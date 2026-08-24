// =========================================================
// EDGE FUNCTION: procesar-pedidos-db  (Tierra Nativa)
// =========================================================
// Arma el mail de compras 100% desde la DB (orders.sheets_payload),
// NO del Google Sheet. Marca "Pasado" en la columna orders.enviado_a_compras_at.
//
// - Pendiente = enviado_a_compras_at IS NULL
// - Excel/processOrders = IDÉNTICOS al de LK (no se tocan)
// - Mail por Gmail API
// - enviado_a_compras_at se sella SOLO si el mail confirmó (200)
// - No toca el sheet
// - Modo dry: POST {"dry":true} -> arma y devuelve el Excel (base64) sin mandar ni marcar
//
// Env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_SENDER,
//      SEND_TO, COMPANY, (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY auto)
// =========================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const COMPANY            = Deno.env.get("COMPANY")!;
const SEND_TO            = Deno.env.get("SEND_TO")!;
const GMAIL_CLIENT_ID     = Deno.env.get("GMAIL_CLIENT_ID")!;
const GMAIL_CLIENT_SECRET = Deno.env.get("GMAIL_CLIENT_SECRET")!;
const GMAIL_REFRESH_TOKEN = Deno.env.get("GMAIL_REFRESH_TOKEN")!;
const GMAIL_SENDER        = Deno.env.get("GMAIL_SENDER")!;
const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---------- DB (REST con service role) ----------
async function dbGet(path: string): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}` },
  });
  if (!r.ok) throw new Error(`DB GET ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
async function markEnviado(ids: number[], whenIso: string): Promise<void> {
  if (!ids.length) return;
  const inList = `(${ids.join(",")})`;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/orders?id=in.${inList}`, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      "Content-Type": "application/json", Prefer: "return=minimal",
    },
    body: JSON.stringify({ enviado_a_compras_at: whenIso }),
  });
  if (!r.ok) throw new Error(`DB PATCH ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

// ---------- Gmail API ----------
function b64url(buf: Uint8Array): string {
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
async function getGmailToken(): Promise<string> {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN, grant_type: "refresh_token",
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Gmail token error: " + JSON.stringify(j));
  return j.access_token;
}
function buildMime(subject: string, body: string, fileName?: string, excelXml?: string): string {
  const B = "BOUND_tn_pedidos";
  let m = "";
  m += `From: ${GMAIL_SENDER}\r\nTo: ${SEND_TO}\r\nSubject: =?UTF-8?B?${b64(subject)}?=\r\nMIME-Version: 1.0\r\n`;
  if (excelXml && fileName) {
    m += `Content-Type: multipart/mixed; boundary="${B}"\r\n\r\n`;
    m += `--${B}\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(body)}\r\n`;
    m += `--${B}\r\nContent-Type: application/vnd.ms-excel; name="${fileName}"\r\nContent-Disposition: attachment; filename="${fileName}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(excelXml)}\r\n`;
    m += `--${B}--`;
  } else {
    m += `Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(body)}`;
  }
  return m;
}
async function sendEmail(subject: string, body: string, excelXml?: string, fileName?: string): Promise<void> {
  const at = await getGmailToken();
  const raw = b64url(new TextEncoder().encode(buildMime(subject, body, fileName, excelXml)));
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!r.ok) throw new Error(`Gmail send ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

// ---------- log ----------
async function logRun(payload: Record<string, unknown>): Promise<void> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/procesar_pedidos_log`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        "Content-Type": "application/json", Prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) console.error("logRun non-OK:", r.status, await r.text());
  } catch (e) { console.error("logRun failed:", e); }
}

