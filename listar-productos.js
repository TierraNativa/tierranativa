/**
 * listar-productos.js
 *
 * Imprime por consola `cod<TAB>activo<TAB>description` de todos los productos.
 * Usa la service_role si esta en el entorno; si no, la anon key publica de
 * script.js (RLS deja ver lo mismo que el catalogo).
 *
 * Uso:
 *   node listar-productos.js
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { SUPABASE_URL } = require("./supabase-admin-client");

const ANON_KEY = fs
  .readFileSync(path.join(__dirname, "script.js"), "utf8")
  .match(/sb_publishable_[A-Za-z0-9_-]+/)[0];
const supabase = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || ANON_KEY,
);

async function main() {
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("products")
      .select("cod,active,description")
      .order("cod")
      .range(from, from + PAGE - 1);
    if (error) throw new Error("Error leyendo products: " + error.message);
    for (const p of data) {
      const desc = String(p.description ?? "").replace(/\s+/g, " ").trim();
      console.log(`PROD\t${p.cod}\t${p.active}\t${desc}`);
    }
    if (data.length < PAGE) break;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
