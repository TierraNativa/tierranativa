// Supabase Edge Function: crear-cliente-auth
// -----------------------------------------------------------------------------
// Crea (o recupera) el usuario de Supabase Auth de un cliente, usando la
// service_role key -> auth.admin.createUser. Reemplaza a los signUp del front
// (_expoCreateAuthUser en script.js, createAuthUser en admin.js).
//
// POR QUÉ EXISTE: Supabase endureció la validación de email en signUp y ahora
// rechaza el dominio sintético <cuit>@cuit.tierranativa ("Email address is
// invalid"). auth.admin.createUser NO valida el formato, así que el alta vuelve
// a funcionar. El login (grant_type=password) nunca validó el dominio, así que
// los usuarios creados por acá entran normal.
//
// SEGURIDAD: sólo un ADMIN puede llamarla. Se verifica el JWT del que llama
// (getUser) y su presencia en public.admins. El service_role NUNCA sale de la
// función (vive en los secrets, inyectado por Supabase).
//
// Entrada:  { cuit: "<dígitos o con guiones>", pin: "123456" }
// Salida:   { id: "<uuid>", created: true|false }  |  { error: "..." }
// -----------------------------------------------------------------------------

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

// Dominio del email sintético. En LK/Chef sería "cuit.loekemeyer".
const EMAIL_DOMAIN = "cuit.tierranativa";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function findUserIdByEmail(
  admin: ReturnType<typeof createClient>,
  email: string,
): Promise<string | null> {
  const target = email.toLowerCase();
  const perPage = 1000;
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error || !data) return null;
    const hit = data.users.find(
      (u) => (u.email ?? "").toLowerCase() === target,
    );
    if (hit) return hit.id;
    if (data.users.length < perPage) return null;
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "no_auth" }, 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: who, error: whoErr } = await userClient.auth.getUser();
  if (whoErr || !who?.user) return json({ error: "invalid_token" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: adminRow } = await admin
    .from("admins")
    .select("auth_user_id")
    .eq("auth_user_id", who.user.id)
    .maybeSingle();
  if (!adminRow) return json({ error: "not_admin" }, 403);

  const body = await req.json().catch(() => ({}));
  const digits = String(body?.cuit ?? "").replace(/[^0-9]/g, "");
  const pin = String(body?.pin ?? "");
  if (!digits) return json({ error: "cuit_requerido" }, 400);
  if (pin.length < 6) return json({ error: "pin_invalido" }, 400);
  const email = `${digits}@${EMAIL_DOMAIN}`;

  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email,
    password: pin,
    email_confirm: true,
  });
  if (!cErr && created?.user) {
    return json({ id: created.user.id, created: true });
  }

  const msg = (cErr?.message ?? "").toLowerCase();
  const yaExiste =
    msg.includes("already") || msg.includes("registered") ||
    msg.includes("exists") || msg.includes("duplicate");
  if (yaExiste) {
    const id = await findUserIdByEmail(admin, email);
    if (id) {
      await admin.auth.admin.updateUserById(id, {
        password: pin,
        email_confirm: true,
      });
      return json({ id, created: false });
    }
  }

  return json({ error: cErr?.message ?? "create_failed" }, 400);
});