// ===== lógica de pedidos / Excel — IDÉNTICA a procesar-pedidos-v2 (no se toca) =====
function padCodArt(cod: unknown): string {
  const s = String(cod).trim();
  const digits = s.match(/\d+/)?.[0] || "";
  const letters = s.match(/[a-zA-Z]+/)?.[0] || "";
  return digits.padStart(3, "0") + letters;
}
function normalizeDate(val: string): string {
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(val)) return val;
  const m = val.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return val;
}
interface Item { N_Pedido: number; row_number: number; fecha: string; cliente: string; vend: string; articulo: string; cajas: string; uni: string; sucursal: string; leyenda2: string; condPago: string; pctDto: string; numOC: string; }
function toItem(r: Record<string, unknown>, nPedido: number): Item {
  return {
    N_Pedido: nPedido,
    row_number: 0,
    fecha: normalizeDate(String(r["Fecha Pedido"] || "")),
    cliente: String(r["Cliente"] || ""),
    vend: String(r["Vend"] || ""),
    articulo: padCodArt(r["Cod Art"]),
    cajas: String(r["Cajas"] || ""),
    uni: String(r["Uni Pedidas"] || ""),
    sucursal: String(r["Sucursal de Entrega"] || ""),
    leyenda2: String(r["Leyenda 2"] || ""),
    condPago: String(r["Condición de Pago"] || ""),
    pctDto: "2% Descuento Web",
    numOC: String(r["Numero OC"] || ""),
  };
}
function processOrders(raw: Record<string, unknown>[]): Item[] {
  const gk = (r: Record<string, unknown>) => `${r["N° Pedido"]}|${r["Sucursal de Entrega"]}|${r["Cliente"]}`;
  const counts = new Map<string, number>();
  for (const r of raw) counts.set(gk(r), (counts.get(gk(r)) || 0) + 1);
  const enriched = raw.map(r => ({ ...r, _count: counts.get(gk(r))!, _ped: String(r["N° Pedido"]), _suc: String(r["Sucursal de Entrega"]) }));
  const big = enriched.filter(e => e._count >= 18);
  const small = enriched.filter(e => e._count < 18);
  const out: Item[] = [];
  let globalN = 0, lastPed: string | null = null, lastSuc: string | null = null, grpCount = 0;
  for (const it of big) {
    if (it._ped !== lastPed || it._suc !== lastSuc || grpCount >= 18) { globalN++; grpCount = 0; lastPed = it._ped; lastSuc = it._suc; }
    grpCount++;
    out.push(toItem(it, globalN));
  }
  const base = globalN;
  const pedMap = new Map<string, number>();
  let cnt = 0;
  for (const it of small) {
    const key = `${it._ped}|${it._suc}|${it["Cliente"]}`;
    if (!pedMap.has(key)) { cnt++; pedMap.set(key, base + cnt); }
    out.push(toItem(it, pedMap.get(key)!));
  }
  return out;
}
function generateExcel(items: Item[], dateLabel: string): string {
  const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const isNum = (v: string) => { if (!v || v.trim() === "") return false; const t = v.trim(); if (t.length > 1 && t.startsWith("0") && !t.startsWith("0.")) return false; return /^-?\d+(\.\d+)?$/.test(t); };
  const cell = (v: string, style?: string) => { const sa = style ? ` ss:StyleID="${style}"` : ""; if (!v && v !== "0") return style ? `<Cell${sa}/>` : "<Cell/>"; const t = isNum(v) ? "Number" : "String"; return `<Cell${sa}><Data ss:Type="${t}">${esc(v)}</Data></Cell>`; };
  const cols: (keyof Item)[] = ["fecha", "N_Pedido", "cliente", "vend", "articulo", "cajas", "uni", "sucursal", "leyenda2", "condPago", "pctDto", "numOC"];
  const sheet1Rows = items.map(it => "<Row>" + cols.map(c => cell(String(it[c]))).join("") + "</Row>").join("\n");
  const groups = new Map<string, { cliente: string; nPedido: number; count: number }>();
  for (const it of items) { const k = `${it.cliente}|${it.N_Pedido}`; if (!groups.has(k)) groups.set(k, { cliente: it.cliente, nPedido: it.N_Pedido, count: 0 }); groups.get(k)!.count++; }
  const desglose = [...groups.values()].sort((a, b) => a.nPedido - b.nPedido);
  const pedidosOrig = new Set(items.map(i => `${i.cliente}|${i.sucursal}`)).size;
  const cantNP = desglose.length;
  const sheet2Rows = [
    `<Row>${cell("Pedidos", "Header")}${cell("NP", "Header")}</Row>`,
    `<Row>${cell(String(pedidosOrig), "Data")}${cell(String(cantNP), "Data")}</Row>`,
    "<Row/>",
    `<Row><Cell ss:MergeAcross="2" ss:StyleID="Desglose"><Data ss:Type="String">Desglose</Data></Cell></Row>`,
    `<Row>${cell("Cod Clte", "Header")}${cell("Num Ped", "Header")}${cell("Cant Items", "Header")}</Row>`,
    ...desglose.map(d => `<Row>${cell(d.cliente, "Data")}${cell(String(d.nPedido), "Data")}${cell(String(d.count), "Data")}</Row>`),
  ].join("\n");
  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
          xmlns:o="urn:schemas-microsoft-com:office:office"
          xmlns:x="urn:schemas-microsoft-com:office:excel"
          xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Styles>
    <Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Bottom"/></Style>
    <Style ss:ID="Header"><Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/><Font ss:Size="16" ss:Bold="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/></Borders></Style>
    <Style ss:ID="Data"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:Size="14"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/></Borders></Style>
    <Style ss:ID="Desglose"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:Size="20" ss:Bold="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/></Borders></Style>
  </Styles>
  <Worksheet ss:Name="${esc(dateLabel)}"><Table>
${sheet1Rows}
  </Table></Worksheet>
  <Worksheet ss:Name="Resumen"><Table>
      <Column ss:Width="67.5"/><Column ss:Width="51"/><Column ss:Width="63"/>
${sheet2Rows}
  </Table></Worksheet>
</Workbook>`;
}
function arParts(d?: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Argentina/Buenos_Aires", year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d ?? new Date());
  return (t: string) => parts.find(p => p.type === t)?.value || "";
}
function arDate() { const g = arParts(); return { dateStr: `${g("day")}-${g("month")}-${g("year")}`, timeStr: `${g("hour")}:${g("minute")}` }; }
function fechaPedido(createdAtIso: string): string { // dd/MM/yyyy AR
  const g = arParts(new Date(createdAtIso));
  return `${g("day")}/${g("month")}/20${g("year")}`;
}

// ---------- construir filas crudas desde sheets_payload ----------
// Normaliza las DOS formas de payload:
//   LK (snake_case): cod_cliente, condicion_pago_code, sucursal_entrega, d/lc/pp ya calculados
//   TN (camelCase):  codCliente, condicionPagoCode, sucursalEntrega, SIN d/lc/pp (se calculan acá)
function pick(p: any, ...keys: string[]): any {
  for (const k of keys) if (p[k] !== undefined && p[k] !== null) return p[k];
  return undefined;
}
// d/lc/pp con la misma lógica del frontend (script.js)
function statusFields(p: any): { d: string; lc: string; pp: string } {
  if (p.d != null && p.lc != null && p.pp != null) {
    return { d: String(p.d), lc: String(p.lc), pp: String(p.pp) };
  }
  const debt = Number(p.deuda || 0);
  const cl = p.credit_limit == null ? null : Number(p.credit_limit);
  const tot = Number(p.order_total || 0);
  const pterm = p.payment_term;
  return {
    lc: (cl != null && (debt + tot) > cl) ? "X" : "OK",
    d: debt > 0 ? "X" : "OK",
    pp: pterm == null ? "Null" : String(Number(pterm)),
  };
}
function rowsFromOrders(orders: any[]): Record<string, unknown>[] {
  const raw: Record<string, unknown>[] = [];
  for (const o of orders) {
    const p = o.sheets_payload || {};
    const items = Array.isArray(p.items) ? p.items : [];
    const codCliente = pick(p, "cod_cliente", "codCliente") ?? "";
    const vend = pick(p, "vend") ?? "";
    const condCode = pick(p, "condicion_pago_code", "condicionPagoCode") ?? "";
    const sucursal = pick(p, "sucursal_entrega", "sucursalEntrega") ?? "";
    const numOC = pick(p, "numOC", "numero_oc", "numeroOC") ?? "";
    const { d, lc, pp } = statusFields(p);
    for (const it of items) {
      raw.push({
        "N° Pedido": String(o.id),
        "Fecha Pedido": fechaPedido(o.created_at),
        "Cliente": String(codCliente),
        "Vend": String(vend),
        "Cod Art": it.cod_art,
        "Cajas": String(it.cajas ?? ""),
        "Uni Pedidas": String((Number(it.cajas) || 0) * (Number(it.uxb) || 0)),
        "Sucursal de Entrega": String(sucursal),
        "Condición de Pago": String(condCode),
        "Leyenda 2": `D ${d} - LC ${lc} - PP ${pp}`,
        "Numero OC": String(numOC),
      });
    }
  }
  return raw;
}

// ---------- handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const startedAt = Date.now();
  let dry = false;
  try { const b = await req.json(); dry = !!b?.dry; } catch { /* sin body */ }

  try {
    // pendientes: enviado_a_compras_at null, con payload, ordenados por id
    const pend: any[] = await dbGet(`orders?enviado_a_compras_at=is.null&sheets_payload=not.is.null&select=id,created_at,sheets_payload&order=id.asc`);
    const { dateStr, timeStr } = arDate();
    const raw = rowsFromOrders(pend);

    if (raw.length === 0) {
      const subject = `Pedidos Web ${COMPANY} de ${dateStr} a las ${timeStr}`;
      if (!dry) {
        await sendEmail(subject, `El dia ${dateStr} a las ${timeStr} no hubo nuevos pedidos en ${COMPANY}`);
        await logRun({ company: COMPANY, status: "no_orders", orders_count: 0, pedidos_generated: 0, email_subject: subject, email_to: SEND_TO, duration_ms: Date.now() - startedAt });
      }
      return jsonOk({ message: "No pending orders", dry });
    }

    const items = processOrders(raw);
    const dateLabel = `${dateStr} 9Hs`;
    const xml = generateExcel(items, dateLabel);
    const fileName = `Pedidos_Descargado_${dateStr}_9Hs.xls`;
    const subject = `Pedidos Web ${COMPANY} de ${dateStr}`;
    const pedidosGenerated = new Set(items.map(i => i.N_Pedido)).size;
    const orderIds = pend.map(o => Number(o.id));

    if (dry) {
      return jsonOk({ dry: true, ordersPending: pend.length, lineRows: raw.length, pedidosGenerated, orderIds, excelBase64: b64(xml) });
    }

    // 1) mandar mail
    await sendEmail(subject, "Excel Adjunto", xml, fileName);
    // 2) SOLO si el mail confirmó, sellar enviado_a_compras_at
    await markEnviado(orderIds, new Date().toISOString());

    await logRun({ company: COMPANY, status: "ok", orders_count: raw.length, pedidos_generated: pedidosGenerated, email_subject: subject, email_to: SEND_TO, row_numbers: orderIds, duration_ms: Date.now() - startedAt });
    return jsonOk({ ordersProcessed: raw.length, pedidosGenerated, orders: orderIds.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!dry) await logRun({ company: COMPANY, status: "error", error_message: msg, duration_ms: Date.now() - startedAt });
    return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});

function jsonOk(data: Record<string, unknown>) {
  return new Response(JSON.stringify({ ok: true, ...data }), { headers: { ...CORS, "Content-Type": "application/json" } });
}
