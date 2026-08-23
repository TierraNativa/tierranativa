"use strict";

/***********************
 * SUPABASE CONFIG
 ***********************/
const SUPABASE_URL = "https://zjvpzqhbekxnwxdczpof.supabase.co";
const SUPABASE_ANON_KEY =
  "sb_publishable_b4ua15HoSbe8o5SHsbJxWw_fvZFUdxv";

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
);

/***********************
 * GOOGLE SHEETS (PROXY)
 ***********************/
const SHEETS_PROXY_URL =
  "https://zjvpzqhbekxnwxdczpof.functions.supabase.co/sheets-proxy";
const SHEETS_ENTREGAS_PROXY_URL =
  "https://zjvpzqhbekxnwxdczpof.functions.supabase.co/sheets-entregas-proxy";
const NOTIFY_NEW_ADDRESS_URL =
  "https://zjvpzqhbekxnwxdczpof.functions.supabase.co/notify-new-address";

/***********************
 * UI CONSTANTS
 ***********************/
let WEB_ORDER_DISCOUNT = 0.02; // default fallback
const UPSELL_DISCOUNT = 0.3; // Descuento extra aplicado al pedido "promo" (items agregados desde popup upsell). Se graba como pedido separado (X+1).

// EXPO: multiplicador de descuento web para las previews de "Tu precio contado".
// Con un cliente de expo activo el operador es admin -> NO se aplica web (el total
// del carrito ya usa web=0 para admin); fuera de expo, comportamiento normal.
function _expoWebMul() {
  return _expoActiveCustomer ? 1 : (1 - WEB_ORDER_DISCOUNT);
}
// EXPO: en esta copia el admin no elige entre sus razones vinculadas; entra a
// cualquier cliente del padrón vía "Elegir cliente" o crea uno con "Nuevo cliente".
const EXPO_MODE = true;
// Modo cliente-expo: activo cuando el cliente seleccionado es un cliente NUEVO
// de expo (está en expo_clientes_pendientes). En ese modo el pricing deja de ser
// "admin/precio lista" y pasa a cliente real: dto por ESCALA (según subtotal de
// lista, en vivo) + contado (-25%) OBLIGATORIO + web (-2%).
var _expoClientMode = false;      // cliente NUEVO de expo (escala + contado forzado)
var _escalaActiva = false;        // cliente con escala activa (dto por 1ª compra, self-service)
var _expoActiveCustomer = false;  // hay un cliente REAL seleccionado (mostrar SU precio)
var _expoClientComplete = false;  // el cliente NUEVO de expo tiene TODOS los datos (salvo expreso)
var _expoScale = null; // [{desde, dto}] ordenado por desde asc

// Completitud automática de un cliente nuevo de expo: TODOS los campos son
// obligatorios salvo el Expreso de cada dirección de entrega. Opera sobre una
// fila de staging (expo_clientes_pendientes) o un objeto con los mismos campos.
function _expoDatosCompletos(d) {
  if (!d) return false;
  var req = [
    d.business_name, d.cuit, d.condicion_iva, d.vend, d.whatsapp, d.mail,
    d.direccion, d.numero, d.cp, d.localidad, d.provincia,
  ];
  for (var i = 0; i < req.length; i++) {
    if (!String(req[i] == null ? "" : req[i]).trim()) return false;
  }
  var dirs = Array.isArray(d.direcciones_entrega) ? d.direcciones_entrega : [];
  if (!dirs.length) return false;
  for (var j = 0; j < dirs.length; j++) {
    var a = dirs[j] || {};
    // Expreso NO es obligatorio (puede no haber uno fijo).
    if (
      !String(a.direccion || "").trim() ||
      !String(a.localidad || "").trim() ||
      !String(a.provincia || "").trim()
    )
      return false;
  }
  return true;
}

// Lista legible de lo que falta (para avisar al confirmar "Datos completados").
function _expoFaltantes(d) {
  var out = [];
  var map = [
    ["business_name", "Razón social"], ["cuit", "CUIT"],
    ["condicion_iva", "Condición IVA"], ["vend", "Vendedor"],
    ["whatsapp", "WhatsApp"], ["mail", "Mail"], ["direccion", "Calle"],
    ["numero", "Número"], ["cp", "C.P."], ["localidad", "Localidad"],
    ["provincia", "Provincia"],
  ];
  map.forEach(function (m) {
    if (!String(d[m[0]] == null ? "" : d[m[0]]).trim()) out.push(m[1]);
  });
  var dirs = Array.isArray(d.direcciones_entrega) ? d.direcciones_entrega : [];
  if (!dirs.length) out.push("una dirección de entrega");
  else {
    var bad = false;
    dirs.forEach(function (a) {
      a = a || {};
      if (
        !String(a.direccion || "").trim() ||
        !String(a.localidad || "").trim() ||
        !String(a.provincia || "").trim()
      )
        bad = true;
    });
    if (bad) out.push("dirección de entrega (calle/localidad/provincia)");
  }
  return out;
}

// Lee el formulario de alta a la forma que consumen _expoDatosCompletos/_expoFaltantes.
function _expoReadFormData() {
  function v(id) {
    var e = document.getElementById(id);
    return e ? String(e.value || "").trim() : "";
  }
  return {
    business_name: v("expoNewRazon"),
    cuit: v("expoNewCuit").replace(/[^0-9]/g, ""),
    condicion_iva: v("expoNewCondIva"),
    vend: v("expoNewVend"),
    whatsapp: v("expoNewWhatsapp"),
    mail: v("expoNewMail"),
    direccion: v("expoNewDirFiscal"),
    numero: v("expoNewNumFiscal"),
    cp: v("expoNewCpFiscal"),
    localidad: v("expoNewLocFiscal"),
    provincia: v("expoNewProvFiscal"),
    direcciones_entrega: _expoAddrCollect(),
  };
}

// Habilita el botón "Datos completados" (verde) SOLO cuando está todo completo
// (incluida la sucursal; el único opcional es el expreso). Corre en vivo.
function _expoNewSyncComplete() {
  var btn = document.getElementById("expoNewClose");
  if (!btn) return;
  btn.disabled = !_expoDatosCompletos(_expoReadFormData());
}

/***********************
 * EXPO — entrada "Elegir cliente" / "Nuevo cliente"
 * Reemplaza el selector "Elegir razón social" en esta copia.
 ***********************/
var _expoPickWired = false;
var _expoSearchTimer = null;

function _expoEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}

// Carga la escala de descuento por volumen (una vez).
async function _expoLoadScale() {
  if (_expoScale) return _expoScale;
  try {
    var r = await supabaseClient
      .from("expo_dto_escala")
      .select("desde,dto")
      .order("desde", { ascending: true });
    _expoScale = r.error ? [] : (r.data || []);
  } catch (e) {
    _expoScale = [];
  }
  return _expoScale;
}

// Subtotal de LISTA del carrito (sin dto): base para elegir el tramo.
function _expoListSubtotal() {
  var s = 0;
  (cart || []).forEach(function (item) {
    var p = findAnyProduct(item.productId);
    if (!p) return;
    // El tramo se elige sobre el MISMO precio que se muestra: en cliente nuevo
    // de expo eso es lista 2 (getPriceForCustomer ya resuelve el fallback).
    s += Number(getPriceForCustomer(p) || 0) * (item.qtyCajas * Number(p.uxb || 0));
  });
  return s;
}

// dto (fracción) que corresponde a un subtotal según la escala.
function _expoScaleDtoFor(sub) {
  if (!_expoScale || !_expoScale.length) return 0;
  var dto = 0;
  _expoScale.forEach(function (t) {
    if (sub >= Number(t.desde)) dto = Number(t.dto);
  });
  return dto;
}

// Sincroniza el dto del cliente-expo con la escala según el carrito actual.
// Lo escribe en customerProfile.dto_vol para que TODO el pricing lo lea igual.
function _expoSyncDto() {
  if (!(_expoClientMode || _escalaActiva) || !customerProfile) return;
  customerProfile.dto_vol = _expoScaleDtoFor(_expoListSubtotal());
  _expoRenderCheckpoints();
  if (_escalaActiva) _escalaRenderCheckpoints();
}

// Garantiza que el <select> oculto tenga la <option> del cliente elegido.
// Ese value lo leen onLinkedCustomerSelected y el gate de confirmación.
function _expoEnsureOption(id, label) {
  var sel = document.getElementById("customerSelect");
  if (!sel) return;
  if (!sel.querySelector('option[value="' + id + '"]')) {
    var o = document.createElement("option");
    o.value = id;
    o.textContent = label || "";
    sel.appendChild(o);
  }
}

function _expoNextTier(sub) {
  if (!_expoScale) return null;
  for (var i = 0; i < _expoScale.length; i++) {
    if (Number(_expoScale[i].desde) > sub) {
      return { dto: Number(_expoScale[i].dto), falta: Number(_expoScale[i].desde) - sub };
    }
  }
  return null;
}

function _expoMoney(n) {
  try {
    return Number(n || 0).toLocaleString("es-AR", { maximumFractionDigits: 0 });
  } catch (e) {
    return String(Math.round(Number(n || 0)));
  }
}

// Monto compacto para las etiquetas de los checkpoints: 600000 → $600k, 1500000 → $1,5M.
function _expoCompact(n) {
  n = Number(n) || 0;
  if (n >= 1000000) {
    var m = n / 1000000;
    return "$" + (m % 1 === 0 ? m : m.toFixed(1).replace(".", ",")) + "M";
  }
  if (n >= 1000) return "$" + Math.round(n / 1000) + "k";
  return "$" + n;
}

/***********************
 * ESCALA ACTIVA — self-service dto por 1ª compra
 ***********************/

// Barra de progreso de descuento por volumen (escala activa self-service)
function _escalaRenderCheckpoints() {
  if (!_escalaActiva || !_expoScale || !_expoScale.length) return;

  var tiers = _expoScale.slice().sort(function (a, b) {
    return Number(a.desde) - Number(b.desde);
  });
  var sub = _expoListSubtotal();
  var n = tiers.length;
  var curIdx = 0;
  for (var i = 0; i < n; i++) if (sub >= Number(tiers[i].desde)) curIdx = i;
  var pos = function (i) { return n <= 1 ? 100 : (i / (n - 1)) * 100; };
  var fillFrac;
  if (curIdx >= n - 1) {
    fillFrac = 100;
  } else {
    var a = Number(tiers[curIdx].desde), b = Number(tiers[curIdx + 1].desde);
    var prog = b > a ? Math.min(1, Math.max(0, (sub - a) / (b - a))) : 0;
    fillFrac = pos(curIdx) + prog * (pos(curIdx + 1) - pos(curIdx));
  }
  var steps = "";
  tiers.forEach(function (t, i) {
    var cls = i < curIdx ? "done" : i === curIdx ? "current" : "todo";
    steps +=
      '<div class="expo-cp-step ' + cls + '" style="left:' + pos(i) + '%">' +
      '<span class="expo-cp-pct">' + Math.round(Number(t.dto) * 100) + "%</span>" +
      '<span class="expo-cp-dot"></span>' +
      '<span class="expo-cp-amt">' + _expoCompact(t.desde) + "</span>" +
      "</div>";
  });
  var next = _expoNextTier(sub);
  var curDto = Math.round(Number(tiers[curIdx].dto) * 100);
  var right = next
    ? "Faltan <b>$" + _expoMoney(next.falta) + "</b> para " + Math.round(next.dto * 100) + "%"
    : "<b>Descuento máximo alcanzado</b>";
  var html =
    '<div class="expo-cp-head">' +
      '<span class="expo-cp-title">Tu descuento por volumen · <b>' + curDto + "%</b></span>" +
      '<span class="expo-cp-sub">Pedido (lista): <b>$' + _expoMoney(sub) + "</b></span>" +
      '<span class="expo-cp-next">' + right + "</span>" +
    "</div>" +
    '<div class="expo-cp-track">' +
      '<div class="expo-cp-fill" style="width:' + fillFrac + '%"></div>' +
      steps +
    "</div>";

  _escalaEnsureContainer("escalaCheckProd", "productos", ".section-title-row").innerHTML = html;
  _escalaEnsureContainer("escalaCheckCart", "carrito", ".cart-col-right").innerHTML = html;
}

function _escalaEnsureContainer(id, sectionId, afterSelector) {
  var el = document.getElementById(id);
  if (el) return el;
  el = document.createElement("div");
  el.id = id;
  el.className = "expo-cp-wrap escala-cp-wrap";
  var sec = document.getElementById(sectionId);
  if (!sec) return el;
  var ref = afterSelector ? sec.querySelector(afterSelector) : null;
  if (ref && ref.nextSibling) {
    ref.parentNode.insertBefore(el, ref.nextSibling);
  } else if (ref) {
    ref.parentNode.appendChild(el);
  } else {
    sec.insertBefore(el, sec.firstChild);
  }
  return el;
}

function _escalaForceContadoUI() {
  if (!_escalaActiva) return;
  var payBtns = document.getElementById("paymentButtons");
  var payLater = document.getElementById("payLaterBtn");
  var paySel = document.getElementById("paymentSelect");
  if (payBtns) payBtns.style.display = "none";
  if (payLater) payLater.style.display = "none";
  if (paySel) { paySel.value = "0.30"; paySel.style.display = "none"; }

  var notice = document.getElementById("escalaContadoNotice");
  if (!notice) {
    var payRow = document.getElementById("paymentRow");
    var card = payRow ? payRow.querySelector(".pay-card") : null;
    if (card) {
      notice = document.createElement("div");
      notice.id = "escalaContadoNotice";
      notice.className = "escala-contado-notice";
      notice.innerHTML =
        '<div class="escala-contado-icon">💰</div>' +
        '<div class="escala-contado-text">' +
          '<strong>Contado −30%</strong>' +
          '<span>Medio de pago fijo para tu primer pedido</span>' +
        '</div>';
      var webNote = card.querySelector(".web-note");
      if (webNote) card.insertBefore(notice, webNote);
      else card.appendChild(notice);
    }
  }
  var hint = document.querySelector("#paymentRow .ship-hint");
  if (hint) hint.style.display = "none";
}

async function _escalaFijar(dtoOverride) {
  if (!_escalaActiva || !customerProfile) return;
  // El dto a fijar es el que USÓ el pedido, capturado antes de vaciar el carrito.
  // Sin el override, customerProfile.dto_vol ya fue recalculado a 0% (carrito vacío).
  var dto = dtoOverride != null ? Number(dtoOverride) : Number(customerProfile.dto_vol || 0);
  try {
    await supabaseClient.rpc("fijar_dto_escala", {
      p_customer_id: customerProfile.id,
      p_dto: dto
    });
    _escalaActiva = false;
    customerProfile.escala_activa = false;
    customerProfile.dto_vol = dto; // dejar el dto fijo también en memoria (coherente con DB)
  } catch (e) {
    console.error("fijar_dto_escala error:", e);
  }
}

// Barra de "checkpoints": muestra los tramos de la escala como hitos, el progreso
// del pedido (lista) y cuánto falta para el próximo tramo. Solo para cliente nuevo.
function _expoRenderCheckpoints() {
  var cp = document.getElementById("expoCheckpoints");
  if (!cp) return;
  if (!_expoClientMode || !_expoScale || !_expoScale.length) {
    cp.style.display = "none";
    return;
  }
  var tiers = _expoScale.slice().sort(function (a, b) {
    return Number(a.desde) - Number(b.desde);
  });
  var sub = _expoListSubtotal();
  var n = tiers.length;
  var curIdx = 0;
  for (var i = 0; i < n; i++) if (sub >= Number(tiers[i].desde)) curIdx = i;
  var pos = function (i) { return n <= 1 ? 100 : (i / (n - 1)) * 100; };
  var fillFrac;
  if (curIdx >= n - 1) {
    fillFrac = 100;
  } else {
    var a = Number(tiers[curIdx].desde), b = Number(tiers[curIdx + 1].desde);
    var prog = b > a ? Math.min(1, Math.max(0, (sub - a) / (b - a))) : 0;
    fillFrac = pos(curIdx) + prog * (pos(curIdx + 1) - pos(curIdx));
  }
  var steps = "";
  tiers.forEach(function (t, i) {
    var cls = i < curIdx ? "done" : i === curIdx ? "current" : "todo";
    steps +=
      '<div class="expo-cp-step ' + cls + '" style="left:' + pos(i) + '%">' +
      '<span class="expo-cp-pct">' + Math.round(Number(t.dto) * 100) + "%</span>" +
      '<span class="expo-cp-dot"></span>' +
      '<span class="expo-cp-amt">' + _expoCompact(t.desde) + "</span>" +
      "</div>";
  });
  var next = _expoNextTier(sub);
  var curDto = Math.round(Number(tiers[curIdx].dto) * 100);
  var right = next
    ? "Faltan <b>$" + _expoMoney(next.falta) + "</b> para " + Math.round(next.dto * 100) + "%"
    : "<b>Descuento máximo alcanzado</b>";
  cp.innerHTML =
    '<div class="expo-cp-head">' +
      '<span class="expo-cp-title">Descuento por volumen · <b>' + curDto + "%</b></span>" +
      '<span class="expo-cp-sub">Pedido (lista): <b>$' + _expoMoney(sub) + "</b></span>" +
      '<span class="expo-cp-next">' + right + "</span>" +
    "</div>" +
    '<div class="expo-cp-track">' +
      '<div class="expo-cp-fill" style="width:' + fillFrac + '%"></div>' +
      steps +
    "</div>";
  cp.style.display = "";
}

function _expoUpdateChip() {
  var chip = document.getElementById("expoCurrentChip");
  var _catBtn = document.getElementById("expoCatalogoBtn");
  if (_catBtn) {
    var _hc = _expoActiveCustomer && customerProfile && customerProfile.id && customerProfile.cod_cliente;
    _catBtn.style.display = _hc ? "" : "none";
  }
  if (!chip) return;
  if (!(customerProfile && customerProfile.id && customerProfile.business_name)) {
    chip.textContent = "Sin cliente seleccionado";
    chip.classList.remove("has-client");
    return;
  }
  var dto = Number(customerProfile.dto_vol || 0);
  var name =
    '<span class="expo-chip-name">' + _expoEsc(customerProfile.business_name) + "</span>";
  var inner;
  if (_expoClientMode) {
    // El detalle del dto por volumen se muestra en la barra de checkpoints.
    var estado = _expoClientComplete
      ? '<span class="expo-chip-ok">✓ Datos completos</span>'
      : '<span class="expo-chip-falta">Faltan datos</span>';
    inner = name + '<span class="expo-chip-meta">Contado 1ª compra · ' + estado + "</span>";
  } else {
    inner =
      name +
      '<span class="expo-chip-meta">Cód ' +
      _expoEsc(customerProfile.cod_cliente || "—") +
      (dto > 0 ? " · Dto " + Math.round(dto * 100) + "%" : "") +
      "</span>";
  }
  // La cruz (soltar cliente) solo cuando hay un cliente ELEGIDO/NUEVO de expo,
  // NO en el perfil propio del operador (ahí no hay nada que soltar).
  var cruz = _expoActiveCustomer
    ? '<button type="button" class="expo-chip-clear" title="Soltar cliente y volver a tu perfil" ' +
      'onclick="expoClearCustomer()">&times;</button>'
    : "";
  chip.innerHTML = '<div class="expo-chip-text">' + inner + "</div>" + cruz;
  chip.classList.add("has-client");
  _expoRenderCheckpoints();
  _expoRefreshResumeBtn();
}

function _expoImgSrcFor(cod) {
  var c = String(cod || "").trim().toUpperCase();
  for (var i = 0; i < (products || []).length; i++) {
    if (String(products[i].cod || "").trim().toUpperCase() === c) return primaryProductImage(products[i]);
  }
  return BASE_IMG + encodeURIComponent(cod) + ".webp";
}
function _expoImgDataURL(src) {
  return new Promise(function (resolve) {
    var img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = function () {
      try {
        var c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        resolve(c.toDataURL("image/jpeg", 0.85));
      } catch (e) {
        resolve(null);
      }
    };
    img.onerror = function () { resolve(null); };
    img.src = src;
  });
}

// --- Motor de equivalencias de producto (base + variante) ---
// La "base" es el tipo de producto sin la variante (material/mango/terminación/
// tamaño). Dos productos con la misma base son equivalentes. La lista de tokens
// de variante es EDITABLE — si una equivalencia sale mal, se ajusta acá.
var EQUIV_VARIANT = {
  cromado: 1, cromada: 1, niquelado: 1, niquelada: 1, rojo: 1, roja: 1,
  color: 1, colores: 1, metalizado: 1, metalizada: 1, metalizados: 1,
  acacia: 1, nylon: 1, silicona: 1, silicon: 1, inox: 1, inoxidable: 1,
  acero: 1, madera: 1, loeke: 1, ergonomico: 1, bambu: 1, premium: 1,
  alambre: 1, plastico: 1, plastica: 1, mgo: 1, mango: 1, capuchon: 1,
  super: 1, tradicional: 1, chata: 1, ac: 1
};
var EQUIV_PREMIUM = { acacia: 1, inox: 1, inoxidable: 1, acero: 1, silicona: 1, premium: 1, bambu: 1 };
function _equivNorm(s) {
  return String(s || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function _equivBase(desc) {
  var toks = _equivNorm(desc).split(" ").filter(function (t) {
    if (!t) return false;
    if (EQUIV_VARIANT[t]) return false;
    if (/^\d+(cm|mm|ml|lt|l|pza)?$/.test(t)) return false; // tamaños/cantidades
    if (t.length === 1) return false; // tokens sueltos (c/, x, etc.)
    if (t === "de" || t === "la" || t === "el" || t === "con" || t === "para" ||
        t === "pza" || t === "pieza" || t === "uso" || t === "usos" || t === "pie") return false;
    return true;
  });
  if (toks[0] && toks[0].length > 4 && toks[0].slice(-1) === "s") toks[0] = toks[0].slice(0, -1);
  return toks.join(" ");
}
function _equivTier(desc) {
  var toks = _equivNorm(desc).split(" ");
  for (var i = 0; i < toks.length; i++) if (EQUIV_PREMIUM[toks[i]]) return 1;
  return 0;
}

async function _expoCatalogoPDF() {
  if (!customerProfile || !customerProfile.cod_cliente) {
    alert("Elegí un cliente existente primero.");
    return;
  }
  if (!(window.jspdf && window.jspdf.jsPDF)) {
    alert("No se pudo cargar el generador de PDF. Recargá la página.");
    return;
  }
  var cod = String(customerProfile.cod_cliente);
  var rs = (customerProfile.business_name || "Cliente").trim();
  var btn = document.getElementById("expoCatalogoBtn");
  var btnTxt = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Generando…"; }

  try {
    // 1. Historial del cliente (item_code, ym, boxes)
    var hist = await supabaseClient.rpc("get_customer_history", { p_cod_cliente: cod });
    var rows = (hist && hist.data) || [];
    var purchased = new Set();
    var lastYm = {};
    var months = {};
    rows.forEach(function (row) {
      var c = String(row.item_code || "").trim().toUpperCase();
      if (!c) return;
      if ((Number(row.boxes) || 0) <= 0) return;
      purchased.add(c);
      var ym = String(row.ym || "");
      if (!lastYm[c] || ym > lastYm[c]) lastYm[c] = ym;
      months[c] = (months[c] || 0) + 1;
    });

    // 2. Estadística madre (demanda por SKU en todo el negocio).
    // Tierra Nativa no tiene esa tabla; se cae al ranking del propio catálogo.
    var em = {};
    try {
      var esRes = await supabaseClient
        .from("estadistica_madre")
        .select("cod, e_madre_uni_mes, ranking, descripcion, categoria")
        .limit(3000);
      (((esRes && esRes.data) || [])).forEach(function (r) {
        em[String(r.cod || "").trim().toUpperCase()] = r;
      });
    } catch (_e) {}
    if (!Object.keys(em).length) {
      (products || []).forEach(function (p) {
        var c = String(p.cod || "").trim().toUpperCase();
        if (!c || p.ranking == null) return;
        em[c] = { cod: c, ranking: Number(p.ranking), e_madre_uni_mes: 0, descripcion: p.description, categoria: p.category };
      });
    }

    // 3. Mapa del catálogo por código (para descripción + foto)
    var prodByCod = {};
    (products || []).forEach(function (p) {
      var c = String(p.cod || "").trim().toUpperCase();
      if (c) prodByCod[c] = p;
    });

    // 4. Equivalencias: base -> grupo de productos; y qué base ya lleva el cliente
    var groupByBase = {};
    var baseOf = {};
    (products || []).forEach(function (p) {
      var c = String(p.cod || "").trim().toUpperCase();
      if (!c) return;
      var b = _equivBase(p.description || "");
      if (!b) return;
      baseOf[c] = b;
      (groupByBase[b] = groupByBase[b] || []).push({
        cod: c,
        desc: p.description || c,
        tier: _equivTier(p.description || ""),
        precio: p.list_price != null && p.uxb != null ? Number(p.list_price) * Number(p.uxb) : null,
        uxb: p.uxb != null ? Number(p.uxb) : null,
        ranking: em[c] ? em[c].ranking : null,
      });
    });
    var carried = {}; // base -> {tier, desc} de lo que YA lleva
    purchased.forEach(function (c) {
      var b = baseOf[c];
      if (!b) return;
      var d = (prodByCod[c] && prodByCod[c].description) || c;
      var t = _equivTier((prodByCod[c] && prodByCod[c].description) || "");
      if (!carried[b] || t > carried[b].tier) carried[b] = { tier: t, desc: d };
    });

    // baseline de demanda para el "N× más"
    var bv = [];
    purchased.forEach(function (c) { var e = em[c]; if (e && e.e_madre_uni_mes > 0) bv.push(e.e_madre_uni_mes); });
    bv.sort(function (x, y) { return x - y; });
    var baseline = bv.length ? bv[Math.floor(bv.length / 2)] : 0;

    // 5. SUMAR: más vendidos que no compra, SIN los equivalentes de lo que ya lleva
    var sumar = [];
    (products || []).forEach(function (p) {
      var c = String(p.cod || "").trim().toUpperCase();
      if (!c || purchased.has(c)) return;
      var e = em[c];
      if (!e || (e.ranking == null && !e.e_madre_uni_mes)) return;
      if (carried[baseOf[c]]) return; // ya lleva un equivalente → no redundar
      var mult = e.e_madre_uni_mes && baseline ? e.e_madre_uni_mes / baseline : null;
      var sub = p.category ? p.category + ". " : "";
      if (mult && mult >= 1.3) sub += "Se vende ~" + (mult >= 10 ? Math.round(mult) : mult.toFixed(1)) + "× más que tu compra promedio.";
      sumar.push({
        cod: c, titulo: p.description || c,
        precio: p.list_price != null && p.uxb != null ? Number(p.list_price) * Number(p.uxb) : null,
        uxb: p.uxb != null ? Number(p.uxb) : null,
        sub: sub, ranking: e.ranking,
      });
    });
    sumar.sort(function (m, n) { var rm = m.ranking == null ? 1e9 : m.ranking; var rn = n.ranking == null ? 1e9 : n.ranking; return rm - rn; });
    sumar = sumar.slice(0, 16);

    // 6. MEJORÁ: para cada base que lleva en estándar, la versión premium equivalente
    var upgrades = [];
    var seenUp = {};
    Object.keys(carried).forEach(function (b) {
      if (carried[b].tier >= 1) return; // ya lleva premium
      (groupByBase[b] || []).forEach(function (g) {
        if (g.tier < 1 || purchased.has(g.cod) || seenUp[g.cod]) return;
        seenUp[g.cod] = 1;
        upgrades.push({
          cod: g.cod, titulo: g.desc, precio: g.precio, uxb: g.uxb,
          sub: "Vos llevás " + String(carried[b].desc).trim() + ". Probá esta versión premium.",
          ranking: g.ranking,
        });
      });
    });
    upgrades.sort(function (m, n) { var rm = m.ranking == null ? 1e9 : m.ranking; var rn = n.ranking == null ? 1e9 : n.ranking; return rm - rn; });
    upgrades = upgrades.slice(0, 8);

    // 7. Bajas: comprados en >=2 meses cuya última compra es vieja (>=4 meses)
    function ymNum(ym) {
      var m = String(ym).match(/(\d{4})[-\/]?(\d{2})/);
      return m ? parseInt(m[1], 10) * 12 + parseInt(m[2], 10) : 0;
    }
    var hoy = new Date();
    var hoyNum = hoy.getFullYear() * 12 + (hoy.getMonth() + 1);
    var bajas = [];
    Object.keys(lastYm).forEach(function (c) {
      if ((months[c] || 0) < 2) return;
      if (hoyNum - ymNum(lastYm[c]) < 4) return;
      var p = prodByCod[c];
      var ym = String(lastYm[c] || "");
      bajas.push({
        cod: c, titulo: (p && p.description) || (em[c] && em[c].descripcion) || c,
        precio: p && p.list_price != null && p.uxb != null ? Number(p.list_price) * Number(p.uxb) : null,
        uxb: p && p.uxb != null ? Number(p.uxb) : null,
        sub: ym ? "Última compra: " + ym.slice(0, 7) : "Lo comprabas antes.",
        _ym: ym,
      });
    });
    bajas.sort(function (a, b) { return String(b._ym).localeCompare(String(a._ym)); });
    bajas = bajas.slice(0, 16);

    var secciones = [];
    if (sumar.length) secciones.push({ titulo: "PRODUCTOS PARA SUMAR", items: sumar });
    if (upgrades.length) secciones.push({ titulo: "MEJORÁ LO QUE YA LLEVÁS", items: upgrades });
    if (bajas.length) secciones.push({ titulo: "PRODUCTOS QUE DEJASTE DE LLEVAR", items: bajas });

    if (!secciones.length) {
      alert("No hay productos para armar el catálogo de este cliente.");
      return;
    }
    await _expoBuildCatalogoPDF(rs, cod, secciones);
  } catch (e) {
    console.error("[expo] catálogo PDF falló:", e);
    alert("No se pudo generar el catálogo: " + (e && e.message ? e.message : e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btnTxt || "📄 Catálogo"; }
  }
}

async function _expoBuildCatalogoPDF(rs, cod, secciones) {
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF("p", "mm", "a4");
  var W = 210, H = 297, M = 12, GAP = 8;
  var colW = (W - 2 * M - GAP) / 2; // ~89 mm
  var photoW = 46;
  var cardH = 82;
  var y, col;

  function money(n) {
    if (n == null || !isFinite(n)) return "";
    return "$" + Math.round(n).toLocaleString("es-AR");
  }

  // Encabezado
  doc.setFillColor(17, 24, 39);
  doc.rect(0, 0, W, 42, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("SELECCIÓN PREPARADA PARA", M, 16);
  doc.setFontSize(18);
  doc.text(String(rs).toUpperCase().slice(0, 40), M, 27);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(200, 200, 200);
  doc.text("Cod " + cod + "  ·  Productos elegidos para vos", M, 36);
  doc.setTextColor(0, 0, 0);
  y = 50; col = 0;

  function nextPage() { doc.addPage(); y = M + 4; col = 0; }

  function seccion(txt) {
    if (col === 1) { y += cardH; col = 0; } // cerrar fila incompleta
    if (y > H - cardH - 12) nextPage();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(180, 30, 30);
    doc.text(txt, M, y);
    doc.setTextColor(0, 0, 0);
    y += 2;
    doc.setDrawColor(220, 220, 220);
    doc.line(M, y, W - M, y);
    y += 7;
  }

  async function card(item) {
    if (col === 0 && y + cardH > H - M) nextPage();
    var x = M + col * (colW + GAP);
    var px = x + (colW - photoW) / 2;
    var dataUrl = await _expoImgDataURL(
      _expoImgSrcFor(item.cod)
    );
    if (dataUrl) {
      try { doc.addImage(dataUrl, "JPEG", px, y, photoW, photoW); } catch (e) {}
    } else {
      doc.setDrawColor(230, 230, 230);
      doc.rect(px, y, photoW, photoW);
      doc.setFontSize(7);
      doc.setTextColor(175, 175, 175);
      doc.text("sin foto", x + colW / 2 - 6, y + photoW / 2);
      doc.setTextColor(0, 0, 0);
    }
    var ty = y + photoW + 6;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    var tl = doc.splitTextToSize(String(item.titulo || item.cod), colW).slice(0, 2);
    doc.text(tl, x, ty);
    ty += tl.length * 4.4 + 1;
    if (item.precio) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(20, 120, 40);
      doc.text(money(item.precio) + (item.uxb ? " /caja (" + item.uxb + " u.)" : ""), x, ty);
      doc.setTextColor(0, 0, 0);
      ty += 5;
    }
    if (item.sub) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(110, 110, 110);
      doc.text(doc.splitTextToSize(String(item.sub), colW).slice(0, 3), x, ty);
      doc.setTextColor(0, 0, 0);
    }
    if (col === 0) { col = 1; } else { col = 0; y += cardH; }
  }

  for (var s = 0; s < (secciones || []).length; s++) {
    seccion(secciones[s].titulo);
    var items = secciones[s].items || [];
    for (var i = 0; i < items.length; i++) await card(items[i]);
    if (col === 1) { y += cardH; col = 0; }
  }

  doc.save("catalogo_" + cod + ".pdf");
}
window._expoCatalogoPDF = _expoCatalogoPDF;

function renderExpoEntryBar() {
  var bar = document.createElement("div");
  bar.id = "customerSelectorBanner";
  bar.className = "customer-selector-banner expo-entry-bar";
  bar.innerHTML =
    '<div class="expo-current" id="expoCurrentChip">Sin cliente seleccionado</div>' +
    '<div class="expo-entry-actions">' +
    '<button type="button" class="expo-btn expo-btn-pick" id="expoElegirBtn">Elegir cliente</button>' +
    '<button type="button" class="expo-btn expo-btn-new" id="expoNuevoBtn">+ Nuevo cliente</button>' +
    '<button type="button" class="expo-btn expo-btn-resume" id="expoContinuarBtn" style="display:none">Continuar carga pausada</button>' +
    '<button type="button" class="expo-btn expo-btn-new" id="expoCatalogoBtn" style="display:none" title="Catálogo de recuperación con fotos para mostrarle al cliente" onclick="_expoCatalogoPDF()">📄 Catálogo</button>' +
    "</div>" +
    '<select id="customerSelect" class="expo-hidden-select" tabindex="-1" aria-hidden="true"><option value=""></option></select>';

  document.body.classList.add("expo-operator");
  var section = document.getElementById("productos");
  var anchorRow = null;
  // Preferido: meter la barra en la fila de acciones de la mobile-products-bar
  // (misma fila que "Filtros"), para no ocupar un renglón aparte.
  var mpbActions = document.querySelector("#mobileProductsBar .mpb-actions");
  if (mpbActions) {
    mpbActions.insertBefore(bar, mpbActions.firstChild);
    anchorRow = document.getElementById("mobileProductsBar");
    // Sacar Filtros de mpb-actions y ponerlo como hijo directo del
    // mobileProductsBar para que CSS order lo ubique DESPUÉS del buscador.
    var filtrosBtn = document.getElementById("openFiltersBtn");
    if (filtrosBtn && anchorRow) {
      anchorRow.appendChild(filtrosBtn);
    }
  } else if (section) {
    var sortRow = section.querySelector(".sort-row");
    if (sortRow) {
      sortRow.insertBefore(bar, sortRow.firstChild);
      anchorRow = sortRow;
    } else {
      var titleRow = section.querySelector(".section-title-row");
      if (titleRow) { titleRow.parentNode.insertBefore(bar, titleRow.nextSibling); anchorRow = titleRow; }
      else section.insertBefore(bar, section.firstChild);
    }
  }

  // Barra de checkpoints del dto por volumen (full-width, debajo de la fila).
  var cp = document.getElementById("expoCheckpoints");
  if (!cp) {
    cp = document.createElement("div");
    cp.id = "expoCheckpoints";
    cp.className = "expo-cp-wrap";
    cp.style.display = "none";
  }
  if (anchorRow && anchorRow.parentNode) {
    anchorRow.parentNode.insertBefore(cp, anchorRow.nextSibling);
  } else if (section) {
    section.insertBefore(cp, section.firstChild);
  }

  // Si ya hay un cliente activo, reflejarlo en el select oculto + chip.
  if (customerProfile && customerProfile.id) {
    _expoEnsureOption(customerProfile.id, customerProfile.business_name);
    var selNow = document.getElementById("customerSelect");
    if (selNow) selNow.value = customerProfile.id;
    _expoUpdateChip();
  }

  var elegirBtn = document.getElementById("expoElegirBtn");
  var nuevoBtn = document.getElementById("expoNuevoBtn");
  var contBtn = document.getElementById("expoContinuarBtn");
  if (elegirBtn) elegirBtn.addEventListener("click", expoOpenPickModal);
  if (nuevoBtn) nuevoBtn.addEventListener("click", expoNuevoCliente);
  if (contBtn) contBtn.addEventListener("click", expoOpenResumeModal);

  _expoWirePickModal();
  _expoWireResumeModal();
  // Mostrar "Continuar carga pausada" solo si hay clientes en staging.
  _expoRefreshResumeBtn();
}

// Muestra/oculta el botón "Continuar carga pausada" según haya pendientes.
async function _expoRefreshResumeBtn() {
  var btn = document.getElementById("expoContinuarBtn");
  if (!btn) return;
  // En el perfil propio del operador (sin cliente de expo elegido) NO mostrar el
  // botón: siempre hay clientes en staging y aparecería permanentemente. Solo se
  // ve con un cliente de expo activo (para editarlo/completarlo).
  if (!_expoActiveCustomer || !_expoClientMode) {
    btn.style.display = "none";
    return;
  }
  try {
    var r = await supabaseClient
      .from("expo_clientes_pendientes")
      .select("business_name,cuit,condicion_iva,vend,whatsapp,mail,direccion,numero,cp,localidad,provincia,direcciones_entrega")
      .eq("estado", "pendiente");
    // Re-chequear: mientras esperábamos, el operador pudo soltar el cliente y
    // volver a su perfil (race). Si ya no hay cliente activo, ocultar.
    if (!_expoActiveCustomer || !_expoClientMode) {
      btn.style.display = "none";
      return;
    }
    if (r.error || !r.data || !r.data.length) {
      btn.style.display = "none";
      return;
    }
    var incompletos = r.data.filter(function (d) {
      return !_expoDatosCompletos(d);
    }).length;
    btn.style.display = "";
    if (incompletos > 0) {
      // Hay clientes con datos a medias → "Continuar carga pausada".
      btn.classList.add("expo-btn-resume");
      btn.classList.remove("expo-btn-resume-done");
      btn.textContent = "Continuar carga pausada (" + incompletos + ")";
    } else {
      // Cliente activo completo → editar solo ese (los viejos completos no se listan).
      btn.classList.remove("expo-btn-resume");
      btn.classList.add("expo-btn-resume-done");
      btn.textContent = "✓ Editar cliente";
    }
  } catch (e) {
    btn.style.display = "none";
  }
}

// EXPO: panel de cierre en la confirmación. El operador manda el resumen por
// WhatsApp desde el teléfono de ventas (botón wa.me) — NO lo manda un bot solo.
// Aparece para CUALQUIER cliente expo (nuevo o ya elegido), no solo los nuevos.
// El PIN sólo se muestra para clientes NUEVOS (modo cliente-expo).
var _expoConfirmMsg = ""; // resumen armado, para el botón "Copiar resumen"
async function _expoShowConfirmPanel() {
  var panel = document.getElementById("expoConfirmPanel");
  if (!panel) return;
  var stdWrap = document.querySelector(".success-download-wrap");
  // Sólo tiene sentido en modo expo con un cliente activo (nuevo o elegido).
  var esExpo =
    EXPO_MODE && (_expoClientMode || _expoActiveCustomer);
  if (!esExpo || !lastConfirmedOrder || !(customerProfile && customerProfile.id)) {
    panel.style.display = "none";
    _expoConfirmMsg = "";
    if (stdWrap) stdWrap.style.display = ""; // cliente normal: descarga estándar visible
    return;
  }
  var esClienteNuevo = !!_expoClientMode;
  // El panel trae su propio botón de descarga → ocultar el estándar
  if (stdWrap) stdWrap.style.display = "none";
  var pin = "", wsp = "";
  try {
    var r = await supabaseClient
      .from("customers")
      .select("pin,whatsapp")
      .eq("id", customerProfile.id)
      .maybeSingle();
    if (r.data) {
      pin = r.data.pin || "";
      wsp = r.data.whatsapp || "";
    }
  } catch (e) { /* ignore */ }

  // Título + fila del PIN según sea cliente nuevo o ya existente.
  var titleEl = document.getElementById("expoConfirmTitle");
  var pinrowEl = document.getElementById("expoConfirmPinrow");
  if (titleEl) {
    titleEl.textContent = esClienteNuevo
      ? "Cliente nuevo — cerrá el circuito"
      : "Enviá la confirmación al cliente";
  }
  if (pinrowEl) pinrowEl.style.display = esClienteNuevo ? "" : "none";
  var pinEl = document.getElementById("expoConfirmPin");
  if (pinEl) pinEl.textContent = pin || "—";

  // ---- Resumen del pedido ----
  var dtoPct = Math.round(Number(lastConfirmedOrder.dtoVol || 0) * 100);
  var total = _expoMoney(lastConfirmedOrder.total || 0);
  var msg =
    "¡Tu pedido fue confirmado! ✅\n\n" +
    "Hola " + (lastConfirmedOrder.customerName || "") +
    ", te paso el resumen de tu pedido en Tierra Nativa:\n\n" +
    "Pedido N° " + (lastConfirmedOrder.orderId || "") + "\n" +
    "Total: $" + total + " + IVA\n" +
    "Descuento por volumen otorgado: " + dtoPct + "%\n";
  if (esClienteNuevo) {
    msg +=
      "Pago: Contado (1ra compra)\n\n" +
      "Para tus próximos pedidos online:\n" +
      "Usuario: tu CUIT\n" +
      "Clave: " + (pin || "(a definir)") + "\n\n";
  } else {
    msg += "\n";
  }
  msg += "¡Gracias por tu compra!";
  _expoConfirmMsg = msg;

  var waBtn = document.getElementById("expoConfirmWa");
  if (waBtn) {
    var num = String(wsp).replace(/[^0-9]/g, "");
    // Si el cliente no tiene WhatsApp cargado, wa.me igual abre el selector de
    // contacto con el texto pre-cargado; el operador elige a quién mandarlo.
    waBtn.href = "https://wa.me/" + num + "?text=" + encodeURIComponent(msg);
  }
  // Reset visual del botón "Copiar resumen" por si quedó en estado "copiado".
  var copyBtn = document.getElementById("expoConfirmCopy");
  if (copyBtn) copyBtn.classList.remove("expo-copied");
  panel.style.display = "";
}

// EXPO: copia el resumen del pedido al portapapeles (fallback para pegarlo a mano).
async function expoCopiarResumen() {
  var txt = _expoConfirmMsg || "";
  if (!txt) return;
  var ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(txt);
      ok = true;
    }
  } catch (e) { /* fallback abajo */ }
  if (!ok) {
    try {
      var ta = document.createElement("textarea");
      ta.value = txt;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ok = document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (e2) { /* nada */ }
  }
  var btn = document.getElementById("expoConfirmCopy");
  if (btn) {
    var prev = btn.dataset.origHtml || btn.innerHTML;
    btn.dataset.origHtml = prev;
    btn.classList.add("expo-copied");
    btn.innerHTML = ok ? "✓ Resumen copiado" : "No se pudo copiar";
    setTimeout(function () {
      btn.classList.remove("expo-copied");
      btn.innerHTML = btn.dataset.origHtml || prev;
    }, 1800);
  }
}

function expoOpenPickModal() {
  var m = document.getElementById("expoPickModal");
  if (!m) return;
  m.classList.add("open"); // ✅ clave: .modal se muestra con .open, no quitando .hidden
  m.classList.remove("hidden");
  m.setAttribute("aria-hidden", "false");
  var inp = document.getElementById("expoPickSearch");
  var res = document.getElementById("expoPickResults");
  if (inp) inp.value = "";
  if (res)
    res.innerHTML =
      '<div class="expo-pick-hint">Escribí cód, razón social, CUIT o dirección…</div>';
  if (inp) setTimeout(function () { inp.focus(); }, 30);
}

function expoClosePickModal() {
  var m = document.getElementById("expoPickModal");
  if (!m) return;
  m.classList.remove("open");
  m.classList.add("hidden");
  m.setAttribute("aria-hidden", "true");
}

async function _expoRunSearch() {
  var inp = document.getElementById("expoPickSearch");
  var res = document.getElementById("expoPickResults");
  if (!inp || !res) return;
  var q = inp.value.trim();
  if (q.length < 2) {
    res.innerHTML =
      '<div class="expo-pick-hint">Escribí al menos 2 caracteres…</div>';
    return;
  }
  res.innerHTML = '<div class="expo-pick-hint">Buscando…</div>';
  var r = await supabaseClient.rpc("buscar_cliente_expo", { p_q: q });
  // El input pudo cambiar mientras esperábamos: descartar respuesta vieja.
  if (inp.value.trim() !== q) return;
  if (r.error) {
    res.innerHTML =
      '<div class="expo-pick-hint expo-pick-err">Error: ' +
      _expoEsc(r.error.message) +
      "</div>";
    return;
  }
  var rows = r.data || [];
  if (!rows.length) {
    res.innerHTML =
      '<div class="expo-pick-hint">Sin resultados para "' +
      _expoEsc(q) +
      '"</div>';
    return;
  }
  var html = "";
  rows.forEach(function (c) {
    var dto = Number(c.dto_vol || 0);
    html +=
      '<button type="button" class="expo-pick-row" data-id="' +
      c.id +
      '"><span class="expo-pick-name">' +
      _expoEsc(c.business_name) +
      '</span><span class="expo-pick-sub">Cód ' +
      _expoEsc(c.cod_cliente || "—") +
      (c.cuit ? " · CUIT " + _expoEsc(c.cuit) : "") +
      (dto > 0 ? " · Dto " + Math.round(dto * 100) + "%" : "") +
      "</span>" +
      (c.direccion
        ? '<span class="expo-pick-dir">' +
          _expoEsc(c.direccion) +
          (c.localidad ? " · " + _expoEsc(c.localidad) : "") +
          "</span>"
        : "") +
      "</button>";
  });
  res.innerHTML = html;
  res.querySelectorAll(".expo-pick-row").forEach(function (row) {
    row.addEventListener("click", function () {
      var cust = rows.find(function (x) {
        return String(x.id) === row.dataset.id;
      });
      if (cust) expoApplyCustomer(cust);
    });
  });
}

async function expoApplyCustomer(cust, opts) {
  opts = opts || {};
  // Registrar en linkedCustomers para que el resto del flujo lo reconozca.
  if (
    !(linkedCustomers || []).some(function (c) {
      return String(c.customer_id) === String(cust.id);
    })
  ) {
    linkedCustomers.push({
      customer_id: cust.id,
      cod_cliente: cust.cod_cliente,
      business_name: cust.business_name,
      dto_vol: cust.dto_vol,
      vend: cust.vend,
    });
  }
  _expoEnsureOption(cust.id, cust.business_name);
  var sel = document.getElementById("customerSelect");
  if (sel) sel.value = cust.id;
  expoClosePickModal();

  // Hay un cliente real seleccionado: mostrar SUS precios (dto + web), no lista.
  _expoActiveCustomer = true;

  // ¿Es cliente NUEVO de expo? (forzado desde el alta, o presente en staging).
  // Solo esos entran en "modo cliente-expo" (escala + contado obligatorio + web).
  // En la misma consulta traemos los campos para calcular la COMPLETITUD (auto).
  _expoClientMode = !!opts.forceExpoNew;
  _expoClientComplete = false;
  try {
    var st = await supabaseClient
      .from("expo_clientes_pendientes")
      .select("business_name,cuit,condicion_iva,vend,whatsapp,mail,direccion,numero,cp,localidad,provincia,direcciones_entrega")
      .eq("customer_id", cust.id)
      .eq("estado", "pendiente")
      .order("actualizado_at", { ascending: false })
      .limit(1);
    if (!st.error && st.data && st.data.length) {
      _expoClientMode = true; // presente en staging = cliente de expo
      _expoClientComplete = _expoDatosCompletos(st.data[0]);
    }
  } catch (e) { /* si falla, queda incompleto (bloquea envío por las dudas) */ }
  if (_expoClientMode) await _expoLoadScale();

  await onLinkedCustomerSelected({ customerId: cust.id, fromRestore: !!opts.fromRestore });

  // Persistir el cliente elegido de expo en su propia clave, para restaurarlo al
  // volver de historial/sugerencias (que recargan la página): el cliente puede
  // venir del padrón y NO estar en linkedCustomers, así que la restauración
  // normal (que busca dentro de linkedCustomers) no lo encuentra.
  if (!opts.fromRestore) {
    try {
      localStorage.setItem(
        "lk_expo_selected_client",
        JSON.stringify({
          id: cust.id,
          cod_cliente: cust.cod_cliente,
          business_name: cust.business_name,
          dto_vol: cust.dto_vol,
          vend: cust.vend,
          expoClientMode: _expoClientMode,
        }),
      );
    } catch (e) {}
  }

  // Loke sigue al cliente elegido, no al operador admin (ver checkLokeAccess).
  await checkLokeAccess();
  updateLokeButton();
  if (hasLokeAccess) {
    try {
      await loadLokeProducts();
      renderLokeProducts();
    } catch (e) { /* opcional */ }
  } else if (typeof showSection === "function") {
    // Si estaba mirando la Línea Loke y el cliente nuevo no la tiene, salir.
    var lokeSec = document.getElementById("loke");
    if (lokeSec && lokeSec.classList.contains("active")) showSection("productos");
  }

  if (_expoClientMode) {
    // Forzar contado en la UI de pago (el cálculo ya lo fuerza igual).
    var paySel = document.getElementById("paymentSelect");
    if (paySel) paySel.value = "0.30";
    _expoSyncDto();
    updateCart();
    renderProducts();
  }
  _expoUpdateChip();
}

// EXPO: soltar el cliente elegido y volver al perfil del operador (admin).
// Evita quedarse "pegado" a un cliente que no se terminó de fijar.
function expoClearCustomer() {
  if (cart && cart.length > 0) {
    if (
      !window.confirm(
        "Vas a soltar al cliente y volver a tu perfil. El pedido en curso (" +
          cart.length +
          " ítem/s) se vacía. ¿Continuar?",
      )
    )
      return;
    cart.splice(0, cart.length);
    if (typeof saveCartToLS === "function") saveCartToLS();
  }
  try {
    localStorage.removeItem("lk_expo_selected_client");
  } catch (e) {}
  _expoActiveCustomer = false;
  _expoClientMode = false;
  _expoClientComplete = false;
  var sel = document.getElementById("customerSelect");
  if (sel) sel.value = VENDOR_SELF_VALUE;
  // Restaurar el perfil propio del operador (misma vía que "Perfil Vendedor").
  Promise.resolve(
    onLinkedCustomerSelected({ customerId: VENDOR_SELF_VALUE, fromRestore: true }),
  ).then(function () {
    _expoUpdateChip();
    checkLokeAccess().then(function () {
      updateLokeButton();
    });
    if (typeof updateCart === "function") updateCart();
    if (typeof renderProducts === "function") renderProducts();
    if (typeof refreshSubmitEnabled === "function") refreshSubmitEnabled();
  });
}
window.expoClearCustomer = expoClearCustomer;
window.expoCopiarResumen = expoCopiarResumen;

/* ===================================================================
   EXPO — Lector de QR de credenciales (autocompleta "Nuevo cliente")
   Escaneo con la cámara (jsQR self-hosted, anda en iOS Safari) + parser
   multi-formato. El parseo (_expoParseQR) está aislado: cambiar de formato
   es tocar UNA función.
   Formato confirmado (credencial EXPOSITOR Expo Presentes), pipe-delimited:
     CODE|NOMBRE|APELLIDO|EMPRESA||||||   ej: 822126|JUAN|FARIAS|CHEF||||||
   OJO: el campo 3 es la EMPRESA (razón social), no el cargo. El formato del
   VISITANTE no está confirmado; si viene pipe-delimited se parsea igual.
   =================================================================== */
var _expoQrStream = null;
var _expoQrRaf = null;
var _expoJsqrLoading = null;

function _expoLoadJsQR() {
  if (window.jsQR) return Promise.resolve();
  if (_expoJsqrLoading) return _expoJsqrLoading;
  _expoJsqrLoading = new Promise(function (resolve, reject) {
    var s = document.createElement("script");
    s.src = "jsqr.js?v=1";
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error("No se pudo cargar el lector de QR")); };
    document.head.appendChild(s);
  });
  return _expoJsqrLoading;
}

// --- Parseo del texto crudo del QR: detecta formato y devuelve campos ---
function _expoParseQR(raw) {
  var text = String(raw == null ? "" : raw).trim();
  if (!text) return { source: "vacio" };
  if (/^BEGIN:VCARD/i.test(text)) return _expoParseVCard(text);
  if (/^mailto:/i.test(text)) return _expoParseMailto(text);
  // tel: → cámara nativa de iOS masticando el QR; se saca por contenido.
  if (/^tel:/i.test(text)) return _expoParseHeur(text);
  if (_expoIsExpoPresentes(text)) return _expoParseExpoPresentes(text);
  if (/^https?:\/\//i.test(text)) return _expoParseUrl(text);
  if (/^MECARD:/i.test(text)) return _expoParseMecard(text);
  return { fullName: text, source: "qr_text" };
}

// Credencial COMERCIANTE/VISITANTE Expo Presentes: mailto: + pipe (URL-encoded, %7C = |).
// Layout POSICIONAL confirmado sobre el QR real
//   (raw: mailto:SRL%7C43322970%7C30515842450%7C1130982609%7Ctomibeviglia@gmail.com):
//     0:RAZÓN SOCIAL | 1:DNI | 2:CUIT | 3:TELÉFONO | 4:EMAIL
// DNI (1) se ignora a propósito; se toma razón social, CUIT, teléfono y email.
function _expoParseMailto(text) {
  var body = text.replace(/^mailto:/i, "");
  try { body = decodeURIComponent(body); } catch (e) {}
  body = body.trim();
  if (body.indexOf("|") >= 0) {
    var f = body.split("|");
    var out = { source: "qr_visitante" };
    var razon = (f[0] || "").trim();
    var cuit = (f[2] || "").replace(/\D/g, "");
    var tel = (f[3] || "").replace(/\D/g, "");
    var email = (f[4] || "").trim();
    if (razon) out.company = razon;
    if (cuit.length === 11) out.cuit = cuit;
    if (tel) out.whatsapp = tel;
    if (email && email.indexOf("@") > 0) out.email = email;
    return out;
  }
  return { email: body || undefined, source: "qr_mailto" };
}

function _expoIsExpoPresentes(text) {
  if (text.indexOf("|") < 0) return false;
  var f = text.split("|");
  if (f.length < 5) return false;
  var c0 = (f[0] || "").trim();
  return c0.length > 0 && c0.length <= 20 && /^[A-Za-z0-9-]+$/.test(c0);
}

function _expoParseExpoPresentes(text) {
  var f = text.split("|");
  var nombre = (f[1] || "").trim();
  var apellido = (f[2] || "").trim();
  var empresa = (f[3] || "").trim();
  var fullName = (nombre + " " + apellido).trim();
  return {
    fullName: fullName || undefined,
    company: empresa || undefined,
    source: "qr_expo_presentes",
  };
}

// Extractor por CONTENIDO (fallback para strings masticados: tel:, etc.).
// Saca email, CUIT (11 díg) y teléfono (10 díg); NO intenta razón social.
function _expoParseHeur(text) {
  var out = { source: "qr_heuristico" };
  var email = (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [])[0];
  if (email) out.email = email;
  var cuit = (text.match(/(?:^|\D)(\d{11})(?:\D|$)/) || [])[1];
  if (cuit) out.cuit = cuit;
  var resto = cuit ? text.replace(cuit, "") : text;
  var tel = (resto.match(/(?:^|\D)(\d{10})(?:\D|$)/) || [])[1];
  if (tel) out.whatsapp = tel;
  return out;
}

function _expoParseVCard(text) {
  function grab(re) { var m = text.match(re); return m ? m[1].trim() : ""; }
  var fn = grab(/(?:^|\n)FN:(.+)/i);
  if (!fn) {
    var n = grab(/(?:^|\n)N:(.+)/i);
    if (n) fn = n.split(";").filter(Boolean).reverse().join(" ").trim();
  }
  return {
    fullName: fn || undefined,
    company: grab(/(?:^|\n)ORG:(.+)/i) || undefined,
    whatsapp: grab(/(?:^|\n)TEL[^:]*:(.+)/i) || undefined,
    email: grab(/(?:^|\n)EMAIL[^:]*:(.+)/i) || undefined,
    position: grab(/(?:^|\n)TITLE:(.+)/i) || undefined,
    source: "qr_vcard",
  };
}

function _expoParseMecard(text) {
  function grab(k) { var m = text.match(new RegExp(k + ":([^;]*)", "i")); return m ? m[1].trim() : ""; }
  var n = grab("N");
  if (n) n = n.split(",").filter(Boolean).reverse().join(" ").trim();
  return {
    fullName: n || undefined,
    whatsapp: grab("TEL") || undefined,
    email: grab("EMAIL") || undefined,
    company: grab("ORG") || undefined,
    source: "qr_mecard",
  };
}

function _expoParseUrl(text) {
  var out = { source: "qr_url" };
  try {
    var u = new URL(text);
    var q = u.searchParams;
    var nombre = q.get("nombre") || q.get("name");
    var empresa = q.get("empresa") || q.get("company");
    var wsp = q.get("whatsapp") || q.get("tel") || q.get("phone");
    var mail = q.get("email");
    if (nombre) out.fullName = nombre;
    if (empresa) out.company = empresa;
    if (wsp) out.whatsapp = wsp;
    if (mail) out.email = mail;
  } catch (e) {}
  return out;
}

// --- Rellena el formulario con lo que trajo el QR. Devuelve campos completados.
function _expoFillFromQR(p) {
  var llenos = [];
  function set(id, val, label) {
    if (!val) return;
    var el = document.getElementById(id);
    if (!el) return;
    el.value = val;
    llenos.push(label);
  }
  // Razón social: empresa; si no vino empresa, el nombre completo.
  set("expoNewRazon", p.company || p.fullName, "Razón social");
  if (p.cuit) set("expoNewCuit", String(p.cuit).replace(/[^0-9]/g, ""), "CUIT");
  set("expoNewMail", p.email, "Mail");
  if (p.whatsapp) set("expoNewWhatsapp", String(p.whatsapp).replace(/[^0-9]/g, ""), "WhatsApp");
  if (p.province) {
    var sel = document.getElementById("expoNewProvFiscal");
    if (sel) {
      var want = String(p.province).toLowerCase();
      Array.prototype.forEach.call(sel.options, function (o) {
        if (o.value && o.value.toLowerCase() === want) { sel.value = o.value; llenos.push("Provincia"); }
      });
    }
  }
  if (typeof _expoNewSyncComplete === "function") _expoNewSyncComplete();
  return llenos;
}

// --- Escaneo con la cámara ---
function _expoScanQR() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert("Este dispositivo/navegador no permite usar la cámara. Cargá los datos a mano.");
    return;
  }
  var ov = document.getElementById("expoQrScan");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "expoQrScan";
    ov.className = "expo-qr-scan";
    ov.innerHTML =
      '<div class="expo-qr-inner">' +
      '<video id="expoQrVideo" playsinline muted autoplay></video>' +
      '<div class="expo-qr-frame"></div>' +
      '<div class="expo-qr-hint" id="expoQrHint">Apuntá al QR de la credencial…</div>' +
      '<button type="button" class="expo-qr-cancel" onclick="_expoStopScan()">Cancelar</button>' +
      "</div>";
    document.body.appendChild(ov);
  }
  ov.style.display = "flex";
  var video = document.getElementById("expoQrVideo");
  var hint = document.getElementById("expoQrHint");

  _expoLoadJsQR().then(function () {
    return navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .catch(function () {
        // Laptop/desktop sin cámara trasera: usar la que haya.
        return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      });
  }).then(function (stream) {
    _expoQrStream = stream;
    video.srcObject = stream;
    video.setAttribute("playsinline", "");
    return video.play();
  }).then(function () {
    var canvas = document.createElement("canvas");
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    var tick = function () {
      if (!_expoQrStream) return;
      if (video.readyState >= 2 && video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        try {
          var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          var code = window.jsQR ? window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" }) : null;
          if (code && code.data) { _expoOnQrDecoded(code.data); return; }
        } catch (e) {}
      }
      _expoQrRaf = requestAnimationFrame(tick);
    };
    _expoQrRaf = requestAnimationFrame(tick);
  }).catch(function (err) {
    if (hint) hint.textContent = "No se pudo abrir la cámara: " + (err && err.message ? err.message : err);
    setTimeout(_expoStopScan, 2800);
  });
}

function _expoStopScan() {
  if (_expoQrRaf) { cancelAnimationFrame(_expoQrRaf); _expoQrRaf = null; }
  if (_expoQrStream) {
    try { _expoQrStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    _expoQrStream = null;
  }
  var ov = document.getElementById("expoQrScan");
  if (ov) ov.style.display = "none";
}

function _expoOnQrDecoded(raw) {
  _expoStopScan();
  var p = _expoParseQR(raw);
  var llenos = _expoFillFromQR(p);
  var msg = llenos.length
    ? "QR leído. Completado: " + llenos.join(", ") + ". Revisá y completá el resto."
    : "QR leído pero sin datos para cargar (formato " + (p.source || "?") + "). Cargá a mano.";
  if (typeof _expoNewStatus === "function") _expoNewStatus(msg, !llenos.length);
  else alert(msg);
  // Si no reconoció ningún campo, mostrar el texto crudo para poder ajustar el
  // parser a un formato de credencial nuevo. En un escaneo exitoso no molesta.
  if (!llenos.length) {
    try { alert("QR sin campos reconocidos. Texto crudo:\n\n" + String(raw == null ? "" : raw)); } catch (e) {}
  }
  try { console.log("[EXPO QR crudo]", raw); } catch (e) {}
}

window._expoScanQR = _expoScanQR;

// ---- EXPO: Nuevo cliente (Fase 2) ----
// Estado del alta en curso: permite pausar (guardar parcial) y volver a editar.
var _expoNewState = { id: null, authId: null };
var _expoNewWired = false;

// PIN de 6 DÍGITOS: es el password del login del cliente (CUIT + PIN) y la tabla
// customers tiene el constraint customers_pin_6_digits (pin ~ '^\d{6}$').
function _expoNewGenPin() {
  var r = "";
  for (var i = 0; i < 6; i++) r += String(Math.floor(Math.random() * 10));
  return r;
}

// Crea el usuario auth con un cliente aparte (no pisa la sesión del operador).
async function _expoCreateAuthUser(cuit, pin) {
  var digits = String(cuit || "").replace(/[^0-9]/g, "");
  if (!digits) return null;
  var email = digits + "@cuit.tierranativa";
  var tmp = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  var res = await tmp.auth.signUp({ email: email, password: pin });
  if (res.error) {
    if (res.error.message.toLowerCase().includes("already registered")) {
      var lg = await tmp.auth.signInWithPassword({ email: email, password: pin });
      if (!lg.error && lg.data.user) return lg.data.user.id;
    }
    console.warn("expo auth signup:", res.error.message);
    return null;
  }
  return res.data.user ? res.data.user.id : null;
}

function _expoNewStatus(msg, kind) {
  var el = document.getElementById("expoNewStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = kind === "err" ? "#b91c1c" : kind === "ok" ? "#166534" : "#6b7280";
}

// Provincias argentinas (24 jurisdicciones) para los desplegables del alta.
var EXPO_PROVINCIAS = [
  "Buenos Aires", "Ciudad Autónoma de Buenos Aires", "Catamarca", "Chaco",
  "Chubut", "Córdoba", "Corrientes", "Entre Ríos", "Formosa", "Jujuy",
  "La Pampa", "La Rioja", "Mendoza", "Misiones", "Neuquén", "Río Negro",
  "Salta", "San Juan", "San Luis", "Santa Cruz", "Santa Fe",
  "Santiago del Estero", "Tierra del Fuego", "Tucumán",
];
function _expoProvinciaOptions(selected) {
  var out = '<option value="">Provincia</option>';
  EXPO_PROVINCIAS.forEach(function (p) {
    out +=
      '<option value="' + p + '"' +
      (String(selected || "") === p ? " selected" : "") +
      ">" + p + "</option>";
  });
  return out;
}

// Expresos/transportistas TAL CUAL están cargados en ISIS (última columna del
// export de sucursales). El campo Expreso autocompleta contra esta lista para
// que se elija el nombre EXACTO y la importación al ERP no falle por un typo.
var EXPO_EXPRESOS = [
  "11 de Marzo", "4H S.R.L.", "7 de Agosto", "AG Distribuciones Cordoba", "AGUILAR", "ALBO",
  "ALCUVA", "ALEX", "ALONSO", "Alta Cba Encomiendas", "ALVEAR SUR", "AMANES", "AMICCI",
  "ANDESMAR", "Andina HC SRL", "ANDINA HNOS", "ARAVERA", "ARIAS (COMODORO)",
  "ARIAS (SANTA FE)", "ARNES", "ASCENCIO", "Astutti", "AVELLANEDA", "AZUL",
  "BAIRES MATADEROS", "BALUT", "BARILOCHE", "BBB Express", "BELGRANO", "BICENTENARIO",
  "BILLETA", "BIN", "BISONTE", "BOLLATI", "BOLLATTI", "CALTABIANO", "CAMIONERA MENDOCINA",
  "CARDONE S.A.", "CARENA", "CARGO", "CARLITOS (para Entre Rios)",
  "CARLITOS (para Prov BsAS)", "CARNEVALI", "CAROSIO Y VAIROLATTI",
  "Carossio, Vairolatti y Cía SRL", "CATALBIANO", "CAÑADA DE GOMEZ", "CD Bazares en Linea",
  "CEMA", "CENTRAL ARGENTINO", "CHAMORRO", "CHAVEZ HNOS", "Chilecito", "CHIVILCOY",
  "CIARLANTINI", "CONTE", "COOP DE TRABAJO RSUT LTDA", "COPAR", "CRUZ DEL SUR", "DE LA VEGA",
  "Delog", "DEMONTE", "DIAGONAL", "DIEMAR", "DON ROBERTO", "DOÑA RAMONA", "EL CHANGUITO",
  "EL CHINO", "EL FARO SA", "EL JESUITA", "EL NOBLE", "EL RAPIDO", "EL RAYO", "El Resero",
  "EL VASQUITO", "ENCARGO", "ENCARGO EXPRESS", "ENCOMIENDAS CARLOS CASARES",
  "ENTREGA DEPOSITO", "Estacion De Cargas Serena SRL", "ESTRELLA", "EXPRESO 2 CIUDADES",
  "EXPRESO ALFA", "Expreso Biletta S.R.L.", "EXPRESO CAMUFER", "EXPRESO CAVALA",
  "Expreso de a 4 Bahia", "Expreso El Rapido", "Expreso El Vasquito SA", "EXPRESO FUEGUINOS",
  "EXPRESO GARMENDIA", "Expreso Interprovincial", "Expreso Junin", "Expreso Lo Bruno",
  "EXPRESO MAIPU", "EXPRESO MKS", "EXPRESO PANAMA", "EXPRESO PUERTAS DE CUYO",
  "EXPRESO RICHTER", "Expreso Suarence", "EXPRESO T.A.S.", "EXPRESO TRAN VITALE",
  "Expreso Trole", "EXPRESO TROLE", "Expreso Valeiras", "FANTACCI", "Ferrocargas del Sur",
  "FONTANA", "FORZAP", "FRASER", "FRONTERA", "GAL LOGISTICA SA",
  "Gestiones y Soluciones Logist", "GOMEZ", "Grupo Nava", "Guillan", "HACHA DE PIEDRA",
  "HADA", "HERMES", "ILIA", "IMAZ", "INCA", "INTERPROVINCIAL", "JE Logistica",
  "JOSE BELARDI", "KEMBER", "L y D Logistica", "LA ANTARTIDA", "LA SEVILLANITA", "LAN CARG",
  "LANCIONI", "LARRAZ", "LAST EXPRES", "Lazaro Cargas", "LEO", "LESCANO", "LEZANA", "Lider",
  "Logiscar SAS", "LOGISTICA ANDREA", "Logistica Busca Lo Mio", "Logistica Cardo",
  "Logistica Difabio", "LOGISTICA SALTA SRL", "LOGISTICA SATELITAL SRL",
  "Logistica TransSAB", "LOPEZ", "LOTSA", "LUCES", "LUJAN DE CUYO", "LUKE", "LURO", "M Z",
  "MALARGUE", "MF Logistica", "MIGUEL MESSARA", "MONTERO HERMANOS SRL", "MORABITO",
  "Morresi", "MOSTTO- PERGAMINO", "MOSTTO- PORTELA", "Moyano Cargas", "NOR PATAGONICO",
  "NT SERVICIOS", "NUB LOGISTICA S.A.S", "NUB LOGISTICAS SAS", "NUEVA ROMA",
  "NUEVO HORIZONTE", "NUEVO TRANSPORTE SRL", "NUEVO VALLE", "Oliva", "OLIVA HNOS", "ORION",
  "ORO BLANCO", "ORO NEGRO", "Ortiz", "PACINI", "PEDRITO", "PIGUE", "POLI", "PRADA",
  "PREMAT", "PRIVITERA", "PUNILLA", "Raosa S.R.L.", "Red del Norte", "RETIRA", "RICHARDS",
  "RIDISSI", "Rio Lavayen", "RIVADAVIA", "RIVERO", "RODRIGO", "RODRIGUEZ", "RUTA 11",
  "SALDAR", "SALMA", "SALTA", "San Carlos (Bs As)", "SAN CARLOS (Rosario)", "SAN JOSE",
  "SAN NICOLAS", "SANCHEZ", "SANELLI", "SANTA ELISA", "SANTA ROSA", "SANTULI", "SARITA",
  "Scor Dina", "Servicargas Transporte", "Servicios Logisticos y Postale", "SEVILLANITA",
  "SNAIDER", "SOLMAR", "SPACAPAN", "SUDAMERICANO", "SZILAK S.R.L.", "TAQSA PAQ", "TARRES",
  "TB LOGISTICA", "TIM CAR", "Todo Facil Express", "Tokio", "TRADELOG", "Trand Melly's",
  "TRANS", "TRANS-NORT", "TRANSCARGO ARGENTINA", "Transfull SA", "TRANSGUAZU", "TRANSNORT",
  "TRANSP THUNDER", "TRANSP.LAS FLORES", "Transporte Falco", "Transporte Frontera",
  "TRANSPORTE HIPPOCARGO", "Transporte Iros", "Transporte Jaime", "TRANSPORTE LA RUTA S-A-",
  "Transporte Milana", "TRANSPORTE PILONI", "Transporte RSUT", "TRANSPORTE SALDAR",
  "Transporte Santa Fe", "Transporte Sierra", "Transportes Union SA", "TRANSVEL", "TRAVERSO",
  "Tuñon y Mossotto", "UNION (CHUBUT)", "VALLE DE LERMA", "VELOMAX", "VESPRINI", "Victorica",
  "VILLA ANGELA", "VILLANOVA", "YOUVE", "Ñandubay",
];
// Crea (una vez) el <datalist> global que alimenta el autocomplete de Expreso.
function _expoBuildExpresoDatalist() {
  if (document.getElementById("expoExpresoList")) return;
  var dl = document.createElement("datalist");
  dl.id = "expoExpresoList";
  var html = "";
  EXPO_EXPRESOS.forEach(function (n) {
    html += '<option value="' + _expoEsc(n) + '"></option>';
  });
  dl.innerHTML = html;
  document.body.appendChild(dl);
}
function _expoFillProvincias() {
  var sel = document.getElementById("expoNewProvFiscal");
  if (sel) sel.innerHTML = _expoProvinciaOptions(sel.value);
}

function _expoAddrAddRow(prefill, prepend) {
  prefill = prefill || {};
  _expoBuildExpresoDatalist();
  var list = document.getElementById("expoAddrList");
  if (!list) return;
  var row = document.createElement("div");
  row.className = "expo-addr-row";
  row.innerHTML =
    '<input class="expo-inp expo-addr-tit" placeholder="Nombre sucursal — ej: Gurruchaga 2100 - Palermo" />' +
    '<div class="expo-addr-fields">' +
    '<input class="expo-inp expo-addr-dir" placeholder="Dirección de entrega" />' +
    '<input class="expo-inp expo-addr-loc" placeholder="Localidad / zona" />' +
    '<select class="expo-inp expo-addr-prov">' + _expoProvinciaOptions(prefill.provincia) + "</select>" +
    '<input class="expo-inp expo-addr-exp" list="expoExpresoList" autocomplete="off" placeholder="Expreso (empezá a escribir)" />' +
    '<button type="button" class="expo-addr-del" title="Quitar">&times;</button>' +
    "</div>";
  row.querySelector(".expo-addr-tit").value = prefill.titulo || "";
  row.querySelector(".expo-addr-dir").value = prefill.direccion || "";
  row.querySelector(".expo-addr-loc").value = prefill.localidad || "";
  row.querySelector(".expo-addr-prov").value = prefill.provincia || "";
  row.querySelector(".expo-addr-exp").value = prefill.expreso || "";
  // Autocompletar el título como "dirección - zona" si el operador no lo tocó.
  var titEl = row.querySelector(".expo-addr-tit");
  var dirEl = row.querySelector(".expo-addr-dir");
  var locEl = row.querySelector(".expo-addr-loc");
  function _autoTit() {
    if (titEl.dataset.touched === "1") return;
    var d = dirEl.value.trim(), l = locEl.value.trim();
    titEl.value = d && l ? d + " - " + l : d || l || "";
  }
  dirEl.addEventListener("input", _autoTit);
  locEl.addEventListener("input", _autoTit);
  titEl.addEventListener("input", function () { titEl.dataset.touched = "1"; });
  row.querySelector(".expo-addr-del").addEventListener("click", function () {
    row.remove();
    // Garantizar mínimo 1 fila
    if (!document.querySelectorAll("#expoAddrList .expo-addr-row").length)
      _expoAddrAddRow();
    _expoNewSyncComplete();
  });
  // Las sucursales nuevas (botones Agregar / Usar fiscal) van ARRIBA (primeras).
  if (prepend && list.firstChild) list.insertBefore(row, list.firstChild);
  else list.appendChild(row);
  _expoNewSyncComplete();
}

function _expoAddrCollect() {
  var out = [];
  document.querySelectorAll("#expoAddrList .expo-addr-row").forEach(function (r) {
    var dir = (r.querySelector(".expo-addr-dir").value || "").trim();
    if (!dir) return;
    var loc = (r.querySelector(".expo-addr-loc").value || "").trim();
    var tit = (r.querySelector(".expo-addr-tit").value || "").trim();
    out.push({
      titulo: tit || (loc ? dir + " - " + loc : dir), // nombre de sucursal
      direccion: dir,
      localidad: loc,
      provincia: (r.querySelector(".expo-addr-prov").value || "").trim(),
      expreso: (r.querySelector(".expo-addr-exp").value || "").trim(),
    });
  });
  return out;
}

// Vendedores (código ERP → nombre). El 7 (FCA = nosotros) va primero.
var EXPO_VENDEDORES = [
  { c: "7", n: "FCA (Nosotros)" },
  { c: "1", n: "Andres O. Luca" }, { c: "2", n: "Audisio Mario" },
  { c: "3", n: "Cagnolo Mario" }, { c: "4", n: "Carrizo Gabriel" },
  { c: "5", n: "Fabrica J" }, { c: "6", n: "Fabrica P" },
  { c: "8", n: "Horizonte" }, { c: "9", n: "Juan Jose Zaffaroni" },
  { c: "10", n: "Lisa Katz" }, { c: "11", n: "Marcos Lilo" },
  { c: "12", n: "Tomas Schinder" }, { c: "13", n: "Monin Leticia S" },
  { c: "14", n: "Norhon" }, { c: "15", n: "O.M.D. Argentina" },
  { c: "16", n: "Pablo Antonelli" }, { c: "17", n: "Pedro Serra" },
  { c: "18", n: "Primer Precio" }, { c: "19", n: "Sphan" },
  { c: "20", n: "Supermercados" }, { c: "21", n: "Thomas LK" },
  { c: "22", n: "La Bianca" }, { c: "23", n: "Mottura" },
];

function _expoFillVendedores() {
  var sel = document.getElementById("expoNewVend");
  if (!sel) return;
  sel.innerHTML = EXPO_VENDEDORES.map(function (v) {
    return '<option value="' + v.c + '">' + v.c + " - " + v.n + "</option>";
  }).join("");
  sel.value = "7"; // default: nosotros
}

async function expoNuevoCliente() {
  var m = document.getElementById("expoNewModal");
  if (!m) return;
  _expoNewState = { id: null, authId: null };
  [
    "expoNewRazon", "expoNewCuit", "expoNewWhatsapp",
    "expoNewMail", "expoNewCod",
    "expoNewDirFiscal", "expoNewNumFiscal", "expoNewCpFiscal",
    "expoNewLocFiscal", "expoNewProvFiscal",
  ].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.value = "";
  });
  var condIva = document.getElementById("expoNewCondIva");
  if (condIva) condIva.value = "Responsable Inscripto";
  _expoFillVendedores();
  _expoFillProvincias();
  document.getElementById("expoNewPin").value = _expoNewGenPin();
  document.getElementById("expoAddrList").innerHTML = "";
  _expoAddrAddRow();
  _expoNewStatus("");
  _expoWireNewModal();
  _expoNewSyncComplete();
  m.classList.add("open"); // ✅ clave: .modal se muestra con .open
  m.classList.remove("hidden");
  m.setAttribute("aria-hidden", "false");
  // Código ASIGNADO por el sistema (contador propio, no depende del padrón parcial).
  try {
    var r = await supabaseClient.rpc("expo_peek_cod");
    var codEl = document.getElementById("expoNewCod");
    if (codEl && !r.error && r.data != null) codEl.value = r.data;
  } catch (e) { /* opcional */ }
}

window._expoCloseNewModal = _expoCloseNewModal;
function _expoCloseNewModal() {
  var m = document.getElementById("expoNewModal");
  if (!m) return;
  m.classList.remove("open");
  m.classList.add("hidden");
  m.setAttribute("aria-hidden", "true");
}

// Validación de CUIT argentino (11 dígitos + dígito verificador módulo 11).
// Devuelve true si el DV cierra. Los placeholders 99… no cierran → se avisa,
// pero NO se bloquea (el ERP los usa a propósito).
function _expoCuitValido(digits) {
  digits = String(digits || "").replace(/[^0-9]/g, "");
  if (digits.length !== 11) return false;
  var pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  var suma = 0;
  for (var i = 0; i < 10; i++) suma += parseInt(digits[i], 10) * pesos[i];
  var resto = suma % 11;
  var dv = 11 - resto;
  if (dv === 11) dv = 0;
  if (dv === 10) return false; // CUIT inválido por norma
  return dv === parseInt(digits[10], 10);
}

// Busca clientes existentes con el MISMO CUIT (excluyendo el propio en edición).
// Reusa buscar_cliente_expo (matchea por dígitos) y filtra por coincidencia exacta.
async function _expoDuplicadosCuit(cuit, selfId) {
  var out = [];
  try {
    var r = await supabaseClient.rpc("buscar_cliente_expo", { p_q: cuit });
    if (!r.error && r.data) {
      r.data.forEach(function (c) {
        if (selfId && String(c.id) === String(selfId)) return;
        var cd = String(c.cuit || "").replace(/[^0-9]/g, "");
        if (cd && cd === cuit) out.push(c);
      });
    }
  } catch (e) { /* si falla la búsqueda, no bloquea el alta */ }
  return out;
}

// mode: "order"    → guarda parcial y va a armar el pedido (arranque incompleto).
//       "complete" → exige TODOS los datos (salvo expreso). Si falta, avisa qué
//                    y NO cierra (igual guarda lo que hay). Si está completo,
//                    cierra y lleva al carrito para pagar/enviar.
async function _expoGuardarNuevo(mode) {
  if (mode === true) mode = "order"; // compat retro (viejo pauseOnly)
  mode = mode || "order";
  var razon = (document.getElementById("expoNewRazon").value || "").trim();
  var cuit = (document.getElementById("expoNewCuit").value || "").replace(/[^0-9]/g, "");
  // Mínimo para registrar al cliente: SOLO la razón social (para tenerlo cargado
  // apenas llega y arrancar el pedido). El CUIT y el resto pueden venir después;
  // el ENVÍO del pedido queda bloqueado hasta que esté completo (chequeo auto).
  if (!razon) {
    _expoNewStatus("La razón social es obligatoria para registrar al cliente.", "err");
    return;
  }
  var addrs = _expoAddrCollect();

  // Chequeos de CUIT solo si ya lo cargaron (puede completarse más tarde).
  if (cuit) {
    // Validar CUIT (avisar, no bloquear: hay placeholders 99… a propósito).
    if (!_expoCuitValido(cuit)) {
      if (!confirm(
        "El CUIT " + cuit + " no parece válido (dígito verificador no cierra o no tiene 11 dígitos).\n\n" +
        "¿Guardar igual? (usá esto solo si es un CUIT provisorio)."
      )) {
        _expoNewStatus("Revisá el CUIT.", "err");
        return;
      }
    }
    // Aviso de duplicado por CUIT (excluye el propio si es edición).
    var dups = await _expoDuplicadosCuit(cuit, _expoNewState.id);
    if (dups.length) {
      var lista = dups.slice(0, 5).map(function (c) {
        return "• Cód " + (c.cod_cliente || "—") + " — " + (c.business_name || "");
      }).join("\n");
      if (!confirm(
        "Ya existe " + dups.length + " cliente(s) con el CUIT " + cuit + ":\n\n" +
        lista + "\n\n¿Crear/actualizar igual?"
      )) {
        _expoNewStatus("Alta cancelada: CUIT ya existente.", "err");
        return;
      }
    }
  }
  var cod = (document.getElementById("expoNewCod").value || "").trim();
  var pin = document.getElementById("expoNewPin").value;
  // El Dto por volumen NO se carga acá: se calcula por la escala en función del
  // pedido. El cliente se crea con dto 0 (el ERP fija el dto vigente después).
  var dto = 0;
  var whatsapp = (document.getElementById("expoNewWhatsapp").value || "").trim();
  var mail = (document.getElementById("expoNewMail").value || "").trim();
  var vend = (document.getElementById("expoNewVend").value || "").trim();
  var dirFiscal = (document.getElementById("expoNewDirFiscal").value || "").trim();
  var numFiscal = (document.getElementById("expoNewNumFiscal").value || "").trim();
  var cpFiscal = (document.getElementById("expoNewCpFiscal").value || "").trim();
  var locFiscal = (document.getElementById("expoNewLocFiscal").value || "").trim();
  var provFiscal = (document.getElementById("expoNewProvFiscal").value || "").trim();
  var tel = ""; // campo Teléfono removido del alta (queda WhatsApp)
  var condIvaEl = document.getElementById("expoNewCondIva");
  var condIva = condIvaEl ? condIvaEl.value : "";

  // Completitud automática (todo salvo expreso).
  var formData = {
    business_name: razon, cuit: cuit, condicion_iva: condIva, vend: vend,
    whatsapp: whatsapp, mail: mail, direccion: dirFiscal, numero: numFiscal,
    cp: cpFiscal, localidad: locFiscal, provincia: provFiscal,
    direcciones_entrega: addrs,
  };
  var completo = _expoDatosCompletos(formData);

  var pauseBtn = document.getElementById("expoNewPause");
  var goBtn = document.getElementById("expoNewGoOrder");
  if (pauseBtn) pauseBtn.disabled = true;
  if (goBtn) goBtn.disabled = true;
  _expoNewStatus("Guardando…");

  try {
    if (!_expoNewState.id) {
      // Reservar el código asignado por el sistema (solo en el alta inicial).
      try {
        var rc = await supabaseClient.rpc("expo_reservar_cod");
        if (!rc.error && rc.data != null) {
          cod = String(rc.data);
          var ce = document.getElementById("expoNewCod");
          if (ce) ce.value = cod;
        }
      } catch (e) { /* si falla, queda el código del peek */ }
    }
    var cust = {
      business_name: razon,
      cuit: cuit || null,
      cod_cliente: cod ? parseInt(cod, 10) : null,
      dto_vol: dto,
      vend: vend || null,
      mail: mail || null,
      whatsapp: whatsapp || null,
      direccion_fiscal: dirFiscal || null,
      localidad: locFiscal || null,
    };

    // El usuario auth (login del cliente) SOLO se puede crear con CUIT (el email
    // sintético es <cuit>@cuit.tierranativa). Si todavía no hay CUIT, se difiere:
    // se crea cuando se complete. Puede pasar en el alta o en un guardado posterior.
    if (cuit && !_expoNewState.authId) {
      _expoNewState.authId = await _expoCreateAuthUser(cuit, pin);
    }

    if (!_expoNewState.id) {
      var insPayload = Object.assign({}, cust, { pin: pin });
      if (_expoNewState.authId) insPayload.auth_user_id = _expoNewState.authId;
      var ins = await supabaseClient
        .from("customers")
        .insert(insPayload)
        .select("id")
        .single();
      if (ins.error) throw ins.error;
      _expoNewState.id = ins.data.id;
    } else {
      var updPayload = Object.assign({}, cust);
      // Si recién ahora se creó el auth (CUIT cargado más tarde), vincularlo.
      if (_expoNewState.authId) updPayload.auth_user_id = _expoNewState.authId;
      var upd = await supabaseClient
        .from("customers")
        .update(updPayload)
        .eq("id", _expoNewState.id);
      if (upd.error) throw upd.error;
    }

    // Direcciones de entrega: reemplazo total (borrar + insertar).
    await supabaseClient
      .from("customer_delivery_addresses")
      .delete()
      .eq("customer_id", _expoNewState.id);
    var addrRows = addrs.map(function (a, i) {
      return {
        customer_id: _expoNewState.id,
        slot: i + 1,
        label: a.titulo || a.direccion, // nombre de la sucursal (dirección - zona)
        direccion_entrega: a.direccion,
        localidad: a.localidad || null,
        provincia: a.provincia || null,
        nombre_expreso: a.expreso || null,
      };
    });
    // Puede no haber ninguna dirección todavía (cliente en pausa incompleto).
    if (addrRows.length) {
      var addrIns = await supabaseClient
        .from("customer_delivery_addresses")
        .insert(addrRows);
      if (addrIns.error) throw addrIns.error;
    }

    // Staging para el ERP (una fila por cliente).
    await supabaseClient
      .from("expo_clientes_pendientes")
      .delete()
      .eq("customer_id", _expoNewState.id);
    var stIns = await supabaseClient.from("expo_clientes_pendientes").insert({
      customer_id: _expoNewState.id,
      cod_cliente: cust.cod_cliente,
      business_name: razon,
      cuit: cuit,
      direccion: dirFiscal || null,
      numero: numFiscal || null,
      cp: cpFiscal || null,
      localidad: locFiscal || null,
      provincia: provFiscal || null,
      condicion_iva: condIva || null,
      telefono: tel || null,
      whatsapp: whatsapp || null,
      mail: mail || null,
      vend: vend || null,
      dto_vol: dto,
      pin: pin,
      direcciones_entrega: addrs,
      estado: "pendiente",
      actualizado_at: new Date().toISOString(),
    });
    if (stIns.error) throw stIns.error;
    // Nota: el vend queda en customers.vend + staging (suficiente para el ERP).
    // La asociación a user_customer_links la resuelve el panel admin, no el alta expo.

    _expoClientComplete = completo;
    _expoRefreshResumeBtn();

    var custObj = {
      id: _expoNewState.id,
      cod_cliente: cust.cod_cliente,
      business_name: razon,
      cuit: cuit,
      dto_vol: dto,
      vend: vend,
    };

    // "Datos completados" pero faltan: avisar QUÉ falta y NO cerrar. El cliente
    // queda guardado parcial; el envío del pedido sigue bloqueado hasta completar.
    if (mode === "complete" && !completo) {
      var faltan = _expoFaltantes(formData);
      _expoNewStatus("Faltan datos para confirmar: " + faltan.join(", ") + ".", "err");
      if (pauseBtn) pauseBtn.disabled = false;
      if (goBtn) goBtn.disabled = false;
      return;
    }

    _expoCloseNewModal();
    await expoApplyCustomer(custObj, { forceExpoNew: true });
    if (typeof showSection === "function") {
      if (mode === "complete") {
        // Datos completos → al carrito si ya hay ítems, si no al catálogo.
        showSection(cart && cart.length > 0 ? "carrito" : "productos");
      } else {
        // Pausar y cargar pedido → al catálogo a armar el pedido.
        showSection("productos");
      }
    }
  } catch (e) {
    _expoNewStatus("Error: " + (e && e.message ? e.message : e), "err");
  } finally {
    if (pauseBtn) pauseBtn.disabled = false;
    if (goBtn) goBtn.disabled = false;
  }
}

function _expoWireNewModal() {
  if (_expoNewWired) return;
  var m = document.getElementById("expoNewModal");
  if (!m) return;
  _expoNewWired = true;
  // Sacar del #perfil (display:none desde Productos) para que el modal renderice.
  if (m.parentElement !== document.body) document.body.appendChild(m);
  // Validación EN VIVO: el botón "Datos completados" se habilita solo si está todo.
  m.addEventListener("input", _expoNewSyncComplete);
  m.addEventListener("change", _expoNewSyncComplete);
  var byId = function (x) { return document.getElementById(x); };
  if (byId("expoNewBackdrop")) byId("expoNewBackdrop").addEventListener("click", _expoCloseNewModal);
  // "Datos completados": exige TODO (salvo expreso). Si falta, avisa qué; si
  // está completo, guarda, cierra y lleva al carrito para pagar/enviar.
  if (byId("expoNewClose")) byId("expoNewClose").addEventListener("click", function () { _expoGuardarNuevo("complete"); });
  // Sucursales nuevas van ARRIBA (prepend = true).
  if (byId("expoAddrAdd")) byId("expoAddrAdd").addEventListener("click", function () { _expoAddrAddRow({}, true); });
  if (byId("expoAddrUseFiscal"))
    byId("expoAddrUseFiscal").addEventListener("click", function () {
      var calle = (byId("expoNewDirFiscal").value || "").trim();
      var nro = (byId("expoNewNumFiscal").value || "").trim();
      var loc = (byId("expoNewLocFiscal").value || "").trim();
      var dir = (calle + " " + nro).trim();
      _expoAddrAddRow({
        titulo: dir && loc ? dir + " - " + loc : dir,
        direccion: dir,
        localidad: loc,
        provincia: (byId("expoNewProvFiscal").value || "").trim(),
      }, true);
    });
  if (byId("expoNewPause")) byId("expoNewPause").addEventListener("click", function () { _expoGuardarNuevo("order"); });
  if (byId("expoNewGoOrder")) byId("expoNewGoOrder").addEventListener("click", function () { _expoGuardarNuevo("order"); });
  if (byId("expoNewPinCopy"))
    byId("expoNewPinCopy").addEventListener("click", function () {
      var v = byId("expoNewPin").value;
      if (!v) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(v).then(function () {
          _expoNewStatus("Clave copiada.", "ok");
        });
      } else {
        byId("expoNewPin").select();
      }
    });
}

// ---- EXPO: Continuar carga pausada ----
var _expoResumeWired = false;

function _expoWireResumeModal() {
  if (_expoResumeWired) return;
  var m = document.getElementById("expoResumeModal");
  if (!m) return;
  _expoResumeWired = true;
  if (m.parentElement !== document.body) document.body.appendChild(m);
  var closeBtn = document.getElementById("expoResumeClose");
  var backdrop = document.getElementById("expoResumeBackdrop");
  if (closeBtn) closeBtn.addEventListener("click", expoCloseResumeModal);
  if (backdrop) backdrop.addEventListener("click", expoCloseResumeModal);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && m.classList.contains("open")) expoCloseResumeModal();
  });
}

function expoCloseResumeModal() {
  var m = document.getElementById("expoResumeModal");
  if (!m) return;
  m.classList.remove("open");
  m.classList.add("hidden");
  m.setAttribute("aria-hidden", "true");
}

async function expoOpenResumeModal() {
  var m = document.getElementById("expoResumeModal");
  if (!m) return;
  _expoWireResumeModal();
  m.classList.add("open");
  m.classList.remove("hidden");
  m.setAttribute("aria-hidden", "false");
  var res = document.getElementById("expoResumeList");
  if (res) res.innerHTML = '<div class="expo-pick-hint">Cargando…</div>';
  var r = await supabaseClient
    .from("expo_clientes_pendientes")
    .select("customer_id,cod_cliente,business_name,cuit,localidad,provincia,telefono,whatsapp,mail,vend,dto_vol,pin,condicion_iva,direccion,numero,cp,direcciones_entrega,actualizado_at")
    .eq("estado", "pendiente")
    .order("actualizado_at", { ascending: false });
  if (!res) return;
  if (r.error) {
    res.innerHTML = '<div class="expo-pick-hint expo-pick-err">Error: ' + _expoEsc(r.error.message) + "</div>";
    return;
  }
  // Solo el/los que están EN CURSO: incompletos ("Falta datos"), más el cliente
  // activo ahora (para poder editarlo aunque ya esté completo). Los clientes
  // viejos ya completos NO se listan acá — ensucian la carga en curso.
  var _activeCod =
    customerProfile && customerProfile.cod_cliente
      ? String(customerProfile.cod_cliente)
      : "";
  var rows = (r.data || []).filter(function (c) {
    var completo = _expoDatosCompletos(c);
    var esActivo = _activeCod && String(c.cod_cliente || "") === _activeCod;
    return !completo || esActivo;
  });
  if (!rows.length) {
    res.innerHTML = '<div class="expo-pick-hint">No hay cargas en curso.</div>';
    return;
  }
  _expoResumeRows = rows;
  var html = "";
  rows.forEach(function (c, i) {
    var nDir = Array.isArray(c.direcciones_entrega) ? c.direcciones_entrega.length : 0;
    var ok = _expoDatosCompletos(c);
    var badge = ok
      ? '<span class="expo-resume-badge ok">✓ Completo</span>'
      : '<span class="expo-resume-badge falta">Falta datos</span>';
    html +=
      '<button type="button" class="expo-pick-row" data-idx="' + i + '">' +
      '<span class="expo-pick-name">' + _expoEsc(c.business_name || "(sin razón social)") + " " + badge + "</span>" +
      '<span class="expo-pick-sub">Cód ' + _expoEsc(c.cod_cliente || "—") +
      (c.cuit ? " · CUIT " + _expoEsc(c.cuit) : "") +
      " · " + nDir + " dir." + "</span>" +
      "</button>";
  });
  res.innerHTML = html;
  res.querySelectorAll(".expo-pick-row").forEach(function (row) {
    row.addEventListener("click", function () {
      var c = _expoResumeRows[parseInt(row.dataset.idx, 10)];
      if (c) expoEditarPendiente(c);
    });
  });
}

var _expoResumeRows = [];

// Abre el modal de "Nuevo cliente" en modo EDICIÓN, precargado desde staging.
function expoEditarPendiente(row) {
  var m = document.getElementById("expoNewModal");
  if (!m) return;
  expoCloseResumeModal();
  _expoNewState = { id: row.customer_id, authId: null };
  _expoFillVendedores();
  _expoFillProvincias();
  function setVal(id, v) {
    var el = document.getElementById(id);
    if (el) el.value = v != null ? v : "";
  }
  setVal("expoNewRazon", row.business_name);
  setVal("expoNewCuit", row.cuit);
  setVal("expoNewWhatsapp", row.whatsapp);
  setVal("expoNewMail", row.mail);
  setVal("expoNewCod", row.cod_cliente);
  setVal("expoNewDirFiscal", row.direccion);
  setVal("expoNewNumFiscal", row.numero);
  setVal("expoNewCpFiscal", row.cp);
  setVal("expoNewLocFiscal", row.localidad);
  setVal("expoNewProvFiscal", row.provincia);
  var condIva = document.getElementById("expoNewCondIva");
  if (condIva) condIva.value = row.condicion_iva || "Responsable Inscripto";
  var vendSel = document.getElementById("expoNewVend");
  if (vendSel && row.vend != null && row.vend !== "") vendSel.value = String(row.vend);
  document.getElementById("expoNewPin").value = row.pin || _expoNewGenPin();
  var list = document.getElementById("expoAddrList");
  list.innerHTML = "";
  var dirs = Array.isArray(row.direcciones_entrega) ? row.direcciones_entrega : [];
  if (dirs.length) dirs.forEach(function (d) { _expoAddrAddRow(d); });
  else _expoAddrAddRow();
  _expoNewStatus("Editando carga pausada. Guardá para actualizar.", "");
  _expoWireNewModal();
  _expoNewSyncComplete();
  m.classList.add("open");
  m.classList.remove("hidden");
  m.setAttribute("aria-hidden", "false");
}

function _expoWirePickModal() {
  if (_expoPickWired) return;
  var m = document.getElementById("expoPickModal");
  if (!m) return;
  _expoPickWired = true;
  // El markup quedó dentro de #perfil (una .section que se oculta con display:none),
  // así que el modal no renderiza desde Productos. Lo movemos al body.
  if (m.parentElement !== document.body) document.body.appendChild(m);
  var closeBtn = document.getElementById("expoPickClose");
  var backdrop = document.getElementById("expoPickBackdrop");
  var inp = document.getElementById("expoPickSearch");
  if (closeBtn) closeBtn.addEventListener("click", expoClosePickModal);
  if (backdrop) backdrop.addEventListener("click", expoClosePickModal);
  if (inp)
    inp.addEventListener("input", function () {
      clearTimeout(_expoSearchTimer);
      _expoSearchTimer = setTimeout(_expoRunSearch, 250);
    });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !m.classList.contains("hidden"))
      expoClosePickModal();
  });
}


// NOTA: el endpoint /storage/v1/render/image/public/ requiere el feature
// de image transformations, que NO está habilitado en este proyecto Supabase.
// Las imágenes están almacenadas a 400x400 WebP, así que se sirven directo
// vía /object/public/ sin transform. IMG_PARAMS queda vacío.
const BASE_IMG = `${SUPABASE_URL}/storage/v1/object/public/products-images/`;
const IMG_PARAMS = ``;

/***********************
 * IMAGENES DE PRODUCTO — MODELO DE TIERRA NATIVA
 *
 * DIFERENCIA CRITICA CON PAGINALK. En LK hay UNA imagen por producto,
 * guardada como `{cod}.webp` en la raiz del bucket, y el codigo arma la
 * URL como BASE_IMG + cod + ".webp".
 *
 * En Tierra Nativa hay VARIAS imagenes por producto, en una carpeta por
 * codigo, y la lista vive en la columna `products.images` (jsonb):
 *
 *   ["084/1.webp", "084/2.webp", "084/3.webp", ...]
 *
 * El archivo `084.webp` NO existe. Usar el esquema de LK tal cual haria
 * que los 336 productos mostraran no-image.jpg.
 *
 * Este bloque se recupero del script.js propio de Elias (commit 3dad03e),
 * que ya resolvia esto bien, y se reinserta sobre el codigo portado.
 ***********************/
const IMG_VERSION = "9999-12-31-2"; // cambiar cuando se actualicen imagenes

const productImagesCache = new Map();

function normalizeProductImagePath(path) {
  const raw = String(path || "").trim();
  if (!raw) return "";

  // Si ya viene completa, se deja como esta.
  if (/^https?:\/\//i.test(raw)) return raw;

  // Si viene con slash inicial, se saca.
  const clean = raw.replace(/^\/+/, "");

  return `${BASE_IMG}${clean}?v=${encodeURIComponent(IMG_VERSION)}`;
}

/**
 * Devuelve las URLs de imagen de un producto, en orden.
 * Prioriza la columna `images`; si no hay, prueba `{cod}.{ext}` como
 * fallback liviano (no lista carpetas del bucket).
 */
function getProductImages(productOrCod) {
  const isObj = productOrCod && typeof productOrCod === "object";
  const cod = String(isObj ? productOrCod.cod : productOrCod || "").trim();

  if (!cod) return ["img/no-image.jpg"];

  if (productImagesCache.has(cod)) {
    return productImagesCache.get(cod);
  }

  let urls = [];

  // 1) Prioridad: columna images de products.
  //
  // Puede llegar de dos formas, igual que subcategory:
  //   - array JS real     -> SELECT directo, o RPC con los tipos corregidos
  //   - string '["a","b"]' -> RPC `get_products_public_sorted` SIN corregir,
  //                           que declara images como text y Postgres castea
  // Se toleran las dos para que el catalogo ande antes y despues del DDL
  // de la Phase 3.
  if (isObj && productOrCod.images != null) {
    let list = productOrCod.images;

    if (typeof list === "string") {
      const s = list.trim();
      try {
        list = s ? JSON.parse(s) : [];
      } catch (e) {
        // Tolera tambien el formato de array de Postgres "{a,b}".
        list =
          s.startsWith("{") && s.endsWith("}")
            ? s
                .slice(1, -1)
                .split(",")
                .map((x) => x.replace(/^"|"$/g, "").trim())
                .filter(Boolean)
            : [];
      }
    }

    if (Array.isArray(list) && list.length) {
      urls = list.map(normalizeProductImagePath).filter(Boolean);
    }
  }

  // 2) Fallback: un unico intento .webp por codigo. En Tierra Nativa las fotos
  // viven en carpetas por codigo (columna images); {cod}.webp en la raiz del
  // bucket normalmente NO existe, asi que si un producto no tiene images no
  // tiene sentido disparar 4 requests (.webp/.jpg/.jpeg/.png) que fallan todas.
  // Con un solo slide, buildCarouselHtml usa la rama single -> onerror muestra
  // no-image.jpg (placeholder limpio en vez de una card en blanco).
  if (!urls.length) {
    const c = encodeURIComponent(cod);
    const v = encodeURIComponent(IMG_VERSION);
    urls = [`${BASE_IMG}${c}.webp?v=${v}`];
  }

  productImagesCache.set(cod, urls);
  return urls;
}

/** Primera imagen de un producto, o el placeholder. */
function primaryProductImage(product) {
  const imgs = getProductImages(product);
  return imgs && imgs.length ? imgs[0] : "img/no-image.jpg";
}

/**
 * Carrusel de imagenes por producto. Recuperado del script.js propio de
 * Elias (commit 3dad03e). PaginaLK no tiene este componente: alla hay una
 * sola imagen por producto, aca hay varias por codigo.
 *
 * Las imagenes que no sean la primera se cargan con data-src y recien se
 * materializan al navegar (ver ensureImageLoaded en initCarousels), asi
 * una card con 6 fotos no dispara 6 requests de entrada.
 *
 * El onerror va sacando slides rotos y, si queda uno solo, esconde las
 * flechas. Si no queda ninguno, se elimina el carrusel entero.
 */
/**
 * Devuelve la URL de la MINIATURA (~700px) a partir de la URL original,
 * insertando "_sm" antes de la extensión:
 *   .../631/1.webp?v=X  ->  .../631/1_sm.webp?v=X
 * Las miniaturas las genera make-thumbnails.js en el bucket. Si todavía no
 * existen, el onerror del <img> cae a la original (sin romper nada).
 */
function thumbUrl(url) {
  return String(url || "").replace(/(\.[a-z0-9]+)(\?|#|$)/i, "_sm$1$2");
}

/**
 * Imagen de producto. Por ahora hay UNA imagen por producto (flechas ocultas):
 * se muestra solo la primera. La grilla carga la miniatura `_sm` (liviana);
 * el zoom usa la original en alta calidad (data-full), que solo se descarga al
 * hacer click. Si la miniatura no existe aún, el onerror cae a la original y,
 * si esa también falla, al placeholder no-image.
 */
function buildCarouselHtml(pid, images, description) {
  const full = Array.isArray(images) && images.length ? images[0] : "";
  const alt = String(description || "").replace(/"/g, "&quot;");

  if (!full) {
    return `<div class="product-carousel empty" data-pid="${pid}"></div>`;
  }

  return `
    <div class="product-carousel single" data-pid="${pid}">
      <div class="carousel-slide active">
        <img
          id="img-${pid}"
          src="${thumbUrl(full)}"
          data-full="${full}"
          loading="lazy"
          decoding="async"
          alt="${alt}"
          onclick="openImgZoom(this.dataset.full || this.src, this.alt)"
          onerror="if(this.src!==this.dataset.full){this.src=this.dataset.full;}else{this.onerror=null;this.src='img/no-image.jpg';}"
        >
      </div>
    </div>
  `;
}

/** Activa los carruseles que todavia no fueron inicializados. Idempotente. */
function initCarousels(scope = document) {
  scope.querySelectorAll(".product-carousel").forEach((carousel) => {
    if (carousel.dataset.ready === "1") return;

    const prev = carousel.querySelector(".carousel-btn.prev");
    const next = carousel.querySelector(".carousel-btn.next");

    if (carousel.querySelectorAll(".carousel-slide").length <= 1) {
      if (prev) prev.style.display = "none";
      if (next) next.style.display = "none";
    }

    let index = 0;

    const getSlides = () =>
      Array.from(carousel.querySelectorAll(".carousel-slide"));

    function ensureImageLoaded(slide) {
      if (!slide) return;
      const img = slide.querySelector("img");
      if (!img) return;
      const pendingSrc = img.getAttribute("data-src");
      if (pendingSrc && !img.getAttribute("src")) {
        img.setAttribute("src", pendingSrc);
        img.removeAttribute("data-src");
      }
    }

    function show(i) {
      const slides = getSlides();
      if (!slides.length) {
        carousel.remove();
        return;
      }

      if (i < 0) i = slides.length - 1;
      if (i >= slides.length) i = 0;

      slides.forEach((slide, idx) => {
        slide.classList.toggle("active", idx === i);
      });

      index = i;

      // Precarga la actual y sus vecinas.
      ensureImageLoaded(slides[index]);
      ensureImageLoaded(slides[index + 1] || slides[0]);
      ensureImageLoaded(slides[index - 1] || slides[slides.length - 1]);

      const hasMultiple = slides.length > 1;
      if (prev) prev.style.display = hasMultiple ? "" : "none";
      if (next) next.style.display = hasMultiple ? "" : "none";
    }

    if (prev) prev.addEventListener("click", () => show(index - 1));
    if (next) next.addEventListener("click", () => show(index + 1));

    carousel.dataset.ready = "1";
    show(0);
  });
}

/***********************
 * HISTORIAL DE RENAMES DE PRODUCTO
 * Cuando un cod cambia en DB, registramos acá para que los PDFs de pedidos
 * VIEJOS (created_at < renamed_at) sigan mostrando el cod viejo (tal cual lo
 * conoció el cliente al hacer el pedido). Lookup por UUID (product_id es
 * estable a través del rename).
 ***********************/
const PRODUCT_RENAMES = [
  {
    product_id: "97223cfc-0df1-41fc-938e-a17af996e261",
    old_cod: "574E",
    new_cod: "574",
    renamed_at: "2026-05-12T16:42:00Z",
  },
];

// Devuelve el cod a mostrar en un pedido histórico (si created_at < renamed_at,
// muestra el viejo; sino, el actual).
function legacyCodForOrder(productId, currentCod, orderCreatedAt) {
  if (!productId || !orderCreatedAt) return currentCod || "";
  const r = PRODUCT_RENAMES.find((x) => x.product_id === productId);
  if (!r) return currentCod || "";
  return new Date(orderCreatedAt) < new Date(r.renamed_at)
    ? r.old_cod
    : currentCod || r.new_cod;
}

/***********************
 * ORDEN FIJO (como pediste)
 ***********************/
/***********************
 * ORDEN FIJO DEL CATALOGO — TIERRA NATIVA
 *
 * Recuperado del script.js propio de Elias (commit 3dad03e). NO inventar
 * este orden: sale del Catalogo 2026 DIGITAL, es una decision comercial.
 * Las categorias/subcategorias que no figuren se muestran igual, despues
 * de las listadas y en orden alfabetico.
 ***********************/
const CATEGORY_ORDER = ["Cuadros", "Portaretratos", "Deco"];

// Categoria que se subdivide en subcategorias. En PaginaLK era "Utensilios";
// aca es "Cuadros" (142 productos activos, 43 subcategorias en uso).
// En minusculas: la comparacion se hace con toLowerCase().
const SUBCATEGORY_PARENT = "cuadros";

const CUADROS_SUB_ORDER = [
  // Orden según Catálogo 2026 DIGITAL
  "Rebel",
  "Café Pastel",
  "Ciudades Letra Color",
  "Abstracto Naranja",
  "Pizza",
  "Bauhaus",
  "Wine",
  "Smiley",
  "Matisse",
  "Animales ByN",
  "Arpillera",
  "Grafitti",
  "Typography",
  "Artemisa",
  "Botanica",
  "Hojas Verdes",
  "Colores",
  "Ciudades",
  "Set",
  "Terra",
  "Cocina Geometrica",
  "Plumas",
  "Frases",
  "Blanco y Negro",
  "Abstracto",
  "Beach",
  "Lettering",
  "Sunshine",
  "Romantic Pink",
  "Fashion",
  "Pink",
  "Graphic Work",
  "Grey Shadows",
  "Black & White",
  "Feminine",
  "Café",
  "Nordico",
  "Geométrico",
  "Infantil",
  "Back To School",
  "Suculentas y Cactus",
  "Calm",
  "Nature",
  "Cactus",
  "Vintage",
  "Boho",
  "Pet",
];

/**
 * Normaliza `subcategory` a un array de strings limpio.
 *
 * En Tierra Nativa `products.subcategory` es `text[]`, pero lo que llega al
 * frontend depende de por donde vino el dato:
 *
 *   - RPC con los tipos corregidos, o SELECT directo -> array JS real
 *   - RPC `get_products_public_sorted` SIN corregir  -> el string "{Beach}"
 *     (Postgres castea text[] a text y deja las llaves)
 *
 * Esta funcion tolera las dos formas a proposito, asi el frontend queda
 * correcto tanto antes como despues de aplicar el DDL de la Phase 3.
 *
 * Devuelve ["Otros"] si no hay subcategoria.
 */
function subcategoriesOf(p) {
  const raw = p ? p.subcategory : null;

  if (Array.isArray(raw)) {
    const clean = raw.map((s) => String(s).trim()).filter(Boolean);
    return clean.length ? clean : ["Otros"];
  }

  const s = raw == null ? "" : String(raw).trim();
  if (!s) return ["Otros"];

  // Formato "{A,B}" del cast crudo de Postgres.
  if (s.startsWith("{") && s.endsWith("}")) {
    const inner = s
      .slice(1, -1)
      .split(",")
      .map((x) => x.replace(/^"|"$/g, "").trim())
      .filter(Boolean);
    return inner.length ? inner : ["Otros"];
  }

  return [s];
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/***********************
 * MEDIDAS DE CUADROS (filtro por tamaño)
 * La medida vive en products.medidas (text[]), pero para el filtro se deriva
 * de la description, que SIEMPRE está disponible (logueado o no, RPC o select
 * directo). Un "set" trae varias (ej. "20*30,30*40,40*50"). Si la columna
 * medidas viene en el producto, se prioriza; si no, se parsea el texto.
 ***********************/
function isCuadro(p) {
  return (
    String(p && p.category ? p.category : "")
      .trim()
      .toLowerCase() === SUBCATEGORY_PARENT
  );
}

function medidasFromDescription(desc) {
  const out = [];
  const re = /(\d{1,3})\s*[*×]\s*(\d{1,3})/g;
  const s = String(desc || "");
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[1] + "*" + m[2]);
  return out;
}

function getProductMedidas(p) {
  if (!p) return [];

  // 1) Columna medidas si vino (array real o string tipo "{20*30,30*40}").
  let raw = p.medidas;
  if (Array.isArray(raw)) {
    const arr = raw.map((x) => String(x).trim()).filter(Boolean);
    if (arr.length) return arr;
  } else if (typeof raw === "string" && raw.trim()) {
    const s = raw.trim();
    if (s.startsWith("{") && s.endsWith("}")) {
      const arr = s
        .slice(1, -1)
        .split(",")
        .map((x) => x.replace(/^"|"$/g, "").trim())
        .filter(Boolean);
      if (arr.length) return arr;
    }
  }

  // 2) Fallback: derivar de la description (solo tiene sentido en Cuadros).
  return isCuadro(p) ? medidasFromDescription(p.description) : [];
}

function compareMedida(a, b) {
  const pa = String(a).split("*").map(Number);
  const pb = String(b).split("*").map(Number);
  return (pa[0] || 0) - (pb[0] || 0) || (pa[1] || 0) - (pb[1] || 0);
}

// Medidas distintas presentes en los Cuadros del catálogo, ordenadas.
function getAllMedidas() {
  const set = new Set();
  (products || []).forEach((p) => {
    if (isCuadro(p)) getProductMedidas(p).forEach((m) => set.add(m));
  });
  return Array.from(set).sort(compareMedida);
}

// Medidas destacadas (van primero, en este orden y con 🔥). El resto va
// después de una fila vacía, ordenado normal.
const FEATURED_MEDIDAS = ["40*50", "30*40", "30*30", "20*30", "10*30"];

// Separa las medidas en { featured, rest } respetando el orden pedido para las
// destacadas y el orden por tamaño para las demás.
function splitMedidas(all) {
  const present = new Set(all);
  const featured = FEATURED_MEDIDAS.filter((m) => present.has(m));
  const feSet = new Set(featured);
  const rest = all.filter((m) => !feSet.has(m)); // `all` ya viene ordenado
  return { featured, rest };
}

async function getWebOrderDiscount() {
  try {
    const { data, error } = await supabaseClient
      .from("app_settings")
      .select("value")
      .eq("key", "web_order_discount")
      .single();

    if (error) throw error;
    return Number(data?.value) || 0;
  } catch (e) {
    console.warn("No se pudo leer web_order_discount, usando default 0.02", e);
    return 0.02;
  }
}

/***********************
 * STATE
 ***********************/
let products = []; // productos cargados
let currentSession = null; // sesión supabase
let isAdmin = false; // admin flag
let customerProfile = null; // {id, business_name, dto_vol, ...}
let customerList = null; // 1 (Tierra Nativa) | 2 (Pablo/lista2)
let _vendorOwnProfile = null; // snapshot del perfil del vendedor logueado (para volver desde "Pedir para")
function isListPriceOnlyClient() {
  // EXPO: con un cliente real seleccionado, cotiza para ESE cliente (aplica sus
  // descuentos como a cualquier logueado), no precio de lista de admin.
  if (_expoActiveCustomer) return false;
  return isAdmin || String(customerProfile?.cod_cliente) === "5000";
}

// Clientes con "Formato" propio (gestión de stock en consignación): pueden elegir
// entre el formato regular de la página y su formato especial. Se gatea por
// cod_cliente o CUIT (lo que matchee). Para sumar un cliente, agregar acá su
// entrada + sus tablas <prefix>_* + su página <prefix>/index.html con la config.
// VACIADO EN EL PORT A TIERRA NATIVA (Phase 4, 2026-07-21).
// En PaginaLK esta lista tenia a OSA (osa/index.html) y Torres y Liva
// (tyl/index.html), dos modulos que Tierra Nativa NO usa y que estan
// excluidos del alcance. Con la lista vacia, getFormatoCliente() devuelve
// siempre null, isFormatoCliente() siempre false, y todo el flujo de
// "Formato" queda inerte: el modal no se abre y no se linkea a ninguna
// pagina de modulo.
//
// El codigo muerto que quedo colgando de esto (OSA_FORMAT_PREF_KEY, el
// modal osaFormatModal de mayorista.html y su CSS) se elimina en la
// Phase 5, donde vive PORT-08.
const FORMATO_CLIENTES = [];
// Devuelve la config de formato del cliente logueado (o null si no tiene).
function getFormatoCliente() {
  const cod = String(customerProfile?.cod_cliente || "").trim();
  const cuit = String(customerProfile?.cuit || "").replace(/\D/g, "");
  return FORMATO_CLIENTES.find((f) => f.cod === cod || f.cuit === cuit) || null;
}
function isFormatoCliente() { return !!getFormatoCliente(); }

// Retorna el precio correcto según la lista del cliente logueado
function getPriceForCustomer(product) {
  if (!product) return 0;
  // Lista 2 (Pablo) — o un cliente NUEVO de expo, cuya escala corre sobre
  // LISTA 2 — usan list2_price si existe. Si el producto no tiene list2_price
  // (137 de 312), cae a list_price.
  if ((customerList === 2 || _expoClientMode) && product.list2_price) {
    return product.list2_price;
  }
  // Default: list_price (Tierra Nativa o fallback)
  return product.list_price || 0;
}

const cart = []; // [{ productId: uuidString, qtyCajas }]

// Entrega desde DB (slots 1..25)
let deliveryChoice = { slot: "", label: "" };

let sortMode = "category"; // category | bestsellers | price_desc | price_asc

let lastConfirmedOrder = null;

/***********************
 * ANOMALY DETECTION
 * Detecta cantidades inusuales comparando contra el promedio histórico del cliente.
 ***********************/
const ANOMALY_THRESHOLD = 6; // marca si pedido > promedio * 6
let _anomalyCache = { customerId: null, map: null }; // cache por cliente

async function loadAnomalyData(codCliente) {
  if (_anomalyCache.customerId === codCliente && _anomalyCache.map) {
    return _anomalyCache.map;
  }
  try {
    const { data, error } = await supabaseClient.rpc("get_customer_history", {
      p_cod_cliente: String(codCliente).trim(),
    });

    if (error || !data || !data.length) {
      _anomalyCache = { customerId: codCliente, map: new Map() };
      return _anomalyCache.map;
    }

    // Contar meses distintos con actividad para este cliente
    const allMonths = new Set(
      data.map(function (r) {
        return r.ym;
      }),
    );
    const totalMonths = Math.max(allMonths.size, 1);

    // Sumar cajas totales por artículo
    const totals = {};
    const itemMonths = {}; // meses en los que se pidió cada artículo
    for (const r of data) {
      const code = String(r.item_code || "").trim();
      if (!code) continue;
      totals[code] = (totals[code] || 0) + Number(r.boxes || 0);
      if (!itemMonths[code]) itemMonths[code] = new Set();
      itemMonths[code].add(r.ym);
    }

    // Promedio = total cajas / meses en que pidió ese artículo
    const map = new Map();
    for (const code in totals) {
      const months = itemMonths[code].size || 1;
      map.set(code, {
        avg: totals[code] / months,
        totalBoxes: totals[code],
        months: months,
      });
    }

    _anomalyCache = { customerId: codCliente, map: map };
    return map;
  } catch (e) {
    console.warn("loadAnomalyData error:", e);
    return new Map();
  }
}

function checkItemAnomaly(anomalyMap, codArt, cajasOrdered) {
  if (!anomalyMap || !anomalyMap.size) return null;
  const code = String(codArt || "").trim();
  const info = anomalyMap.get(code);
  if (!info || info.avg <= 0) return null;
  const ratio = cajasOrdered / info.avg;
  if (ratio >= ANOMALY_THRESHOLD) {
    return { avg: info.avg, ratio: ratio, months: info.months };
  }
  return null;
}

// Filtros UI (DESKTOP / estado aplicado)
let filterAll = true; // "Todos" ON por default
let filterCats = new Set(); // acumulativo
let filterMedidas = new Set(); // ✅ medidas de Cuadros seleccionadas
let medidasExpanded = false; // ✅ "Ver más" de medidas (oculta las no destacadas)
let searchTerm = ""; // buscador
let filterNewOnly = false; // ✅ NUEVOS (desktop + mobile)
let filterMyAssortment = false; // ✅ MI SURTIDO (18 meses)
let myAssortmentIds = null; // Set<string> de product_id

// ===== Mobile Filters (pendientes) =====
let pendingFilterAll = true;
let pendingFilterCats = new Set();
let pendingFilterMedidas = new Set(); // ✅ medidas de Cuadros (overlay mobile)
let pendingFilterNewOnly = false; // ✅ NUEVOS (overlay mobile)

/***********************
 * DOM HELPERS
 ***********************/
function $(id) {
  return document.getElementById(id);
}

function formatMoney(n) {
  return Math.round(Number(n || 0)).toLocaleString("es-AR");
}

function headerTwoLine(text) {
  const parts = String(text || "")
    .trim()
    .split(/\s+/);
  if (parts.length >= 2) {
    return `<span class="split-2line">${parts[0]}<br>${parts
      .slice(1)
      .join(" ")}</span>`;
  }
  return String(text || "");
}

function splitTwoWords(text) {
  const parts = String(text || "")
    .trim()
    .split(/\s+/);
  if (parts.length === 2) {
    return `<span class="split-2line">${parts[0]}<br>${parts[1]}</span>`;
  }
  return String(text || "");
}

function setOrderStatus(message, type = "") {
  const el = $("orderStatus");
  if (!el) return;

  el.classList.remove("ok", "err");
  if (type) el.classList.add(type);
  el.textContent = message || "";
}

/***********************
 * MOBILE MENU
 ***********************/
function toggleMobileMenu(forceOpen) {
  const menu = $("mobileMenu");
  const btn = $("hamburgerBtn");
  if (!menu || !btn) return;

  const willOpen =
    typeof forceOpen === "boolean"
      ? forceOpen
      : !menu.classList.contains("open");

  menu.classList.toggle("open", willOpen);
  menu.setAttribute("aria-hidden", willOpen ? "false" : "true");
  btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
}

function closeMobileMenu() {
  toggleMobileMenu(false);
}

function closeMobileUserMenu() {
  const m = $("mobileUserMenu");
  if (!m) return;

  m.classList.remove("open");
  m.setAttribute("aria-hidden", "true");
}

function toggleMobileUserMenu() {
  const m = $("mobileUserMenu");
  if (!m) return;

  const willOpen = !m.classList.contains("open");
  m.classList.toggle("open", willOpen);
  m.setAttribute("aria-hidden", willOpen ? "false" : "true");
}

window.closeMobileUserMenu = closeMobileUserMenu;

/***********************
 * SECTIONS
 ***********************/
function showSection(id) {
  if (id === "carrito" && !currentSession) {
    openLogin();
    return;
  }

  // BROWSER BACK: cuando entrás a perfil, push state para que el botón
  // atrás del navegador te lleve a productos (inicio de mayorista).
  // Solo se ejecuta si el cambio NO viene del popstate handler (que setea
  // window.__lkBackNav = true para evitar loop infinito).
  if (!window.__lkBackNav) {
    if (id === "perfil") {
      try {
        history.pushState({ lkSection: "perfil" }, "", "#perfil");
      } catch (e) {}
    } else if (id === "productos") {
      // Limpiar el hash si volvimos a productos via UI normal
      if (location.hash === "#perfil") {
        try {
          history.replaceState({ lkSection: "productos" }, "", " ");
        } catch (e) {}
      }
    }
  }

  document
    .querySelectorAll(".section")
    .forEach((s) => s.classList.remove("active"));

  const el = $(id);
  if (el) el.classList.add("active");

  // Ocultar buscador/controles de productos mientras el usuario mira el carrito
  document.body.classList.toggle("section-carrito", id === "carrito");
  // Idem en perfil: el buscador del catálogo no tiene sentido ahí
  document.body.classList.toggle("section-perfil", id === "perfil");

  // Refrescar lista del módulo "no llevás" cada vez que se abre el carrito
  if (id === "carrito") {
    // Si hay una edición en curso, re-asegurar el cartel amarillo: al salir y
    // volver al carrito el banner se perdía aunque el modo edición siguiera activo.
    if (editingOrderId) {
      setEditBanner(editingOrderId);
    }
    _missingModuleAllPids = null;
    _missingModuleOffset = 0;
    if (typeof renderMissingAssortmentModule === "function") {
      renderMissingAssortmentModule();
    }
    // Sync del alto del missing module al de totals — la sección recién
    // ahora es visible (offsetHeight > 0). Doble llamada (frame + 200ms)
    // para cubrir layouts que tardan en estabilizarse.
    if (typeof window.__lkSyncCartColHeight === "function") {
      requestAnimationFrame(window.__lkSyncCartColHeight);
      setTimeout(window.__lkSyncCartColHeight, 200);
    }
    // Scroll al tope al entrar al carrito (no quedar en la misma posición
    // donde estaba el usuario en productos).
    try {
      window.scrollTo({ top: 0, behavior: "auto" });
    } catch (e) {
      window.scrollTo(0, 0);
    }
  }

  // Mismo scroll-to-top al entrar al perfil
  if (id === "perfil") {
    try {
      window.scrollTo({ top: 0, behavior: "auto" });
    } catch (e) {
      window.scrollTo(0, 0);
    }
  }

  closeCategoriesMenu();
  closeUserMenu();
  closeMobileMenu();
  closeFiltersOverlay();
  closeMobileUserMenu();

  // Loke mode: swap logo + hide Loke button
  var logoImg = document.querySelector(".logo-img");
  var lokeLink = document.getElementById("lokeLink");
  var header = document.querySelector(".header");

  if (id === "loke") {
    if (logoImg) {
      logoImg.dataset.originalSrc = logoImg.src;
      logoImg.src = "img/loke_logo.png";
    }
    if (lokeLink) lokeLink.style.display = "none";
    var mLokeBtn = document.getElementById("mobileLokeBtn");
    if (mLokeBtn) mLokeBtn.style.display = "none";
    if (header) header.classList.add("loke-mode");
  } else {
    if (logoImg && logoImg.dataset.originalSrc) {
      logoImg.src = logoImg.dataset.originalSrc;
    }
    if (lokeLink && hasLokeAccess) lokeLink.style.display = "inline-flex";
    var mLokeBtn2 = document.getElementById("mobileLokeBtn");
    if (mLokeBtn2 && hasLokeAccess) mLokeBtn2.style.display = "inline-flex";
    if (header) header.classList.remove("loke-mode");
  }
}

function goToProductsTop() {
  showSection("productos");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/***********************
 * CUIT -> EMAIL INTERNO
 ***********************/
function normalizeCUIT(cuit) {
  return String(cuit || "")
    .trim()
    .replace(/\s+/g, "");
}

function cuitDigits(cuit) {
  return normalizeCUIT(cuit).replace(/\D/g, "");
}

function cuitToInternalEmail(cuit) {
  const digits = cuitDigits(cuit);
  if (!digits) return "";
  return `${digits}@cuit.tierranativa`;
}

/***********************
 * LOGIN MODAL
 ***********************/
function openLogin() {
  setOrderStatus("");

  const err = $("loginError");
  if (err) {
    err.style.display = "none";
    err.innerText = "";
  }

  $("loginModal")?.classList.add("open");
  $("loginModal")?.setAttribute("aria-hidden", "false");

  // Enter en cualquiera de los dos inputs dispara login() (los inputs no
  // están dentro de un <form>, así que el submit nativo no se dispara solo).
  // Bindeo idempotente: si ya está bindeado, no se duplica.
  const _bindEnter = (id) => {
    const el = $(id);
    if (!el || el.dataset.enterBound === "1") return;
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        login();
      }
    });
    el.dataset.enterBound = "1";
  };
  _bindEnter("cuitInput");
  _bindEnter("passInput");
}

function closeLogin() {
  $("loginModal")?.classList.remove("open");
  $("loginModal")?.setAttribute("aria-hidden", "true");
}

/***********************
 * SELECTOR DE FORMATO (cliente OSA · 2533)
 ***********************/
const OSA_FORMAT_PREF_KEY = "lk_format_pref"; // 'regular' | 'formato'

function openOsaFormatChooser() {
  const m = $("osaFormatModal");
  const f = getFormatoCliente();
  if (!m || !f) return;
  // Partes dinámicas según el cliente (OSA, Torres y Liva, …).
  const lbl = $("osaFormatLinkLabel");
  if (lbl) lbl.textContent = "Pedido Automático";
  const link = $("osaFormatLink");
  if (link) link.setAttribute("href", f.page);
  m.classList.add("open");
  m.setAttribute("aria-hidden", "false");
}

function closeOsaFormatChooser() {
  const m = $("osaFormatModal");
  if (!m) return;
  m.classList.remove("open");
  m.setAttribute("aria-hidden", "true");
}

// Guarda la última preferencia de formato (sin redirigir). El formato del cliente
// navega solo (el <a> tiene el href que setea openOsaFormatChooser); regular cierra.
function recordarFormato(which) {
  try {
    localStorage.setItem(OSA_FORMAT_PREF_KEY, which === "regular" ? "regular" : "formato");
  } catch (e) {}
}

function elegirFormato(which) {
  recordarFormato(which);
  if (which !== "regular") {
    const f = getFormatoCliente();
    if (f) { window.location.href = f.page; return; }
  }
  closeOsaFormatChooser();
}

// Muestra el selector cuando entra un cliente con formato propio: en un login
// nuevo (force) y también al abrir ya logueado. Una vez por sesión de navegador;
// siempre accesible además desde el menú de usuario → "Formato <cliente>".
function maybeShowOsaFormatChooser(opts) {
  opts = opts || {};
  if (!isFormatoCliente()) return;
  const modal = $("osaFormatModal");
  if (modal && modal.classList.contains("open")) return; // ya está abierto
  try {
    if (!opts.force && sessionStorage.getItem("lk_chooser_seen") === "1") return;
    sessionStorage.setItem("lk_chooser_seen", "1");
  } catch (e) {}
  openOsaFormatChooser();
}

function looksLikeCUIT(val) {
  const cleaned = val.replace(/[-\s]/g, "");
  if (/[^0-9]/.test(cleaned)) return false;
  return cleaned.length >= 10 && cleaned.length <= 11;
}

/***********************
 * LOGIN MAESTRO (admin)
 * El admin entra como cualquier cliente (menos PPP) poniendo su CLAVE MAESTRA en
 * el campo CUIT y el CÓDIGO DE CLIENTE en la contraseña, con verificación por un
 * código de 6 dígitos que llega a su mail. La clave NO vive en este archivo: se
 * valida server-side en la Edge Function master-login (compara su hash sha256
 * contra el guardado en Vault). Si la clave es incorrecta, se trata como un
 * usuario inexistente (no se revela que el modo maestro existe).
 ***********************/
async function masterLoginCall(action, master, cod, code) {
  try {
    const res = await fetch(SUPABASE_URL + "/functions/v1/master-login", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ action, master, cod, code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error || "http_" + res.status };
    return { data };
  } catch (e) {
    return { error: "network" };
  }
}

// Devuelve "pending" si arrancó el flujo maestro (código enviado / overlay abierto
// / error mostrado), o false si NO es un login maestro (clave inválida o el PIN no
// es un código de cliente) → el llamador sigue con "Usuario no encontrado".
async function intentarLoginMaestro(master, cod) {
  // El "PIN" puede ser un CÓDIGO DE CLIENTE o un CUIT (con o sin guiones/puntos).
  const codClean = String(cod).replace(/[\s.\-]/g, "");
  if (!/^\d{1,11}$/.test(codClean)) return false;
  const r = await masterLoginCall("send", master, codClean, null);
  if (r.error) {
    if (r.error === "invalid") return false; // clave maestra incorrecta
    const msg =
      r.error === "no_client" ? "Ese código de cliente o CUIT no existe."
      : r.error === "not_allowed" ? "No se puede entrar como esa cuenta."
      : r.error === "rate_limited" ? "Demasiados intentos. Esperá 10 minutos."
      : (r.error === "mail_not_configured" || r.error === "mail_failed") ? "No se pudo enviar el código. Avisá a IT."
      : "No se pudo iniciar el acceso maestro.";
    const err = $("loginError");
    if (err) { err.innerText = msg; err.style.display = "block"; }
    return "pending";
  }
  mostrarMasterOtp(master, codClean);
  return "pending";
}

function mostrarMasterOtp(master, cod) {
  const ov = $("masterOtpOverlay");
  if (!ov) return;
  const codEl = $("masterOtpCod");
  const codeInput = $("masterOtpCode");
  const errEl = $("masterOtpError");
  const verifyBtn = $("masterOtpVerify");
  const resendBtn = $("masterOtpResend");
  const cancelBtn = $("masterOtpCancel");
  if (codEl) codEl.innerText = cod;
  if (codeInput) codeInput.value = "";
  if (errEl) errEl.innerText = "";
  ov.style.display = "flex";
  setTimeout(() => codeInput && codeInput.focus(), 60);

  async function verificar() {
    const code = (codeInput.value || "").replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) { errEl.innerText = "Ingresá el código de 6 dígitos."; return; }
    verifyBtn.disabled = true; errEl.innerText = "Verificando…";
    const r = await masterLoginCall("verify", master, cod, code);
    if (r.error || !r.data || !r.data.email) {
      errEl.innerText = r.error === "invalid_code" ? "Código inválido o vencido." : "No se pudo verificar.";
      verifyBtn.disabled = false; codeInput.value = ""; codeInput.focus();
      return;
    }
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: r.data.email, password: r.data.pin,
    });
    if (error) { errEl.innerText = "No se pudo iniciar sesión como ese cliente."; verifyBtn.disabled = false; return; }
    try { localStorage.setItem("is_logged", "1"); } catch (e) {}
    ov.style.display = "none";
    location.reload(); // reinicia la app ya logueado como el cliente
  }
  async function reenviar() {
    resendBtn.disabled = true; errEl.innerText = "";
    const r = await masterLoginCall("send", master, cod, null);
    errEl.innerText = r.error ? "No se pudo reenviar." : "Código reenviado.";
    setTimeout(() => { resendBtn.disabled = false; }, 3000);
  }
  function cerrar() { ov.style.display = "none"; verifyBtn.disabled = false; resendBtn.disabled = false; }
  verifyBtn.onclick = verificar;
  resendBtn.onclick = reenviar;
  cancelBtn.onclick = cerrar;
  codeInput.onkeydown = (e) => { if (e.key === "Enter") verificar(); };
}

async function login() {
  const rawInput = ($("cuitInput")?.value || "").trim();
  const password = ($("passInput")?.value || "").trim();

  if (!rawInput || !password) {
    const err = $("loginError");
    if (err) {
      err.innerText = "Completá CUIT/usuario y contraseña.";
      err.style.display = "block";
    }
    return;
  }

  let cuitValue;

  if (looksLikeCUIT(rawInput)) {
    cuitValue = rawInput;
  } else {
    // Es un username → buscar el CUIT vía RPC
    const { data: foundCuit, error: rpcError } = await supabaseClient.rpc(
      "lookup_cuit_by_username",
      { p_username: rawInput.toLowerCase() },
    );
    if (rpcError || !foundCuit) {
      // ¿Login maestro? Clave compleja en el campo CUIT + código de cliente en la
      // contraseña. Si la clave maestra es válida, dispara el código por mail.
      const maestro = await intentarLoginMaestro(rawInput, password);
      if (maestro === "pending") return;
      const err = $("loginError");
      if (err) {
        err.innerText = "Usuario no encontrado.";
        err.style.display = "block";
      }
      return;
    }
    cuitValue = foundCuit;
  }

  const email = cuitToInternalEmail(cuitValue);
  if (!email) {
    const err = $("loginError");
    if (err) {
      err.innerText = "CUIT inválido.";
      err.style.display = "block";
    }
    return;
  }

  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    const err = $("loginError");
    if (err) {
      err.innerText = "CUIT/usuario o contraseña incorrectos.";
      err.style.display = "block";
    }
    return;
  }

  currentSession = data.session || null;

  // ✅ marca que hubo login
  localStorage.setItem("is_logged", "1");

  closeLogin();

  // limpiar búsqueda
  searchTerm = "";
  const ns = $("navSearch");
  if (ns) ns.value = "";

  await refreshAuthState();
  await loadProductsFromDB();
  normalizeCartAgainstProducts();
  myAssortmentIds = await loadMyAssortmentIds();

  renderCategoriesMenu();
  renderCategoriesSidebar();
  renderProducts();
  updateCart();
  syncPaymentButtons();
}

/***********************
 * LOGOUT
 ***********************/
async function logout() {
  if (window.__isLoggingOut) return;
  window.__isLoggingOut = true;

  try {
    const signOutPromise = supabaseClient.auth.signOut().catch(() => {});
    await Promise.race([
      signOutPromise,
      new Promise((r) => setTimeout(r, 1200)),
    ]);

    Object.keys(localStorage)
      .filter((k) => k.startsWith("sb-") && k.endsWith("-auth-token"))
      .forEach((k) => localStorage.removeItem(k));

    Object.keys(sessionStorage)
      .filter((k) => k.startsWith("sb-") && k.endsWith("-auth-token"))
      .forEach((k) => sessionStorage.removeItem(k));

    currentSession = null;
    isAdmin = false;
    customerProfile = null;
    deliveryChoice = { slot: "", label: "" };
    cart.splice(0, cart.length);
    localStorage.removeItem(CART_LS_KEY);
    localStorage.removeItem("is_logged");
    localStorage.removeItem("lk_vendor_selected_cod_cliente");
    localStorage.removeItem("lk_vendor_selected_business_name");
    localStorage.removeItem("lk_vendor_selected_dto_vol");

    if ($("customerNote")) $("customerNote").innerText = "";
    if ($("helloNavText")) $("helloNavText").innerText = "";
    if ($("loginBtn")) $("loginBtn").style.display = "inline";
    if ($("userBox")) $("userBox").style.display = "none";

    closeUserMenu();
    resetShippingSelect();

    // reset filtros
    filterAll = true;
    filterCats.clear();
    searchTerm = "";
    setSearchInputValue("");

    renderCategoriesMenu();
    renderCategoriesSidebar();
    renderProducts();
    updateCart();

    showSection("productos");

    setTimeout(() => location.reload(), 50);
  } catch (e) {
    console.error("logout error:", e);
    setOrderStatus(
      "No se pudo cerrar sesión. Probá recargando la página.",
      "err",
    );
    window.__isLoggingOut = false;
  }
}

/***********************
 * AUTH/PROFILE HELPERS
 ***********************/
async function refreshAuthState(sessionOverride) {
  if (sessionOverride !== undefined) {
    currentSession = sessionOverride;
  } else {
    const { data } = await supabaseClient.auth.getSession();
    currentSession = data.session || null;
  }

  if (!currentSession) {
    isAdmin = false;
    customerProfile = null;
    deliveryChoice = { slot: "", label: "" };
    const clienteNuevoRow = $("clienteNuevoRow");
    const clienteNuevoInput = $("clienteNuevoInput");
    if (clienteNuevoRow) clienteNuevoRow.style.display = "none";
    if (clienteNuevoInput) clienteNuevoInput.value = "";

    syncAdminCheckoutUI();

    if ($("loginBtn")) $("loginBtn").style.display = "inline";
    if ($("userBox")) $("userBox").style.display = "none";
    if ($("ctaCliente")) $("ctaCliente").style.display = "inline-flex";
    if ($("helloNavBtn")) $("helloNavBtn").innerText = "";
    if ($("customerNote")) $("customerNote").innerText = "";
    if ($("menuMyOrders")) $("menuMyOrders").style.display = "none";

    resetShippingSelect();
    return;
  }

  const { data: adminRow, error: adminErr } = await supabaseClient
    .from("admins")
    .select("auth_user_id")
    .eq("auth_user_id", currentSession.user.id)
    .maybeSingle();

  isAdmin = !!adminRow && !adminErr;
  const clienteNuevoRow = $("clienteNuevoRow");
  const clienteNuevoInput = $("clienteNuevoInput");

  if (clienteNuevoRow) {
    clienteNuevoRow.style.display = isAdmin ? "block" : "none";
  }

  if (clienteNuevoInput && !isAdmin) {
    clienteNuevoInput.value = "";
  }
  syncAdminCheckoutUI();

  let custRow = null;
  let custErr = null;

  // Intento 1: buscar por auth_user_id
  const result1 = await supabaseClient
    .from("customers")
    .select(
      "id,business_name,dto_vol,cod_cliente,cuit,direccion_fiscal,localidad,vend,mail,lista,escala_activa",
    )
    .eq("auth_user_id", currentSession.user.id)
    .maybeSingle();

  custRow = result1.data;
  custErr = result1.error;

  if (custErr) {
    console.error("Error en query por auth_user_id:", custErr);
  }

  // Intento 2 (fallback): buscar por email si el primer intento no retornó nada
  if (!custRow && currentSession.user.email) {
    console.warn("No se encontró customer por auth_user_id, intentando por email:", currentSession.user.email);
    const result2 = await supabaseClient
      .from("customers")
      .select(
        "id,business_name,dto_vol,cod_cliente,cuit,direccion_fiscal,localidad,vend,mail,lista,escala_activa",
      )
      .eq("mail", currentSession.user.email)
      .maybeSingle();

    custRow = result2.data;
    if (result2.error) {
      console.error("Error en query por email:", result2.error);
    } else if (custRow) {
      console.log("Customer encontrado por email fallback:", custRow.cod_cliente, custRow.business_name);
    }
  }

  if (custRow) {
    console.log("✅ Customer cargado:", {
      id: custRow.id,
      cod_cliente: custRow.cod_cliente,
      business_name: custRow.business_name,
      mail: custRow.mail,
      cuit: custRow.cuit,
    });
  } else {
    console.warn("❌ No se encontró customer para user:", {
      user_id: currentSession.user.id,
      user_email: currentSession.user.email,
    });
  }

  customerProfile = custRow || null;
  customerList = Number(custRow?.lista) || 1; // 1 = Tierra Nativa, 2 = Pablo/Lista2 — PostgREST serializa el numeric como string ("2"), sin Number() el "=== 2" nunca matchea
  // Snapshot del perfil propio del vendedor para poder volver desde "Pedir para"
  _vendorOwnProfile = customerProfile ? Object.assign({}, customerProfile) : null;

  // Escala activa: cliente self-service con dto en vivo (1ª compra)
  if (customerProfile && customerProfile.escala_activa && !isAdmin) {
    _escalaActiva = true;
    await _expoLoadScale();
    setTimeout(function () {
      _escalaForceContadoUI();
      _expoSyncDto();
    }, 0);
  }

  if ($("loginBtn")) $("loginBtn").style.display = "none";
  if ($("userBox")) $("userBox").style.display = "inline-flex";
  if ($("ctaCliente")) $("ctaCliente").style.display = "none";

  let razonSocial = (customerProfile?.business_name || "").trim();
  if (!razonSocial && customerProfile?.cod_cliente) {
    razonSocial = `Cliente ${customerProfile.cod_cliente}`;
  }
  if ($("helloNavText"))
    $("helloNavText").innerText = razonSocial ? `Hola, ${razonSocial} !` : "Hola!";

  if ($("menuMyOrders")) $("menuMyOrders").style.display = "block";

  // Panel Admin: solo la empresa dueña del sitio, que es el cod_cliente "1"
  // de su propia base. Un vendedor con flag de admin pero otro cod no ve el
  // acceso al panel.
  //
  // En PaginaLK este gate decia "SOLO Loekemeyer (cod 1). Tierra Nativa y
  // otros vendedores admin no ven el acceso" — porque alla Tierra Nativa es
  // un CLIENTE de Loekemeyer. Corriendo sobre la base propia de Tierra
  // Nativa la condicion sigue siendo correcta (su admin tambien es cod 1,
  // verificado), pero el nombre y el comentario decian lo contrario de lo
  // que hacen. Renombrado para que se entienda.
  // El acceso real al panel lo protege el 2FA por mail (OTP) de admin.html,
  // que solo deja entrar al admin dueno (CUIT PPP). Por eso alcanza con mostrar
  // el link a cualquier usuario verificado como admin (fila en la tabla admins).
  var isOwnerAdmin = isAdmin;
  if ($("menuAdminPanel"))
    $("menuAdminPanel").style.display = isOwnerAdmin ? "block" : "none";
  if ($("menuAdminPanelMobile"))
    $("menuAdminPanelMobile").style.display = isOwnerAdmin ? "block" : "none";

  // Acceso al "Formato <cliente>": solo clientes con formato propio (OSA, TyL…).
  if ($("menuFormatoOsa")) {
    var _fmt = getFormatoCliente();
    var _mi = $("menuFormatoOsa");
    _mi.style.display = _fmt ? "block" : "none";
    if (_fmt) {
      _mi.setAttribute("href", _fmt.page);
      var _lbl = _mi.querySelector(".user-menu-label");
      if (_lbl) _lbl.textContent = "Pedido Automático";
    }
  }

  // Admin: ocultar "Análisis de tus compras" (es de cliente)
  if ($("menuAnalisis"))
    $("menuAnalisis").style.display = isAdmin ? "none" : "";
  if ($("menuAnalisisMobile"))
    $("menuAnalisisMobile").style.display = isAdmin ? "none" : "";

  const note = $("customerNote");
  if (note) {
    const dto = Number(customerProfile?.dto_vol || 0);

    if (!currentSession) {
      note.innerText = "";
    } else if (isAdmin) {
      note.innerText = "Modo Administrador";
    } else if (dto > 0) {
      note.innerText = "Ya está aplicado tu Dto x Volumen";
    } else {
      note.innerText = "";
    }
  }

  await loadDeliveryOptions();
}

function getDtoVol() {
  if (isListPriceOnlyClient()) return 0;
  return Number(customerProfile?.dto_vol || 0);
}

function unitYourPrice(listPrice) {
  const dto = getDtoVol();
  return Number(listPrice || 0) * (1 - dto);
}

// Precio contado unitario — MISMA fórmula para todas las vistas que muestran
// "Tu precio contado" (card de catálogo, carrusel NUEVOS y módulo "surtido
// faltante"): resuelve la lista correcta (getPriceForCustomer, que respeta
// customerList/expo) → dto x volumen (unitYourPrice) → web (_expoWebMul) → 30%
// de contado. Un solo lugar, para que el mismo producto no muestre un precio
// distinto según la pantalla.
function precioContadoUnitario(product) {
  return unitYourPrice(getPriceForCustomer(product)) * _expoWebMul() * (1 - 0.3);
}

/***********************
 * MÉTODO DE PAGO
 ***********************/
function getPaymentDiscount() {
  // EXPO: cliente nuevo = 1ª compra contado (-30%) OBLIGATORIO.
  if (_expoClientMode || _escalaActiva) return 0.3;
  if (isListPriceOnlyClient()) return 0;

  const sel = $("paymentSelect");
  if (!sel) return 0;

  const v = parseFloat(sel.value);
  return isNaN(v) ? 0 : v;
}

function getPaymentMethodText() {
  if (_expoClientMode || _escalaActiva) return "Contado";
  if (isListPriceOnlyClient()) return "Contado";

  const sel = $("paymentSelect");
  if (!sel) return "";

  const opt = sel.options[sel.selectedIndex];
  return opt?.textContent ? opt.textContent.trim() : "";
}

function getPaymentMethodCode() {
  if (_expoClientMode || _escalaActiva) return 8; // Contado
  if (isListPriceOnlyClient()) return 8;

  const sel = $("paymentSelect");
  const v = sel ? String(sel.value) : "";

  // Códigos Loekemeyer (ver tabla CHEF↔Loeke)
  if (v === "LATER") return 18; // Prefiero no decidir ahora
  if (v === "0.30") return 8;   // Contado -30%
  if (v === "0.25") return 8;   // Contado (compat: valor viejo)
  if (v === "0.20") return 9;   // 15 a 30 días -20%
  if (v === "0.15") return 10;  // 31 a 45 días -15%
  if (v === "0.10") return 11;  // 46 a 60 días -10%
  if (v === "0.05") return 12;  // E-Cheq 90 días -5%
  if (v === "0.00") return 13;  // E-Cheq 120 días 0%

  return 0; // desconocido
}

function setPaymentByValue(val) {
  const sel = $("paymentSelect");
  if (!sel) return;

  sel.value = String(val);
  syncPaymentButtons();
  updateCart();
  refreshSubmitEnabled();
}

function syncPaymentButtons() {
  const sel = $("paymentSelect");
  const wrap = $("paymentButtons");
  if (!sel || !wrap) return;

  const current = String(sel.value);
  wrap.querySelectorAll(".pay-btn").forEach((btn) => {
    btn.classList.toggle("active", String(btn.dataset.value) === current);
  });
}

function syncAdminCheckoutUI() {
  const paymentRow = $("paymentRow");
  const webNoteBox = $("webNoteBox");
  const webDiscountLine = $("webDiscountLine");
  const paymentDiscountLine = $("paymentDiscountLine");
  const totalNoDiscountLine = $("totalNoDiscountLine");
  const totalDiscountsLine = $("totalDiscountsLine");

  const hideDiscounts = isListPriceOnlyClient();
  if (paymentRow) paymentRow.style.display = hideDiscounts ? "none" : "";
  if (webNoteBox) webNoteBox.style.display = hideDiscounts ? "none" : "";
  if (webDiscountLine)
    webDiscountLine.style.display = hideDiscounts ? "none" : "";
  if (paymentDiscountLine)
    paymentDiscountLine.style.display = hideDiscounts ? "none" : "";
  if (totalNoDiscountLine)
    totalNoDiscountLine.style.display = hideDiscounts ? "none" : "";
  if (totalDiscountsLine)
    totalDiscountsLine.style.display = hideDiscounts ? "none" : "";
}

/***********************
 * PRODUCTS (DB/RPC)
 ***********************/
async function loadProductsFromDB() {
  // Skeleton mientras hace fetch (solo la primera vez, cuando aún no hay products)
  if (typeof renderProductSkeletons === "function" && (!products || !products.length)) {
    renderProductSkeletons(8);
  }
  const logged = !!currentSession;

  if (!logged) {
    // Público: intenta RPC
    const { data, error } = await supabaseClient.rpc(
      "get_products_public_sorted",
      { sort_mode: sortMode },
    );

    if (!error && Array.isArray(data) && data.length) {
      products = data.map((p) => ({
        id: p.id,
        cod: p.cod,
        category: p.category || "Sin categoría",
        subcategory: p.subcategory,
        ranking:
          p.ranking == null || p.ranking === "" ? null : Number(p.ranking),
        orden_catalogo:
          p.orden_catalogo == null || p.orden_catalogo === ""
            ? null
            : Number(p.orden_catalogo),
        description: p.description,
        uxb: p.uxb,
        images: p.images ?? [], // string JSON (RPC) o array (SELECT): getProductImages() parsea ambos
        // ✅ Nuevo parámetro (si el RPC todavía no lo devuelve, queda null)
        badge_status: p.badge_status
          ? String(p.badge_status).trim().toUpperCase()
          : null,
      }));
      return;
    }

    // Fallback: consulta directa SIN list_price (precio solo para autenticados vía RLS)
    if (error)
      console.warn("Public RPC failed, fallback to direct select:", error);

    const { data: rows, error: err2 } = await supabaseClient
      .from("products")
      .select(
        "id,cod,category,subcategory,ranking,orden_catalogo,description,uxb,images,badge_status",
      )
      .eq("active", true);

    if (err2) {
      console.error("Public select failed:", err2);
      products = [];
      return;
    }

    products = (rows || []).map((p) => ({
      id: p.id,
      cod: p.cod,
      category: p.category || "Sin categoría",
      subcategory: p.subcategory,
      ranking: p.ranking == null || p.ranking === "" ? null : Number(p.ranking),
      orden_catalogo:
        p.orden_catalogo == null || p.orden_catalogo === ""
          ? null
          : Number(p.orden_catalogo),
      description: p.description,
      uxb: p.uxb,
      images: p.images ?? [], // string JSON (RPC) o array (SELECT): getProductImages() parsea ambos
      // ✅ Nuevo parámetro
      badge_status: p.badge_status
        ? String(p.badge_status).trim().toUpperCase()
        : null,
    }));

    return;
  }

  // ✅ LOGUEADO: orden también según sortMode
  let q = supabaseClient
    .from("products")
    .select(
      "id,cod,category,subcategory,ranking,orden_catalogo,description,list_price,list2_price,uxb,images,badge_status,active",
    )
    .eq("active", true);

  if (sortMode === "bestsellers") {
    q = q.order("ranking", { ascending: true, nullsFirst: false });
  } else if (sortMode === "price_desc") {
    q = q.order("category", { ascending: true });
    q = q.order("list_price", { ascending: false, nullsFirst: false });
    q = q.order("orden_catalogo", { ascending: true, nullsFirst: false });
  } else if (sortMode === "price_asc") {
    q = q.order("category", { ascending: true });
    q = q.order("list_price", { ascending: true, nullsFirst: false });
    q = q.order("orden_catalogo", { ascending: true, nullsFirst: false });
  } else {
    q = q.order("category", { ascending: true });
    q = q.order("orden_catalogo", { ascending: true, nullsFirst: false });
    q = q.order("description", { ascending: true });
  }

  const { data, error } = await q;

  if (error) {
    console.error("Error loading products:", error);
    products = [];
    return;
  }

  products = (data || []).map((p) => ({
    id: p.id,
    cod: p.cod,
    category: p.category || "Sin categoría",
    // Se preserva TAL CUAL viene: puede ser array (text[] de la tabla) o
    // string ("{Beach}" del RPC sin corregir). La normalizacion se hace
    // en subcategoriesOf(), al agrupar. Colapsarlo a string aca romperia
    // los productos con mas de una subcategoria.
    subcategory: p.subcategory ?? null,
    ranking:
      p.ranking === null || p.ranking === undefined || p.ranking === ""
        ? null
        : Number(p.ranking),
    orden_catalogo:
      p.orden_catalogo === null ||
      p.orden_catalogo === undefined ||
      p.orden_catalogo === ""
        ? null
        : Number(p.orden_catalogo),
    description: p.description,
    list_price: p.list_price,
    list2_price: p.list2_price,
    uxb: p.uxb,
    images: p.images ?? [], // string JSON (RPC) o array (SELECT): getProductImages() parsea ambos
    // ✅ Nuevo parámetro
    badge_status: p.badge_status
      ? String(p.badge_status).trim().toUpperCase()
      : null,
    active: !!p.active,
  }));
}

/***********************
 * CATEGORÍAS HELPERS (orden fijo + fallback)
 ***********************/
function getOrderedCategoriesFrom(list) {
  const presentCats = new Set(
    (list || []).map((p) => String(p.category || "").trim()).filter(Boolean),
  );

  const inOrder = CATEGORY_ORDER.filter((cat) => presentCats.has(cat));

  const extras = Array.from(presentCats)
    .filter((cat) => !CATEGORY_ORDER.includes(cat))
    .sort((a, b) => a.localeCompare(b, "es"));

  // devuelve un array plano, en el orden correcto
  return [...inOrder, ...extras];
}

function slugifyCategory(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-]/g, "");
}

function normalizeText(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function getSortComparator() {
  return (a, b) => {
    const aOrd =
      a.orden_catalogo === null || a.orden_catalogo === undefined
        ? 999999
        : Number(a.orden_catalogo);
    const bOrd =
      b.orden_catalogo === null || b.orden_catalogo === undefined
        ? 999999
        : Number(b.orden_catalogo);

    const aRank =
      a.ranking === null || a.ranking === undefined
        ? 999999
        : Number(a.ranking);
    const bRank =
      b.ranking === null || b.ranking === undefined
        ? 999999
        : Number(b.ranking);

    const aPrice =
      getPriceForCustomer(a) === null || getPriceForCustomer(a) === undefined
        ? -1
        : Number(getPriceForCustomer(a));
    const bPrice =
      getPriceForCustomer(b) === null || getPriceForCustomer(b) === undefined
        ? -1
        : Number(getPriceForCustomer(b));

    if (sortMode === "bestsellers") {
      return (
        aRank - bRank ||
        aOrd - bOrd ||
        String(a.description || "").localeCompare(
          String(b.description || ""),
          "es",
        )
      );
    }

    if (sortMode === "price_desc") {
      return (
        bPrice - aPrice ||
        aOrd - bOrd ||
        String(a.description || "").localeCompare(
          String(b.description || ""),
          "es",
        )
      );
    }

    if (sortMode === "price_asc") {
      const aP = aPrice < 0 ? 999999999 : aPrice;
      const bP = bPrice < 0 ? 999999999 : bPrice;

      return (
        aP - bP ||
        aOrd - bOrd ||
        String(a.description || "").localeCompare(
          String(b.description || ""),
          "es",
        )
      );
    }

    return (
      aOrd - bOrd ||
      String(a.description || "").localeCompare(
        String(b.description || ""),
        "es",
      )
    );
  };
}

function renderCategoriesMenu() {
  const menu = $("categoriesMenu");
  if (!menu) return;

  const ordered = getOrderedCategoriesFrom(products);

  menu.innerHTML = `
    <div>
      <label class="dd-toggle-row dd-chip">
        <span>Todos los artículos</span>
        <input type="checkbox" id="ddToggleAll" ${filterAll ? "checked" : ""}>
      </label>

      <div class="dd-sep"></div>

      <div class="dd-cats-grid">
        ${ordered
          .map(
            (cat) => `
              <label class="dd-chip">
                <span>${cat}</span>
                <input
                  type="checkbox"
                  class="dd-toggle-cat"
                  data-cat="${cat}"
                  ${filterCats.has(cat) ? "checked" : ""}
                >
              </label>
            `,
          )
          .join("")}
      </div>
    </div>
  `;

  const ddAll = $("ddToggleAll");
  if (ddAll) {
    ddAll.addEventListener("change", () => {
      filterAll = ddAll.checked;
      if (filterAll) filterCats.clear();
      if (!filterAll && filterCats.size === 0) filterAll = true;

      renderCategoriesMenu();
      renderCategoriesSidebar();
      renderProducts();
    });
  }

  menu.querySelectorAll(".dd-toggle-cat").forEach((inp) => {
    inp.addEventListener("change", () => {
      const cat = inp.dataset.cat;
      if (inp.checked) filterCats.add(cat);
      else filterCats.delete(cat);

      if (filterCats.size > 0) filterAll = false;
      if (filterCats.size === 0) filterAll = true;

      renderCategoriesMenu();
      renderCategoriesSidebar();
      renderProducts();
    });
  });
}

/***********************
 * SIDEBAR CATEGORÍAS (desktop)
 ***********************/
function renderCategoriesSidebar() {
  const list = $("categoriesSidebarList");
  if (!list) return;

  const ordered = getOrderedCategoriesFrom(products);
  const allMedidas = getAllMedidas();
  const { featured, rest } = splitMedidas(allMedidas);

  const medidaRow = (m, fire) => `
    <label class="medida-row ${filterMedidas.has(m) ? "active" : ""}">
      <span class="medida-text">${m}${fire ? ' <span class="medida-fire">🔥</span>' : ""}</span>
      <input
        type="checkbox"
        class="filter-medida"
        data-medida="${m}"
        ${filterMedidas.has(m) ? "checked" : ""}
      >
      <span class="medida-box"></span>
    </label>
  `;

  // Sub-lista de medidas (checkboxes) que se muestra debajo de "Cuadros".
  // Por defecto solo las destacadas (con 🔥); el resto queda oculto tras un
  // "Ver más". Si hay una medida no destacada ya seleccionada, se abre solo.
  const medidasExp = medidasExpanded || rest.some((m) => filterMedidas.has(m));
  const medidasBlock =
    allMedidas.length > 0
      ? `<div class="medida-list">${featured
          .map((m) => medidaRow(m, true))
          .join("")}${
          rest.length
            ? `<button type="button" class="medida-vermas" id="medidaVerMas">${
                medidasExp ? "Ver menos" : "Ver más"
              }</button><div class="medida-rest" id="medidaRest"${
                medidasExp ? "" : ' style="display:none"'
              }>${rest.map((m) => medidaRow(m, false)).join("")}</div>`
            : ""
        }</div>`
      : "";

  list.innerHTML = `
    <label class="toggle-row ${filterAll ? "active" : ""}">
      <span class="toggle-text">Todos los artículos</span>
      <input type="checkbox" id="toggleAll" ${filterAll ? "checked" : ""}>
      <span class="toggle-ui"></span>
    </label>

    <div class="toggle-sep"></div>

    ${ordered
      .map((cat) => {
        const row = `
          <label class="toggle-row ${filterCats.has(cat) ? "active" : ""}">
            <span class="toggle-text">${cat}</span>
            <input
              type="checkbox"
              class="toggle-cat"
              data-cat="${cat}"
              ${filterCats.has(cat) ? "checked" : ""}
            >
            <span class="toggle-ui"></span>
          </label>
        `;
        // Debajo de Cuadros, las medidas como sub-filtro.
        return String(cat).trim().toLowerCase() === SUBCATEGORY_PARENT
          ? row + medidasBlock
          : row;
      })
      .join("")}
  `;

  const all = $("toggleAll");
  if (all) {
    all.addEventListener("change", () => {
      filterAll = all.checked;
      if (filterAll) filterCats.clear();
      if (!filterAll && filterCats.size === 0) filterAll = true;
      filterMedidas.clear(); // "Todos" limpia también el filtro de medidas

      renderCategoriesSidebar();
      renderCategoriesMenu?.();
      renderProducts();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  list.querySelectorAll(".toggle-cat").forEach((inp) => {
    inp.addEventListener("change", () => {
      const cat = inp.dataset.cat;
      if (inp.checked) filterCats.add(cat);
      else filterCats.delete(cat);

      if (filterCats.size > 0) filterAll = false;
      if (filterCats.size === 0) filterAll = true;
      filterMedidas.clear(); // elegir categoría resetea el sub-filtro de medidas

      renderCategoriesSidebar();
      renderCategoriesMenu?.();
      renderProducts();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  list.querySelectorAll(".filter-medida").forEach((inp) => {
    inp.addEventListener("change", () => {
      const m = inp.dataset.medida;
      if (inp.checked) filterMedidas.add(m);
      else filterMedidas.delete(m);

      renderCategoriesSidebar();
      renderProducts();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  const verMasBtn = $("medidaVerMas");
  if (verMasBtn) {
    verMasBtn.addEventListener("click", () => {
      medidasExpanded = !medidasExpanded;
      const restEl = $("medidaRest");
      if (restEl) restEl.style.display = medidasExpanded ? "" : "none";
      verMasBtn.textContent = medidasExpanded ? "Ver menos" : "Ver más";
    });
  }
}

/***********************
 * USER MENU
 ***********************/
function closeUserMenu() {
  const menu = $("userMenu");
  if (!menu) return;
  menu.classList.remove("open");
  menu.setAttribute("aria-hidden", "true");
}

function toggleUserMenu() {
  const menu = $("userMenu");
  if (!menu) return;

  const open = menu.classList.contains("open");
  closeCategoriesMenu();
  menu.classList.toggle("open", !open);
  menu.setAttribute("aria-hidden", !open ? "false" : "true");

  const btn = $("helloNavBtn");
  if (btn) btn.setAttribute("aria-expanded", !open ? "true" : "false");
}

/***********************
 * PERFIL (UI)
 ***********************/
function waLink(msg) {
  const text = encodeURIComponent(String(msg || "").trim());
  return `https://wa.me/5491131181021?text=${text}`;
}

async function loadMyOrdersUI() {
  const box = $("myOrdersBox");
  const toggleBtn = $("btnOrdersToggle");

  if (!box) return;

  // Ocultar Ver Más por default — solo se muestra si hay > 3 pedidos
  if (toggleBtn) toggleBtn.style.display = "none";

  if (!currentSession || !customerProfile?.id) {
    box.textContent = "Iniciá sesión para ver tus pedidos.";
    return;
  }

  box.textContent = "Cargando…";

  try {
    const { data, error } = await supabaseClient
      .from("orders")
      .select("id, created_at, total, enviado_a_compras_at")
      .eq("customer_id", customerProfile.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    if (!data || !data.length) {
      box.innerHTML = `
        <div class="empty-state-mini">
          <svg class="empty-state-mini-face" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <circle cx="60" cy="60" r="48" fill="none" stroke="#222" stroke-width="7"/>
            <circle cx="46" cy="52" r="5" fill="#222"/>
            <circle cx="74" cy="52" r="5" fill="#222"/>
            <path d="M44 80 Q60 66 76 80" fill="none" stroke="#222" stroke-width="6" stroke-linecap="round"/>
          </svg>
          <div class="empty-state-mini-text">
            <strong>No hay pedidos todavía</strong>
            <span>Cuando hagas tu primer pedido aparecerá acá.</span>
          </div>
        </div>
      `;
      if (toggleBtn) toggleBtn.style.display = "none";
      return;
    }

    // Tracking: lookup directo en order_tracking por np_number = String(order.id)
    // Columnas reales en order_tracking: np_number, status, fecha_entrega
    // Valores de status: "recibido" | "programado" | "entregado"
    const orderIds = data.map((o) => o.id);
    const orderIdsAsNps = orderIds.map((id) => String(id));
    const trackByNp = {};
    if (orderIdsAsNps.length) {
      try {
        const { data: tracks } = await supabaseClient
          .from("order_tracking")
          .select("np_number, status, fecha_entrega")
          .in("np_number", orderIdsAsNps);
        (tracks || []).forEach((t) => (trackByNp[t.np_number] = t));
      } catch (e) {
        console.warn("[orders] no se pudo leer order_tracking:", e);
      }
    }

    // Calcula la etapa (0..2) y label de un pedido según order_tracking.status:
    //  0 Recibido   — sin fila en order_tracking, o status "recibido"
    //  1 Programado — status "programado"
    //  2 Entregado  — status "entregado"
    function getOrderStage(orderId) {
      const t = trackByNp[String(orderId)];
      if (!t) return { stage: 0, label: "Recibido", subtitle: "" };

      const fechaStr = t.fecha_entrega
        ? new Date(t.fecha_entrega).toLocaleDateString("es-AR")
        : "";

      if (t.status === "entregado") {
        return {
          stage: 2,
          label: "Entregado",
          subtitle: fechaStr ? "el " + fechaStr : "",
        };
      }
      if (t.status === "programado") {
        return {
          stage: 1,
          label: "Programado",
          subtitle: fechaStr ? "para " + fechaStr : "",
        };
      }
      // status "recibido" o cualquier otro → stage 0 (sin fecha)
      return { stage: 0, label: "Recibido", subtitle: "" };
    }

    function renderStepper(st) {
      const parts = [];
      for (let i = 0; i <= 2; i++) {
        if (i > 0) {
          parts.push(
            '<span class="o-line ' + (i <= st.stage ? "done" : "") + '"></span>',
          );
        }
        parts.push(
          '<span class="o-dot ' +
            (i <= st.stage ? "done" : "") +
            (i === st.stage ? " current" : "") +
            '" title="' +
            ["Recibido", "Programado", "Entregado"][i] +
            '"></span>',
        );
      }
      return '<div class="o-stepper">' + parts.join("") + "</div>";
    }

    let showAll = false;

    function render() {
      const list = showAll ? data : data.slice(0, 3);

      box.innerHTML = list
        .map((order) => {
          const fecha = new Date(order.created_at);
          const fechaStr = fecha.toLocaleDateString("es-AR");
          const totalStr = Math.round(Number(order.total || 0)).toLocaleString(
            "es-AR",
          );
          const st = getOrderStage(order.id);
          const stepper = renderStepper(st);
          const sub = st.subtitle
            ? '<span class="o-stage-sub">' + st.subtitle + "</span>"
            : "";

          return `
  <div class="order-row">
    <div class="order-col order-date">${fechaStr}</div>
    <div class="order-col order-total">$ ${totalStr}</div>
    <div class="order-col order-action">
      <div class="hist-actions">
        <button class="hist-btn subtle" data-download-order="${order.id}">
          Descargar Pedido
        </button>

        <button class="hist-btn" data-repeat="${order.id}">
          Repetir Pedido
        </button>
${
  isOrderEditable(order)
    ? `        <div class="hist-edit-wrap">
          <span class="hist-edit-hint">Pod&eacute;s editar hasta las 12:30 hs sin avisarnos.</span>
          <button class="hist-edit-link" data-edit="${order.id}">&#9998; Editar pedido</button>
        </div>`
    : ""
}
      </div>
    </div>
    <div class="order-col order-tracking" data-stage="${st.stage}">
      ${stepper}
      <span class="o-stage-label o-stage-${st.stage}">${st.label}</span>
      ${sub}
    </div>
  </div>
`;
        })
        .join("");
    }

    render();

    if (toggleBtn) {
      toggleBtn.style.display = data.length > 3 ? "inline-block" : "none";
      toggleBtn.textContent = "Ver Más";

      toggleBtn.onclick = () => {
        showAll = !showAll;
        toggleBtn.textContent = showAll ? "Ver Menos" : "Ver Más";
        render();
      };
    }

    // Evento repetir pedido

    box.addEventListener("click", async (e) => {
      const repeatId = e.target.dataset.repeat;
      if (repeatId) {
        await repeatOrder(repeatId);
        return;
      }

      const editId = e.target.dataset.edit;
      if (editId) {
        await editOrder(editId);
        return;
      }

      const downloadId = e.target.dataset.downloadOrder;
      if (downloadId) {
        await descargarComprobantePedido(downloadId);
      }
    });
  } catch (err) {
    box.textContent = "Error cargando pedidos.";
    console.error(err);
  }
}

// Estado de edición: si está seteado, submitOrder edita ese pedido en vez de
// crear uno nuevo. El candado real lo aplica la RPC edit_order_fast en el server.
let editingOrderId = null;

// Persistimos el modo edición en localStorage para que sobreviva a recargas de
// página: si no, al actualizar quedaba el carrito armado pero sin el cartel que
// indica que estás editando un pedido (confundía al usuario).
const EDITING_LS_KEY = "lk_editing_order_v1";

function setEditingOrderId(orderId) {
  editingOrderId = orderId ? String(orderId) : null;
  try {
    if (editingOrderId) {
      localStorage.setItem(EDITING_LS_KEY, editingOrderId);
    } else {
      localStorage.removeItem(EDITING_LS_KEY);
    }
  } catch (e) {}
}

// Un pedido es editable mientras NO haya salido a compras (enviado_a_compras_at
// == null) y antes del corte de las 12:30 que se lo llevaría. Esto es solo UI;
// la RPC vuelve a validar el flag server-side.
function isOrderEditable(order) {
  if (!order || order.enviado_a_compras_at) return false;
  const created = new Date(order.created_at);
  if (isNaN(created.getTime())) return false;
  const cutoff = new Date(created);
  cutoff.setHours(12, 30, 0, 0);
  const afterCutoff =
    created.getHours() > 12 ||
    (created.getHours() === 12 && created.getMinutes() >= 30);
  if (afterCutoff) cutoff.setDate(cutoff.getDate() + 1);
  return Date.now() < cutoff.getTime();
}

async function editOrder(orderId) {
  try {
    const { data, error } = await supabaseClient
      .from("order_items")
      .select("product_id, cajas")
      .eq("order_id", orderId);

    if (error) throw error;
    if (!data || !data.length) {
      alert("Ese pedido no tiene items para editar.");
      return;
    }

    cart.splice(0, cart.length);
    data.forEach((it) => {
      const cajas = Number(it.cajas || 0);
      if (!it.product_id || !cajas) return;
      cart.push({
        productId: it.product_id,
        qtyCajas: Math.max(1, Math.round(cajas)),
      });
    });

    setEditingOrderId(orderId);
    updateCart();
    renderProducts();
    setEditBanner(editingOrderId);
    showSection("carrito");
  } catch (err) {
    console.error("editOrder error:", err);
    alert("No se pudo abrir el pedido para editar.");
  }
}

// Cartel "Estás editando el pedido #X" debajo del botón Confirmar.
function setEditBanner(orderId) {
  let banner = document.getElementById("editOrderBanner");
  if (!orderId) {
    if (banner) banner.remove();
    return;
  }
  const btn = $("submitOrderBtn");
  if (!btn || !btn.parentNode) return;
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "editOrderBanner";
    banner.setAttribute(
      "style",
      "padding:8px 12px;border-radius:10px;background:#fff4d6;border:1px solid " +
        "#e6c34d;font-size:13px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;",
    );
    // El header del carrito es un grid con áreas nombradas. Colgamos el cartel
    // adentro y la celda "edit" (CSS) lo ubica al lado del botón Confirmar.
    const header = btn.closest(".section-header") || btn.parentNode;
    header.appendChild(banner);
  }
  banner.innerHTML =
    "<span>Estás editando el pedido <strong>#" +
    orderId +
    "</strong>. Podés editar hasta las 12:30 hs sin avisarnos.</span>" +
    '<button type="button" id="cancelEditBtn" class="hist-btn subtle">Cancelar edición</button>';
  const cancel = document.getElementById("cancelEditBtn");
  if (cancel) cancel.onclick = cancelEdit;
}

function cancelEdit() {
  setEditingOrderId(null);
  setEditBanner(null);
  cart.length = 0;
  saveCartToLS();
  updateCart();
  renderProducts();
  showSection("productos");
}

async function repeatOrder(orderId) {
  try {
    // Repetir siempre crea un pedido NUEVO — salir de cualquier modo edición.
    setEditingOrderId(null);
    setEditBanner(null);
    // Pedimos varias posibles columnas de cantidad para cubrir tu esquema real
    const { data, error } = await supabaseClient
      .from("order_items")
      .select("product_id, cajas")
      .eq("order_id", orderId);

    if (error) throw error;
    if (!data || !data.length) {
      alert("Ese pedido no tiene items para repetir.");
      return;
    }

    // Vaciar carrito actual
    cart.splice(0, cart.length);

    // Agregar productos al carrito
    data.forEach((it) => {
      const cajas = Number(
        it.cajas ??
          it.qtyCajas ??
          it.qty_cajas ??
          it.cantidad ??
          it.qty ??
          it.cajas_pedidas ??
          0,
      );

      if (!it.product_id || !cajas) return;

      cart.push({
        productId: it.product_id,
        qtyCajas: Math.max(1, Math.round(cajas)),
        source: "historial",
      });
      logCartAddEvent(it.product_id, "historial");
    });

    // Refrescar UI
    updateCart();
    renderProducts();

    // Ir al carrito
    showSection("carrito");
  } catch (err) {
    console.error("repeatOrder error:", err);
    alert("No se pudo repetir el pedido.");
  }
}

async function loadMyAddressesUI() {
  const box = $("myAddressesBox");
  if (!box) return;

  if (!currentSession || !customerProfile?.cod_cliente) {
    box.innerHTML = "Iniciá sesión para ver tus sucursales.";
    return;
  }

  box.innerHTML = "Cargando…";

  // Si customerProfile.id no está disponible, obtenerlo
  let customerId = customerProfile.id;
  if (!customerId) {
    const { data: custData } = await supabaseClient
      .from("customers")
      .select("id")
      .eq("auth_user_id", currentSession.user.id)
      .maybeSingle();
    customerId = custData?.id;
    if (!customerId) {
      box.innerHTML = "No se pudieron cargar las sucursales.";
      return;
    }
  }

  const { data, error } = await supabaseClient
    .from("customer_delivery_addresses")
    .select("slot,label,direccion_entrega,zona_expreso,pending_isis")
    .eq("customer_id", customerId)
    .order("slot", { ascending: true });

  if (error) {
    box.innerHTML = "No se pudieron cargar las sucursales.";
    return;
  }

  const rows = data || [];
  if (!rows.length) {
    box.innerHTML = "No tenés sucursales cargadas.";
    return;
  }

  // Slice: por default mostrar solo 8 + botón "Ver Más" para expandir
  var ADDR_INITIAL = 8;
  var showAllAddr = false;
  function renderAddrList() {
    var visible = showAllAddr ? rows : rows.slice(0, ADDR_INITIAL);
    var listHtml = visible
      .map(
        (r) => `
      <div class="addr-item${r.pending_isis ? ' addr-item--pending' : ''}">
        <span class="addr-slot">${r.slot}</span>
        <div class="addr-info">
          <span class="addr-label">${escapeHtml(r.label || "—")}</span>
          ${r.zona_expreso ? `<span class="addr-meta">${escapeHtml(r.zona_expreso)}</span>` : ""}
        </div>
        ${r.pending_isis ? '<span class="addr-pending" title="Pendiente de confirmación administrativa">⏳</span>' : ""}
      </div>
    `,
      )
      .join("");
    box.innerHTML = `<div class="addr-list" data-count="${visible.length}">${listHtml}</div>`;
  }
  renderAddrList();

  // Toggle Ver Más / Ver Menos en el wrapper de acciones de la card
  var toggleBtn = document.getElementById("btnAddressesToggle");
  if (toggleBtn) {
    if (rows.length > ADDR_INITIAL) {
      toggleBtn.style.display = "";
      toggleBtn.textContent = "Ver Más";
      toggleBtn.onclick = function () {
        showAllAddr = !showAllAddr;
        toggleBtn.textContent = showAllAddr ? "Ver Menos" : "Ver Más";
        renderAddrList();
      };
    } else {
      toggleBtn.style.display = "none";
    }
  }
}

// (escapeHtml ya está definido más abajo)

async function changePasswordUI() {
  if (window.__changingPass) return;
  window.__changingPass = true;
  const statusEl = document.getElementById("passStatus");
  const btn = document.getElementById("btnChangePass");

  const p1 = String(document.getElementById("newPass1")?.value || "").trim();
  const p2 = String(document.getElementById("newPass2")?.value || "").trim();

  const setStatus = (t) => {
    if (statusEl) statusEl.textContent = t;
  };

  // Validaciones
  if (!currentSession) {
    setStatus("Tenés que iniciar sesión.");
    return;
  }
  if (!p1 || !p2) {
    setStatus("Completá ambos campos.");
    return;
  }
  if (!/^\d+$/.test(p1) || !/^\d+$/.test(p2)) {
    setStatus("La contraseña debe ser solo numérica.");
    return;
  }
  if (p1.length < 6) {
    setStatus("La contraseña debe tener al menos 6 números.");
    return;
  }
  if (p1 !== p2) {
    setStatus("Las contraseñas no coinciden.");
    return;
  }

  btn && (btn.disabled = true);
  setStatus("Guardando…");

  try {
    // 1) Obtener sesión fresca (token)
    const { data: sessData, error: sessErr } =
      await supabaseClient.auth.getSession();
    if (sessErr) throw sessErr;

    let session = sessData?.session;

    // si por alguna razón no hay session, pedimos re-login
    if (!session?.access_token) {
      setStatus(
        "⚠️ Tu sesión no está disponible. Cerrá sesión e iniciá sesión de nuevo.",
      );
      return;
    }

    // 2) Llamada directa a Supabase Auth (PUT /auth/v1/user)
    const controller = new AbortController();
    const TIMEOUT_MS = 15000;
    const t = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // Si tenés el PIN actual guardado en customerProfile, evitamos setear el mismo
    const pinActual = String(customerProfile?.pin ?? "").trim();
    if (pinActual && String(p1) === pinActual) {
      setStatus("❌ El PIN nuevo no puede ser igual al actual.");
      btn && (btn.disabled = false);
      return;
    }

    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "PUT",
      signal: controller.signal,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: p1 }),
    });

    clearTimeout(t);

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`Auth ${resp.status}: ${txt || resp.statusText}`);
    }

    setStatus("✅ Contraseña actualizada.");

    // Actualizar PIN en customers via RPC set_my_pin.
    // La RPC es SECURITY DEFINER (sortea RLS) y pin viaja como text para preservar ceros a la izquierda.
    try {
      const { error: upErr } = await supabaseClient.rpc("set_my_pin", {
        p_pin: p1,
      });

      if (upErr) throw upErr;

      if (customerProfile) customerProfile.pin = p1;
    } catch (e) {
      console.warn("PIN no se pudo actualizar en customers:", e);
      setStatus(
        "✅ Contraseña actualizada. ⚠️ No se pudo guardar el PIN en customers.",
      );
    }

    document.getElementById("newPass1").value = "";
    document.getElementById("newPass2").value = "";
  } catch (err) {
    if (String(err?.name) === "AbortError") {
      setStatus("❌ Timeout al actualizar contraseña (red/bloqueo).");
    } else {
      setStatus(`❌ ${String(err?.message || err)}`);
    }
  } finally {
    btn && (btn.disabled = false);
    window.__changingPass = false;
  }
}

function fillProfileSummaryUI() {
  // Si no existe el HTML nuevo, no hacemos nada
  if (!$("pfRazonSocial")) return;

  // Si no hay sesión/perfil, mostramos guiones
  if (!currentSession || !customerProfile) {
    $("pfRazonSocial").textContent = "—";
    $("pfCodCliente").textContent = "—";
    $("pfCuit").textContent = "—";
    $("pfCorreo").textContent = "—";
    $("pfDtoVol").textContent = "—";
    return;
  }

  const razon = String(customerProfile.business_name || "").trim();
  const cod = String(customerProfile.cod_cliente || "").trim();
  const cuit = String(customerProfile.cuit || "").trim();
  const mail = String(customerProfile.mail || "").trim();
  const dto = Number(customerProfile.dto_vol || 0); // en tu DB parece venir como 0.15, 0.20, etc.

  $("pfRazonSocial").textContent = razon || "—";
  $("pfCodCliente").textContent = cod || "—";
  $("pfCuit").textContent = cuit || "—";
  $("pfCorreo").textContent = mail || "—";

  // Mostrar/ocultar correo según haya mail
  const correoWrap = $("pfCorreoWrap");
  if (correoWrap) correoWrap.style.display = mail ? "" : "none";

  // Mostrar % (si dto_vol es 0.15 => 15)
  const dtoEl = $("pfDtoVol");
  const dtoContainer = $("pfDtoVolWrap") || dtoEl?.parentElement;

  if (Number.isFinite(dto) && dto > 0) {
    dtoEl.textContent = Math.round(dto * 100) + "%";
    if (dtoContainer) dtoContainer.style.display = "";
  } else {
    if (dtoContainer) dtoContainer.style.display = "none";
  }

  // Setear data-count en el grid según items visibles para que CSS adapte cols
  const grid = $("pfDataGrid");
  if (grid) {
    let visibleCount = 2; // Cod + CUIT siempre
    if (mail) visibleCount++;
    if (Number.isFinite(dto) && dto > 0) visibleCount++;
    grid.setAttribute("data-count", String(visibleCount));
  }

  // Marcar la card según tipo (vendor en perfil propio vs cliente / vendor-as-cliente)
  const summaryEl = document.querySelector("#perfil .profile-summary");
  if (summaryEl) {
    if (typeof isVendorOwnMode === "function" && isVendorOwnMode()) {
      summaryEl.classList.add("is-vendor-profile");
    } else {
      summaryEl.classList.remove("is-vendor-profile");
    }
  }

  // Body classes para CSS:
  // - is-vendor-user: el usuario logueado es vendedor
  // - is-vendor-own-mode: vendedor sin cliente seleccionado (perfil propio)
  //   Cuando el vendedor está viendo a un cliente, is-vendor-own-mode NO se
  //   setea → Análisis de tus compras debe aparecer (del cliente viendo).
  if (typeof isActualVendor === "function") {
    document.body.classList.toggle("is-vendor-user", isActualVendor());
  }
  if (typeof isVendorOwnMode === "function") {
    document.body.classList.toggle("is-vendor-own-mode", isVendorOwnMode());
  }
}

// Abre el perfil + expande la card de Análisis + scrollea a ella.
window.openAnalisisFromMenu = async function () {
  if (!currentSession) {
    openLogin();
    return;
  }
  closeUserMenu && closeUserMenu();
  closeMobileUserMenu && closeMobileUserMenu();
  await openProfile();
  // Esperar el siguiente tick para que el toggle button esté wireado
  setTimeout(function () {
    var card = document.getElementById("profileCardAnalisis");
    var btn = document.getElementById("profileCardAnalisisToggle");
    if (!card || !btn) return;
    if (card.getAttribute("data-open") !== "true") {
      btn.click(); // expandir
    }
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 100);
};

async function openProfile() {
  if (!currentSession) {
    openLogin();
    return;
  }
  showSection("perfil");
  fillProfileSummaryUI(); // ✅ ESTA LÍNEA
  await loadMyOrdersUI();
  await loadMyAddressesUI();
  loadDraftCarts();
  loadVendorNotificationsUI();

  // Análisis de compras embebido (modo customer): exponemos customerProfile
  // global para que el módulo lo lea cuando el usuario expanda la card.
  // Lazy load: solo se dispara la búsqueda cuando hace click en el header
  // de la card colapsable (no al abrir el perfil).
  try {
    window.__lkCustomerProfile = customerProfile;
    setupAnalisisCardToggle();
  } catch (e) {
    console.warn("setupAnalisisCardToggle falló:", e);
  }
}

// Wire del toggle de la card "Análisis de tus compras". Lazy load.
function setupAnalisisCardToggle() {
  var card = document.getElementById("profileCardAnalisis");
  var btn = document.getElementById("profileCardAnalisisToggle");
  var body = document.getElementById("profileCardAnalisisBody");
  if (!card || !btn || !body) return;
  if (btn.__wired) return;
  btn.__wired = true;

  btn.addEventListener("click", function () {
    var isOpen = card.getAttribute("data-open") === "true";
    if (isOpen) {
      card.setAttribute("data-open", "false");
      btn.setAttribute("aria-expanded", "false");
      body.hidden = true;
    } else {
      card.setAttribute("data-open", "true");
      btn.setAttribute("aria-expanded", "true");
      body.hidden = false;
      // Lazy load: la primera vez que se abre, dispara avcInit
      if (!card.__avcLoaded) {
        card.__avcLoaded = true;
        var codCli =
          customerProfile && customerProfile.cod_cliente
            ? String(customerProfile.cod_cliente)
            : "";
        if (codCli && typeof window.avcInitCustomerMode === "function") {
          window.avcInitCustomerMode(codCli);
        }
      }
    }
  });
}

window.openProfile = openProfile;

/***********************
 * NOTIFICACIONES VENDEDOR (perfil)
 * Muestra los últimos pedidos hechos por los clientes del vendedor logueado.
 * Cada card: bullet + "Ver detalle" + "Sugerir productos".
 * Estado leído/no-leído se persiste en localStorage por vendedor.
 ***********************/
const VENDOR_NOTIF_LIMIT_INITIAL = 5;
const VENDOR_NOTIF_LIMIT_FULL = 30;
let _vendorNotifsState = {
  orders: [],
  showAll: false,
  customerById: {},
  inFlight: null, // Promise en curso, para deduplicar llamadas paralelas
  lastLoadedAt: 0,
};

function vendorNotifReadKey() {
  var uid =
    (currentSession && currentSession.user && currentSession.user.id) || "anon";
  return "lk_vendor_notifs_read_" + uid;
}

function getVendorNotifReadSet() {
  try {
    var raw = localStorage.getItem(vendorNotifReadKey());
    if (!raw) return new Set();
    var arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch (e) {
    return new Set();
  }
}

function markVendorNotifRead(orderId) {
  try {
    var set = getVendorNotifReadSet();
    set.add(String(orderId));
    localStorage.setItem(
      vendorNotifReadKey(),
      JSON.stringify(Array.from(set)),
    );
  } catch (e) {}
}

function markAllVendorNotifsRead() {
  try {
    var ids = (_vendorNotifsState.orders || []).map(function (o) {
      return String(o.id);
    });
    localStorage.setItem(vendorNotifReadKey(), JSON.stringify(ids));
  } catch (e) {}
}

async function loadVendorNotificationsUI() {
  var card = document.getElementById("vendorNotifsCard");
  var box = document.getElementById("vendorNotifsBox");
  var badge = document.getElementById("vendorNotifsBadge");
  var btnToggle = document.getElementById("btnNotifsToggle");
  var btnMarkAll = document.getElementById("btnNotifsMarkAllRead");
  if (!card) return;

  // Sólo se muestra al vendedor en su perfil propio (no a clientes ni cuando
  // el vendedor está actuando en nombre de un cliente)
  if (!isVendorOwnMode()) {
    if (card) card.hidden = true;
    return;
  }
  card.hidden = false;

  // Mapa customer_id -> {business_name, cod_cliente}
  // Combina linkedCustomers (auth-based) + customers con vend=vendor.vend
  // (cubre el caso donde un cliente no está aún en user_customer_links)
  var customerById = {};
  (linkedCustomers || []).forEach(function (c) {
    customerById[c.customer_id] = {
      business_name: c.business_name || "",
      cod_cliente: c.cod_cliente || "",
    };
  });

  // Fallback: agregar clientes con vend matching del vendedor
  console.log(
    "[notifs] linkedCustomers count:",
    (linkedCustomers || []).length,
    "_vendorOwnProfile.vend:",
    _vendorOwnProfile && _vendorOwnProfile.vend,
  );
  if (
    _vendorOwnProfile &&
    _vendorOwnProfile.vend !== undefined &&
    _vendorOwnProfile.vend !== null &&
    typeof supabaseClient !== "undefined"
  ) {
    try {
      var vendCode = String(_vendorOwnProfile.vend).trim();
      if (vendCode) {
        // Probar varias variantes (string + integer + sin padding)
        var vendVariants = [vendCode];
        var asNum = Number(vendCode);
        if (!isNaN(asNum)) {
          vendVariants.push(String(asNum));
          vendVariants.push(asNum);
        }
        // Único
        vendVariants = vendVariants.filter(function (v, i, a) {
          return a.indexOf(v) === i;
        });

        var byVendRes = await supabaseClient
          .from("customers")
          .select("id, business_name, cod_cliente, vend")
          .in("vend", vendVariants);

        console.log(
          "[notifs] fallback vend query —",
          "vend variants:",
          vendVariants,
          "rows:",
          byVendRes.data ? byVendRes.data.length : 0,
          "error:",
          byVendRes.error,
        );

        if (!byVendRes.error && Array.isArray(byVendRes.data)) {
          var added = 0;
          byVendRes.data.forEach(function (c) {
            if (!customerById[c.id]) {
              customerById[c.id] = {
                business_name: c.business_name || "",
                cod_cliente: c.cod_cliente || "",
              };
              added++;
            }
          });
          console.log("[notifs] fallback added", added, "new customers");
        }
      }
    } catch (e) {
      console.warn("[notifs] fallback by vend failed:", e);
    }
  }

  _vendorNotifsState.customerById = customerById;

  // Si ya tenemos datos cargados antes, renderizar YA (no resetear a "Cargando…")
  // y refrescar en background.
  var hasCache = _vendorNotifsState.orders.length > 0;
  if (hasCache) {
    renderVendorNotifications();
  } else if (box) {
    box.textContent = "Cargando…";
  }

  // Si hay una llamada en curso, esperar a esa misma (dedup race)
  if (_vendorNotifsState.inFlight) {
    try { await _vendorNotifsState.inFlight; } catch (e) {}
    if (_vendorNotifsState.orders.length) {
      renderVendorNotifications();
    } else if (box && !hasCache) {
      box.textContent = "Sin pedidos recientes de tus clientes.";
    }
    return;
  }

  // (sin early return: la query de orders se hace siempre, RLS filtra)

  // Estrategia: usar RPC server-side (SECURITY DEFINER) que retorna todos los
  // pedidos de la cartera del vendedor (linkedCustomers via user_customer_links),
  // bypassando RLS pero validando auth.uid() server-side.
  _vendorNotifsState.inFlight = (async function () {
    console.log("[notifs] calling RPC get_my_vendor_orders");
    var queryPromise = supabaseClient.rpc("get_my_vendor_orders", {
      p_limit: VENDOR_NOTIF_LIMIT_FULL,
    });
    var timeoutPromise = new Promise(function (_, reject) {
      setTimeout(function () {
        reject(new Error("Timeout (12s) consultando orders"));
      }, 12000);
    });
    var res = await Promise.race([queryPromise, timeoutPromise]);
    console.log(
      "[notifs] RPC done — rows:",
      (res && res.data && res.data.length) || 0,
      "error:",
      res && res.error,
    );
    return res;
  })();

  try {
    var res = await _vendorNotifsState.inFlight;
    if (res && res.error) throw res.error;
    var rawOrders = (res && res.data) || [];

    // Enriquecer customerById con info que viene del RPC
    rawOrders.forEach(function (o) {
      if (!customerById[o.customer_id]) {
        customerById[o.customer_id] = {
          business_name: o.business_name || "",
          cod_cliente: o.cod_cliente || "",
        };
      }
    });
    _vendorNotifsState.customerById = customerById;

    _vendorNotifsState.orders = rawOrders;
    _vendorNotifsState.lastLoadedAt = Date.now();

    // Stage + fecha_entrega vienen incluidos en el RPC (calculados server-side)
    var stageByOrder = {};
    var fechaByOrder = {};
    rawOrders.forEach(function (o) {
      stageByOrder[o.id] = Number.isFinite(o.stage) ? o.stage : 0;
      fechaByOrder[o.id] = o.fecha_entrega || null;
    });
    _vendorNotifsState.stageByOrder = stageByOrder;
    _vendorNotifsState.fechaByOrder = fechaByOrder;

    if (!_vendorNotifsState.orders.length) {
      if (box) box.textContent = "Sin pedidos recientes de tus clientes.";
      if (badge) badge.hidden = true;
      if (btnToggle) btnToggle.hidden = true;
      if (btnMarkAll) btnMarkAll.hidden = true;
      if (typeof updateMenuNotifBadge === "function") updateMenuNotifBadge();
      return;
    }
    renderVendorNotifications();
  } catch (e) {
    console.error("loadVendorNotificationsUI error:", e);
    // Si ya teníamos datos cargados antes, no romper la UI
    if (_vendorNotifsState.orders.length) {
      renderVendorNotifications();
    } else if (box) {
      box.textContent =
        "Error cargando notificaciones: " + (e?.message || e?.code || "ver consola");
    }
  } finally {
    _vendorNotifsState.inFlight = null;
  }
}

function renderVendorNotifications() {
  var box = document.getElementById("vendorNotifsBox");
  var badge = document.getElementById("vendorNotifsBadge");
  var btnToggle = document.getElementById("btnNotifsToggle");
  var btnMarkAll = document.getElementById("btnNotifsMarkAllRead");
  if (!box) return;

  var orders = _vendorNotifsState.orders || [];
  var customerById = _vendorNotifsState.customerById || {};
  var readSet = getVendorNotifReadSet();
  var unreadCount = orders.filter(function (o) {
    return !readSet.has(String(o.id));
  }).length;

  if (badge) {
    if (unreadCount > 0) {
      badge.hidden = false;
      badge.textContent = String(unreadCount);
    } else {
      badge.hidden = true;
    }
  }

  var showAll = _vendorNotifsState.showAll;
  var slice = showAll
    ? orders
    : orders.slice(0, VENDOR_NOTIF_LIMIT_INITIAL);

  var stageByOrder = _vendorNotifsState.stageByOrder || {};
  var fechaByOrder = _vendorNotifsState.fechaByOrder || {};

  function renderNotifStepper(stage, fechaIso, createdAtIso) {
    var stageNum = Number.isFinite(stage) ? stage : 0;
    var labels = ["Recibido", "Programado", "Enviado"];
    var parts = [];
    for (var i = 0; i <= 2; i++) {
      if (i > 0) {
        parts.push(
          '<span class="o-line ' + (i <= stageNum ? "done" : "") + '"></span>'
        );
      }
      parts.push(
        '<span class="o-dot ' +
          (i <= stageNum ? "done" : "") +
          (i === stageNum ? " current" : "") +
          '" title="' + labels[i] + '"></span>'
      );
    }

    // Sub-label con fecha siempre que esté disponible
    function fmtDateShort(iso) {
      if (!iso) return "";
      try {
        // Si viene en formato YYYY-MM-DD (DATE), parsear sin timezone shift
        var s = String(iso).slice(0, 10);
        var ps = s.split("-");
        if (ps.length === 3) {
          return ps[2] + "/" + ps[1] + "/" + ps[0].slice(2);
        }
        return new Date(iso).toLocaleDateString("es-AR");
      } catch (e) {
        return "";
      }
    }

    var sub = "";
    var fechaShow = "";
    var prefix = "";
    if (stageNum === 0) {
      // Recibido → fecha de creación del pedido
      fechaShow = fmtDateShort(createdAtIso);
      prefix = "el";
    } else if (stageNum === 1) {
      fechaShow = fmtDateShort(fechaIso);
      prefix = "para";
    } else if (stageNum === 2) {
      fechaShow = fmtDateShort(fechaIso);
      prefix = "el";
    }
    if (fechaShow) {
      sub =
        '<div class="notif-stage-sub">' +
        prefix +
        " " +
        escapeHtml(fechaShow) +
        "</div>";
    }

    return (
      '<div class="notif-stage-wrap">' +
      '<div class="o-stepper">' + parts.join("") + "</div>" +
      '<div class="notif-stage-label o-stage-' + stageNum + '">' +
      labels[stageNum] +
      "</div>" +
      sub +
      "</div>"
    );
  }

  var rowsHtml = slice
    .map(function (o, idx) {
      var c = customerById[o.customer_id] || {};
      var nombre = String(c.business_name || "Cliente").trim();
      var cod = String(c.cod_cliente || "").trim();
      var orderNum = String(o.id || "").trim();
      var fechaShort = o.created_at
        ? new Date(o.created_at).toLocaleDateString("es-AR", {
            day: "2-digit",
            month: "2-digit",
          })
        : "";
      var unread = !readSet.has(String(o.id));
      var stage = stageByOrder[o.id];
      var fechaEntrega = fechaByOrder[o.id];

      var posCls =
        (idx === 0 ? " first-row" : "") +
        (idx === slice.length - 1 ? " last-row" : "");

      return (
        '<div class="notif-row' +
        posCls +
        (unread ? " unread" : "") +
        '" data-order-id="' +
        escapeAttr(orderNum) +
        '" data-customer-id="' +
        escapeAttr(o.customer_id || "") +
        '">' +
        // Spine (línea + dot)
        '<div class="notif-spine">' +
        '<div class="notif-line"></div>' +
        '<div class="notif-dot' +
        (unread ? " unread" : "") +
        '"></div>' +
        "</div>" +
        // Cliente (clickeable → abre detalle)
        '<div class="notif-cell notif-cell-client">' +
        '<button type="button" class="notif-client-link js-vnotif-detail" data-order-id="' +
        escapeAttr(orderNum) +
        '" title="Ver detalle del pedido">' +
        escapeHtml(nombre) +
        (cod ? ' <span class="notif-cod">(' + escapeHtml(cod) + ")</span>" : "") +
        "</button>" +
        "</div>" +
        // Pedido (fecha DD/MM)
        '<div class="notif-cell notif-cell-date">' +
        escapeHtml(fechaShort || "—") +
        "</div>" +
        // Ver Detalle → botón Descargar
        '<div class="notif-cell notif-cell-action">' +
        '<button type="button" class="profile-btn notif-row-btn js-vnotif-download" data-order-id="' +
        escapeAttr(orderNum) +
        '">Descargar</button>' +
        "</div>" +
        // Estado del pedido (stepper)
        '<div class="notif-cell notif-cell-stage">' +
        renderNotifStepper(stage, fechaEntrega, o.created_at) +
        "</div>" +
        // Sugerir → botón Ver Sugeridos
        '<div class="notif-cell notif-cell-action">' +
        '<button type="button" class="profile-btn notif-row-btn notif-suggest-btn js-vnotif-suggest" data-customer-id="' +
        escapeAttr(o.customer_id || "") +
        '" data-order-id="' +
        escapeAttr(orderNum) +
        '">Ver sugeridos</button>' +
        "</div>" +
        "</div>"
      );
    })
    .join("");

  var html =
    '<div class="notif-timeline">' +
    '<div class="notif-thead">' +
    "<div></div>" +
    "<div>Cliente</div>" +
    "<div>Pedido</div>" +
    "<div>Ver Detalle</div>" +
    "<div>Estado de pedido</div>" +
    "<div>Sugerir</div>" +
    "</div>" +
    rowsHtml +
    "</div>";

  box.innerHTML = html;

  if (btnToggle) {
    if (orders.length > VENDOR_NOTIF_LIMIT_INITIAL) {
      btnToggle.hidden = false;
      btnToggle.textContent = showAll ? "Ver Menos" : "Ver Más";
    } else {
      btnToggle.hidden = true;
    }
    // onclick reemplaza handler previo (evita duplicados)
    btnToggle.onclick = function (e) {
      e.preventDefault();
      _vendorNotifsState.showAll = !_vendorNotifsState.showAll;
      renderVendorNotifications();
    };
  }
  if (btnMarkAll) {
    btnMarkAll.hidden = unreadCount === 0;
    btnMarkAll.onclick = function (e) {
      e.preventDefault();
      markAllVendorNotifsRead();
      renderVendorNotifications();
    };
  }

  // Sync badge en dropdown menu
  if (typeof updateMenuNotifBadge === "function") updateMenuNotifBadge();

  // Listeners por delegación (re-bind en cada render)
  box.querySelectorAll(".js-vnotif-detail").forEach(function (b) {
    b.addEventListener("click", function () {
      openVendorOrderDetail(b.getAttribute("data-order-id"));
    });
  });
  box.querySelectorAll(".js-vnotif-suggest").forEach(function (b) {
    b.addEventListener("click", function () {
      openVendorSuggestions(
        b.getAttribute("data-customer-id"),
        b.getAttribute("data-order-id"),
      );
    });
  });
  box.querySelectorAll(".js-vnotif-download").forEach(function (b) {
    b.addEventListener("click", async function () {
      var orderId = b.getAttribute("data-order-id");
      if (!orderId) return;
      // Marcar como leída
      markVendorNotifRead(orderId);
      renderVendorNotifications();
      // Estado de carga en el botón
      var oldText = b.textContent;
      b.disabled = true;
      b.textContent = "Generando…";
      try {
        await descargarComprobantePedido(orderId);
      } catch (e) {
        console.error("descargar pedido (notif) error:", e);
      } finally {
        b.disabled = false;
        b.textContent = oldText;
      }
    });
  });
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function escapeAttr(s) {
  return escapeHtml(s);
}

// (Toggle handlers ahora se bindean directamente en renderVendorNotifications)

/***********************
 * MODAL: detalle del pedido (vendedor)
 ***********************/
async function openVendorOrderDetail(orderId) {
  var modal = document.getElementById("vendorOrderDetailModal");
  var body = document.getElementById("vendorOrderDetailBody");
  var titleEl = document.getElementById("vendorOrderDetailTitle");
  if (!modal || !body) return;

  // Marcar como leído
  if (orderId) {
    markVendorNotifRead(orderId);
    renderVendorNotifications();
  }

  modal.classList.remove("hidden");
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  body.textContent = "Cargando…";

  try {
    var orderRes = await supabaseClient
      .from("orders")
      .select(
        "id, created_at, total, subtotal, status, payment_method, customer_id",
      )
      .eq("id", orderId)
      .maybeSingle();
    if (orderRes.error) throw orderRes.error;
    var order = orderRes.data || {};

    var custInfo = _vendorNotifsState.customerById[order.customer_id] || {};
    if (titleEl) {
      var orderIdStr = String(orderId || "");
      var orderShown = orderIdStr.length > 8 ? orderIdStr.slice(0, 8) : orderIdStr;
      titleEl.textContent = "Detalle Pedido " + orderShown;
    }

    var itemsRes = await supabaseClient
      .from("order_items")
      .select("product_id, cajas, uxb, is_loke")
      .eq("order_id", orderId);
    if (itemsRes.error) throw itemsRes.error;
    var items = itemsRes.data || [];

    // Resolver cod/desc/precio desde products (en memoria)
    var byPid = {};
    products.forEach(function (p) {
      byPid[String(p.id)] = p;
    });

    var totalFmt = Math.round(Number(order.total || 0)).toLocaleString("es-AR");
    var fechaStr = order.created_at
      ? new Date(order.created_at).toLocaleString("es-AR")
      : "";

    var rowsHtml = items.length
      ? items
          .map(function (it) {
            var prod = byPid[String(it.product_id)] || {};
            var cod = prod.cod || "";
            var desc = prod.description || "";
            var uxb = Number(it.uxb || prod.uxb || 0);
            var cajas = Number(it.cajas || 0);
            var unidades = uxb * cajas;
            var listUnit = Number(prod.list_price || prod.price_cash || 0);
            var sub = listUnit * unidades;
            return (
              "<tr>" +
              "<td>" +
              escapeHtml(cod) +
              "</td>" +
              '<td class="vd-desc">' +
              escapeHtml(desc) +
              "</td>" +
              '<td class="vd-num">' +
              cajas +
              "</td>" +
              '<td class="vd-num">' +
              unidades +
              "</td>" +
              '<td class="vd-num">$' +
              Math.round(listUnit).toLocaleString("es-AR") +
              "</td>" +
              '<td class="vd-num">$' +
              Math.round(sub).toLocaleString("es-AR") +
              "</td>" +
              "</tr>"
            );
          })
          .join("")
      : '<tr><td colspan="6" class="vd-empty">Sin ítems registrados.</td></tr>';

    body.innerHTML =
      '<div class="vd-total-banner">' +
      '<span class="vd-total-label">Total del pedido</span>' +
      '<span class="vd-total-amount">$' +
      totalFmt +
      "</span>" +
      "</div>" +
      '<div class="vd-header">' +
      "<div><b>Cliente:</b> " +
      escapeHtml(custInfo.business_name || "—") +
      " (" +
      escapeHtml(custInfo.cod_cliente || "") +
      ")</div>" +
      "<div><b>Fecha:</b> " +
      escapeHtml(fechaStr) +
      "</div>" +
      "<div><b>Estado:</b> " +
      escapeHtml(order.status || "—") +
      "</div>" +
      "<div><b>Pago:</b> " +
      escapeHtml(order.payment_method || "—") +
      "</div>" +
      "</div>" +
      '<div class="vd-table-wrap"><table class="vd-table">' +
      "<thead><tr><th>Cod</th><th>Descripción</th><th>Cajas</th><th>Unid</th><th>P.unit</th><th>Subtotal</th></tr></thead>" +
      "<tbody>" +
      rowsHtml +
      "</tbody>" +
      "</table></div>";
  } catch (e) {
    console.error("openVendorOrderDetail error:", e);
    body.textContent = "No se pudo cargar el pedido.";
  }
}

function closeVendorOrderDetail() {
  var modal = document.getElementById("vendorOrderDetailModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

/***********************
 * MODAL: sugerir productos (vendedor)
 * Muestra productos NUEVOS + productos que el cliente NO tiene en su surtido 18m.
 ***********************/
async function openVendorSuggestions(customerId, orderId) {
  var modal = document.getElementById("vendorSuggestModal");
  var body = document.getElementById("vendorSuggestBody");
  var titleEl = document.getElementById("vendorSuggestTitle");
  if (!modal || !body) return;

  if (orderId) {
    markVendorNotifRead(orderId);
    renderVendorNotifications();
  }

  modal.classList.remove("hidden");
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  body.textContent = "Buscando sugerencias…";

  try {
    var custInfo = _vendorNotifsState.customerById[customerId] || {};
    var codCliente = custInfo.cod_cliente || "";
    if (titleEl) {
      titleEl.textContent =
        "Sugerir productos" +
        (custInfo.business_name ? " · " + custInfo.business_name : "");
    }

    if (!codCliente) {
      body.textContent = "Falta cod_cliente para este cliente.";
      return;
    }

    // Sugerencias IA del cliente
    console.log(
      "[suggest] llamando sugerencias_cliente para cod:",
      codCliente,
      "cliente:",
      custInfo.business_name,
      "customerId:",
      customerId,
    );
    var sugRes = await supabaseClient.rpc("sugerencias_cliente", {
      p_customer: String(codCliente),
    });
    console.log(
      "[suggest] respuesta — rows:",
      (sugRes.data && sugRes.data.length) || 0,
      "error:",
      sugRes.error,
      "primeros 3 cods:",
      (sugRes.data || []).slice(0, 3).map(function (r) { return r.cod || r.codigo; }),
    );
    if (sugRes.error) {
      console.error("sugerencias_cliente error:", sugRes.error);
      body.textContent =
        "Error cargando sugerencias IA: " + (sugRes.error.message || "");
      return;
    }
    var sugRows = sugRes.data || [];

    // Helper de pick
    function pickField(o, keys, fallback) {
      for (var i = 0; i < keys.length; i++) {
        var v = o[keys[i]];
        if (v !== undefined && v !== null && v !== "") return v;
      }
      return fallback === undefined ? "" : fallback;
    }

    function prodCardHtml(p, tag) {
      var pid = String(pickField(p, ["product_id", "id", "productId"], ""));
      var cod = String(pickField(p, ["cod", "codigo", "item_code"], ""));
      var desc = String(pickField(p, ["description", "descripcion", "articulo"], ""));
      var uxb = Number(pickField(p, ["uxb"], 0));
      var listPrice = Number(pickField(p, ["list_price", "price_cash", "precio"], 0));
      var motivo = String(pickField(p, ["texto_clientes", "mensaje", "texto"], ""));
      var codSafe = encodeURIComponent(cod);
      var img = cod ? primaryProductImage(p) : "img/no-image.jpg";
      var priceFmt = Math.round(listPrice).toLocaleString("es-AR");
      return (
        '<div class="vs-card">' +
        '<img class="vs-img" src="' +
        escapeAttr(img) +
        '" alt="' +
        escapeAttr(desc) +
        '" loading="lazy" onerror="this.onerror=null;this.src=\'img/no-image.jpg\'" />' +
        '<div class="vs-info">' +
        (tag ? '<div class="vs-tag">' + tag + "</div>" : "") +
        '<div class="vs-cod">' +
        escapeHtml(cod) +
        "</div>" +
        '<div class="vs-desc">' +
        escapeHtml(desc) +
        "</div>" +
        (motivo
          ? '<div class="vs-motivo">' + escapeHtml(motivo) + "</div>"
          : "") +
        '<div class="vs-price-block">' +
        '<div class="vs-price">$' +
        priceFmt +
        "</div>" +
        '<div class="vs-uxb">UxB: ' +
        uxb +
        " · Precio Lista</div>" +
        "</div>" +
        '<div class="vs-action">' +
        '<div class="vs-qty-row">' +
        '<span class="vs-qty-label">Cajas</span>' +
        '<div class="vs-stepper">' +
        '<button type="button" class="vs-step-btn js-vs-dec" data-pid="' +
        escapeAttr(pid) +
        '">−</button>' +
        '<input class="vs-step-in" type="number" min="1" value="1" id="vs-qty-' +
        escapeAttr(pid) +
        '" />' +
        '<button type="button" class="vs-step-btn js-vs-inc" data-pid="' +
        escapeAttr(pid) +
        '">+</button>' +
        "</div>" +
        "</div>" +
        '<button type="button" class="profile-btn vs-add-btn js-vs-add" data-pid="' +
        escapeAttr(pid) +
        '" data-cust-id="' +
        escapeAttr(customerId) +
        '">Agregar al pedido</button>' +
        "</div>" +
        "</div>" +
        "</div>"
      );
    }

    var html = "";
    if (sugRows.length) {
      html =
        '<div class="vs-grid">' +
        sugRows
          .map(function (p) {
            return prodCardHtml(p, "");
          })
          .join("") +
        "</div>";
    } else {
      html =
        '<div class="vs-empty">La IA no encontró sugerencias para este cliente.</div>';
    }
    body.innerHTML = html;

    // Bind stepper + Agregar
    body.querySelectorAll(".js-vs-inc").forEach(function (b) {
      b.addEventListener("click", function () {
        var pid = b.getAttribute("data-pid");
        var inp = document.getElementById("vs-qty-" + pid);
        if (!inp) return;
        inp.value = String(Math.max(1, (parseInt(inp.value, 10) || 1) + 1));
      });
    });
    body.querySelectorAll(".js-vs-dec").forEach(function (b) {
      b.addEventListener("click", function () {
        var pid = b.getAttribute("data-pid");
        var inp = document.getElementById("vs-qty-" + pid);
        if (!inp) return;
        inp.value = String(Math.max(1, (parseInt(inp.value, 10) || 1) - 1));
      });
    });
    body.querySelectorAll(".js-vs-add").forEach(function (b) {
      b.addEventListener("click", async function () {
        var pid = b.getAttribute("data-pid");
        var custId = b.getAttribute("data-cust-id");
        var inp = document.getElementById("vs-qty-" + pid);
        var qty = Math.max(1, parseInt(inp && inp.value, 10) || 1);
        await vendorSuggestAddToCart(pid, qty, custId, b);
      });
    });
  } catch (e) {
    console.error("openVendorSuggestions error:", e);
    body.textContent = "Error cargando sugerencias.";
  }
}

function closeVendorSuggestions() {
  var modal = document.getElementById("vendorSuggestModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

/**
 * Agrega un producto al carrito desde el modal Sugerir Productos.
 * Si el cliente activo no es el del modal, primero conmuta el customerProfile
 * (para que el carrito quede asociado a ese cliente al confirmar el pedido).
 */
async function vendorSuggestAddToCart(productId, qty, customerId, btnEl) {
  if (!productId || !customerId) return;
  if (!currentSession) {
    if (typeof openLogin === "function") openLogin();
    return;
  }
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.dataset._old = btnEl.textContent;
    btnEl.textContent = "Agregando…";
  }
  try {
    // Si el cliente activo es distinto, conmutar
    var needSwitch = !customerProfile || String(customerProfile.id) !== String(customerId);
    if (needSwitch) {
      _csSetValue("customerSelect", customerId);
      _csSetValue("customerSelectCart", customerId);
      if (typeof onLinkedCustomerSelected === "function") {
        await onLinkedCustomerSelected();
      }
    }

    // Agregar N cajas al cart (sumando si ya existía)
    var existing = cart.find(function (i) { return i.productId === productId; });
    if (existing) {
      existing.qtyCajas = (Number(existing.qtyCajas) || 0) + qty;
    } else {
      cart.push({ productId: productId, qtyCajas: qty, source: "sugerencia_vendedor" });
      logCartAddEvent(productId, "sugerencia_vendedor");
    }

    if (typeof updateCart === "function") updateCart();
    if (typeof renderProducts === "function") renderProducts();
    if (typeof scheduleViewOrderToastAfterAdd === "function") {
      scheduleViewOrderToastAfterAdd();
    }

    if (btnEl) {
      btnEl.textContent = "Agregado ✓";
      btnEl.classList.add("vs-added");
      setTimeout(function () {
        btnEl.disabled = false;
        btnEl.textContent = btnEl.dataset._old || "Agregar al pedido";
        btnEl.classList.remove("vs-added");
      }, 1400);
    }
  } catch (e) {
    console.error("vendorSuggestAddToCart error:", e);
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = btnEl.dataset._old || "Agregar al pedido";
      alert("No se pudo agregar al pedido. Probá de nuevo.");
    }
  }
}
window.vendorSuggestAddToCart = vendorSuggestAddToCart;

// Listeners de cierre (backdrop + botón + X) — bindeo una sola vez al DOM listo
(function bindVendorNotifModalCloses() {
  function bindOnce() {
    var dBd = document.getElementById("vendorOrderDetailBackdrop");
    var dBtn = document.getElementById("btnCloseVendorOrderDetail");
    var dX = document.getElementById("btnXCloseVendorOrderDetail");
    var sBd = document.getElementById("vendorSuggestBackdrop");
    var sBtn = document.getElementById("btnCloseVendorSuggest");
    var sX = document.getElementById("btnXCloseVendorSuggest");
    if (dBd) dBd.addEventListener("click", closeVendorOrderDetail);
    if (dBtn) dBtn.addEventListener("click", closeVendorOrderDetail);
    if (dX) dX.addEventListener("click", closeVendorOrderDetail);
    if (sBd) sBd.addEventListener("click", closeVendorSuggestions);
    if (sBtn) sBtn.addEventListener("click", closeVendorSuggestions);
    if (sX) sX.addEventListener("click", closeVendorSuggestions);
    // ESC cierra cualquiera de los 2 modales
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      var dM = document.getElementById("vendorOrderDetailModal");
      var sM = document.getElementById("vendorSuggestModal");
      if (dM && dM.classList.contains("open")) closeVendorOrderDetail();
      if (sM && sM.classList.contains("open")) closeVendorSuggestions();
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindOnce);
  } else {
    bindOnce();
  }
})();

window.openVendorOrderDetail = openVendorOrderDetail;
window.closeVendorOrderDetail = closeVendorOrderDetail;
window.openVendorSuggestions = openVendorSuggestions;
window.closeVendorSuggestions = closeVendorSuggestions;
window.loadVendorNotificationsUI = loadVendorNotificationsUI;

/***********************
 * MENU DROPDOWN: visibilidad condicional (vendedor / cliente)
 ***********************/
/**
 * Distingue un vendedor real (cod_cliente sintético 100xx) de un cliente
 * multi-RS (que también tiene linkedCustomers via group_customers pero NO es
 * vendedor). isVendorProfile() solo mira si hay linkedCustomers; este helper
 * además exige que el perfil propio sea un vendedor sintético.
 */
function isActualVendor() {
  if (!_vendorOwnProfile) return false;
  var cod = String(_vendorOwnProfile.cod_cliente || "");
  // Vendedores "regulares" tienen cod 100XX. Loekemeyer SRL (cod 1)
  // también es un vendedor (interno) que vende a su propia cartera.
  return /^100\d{2}$/.test(cod) || cod === "1";
}

function isVendorOwnMode() {
  // Vendedor real con su propio perfil activo (no actuando como cliente)
  if (!isActualVendor() || !currentSession) return false;
  if (!customerProfile) return false;
  return String(customerProfile.id) === String(_vendorOwnProfile.id);
}

/**
 * Modo "navegar como vendedor" — vendedor logueado que aún no eligió un
 * cliente en el dropdown "Pedir para" (placeholder o "Perfil Vendedor"
 * seleccionado explícitamente). En este modo:
 *   - Solo ve Precio Lista (no Tu Precio Contado)
 *   - No puede agregar al carrito (al hacer click se hace scroll al dropdown)
 */
function isVendorProfileBrowseMode() {
  if (!isActualVendor() || !currentSession) return false;
  var sel = document.getElementById("customerSelect");
  if (!sel) return true; // antes de renderear el selector, asumir browse
  var val = sel.value;
  return val === "" || val === VENDOR_SELF_VALUE;
}

/**
 * Oculta el botón "Pedido (N)" del header (desktop + mobile) cuando el
 * vendedor está en modo browse. El vendedor no puede comprar a su nombre,
 * entonces no tiene sentido mostrarle el carrito hasta que elija un cliente.
 */
function _updateCartUIVisibility() {
  var hide = isVendorProfileBrowseMode();
  var cartLink = document.getElementById("cartLink");
  if (cartLink) cartLink.style.display = hide ? "none" : "";
  var mobileCartBtn = document.getElementById("mobileCartBtn");
  if (mobileCartBtn) mobileCartBtn.style.display = hide ? "none" : "";
}

/**
 * Hace scroll al dropdown de "Pedir para" + flash de atención.
 * Llamado cuando un vendedor en modo browse intenta agregar al carrito —
 * lo fuerza a elegir un cliente primero.
 */
function scrollToCustomerSelector() {
  var banner = document.getElementById("customerSelectorBanner");
  if (!banner) return;
  banner.scrollIntoView({ behavior: "smooth", block: "center" });
  // Flash visual para llamar atención
  banner.classList.remove("cs-flash-attention");
  // Forzar reflow para que la animación re-arranque
  void banner.offsetWidth;
  banner.classList.add("cs-flash-attention");
  // Limpiar la clase tras 1.5s
  setTimeout(function () {
    banner.classList.remove("cs-flash-attention");
  }, 1500);
  // Abrir el dropdown automáticamente para que el usuario vea las opciones
  setTimeout(function () {
    var trigger = banner.querySelector(".cs-trigger");
    if (trigger) trigger.click();
  }, 350);
}
window.scrollToCustomerSelector = scrollToCustomerSelector;

function updateMenuNotifVisibility() {
  // "Pedidos Clientes": solo visible cuando el vendedor está en su perfil propio
  // (no cuando actúa en nombre de un cliente)
  var notifEntries = [
    document.getElementById("menuNotifications"),
    document.getElementById("menuNotificationsMobile"),
  ];
  var showNotif = isVendorOwnMode();
  notifEntries.forEach(function (el) {
    if (el) el.style.display = showNotif ? "" : "none";
  });
  if (showNotif) updateMenuNotifBadge();

  // Card "Pedidos Clientes" en Mi perfil: ocultar cuando no está en modo propio
  var notifCard = document.getElementById("vendorNotifsCard");
  if (notifCard) notifCard.hidden = !showNotif;

  // "Historial de Compras" + "Sugerencia Compra x IA": ocultar al vendedor en
  // modo propio, mostrar a clientes y al vendedor cuando actúa como cliente
  var hideClientItems = isVendorOwnMode();
  var clientItems = [
    document.getElementById("menuHistorial"),
    document.getElementById("menuHistorialMobile"),
    document.getElementById("menuSugerencias"),
    document.getElementById("menuSugerenciasMobile"),
    // Cards equivalentes en "Mi perfil"
    document.getElementById("profileCardHistorial"),
    document.getElementById("profileCardSugerencias"),
    document.getElementById("profileCardOrdersWeb"),
    document.getElementById("profileCardSucursales"),
  ];
  clientItems.forEach(function (el) {
    if (el) el.style.display = hideClientItems ? "none" : "";
  });
}

function updateMenuNotifBadge() {
  var badges = [
    document.getElementById("menuNotifBadge"),
    document.getElementById("menuNotifBadgeMobile"),
  ];
  var orders = _vendorNotifsState.orders || [];
  var readSet = getVendorNotifReadSet();
  var unread = orders.filter(function (o) {
    return !readSet.has(String(o.id));
  }).length;
  badges.forEach(function (b) {
    if (!b) return;
    if (unread > 0) {
      b.hidden = false;
      b.textContent = unread > 99 ? "99+" : String(unread);
    } else {
      b.hidden = true;
    }
  });
}

async function openNotificationsFromMenu() {
  if (!currentSession) {
    if (typeof openLogin === "function") openLogin();
    return;
  }
  if (typeof closeUserMenu === "function") closeUserMenu();
  showSection("perfil");
  fillProfileSummaryUI();
  // Cargar el resto del perfil sin bloquear, en paralelo
  loadMyOrdersUI();
  loadMyAddressesUI();
  loadDraftCarts();
  await loadVendorNotificationsUI();
  // Scroll a la card
  setTimeout(function () {
    var el = document.getElementById("vendorNotifsCard");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 80);
}

window.openNotificationsFromMenu = openNotificationsFromMenu;
window.updateMenuNotifVisibility = updateMenuNotifVisibility;
window.updateMenuNotifBadge = updateMenuNotifBadge;

/***********************
 * BUSCADOR
 ***********************/
function setSearchInputValue(val) {
  const v = val || "";
  const nav = $("navSearch");
  const mobile = $("mobileSearch");
  if (nav) nav.value = v;
  if (mobile) mobile.value = v;
}

function getFilteredProducts() {
  let list = products.slice();

  // Medidas (Cuadros): si hay alguna seleccionada, MANDA sobre el filtro de
  // categoría → muestra los Cuadros que incluyan alguna de esas medidas
  // (un set cuenta si tiene al menos una). Si no hay medidas activas, aplica
  // el filtro de categorías normal.
  if (filterMedidas.size > 0) {
    list = list.filter((p) => {
      const ms = getProductMedidas(p);
      return ms.some((m) => filterMedidas.has(m));
    });
  } else if (!filterAll) {
    list = list.filter((p) => filterCats.has(String(p.category || "").trim()));
  }

  // NUEVOS
  if (filterNewOnly) {
    list = list.filter(
      (p) =>
        String(p.badge_status || "")
          .trim()
          .toUpperCase() === "NUEVO",
    );
  }

  // MI SURTIDO
  if (filterMyAssortment) {
    if (myAssortmentIds instanceof Set) {
      list = list.filter((p) => myAssortmentIds.has(String(p.id)));
    }
  }

  // Buscador
  if (searchTerm && String(searchTerm).trim()) {
    const term = normalizeText(searchTerm);
    list = list.filter((p) => {
      const hay = [p.cod, p.description].map(normalizeText).join(" ");
      return hay.includes(term);
    });
  }

  return list;
}

async function loadMyAssortmentIds() {
  if (!currentSession) return new Set();
  if (!customerProfile?.cod_cliente) return new Set();

  const { data, error } = await supabaseClient.rpc("get_my_assortment_18m", {
    p_customer: String(customerProfile.cod_cliente),
  });

  if (error) {
    console.error("RPC get_my_assortment_18m error:", error);
    return new Set();
  }

  return new Set((data || []).map((r) => String(r.product_id)));
}

/***********************
 * RENDER PRODUCTS  ✅ (FIX SORT REAL)
 ***********************/
// Flag: el entrance stagger se dispara UNA sola vez por carga de página.
// Sin esto, cada filtro/sort re-animaría toda la grilla → se siente lento.
let __productsEntranceFired = false;

function renderProducts() {
  const container = $("productsContainer");
  if (!container) return;

  // ✨ Sync carrusel de novedades en cada render (mantiene qty en cart sincronizada)
  try {
    renderNewProductsCarousel();
  } catch (e) {
    console.warn("renderNewProductsCarousel falló:", e);
  }

  container.innerHTML = "";

  const logged = !!currentSession;
  const list =
    typeof getFilteredProducts === "function"
      ? getFilteredProducts()
      : products;

  if (!list.length) {
    container.innerHTML = `
      <div style="padding:24px 40px; color:#666; font-size:14px;">
        Sin resultados${
          typeof searchTerm === "string" && searchTerm.trim()
            ? ` para "${String(searchTerm).trim()}"`
            : ""
        }.
      </div>
    `;
    return;
  }

  const buildCard = (p) => {
    const pid = String(p.id);
    const codSafe = String(p.cod || "").trim();

    // La imagen la arma buildCarouselHtml() mas abajo, leyendo
    // products.images (carpeta por codigo). PaginaLK usaba {cod}.webp en
    // la raiz del bucket, que en Tierra Nativa no existe.

    // ✅ Tu precio normal (se sigue usando para carrito / subtotal, no se muestra en card)
    const tuPrecio = logged ? unitYourPrice(getPriceForCustomer(p)) : 0;
    const dtoVol = Number(customerProfile?.dto_vol || 0);
    // Vendor en modo browse (sin cliente seleccionado o "Perfil Vendedor")
    // → solo Precio Lista, sin Tu Precio Contado.
    const vendorBrowse = isVendorProfileBrowseMode();
    const showListPriceOnly = isListPriceOnlyClient() || vendorBrowse;

    const tuPrecioContado = logged
      ? showListPriceOnly
        ? Number(getPriceForCustomer(p) || 0)
        : precioContadoUnitario(p)
      : 0;

    const badge = String(p.badge_status || "")
      .trim()
      .toUpperCase();

    let badgeHtml = "";

    if (badge === "NUEVO") {
      badgeHtml = '<div class="badge-nuevo">NUEVO</div>';
    } else if (badge === "LIQUIDACION" || badge === "LIQUIDACIÓN") {
      badgeHtml = '<div class="badge-liquidacion">LIQUIDACIÓN</div>';
    } else if (badge === "SIN STOCK") {
      badgeHtml = '<div class="badge-sinstock">SIN STOCK</div>';
    } else if (badge === "PROXIMAMENTE" || badge === "PRÓXIMAMENTE") {
      badgeHtml = '<div class="badge-proximamente">PRÓXIMAMENTE</div>';
    }

    const isMyAssortment =
      myAssortmentIds instanceof Set && myAssortmentIds.has(String(p.id));

    let assortmentStarHtml = "";

    if (isMyAssortment) {
      assortmentStarHtml = `
        <div class="badge-mi-surtido" title="Mi surtido" aria-label="Mi surtido">
          <svg viewBox="0 0 28 28" aria-hidden="true">
            <circle class="star-ring" cx="14" cy="14" r="11.5"></circle>
            <path class="star-fill" d="M14 5.8l2.15 4.35 4.8.7-3.48 3.39.82 4.79L14 16.76 9.71 19.03l.82-4.79-3.48-3.39 4.8-.7L14 5.8z"></path>
          </svg>
        </div>
      `;
    }

    const inCart = cart.find((i) => String(i.productId) === String(pid));
    const qty = inCart ? Number(inCart.qtyCajas || 0) : 0;
    const totalUni = qty * Number(p.uxb || 0);

    return `
      <div class="product-card" id="card-${pid}">
      ${badgeHtml}
      ${assortmentStarHtml}
        ${buildCarouselHtml(pid, getProductImages(p), p.description)}

        <div class="card-top">
          <div class="card-row">
            <div class="card-cod">Cod: <span>${codSafe}</span></div>
            <div class="card-uxb">UxB: <span>${p.uxb}</span></div>
          </div>

          <div class="card-desc">${String(p.description || "")}</div>

          <div class="${logged ? "" : "price-hidden"} card-prices">
  <div class="card-price-line">
    Precio Lista: <strong>$${formatMoney(getPriceForCustomer(p))}</strong><span class="card-iva">+ IVA</span>
  </div>

  ${
    showListPriceOnly
      ? ""
      : `
    <div class="card-price-line">
      Tu Precio Contado: <strong>$${formatMoney(tuPrecioContado)}</strong><span class="card-iva">+ IVA</span>
    </div>
  `
  }
</div>

          <div class="${logged ? "price-hidden" : ""} card-prices">
            <div class="price-locked" aria-hidden="true"></div>
          </div>
        </div>

        ${
          badge === "SIN STOCK"
            ? `
      <button class="add-btn disabled" disabled>
        Sin stock
      </button>
    `
            : badge === "PROXIMAMENTE" || badge === "PRÓXIMAMENTE"
              ? `
      <button class="add-btn disabled" disabled>
        Próximamente
      </button>
    `
            : !logged
              ? `
        <button class="add-btn add-login-btn" onclick="openLogin()">
          Iniciar sesión para ver precios
        </button>
      `
              : qty <= 0
                ? `
          <button class="add-btn ${vendorBrowse ? "add-vendor-browse" : ""}" id="add-${pid}" onclick="${vendorBrowse ? "scrollToCustomerSelector()" : "addFirstBox('" + pid + "','catalogo')"}" title="${vendorBrowse ? "Elegí primero una razón social" : ""}">
            ${vendorBrowse ? "Elegir razón social" : "Agregar al pedido"}
          </button>
        `
                : `
          <div class="card-cartbar" id="qty-${pid}">
          <div class="cartbar-top">
            <div class="cartbar-label">Subtotal</div>
            <div class="cartbar-subtotal">
              <strong class="cartbar-subv">
                $${formatMoney(
                  logged
                    ? unitYourPrice(getPriceForCustomer(p)) * (qty * Number(p.uxb || 0))
                    : 0,
                )}
              </strong>
              <span class="cartbar-iva">+ IVA</span>
            </div>
          </div>
                <div class="cartbar-controls">
                  <div class="cartbar-left">
                    <div class="cartbar-stepper" role="group" aria-label="Cantidad de cajas">
                      <button type="button" class="step-btn" onclick="changeQty('${pid}', -1)" aria-label="Restar 1 caja">−</button>
                      <input
                        class="step-input"
                        type="number"
                        min="1"
                        step="1"
                        value="${qty}"
                        inputmode="numeric"
                        onchange="manualQty('${pid}', this.value)"
                        aria-label="Cantidad de cajas"
                      >
                      <button type="button" class="step-btn" onclick="changeQty('${pid}', 1)" aria-label="Sumar 1 caja">+</button>
                    </div>

                    <button type="button" class="chip chip-5" onclick="changeQty('${pid}', 5)" aria-label="Sumar 5 cajas">+5</button>
                  </div>
                </div>

                <div class="cartbar-units">
                  Unidades: <strong>${formatMoney(totalUni)}</strong>
                </div>
              </div>
            `
        }
      </div>
    `;
  };

  // ✅ SOLO bestsellers en grilla global (opcional)
  if (sortMode === "bestsellers") {
    let items = [...list];
    items.sort(getSortComparator());

    container.innerHTML = `
      <div class="products-grid">
        ${items.map(buildCard).join("")}
      </div>
    `;
    return;
  }

  // ✅ Modo category (bloques por categoría)
  const cats = getOrderedCategoriesFrom(list);

  cats.forEach((category) => {
    const block = document.createElement("div");
    block.className = "category-block";

    const catId = `cat-${slugifyCategory(category)}`;

    let items = list.filter(
      (p) => String(p.category || "").trim() === String(category).trim(),
    );

    // category: ordenar dentro de cada categoría
    items = items.sort(getSortComparator());

    if (!items.length) return;

    let bodyHtml = "";

    if (String(category).trim().toLowerCase() === SUBCATEGORY_PARENT) {
      const groups = new Map();

      // Un producto puede tener MAS DE UNA subcategoria (11 de los 142
      // productos activos de Cuadros tienen dos). En ese caso aparece en
      // cada una, que es lo esperable al filtrar. La version de PaginaLK
      // asumia un solo valor de texto y habria creado una subcategoria
      // fantasma "Beach,Nature".
      items.forEach((p) => {
        subcategoriesOf(p).forEach((key) => {
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(p);
        });
      });

      const present = Array.from(groups.keys());
      const fixed = CUADROS_SUB_ORDER.filter((s) => present.includes(s));

      const extras = present
        .filter((s) => s !== "Otros" && !CUADROS_SUB_ORDER.includes(s))
        .sort((a, b) => a.localeCompare(b, "es"));

      const hasOtros = present.includes("Otros");
      const subcatsOrdered = [
        ...fixed,
        ...extras,
        ...(hasOtros ? ["Otros"] : []),
      ];

      // Cada subcategoría es su propia sección: título (fuera del grid) +
      // su propio .products-grid. Así el título no hereda grid-auto-rows:1fr
      // (que le daba la altura de una card → hueco gigante).
      // Cada colección (subcategoría) es un grupo flex cuyo ancho = --span
      // columnas de la grilla de 4 (--span = min(productos, 4)). Con flex-wrap:
      // dos colecciones de 2 caen lado a lado (2+2 = 4), una de 4 llena la
      // fila y una de 3 se queda sola con un hueco al final. Las cards de cada
      // grupo se reparten ese ancho (se achican para que entren 4), en vez de
      // una grilla por colección que dejaba espacios muertos.
      bodyHtml =
        `<div class="collections-flow">` +
        subcatsOrdered
          .map((sub) => {
            const prods = groups.get(sub) || [];
            prods.sort(getSortComparator());

            const span = Math.min(prods.length, 4) || 1;
            const cards = prods.map(buildCard).join("");
            return `<section class="col-group" style="--span:${span}">
              <div class="subcategory-title">${sub}</div>
              <div class="col-group-cards">${cards}</div>
            </section>`;
          })
          .join("") +
        `</div>`;
    } else {
      const cardsHtml = items.map(buildCard).join("");
      bodyHtml = `<div class="products-grid">${cardsHtml}</div>`;
    }

    block.innerHTML = `
      <h2 class="category-title" id="${catId}">${category}</h2>
      ${bodyHtml}
    `;

    container.appendChild(block);
  });

  if (!container.children.length) {
    container.innerHTML = `
      <div style="padding:24px 40px; color:#666; font-size:14px;">
        Sin resultados${
          typeof searchTerm === "string" && searchTerm.trim()
            ? ` para "${String(searchTerm).trim()}"`
            : ""
        }.
      </div>
    `;
    return;
  }

  // Activar los carruseles de imagen recien insertados. Es idempotente
  // (marca data-ready), asi que re-renders parciales no duplican listeners.
  initCarousels(container);

  // 🎬 Entrance stagger: SOLO la primera vez. Filtros/sort posteriores no re-animan.
  if (!__productsEntranceFired) {
    __productsEntranceFired = true;
    container.querySelectorAll(".products-grid").forEach((g) => {
      g.classList.add("lk-animate-in");
    });
    // Limpieza tras la anim para no dejar la clase indefinidamente
    setTimeout(() => {
      container.querySelectorAll(".products-grid.lk-animate-in").forEach((g) => {
        g.classList.remove("lk-animate-in");
      });
    }, 1500);
  }
}

/***********************
 * ✨ NOVEDADES — Carrusel productos badge_status = "NUEVO"
 * Auto-scroll tipo marquee (loop infinito por duplicación), pausa al hover.
 * Render parcial: solo el foot de cada card se actualiza en cambios de cart.
 * Animación via requestAnimationFrame en JS (no CSS) para que las flechas
 * puedan correr la posición manualmente sin pelearse con keyframes.
 ***********************/
let __ncStructureSig = ""; // signature de estructura (login + lista de NUEVOS)

const __ncAnim = {
  rafId: null,
  pos: 0, // px desplazados (siempre >= 0; se aplica como translateX(-pos))
  halfWidth: 0, // ancho de un "set" (N cards + N gaps)
  speed: 42, // px/sec
  lastTs: 0,
  paused: false, // pausa por hover/focus (temporal)
  manualMode: false, // true durante transición de flechas
  lockedByCart: false, // pausa permanente: hay items en cart → no scrollear
};

const NC_HIDDEN_KEY = "lk_nc_user_hidden";

function _ncIsUserHidden() {
  try {
    return localStorage.getItem(NC_HIDDEN_KEY) === "1";
  } catch (e) {
    return false;
  }
}

function _ncSetUserHidden(hidden) {
  try {
    if (hidden) localStorage.setItem(NC_HIDDEN_KEY, "1");
    else localStorage.removeItem(NC_HIDDEN_KEY);
  } catch (e) {}
}

function _ncHideByUser() {
  var sec = document.getElementById("newProductsCarousel");
  var showBtn = document.getElementById("ncShowBtn");
  _ncSetUserHidden(true);
  if (!sec) {
    if (showBtn) showBtn.hidden = false;
    document.documentElement.style.setProperty("--nc-carousel-h", "0px");
    return;
  }

  // Mostrar el pill INMEDIATAMENTE (no esperar a que el carrusel termine
  // de colapsar). Mientras el carrusel se encoge, el pill ya entra animado
  // → no hay momento "vacío" en la página.
  if (showBtn) {
    showBtn.classList.remove("nc-pill-in");
    void showBtn.offsetHeight;
    showBtn.hidden = false;
    showBtn.classList.add("nc-pill-in");
  }

  // Captura el alto actual y fíjalo inline para animar de N → 0
  var startH = sec.getBoundingClientRect().height;
  sec.style.maxHeight = startH + "px";
  void sec.offsetHeight; // commit del alto explícito antes de animar

  // Aplica clase (opacity/transform/etc) + animar maxHeight a 0
  requestAnimationFrame(function () {
    sec.classList.add("is-collapsing");
    sec.style.maxHeight = "0px";
  });

  var finalize = function () {
    sec.hidden = true;
    sec.classList.remove("is-collapsing");
    sec.style.maxHeight = "";
    document.documentElement.style.setProperty("--nc-carousel-h", "0px");
  };
  setTimeout(finalize, 480);
}

function _ncShowByUser() {
  _ncSetUserHidden(false);
  var showBtn = document.getElementById("ncShowBtn");
  var sec = document.getElementById("newProductsCarousel");

  // Capturar estado del pill ANTES del render — porque renderNewProductsCarousel
  // setea showBtn.hidden = true sincrónicamente y mata cualquier animación.
  var pillWasVisible = showBtn && !showBtn.hidden;
  var pillH = pillWasVisible
    ? showBtn.getBoundingClientRect().height
    : 0;

  // Pre-aplicar estado colapsado al carrusel ANTES del render
  if (sec) {
    sec.classList.add("is-collapsing");
    sec.style.maxHeight = "0px";
  }

  renderNewProductsCarousel();
  // Después del render, el pill quedó hidden=true. Lo "revivimos" para animar.
  // Como ambas operaciones (set hidden true en render + restaurar acá) son
  // sincrónicas, el browser no pinta el estado intermedio.

  if (pillWasVisible && showBtn) {
    showBtn.hidden = false;
    showBtn.classList.remove("nc-pill-in");
    showBtn.style.maxHeight = pillH + "px";
    void showBtn.offsetHeight; // commit
    requestAnimationFrame(function () {
      showBtn.classList.add("is-collapsing");
      showBtn.style.maxHeight = "0px";
    });
    setTimeout(function () {
      showBtn.hidden = true;
      showBtn.classList.remove("is-collapsing");
      showBtn.style.maxHeight = "";
    }, 480);
  }

  if (sec && !sec.hidden) {
    var targetH = sec.scrollHeight;
    void sec.offsetHeight;
    requestAnimationFrame(function () {
      sec.classList.remove("is-collapsing");
      sec.style.maxHeight = targetH + "px";
      setTimeout(function () {
        sec.style.maxHeight = "";
      }, 500);
    });
  } else if (sec) {
    sec.classList.remove("is-collapsing");
    sec.style.maxHeight = "";
  }
}

function _ncFrame(ts) {
  const s = __ncAnim;
  const dt = (ts - s.lastTs) / 1000;
  s.lastTs = ts;

  if (!s.paused && !s.manualMode && !s.lockedByCart && s.halfWidth > 0) {
    s.pos += s.speed * dt;
    if (s.pos >= s.halfWidth) s.pos -= s.halfWidth;
  }

  if (!s.manualMode) {
    const track = document.getElementById("newCarouselTrack");
    if (track) track.style.transform = `translateX(${-s.pos}px)`;
  }

  s.rafId = requestAnimationFrame(_ncFrame);
}

function _ncStartAnimation() {
  if (__ncAnim.rafId) return;
  __ncAnim.lastTs = performance.now();
  __ncAnim.rafId = requestAnimationFrame(_ncFrame);
}

function _ncRecalcHalfWidth() {
  const track = document.getElementById("newCarouselTrack");
  if (!track) return;
  const cards = track.querySelectorAll(".nc-card");
  if (cards.length === 0) {
    __ncAnim.halfWidth = 0;
    return;
  }
  const cardW = cards[0].getBoundingClientRect().width;
  const gapPx = parseFloat(getComputedStyle(track).gap) || 14;
  const setSize = cards.length / 2;
  __ncAnim.halfWidth = setSize * (cardW + gapPx);
}

function _ncShift(dir) {
  const s = __ncAnim;
  const track = document.getElementById("newCarouselTrack");
  if (!track || s.halfWidth === 0) return;
  if (s.manualMode) return; // evita double-click rápido

  const cards = track.querySelectorAll(".nc-card");
  const cardW = cards[0]?.getBoundingClientRect().width || 340;
  const gapPx = parseFloat(getComputedStyle(track).gap) || 14;
  const step = (cardW + gapPx) * 2; // mueve 2 cards por click

  let targetPos = s.pos + dir * step;
  // Normaliza a [0, halfWidth)
  targetPos = ((targetPos % s.halfWidth) + s.halfWidth) % s.halfWidth;

  s.manualMode = true;
  track.style.transition = "transform 0.45s cubic-bezier(0.4, 0, 0.2, 1)";
  track.style.transform = `translateX(${-targetPos}px)`;

  setTimeout(() => {
    track.style.transition = "";
    s.pos = targetPos;
    s.manualMode = false;
  }, 470);
}

function _ncWireControls() {
  if (window.__ncWired) return;
  const section = document.getElementById("newProductsCarousel");
  const prev = document.getElementById("ncnPrev");
  const next = document.getElementById("ncnNext");

  if (section) {
    // Pausa cuando el mouse está en cualquier parte del carrusel (incluye flechas)
    section.addEventListener("mouseenter", () => {
      __ncAnim.paused = true;
    });
    section.addEventListener("mouseleave", () => {
      __ncAnim.paused = false;
    });
    section.addEventListener("focusin", () => {
      __ncAnim.paused = true;
    });
    // focusout: SOLO unpause si ningún elemento adentro del carrusel sigue
    // recibiendo foco Y el mouse no está más arriba. Sin esto, al clickear
    // "Agregar" → foot re-renderea → botón destruido → focusout dispara y
    // unpause aunque el cursor siga sobre la card.
    section.addEventListener("focusout", () => {
      // Defer al próximo tick para dejar que focusin del nuevo elemento (si
      // lo hay) se dispare primero
      setTimeout(() => {
        if (section.contains(document.activeElement)) return;
        if (section.matches(":hover")) return;
        __ncAnim.paused = false;
      }, 0);
    });
    // Touch devices: pausar 5s al tocar (da tiempo a leer / tocar botón)
    let touchTimer = null;
    section.addEventListener(
      "touchstart",
      () => {
        __ncAnim.paused = true;
        clearTimeout(touchTimer);
        touchTimer = setTimeout(() => {
          __ncAnim.paused = false;
        }, 5000);
      },
      { passive: true },
    );
  }

  if (prev) prev.addEventListener("click", () => _ncShift(-1));
  if (next) next.addEventListener("click", () => _ncShift(1));

  // Botón cerrar (X) → oculta carrusel + persiste preferencia
  var closeBtn = document.getElementById("ncCloseBtn");
  if (closeBtn) {
    closeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      _ncHideByUser();
    });
  }

  // Botón "Mostrar novedades" → vuelve a mostrar
  var showBtn = document.getElementById("ncShowBtn");
  if (showBtn) {
    showBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      _ncShowByUser();
    });
  }

  // Recalcular halfWidth + altura del carrusel en resize Y scroll
  function _updateCarouselHVar() {
    var s = document.getElementById("newProductsCarousel");
    if (!s || s.hidden) {
      document.documentElement.style.setProperty("--nc-carousel-h", "0px");
      return;
    }
    var h = s.getBoundingClientRect().height;
    document.documentElement.style.setProperty(
      "--nc-carousel-h",
      Math.round(h) + "px",
    );
  }
  window.addEventListener("resize", function () {
    _ncRecalcHalfWidth();
    _updateCarouselHVar();
  });
  // También actualizar en scroll (la altura puede cambiar al pasar a is-stuck)
  window.addEventListener("scroll", _updateCarouselHVar, { passive: true });

  // Detectar cuando el carrusel está "pegado" al header (sticky stuck)
  // → toggleamos clase .is-stuck para aplicar top plano + fade inferior.
  var stuckRaf = null;
  function checkStuck() {
    stuckRaf = null;
    var sec = document.getElementById("newProductsCarousel");
    if (!sec || sec.hidden) return;
    var rect = sec.getBoundingClientRect();
    // 86px = altura del header fijo (mismo que el `top:` del sticky)
    sec.classList.toggle("is-stuck", rect.top <= 86);
  }
  window.addEventListener(
    "scroll",
    function () {
      if (stuckRaf) return;
      stuckRaf = requestAnimationFrame(checkStuck);
    },
    { passive: true },
  );
  // Estado inicial
  requestAnimationFrame(checkStuck);

  window.__ncWired = true;
}

function _ncBuildPriceBlock(p, logged, showListPriceOnly) {
  if (!logged) {
    return `<div class="nc-price-locked" aria-hidden="true"></div>`;
  }
  if (showListPriceOnly) {
    return `
      <div class="nc-price-label">Precio Lista</div>
      <div class="nc-price-big">$${formatMoney(getPriceForCustomer(p))} <span class="nc-iva">+ IVA</span></div>
    `;
  }
  const tuPrecioContado = precioContadoUnitario(p);
  return `
    <div class="nc-price-label">Tu precio contado</div>
    <div class="nc-price-big">$${formatMoney(tuPrecioContado)} <span class="nc-iva">+ IVA</span></div>
  `;
}

function _ncBuildFootBlock(p, logged) {
  const pid = String(p.id);
  const inCart = cart.find((i) => String(i.productId) === pid);
  const qty = inCart ? Number(inCart.qtyCajas || 0) : 0;

  if (!logged) {
    return `<button type="button" class="nc-add nc-login" onclick="openLogin()">Iniciar sesión</button>`;
  }
  if (qty <= 0) {
    return `<button type="button" class="nc-add" onclick="addFirstBox('${pid}','novedades')">Agregar</button>`;
  }
  // Stepper inline compacto — misma altura que botón Agregar para no romper layout.
  // Click − en qty=1 ⇒ removeItem (lógica en changeQty).
  return `
    <div class="nc-stepper" title="Restá hasta 0 para quitar del pedido">
      <button type="button" class="nc-step" onclick="changeQty('${pid}', -1)" aria-label="Restar">−</button>
      <input class="nc-qty" type="number" min="1" step="1" value="${qty}" inputmode="numeric" onchange="manualQty('${pid}', this.value)">
      <button type="button" class="nc-step" onclick="changeQty('${pid}', 1)" aria-label="Sumar">＋</button>
    </div>
  `;
}

function _ncBuildCardHtml(p, logged, showListPriceOnly, cloneFlag) {
  const pid = String(p.id);
  const codSafe = String(p.cod || "").trim();
  const imgSrc = primaryProductImage(p);
  const imgFallback = "img/no-image.jpg";
  const descSafe = String(p.description || "").replace(/"/g, "&quot;");

  return `
    <article class="nc-card" role="listitem" data-pid="${pid}"${cloneFlag ? ' aria-hidden="true"' : ""}>
      <div class="nc-img-wrap">
        <img
          src="${imgSrc}"
          alt="${descSafe}"
          loading="lazy"
          onerror="this.onerror=null;this.src='${imgFallback}'"
        >
      </div>
      <div class="nc-content">
        <div class="nc-badge">NUEVO</div>
        <div class="nc-body">
          <div class="nc-meta">
            <span class="nc-cod">Cod: <strong>${codSafe}</strong></span>
            <span class="nc-uxb">UxB: <strong>${p.uxb}</strong></span>
          </div>
          <div class="nc-desc" title="${descSafe}">${String(p.description || "")}</div>
        </div>
        <div class="nc-pay">
          <div class="nc-price-block">
            ${_ncBuildPriceBlock(p, logged, showListPriceOnly)}
          </div>
          <div class="nc-foot">
            ${_ncBuildFootBlock(p, logged)}
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderNewProductsCarousel() {
  const sec = document.getElementById("newProductsCarousel");
  const track = document.getElementById("newCarouselTrack");
  const showBtn = document.getElementById("ncShowBtn");
  if (!sec || !track) return;

  // Wire controls (incluye click en ncShowBtn) ANTES de early returns —
  // si no, cuando el carrusel está user-hidden no se attachea el handler
  // y el botón "Mostrar novedades" no responde.
  _ncWireControls();

  // Productos con badge NUEVO
  const news = (Array.isArray(products) ? products : []).filter(
    (p) =>
      String(p.badge_status || "").trim().toUpperCase() === "NUEVO",
  );

  // Usuario cerró el carrusel → mostrar botón "Mostrar novedades" (solo
  // si hay productos NUEVO; si no hay, ni el botón aparece).
  if (_ncIsUserHidden()) {
    sec.hidden = true;
    if (showBtn) showBtn.hidden = !news.length;
    document.documentElement.style.setProperty("--nc-carousel-h", "0px");
    return;
  }

  if (!news.length) {
    sec.hidden = true;
    if (showBtn) showBtn.hidden = true;
    track.innerHTML = "";
    __ncStructureSig = "";
    // Sin carrusel → sidebar sticky vuelve a su top original
    document.documentElement.style.setProperty("--nc-carousel-h", "0px");
    return;
  }

  // Carrusel visible → ocultar el botón "Mostrar"
  if (showBtn) showBtn.hidden = true;

  logNovedadesImpression();

  // Orden estable: ranking asc → orden_catalogo asc → cod
  news.sort((a, b) => {
    const ra = Number(a.ranking ?? 99999);
    const rb = Number(b.ranking ?? 99999);
    if (ra !== rb) return ra - rb;
    const oa = Number(a.orden_catalogo ?? 99999);
    const ob = Number(b.orden_catalogo ?? 99999);
    if (oa !== ob) return oa - ob;
    return String(a.cod || "").localeCompare(String(b.cod || ""));
  });

  sec.hidden = false;

  const logged = !!currentSession;
  const showListPriceOnly = isListPriceOnlyClient();

  // Signature: cuando cambia → full rebuild. Cart no afecta signature.
  const sig =
    (logged ? currentSession.user.id : "guest") +
    "|" +
    (showListPriceOnly ? "L" : "N") +
    "|" +
    news.map((p) => p.id).join(",");

  // Asegurar que el lock por cart NO esté activo — el carrusel solo pausa
  // por hover/focus del mouse, no porque haya items en el cart.
  __ncAnim.lockedByCart = false;

  if (sig === __ncStructureSig && track.children.length) {
    // Solo cart cambió → actualizar foot por card (sin tocar el track → no resetea anim)
    news.forEach((p) => {
      const pid = String(p.id);
      const matches = track.querySelectorAll(
        `.nc-card[data-pid="${CSS.escape(pid)}"] .nc-foot`,
      );
      const footHtml = _ncBuildFootBlock(p, logged);
      matches.forEach((foot) => {
        foot.innerHTML = footHtml;
      });
    });
    return;
  }

  // Full rebuild — duplicamos el set para que la animación translateX(-50%) loopee seamless
  __ncStructureSig = sig;

  const cardsOnce = news
    .map((p) => _ncBuildCardHtml(p, logged, showListPriceOnly, false))
    .join("");
  const cardsClone = news
    .map((p) => _ncBuildCardHtml(p, logged, showListPriceOnly, true))
    .join("");

  track.innerHTML = cardsOnce + cardsClone;

  // Reset posición y recalcular halfWidth con las cards reales
  __ncAnim.pos = 0;
  __ncAnim.manualMode = false;
  track.style.transition = "";
  track.style.transform = "translateX(0)";

  // Wire flechas / hover (idempotente)
  _ncWireControls();

  // Setear --nc-carousel-h con un fallback razonable INMEDIATAMENTE para que
  // la sidebar sticky no se solape con el carrusel en el primer frame.
  // (el rAF de abajo lo refina con el valor exacto)
  document.documentElement.style.setProperty("--nc-carousel-h", "140px");

  // Recalcular después de que el browser haya pintado las cards
  requestAnimationFrame(() => {
    _ncRecalcHalfWidth();
    // Pocos productos: pausar permanente (no anima) pero las flechas igual funcionan
    __ncAnim.paused = news.length < 3;
    _ncStartAnimation();
    // Setear altura real del carrusel para que la sidebar sticky se posicione abajo
    var h = sec.getBoundingClientRect().height;
    document.documentElement.style.setProperty(
      "--nc-carousel-h",
      Math.round(h) + "px",
    );
  });
}

/***********************
 * MOBILE FILTERS OVERLAY
 ***********************/
function openFiltersOverlay() {
  const ov = $("filtersOverlay");
  if (!ov) return;

  pendingFilterAll = filterAll;
  pendingFilterCats = new Set(filterCats);
  pendingFilterNewOnly = filterNewOnly;

  renderFiltersOverlayUI();

  ov.classList.add("open");
  ov.setAttribute("aria-hidden", "false");
}

function closeFiltersOverlay() {
  const ov = $("filtersOverlay");
  if (!ov) return;

  ov.classList.remove("open");
  ov.setAttribute("aria-hidden", "true");
}

function applyPendingFilters() {
  filterAll = !!pendingFilterAll;
  filterCats = new Set(Array.from(pendingFilterCats || []));
  filterNewOnly = !!pendingFilterNewOnly;

  // UI sync del botón NUEVOS desktop (si existe)
  const b = $("btnFilterNew");
  if (b) b.classList.toggle("on", !!filterNewOnly);

  closeFiltersOverlay();
  renderProducts();
}

function cancelPendingFilters() {
  closeFiltersOverlay();
}

// Panel FILTROS (mobile): Mi surtido + Nuevos + Ordenamiento
// (las categorías van en el panel separado renderCategoriasOverlayUI)
function renderFiltersOverlayUI() {
  const grid = $("filtersGrid");
  if (!grid) return;

  const sortActive = (mode) => sortMode === mode;

  grid.innerHTML = `
    <div class="mf-section-label">Surtido</div>
    <button type="button" class="mf-btn ${filterMyAssortment ? "on" : ""}" data-toggle="surtido">
      ★ Mi surtido
    </button>
    <button type="button" class="mf-btn mf-btn2 ${pendingFilterNewOnly ? "on" : ""}" data-new="1">
      ⚡ NUEVOS
    </button>

    <div class="mf-section-label">Ordenar por</div>
    <button type="button" class="mf-btn ${sortActive("bestsellers") ? "on" : ""}" data-sort="bestsellers">
      Más vendidos
    </button>
    <button type="button" class="mf-btn ${sortActive("price_desc") ? "on" : ""}" data-sort="price_desc">
      Mayor precio
    </button>
    <button type="button" class="mf-btn ${sortActive("price_asc") ? "on" : ""}" data-sort="price_asc">
      Menor precio
    </button>
  `;

  grid.querySelectorAll(".mf-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const isNew = btn.dataset.new === "1";
      const sortAttr = btn.dataset.sort;
      const toggleAttr = btn.dataset.toggle;

      if (isNew) {
        pendingFilterNewOnly = !pendingFilterNewOnly;
        renderFiltersOverlayUI();
        return;
      }

      if (toggleAttr === "surtido") {
        // Aplica directo (toggle global) — no necesita "Aplicar"
        filterMyAssortment = !filterMyAssortment;
        if (typeof syncMyAssortmentBtn === "function") syncMyAssortmentBtn();
        if (filterMyAssortment && !(myAssortmentIds instanceof Set)) {
          loadMyAssortmentIds().then((ids) => {
            myAssortmentIds = ids;
            renderProducts();
          });
        }
        renderFiltersOverlayUI();
        return;
      }

      if (sortAttr) {
        sortMode = sortAttr;
        if (typeof applySortUI === "function") applySortUI();
        renderFiltersOverlayUI();
        return;
      }
    });
  });
}

// Panel CATEGORÍAS (mobile): Todos los artículos + lista de categorías
function renderCategoriasOverlayUI() {
  const grid = $("categoriasGrid");
  if (!grid) return;

  const ordered = getOrderedCategoriesFrom(products);
  const isOn = (cat) => pendingFilterCats.has(cat);
  const allMedidas = getAllMedidas();
  const { featured, rest } = splitMedidas(allMedidas);

  const mfChip = (m, fire) =>
    `<button type="button" class="mf-chip ${pendingFilterMedidas.has(m) ? "on" : ""}" data-medida="${m}">${m}${fire ? " 🔥" : ""}</button>`;

  // Chips de medidas (sub-filtro de Cuadros): por defecto solo las destacadas
  // (🔥); el resto queda oculto tras un "Ver más". Si hay una medida no
  // destacada ya seleccionada, se abre solo.
  const medidasExp =
    medidasExpanded || rest.some((m) => pendingFilterMedidas.has(m));
  const medidasBlock =
    allMedidas.length > 0
      ? `<div class="mf-medidas">${featured
          .map((m) => mfChip(m, true))
          .join("")}${
          rest.length
            ? `<div class="mf-medidas-break" aria-hidden="true"></div><button type="button" class="mf-vermas" id="mfVerMas">${
                medidasExp ? "Ver menos" : "Ver más"
              }</button><div class="mf-medidas-rest" id="mfMedidasRest"${
                medidasExp ? "" : ' style="display:none"'
              }>${rest.map((m) => mfChip(m, false)).join("")}</div>`
            : ""
        }</div>`
      : "";

  grid.innerHTML = `
    <button type="button" class="mf-btn mf-btn-all ${pendingFilterAll ? "on" : ""}" data-all="1">
      Todos los artículos
    </button>
    ${ordered
      .map((cat) => {
        const btn = `
          <button type="button" class="mf-btn ${isOn(cat) ? "on" : ""}" data-cat="${cat}">
            ${cat}
          </button>
        `;
        return String(cat).trim().toLowerCase() === SUBCATEGORY_PARENT
          ? btn + medidasBlock
          : btn;
      })
      .join("")}
  `;

  grid.querySelectorAll(".mf-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const isAll = btn.dataset.all === "1";
      const cat = btn.dataset.cat;
      if (isAll) {
        pendingFilterAll = true;
        pendingFilterCats.clear();
      } else {
        pendingFilterAll = false;
        if (pendingFilterCats.has(cat)) pendingFilterCats.delete(cat);
        else pendingFilterCats.add(cat);
        if (pendingFilterCats.size === 0) pendingFilterAll = true;
      }
      pendingFilterMedidas.clear(); // elegir categoría resetea las medidas
      renderCategoriasOverlayUI();
    });
  });

  grid.querySelectorAll(".mf-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const m = chip.dataset.medida;
      if (pendingFilterMedidas.has(m)) pendingFilterMedidas.delete(m);
      else pendingFilterMedidas.add(m);
      renderCategoriasOverlayUI();
    });
  });

  const mfVerMas = $("mfVerMas");
  if (mfVerMas) {
    mfVerMas.addEventListener("click", () => {
      medidasExpanded = !medidasExpanded;
      const restEl = $("mfMedidasRest");
      if (restEl) restEl.style.display = medidasExpanded ? "" : "none";
      mfVerMas.textContent = medidasExpanded ? "Ver menos" : "Ver más";
    });
  }
}

function openCategoriasOverlay() {
  const ov = $("categoriasOverlay");
  if (!ov) return;
  pendingFilterAll = filterAll;
  pendingFilterCats = new Set(filterCats);
  pendingFilterMedidas = new Set(filterMedidas);
  renderCategoriasOverlayUI();
  ov.classList.add("open");
  ov.setAttribute("aria-hidden", "false");
}
function closeCategoriasOverlay() {
  const ov = $("categoriasOverlay");
  if (!ov) return;
  ov.classList.remove("open");
  ov.setAttribute("aria-hidden", "true");
}
function applyPendingCategorias() {
  filterAll = !!pendingFilterAll;
  filterCats = new Set(Array.from(pendingFilterCats || []));
  filterMedidas = new Set(Array.from(pendingFilterMedidas || []));
  closeCategoriasOverlay();
  renderProducts();
  if (typeof renderCategoriesSidebar === "function") renderCategoriesSidebar();
}
window.openCategoriasOverlay = openCategoriasOverlay;
window.closeCategoriasOverlay = closeCategoriasOverlay;
window.applyPendingCategorias = applyPendingCategorias;

/***********************
 * DELIVERY OPTIONS (DB)
 ***********************/
function resetShippingSelect() {
  const sel = $("shippingSelect");
  if (!sel) return;

  // Placeholder oculto del popup (no aparece como item, solo es el label
  // del trigger cuando no hay valor elegido).
  sel.innerHTML = `<option value="" selected disabled hidden>Elegir Sucursal</option>`;
  deliveryChoice = { slot: "", label: "" };
  if (typeof _csSyncPopupFromHidden === "function") _csSyncPopupFromHidden(sel);
}

async function loadDeliveryOptions(retry = 0) {
  const sel = $("shippingSelect");
  if (!sel) return;

  resetShippingSelect();

  // esperar un poco si la sesión/perfil todavía no terminó de restaurarse
  if (!currentSession || !customerProfile?.cod_cliente) {
    if (retry < 5) {
      setTimeout(() => loadDeliveryOptions(retry + 1), 400);
    }
    return;
  }

  // Si customerProfile.id no está disponible, obtenerlo
  let customerId = customerProfile.id;
  if (!customerId) {
    const { data: custData } = await supabaseClient
      .from("customers")
      .select("id")
      .eq("auth_user_id", currentSession.user.id)
      .maybeSingle();
    customerId = custData?.id;
    if (!customerId) {
      return;
    }
  }

  const { data, error } = await supabaseClient
    .from("customer_delivery_addresses")
    .select("slot,label,direccion_entrega,zona_expreso,pending_isis")
    .eq("customer_id", customerId)
    .order("slot", { ascending: true });

  if (error) {
    console.error("delivery options error:", error);
    return;
  }

  var rows = data || [];

  rows.forEach((row) => {
    const opt = document.createElement("option");
    opt.value = String(row.slot);
    const tag = row.pending_isis ? " (pendiente confirmación)" : "";
    opt.textContent = `${row.slot}: ${row.label}${tag}`;
    opt.dataset.label = row.label || "";
    opt.dataset.direccionEntrega = row.direccion_entrega || "";
    opt.dataset.zonaExpreso = row.zona_expreso || "";
    sel.appendChild(opt);
  });

  // Opción especial al final: dispara el modal de alta de sucursal.
  const optAdd = document.createElement("option");
  optAdd.value = "__add__";
  optAdd.textContent = "+ Agregar sucursal";
  sel.appendChild(optAdd);

  // Si tiene una sola sucursal, seleccionar Y AUTO-CONFIRMAR (no muestra
  // botón ni hint — no hace falta confirmar lo obvio).
  var singleAddress = rows.length === 1;
  if (singleAddress) {
    sel.value = String(rows[0].slot);
    deliveryChoice.slot = String(rows[0].slot);
    deliveryChoice.label = rows[0].label || "";
    deliveryChoice.direccionEntrega = rows[0].direccion_entrega || "";
    deliveryChoice.zonaExpreso = rows[0].zona_expreso || "";
  }

  // Botón Confirmar SOLO si hay 2+ sucursales. Con 1 sola, auto-confirma
  // y oculta botón + hint para no confundir al cliente.
  var existingBtn = document.getElementById("shipConfirmBtn");
  var shipCard = sel.closest(".ship-card");
  var hintEl = shipCard ? shipCard.querySelector(".ship-hint") : null;
  if (singleAddress) {
    if (shipCard) {
      shipCard.classList.add("auto-confirmed");
      shipCard.classList.remove("has-confirm");
    }
    if (hintEl) hintEl.style.display = "none";
    if (existingBtn) existingBtn.remove();
  } else {
    // 2+ sucursales: SIN botón Confirmar. El dropdown arranca en "Elegir…"
    // y elegir una dirección ya cuenta como confirmada (en refreshSubmitEnabled,
    // si no hay shipConfirmBtn → deliveryConfirmedByUser = true con slot elegido).
    if (shipCard) {
      shipCard.classList.remove("has-confirm");
      shipCard.classList.remove("auto-confirmed");
    }
    if (existingBtn) existingBtn.remove();
    // Hint visible hasta que se elija (se oculta en el change del shippingSelect).
    if (hintEl) hintEl.style.display = deliveryChoice.slot ? "none" : "";
  }

  // Sincronizar popup del custom dropdown con las options recién cargadas
  if (typeof _csSyncPopupFromHidden === "function") _csSyncPopupFromHidden(sel);

  updateCart();

  // Refrescar info extra del vendedor 10006 (sucursales recién cargadas).
  if (typeof updateVendor10006Info === "function") updateVendor10006Info();
}

// =============================
// Agregar sucursal nueva desde el carrito
// =============================
function abrirModalSucursal() {
  if (!currentSession || !customerProfile?.id) {
    alert("Iniciá sesión para agregar una sucursal.");
    return;
  }
  [
    "sucCalle",
    "sucAltura",
    "sucCp",
    "sucLocalidad",
    "sucExpreso",
    "sucDireccionExpreso",
    "sucObservaciones",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const dl = document.getElementById("sucExpresoList");
  if (dl) dl.innerHTML = "";
  // Precargar el catalogo de expresos en background para que la primera tipeada sea fluida.
  cargarExpresosCache();
  const prov = document.getElementById("sucProvincia");
  if (prov) prov.value = "";
  const err = document.getElementById("sucError");
  if (err) {
    err.style.display = "none";
    err.textContent = "";
  }
  const btn = document.getElementById("sucGuardarBtn");
  if (btn) {
    btn.disabled = true; // arranca deshabilitado: se habilita al completar requeridos
    btn.textContent = "Guardar sucursal";
    btn.title = "Completá los campos obligatorios (*)";
  }
  // Reset estado del expreso (se vuelve a evaluar al elegir localidad/provincia)
  actualizarExpresoSegunCABA();
  validarFormSucursal();
  const modal = document.getElementById("modalNuevaSucursal");
  if (modal) modal.classList.add("open");

  // Envolver el select Provincia con el custom dropdown CS (mismo look que
  // "Pedir para" / "Indicar Dirección"). Idempotente — _csWrapNativeSelect
  // hace early return si ya está envuelto.
  setTimeout(function () {
    var provSel = document.getElementById("sucProvincia");
    if (provSel && typeof _csWrapNativeSelect === "function") {
      _csWrapNativeSelect(provSel, {
        placeholder: "Elegir provincia",
        extraClass: "cs-dropdown-card cs-dropdown-modal",
      });
    }
  }, 50);
}

// Valida en tiempo real el formulario de nueva sucursal y habilita/deshabilita el botón.
// Requeridos: calle, altura (numérica), CP (>=4 dígitos), localidad, provincia.
// Si NO es CABA, expreso también es obligatorio (porque sin expreso no hay forma de despachar).
function validarFormSucursal() {
  const get = (id) =>
    String(document.getElementById(id)?.value || "").trim();
  const calle = get("sucCalle");
  const altura = get("sucAltura");
  const cp = get("sucCp");
  const localidad = get("sucLocalidad");
  const provincia = get("sucProvincia");
  const expreso = get("sucExpreso");

  const esCaba =
    provincia === "CABA" ||
    localidad.toLowerCase() === "caba" ||
    localidad.toLowerCase() === "capital federal" ||
    localidad.toLowerCase() === "capital";

  // Mostrar/ocultar asterisco del Expreso según CABA
  const star = document.getElementById("sucExpresoStar");
  if (star) star.style.display = esCaba ? "none" : "";

  const okCalle = calle.length >= 2;
  const okAltura = /^\d+$/.test(altura);
  const okCp = /^\d{4,10}$/.test(cp);
  const okLoc = localidad.length >= 2;
  const okProv = provincia.length > 0;
  const okExpreso = esCaba ? true : expreso.length >= 2;

  const valido = okCalle && okAltura && okCp && okLoc && okProv && okExpreso;

  const btn = document.getElementById("sucGuardarBtn");
  if (btn) {
    btn.disabled = !valido;
    btn.title = valido
      ? ""
      : "Completá los campos obligatorios (*)";
    btn.style.opacity = valido ? "" : "0.55";
    btn.style.cursor = valido ? "" : "not-allowed";
  }
  return valido;
}

// Cache en memoria de la tabla maestra "expresos" (catalogo).
// Se carga lazy la primera vez que el cliente escribe en el input.
let _expresosCache = null;
let _expresosLoading = null;

async function cargarExpresosCache() {
  if (_expresosCache) return _expresosCache;
  if (_expresosLoading) return _expresosLoading;
  _expresosLoading = (async () => {
    try {
      const { data, error } = await supabaseClient
        .from("expresos")
        .select("razon_social,domicilio,localidad,cp,provincia")
        .order("razon_social", { ascending: true });
      if (error) throw error;
      _expresosCache = data || [];
      return _expresosCache;
    } catch (e) {
      console.warn("cargarExpresosCache error:", e);
      _expresosCache = [];
      return _expresosCache;
    } finally {
      _expresosLoading = null;
    }
  })();
  return _expresosLoading;
}

// Disparado en cada keystroke del input Expreso. Si tipeo >= 2 letras,
// pobla el <datalist> con sugerencias del catalogo (case-insensitive).
async function onExpresoInput() {
  const inp = document.getElementById("sucExpreso");
  const dl = document.getElementById("sucExpresoList");
  if (!inp || !dl) return;
  const q = String(inp.value || "")
    .trim()
    .toLowerCase();
  if (q.length < 2) {
    dl.innerHTML = "";
    return;
  }
  const lista = await cargarExpresosCache();
  const matches = lista
    .filter((e) =>
      String(e.razon_social || "")
        .toLowerCase()
        .includes(q),
    )
    .slice(0, 30);
  dl.innerHTML = matches
    .map(
      (e) =>
        `<option value="${String(e.razon_social || "").replace(/"/g, "&quot;")}"></option>`,
    )
    .join("");
  // Si el cliente ya tipeo el nombre completo (match exacto), autocompletar direccion.
  autocompletarDireccionExpreso();
}

// Si el valor del input Expreso matchea un expreso del catalogo,
// autocompleta el campo "Dirección del expreso" — pero solo si esta vacio
// o tiene la direccion del match anterior (para no pisar lo que el cliente toco).
function autocompletarDireccionExpreso() {
  const inpExp = document.getElementById("sucExpreso");
  const inpDir = document.getElementById("sucDireccionExpreso");
  if (!inpExp || !inpDir) return;
  const q = String(inpExp.value || "")
    .trim()
    .toLowerCase();
  if (!q || !_expresosCache) return;
  const match = _expresosCache.find(
    (e) => String(e.razon_social || "").toLowerCase() === q,
  );
  if (!match) return;
  const partes = [
    String(match.domicilio || "").trim(),
    String(match.localidad || "").trim(),
    String(match.provincia || "").trim(),
  ].filter(Boolean);
  const direccionSugerida = partes.join(", ");
  // Sobrescribir solo si el campo esta vacio o si tiene una direccion previa
  // generada (heuristica: igual a alguna direccion del cache).
  const valorActual = String(inpDir.value || "").trim();
  const eraAutogenerada =
    !valorActual ||
    _expresosCache.some((e) => {
      const partsE = [
        String(e.domicilio || "").trim(),
        String(e.localidad || "").trim(),
        String(e.provincia || "").trim(),
      ].filter(Boolean);
      return partsE.join(", ") === valorActual;
    });
  if (eraAutogenerada) {
    inpDir.value = direccionSugerida;
  }
}

// Si la localidad o provincia es CABA, deshabilita el expreso (no aplica).
function actualizarExpresoSegunCABA() {
  const expEl = document.getElementById("sucExpreso");
  if (!expEl) return;
  const loc = String(
    document.getElementById("sucLocalidad")?.value || "",
  )
    .trim()
    .toLowerCase();
  const prov = String(
    document.getElementById("sucProvincia")?.value || "",
  ).trim();
  const esCaba =
    prov === "CABA" ||
    loc === "caba" ||
    loc === "capital federal" ||
    loc === "capital";
  const dirEl = document.getElementById("sucDireccionExpreso");
  if (esCaba) {
    expEl.value = "";
    expEl.disabled = true;
    expEl.placeholder = "No aplica para CABA";
    expEl.style.background = "#f0f0f0";
    expEl.style.color = "#999";
    if (dirEl) {
      dirEl.value = "";
      dirEl.disabled = true;
      dirEl.placeholder = "No aplica para CABA";
      dirEl.style.background = "#f0f0f0";
      dirEl.style.color = "#999";
    }
  } else {
    expEl.disabled = false;
    expEl.placeholder = "Empezá a tipear (mín. 2 letras)…";
    expEl.style.background = "";
    expEl.style.color = "";
    if (dirEl) {
      dirEl.disabled = false;
      dirEl.placeholder = "Dirección de retiro del expreso";
      dirEl.style.background = "";
      dirEl.style.color = "";
    }
  }
  // Revalidar (cambia el set de campos requeridos según CABA)
  if (typeof validarFormSucursal === "function") validarFormSucursal();
}

function cerrarModalSucursal() {
  const modal = document.getElementById("modalNuevaSucursal");
  if (modal) modal.classList.remove("open");
}

async function guardarNuevaSucursal() {
  const errEl = document.getElementById("sucError");
  const btn = document.getElementById("sucGuardarBtn");
  const setError = (msg) => {
    if (errEl) {
      errEl.textContent = msg;
      errEl.style.display = "block";
    }
  };

  if (!currentSession || !customerProfile?.id) {
    setError("Iniciá sesión nuevamente.");
    return;
  }

  const calle = String(
    document.getElementById("sucCalle")?.value || "",
  ).trim();
  const altura = String(
    document.getElementById("sucAltura")?.value || "",
  ).trim();
  const cp = String(document.getElementById("sucCp")?.value || "").trim();
  const localidad = String(
    document.getElementById("sucLocalidad")?.value || "",
  ).trim();
  const provincia = String(
    document.getElementById("sucProvincia")?.value || "",
  ).trim();
  const expreso = String(
    document.getElementById("sucExpreso")?.value || "",
  ).trim();
  const direccionExpreso = String(
    document.getElementById("sucDireccionExpreso")?.value || "",
  ).trim();
  const observaciones = String(
    document.getElementById("sucObservaciones")?.value || "",
  ).trim();

  if (!calle || calle.length < 2) return setError("Completá la calle.");
  if (!altura || !/^\d+$/.test(altura))
    return setError("La altura debe ser numérica.");
  if (!cp || !/^\d{4,10}$/.test(cp))
    return setError("El código postal debe tener al menos 4 dígitos.");
  if (!localidad || localidad.length < 2)
    return setError("Completá la localidad.");
  if (!provincia) return setError("Elegí la provincia.");

  // Expreso obligatorio fuera de CABA (sin expreso no hay forma de despachar al interior).
  const _locLower = localidad.toLowerCase();
  const esCaba =
    provincia === "CABA" ||
    _locLower === "caba" ||
    _locLower === "capital federal" ||
    _locLower === "capital";
  if (!esCaba && (!expreso || expreso.length < 2)) {
    return setError(
      "Indicá el expreso (obligatorio fuera de CABA). Si no sabés cuál, escribí el nombre o consultanos por WhatsApp.",
    );
  }

  if (errEl) errEl.style.display = "none";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Guardando…";
  }

  try {
    // Calcular siguiente slot del cliente
    const { data: existing, error: exErr } = await supabaseClient
      .from("customer_delivery_addresses")
      .select("slot")
      .eq("customer_id", customerProfile.id);
    if (exErr) throw new Error(exErr.message || "Error al leer sucursales.");
    const nextSlot =
      (existing || []).reduce(
        (m, d) => Math.max(m, Number(d.slot || 0)),
        0,
      ) + 1;

    // Label y direccion_entrega siguiendo convención de ventas
    const label = `${calle} ${altura} - ${localidad}`;
    const direccionEntrega = `${calle} ${altura}, ${localidad}, ${provincia}`;

    const payload = {
      customer_id: customerProfile.id,
      slot: nextSlot,
      label: label,
      direccion_entrega: direccionEntrega,
      zona_expreso: expreso || null,
      nombre_expreso: expreso || null,
      direccion_expreso: direccionExpreso || null,
      calle: calle,
      altura: altura,
      cp: cp,
      localidad: localidad,
      provincia: provincia,
      observaciones: observaciones || null,
      pending_isis: true,
    };

    const ins = await supabaseClient
      .from("customer_delivery_addresses")
      .insert(payload)
      .select("slot")
      .single();
    if (ins.error)
      throw new Error(ins.error.message || "Error al guardar la sucursal.");

    const newSlot = ins.data?.slot ?? nextSlot;

    // Notificar a ventas por WhatsApp (no bloqueante).
    // PK compuesta: customer_id + slot (la tabla no tiene id).
    try {
      await fetch(NOTIFY_NEW_ADDRESS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${currentSession.access_token}`,
        },
        body: JSON.stringify({
          customer_id: customerProfile.id,
          slot: newSlot,
        }),
      });
    } catch (e) {
      console.warn("notify-new-address fallo (no bloquea):", e);
    }

    // Refrescar lista del select y seleccionar la nueva
    await loadDeliveryOptions();
    const sel = $("shippingSelect");
    if (sel && newSlot != null) {
      sel.value = String(newSlot);
      if (typeof _csRefreshDropdownVisual === "function") _csRefreshDropdownVisual(sel);
      const opt = sel.options[sel.selectedIndex];
      deliveryChoice = {
        slot: String(newSlot),
        label: opt?.dataset.label || label,
        direccionEntrega: opt?.dataset.direccionEntrega || direccionEntrega,
        zonaExpreso: opt?.dataset.zonaExpreso || expreso,
      };
      refreshSubmitEnabled();
    }

    cerrarModalSucursal();
    alert("Sucursal agregada. Queda pendiente de confirmación.");
  } catch (e) {
    console.error("guardarNuevaSucursal error:", e);
    setError("Error: " + (e.message || e));
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Guardar sucursal";
    }
  }
}

// =============================
// UX: fly-to-cart + toast "Ver pedido"
// =============================
let __viewOrderShowTimer = null;
let __viewOrderHideTimer = null;

function getVisibleCartIconEl() {
  // Desktop icon
  const desktop = document.getElementById("cartIcon");
  if (desktop && desktop.offsetParent !== null) return desktop;

  // Mobile icon (dentro del botón)
  const mobileBtn = document.getElementById("mobileCartBtn");
  if (mobileBtn && mobileBtn.offsetParent !== null) {
    const img = mobileBtn.querySelector("img");
    return img || mobileBtn;
  }

  // fallback: link del carrito
  const link = document.getElementById("cartLink");
  if (link && link.offsetParent !== null) return link;

  return null;
}

function flyProductImageToCart(productId) {
  // Catálogo principal usa id="img-<pid>". Loke no — fallback: <img> dentro de la card.
  let img = document.getElementById(`img-${productId}`);
  if (!img) {
    const card =
      document.getElementById(`card-${productId}`) ||
      document.getElementById(`loke-card-${productId}`);
    if (card) img = card.querySelector("img");
  }
  const target = getVisibleCartIconEl();
  if (!img || !target) return;

  const r1 = img.getBoundingClientRect();
  const r2 = target.getBoundingClientRect();
  if (!r1.width || !r1.height || !r2.width || !r2.height) return;

  const clone = img.cloneNode(true);
  clone.className = "fly-to-cart";
  clone.style.left = `${r1.left}px`;
  clone.style.top = `${r1.top}px`;
  clone.style.width = `${r1.width}px`;
  clone.style.height = `${r1.height}px`;
  clone.style.opacity = "1";
  clone.style.transform = "translate3d(0,0,0) scale(1)";

  document.body.appendChild(clone);

  const dx = r2.left + r2.width / 2 - (r1.left + r1.width / 2);
  const dy = r2.top + r2.height / 2 - (r1.top + r1.height / 2);

  // start anim next frame
  requestAnimationFrame(() => {
    clone.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(0.15)`;
    clone.style.opacity = "0";
  });

  clone.addEventListener("transitionend", () => clone.remove(), { once: true });
}

// Helper: dispara las 3 animaciones add-to-cart juntas.
// Llamar SIEMPRE después de renderProducts()/renderLokeProducts() para que
// las clases se apliquen al DOM ya re-renderizado.
function triggerAddAnimations(productId) {
  requestAnimationFrame(() => {
    // 1) imagen vuela al carrito
    flyProductImageToCart(productId);

    // 2) bump de la card
    const card =
      document.getElementById(`card-${productId}`) ||
      document.getElementById(`loke-card-${productId}`);
    if (card) {
      card.classList.remove("lk-bump");
      void card.offsetWidth; // reflow → re-dispara animación si se clickea rápido
      card.classList.add("lk-bump");
    }

    // 3) pop del input de cantidad
    if (card) {
      const qtyInput = card.querySelector(".step-input");
      if (qtyInput) {
        qtyInput.classList.remove("lk-pop");
        void qtyInput.offsetWidth;
        qtyInput.classList.add("lk-pop");
      }

      // 3b) celebración en la imagen: bounce + wobble + pulse combinados
      const img = card.querySelector("img");
      if (img) {
        img.classList.remove("lk-celebrate");
        void img.offsetWidth;
        img.classList.add("lk-celebrate");
      }
    }

    // 4) shake del ícono del carrito cuando "llega" el vuelo
    setTimeout(() => {
      const target = getVisibleCartIconEl();
      if (!target) return;
      target.classList.remove("lk-cart-shake");
      void target.offsetWidth;
      target.classList.add("lk-cart-shake");
    }, 480);
  });
}

function hideViewOrderToast() {
  const t = document.getElementById("viewOrderToast");
  if (!t) return;
  t.classList.remove("show");
  t.setAttribute("aria-hidden", "true");
}

function positionViewOrderToastBelowHeader() {
  const header =
    document.querySelector("header") || document.querySelector(".header");
  const toast = document.getElementById("viewOrderToast");
  if (!header || !toast) return;

  const headerRect = header.getBoundingClientRect();
  const offset = Math.max(0, headerRect.bottom + 10); // 10px de aire

  toast.style.top = `${offset}px`;
}

function showViewOrderToast() {
  const t = document.getElementById("viewOrderToast");
  if (!t) return;

  positionViewOrderToastBelowHeader();

  t.classList.add("show");
  t.setAttribute("aria-hidden", "false");
}

function scheduleViewOrderToastAfterAdd() {
  // no acumulativo: si agregás otra vez, resetea el “3s visible”
  clearTimeout(__viewOrderShowTimer);
  clearTimeout(__viewOrderHideTimer);

  // aparece rápido (80ms) para que se sienta “instantáneo”
  __viewOrderShowTimer = setTimeout(() => {
    showViewOrderToast();

    // y se oculta 3s después de aparecer
    clearTimeout(__viewOrderHideTimer);
    __viewOrderHideTimer = setTimeout(() => hideViewOrderToast(), 3000);
  }, 80);
}

/***********************
 * CART
 ***********************/
// ==============================
// CART (persistencia entre páginas)
// ==============================
const CART_LS_KEY = "lk_mayorista_cart_v1";

function loadCartFromLS() {
  try {
    const raw = localStorage.getItem(CART_LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // normaliza
    return arr
      .map((x) => ({
        productId: String(x.productId),
        qtyCajas: Math.max(1, parseInt(x.qtyCajas, 10) || 1),
        isUpsellPromo: !!x.isUpsellPromo,
        source: x.source || "catalogo",
      }))
      .filter((x) => x.productId);
  } catch {
    return [];
  }
}

(function hydrateCartFromLS() {
  const savedCart = loadCartFromLS();
  cart.splice(0, cart.length, ...savedCart);
  // Restaurar modo edición tras recargar la página: si el carrito guardado
  // pertenecía a un pedido en edición, recuperamos editingOrderId para que
  // vuelva a aparecer el cartel amarillo (y submitOrder edite, no cree nuevo).
  try {
    const savedEditing = localStorage.getItem(EDITING_LS_KEY);
    if (savedEditing && savedCart.length) {
      editingOrderId = String(savedEditing);
    } else if (!savedCart.length) {
      // Carrito vacío → no tiene sentido conservar el flag.
      localStorage.removeItem(EDITING_LS_KEY);
    }
  } catch (e) {}
})();

function saveCartToLS() {
  try {
    // guardamos SOLO lo mínimo
    const payload = cart.map((x) => ({
      productId: String(x.productId),
      qtyCajas: Math.max(1, parseInt(x.qtyCajas, 10) || 1),
      isUpsellPromo: !!x.isUpsellPromo,
      source: x.source || "catalogo",
    }));
    localStorage.setItem(CART_LS_KEY, JSON.stringify(payload));
  } catch {}
}

function normalizeCartAgainstProducts() {
  if (!Array.isArray(products) || !products.length) return;

  const validIds = new Set(products.map((p) => String(p.id)));
  (lokeProducts || []).forEach((p) => validIds.add(String(p.id)));
  const cleaned = cart.filter((item) => validIds.has(String(item.productId)));

  if (cleaned.length !== cart.length) {
    cart.splice(0, cart.length, ...cleaned);
    saveCartToLS();
  }
}

/***********************
 * SAVED CARTS (Pedidos sin Confirmar)
 * Drafts de carrito persistidos en DB.
 * - Un solo draft activo por cliente (UNIQUE customer_id -> upsert).
 * - RLS gatea acceso: cliente dueño / vendedor vinculado / admin.
 ***********************/

async function openSaveDraftModal() {
  if (!currentSession) {
    openLogin();
    return;
  }
  var _csv1 = document.getElementById("customerSelect")?.value || "";
  if (
    isVendorProfile() &&
    (!_csv1 || _csv1 === VENDOR_SELF_VALUE)
  ) {
    alert("Elegí una razón social antes de guardar el pedido.");
    return;
  }
  if (!customerProfile?.id) {
    alert("No se encontró el perfil del cliente.");
    return;
  }
  if (!cart.length) {
    alert("El carrito está vacío.");
    return;
  }

  const modal = document.getElementById("saveDraftModal");
  if (!modal) return;
  const nameInput = document.getElementById("draftNameInput");
  const notesInput = document.getElementById("draftNotesInput");
  const clearChk = document.getElementById("draftClearAfter");
  const status = document.getElementById("saveDraftStatus");
  const hint = document.getElementById("saveDraftHint");
  const btnConfirm = document.getElementById("btnSaveDraftConfirm");
  const capList = document.getElementById("saveDraftCapList");

  if (nameInput) nameInput.value = "";
  if (notesInput) notesInput.value = "";
  if (clearChk) clearChk.checked = false;
  if (status) {
    status.textContent = "";
    status.className = "profile-status";
  }
  if (hint) {
    hint.textContent = "";
    hint.style.color = "#666";
    hint.style.fontWeight = "normal";
  }
  if (capList) {
    capList.style.display = "none";
    capList.innerHTML = "";
  }
  if (btnConfirm) {
    btnConfirm.textContent = "Guardar pedido sin enviar";
    btnConfirm.disabled = false;
  }

  modal.classList.add("open");
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");

  await refreshSaveDraftModalState();
}

// Recalcula hint / lista inline / estado del botón según drafts actuales del cliente
async function refreshSaveDraftModalState() {
  const nameInput = document.getElementById("draftNameInput");
  const hint = document.getElementById("saveDraftHint");
  const btnConfirm = document.getElementById("btnSaveDraftConfirm");
  const capList = document.getElementById("saveDraftCapList");

  try {
    if (window.__activeDraftId) {
      const { data } = await supabaseClient
        .from("saved_carts")
        .select("name")
        .eq("id", window.__activeDraftId)
        .maybeSingle();
      const nm = data && data.name ? data.name : "el pedido guardado";
      if (hint) {
        hint.textContent = "Vas a actualizar: " + nm;
        hint.style.color = "#666";
        hint.style.fontWeight = "normal";
      }
      if (btnConfirm) {
        btnConfirm.textContent = "Actualizar pedido";
        btnConfirm.disabled = false;
      }
      if (nameInput && data && data.name && !nameInput.value)
        nameInput.value = data.name;
      if (capList) {
        capList.style.display = "none";
        capList.innerHTML = "";
      }
      return;
    }

    const { data: drafts, error } = await supabaseClient
      .from("saved_carts")
      .select("id, name, item_count, updated_at")
      .eq("customer_id", customerProfile.id)
      .order("updated_at", { ascending: false });

    if (error) throw error;
    const used = (drafts || []).length;

    if (used >= 3) {
      if (hint) {
        hint.textContent =
          "Llegaste al tope: 3 pedidos sin confirmar. Eliminá uno para poder guardar este.";
        hint.style.color = "#b00020";
        hint.style.fontWeight = "600";
      }
      if (btnConfirm) {
        btnConfirm.textContent = "Guardar pedido sin enviar (3/3)";
        btnConfirm.disabled = true;
      }
      if (capList) {
        const escape = (s) =>
          String(s || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
        capList.style.display = "block";
        capList.innerHTML =
          '<div style="font-size:12px;font-weight:600;margin-bottom:6px;">Tus pedidos sin confirmar:</div>' +
          (drafts || [])
            .map((d) => {
              const title = escape(d.name || "Pedido guardado");
              const fecha = d.updated_at
                ? new Date(d.updated_at).toLocaleString("es-AR")
                : "";
              const count = Number(d.item_count || 0);
              return (
                "" +
                '<div style="display:flex;gap:8px;justify-content:space-between;align-items:center;border:1px solid #eee;border-radius:8px;padding:8px 10px;margin-bottom:6px;">' +
                '<div style="flex:1 1 auto;min-width:0;">' +
                '<div style="font-weight:600;font-size:13px;">' +
                title +
                "</div>" +
                '<div style="color:#666;font-size:11px;">' +
                count +
                " item" +
                (count === 1 ? "" : "s") +
                " · " +
                fecha +
                "</div>" +
                "</div>" +
                '<button type="button" class="profile-btn danger" ' +
                'style="padding:6px 10px;font-size:12px;" ' +
                "onclick=\"deleteDraftFromModal('" +
                escape(d.id) +
                "')\">Eliminar</button>" +
                "</div>"
              );
            })
            .join("");
      }
    } else {
      if (hint) {
        hint.textContent = "Tenés " + used + " de 3 pedidos sin confirmar.";
        hint.style.color = "#666";
        hint.style.fontWeight = "normal";
      }
      if (btnConfirm) {
        btnConfirm.textContent = "Guardar pedido sin enviar";
        btnConfirm.disabled = false;
      }
      if (capList) {
        capList.style.display = "none";
        capList.innerHTML = "";
      }
    }
  } catch (e) {
    console.warn("refreshSaveDraftModalState error:", e);
  }
}

// Delete desde dentro del modal: borra y recalcula estado inline (no cierra el modal)
async function deleteDraftFromModal(draftId) {
  if (!draftId) return;
  if (!confirm("¿Eliminar este pedido sin confirmar?")) return;

  try {
    const { error } = await supabaseClient
      .from("saved_carts")
      .delete()
      .eq("id", draftId);

    if (error) throw error;

    if (window.__activeDraftId === draftId) {
      window.__activeDraftId = null;
    }
    // Refrescar la card del perfil en paralelo + el estado del modal
    loadDraftCarts();
    await refreshSaveDraftModalState();
  } catch (err) {
    console.error("deleteDraftFromModal error:", err);
    alert("No se pudo eliminar: " + (err.message || String(err)));
  }
}

function closeSaveDraftModal() {
  const modal = document.getElementById("saveDraftModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

async function saveCart() {
  const status = document.getElementById("saveDraftStatus");
  const setStatus = (msg, cls) => {
    if (!status) return;
    status.textContent = msg || "";
    status.className = "profile-status" + (cls ? " " + cls : "");
  };
  const btn = document.getElementById("btnSaveDraftConfirm");

  try {
    if (!currentSession) {
      openLogin();
      return;
    }
    if (!customerProfile?.id) {
      setStatus("No hay cliente seleccionado.", "err");
      return;
    }
    if (!cart.length) {
      setStatus("El carrito está vacío.", "err");
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = "Guardando…";
    }
    setStatus("Guardando…");

    const name = String(
      document.getElementById("draftNameInput")?.value || "",
    ).trim();
    const notes = String(
      document.getElementById("draftNotesInput")?.value || "",
    ).trim();
    const clearAfter = !!document.getElementById("draftClearAfter")?.checked;
    const paySel = document.getElementById("paymentSelect");
    const paymentMethod = paySel ? String(paySel.value || "") : "";

    const items = cart.map((x) => ({
      productId: String(x.productId),
      qtyCajas: Math.max(1, parseInt(x.qtyCajas, 10) || 1),
      isUpsellPromo: !!x.isUpsellPromo,
      source: x.source || "catalogo",
    }));

    const basePayload = {
      name: name || null,
      notes: notes || null,
      payment_method: paymentMethod || null,
      delivery_slot: deliveryChoice?.slot || null,
      delivery_label: deliveryChoice?.label || null,
      items: items,
      updated_at: new Date().toISOString(),
    };

    if (window.__activeDraftId) {
      // UPDATE: venía de un draft cargado → actualizar ese mismo registro
      const { error } = await supabaseClient
        .from("saved_carts")
        .update(basePayload)
        .eq("id", window.__activeDraftId);

      if (error) throw error;
      setStatus("Pedido actualizado.", "ok");
    } else {
      // INSERT: pre-check del tope 3 por cliente
      const { count, error: countErr } = await supabaseClient
        .from("saved_carts")
        .select("id", { count: "exact", head: true })
        .eq("customer_id", customerProfile.id);

      if (countErr) throw countErr;

      if ((count || 0) >= 3) {
        setStatus(
          "Ya tenés 3 pedidos sin confirmar. Eliminá uno antes de guardar otro.",
          "err",
        );
        return;
      }

      const insertPayload = Object.assign({}, basePayload, {
        customer_id: customerProfile.id,
        created_by_auth_user_id: currentSession?.user?.id || null,
      });

      const { error } = await supabaseClient
        .from("saved_carts")
        .insert(insertPayload);

      if (error) throw error;

      // NO marcamos este draft como activo: cada "Guardar" sin un draft cargado
      // crea un registro nuevo. Para actualizar uno existente, el usuario debe
      // cargarlo primero desde "Pedidos sin Confirmar".
      setStatus("Pedido guardado.", "ok");
    }

    if (clearAfter) {
      cart.splice(0, cart.length);
      saveCartToLS();
      updateCart();
      renderProducts();
    }

    // Refrescar la card del perfil si está montada
    loadDraftCarts();

    setTimeout(closeSaveDraftModal, 700);
  } catch (err) {
    console.error("saveCart error:", err);
    setStatus(
      "No se pudo guardar el pedido: " + (err.message || String(err)),
      "err",
    );
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Guardar pedido sin enviar";
    }
  }
}

async function loadDraftCarts() {
  const box = document.getElementById("draftCartsBox");
  if (!box) return;

  if (!currentSession || !customerProfile?.id) {
    box.innerHTML = "Iniciá sesión para ver tus pedidos sin confirmar.";
    return;
  }

  box.innerHTML = "Cargando…";

  // Vendedor en perfil propio → traer drafts de TODOS los clientes vinculados
  // Cliente (o vendedor actuando como cliente) → solo drafts del customerProfile activo
  const vendorOwnMode = isVendorOwnMode();
  const customerIds = vendorOwnMode
    ? (linkedCustomers || []).map(function (c) {
        return c.customer_id;
      })
    : [customerProfile.id];

  if (vendorOwnMode && !customerIds.length) {
    box.innerHTML =
      '<div class="draft-empty" style="color:#666;">No hay clientes vinculados.</div>';
    return;
  }

  // Mapa para resolver nombre por customer_id (vendor mode)
  const custInfo = {};
  (linkedCustomers || []).forEach(function (c) {
    custInfo[c.customer_id] = {
      business_name: c.business_name || "",
      cod_cliente: c.cod_cliente || "",
    };
  });

  try {
    const { data, error } = await supabaseClient
      .from("saved_carts")
      .select(
        "id, customer_id, name, notes, item_count, created_at, updated_at, payment_method, delivery_label",
      )
      .in("customer_id", customerIds)
      .order("updated_at", { ascending: false });

    if (error) throw error;

    const rows = data || [];
    if (!rows.length) {
      const emptyMsg = vendorOwnMode
        ? "Ninguno de tus clientes tiene pedidos sin confirmar."
        : "Cuando guardes un pedido aparecerá acá.";
      const emptyTitle = vendorOwnMode
        ? "Sin pedidos pendientes"
        : "Nada sin confirmar";
      box.innerHTML = `
        <div class="empty-state-mini">
          <svg class="empty-state-mini-face" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <!-- Disquete (icono universal de "guardar") -->
            <path d="M26 22 L82 22 L98 38 L98 98 Q98 102 94 102 L26 102 Q22 102 22 98 L22 26 Q22 22 26 22 Z"
                  fill="none" stroke="#222" stroke-width="6" stroke-linejoin="round"/>
            <!-- Etiqueta superior (parte que se escribía) -->
            <rect x="36" y="22" width="40" height="22" fill="#222"/>
            <!-- Ventanita de la etiqueta -->
            <rect x="62" y="26" width="10" height="14" fill="#fff"/>
            <!-- Recuadro inferior (área de "datos") -->
            <rect x="34" y="62" width="52" height="32" rx="2" fill="none" stroke="#222" stroke-width="5"/>
            <line x1="44" y1="74" x2="76" y2="74" stroke="#222" stroke-width="4" stroke-linecap="round"/>
            <line x1="44" y1="84" x2="68" y2="84" stroke="#222" stroke-width="4" stroke-linecap="round"/>
          </svg>
          <div class="empty-state-mini-text">
            <strong>${emptyTitle}</strong>
            <span>${emptyMsg}</span>
          </div>
        </div>
      `;
      return;
    }

    const escape = (s) =>
      String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    // Helper: tiempo relativo (ej "hace 5 min", "hace 2 h", "ayer", o fecha completa)
    const formatRelative = (d) => {
      if (!d) return "";
      const dt = new Date(d);
      const diff = (Date.now() - dt.getTime()) / 1000; // sec
      if (diff < 60) return "hace unos segundos";
      if (diff < 3600) return "hace " + Math.floor(diff / 60) + " min";
      if (diff < 86400) return "hace " + Math.floor(diff / 3600) + " h";
      if (diff < 172800) return "ayer";
      if (diff < 604800) return "hace " + Math.floor(diff / 86400) + " días";
      return dt.toLocaleDateString("es-AR", { day: "2-digit", month: "short" });
    };

    box.innerHTML = rows
      .map((r) => {
        const title = escape(r.name || "Pedido guardado");
        const fechaRel = formatRelative(r.updated_at);
        const fechaFull = r.updated_at
          ? new Date(r.updated_at).toLocaleString("es-AR")
          : "";
        const notesHtml = r.notes
          ? '<div class="draft-notes">' + escape(r.notes) + "</div>"
          : "";
        const count = Number(r.item_count || 0);
        const ci = vendorOwnMode ? custInfo[r.customer_id] || {} : null;
        const clientHtml =
          vendorOwnMode && ci
            ? '<div class="draft-client">' +
              escape(ci.business_name || "Cliente") +
              (ci.cod_cliente ? ' <span class="draft-client-cod">' + escape(ci.cod_cliente) + "</span>" : "") +
              "</div>"
            : "";
        return (
          '<div class="draft-row" data-draft-id="' + escape(r.id) + '">' +
          '<div class="draft-icon" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>' +
          '<polyline points="17 21 17 13 7 13 7 21"/>' +
          '<polyline points="7 3 7 8 15 8"/>' +
          "</svg>" +
          "</div>" +
          '<div class="draft-info">' +
          clientHtml +
          '<div class="draft-title">' + title + "</div>" +
          '<div class="draft-meta">' +
          '<span class="draft-count">' + count + " item" + (count === 1 ? "" : "s") + "</span>" +
          '<span class="draft-dot">·</span>' +
          '<span class="draft-time" title="' + escape(fechaFull) + '">' + fechaRel + "</span>" +
          "</div>" +
          notesHtml +
          "</div>" +
          '<div class="draft-actions">' +
          '<button type="button" class="draft-btn draft-btn-load" onclick="loadDraftIntoCart(\'' + escape(r.id) + '\')">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/></svg>' +
          'Cargar al carrito</button>' +
          '<button type="button" class="draft-btn draft-btn-del" onclick="deleteDraftCart(\'' + escape(r.id) + '\')" aria-label="Eliminar pedido guardado">' +
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
          "</button>" +
          "</div>" +
          "</div>"
        );
      })
      .join("");
  } catch (err) {
    console.error("loadDraftCarts error:", err);
    box.innerHTML = "No se pudieron cargar los pedidos guardados.";
  }
}

async function loadDraftIntoCart(draftId) {
  if (!draftId) return;
  try {
    const { data, error } = await supabaseClient
      .from("saved_carts")
      .select(
        "id, customer_id, items, payment_method, delivery_slot, delivery_label",
      )
      .eq("id", draftId)
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      alert("Ese pedido ya no existe.");
      return;
    }

    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
      alert("Ese pedido guardado no tiene items.");
      return;
    }

    if (
      cart.length > 0 &&
      !confirm(
        "Tu carrito actual se reemplazará por el pedido guardado. ¿Continuar?",
      )
    ) {
      return;
    }

    // Si el draft pertenece a otro cliente vinculado (vendedor cargando un draft
    // de su cartera), conmutar al perfil de ese cliente primero
    if (
      data.customer_id &&
      String(data.customer_id) !== String(customerProfile?.id) &&
      (linkedCustomers || []).some(function (c) {
        return String(c.customer_id) === String(data.customer_id);
      })
    ) {
      _csSetValue("customerSelect", data.customer_id);
      _csSetValue("customerSelectCart", data.customer_id);
      if (typeof onLinkedCustomerSelected === "function") {
        await onLinkedCustomerSelected();
      }
    }

    // Reemplazar carrito
    cart.splice(0, cart.length);
    items.forEach((it) => {
      const pid = String(it.productId || it.product_id || "");
      const qty = Math.max(
        1,
        Math.round(Number(it.qtyCajas || it.qty_cajas || 0)),
      );
      if (!pid || !qty) return;
      cart.push({
        productId: pid,
        qtyCajas: qty,
        isUpsellPromo: !!it.isUpsellPromo,
        source: it.source || "catalogo",
      });
    });
    saveCartToLS();

    // Limpiar productos discontinuados (si products ya cargó)
    const beforeCount = cart.length;
    normalizeCartAgainstProducts();
    const removed = beforeCount - cart.length;

    // Restaurar método de pago y sucursal si todavía están disponibles
    if (data.payment_method) {
      const paySel = document.getElementById("paymentSelect");
      if (
        paySel &&
        Array.from(paySel.options).some((o) => o.value === data.payment_method)
      ) {
        paySel.value = data.payment_method;
      }
    }
    if (data.delivery_slot) {
      deliveryChoice = {
        slot: data.delivery_slot,
        label: data.delivery_label || "",
      };
      const shipSel = document.getElementById("shippingSelect");
      if (
        shipSel &&
        Array.from(shipSel.options).some((o) => o.value === data.delivery_slot)
      ) {
        shipSel.value = data.delivery_slot;
        if (typeof _csRefreshDropdownVisual === "function") _csRefreshDropdownVisual(shipSel);
      }
    }

    // Recordar id del draft: al confirmar el pedido se borra automáticamente
    window.__activeDraftId = data.id;

    updateCart();
    renderProducts();
    if (typeof syncPaymentButtons === "function") syncPaymentButtons();
    if (typeof refreshSubmitEnabled === "function") refreshSubmitEnabled();

    showSection("carrito");
    window.scrollTo({ top: 0, behavior: "smooth" });

    if (removed > 0) {
      setTimeout(() => {
        alert(
          "Pedido cargado. " +
            removed +
            " producto" +
            (removed === 1 ? "" : "s") +
            " ya no están disponibles y se omitieron.",
        );
      }, 100);
    }
  } catch (err) {
    console.error("loadDraftIntoCart error:", err);
    alert("No se pudo cargar el pedido guardado.");
  }
}

async function deleteDraftCart(draftId) {
  if (!draftId) return;
  if (!confirm("¿Eliminar este pedido sin confirmar?")) return;

  try {
    const { error } = await supabaseClient
      .from("saved_carts")
      .delete()
      .eq("id", draftId);

    if (error) throw error;

    if (window.__activeDraftId === draftId) {
      window.__activeDraftId = null;
    }
    loadDraftCarts();
  } catch (err) {
    console.error("deleteDraftCart error:", err);
    alert("No se pudo eliminar: " + (err.message || String(err)));
  }
}

function openDraftsFromMenu() {
  // Abre perfil y hace scroll hasta la card de drafts
  openProfile();
  loadDraftCarts();
  setTimeout(() => {
    const el = document.getElementById("draftCartsBox");
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, 250);
}

// Registra una única vez por sesión (mientras no se recargue la página) que
// el carrusel de Novedades se mostró con al menos un producto — permite
// calcular tasa de conversión vistas → agregados en el panel admin.
var _novedadesImpressionLogged = false;
function logNovedadesImpression() {
  if (_novedadesImpressionLogged) return;
  _novedadesImpressionLogged = true;
  try {
    if (!currentSession || !supabaseClient) return;
    supabaseClient
      .from("novedades_impressions")
      .insert({
        customer_id: customerProfile?.id || null,
        auth_user_id: currentSession.user.id,
      })
      .then(function () {});
  } catch (e) {
    // no-op
  }
}

// Registra en background un click de "agregar", etiquetado por módulo de
// origen (catalogo / novedades / surtido_faltante / upsell_popup / loke /
// sugerencia_vendedor / historial). No bloquea la UI ni rompe el flujo si
// falla (ej. la tabla todavía no existe en Supabase).
function logCartAddEvent(productId, source) {
  try {
    if (!currentSession || !supabaseClient) return;
    supabaseClient
      .from("cart_add_events")
      .insert({
        customer_id: customerProfile?.id || null,
        auth_user_id: currentSession.user.id,
        product_id: productId,
        source: source || "catalogo",
      })
      .then(function () {});
  } catch (e) {
    // no-op: analytics nunca debe romper el flujo de compra
  }
}

function addFirstBox(productId, source) {
  if (!currentSession) {
    openLogin();
    return;
  }

  // Guard: vendor en browse mode (sin cliente seleccionado o "Perfil Vendedor")
  // → no puede comprar a su nombre, redirigir al selector
  if (
    typeof isVendorProfileBrowseMode === "function" &&
    isVendorProfileBrowseMode()
  ) {
    if (typeof scrollToCustomerSelector === "function") {
      scrollToCustomerSelector();
    }
    return;
  }

  // Guard: no permitir agregar productos PROXIMAMENTE / SIN STOCK
  // (botones inline ya están disabled, esto cubre cualquier path adicional)
  const product = (products || []).find(
    (p) => String(p.id) === String(productId),
  );
  if (product) {
    const status = String(product.badge_status || "")
      .trim()
      .toUpperCase();
    if (
      status === "SIN STOCK" ||
      status === "PROXIMAMENTE" ||
      status === "PRÓXIMAMENTE"
    ) {
      return;
    }
  }

  const existing = cart.find((i) => i.productId === productId);

  if (existing) {
    existing.qtyCajas += 1;
  } else {
    cart.push({ productId, qtyCajas: 1, source: source || "catalogo" });
    toggleControls(productId, true);
    logCartAddEvent(productId, source || "catalogo");
  }

  // ✅ Toast: 3s después del último “agregar” (no acumulativo)
  scheduleViewOrderToastAfterAdd();

  updateCart();
  refreshSubmitEnabled();
  renderProducts();

  // 🎬 Animaciones: vuela al carrito + bump card + pop qty + shake ícono (siempre)
  triggerAddAnimations(productId);
}

function changeQty(productId, delta) {
  const item = cart.find((i) => i.productId === productId);
  if (!item) return;

  item.qtyCajas += delta;

  if (item.qtyCajas <= 0) {
    removeItem(productId);
    return;
  }

  const input = document.querySelector(`#qty-${CSS.escape(productId)} input`);
  if (input) input.value = item.qtyCajas;

  updateCart();
  renderProducts();

  // 🎬 Solo al SUMAR (no al restar) — cubre +/+5 del catálogo y de Loke
  if (delta > 0) triggerAddAnimations(productId);
}

function manualQty(productId, value) {
  const qty = Math.max(0, parseInt(value, 10) || 0);

  const item = cart.find((i) => i.productId === productId);
  if (!item) return;

  if (qty <= 0) {
    removeItem(productId);
    return;
  }

  item.qtyCajas = qty;
  updateCart();
  renderProducts();
}

function removeItem(productId) {
  const idx = cart.findIndex((i) => i.productId === productId);
  if (idx >= 0) cart.splice(idx, 1);

  toggleControls(productId, false);
  updateCart();
  renderProducts();
}

function toggleControls(productId, show) {
  const addBtn = $(`add-${productId}`);
  const qtyWrap = $(`qty-${productId}`);

  if (addBtn) addBtn.style.display = show ? "none" : "inline-block";
  if (qtyWrap) qtyWrap.style.display = show ? "block" : "none";
}

function calcTotals() {
  const logged = !!currentSession;
  const paymentDiscount = getPaymentDiscount();
  const webDiscountRate = isAdmin ? 0 : WEB_ORDER_DISCOUNT;

  let subtotal = 0;

  if (logged) {
    cart.forEach((item) => {
      const p = findAnyProduct(item.productId);
      if (!p) return;

      const totalUni = item.qtyCajas * Number(p.uxb || 0);
      const loke = isLokeItem(item.productId);
      subtotal += loke
        ? Number(getPriceForCustomer(p) || 0) * totalUni
        : unitYourPrice(getPriceForCustomer(p)) * totalUni;
    });
  }

  let totalNoDiscount = 0;
  cart.forEach((item) => {
    const p = findAnyProduct(item.productId);
    if (!p) return;

    const totalUni = item.qtyCajas * Number(p.uxb || 0);
    totalNoDiscount += Number(getPriceForCustomer(p) || 0) * totalUni;
  });

  const webDiscountValue = subtotal * webDiscountRate;
  const afterWeb = subtotal - webDiscountValue;

  const paymentDiscountValue = afterWeb * paymentDiscount;
  const finalTotal = afterWeb - paymentDiscountValue;

  const totalDiscounts = Math.max(0, totalNoDiscount - finalTotal);

  return {
    logged,
    paymentDiscount,
    webDiscountRate,
    subtotal,
    totalNoDiscount,
    webDiscountValue,
    paymentDiscountValue,
    finalTotal,
    totalDiscounts,
  };
}

function updateCart() {
  const cartDiv = $("cart");
  if (!cartDiv) return;

  // EXPO: dto por escala segun subtotal de lista, antes de calcular totales.
  _expoSyncDto();
  _expoUpdateChip();

  // Escala activa: forzar contado en cada render del carrito.
  if (_escalaActiva) _escalaForceContadoUI();

  const submitBtn = document.getElementById("submitOrderBtn");
  const shippingSelectEl = document.getElementById("shippingSelect");

  if (shippingSelectEl && shippingSelectEl.value && !deliveryChoice.slot) {
    const opt = shippingSelectEl.options[shippingSelectEl.selectedIndex];
    deliveryChoice.slot = shippingSelectEl.value || "";
    deliveryChoice.label = opt?.dataset?.label || opt?.textContent || "";
    deliveryChoice.direccionEntrega = opt?.dataset?.direccionEntrega || "";
    deliveryChoice.zonaExpreso = opt?.dataset?.zonaExpreso || "";
  }

  const hasShipping =
    !!deliveryChoice?.slot || !!String(shippingSelectEl?.value || "").trim();
  const hasPayment = isAdmin
    ? true
    : !!document.getElementById("paymentSelect")?.value;
  const hasItems = cart.length > 0;

  if (submitBtn) {
    submitBtn.disabled = !(hasShipping && hasPayment && hasItems);
    submitBtn.classList.toggle("is-disabled", submitBtn.disabled);
  }

  const t = calcTotals();

  if (!cart.length) {
    cartDiv.innerHTML = `
      <div class="cart-empty">
        <div class="cart-empty-row">
          <svg class="cart-empty-face" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <!-- contorno cara -->
            <circle cx="60" cy="60" r="48" fill="none" stroke="#222" stroke-width="7"/>
            <!-- ojos (puntos) -->
            <circle cx="46" cy="52" r="5" fill="#222"/>
            <circle cx="74" cy="52" r="5" fill="#222"/>
            <!-- boca frown (corners arriba, centro abajo) -->
            <path d="M44 80 Q60 66 76 80" fill="none" stroke="#222" stroke-width="6" stroke-linecap="round"/>
          </svg>
          <div class="cart-empty-text-wrap">
            <h3 class="cart-empty-title">Tu carrito está vacío</h3>
            <p class="cart-empty-text">Explorá los productos y agregá los que necesites para armar tu pedido.</p>
          </div>
        </div>
        <button type="button" class="cart-empty-btn" onclick="showSection('productos')">
          ← Ver productos
        </button>
      </div>
    `;
  } else {
    let rows = "";

    // Ordenar: primero Loekemeyer por código, luego LOKE por código
    const sortedCart = [...cart].sort((a, b) => {
      const aLoke = isLokeItem(a.productId) ? 1 : 0;
      const bLoke = isLokeItem(b.productId) ? 1 : 0;
      if (aLoke !== bLoke) return aLoke - bLoke;
      const pA = findAnyProduct(a.productId);
      const pB = findAnyProduct(b.productId);
      return String(pA?.cod || "").localeCompare(
        String(pB?.cod || ""),
        undefined,
        { numeric: true },
      );
    });

    sortedCart.forEach((item) => {
      const p = findAnyProduct(item.productId);
      if (!p) return;

      const totalCajas = item.qtyCajas;
      const totalUni = totalCajas * Number(p.uxb || 0);
      const loke = isLokeItem(item.productId);

      const tuPrecioUnit = t.logged
        ? loke
          ? Number(getPriceForCustomer(p) || 0)
          : unitYourPrice(getPriceForCustomer(p))
        : 0;
      const lineTotal = t.logged ? tuPrecioUnit * totalUni : 0;

      const pidAttr = String(item.productId).replace(/'/g, "\\'");
      rows += `
        <tr class="${loke ? "loke-row" : ""}${item.isUpsellPromo ? " promo-row" : ""}">
          <td><strong>${String(p.cod || "")}</strong></td>
          <td class="desc">${loke ? '<span class="loke-cart-tag">LOKE</span>' : ""}${item.isUpsellPromo ? '<span class="promo-cart-tag" style="display:inline-block;background:#ffebb3;color:#7a5100;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;margin-right:6px;">PROMO 30% (pedido aparte)</span>' : ""}${splitTwoWords(p.description)}</td>
          <td>
            <div class="cart-step">
              <button type="button" class="cart-step-btn" onclick="changeQty('${pidAttr}', -1)" aria-label="Restar una caja">−</button>
              <input type="number" min="0" class="cart-step-input" value="${totalCajas}" onchange="manualQty('${pidAttr}', this.value)" aria-label="Cantidad de cajas" />
              <button type="button" class="cart-step-btn" onclick="changeQty('${pidAttr}', 1)" aria-label="Sumar una caja">+</button>
              <button type="button" class="cart-step-remove" onclick="removeItem('${pidAttr}')" aria-label="Eliminar del pedido" title="Eliminar">✕</button>
            </div>
          </td>
          <td>${formatMoney(totalUni)}</td>
          <td>${t.logged ? "$" + formatMoney(tuPrecioUnit) + "<br><span class='cart-iva'>+ IVA</span>" : "—"}</td>
          <td><strong>${t.logged ? "$" + formatMoney(lineTotal) + "<br><span class='cart-iva'>+ IVA</span>" : "—"}</strong></td>
        </tr>
      `;
    });

    cartDiv.innerHTML = `
      <table class="cart-table">
        <colgroup>
          <col class="cod">
          <col class="desc">
          <col class="cajas">
          <col class="uni">
          <col class="tp">
          <col class="total">
        </colgroup>

        <thead>
          <tr>
            <th>${headerTwoLine("Cod")}</th>
            <th>${headerTwoLine("Descripción")}</th>
            <th>${headerTwoLine("Total Cajas")}</th>
            <th>${headerTwoLine("Total Uni")}</th>
            <th>${headerTwoLine(isListPriceOnlyClient() ? "Precio Lista" : "Tu Precio")}</th>
            <th>${headerTwoLine("Total $")}</th>
          </tr>
        </thead>

        <tbody>${rows}</tbody>
      </table>
    `;
  }

  $("subtotal") && ($("subtotal").innerText = formatMoney(t.subtotal));
  $("webDiscountValue") &&
    ($("webDiscountValue").innerText = formatMoney(t.webDiscountValue));
  $("paymentDiscountValue") &&
    ($("paymentDiscountValue").innerText = formatMoney(t.paymentDiscountValue));
  $("total") && ($("total").innerText = formatMoney(t.finalTotal));

  if ($("pedidoTotalHeader"))
    $("pedidoTotalHeader").innerText = formatMoney(t.finalTotal);

  if ($("paymentDiscountPercent")) {
    $("paymentDiscountPercent").innerText =
      (t.paymentDiscount * 100).toFixed(0) + "%";
  }

  $("totalNoDiscount") &&
    ($("totalNoDiscount").innerText = formatMoney(t.totalNoDiscount));
  $("totalDiscounts") &&
    ($("totalDiscounts").innerText = formatMoney(t.totalDiscounts));

  let count = 0;
  cart.forEach((item) => {
    const p = findAnyProduct(item.productId);
    if (!p) return;
    count += Number(item.qtyCajas || 0);
  });
  $("cartCount") && ($("cartCount").innerText = count);
  $("mobileCartCount") && ($("mobileCartCount").innerText = count);

  // Vendor en modo browse → ocultar botones de carrito (no puede comprar a su nombre)
  _updateCartUIVisibility();

  const btn = $("submitOrderBtn");
  if (btn) {
    // Delivery: requiere slot Y haber clickeado "Confirmar dirección entrega"
    // (el botón toma .confirmed solo después del click del usuario)
    const shipBtn = document.getElementById("shipConfirmBtn");
    const deliveryConfirmedByUser =
      !shipBtn || shipBtn.classList.contains("confirmed");
    const mustChooseDelivery = !deliveryChoice.slot || !deliveryConfirmedByUser;
    const mustChoosePayment =
      !isAdmin && !document.getElementById("paymentSelect")?.value;
    var _csv2 = document.getElementById("customerSelect")?.value || "";
    var _custConfirmBtn = document.getElementById("customerConfirmBtn");
    var _customerConfirmedByUser =
      !_custConfirmBtn || _custConfirmBtn.classList.contains("confirmed");
    const mustChooseCustomer =
      isVendorProfile() &&
      (!_csv2 || _csv2 === VENDOR_SELF_VALUE || !_customerConfirmedByUser);

    const canConfirm =
      !!currentSession &&
      cart.length > 0 &&
      !mustChooseDelivery &&
      !mustChoosePayment &&
      !mustChooseCustomer;

    btn.disabled = !canConfirm;
    // Sync clase .is-disabled — sino la CSS sigue mostrando disabled aunque
    // disabled=false → bug visual + click pasa pero parece inhabilitado
    btn.classList.toggle("is-disabled", btn.disabled);

    if (!!currentSession && cart.length > 0 && mustChooseCustomer) {
      setOrderStatus(
        "Elegí una razón social para poder confirmar el pedido.",
        "err",
      );
    } else if (!!currentSession && cart.length > 0 && mustChooseDelivery) {
      setOrderStatus(
        "Elegí una opción de Entrega para poder confirmar el pedido.",
        "err",
      );
    } else if (!!currentSession && cart.length > 0 && mustChoosePayment) {
      setOrderStatus(
        "Elegí un método de pago para poder confirmar el pedido.",
        "err",
      );
    } else if (btn.disabled === false) {
      setOrderStatus("");
    }
  }
  syncAdminCheckoutUI();
  renderMissingAssortmentModule();
  // ✅ persiste carrito para otras páginas (sugerencias, historial, etc.)
  saveCartToLS();
}

/***********************
 * SEND TO SHEETS + SUBMIT ORDER
 ***********************/
async function sendOrderToSheets(input) {
  if (!SHEETS_PROXY_URL) {
    throw new Error("Sheets proxy config missing");
  }

  if (!currentSession?.access_token) {
    throw new Error("Not logged in");
  }

  // Acepta tanto snake_case como camelCase para compatibilidad con retry
  const payload = {
    order_number: String(input.order_number || input.orderNumber || "").trim(),
    condicion_pago_code: Number(
      input.condicion_pago_code || input.condicionPagoCode || 0,
    ),
    cod_cliente: String(input.cod_cliente || input.codCliente || "").trim(),
    vend: String(input.vend || "").trim(),
    condicion_pago: String(
      input.condicion_pago || input.condicionPago || "",
    ).trim(),
    sucursal_entrega: String(
      input.sucursal_entrega || input.sucursalEntrega || "",
    ).trim(),
    cliente_nuevo: String(
      input.cliente_nuevo || input.clienteNuevo || "",
    ).trim(),
    is_promo: !!(input.is_promo || input.isPromo),
    extra_discount: Number(input.extra_discount || input.extraDiscount || 0),
    deuda: Number(input.deuda || 0),
    payment_term: input.payment_term == null ? null : Number(input.payment_term),
    credit_limit: input.credit_limit == null ? null : Number(input.credit_limit),
    lc: String(input.lc || "OK").trim(),
    d: String(input.d || "OK").trim(),
    pp: String(input.pp || "Null").trim(),
    order_total: Number(input.order_total || 0),
    mode: String(input.mode || "new").trim(),
    source: String(input.source || "Web").trim(),
    items: (input.items || []).map((it) => ({
      cod_art: String(it.cod_art || "").trim(),
      cajas: Number(it.cajas || 0),
      uxb: Number(it.uxb || 0),
    })),
  };

  const resp = await fetch(SHEETS_PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${currentSession.access_token}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok || data?.ok === false) {
    throw new Error(data?.error || `Proxy error ${resp.status}`);
  }

  return { ok: true };
}

async function withTimeout(promise, ms, label = "timeout") {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(
      () => reject(new Error(`Timeout (${ms}ms) en ${label}`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

function debugStep(txt) {
  setOrderStatus(txt, "");
}

function setSubmitOrderLoading(isLoading, text = "") {
  const btn = $("submitOrderBtn");
  if (!btn) return;

  if (isLoading) {
    btn.disabled = true;
    btn.dataset.originalText = btn.dataset.originalText || btn.textContent;
    btn.textContent = text || "Enviando...";
    btn.classList.add("is-loading");
    btn.setAttribute("aria-busy", "true");
  } else {
    btn.classList.remove("is-loading");
    btn.setAttribute("aria-busy", "false");
    btn.textContent = btn.dataset.originalText || "Confirmar pedido";
  }
}

async function rollbackOrder(orderId) {
  if (!orderId) return;

  const delItems = await supabaseClient
    .from("order_items")
    .delete()
    .eq("order_id", orderId);

  if (delItems.error) {
    console.error("rollback order_items error:", delItems.error);
  }

  const delOrder = await supabaseClient
    .from("orders")
    .delete()
    .eq("id", orderId);

  if (delOrder.error) {
    console.error("rollback orders error:", delOrder.error);
  }
}

async function sendOrderToSheetsWithRetry(payload, maxAttempts = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        setOrderStatus("Error al enviar a Sheets. Reintentando...", "err");
        setSubmitOrderLoading(
          true,
          `Reintentando... (${attempt}/${maxAttempts})`,
        );
      }

      const result = await withTimeout(
        sendOrderToSheets(payload),
        25000,
        `Sheets proxy intento ${attempt}`,
      );

      return result;
    } catch (e) {
      lastError = e;
      console.warn(`Sheets intento ${attempt} falló:`, e);

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
  }

  throw lastError || new Error("Falló el envío a Sheets");
}

/***********************
 * SEND TO ENTREGAS SHEET
 ***********************/
async function sendOrderToEntregasSheet(payload) {
  if (!SHEETS_ENTREGAS_PROXY_URL) return;
  try {
    const token = currentSession?.access_token || SUPABASE_ANON_KEY;
    const resp = await fetch(SHEETS_ENTREGAS_PROXY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(function () {
      return {};
    });
    if (!resp.ok || data?.ok === false) {
      console.warn("Entregas sheet error:", data?.error || resp.status);
    }
  } catch (e) {
    console.warn("Entregas sheet error:", e);
  }
}

/***********************
 * ANOMALY ALERT → SHEETS
 ***********************/
async function sendAnomalyAlertToSheets(alertPayload) {
  if (!SHEETS_PROXY_URL) return;
  try {
    var payload = Object.assign({ action: "anomaly_alert" }, alertPayload);
    var token = currentSession?.access_token || SUPABASE_ANON_KEY;
    var resp = await fetch(SHEETS_PROXY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(payload),
    });
    var data = await resp.json().catch(function () {
      return {};
    });
    if (!resp.ok || data?.ok === false) {
      console.warn("Anomaly alert sheet error:", data?.error || resp.status);
    }
  } catch (e) {
    console.warn("Anomaly alert sheet error:", e);
  }
}

/***********************
 * UPSELL POPUP
 ***********************/
const UPSELL_ENABLED = false; // Cambiar a true para reactivar la oferta upsell del 30% (popup al confirmar pedido).
const UPSELL_CODES = [
  "598E",
  "589E",
  "566E",
  "522E",
  "539E",
  "583E",
  "536E",
  "538E",
  "540E",
  "584E",
];

function getNextSundayMidnight() {
  var now = new Date();
  var day = now.getDay(); // 0=Sun
  var daysUntilSunday = day === 0 ? 0 : 7 - day;
  var target = new Date(now);
  target.setDate(target.getDate() + daysUntilSunday);
  target.setHours(23, 59, 59, 999);
  if (now >= target && day === 0) {
    target.setDate(target.getDate() + 7);
  }
  return target;
}

function formatCountdown(ms) {
  if (ms <= 0) return "00:00:00";
  var s = Math.floor(ms / 1000);
  var d = Math.floor(s / 86400);
  s %= 86400;
  var h = Math.floor(s / 3600);
  s %= 3600;
  var m = Math.floor(s / 60);
  s %= 60;
  var parts = [];
  if (d > 0) parts.push(d + "d");
  parts.push(
    String(h).padStart(2, "0") +
      ":" +
      String(m).padStart(2, "0") +
      ":" +
      String(s).padStart(2, "0"),
  );
  return parts.join(" ");
}

function getMissingAssortmentProducts(maxItems) {
  if (!(myAssortmentIds instanceof Set) || myAssortmentIds.size === 0)
    return [];

  var cartIds = new Set(
    cart.map(function (i) {
      return String(i.productId);
    }),
  );

  var missing = products.filter(function (p) {
    var pid = String(p.id);
    return myAssortmentIds.has(pid) && !cartIds.has(pid);
  });

  // Ranking ascendente (1 = mejor). Nulos al final.
  missing.sort(function (a, b) {
    var ra = a.ranking != null ? Number(a.ranking) : Infinity;
    var rb = b.ranking != null ? Number(b.ranking) : Infinity;
    return ra - rb;
  });

  if (maxItems && Number(maxItems) > 0)
    return missing.slice(0, Number(maxItems));
  return missing;
}

var _missingModuleAllPids = null; // todos los pids faltantes (full)
var _missingModuleOffset = 0; // offset de rotación (qué 6 mostrar)
var _missingModuleTotal = 0; // total de productos faltantes (para subtitle)
var MISSING_MODULE_DISPLAY = 6;

// Mueve la card de totales entre cart-col-left (sin missing) y cart-bottom-row
// (con missing) para que cuando no haya missing, los totales se peguen al
// método de pago en vez de quedar abajo del cart-table que es más alto.
function placeTotalsCard(missingVisible) {
  var totals = document.querySelector("#carrito .cart-total");
  if (!totals) return;
  var bottomRow = document.querySelector("#carrito .cart-bottom-row");
  var leftCol = document.querySelector("#carrito .cart-col-left");
  if (!bottomRow || !leftCol) return;
  if (missingVisible) {
    // Devolver totals a la cart-bottom-row (primer hijo)
    if (totals.parentNode !== bottomRow) {
      bottomRow.insertBefore(totals, bottomRow.firstChild);
    }
  } else {
    // Pegar totals al final de cart-col-left (debajo de pay-card)
    if (totals.parentNode !== leftCol) {
      leftCol.appendChild(totals);
    }
  }
}
window.placeTotalsCard = placeTotalsCard;

function renderMissingAssortmentModule() {
  var container = document.getElementById("missingAssortmentModule");
  if (!container) return;

  if (!currentSession || !customerProfile) {
    container.innerHTML = "";
    container.style.display = "none";
    _missingModuleAllPids = null;
    _missingModuleOffset = 0;
    placeTotalsCard(false);
    if (typeof window.__lkSyncCartColHeight === "function")
      window.__lkSyncCartColHeight();
    return;
  }

  // Recompute SIEMPRE — así si el cliente quita un item del carrito, el
  // módulo lo refleja al instante (no se queda con la lista cacheada vacía
  // de cuando el carrito tenía todo su surtido). Performance OK: filtro
  // simple sobre ~1000 productos.
  var fresh = getMissingAssortmentProducts();
  _missingModuleTotal = fresh.length;
  _missingModuleAllPids = fresh.map(function (p) {
    return String(p.id);
  });
  // Mantener offset actual si está dentro del rango, sino reset
  if (_missingModuleOffset >= _missingModuleAllPids.length) {
    _missingModuleOffset = 0;
  }

  // Mostrar TODOS los productos faltantes — el grid hace scroll vertical
  // (max-height + overflow-y en .missing-cards). El offset queda como
  // punto de partida del orden para mantener compat con el botón Refrescar.
  var total = _missingModuleAllPids.length;
  var displayPids = [];
  if (total > 0) {
    var off = _missingModuleOffset % total;
    for (var i = 0; i < total; i++) {
      displayPids.push(_missingModuleAllPids[(off + i) % total]);
    }
  }

  // Resolver productos por id
  var byId = new Map(
    products.map(function (p) {
      return [String(p.id), p];
    }),
  );
  var items = displayPids
    .map(function (pid) {
      return byId.get(pid);
    })
    .filter(Boolean);

  if (!items.length) {
    container.innerHTML = "";
    container.style.display = "none";
    placeTotalsCard(false);
    if (typeof window.__lkSyncCartColHeight === "function")
      window.__lkSyncCartColHeight();
    return;
  }

  var showTuPrecio = !isAdmin && !isListPriceOnlyClient();
  var cartQtyById = new Map(
    cart.map(function (i) {
      return [String(i.productId), Number(i.qtyCajas || 0)];
    }),
  );

  var cardsHtml = items
    .map(function (p) {
      var pid = String(p.id);
      var codSafe = String(p.cod || "").trim();
      var imgSrc = primaryProductImage(p);
      var tuPrecio = showTuPrecio
        ? precioContadoUnitario(p)
        : Number(getPriceForCustomer(p) || 0);
      var qty = cartQtyById.get(pid) || 0;

      return (
        '<div class="missing-card' +
        (qty > 0 ? " has-qty" : "") +
        '" data-pid="' +
        pid +
        '">' +
        '<img src="' +
        imgSrc +
        '" width="120" height="120" loading="lazy" onerror="this.src=\'img/no-image.jpg\'" alt="' +
        codSafe +
        '">' +
        '<div class="missing-card-info">' +
        '<div class="missing-desc" title="' +
        String(p.description || "").replace(/"/g, "&quot;") +
        '">' +
        String(p.description || "") +
        "</div>" +
        '<div class="missing-price-row">' +
        '<span class="missing-cod">' +
        codSafe +
        '</span>' +
        '<span class="missing-price-label">Tu precio contado:</span>' +
        '<span class="missing-price">$' +
        formatMoney(tuPrecio) +
        '</span>' +
        '<span class="missing-price-note">+ IVA</span>' +
        '</div>' +
        "</div>" +
        '<div class="missing-stepper">' +
        '<button type="button" class="missing-step-btn" onclick="missingStep(\'' +
        pid +
        '\', -1)" aria-label="Restar">−</button>' +
        '<span class="missing-qty" id="missingQty-' +
        pid +
        '">' +
        qty +
        "</span>" +
        '<button type="button" class="missing-step-btn" onclick="missingStep(\'' +
        pid +
        '\', 1)" aria-label="Sumar">+</button>' +
        "</div>" +
        "</div>"
      );
    })
    .join("");

  container.style.display = "";
  container.innerHTML =
    '<div class="missing-header">' +
    '<div class="missing-header-left">' +
    '<div class="missing-title">¿Seguro que no necesitás esto de tu surtido?</div>' +
    "</div>" +
    "</div>" +
    '<div class="missing-cards">' +
    cardsHtml +
    "</div>";
  placeTotalsCard(true);
  if (typeof window.__lkSyncCartColHeight === "function")
    window.__lkSyncCartColHeight();
}

function rotateMissingModule() {
  if (!_missingModuleAllPids || _missingModuleAllPids.length === 0) return;
  _missingModuleOffset =
    (_missingModuleOffset + MISSING_MODULE_DISPLAY) %
    _missingModuleAllPids.length;
  renderMissingAssortmentModule();
}
window.rotateMissingModule = rotateMissingModule;

function missingStep(pid, delta) {
  var inCart = cart.find(function (i) {
    return String(i.productId) === String(pid);
  });
  if (!inCart) {
    if (delta > 0) addFirstBox(pid, "surtido_faltante");
    return;
  }
  changeQty(pid, delta); // si llega a 0, removeItem se encarga
}

function getUpsellProducts() {
  if (!UPSELL_ENABLED) return [];
  var cartIds = new Set(
    cart.map(function (i) {
      return String(i.productId);
    }),
  );
  var historyIds = myAssortmentIds instanceof Set ? myAssortmentIds : new Set();

  var eligible = UPSELL_CODES.map(function (cod) {
    var p = products.find(function (x) {
      return String(x.cod || "").trim() === cod;
    });
    if (!p) return null;
    var pid = String(p.id);
    if (cartIds.has(pid)) return null;
    if (historyIds.has(pid)) return null;
    return p;
  }).filter(Boolean);

  // Sort by ranking ascending (closest to 1 = best) — nulls last
  eligible.sort(function (a, b) {
    var ra = a.ranking != null ? Number(a.ranking) : Infinity;
    var rb = b.ranking != null ? Number(b.ranking) : Infinity;
    return ra - rb;
  });

  return eligible.slice(0, 4);
}

function showUpsellPopup(upsellProducts) {
  return new Promise(function (resolve) {
    var overlay = document.createElement("div");
    overlay.id = "upsellOverlay";
    overlay.className = "upsell-overlay";

    var logged = !!currentSession && !!customerProfile;
    var upsellCart = {}; // { productId: qtyCajas }
    var deadline = getNextSundayMidnight();
    var timerInterval = null;

    function calcContadoPrice(listPrice) {
      if (!logged) return 0;
      if (isAdmin) return Number(listPrice || 0);
      return unitYourPrice(listPrice) * (1 - WEB_ORDER_DISCOUNT) * (1 - 0.3);
    }
    function calcUpsellPrice(listPrice) {
      return calcContadoPrice(listPrice) * (1 - 0.3);
    }

    function updateBtnState() {
      var hasItems = Object.values(upsellCart).some(function (q) {
        return q > 0;
      });
      var addBtn = document.getElementById("upsellAddBtn");
      var noBtn = document.getElementById("upsellNoBtn");
      if (addBtn) addBtn.style.display = hasItems ? "inline-flex" : "none";
      if (noBtn)
        noBtn.textContent = hasItems ? "No agregar nada" : "No, gracias";
    }

    var cardsHtml = upsellProducts
      .map(function (p) {
        var pid = String(p.id);
        var codSafe = String(p.cod || "").trim();
        var imgSrc = primaryProductImage(p);
        var contado = calcContadoPrice(getPriceForCustomer(p));
        var oferta = calcUpsellPrice(getPriceForCustomer(p));
        var uxb = Number(p.uxb || 0);

        return (
          '<div class="upsell-card" data-pid="' +
          pid +
          '">' +
          '<img src="' +
          imgSrc +
          '" width="400" height="400" loading="lazy" onerror="this.src=\'img/no-image.jpg\'" alt="' +
          codSafe +
          '">' +
          '<div class="upsell-card-info">' +
          '<div class="upsell-cod">' +
          codSafe +
          "</div>" +
          '<div class="upsell-desc">' +
          String(p.description || "") +
          "</div>" +
          '<div class="upsell-uxb">UxB: ' +
          uxb +
          "</div>" +
          '<div class="upsell-price-list">Precio de lista: $' +
          formatMoney(getPriceForCustomer(p)) +
          " + IVA</div>" +
          (logged
            ? '<div class="upsell-price-old">Contado: $' +
              formatMoney(contado) +
              " + IVA</div>" +
              '<div class="upsell-price-offer">OFERTA ESPECIAL: <strong>$' +
              formatMoney(oferta) +
              " + IVA</strong></div>"
            : "") +
          "</div>" +
          '<div class="upsell-controls">' +
          '<button type="button" class="upsell-minus" data-pid="' +
          pid +
          '">−</button>' +
          '<span class="upsell-qty" id="upsellQty-' +
          pid +
          '">0</span>' +
          '<button type="button" class="upsell-plus" data-pid="' +
          pid +
          '">+</button>' +
          "</div>" +
          "</div>"
        );
      })
      .join("");

    overlay.innerHTML =
      '<div class="upsell-popup">' +
      '<button type="button" id="upsellCloseX" class="upsell-close-x" aria-label="Cerrar">&times;</button>' +
      '<div class="upsell-header">' +
      '<div class="upsell-title">Antes de confirmar...</div>' +
      '<div class="upsell-subtitle">Estos productos todavía no los probaste. ¡Aprovechá el precio contado!</div>' +
      '<div class="upsell-timer" id="upsellTimer"></div>' +
      "</div>" +
      '<div class="upsell-cards">' +
      cardsHtml +
      "</div>" +
      '<div class="upsell-actions">' +
      '<button type="button" id="upsellNoBtn" class="upsell-btn-no">No, gracias</button>' +
      '<button type="button" id="upsellAddBtn" class="upsell-btn-add" style="display:none">Agregar al pedido y enviar</button>' +
      "</div>" +
      "</div>";

    document.body.appendChild(overlay);

    // Timer
    function tickTimer() {
      var now = new Date();
      var ms = deadline - now;
      var el = document.getElementById("upsellTimer");
      if (el) el.textContent = "Oferta válida por: " + formatCountdown(ms);
    }
    tickTimer();
    timerInterval = setInterval(tickTimer, 1000);

    function cleanup() {
      clearInterval(timerInterval);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    // +/- controls
    overlay.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-pid]");
      if (!btn) return;
      var pid = btn.dataset.pid;
      if (!upsellCart[pid]) upsellCart[pid] = 0;

      if (btn.classList.contains("upsell-plus")) {
        upsellCart[pid]++;
      } else if (btn.classList.contains("upsell-minus")) {
        if (upsellCart[pid] > 0) upsellCart[pid]--;
      }

      var qtyEl = document.getElementById("upsellQty-" + pid);
      if (qtyEl) qtyEl.textContent = upsellCart[pid];
      updateBtnState();
    });

    // X close — cancel without sending
    document
      .getElementById("upsellCloseX")
      .addEventListener("click", function () {
        cleanup();
        resolve("cancel");
      });

    // No, gracias
    document
      .getElementById("upsellNoBtn")
      .addEventListener("click", function () {
        cleanup();
        resolve(false);
      });

    // Agregar al pedido y enviar
    document
      .getElementById("upsellAddBtn")
      .addEventListener("click", function () {
        Object.keys(upsellCart).forEach(function (pid) {
          var qty = upsellCart[pid];
          if (qty <= 0) return;
          var existing = cart.find(function (i) {
            return String(i.productId) === pid;
          });
          if (existing) {
            existing.qtyCajas += qty;
            existing.isUpsellPromo = true;
          } else {
            cart.push({
              productId: pid,
              qtyCajas: qty,
              isUpsellPromo: true,
              source: "upsell_popup",
            });
            logCartAddEvent(pid, "upsell_popup");
          }
        });
        updateCart();
        renderProducts();
        cleanup();
        resolve(true);
      });
  });
}

// === Sustitución de códigos discontinuados (sin stock / reemplazados) ===
// Si el cliente pide el código viejo, el pedido se anota con el código nuevo.
// factor = cajas_nuevas / cajas_viejas → preserva las UNIDADES pedidas
// (ej: 548 viene x24, 590E x12 → 1 caja de 548 = 2 cajas de 590E = 24 u).
// 029/030 son sólo de cotizador (no existen en web) → no van acá.
var CODE_SUBSTITUTIONS = {
  // "565": { cod: "607E", factor: 1 }, // DESACTIVADO 2026-07-02: hay stock de 565, se envía 565. Reactivar cuando no haya stock.
  "323": { cod: "323E", factor: 1 },
  "548": { cod: "590E", factor: 2 },
};
function findProductByCod(cod) {
  var c = String(cod || "").trim().toUpperCase();
  return products.find(function (x) {
    return String(x.cod || "").trim().toUpperCase() === c;
  });
}
// Devuelve { product, codOriginal, factor }. codOriginal != null sólo si hubo swap.
function applyCodeSubstitution(p) {
  if (!p) return { product: p, codOriginal: null, factor: 1 };
  var sub = CODE_SUBSTITUTIONS[String(p.cod || "").trim().toUpperCase()];
  if (!sub) return { product: p, codOriginal: null, factor: 1 };
  var target = findProductByCod(sub.cod);
  if (!target) return { product: p, codOriginal: null, factor: 1 };
  return { product: target, codOriginal: p.cod, factor: sub.factor };
}

// Helper: submit a single order (regular or promo). Returns { orderId, itemsPayload, pdfItems, subtotal, finalTotal, totalDiscounts, extraDiscountRate } on success; throws on failure.
async function _submitSingleOrder(
  items,
  extraDiscountRate,
  clienteNuevoValue,
  deliveryChoiceSnapshot,
  editOrderId,
) {
  var paymentDiscount = getPaymentDiscount();
  var webDiscountRate = isAdmin ? 0 : WEB_ORDER_DISCOUNT;
  var dtoVol = getDtoVol();
  var extraRate = Number(extraDiscountRate || 0);
  var isPromo = extraRate > 0;

  // Build items payload
  var itemsPayload = items
    .map(function (item) {
      var p = findAnyProduct(item.productId);
      if (!p) return null;
      var loke = isLokeItem(item.productId);
      var qtyCajas = Number(item.qtyCajas || 0);
      var codOriginal = null;
      if (!loke) {
        var sub = applyCodeSubstitution(p);
        if (sub.codOriginal) {
          p = sub.product;
          codOriginal = sub.codOriginal;
          qtyCajas = qtyCajas * (sub.factor || 1);
        }
      }
      var uxb = Number(p.uxb || 0);
      return {
        product_id: p.id,
        cod_art: (loke ? "LOKE-" : "") + String(p.cod || "").trim(),
        cod_original: codOriginal,
        cajas: qtyCajas,
        uxb: uxb,
        unidades: qtyCajas * uxb,
        unit_price: loke
          ? Number(getPriceForCustomer(p) || 0)
          : Number(unitYourPrice(getPriceForCustomer(p)) || 0),
        list_price: Number(getPriceForCustomer(p) || 0),
        description: String(p.description || ""),
        is_loke: loke,
        source: item.source || "catalogo",
      };
    })
    .filter(Boolean)
    .sort(function (a, b) {
      var aLoke = a.is_loke ? 1 : 0;
      var bLoke = b.is_loke ? 1 : 0;
      if (aLoke !== bLoke) return aLoke - bLoke;
      return String(a.cod_art || "").localeCompare(
        String(b.cod_art || ""),
        undefined,
        { numeric: true },
      );
    });

  // Totals (aplicando web → payment → extra en cascada)
  var subtotal = 0;
  var totalNoDiscount = 0;
  itemsPayload.forEach(function (it) {
    subtotal += Number(it.unit_price || 0) * Number(it.unidades || 0);
    totalNoDiscount += Number(it.list_price || 0) * Number(it.unidades || 0);
  });
  var afterWeb = subtotal * (1 - webDiscountRate);
  var afterPayment = afterWeb * (1 - paymentDiscount);
  var finalTotal = afterPayment * (1 - extraRate);
  var totalDiscounts = Math.max(0, totalNoDiscount - finalTotal);

  // RPC call — el 30% extra ya viene BAKED-IN en p_total
  var rpcItems = itemsPayload.map(function (it) {
    return {
      product_id: it.product_id,
      cajas: it.cajas,
      uxb: it.uxb,
      is_loke: !!it.is_loke,
    };
  });

  var rpcResult = await withTimeout(
    editOrderId
      ? supabaseClient.rpc("edit_order_fast", {
          p_order_id: editOrderId,
          p_auth_user_id: currentSession.user.id,
          p_customer_id: customerProfile.id,
          p_payment_method: getPaymentMethodText(),
          p_payment_discount: Number(paymentDiscount || 0),
          p_web_discount: Number(webDiscountRate || 0),
          p_subtotal: Number(subtotal || 0),
          p_total: Number(finalTotal || 0),
          p_items: rpcItems,
        })
      : supabaseClient.rpc("submit_order_fast", {
          p_auth_user_id: currentSession.user.id,
          p_customer_id: customerProfile.id,
          p_status: "pendiente",
          p_payment_method: getPaymentMethodText(),
          p_payment_discount: Number(paymentDiscount || 0),
          p_web_discount: Number(webDiscountRate || 0),
          p_subtotal: Number(subtotal || 0),
          p_total: Number(finalTotal || 0),
          p_items: rpcItems,
        }),
    15000,
    editOrderId ? "edit_order_fast" : "submit_order_fast",
  );

  if (rpcResult.error || (!editOrderId && !rpcResult.data)) {
    var msg =
      rpcResult.error?.message ||
      rpcResult.error?.details ||
      rpcResult.error?.hint ||
      "RPC falló";
    throw new Error(msg);
  }

  var orderId = editOrderId || rpcResult.data;

  // PDF items: para promo, bakeamos el 30% en el "tu precio" unitario para que se vea la oferta por fila
  var pdfItems = itemsPayload.map(function (it) {
    var unidades = Number(it.cajas || 0) * Number(it.uxb || 0);
    var listUnit = Number(it.list_price || 0);
    var tuPrecioUnit = isAdmin
      ? listUnit * (1 - extraRate)
      : listUnit * (1 - dtoVol) * (1 - webDiscountRate) * (1 - extraRate);
    return {
      cod: it.cod_art,
      description: it.description || "",
      cajas: Number(it.cajas || 0),
      unidades: unidades,
      tu_precio_unit: tuPrecioUnit,
      sub_total: tuPrecioUnit * unidades,
      list_price_unit: listUnit,
      list_sub_total: listUnit * unidades,
    };
  });

  var listSubtotal = pdfItems.reduce(function (acc, it) {
    return acc + Number(it.list_sub_total || 0);
  }, 0);

  // Calculate status fields for sheet
  var debt = Number(customerProfile.debt || 0);
  var creditLimit = customerProfile.credit_limit == null ? null : Number(customerProfile.credit_limit);

  // LC: "X" if (debt + order) > creditLimit, else "OK"
  var lcStatus = "OK";
  if (creditLimit != null && (debt + finalTotal) > creditLimit) {
    lcStatus = "X";
  }

  // D (Deuda): "X" if debt > 0, else "OK"
  var dStatus = debt > 0 ? "X" : "OK";

  // PP: payment_term value or "Null" (no tiene plazo cargado)
  var ppStatus = customerProfile.payment_term == null
    ? "Null"
    : String(Number(customerProfile.payment_term));

  // Sheets payload (snake_case para compat con Apps Script + retry)
  var sheetsPayload = {
    order_number: String(orderId || "").trim(),
    cod_cliente: String(customerProfile.cod_cliente || "").trim(),
    vend: String(customerProfile.vend || "").trim(),
    condicion_pago: String(getPaymentMethodText() || "").trim(),
    condicion_pago_code: Number(getPaymentMethodCode() || 0),
    sucursal_entrega: String(
      deliveryChoiceSnapshot.label || deliveryChoiceSnapshot.slot || "",
    ).trim(),
    cliente_nuevo: String(clienteNuevoValue || "").trim(),
    is_promo: isPromo,
    extra_discount: extraRate,
    deuda: debt,
    credit_limit: creditLimit,
    payment_term: customerProfile.payment_term == null ? null : Number(customerProfile.payment_term),
    lc: lcStatus,
    d: dStatus,
    pp: ppStatus,
    order_total: finalTotal,
    source: "Web",
    mode: editOrderId ? "edit" : "new",
    items: itemsPayload.map(function (it) {
      return {
        cod_art: it.cod_art,
        cod_original: it.cod_original || null,
        cajas: it.cajas,
        uxb: it.uxb,
      };
    }),
  };

  // Guardar payload para retry automático + marcar is_promo/extra_discount
  // + quién estaba logueado al confirmar (cliente o vendedor "Pedir para")
  supabaseClient
    .from("orders")
    .update({
      sheets_payload: sheetsPayload,
      is_promo: isPromo,
      extra_discount: extraRate,
      placed_by_auth_user_id: currentSession.user.id,
    })
    .eq("id", orderId)
    .then(function () {});

  // Marcar en order_items desde qué módulo se agregó cada línea (Novedades,
  // Sugerencias, Historial, catálogo normal, etc). Background, no bloquea.
  itemsPayload.forEach(function (it) {
    supabaseClient
      .from("order_items")
      .update({ source: it.source || "catalogo" })
      .eq("order_id", orderId)
      .eq("product_id", it.product_id)
      .then(function () {});
  });

  // Enviar a sheets-proxy en background
  sendOrderToSheetsWithRetry(sheetsPayload, 3)
    .then(function () {
      supabaseClient
        .from("orders")
        .update({ sheets_sent: true })
        .eq("id", orderId)
        .then(function () {});
    })
    .catch(function (e) {
      console.warn("Sheets error (order " + orderId + "):", e);
    });

  // Enviar al Sheet de entregas (Base Picking) en background
  var entregasPayload = {
    order_number: orderId,
    fecha: new Date().toLocaleDateString("es-AR"),
    cod_cliente: customerProfile.cod_cliente,
    cliente: customerProfile.business_name,
    vendedor: customerProfile.vend || "",
    direccion_entrega:
      deliveryChoiceSnapshot.direccionEntrega ||
      deliveryChoiceSnapshot.label ||
      "",
    barrio_entrega: deliveryChoiceSnapshot.zonaExpreso || "",
    empresa: "LK",
    is_promo: isPromo,
    extra_discount: extraRate,
    mode: editOrderId ? "edit" : "new",
    items: itemsPayload.map(function (it) {
      return {
        cod_art: it.cod_art,
        description: it.description || "",
        cajas: it.cajas,
        uxb: it.uxb,
      };
    }),
  };
  sendOrderToEntregasSheet(entregasPayload);

  return {
    orderId: orderId,
    itemsPayload: itemsPayload,
    pdfItems: pdfItems,
    subtotal: subtotal,
    listSubtotal: listSubtotal,
    finalTotal: finalTotal,
    totalDiscounts: totalDiscounts,
    extraDiscountRate: extraRate,
    paymentDiscount: Number(paymentDiscount || 0),
    webDiscount: Number(webDiscountRate || 0),
    dtoVol: Number(dtoVol || 0),
  };
}

async function submitOrder() {
  // Snapshot del modo edición: si está seteado, este submit edita ese pedido.
  var editOrderIdSnapshot = editingOrderId;

  // Upsell check — show popup before confirming (no aplica editando un pedido)
  if (!editOrderIdSnapshot && !window.__submittingOrder && !window.__upsellShown) {
    var upsellProducts = getUpsellProducts();
    if (upsellProducts.length > 0) {
      window.__upsellShown = true;
      var upsellResult = await showUpsellPopup(upsellProducts);
      window.__upsellShown = false;
      if (upsellResult === "cancel") return; // closed with X — don't send
    }
  }

  const btn = $("submitOrderBtn");
  const clienteNuevoValue = isAdmin
    ? String($("clienteNuevoInput")?.value || "").trim()
    : "";
  try {
    setOrderStatus("");

    if (window.__submittingOrder) return;
    window.__submittingOrder = true;
    setSubmitOrderLoading(true, "Enviando...");

    if (!currentSession) {
      openLogin();
      return;
    }
    var _csv3 = document.getElementById("customerSelect")?.value || "";
    if (
      isVendorProfile() &&
      (!_csv3 || _csv3 === VENDOR_SELF_VALUE)
    ) {
      setOrderStatus(
        "Debes seleccionar una razón social para confirmar el pedido.",
        "err",
      );
      return;
    }
    if (!customerProfile?.id) {
      setOrderStatus("No se encontro el perfil del cliente.", "err");
      return;
    }
    if (!cart.length) {
      setOrderStatus("Carrito vacio.", "err");
      return;
    }

    const shippingSelectEl = document.getElementById("shippingSelect");
    if (shippingSelectEl && shippingSelectEl.value && !deliveryChoice.slot) {
      const opt = shippingSelectEl.options[shippingSelectEl.selectedIndex];
      deliveryChoice.slot = shippingSelectEl.value || "";
      deliveryChoice.label = opt?.dataset?.label || opt?.textContent || "";
      deliveryChoice.direccionEntrega = opt?.dataset?.direccionEntrega || "";
      deliveryChoice.zonaExpreso = opt?.dataset?.zonaExpreso || "";
    }

    if (!deliveryChoice?.slot) {
      setOrderStatus("Debes seleccionar una sucursal de entrega.", "err");
      return;
    }

    const paySel = document.getElementById("paymentSelect");
    if (!isAdmin && (!paySel || !String(paySel.value || "").trim())) {
      setOrderStatus("Debes seleccionar un metodo de pago.", "err");
      return;
    }

    // ---- Split cart: regular (pedido X) vs promo (pedido X+1) ----
    const regularItems = cart.filter(function (i) {
      return !i.isUpsellPromo;
    });
    const promoItems = cart.filter(function (i) {
      return !!i.isUpsellPromo;
    });

    if (regularItems.length === 0 && promoItems.length === 0) {
      setOrderStatus("Carrito vacio.", "err");
      return;
    }

    // ---- Snapshot deliveryChoice antes de resetear ----
    var deliveryChoiceSnapshot = {
      slot: deliveryChoice.slot,
      label: deliveryChoice.label,
      direccionEntrega: deliveryChoice.direccionEntrega || "",
      zonaExpreso: deliveryChoice.zonaExpreso || "",
    };

    // ---- Submit pedido regular (X) ----
    var regularResult = null;
    if (regularItems.length > 0) {
      debugStep("Confirmando pedido...");
      try {
        regularResult = await _submitSingleOrder(
          regularItems,
          0,
          clienteNuevoValue,
          deliveryChoiceSnapshot,
          editOrderIdSnapshot,
        );
      } catch (e) {
        console.error("Regular order error:", e);
        setOrderStatus(
          "No se pudo confirmar el pedido: " + (e.message || String(e)),
          "err",
        );
        return;
      }
    }

    // ---- Submit pedido promo (X+1) ----
    var promoResult = null;
    if (promoItems.length > 0) {
      debugStep(
        regularResult ? "Confirmando pedido promo..." : "Confirmando pedido...",
      );
      try {
        promoResult = await _submitSingleOrder(
          promoItems,
          UPSELL_DISCOUNT,
          clienteNuevoValue,
          deliveryChoiceSnapshot,
        );
      } catch (e) {
        console.error("Promo order error:", e);
        if (regularResult) {
          // El pedido principal ya se grabó; no tumbamos el flujo, sólo avisamos.
          setOrderStatus(
            "Pedido principal confirmado, pero el pedido promo falló: " +
              (e.message || String(e)),
            "err",
          );
        } else {
          setOrderStatus(
            "No se pudo confirmar el pedido: " + (e.message || String(e)),
            "err",
          );
          return;
        }
      }
    }

    // ---- Datos para PDF ----
    var primaryResult = regularResult || promoResult;
    if (primaryResult) {
      lastConfirmedOrder = {
        orderId: primaryResult.orderId,
        customerName: customerProfile?.business_name || "",
        codCliente: customerProfile?.cod_cliente || "",
        sucursalEntrega:
          deliveryChoiceSnapshot.label || deliveryChoiceSnapshot.slot || "",
        metodoPago: getPaymentMethodText(),
        subtotal: Number(primaryResult.subtotal || 0),
        listSubtotal: Number(primaryResult.listSubtotal || 0),
        descuentos: Number(primaryResult.totalDiscounts || 0),
        total: Number(primaryResult.finalTotal || 0),
        items: primaryResult.pdfItems,
        paymentDiscount: Number(primaryResult.paymentDiscount || 0),
        webDiscount: Number(primaryResult.webDiscount || 0),
        dtoVol: Number(primaryResult.dtoVol || 0),
        // Si hubo regular + promo, guardamos el promo aparte para renderizarlo en el PDF
        promoOrder:
          regularResult && promoResult
            ? {
                orderId: promoResult.orderId,
                subtotal: Number(promoResult.subtotal || 0),
                descuentos: Number(promoResult.totalDiscounts || 0),
                total: Number(promoResult.finalTotal || 0),
                items: promoResult.pdfItems,
              }
            : null,
      };

      // Subir PDF al bucket de Supabase (best-effort).
      // Lo posponemos para que jsPDF no compita con la animacion Lottie de
      // confirmacion (ambos usan main thread). Usamos requestIdleCallback con
      // fallback a setTimeout para navegadores viejos (Safari).
      var _subirPDF = function () {
        descargarPedidoPDF(true).catch(function (e) {
          console.warn("Subida PDF al bucket fallo:", e);
        });
      };
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(_subirPDF, { timeout: 5000 });
      } else {
        setTimeout(_subirPDF, 2500);
      }
    }

    // Escala activa: capturar el dto REAL del pedido ANTES de vaciar el carrito.
    // Si no, updateCart() (post-reset) recalcula dto_vol sobre un carrito vacío
    // (subtotal 0 → 0%) y _escalaFijar terminaría fijando 0% permanente.
    var _escalaDtoParaFijar =
      _escalaActiva && primaryResult
        ? Number(primaryResult.dtoVol || 0)
        : customerProfile
          ? Number(customerProfile.dto_vol || 0)
          : 0;

    // ---- Reset UI ----
    // Salir del modo edición (si venía de "Editar Pedido").
    setEditingOrderId(null);
    setEditBanner(null);
    cart.length = 0;
    saveCartToLS();

    // Borrar draft asociado si este pedido venía de "Pedidos sin Confirmar"
    if (window.__activeDraftId) {
      const draftIdToDelete = window.__activeDraftId;
      window.__activeDraftId = null;
      supabaseClient
        .from("saved_carts")
        .delete()
        .eq("id", draftIdToDelete)
        .then(
          function () {},
          function (err) {
            console.warn("No se pudo borrar draft:", err);
          },
        );
    }

    deliveryChoice = { slot: "", label: "" };
    var shipSel = $("shippingSelect");
    if (shipSel) {
      shipSel.value = "";
      if (typeof _csRefreshDropdownVisual === "function") _csRefreshDropdownVisual(shipSel);
    }
    var shipConfirmBtn = $("shipConfirmBtn");
    if (shipConfirmBtn) {
      var shipCard = shipConfirmBtn.closest(".ship-card");
      if (shipCard) shipCard.classList.remove("has-confirm");
      shipConfirmBtn.remove();
    }
    if (paySel) paySel.value = "";
    document.querySelectorAll("#paymentButtons .pay-btn").forEach(function (b) {
      b.classList.remove("selected", "active");
    });
    var payLaterBtn = $("payLaterBtn");
    if (payLaterBtn) payLaterBtn.classList.remove("selected", "active");

    updateCart();
    renderProducts();
    syncPaymentButtons();
    loadDeliveryOptions();
    refreshSubmitEnabled();

    showSection("pedidoConfirmado");

    // Escala activa: fijar el dto definitivo (el que usó el pedido) y apagar el flag.
    if (_escalaActiva) {
      _escalaFijar(_escalaDtoParaFijar).catch(function (e) { console.error("escalaFijar:", e); });
    }

    // EXPO: chip con el N° de pedido (prueba de que quedó grabado) + panel de cierre.
    try {
      var _son = document.getElementById("successOrderNum");
      if (_son) {
        var _oid = lastConfirmedOrder && lastConfirmedOrder.orderId;
        _son.textContent = _oid ? "Pedido N° " + _oid : "";
        _son.style.display = _oid ? "" : "none";
      }
    } catch (e) {}
    if (typeof _expoShowConfirmPanel === "function") _expoShowConfirmPanel();
    playSuccessAnimation();
    window.scrollTo({ top: 0, behavior: "smooth" });

    // ---- Detección de anomalías en background (solo sobre el pedido regular) ----
    if (regularResult && regularResult.itemsPayload) {
      var codClienteSnap = customerProfile.cod_cliente;
      var regularOrderId = regularResult.orderId;
      var regularItemsPayload = regularResult.itemsPayload;
      var clienteNameSnap = customerProfile.business_name;
      (async function () {
        try {
          var anomalyMap = await loadAnomalyData(codClienteSnap);
          if (!anomalyMap || !anomalyMap.size) return;
          var alertas = [];
          for (var ai = 0; ai < regularItemsPayload.length; ai++) {
            var it = regularItemsPayload[ai];
            var codArt = String(it.cod_art || "")
              .replace(/^LOKE-/, "")
              .trim();
            var anomaly = checkItemAnomaly(anomalyMap, codArt, it.cajas);
            if (anomaly) {
              alertas.push({
                cod_art: codArt,
                cajas: it.cajas,
                promedio: Math.round(anomaly.avg * 10) / 10,
                ratio: Math.round(anomaly.ratio * 10) / 10,
              });
            }
          }
          if (alertas.length > 0) {
            sendAnomalyAlertToSheets({
              order_number: regularOrderId,
              cod_cliente: codClienteSnap,
              cliente: clienteNameSnap,
              alertas: alertas,
            });
          }
        } catch (e) {
          console.warn("anomaly check error:", e);
        }
      })();
    }
  } catch (e) {
    console.error("submitOrder error:", e);
    setOrderStatus(
      "Ocurrio un problema al enviar el pedido, reintente el envio.",
      "err",
    );

    var btn2 = $("submitOrderBtn");
    if (btn2) {
      btn2.disabled = false;
      btn2.classList.remove("is-loading", "is-disabled");
      btn2.setAttribute("aria-busy", "false");
      btn2.textContent = btn2.dataset.originalText || "Confirmar pedido";
    }

    window.__submittingOrder = false;
    return;
  } finally {
    window.__submittingOrder = false;
    setSubmitOrderLoading(false);
    refreshSubmitEnabled();
  }
}

function refreshSubmitEnabled() {
  const btn = document.getElementById("submitOrderBtn");
  if (!btn) return;

  const shipSel = document.getElementById("shippingSelect");
  const paySel = document.getElementById("paymentSelect");
  const custSel = document.getElementById("customerSelect");

  const hasSession = !!currentSession;
  const hasItems = cart.length > 0;
  // hasShipping: requiere slot Y haber clickeado "Confirmar dirección entrega"
  const shipBtn = document.getElementById("shipConfirmBtn");
  const deliveryConfirmedByUser =
    !shipBtn || shipBtn.classList.contains("confirmed");
  const hasShipping =
    !!(shipSel && String(shipSel.value || "").trim()) && deliveryConfirmedByUser;
  const hasPayment = isAdmin
    ? true
    : !!(paySel && String(paySel.value || "").trim());
  const custSelVal = custSel ? String(custSel.value || "").trim() : "";
  // Vendedor: además de elegir cliente, debe haber clickeado "Confirmar"
  // (mismo patrón que la dirección de entrega).
  const custConfirmBtn = document.getElementById("customerConfirmBtn");
  const customerConfirmedByUser =
    !custConfirmBtn || custConfirmBtn.classList.contains("confirmed");
  const hasCustomer =
    !isVendorProfile() ||
    (!!custSelVal && custSelVal !== VENDOR_SELF_VALUE && customerConfirmedByUser);

  btn.disabled = !(
    hasSession &&
    hasItems &&
    hasShipping &&
    hasPayment &&
    hasCustomer
  );
  btn.classList.toggle("is-disabled", btn.disabled);
}

// =========================================================
// PANTALLA FINAL DEL PEDIDO
// =========================================================

// ✅ Botón "Volver"
function volverMayorista() {
  showSection("productos");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ✅ Botón "Descargar pedido"
// Genera un archivo .txt con el resumen del pedido confirmado
// =========================================================
// Convierte una imagen a DataURL para poder insertarla en jsPDF
// =========================================================
function loadImageAsDataURL(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";

    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;

      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);

      resolve(canvas.toDataURL("image/png"));
    };

    img.onerror = reject;
    img.src = src;
  });
}
// Intenta extraer la tasa de descuento desde el texto del método de pago
// (ej: "Pago Contado: 30% Dto" → 0.30). Devuelve null si no encuentra.
function parsePaymentDiscountFromText(text) {
  const m = String(text || "").match(/(\d+)\s*%/);
  if (!m) return null;
  return Number(m[1]) / 100;
}

// Dibuja el encabezado de la tabla de ítems
function _drawItemsHeader(doc, y, cols) {
  doc.setFillColor(240, 240, 240);
  doc.rect(14, y - 5, 182, 8, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(0, 0, 0);
  doc.text("Cod", cols.cod, y);
  doc.text("Descripción", cols.desc, y);
  doc.text("Cajas", cols.cajas, y, { align: "right" });
  doc.text("Uni", cols.uni, y, { align: "right" });
  doc.text("Precio", cols.precio, y, { align: "right" });
  doc.text("Subtotal", cols.subtotal, y, { align: "right" });
  return y + 8;
}

// ✅ Genera PDF del pedido con formato "Pedido Web" (grilla de métodos de pago)
// soloSubir=true → no descarga al disco, solo sube al bucket pedidos-pdf de Supabase
//                  (lo usa el flow de confirmacion para que el bot lo pueda mandar
//                   por WhatsApp).
async function descargarPedidoPDF(soloSubir = false) {
  if (!lastConfirmedOrder) {
    if (!soloSubir) alert("No hay un pedido para descargar.");
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF("p", "mm", "a4");
  doc.setFillColor(255, 255, 255);
  doc.rect(0, 0, 210, 297, "F");

  const {
    customerName,
    codCliente,
    sucursalEntrega,
    metodoPago,
    subtotal,
    listSubtotal,
    total,
    items,
    paymentDiscount,
    webDiscount,
    dtoVol,
  } = lastConfirmedOrder;

  // Subtotal "puro de lista" (sin ningún descuento) para columnas y totales
  const listSub = Number(
    listSubtotal ||
      (items || []).reduce(
        (acc, it) => acc + Number(it.list_sub_total || 0),
        0,
      ),
  );

  const pageWidth = 210;
  const margin = 14;
  const rightX = pageWidth - margin; // 196
  // Columnas apretadas; right-aligned para "cajas"/"uni"/"precio"/"subtotal".
  // Subtotal/Precio tienen lugar para montos de hasta 8 dígitos ($99.999.999).
  const cols = {
    cod: margin + 1, // 15 (left)
    desc: margin + 18, // 32 (left)
    cajas: margin + 91, // 105 (right)
    uni: margin + 111, // 125 (right)
    precio: margin + 146, // 160 (right)
    subtotal: rightX - 2, // 194 (right)
  };

  // =========================================================
  // HEADER: banner con logo (ya trae fondo + logo)
  // =========================================================
  const headerBanner = await loadImageAsDataURL("img/HeaderTN.png");
  doc.addImage(headerBanner, "PNG", 0, 0, 210, 24);

  // =========================================================
  // TÍTULO
  // =========================================================
  doc.setTextColor(0, 0, 0);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.text("Pedido Web", margin, 40);

  // =========================================================
  // DATOS GENERALES
  // =========================================================
  let y = 52;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(`Cliente: ${customerName}`, margin, y);
  y += 6;
  doc.text(`Cod. Cliente: ${codCliente}`, margin, y);
  y += 6;
  if (sucursalEntrega) {
    doc.text(`Sucursal de entrega: ${sucursalEntrega}`, margin, y);
    y += 6;
  }
  doc.text(`Método de pago: ${metodoPago || "—"}`, margin, y);
  y += 4;

  // Nota a la derecha arriba de la tabla
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(90, 90, 90);
  doc.text("Subtotal no contempla Descuentos", rightX, y, { align: "right" });
  doc.setTextColor(0, 0, 0);
  y += 8;

  // =========================================================
  // TABLA DE ÍTEMS
  // =========================================================
  y = _drawItemsHeader(doc, y, cols);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  items.forEach((it) => {
    if (y > 250) {
      doc.addPage();
      doc.addImage(headerBanner, "PNG", 0, 0, 210, 24);
      y = 36;
      y = _drawItemsHeader(doc, y, cols);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
    }
    const desc = String(it.description || "").slice(0, 30);
    const precio = Number(
      it.list_price_unit != null ? it.list_price_unit : it.tu_precio_unit || 0,
    );
    const sub = Number(
      it.list_sub_total != null ? it.list_sub_total : it.sub_total || 0,
    );
    doc.text(String(it.cod || ""), cols.cod, y);
    doc.text(desc, cols.desc, y);
    doc.text(String(it.cajas || 0), cols.cajas, y, { align: "right" });
    doc.text(String(it.unidades || 0), cols.uni, y, { align: "right" });
    doc.text(`$${formatMoney(precio)}`, cols.precio, y, { align: "right" });
    doc.text(`$${formatMoney(sub)}`, cols.subtotal, y, { align: "right" });
    y += 7;
  });

  // =========================================================
  // TOTALES a la derecha
  // =========================================================
  y += 6;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Subtotal sin Descuentos:", rightX - 50, y, { align: "right" });
  doc.text(`$${formatMoney(listSub)} + IVA`, rightX, y, { align: "right" });

  // Descuento del método de pago elegido = listSub - totalConEseMétodo.
  // Siempre que haya un método válido seleccionado (y no admin/precio-lista).
  const _pdForDelta = Number(paymentDiscount || 0);
  const _wdForDelta =
    typeof webDiscount === "number" ? Number(webDiscount) : WEB_ORDER_DISCOUNT;
  const _dvForDelta = typeof dtoVol === "number" ? Number(dtoVol) : 0;
  const _noSelDelta = /no\s*decidir/i.test(String(metodoPago || ""));
  const totalSelMethod =
    listSub * (1 - _dvForDelta) * (1 - _wdForDelta) * (1 - _pdForDelta);
  const deltaMetodo = Math.max(0, listSub - totalSelMethod);

  if (!isAdmin && !isListPriceOnlyClient() && !_noSelDelta && deltaMetodo > 0) {
    y += 7;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(80, 80, 80);
    doc.text("Descuentos c/ Método de pago elegido:", rightX - 25, y, {
      align: "right",
    });
    doc.text(`$${formatMoney(deltaMetodo)}`, rightX, y, { align: "right" });
    doc.setTextColor(0, 0, 0);
  }

  y += 14;

  // =========================================================
  // GRILLA DE MÉTODOS DE PAGO (solo cliente mayorista estándar)
  // =========================================================
  const showPaymentGrid =
    !isAdmin && !isListPriceOnlyClient() && Number(subtotal || 0) > 0;

  if (showPaymentGrid) {
    const pd = Number(paymentDiscount || 0);
    const wd =
      typeof webDiscount === "number"
        ? Number(webDiscount)
        : WEB_ORDER_DISCOUNT;
    const dv = typeof dtoVol === "number" ? Number(dtoVol) : 0;
    // Si el cliente eligió "Prefiero no decidir ahora", no resaltamos ninguna opción
    const noSelection = /no\s*decidir/i.test(String(metodoPago || ""));

    const options = [
      { label: "Contado", discount: 0.3 },
      { label: "30 días", discount: 0.2 },
      { label: "45 días", discount: 0.15 },
      { label: "60 días", discount: 0.1 },
      { label: "90 días eCheq", discount: 0.05 },
      { label: "120 días eCheq", discount: 0.0 },
    ];

    const gapX = 4;
    const gapY = 4;
    const boxW = (rightX - margin - gapX * 2) / 3; // 3 columnas
    const boxH = 14;

    // Salto de página si no entra la grilla
    if (y + 2 * boxH + gapY > 275) {
      doc.addPage();
      doc.addImage(headerBanner, "PNG", 0, 0, 210, 24);
      y = 36;
    }

    options.forEach((opt, i) => {
      const row = Math.floor(i / 3);
      const col = i % 3;
      const bx = margin + col * (boxW + gapX);
      const by = y + row * (boxH + gapY);
      const optTotal = listSub * (1 - dv) * (1 - wd) * (1 - opt.discount);
      const selected = !noSelection && Math.abs(opt.discount - pd) < 0.001;

      if (selected) {
        doc.setDrawColor(34, 139, 76); // verde
        doc.setLineWidth(0.9);
      } else {
        doc.setDrawColor(180, 180, 180);
        doc.setLineWidth(0.3);
      }
      doc.roundedRect(bx, by, boxW, boxH, 3, 3);

      // Texto label
      doc.setFont("helvetica", selected ? "bold" : "normal");
      doc.setFontSize(9);
      doc.setTextColor(0, 0, 0);

      const labelLines = opt.label.includes("eCheq")
        ? opt.label.replace(" eCheq", "\neCheq").split("\n")
        : [opt.label];

      const labelX = bx + 3;
      if (labelLines.length === 1) {
        doc.text(labelLines[0], labelX, by + boxH / 2 + 1);
      } else {
        doc.text(labelLines[0], labelX, by + boxH / 2 - 1.2);
        doc.text(labelLines[1], labelX, by + boxH / 2 + 3);
      }

      // Flecha dibujada con líneas (Helvetica no soporta "→" unicode).
      // Se coloca justo después de la etiqueta (primera línea).
      const firstLineW = doc.getTextWidth(labelLines[0]);
      const aLen = 4;
      const ax = labelX + firstLineW + 1.5;
      const ay = by + boxH / 2;
      doc.setDrawColor(
        selected ? 34 : 90,
        selected ? 139 : 90,
        selected ? 76 : 90,
      );
      doc.setLineWidth(selected ? 0.7 : 0.5);
      doc.line(ax, ay, ax + aLen, ay);
      doc.line(ax + aLen, ay, ax + aLen - 1.4, ay - 1.2);
      doc.line(ax + aLen, ay, ax + aLen - 1.4, ay + 1.2);
      doc.setDrawColor(0, 0, 0);
      doc.setLineWidth(0.2);

      // Monto alineado a la derecha del box — con lugar para $99.999.999 + IVA
      doc.setFont("helvetica", selected ? "bold" : "normal");
      doc.setFontSize(9);
      doc.text(
        `$${formatMoney(optTotal)} + IVA`,
        bx + boxW - 3,
        by + boxH / 2 + 1,
        { align: "right" },
      );
    });

    // Resetear estilo
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.2);
    y += 2 * boxH + gapY + 4;
  } else {
    // Cliente con precio de lista / admin: mostramos total simple
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Total:", rightX - 45, y, { align: "right" });
    doc.text(`$${formatMoney(total)} + IVA`, rightX, y, { align: "right" });
    y += 10;
  }

  // =========================================================
  // SECCIÓN PEDIDO PROMO (X+1) — sólo si hubo items de upsell
  // =========================================================
  if (lastConfirmedOrder.promoOrder) {
    const promo = lastConfirmedOrder.promoOrder;

    y += 10;
    if (y > 245) {
      doc.addPage();
      y = 28;
    }

    // Banner promo
    doc.setFillColor(255, 235, 180);
    doc.rect(14, y - 5, 182, 10, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(150, 80, 0);
    doc.text(
      `PROMO · Pedido Nº ${promo.orderId} — 30% OFF lanzamiento`,
      16,
      y + 2,
    );
    doc.setTextColor(0, 0, 0);
    y += 14;

    // Totales promo
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(`Subtotal: $${formatMoney(promo.subtotal)}`, 14, y);
    y += 7;
    doc.text(`Descuentos: $${formatMoney(promo.descuentos)}`, 14, y);
    y += 7;
    doc.text(`Total: $${formatMoney(promo.total)} + IVA`, 14, y);
    y += 10;

    // Tabla header
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setFillColor(240, 240, 240);
    doc.rect(14, y - 5, 182, 8, "F");
    doc.text("Cod", 16, y);
    doc.text("Descripción", 30, y);
    doc.text("Cajas", 118, y);
    doc.text("Uni", 134, y);
    doc.text("Tu precio", 146, y);
    doc.text("Subtotal", 173, y);
    y += 8;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);

    promo.items.forEach((it) => {
      if (y > 275) {
        doc.addPage();
        y = 28;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8);
        doc.setFillColor(240, 240, 240);
        doc.rect(14, y - 5, 182, 8, "F");
        doc.text("Cod", 16, y);
        doc.text("Descripción", 30, y);
        doc.text("Cajas", 118, y);
        doc.text("Uni", 134, y);
        doc.text("Tu precio", 146, y);
        doc.text("Subtotal", 173, y);
        y += 8;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
      }
      const pDesc = String(it.description || "").slice(0, 24);
      doc.text(String(it.cod || ""), 16, y);
      doc.text(pDesc, 30, y);
      doc.text(String(it.cajas || 0), 118, y);
      doc.text(String(it.unidades || 0), 134, y);
      doc.text(`$${formatMoney(it.tu_precio_unit || 0)}`, 146, y);
      doc.text(`$${formatMoney(it.sub_total || 0)}`, 173, y);
      y += 7;
    });
  }

  const now = new Date();

  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(-2);
  const HH = String(now.getHours()).padStart(2, "0");
  const MM = String(now.getMinutes()).padStart(2, "0");
  const SS = String(now.getSeconds()).padStart(2, "0");

  if (soloSubir) {
    // Modo upload-only: mandar el PDF a la edge function subir-pedido-pdf,
    // que valida ownership con el JWT y sube al bucket con service_role.
    await _enviarPDFAEdgeFunction(doc, lastConfirmedOrder.orderId);
    return;
  }

  // Modo descarga local (default).
  const fileName = `Pedido-${dd}_${mm}_${yy}-${HH}_${MM}_${SS}.pdf`;
  doc.save(fileName);

  // Tambien subir al bucket en background (best-effort, sin bloquear la
  // descarga del usuario).
  _enviarPDFAEdgeFunction(doc, lastConfirmedOrder.orderId).catch(function (e) {
    console.warn("Subida PDF al bucket fallo:", e);
  });
}

// Helper: convierte el doc jsPDF a base64 y lo manda a la edge function
// subir-pedido-pdf con el JWT del usuario actual. Best-effort: cualquier
// error se loguea pero no se propaga al caller.
async function _enviarPDFAEdgeFunction(doc, orderId) {
  if (!orderId || !doc) return;
  try {
    // Obtener token de sesion del usuario logueado.
    const sessRes = await supabaseClient.auth.getSession();
    const token = sessRes?.data?.session?.access_token;
    if (!token) {
      console.warn("Subir PDF: no hay sesion auth, skip");
      return;
    }

    // Convertir doc a base64.
    // jsPDF.output('datauristring') devuelve "data:application/pdf;filename=generated.pdf;base64,XXX..."
    // Tomamos solo la parte base64 despues de la coma.
    const dataUri = doc.output("datauristring");
    const idx = dataUri.indexOf("base64,");
    if (idx < 0) {
      console.warn("Subir PDF: no pude extraer base64 del doc");
      return;
    }
    const pdfBase64 = dataUri.slice(idx + 7);

    const url = SUPABASE_URL + "/functions/v1/subir-pedido-pdf";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ order_id: orderId, pdf_base64: pdfBase64 }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.warn("Subir PDF a edge fallo:", res.status, txt);
      return;
    }
    const data = await res.json();
    if (!data?.ok) {
      console.warn("Subir PDF: respuesta no ok", data);
      return;
    }
  } catch (e) {
    console.warn("Subir PDF excepcion:", e);
  }
}

// =========================================================
// Descargar comprobante de un pedido ya guardado
// =========================================================
async function descargarComprobantePedido(orderId) {
  try {
    if (!orderId) {
      alert("No se encontró el pedido.");
      return;
    }

    var orderRow, itemsRows, custRow;

    // Si es vendedor (modo propio o actuando como cliente), usar RPC para
    // bypassear RLS — sirve también si el pedido es de su cartera
    var useVendorRPC = typeof isActualVendor === "function" && isActualVendor();

    if (useVendorRPC) {
      const { data: rpcData, error: rpcErr } = await supabaseClient.rpc(
        "vendor_get_order_full",
        { p_order_id: Number(orderId) },
      );
      if (rpcErr || !rpcData) {
        console.error("vendor_get_order_full err:", rpcErr);
        // Fallback a query directa por si el pedido es del propio vendedor
        const { data: fallbackOrder } = await supabaseClient
          .from("orders")
          .select("id, total, subtotal, payment_method, customer_id, created_at")
          .eq("id", orderId)
          .maybeSingle();
        if (!fallbackOrder) {
          alert("No se pudo leer el pedido.");
          return;
        }
        orderRow = fallbackOrder;
        const { data: fItems } = await supabaseClient
          .from("order_items")
          .select("product_id, cajas, uxb")
          .eq("order_id", orderId);
        itemsRows = fItems || [];
      } else {
        orderRow = rpcData.order || null;
        itemsRows = rpcData.items || [];
        custRow = rpcData.customer || null;
        if (!orderRow) {
          alert("No se pudo leer el pedido.");
          return;
        }
      }
    } else {
      const { data: orderRowDirect, error: orderErr } = await supabaseClient
        .from("orders")
        .select("id, total, subtotal, payment_method, customer_id")
        .eq("id", orderId)
        .single();

      if (orderErr || !orderRowDirect) {
        console.error("orderErr:", orderErr);
        alert("No se pudo leer el pedido.");
        return;
      }
      orderRow = orderRowDirect;

      const { data: itemsRowsDirect, error: itemsErr } = await supabaseClient
        .from("order_items")
        .select("product_id, cajas, uxb")
        .eq("order_id", orderId);

      if (itemsErr) {
        console.error("itemsErr:", itemsErr);
        alert("No se pudieron leer los ítems del pedido.");
        return;
      }
      itemsRows = itemsRowsDirect;
    }

    let customerName = customerProfile?.business_name || "";
    let codCliente = customerProfile?.cod_cliente || "";

    // Si vino del RPC con custRow, usar esa info preferentemente
    if (custRow) {
      customerName = custRow.business_name || customerName;
      codCliente = custRow.cod_cliente || codCliente;
    } else if (!customerName || !codCliente) {
      const { data: custRowDb, error: custErr } = await supabaseClient
        .from("customers")
        .select("business_name, cod_cliente")
        .eq("id", orderRow.customer_id)
        .maybeSingle();

      if (custErr) {
        console.error("custErr:", custErr);
      }

      customerName = custRowDb?.business_name || "";
      codCliente = custRowDb?.cod_cliente || "";
    }

    const productIds = (itemsRows || [])
      .map((r) => r.product_id)
      .filter(Boolean);

    let productsMap = new Map();

    if (productIds.length) {
      const { data: prods, error: prodsErr } = await supabaseClient
        .from("products")
        .select("id, cod, description, list_price, list2_price")
        .in("id", productIds);

      if (prodsErr) {
        console.error("prodsErr:", prodsErr);
      } else {
        productsMap = new Map((prods || []).map((p) => [String(p.id), p]));
      }
    }

    const orderItems = (itemsRows || []).map((it) => {
      const prod = productsMap.get(String(it.product_id)) || {};
      const unidades = Number(it.cajas || 0) * Number(it.uxb || 0);
      const listUnit = Number(getPriceForCustomer(prod) || 0);

      const tuPrecioUnit = isAdmin
        ? listUnit
        : listUnit * (1 - getDtoVol()) * (1 - WEB_ORDER_DISCOUNT);

      // Si el pedido es anterior al rename del producto, mostramos el cod viejo
      // (tal cual lo conoció el cliente al hacer el pedido).
      const displayedCod = legacyCodForOrder(
        String(it.product_id || ""),
        prod.cod || "",
        orderRow.created_at,
      );

      return {
        cod: displayedCod,
        description: prod.description || "",
        cajas: Number(it.cajas || 0),
        unidades,
        tu_precio_unit: tuPrecioUnit,
        sub_total: tuPrecioUnit * unidades,
        list_price_unit: listUnit,
        list_sub_total: listUnit * unidades,
      };
    });

    const listSubtotal = orderItems.reduce(
      (acc, it) => acc + Number(it.list_sub_total || 0),
      0,
    );

    lastConfirmedOrder = {
      orderId: orderRow.id,
      customerName,
      codCliente,
      sucursalEntrega: "",
      metodoPago: orderRow.payment_method || "",
      subtotal: Number(orderRow.subtotal || 0),
      listSubtotal: listSubtotal,
      descuentos: Math.max(
        0,
        Number(orderRow.subtotal || 0) - Number(orderRow.total || 0),
      ),
      total: Number(orderRow.total || 0),
      items: orderItems,
      paymentDiscount: parsePaymentDiscountFromText(
        orderRow.payment_method || "",
      ),
      webDiscount: isAdmin ? 0 : WEB_ORDER_DISCOUNT,
      dtoVol: getDtoVol(),
    };

    await descargarPedidoPDF();
  } catch (err) {
    console.error("descargarComprobantePedido error:", err);
    alert("No se pudo descargar el comprobante.");
  }
}

async function openMyOrders() {
  await openProfile();
}
window.openMyOrders = openMyOrders;

function openChangePassword() {
  if (!currentSession) {
    openLogin();
    return;
  }

  showSection("perfil");
  closeUserMenu?.();

  // ✅ abrir usando la función global del modal (la del PASO 1)
  // Esperamos 1 tick para asegurar que el DOM del perfil esté visible
  setTimeout(() => {
    if (typeof window.openPassModal === "function") {
      window.openPassModal();
    } else {
      // fallback por si algo falló
      const passModal = document.getElementById("passModal");
      if (passModal) {
        passModal.classList.remove("hidden");
        passModal.setAttribute("aria-hidden", "false");
        document.getElementById("newPass1")?.focus();
      }
    }
  }, 0);
}
window.openChangePassword = openChangePassword;

function openPassModal() {
  const passModal = document.getElementById("passModal");
  if (!passModal) return;

  passModal.classList.add("open"); // ✅ clave
  passModal.classList.remove("hidden"); // por si existe
  passModal.setAttribute("aria-hidden", "false");

  document.getElementById("newPass1")?.focus();
}

function closePassModal() {
  const passModal = document.getElementById("passModal");
  if (!passModal) return;

  passModal.classList.remove("open"); // ✅ clave
  passModal.classList.add("hidden");
  passModal.setAttribute("aria-hidden", "true");
}

function togglePassword(inputId, btnEl) {
  const input = document.getElementById(inputId);
  if (!input || !btnEl) return;

  const isHidden = input.type === "password";
  input.type = isHidden ? "text" : "password";
  btnEl.setAttribute("data-show", isHidden ? "1" : "0");
}

/***********************
 * INIT (arranque de la web) — CORREGIDO ✅
 ***********************/

/***********************
 * LINKED CUSTOMERS (Vendedores / Multi-RS)
 ***********************/
let linkedCustomers = [];

async function loadLinkedCustomers() {
  if (!currentSession) {
    linkedCustomers = [];
    return;
  }

  // Traer vendedores y grupos en paralelo
  var [vendorRes, groupRes] = await Promise.all([
    supabaseClient.rpc("get_my_linked_customers"),
    supabaseClient.rpc("get_my_group_customers"),
  ]);

  if (vendorRes.error)
    console.error("loadLinkedCustomers (vendor) error:", vendorRes.error);
  if (groupRes.error)
    console.error("loadLinkedCustomers (group) error:", groupRes.error);

  var vendorList = vendorRes.error ? [] : vendorRes.data || [];
  var groupList = groupRes.error ? [] : groupRes.data || [];

  // Fusionar sin duplicar por customer_id (vendedor tiene prioridad)
  var seen = {};
  var merged = [];
  vendorList.forEach(function (c) {
    if (!seen[c.customer_id]) {
      seen[c.customer_id] = true;
      merged.push(c);
    }
  });
  groupList.forEach(function (c) {
    if (!seen[c.customer_id]) {
      seen[c.customer_id] = true;
      merged.push(c);
    }
  });

  linkedCustomers = merged;

  // Diagnóstico: log compacto para detectar por qué el dropdown "Pedir para"
  // podría no aparecer (renderCustomerSelector hace early return si length===0)
  console.log("[loadLinkedCustomers]", {
    user: currentSession?.user?.id,
    vendorRPC_count: vendorList.length,
    groupRPC_count: groupList.length,
    merged_count: merged.length,
    vendorRPC_error: vendorRes.error,
    groupRPC_error: groupRes.error,
  });

  // Mostrar/ocultar entry "Notificaciones" en dropdown según si es vendedor
  if (typeof updateMenuNotifVisibility === "function") {
    updateMenuNotifVisibility();
    // Y precargar las notifs en background para tener el contador al día
    if (linkedCustomers.length > 0) {
      loadVendorNotificationsUI().catch(function () {});
    }
  }
}

function isVendorProfile() {
  return linkedCustomers.length > 0;
}

var VENDOR_SELF_VALUE = "__vendor__";

function buildCustomerSelectOptions() {
  var html = "";
  // "Perfil vendedor" NO aparece — un vendedor nunca compra a su nombre.
  // EXCEPCIÓN: Loekemeyer SRL (cod 1) sí aparece como cliente (es la
  // propia empresa operando como vendedor interno y puede comprar).
  if (isActualVendor()) {
    var vCod = String((_vendorOwnProfile && _vendorOwnProfile.cod_cliente) || "");
    var vName = _vendorOwnProfile && _vendorOwnProfile.business_name;
    if (vCod === "1" && vName) {
      html +=
        '<option value="' +
        VENDOR_SELF_VALUE +
        '">' +
        vName +
        " (" +
        vCod +
        ")</option>";
    }
  }
  html += '<option value="" disabled hidden>Elegir razon social...</option>';
  linkedCustomers.forEach(function (c) {
    html +=
      '<option value="' +
      c.customer_id +
      '">' +
      c.business_name +
      " (" +
      c.cod_cliente +
      ")</option>";
  });
  return html;
}

// Datos estructurados (en vez de HTML) para alimentar tanto el <select> oculto
// como el dropdown custom.
function buildCustomerOptionsData(opts) {
  opts = opts || {};
  var forCart = !!opts.forCart;
  var data = [];
  // "Perfil vendedor" aparece SOLO en el banner del inicio de mayorista
  // (para que el vendedor pueda navegar su propio perfil). En el carrito
  // NO aparece (un vendedor no puede hacer un pedido a su nombre).
  // EXCEPCIÓN: Loekemeyer SRL (cod 1) sí aparece en ambos lados (es la
  // empresa operando como vendedor interno y puede comprar).
  if (isActualVendor()) {
    var vCod = String((_vendorOwnProfile && _vendorOwnProfile.cod_cliente) || "");
    var vName = _vendorOwnProfile && _vendorOwnProfile.business_name;
    var isLoke = vCod === "1" && vName;
    if (isLoke) {
      data.push({
        value: VENDOR_SELF_VALUE,
        label: vName + " (" + vCod + ")",
        disabled: false,
        hidden: false,
      });
    } else if (!forCart) {
      // Vendedor común: "Perfil vendedor" YA NO va en la lista del dropdown.
      // Lo maneja el tick clickeable que está POR FUERA del dropdown
      // (buildVendorProfileTick). Igual dejamos la opción en el <select> oculto
      // (hidden:true) para poder setear el value VENDOR_SELF_VALUE desde el tick.
      data.push({
        value: VENDOR_SELF_VALUE,
        label: "Perfil vendedor",
        disabled: false,
        hidden: true,
      });
    }
  }
  data.push({
    value: "",
    label: "Elegir razon social...",
    disabled: true,
    hidden: true,
  });
  linkedCustomers.forEach(function (c) {
    data.push({
      value: c.customer_id,
      label: c.business_name + " (" + c.cod_cliente + ")",
      disabled: false,
      hidden: false,
    });
  });
  return data;
}

// Escape HTML para inyectar texto en innerHTML sin XSS
function _csEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Crea un dropdown custom (div + lista) que reemplaza al <select> nativo.
 * Mantiene un <select> oculto con el `targetId` para compatibilidad con el
 * resto del código que lee `document.getElementById(id).value`.
 *
 * Fix bug Chrome + Win dark mode: el popup nativo de <select> se renderea
 * con tema dark un frame antes de aplicar custom CSS → flicker negro.
 * Con dropdown custom no hay widget nativo → sin flicker.
 */
function _csCreateDropdown(targetId, optionsData, currentValue, extraClass, opts) {
  opts = opts || {};
  var searchable = !!opts.searchable;
  var wrap = document.createElement("div");
  wrap.className = "cs-dropdown" + (extraClass ? " " + extraClass : "");
  wrap.dataset.target = targetId;

  // Encuentra label de la opción seleccionada
  var selOpt = optionsData.find(function (o) {
    return o.value === currentValue;
  });
  var labelText = selOpt ? selOpt.label : "Elegir razon social...";

  // <select> oculto para parity con código existente que lee .value
  var hiddenSel = document.createElement("select");
  hiddenSel.id = targetId;
  hiddenSel.className = "cs-hidden-select";
  hiddenSel.tabIndex = -1;
  hiddenSel.setAttribute("aria-hidden", "true");
  hiddenSel.innerHTML = optionsData
    .map(function (o) {
      var attrs = "";
      if (o.disabled) attrs += " disabled";
      if (o.hidden) attrs += " hidden";
      return (
        '<option value="' +
        _csEscape(o.value) +
        '"' +
        attrs +
        ">" +
        _csEscape(o.label) +
        "</option>"
      );
    })
    .join("");
  hiddenSel.value = currentValue || "";
  hiddenSel.addEventListener("change", onAnyCustomerSelectChange);

  // Trigger button
  var trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "cs-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.innerHTML =
    '<span class="cs-trigger-label">' +
    _csEscape(labelText) +
    "</span>" +
    '<span class="cs-trigger-arrow" aria-hidden="true">▾</span>';

  // Popup
  var popup = document.createElement("div");
  popup.className = "cs-popup";
  popup.setAttribute("role", "listbox");
  popup.hidden = true;

  // Buscador opcional (solo dropdowns "Pedir para"): filtra por nombre o
  // cod_cliente. El label de cada opción ya es "Nombre (cod)", así que basta
  // con matchear el textContent.
  var searchHTML = searchable
    ? '<div class="cs-search">' +
      '<input type="text" class="cs-search-input" placeholder="Buscar por nombre o código…" autocomplete="off" spellcheck="false" />' +
      "</div>"
    : "";

  var optionsHTML = optionsData
    .filter(function (o) {
      return !o.hidden;
    })
    .map(function (o) {
      var selectedAttr =
        o.value === currentValue ? ' data-selected="true"' : "";
      var disabledAttr = o.disabled ? " disabled" : "";
      return (
        '<button type="button" class="cs-option" role="option" data-value="' +
        _csEscape(o.value) +
        '"' +
        selectedAttr +
        disabledAttr +
        ">" +
        _csEscape(o.label) +
        "</button>"
      );
    })
    .join("");

  popup.innerHTML =
    searchHTML +
    optionsHTML +
    (searchable ? '<div class="cs-no-results" hidden>Sin resultados</div>' : "");

  wrap.appendChild(trigger);
  wrap.appendChild(popup);
  wrap.appendChild(hiddenSel);

  _csWireDropdown(wrap);
  _csUpdateVendorCheck(wrap);

  return wrap;
}

// El tick "Perfil vendedor" ahora vive POR FUERA del dropdown (chip clickeable).
// Esta función se conserva como hook desde los refrescos del dropdown y
// simplemente re-sincroniza el estado del tick externo.
function _csUpdateVendorCheck(wrap) {
  if (typeof updateVendorProfileTick === "function") updateVendorProfileTick();
}

// Vendedor "común" (sintético 100xx) — NO Loke (cod 1, que compra como empresa).
// Solo estos ven el tick "Perfil vendedor" por fuera del dropdown.
function isCommonVendor() {
  return (
    isActualVendor() &&
    String((_vendorOwnProfile && _vendorOwnProfile.cod_cliente) || "") !== "1"
  );
}

// Click en el tick → ir a Perfil vendedor (setea VENDOR_SELF_VALUE y dispara
// el flujo normal de cambio de cliente).
function onVendorTickClick() {
  var sel = document.getElementById("customerSelect");
  if (!sel) return;
  sel.value = VENDOR_SELF_VALUE;
  if (typeof _csRefreshDropdownVisual === "function") _csRefreshDropdownVisual(sel);
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  updateVendorProfileTick();
}

// Construye el chip tick "Perfil vendedor" como pill independiente al lado
// del banner "Pedir para". Solo para vendedor común.
// Crea (o devuelve) la "zona vendedor": una COLUMNA donde la fila superior tiene
// el banner "Pedir para" + el tick "Perfil vendedor" en la MISMA línea, y el
// selector de sucursal va debajo. Mueve el banner adentro de la fila superior.
function _ensureVendorZone() {
  var banner = document.getElementById("customerSelectorBanner");
  if (!banner) return null;
  var zone = document.getElementById("csVendorZone");
  if (zone) return zone;
  var parent = banner.parentNode;
  if (!parent) return null;
  zone = document.createElement("div");
  zone.id = "csVendorZone";
  zone.className = "cs-vendor-zone";
  var top = document.createElement("div");
  top.id = "csVendorTop";
  top.className = "cs-vendor-top";
  parent.insertBefore(zone, banner); // zone toma el lugar del banner
  top.appendChild(banner); // banner en la fila superior
  zone.appendChild(top);
  return zone;
}

function getVendorTop() {
  _ensureVendorZone();
  return document.getElementById("csVendorTop");
}

function buildVendorProfileTick(banner) {
  var oldTick = document.getElementById("vendorProfileTickWrap");
  if (oldTick) oldTick.remove();
  if (!banner || !isCommonVendor()) return;

  var btn = document.createElement("button");
  btn.type = "button";
  btn.id = "vendorProfileTickWrap";
  btn.className = "vendor-profile-tick";
  btn.setAttribute("role", "checkbox");
  btn.setAttribute("aria-checked", "false");
  btn.title = "Tildá para navegar tu Perfil vendedor. Elegí un cliente para destildar.";
  btn.innerHTML =
    '<span class="vpt-box" aria-hidden="true">✓</span>' +
    '<span class="vpt-label">Perfil vendedor</span>';
  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    onVendorTickClick();
  });

  // El tick va en la MISMA línea que "Pedir para" (fila superior de la zona).
  var top = getVendorTop();
  if (top) top.appendChild(btn);
  else if (banner.parentNode)
    banner.parentNode.appendChild(btn);
  updateVendorProfileTick();
}

// Sincroniza el estado tildado del tick con el cliente activo.
function updateVendorProfileTick() {
  var btn = document.getElementById("vendorProfileTickWrap");
  if (!btn) return;
  var sel = document.getElementById("customerSelect");
  var active = !!(sel && sel.value === VENDOR_SELF_VALUE);
  btn.classList.toggle("checked", active);
  btn.setAttribute("aria-checked", active ? "true" : "false");
}

// Filtra las opciones del popup por nombre o cod_cliente (case/acento-insensible).
function _csFilterOptions(wrap, query) {
  if (!wrap) return;
  var popup = wrap.querySelector(".cs-popup");
  if (!popup) return;
  var norm = function (s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
  };
  var q = norm(query).trim();
  var anyVisible = false;
  popup.querySelectorAll(".cs-option").forEach(function (o) {
    // El header/placeholder (disabled, value vacío) se oculta mientras se busca.
    if (o.disabled && o.getAttribute("data-value") === "") {
      o.hidden = q.length > 0;
      return;
    }
    var match = !q || norm(o.textContent).indexOf(q) !== -1;
    o.hidden = !match;
    if (match) anyVisible = true;
  });
  var noRes = popup.querySelector(".cs-no-results");
  if (noRes) noRes.hidden = anyVisible;
}

function _csWireDropdown(wrap) {
  var trigger = wrap.querySelector(".cs-trigger");
  var popup = wrap.querySelector(".cs-popup");
  var hiddenSel = wrap.querySelector(".cs-hidden-select");
  if (!trigger || !popup || !hiddenSel) return;

  var searchInput = wrap.querySelector(".cs-search-input");

  trigger.addEventListener("click", function (e) {
    e.stopPropagation();
    var isOpen = !popup.hidden;
    _csCloseAllPopups();
    if (!isOpen) {
      popup.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      // Al abrir: limpiar el buscador y mostrar toda la lista de nuevo.
      if (searchInput) {
        searchInput.value = "";
        _csFilterOptions(wrap, "");
        _csUpdateVendorCheck(wrap);
        // Foco diferido para no chocar con el cierre por click global.
        setTimeout(function () {
          searchInput.focus();
        }, 0);
      }
      var sel = popup.querySelector('.cs-option[data-selected="true"]');
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
    }
  });

  if (searchInput) {
    // Clicks dentro del buscador no deben cerrar el popup ni seleccionar.
    var searchWrap = searchInput.closest(".cs-search");
    if (searchWrap) {
      searchWrap.addEventListener("click", function (e) {
        e.stopPropagation();
      });
    }
    searchInput.addEventListener("click", function (e) {
      e.stopPropagation();
    });
    searchInput.addEventListener("keydown", function (e) {
      e.stopPropagation();
      // Enter: si hay una sola opción visible, seleccionarla.
      if (e.key === "Enter") {
        e.preventDefault();
        var visible = Array.prototype.filter.call(
          popup.querySelectorAll(".cs-option"),
          function (o) {
            return !o.hidden && !o.disabled;
          }
        );
        if (visible.length === 1) visible[0].click();
      }
    });
    searchInput.addEventListener("input", function () {
      _csFilterOptions(wrap, searchInput.value);
      // El tick de "Perfil vendedor" se saca apenas el vendedor escribe.
      _csUpdateVendorCheck(wrap);
    });
  }

  popup.addEventListener("click", function (e) {
    var opt = e.target.closest(".cs-option");
    if (!opt || opt.disabled) return;
    e.stopPropagation();
    var value = opt.dataset.value;
    var label = opt.textContent;

    // Update visual
    trigger.querySelector(".cs-trigger-label").textContent = label;
    popup.querySelectorAll(".cs-option").forEach(function (o) {
      delete o.dataset.selected;
    });
    opt.dataset.selected = "true";

    // Update hidden select + dispatch change para que onAnyCustomerSelectChange corra
    hiddenSel.value = value;
    hiddenSel.dispatchEvent(new Event("change", { bubbles: true }));

    // Refrescar visual desde el value actual del hiddenSel — si el change
    // handler reseteó el value (ej. "+ Agregar sucursal" → vuelve al slot
    // anterior), el trigger debe reflejar eso.
    _csRefreshDropdownVisual(hiddenSel);
    _csUpdateVendorCheck(wrap);

    // Cerrar
    popup.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  });
}

function _csCloseAllPopups() {
  document.querySelectorAll(".cs-popup").forEach(function (p) {
    if (!p.hidden) {
      p.hidden = true;
      var t = p.parentElement && p.parentElement.querySelector(".cs-trigger");
      if (t) t.setAttribute("aria-expanded", "false");
    }
  });
}

// Refresca el visual del dropdown custom desde el valor del hidden select
function _csRefreshDropdownVisual(hiddenSel) {
  if (!hiddenSel) return;
  var wrap = hiddenSel.closest(".cs-dropdown");
  if (!wrap) return;
  var val = hiddenSel.value;
  var triggerLabel = wrap.querySelector(".cs-trigger-label");
  var popup = wrap.querySelector(".cs-popup");
  if (!triggerLabel || !popup) return;

  var placeholder = wrap.dataset.placeholder || "Elegir razon social...";
  var newLabel = placeholder;
  var found = false;
  popup.querySelectorAll(".cs-option").forEach(function (o) {
    delete o.dataset.selected;
    if (o.dataset.value === val) {
      o.dataset.selected = "true";
      newLabel = o.textContent;
      found = true;
    }
  });
  // Fallback: si el value no está en el popup (ej. "Perfil vendedor", que es una
  // opción oculta del <select>), usar el texto de la opción del select oculto.
  if (!found && val) {
    var opt = Array.prototype.find.call(hiddenSel.options, function (o) {
      return o.value === val;
    });
    if (opt) newLabel = opt.textContent;
  }
  triggerLabel.textContent = newLabel;
  _csUpdateVendorCheck(wrap);
}

/**
 * Reconstruye el popup del dropdown custom desde las <option> actuales del
 * hidden <select>. Útil cuando el código existente repuebla el select nativo
 * dinámicamente (ej. loadDeliveryOptions). Mantiene marca data-selected y
 * sincroniza el label del trigger.
 */
function _csSyncPopupFromHidden(hiddenSel) {
  if (typeof hiddenSel === "string") hiddenSel = document.getElementById(hiddenSel);
  if (!hiddenSel) return;
  var wrap = hiddenSel.closest(".cs-dropdown");
  if (!wrap) return;
  var popup = wrap.querySelector(".cs-popup");
  if (!popup) return;

  var currentVal = hiddenSel.value || "";
  var html = "";
  Array.from(hiddenSel.options).forEach(function (o) {
    if (o.hidden) return;
    var selectedAttr = o.value === currentVal ? ' data-selected="true"' : "";
    var disabledAttr = o.disabled ? " disabled" : "";
    html +=
      '<button type="button" class="cs-option" role="option" data-value="' +
      _csEscape(o.value) +
      '"' +
      selectedAttr +
      disabledAttr +
      ">" +
      _csEscape(o.textContent) +
      "</button>";
  });
  popup.innerHTML = html;
  _csRefreshDropdownVisual(hiddenSel);
}

/**
 * Envuelve un <select> nativo existente con la UI del custom dropdown CS.
 * El <select> queda como hidden-select (el id permanece, las options siguen
 * siendo legibles vía .options[idx].dataset.*). Trigger + popup se renderizan
 * encima. Pensado para `shippingSelect` que tiene options dinámicas.
 *
 * opts:
 *   placeholder  — texto cuando value vacío (default "Elegir...")
 *   extraClass   — clase extra para .cs-dropdown (ej. "cs-dropdown-banner")
 */
function _csWrapNativeSelect(selectEl, opts) {
  if (!selectEl || selectEl.classList.contains("cs-hidden-select")) return;
  opts = opts || {};
  var placeholder = opts.placeholder || "Elegir...";
  var extraClass = opts.extraClass || "";

  var wrap = document.createElement("div");
  wrap.className = "cs-dropdown" + (extraClass ? " " + extraClass : "");
  wrap.dataset.target = selectEl.id;
  wrap.dataset.placeholder = placeholder;

  // Trigger
  var trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "cs-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.innerHTML =
    '<span class="cs-trigger-label">' +
    _csEscape(placeholder) +
    "</span>" +
    '<span class="cs-trigger-arrow" aria-hidden="true">▾</span>';

  // Popup vacío (se llena via _csSyncPopupFromHidden)
  var popup = document.createElement("div");
  popup.className = "cs-popup";
  popup.setAttribute("role", "listbox");
  popup.hidden = true;

  // Reemplazar select en DOM: el wrap toma su lugar, el select pasa adentro
  var parent = selectEl.parentNode;
  parent.insertBefore(wrap, selectEl);
  selectEl.classList.add("cs-hidden-select");
  selectEl.tabIndex = -1;
  selectEl.setAttribute("aria-hidden", "true");
  wrap.appendChild(trigger);
  wrap.appendChild(popup);
  wrap.appendChild(selectEl);

  _csWireDropdown(wrap);
  _csSyncPopupFromHidden(selectEl);
  return wrap;
}

// Helper para setear valor programáticamente (sincroniza hidden select +
// refresca visual del dropdown custom). Usar en lugar de `el.value = X` directo.
function _csSetValue(id, value) {
  var el = document.getElementById(id);
  if (!el) return;
  el.value = value;
  _csRefreshDropdownVisual(el);
}

// Listeners globales (una sola vez): click fuera + Escape + scroll cierran popups
if (typeof window !== "undefined" && !window.__csGlobalWired) {
  document.addEventListener("click", function () {
    _csCloseAllPopups();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") _csCloseAllPopups();
  });
  // Cerrar al scrollear (el popup queda en posición rara si el trigger se mueve)
  window.addEventListener(
    "scroll",
    function () {
      _csCloseAllPopups();
    },
    { passive: true },
  );
  window.__csGlobalWired = true;
}

function syncCustomerSelectors(sourceId) {
  var source = document.getElementById(sourceId);
  if (!source) return;
  var val = source.value;
  ["customerSelect", "customerSelectCart"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el && el.id !== sourceId) {
      // Si el target no tiene esa option (ej. customerSelectCart no incluye
      // VENDOR_SELF_VALUE para vendedor común), resetear a "".
      var hasOption = Array.from(el.options).some(function (o) {
        return o.value === val;
      });
      el.value = hasOption ? val : "";
      _csRefreshDropdownVisual(el);
    }
  });
}

function onAnyCustomerSelectChange(e) {
  // Reset del botón "Confirmada" → "Confirmar" cuando cambia el cliente —
  // forzar al vendedor a re-confirmar la nueva razón social.
  var custConfirmReset = document.getElementById("customerConfirmBtn");
  if (custConfirmReset && custConfirmReset.classList.contains("confirmed")) {
    custConfirmReset.classList.remove("confirmed");
    custConfirmReset.textContent = "Confirmar";
    custConfirmReset.disabled = false;
  }
  syncCustomerSelectors(e.target.id);
  updateVendorProfileTick();
  onLinkedCustomerSelected();
}

function renderCustomerSelector() {
  var existing = document.getElementById("customerSelectorBanner");
  if (existing) existing.remove();

  var existingCart = document.getElementById("customerSelectorCart");
  if (existingCart) existingCart.remove();

  // Limpiar la zona del vendedor (col PEDIR PARA + sucursal + tick) si quedó
  // de un render previo — así no se reusa un wrapper vacío.
  var existingZone = document.getElementById("csVendorZone");
  if (existingZone) existingZone.remove();

  // EXPO: reemplaza el selector "Elegir razón social" por la barra
  // [Elegir cliente] [+ Nuevo cliente]. Solo para el operador admin.
  if (EXPO_MODE && isAdmin) {
    renderExpoEntryBar();
    return;
  }

  if (!linkedCustomers.length) return;

  // Banner del inicio: incluye "Perfil vendedor" para vendedor común
  // (les permite navegar su propio perfil sin elegir cliente).
  var optionsData = buildCustomerOptionsData();
  // Carrito: NO incluye "Perfil vendedor" para vendedor común
  // (vendedor no puede hacer un pedido a su nombre).
  var optionsDataCart = buildCustomerOptionsData({ forCart: true });

  // Default = "" (placeholder "Elegir razón social..."). La selección real
  // viene de localStorage via restoreSelectedCustomerIfAny() que se ejecuta
  // después. Si el vendedor no eligió nada antes → queda en placeholder.
  // Solo si YA tenía un cliente cargado en customerProfile (no su propio
  // perfil), reflejarlo para no perder estado en re-renders intermedios.
  var isLinked =
    customerProfile &&
    linkedCustomers.some(function (c) {
      return c.customer_id === customerProfile.id;
    });
  var currentVal = isLinked ? customerProfile.id : "";

  // --- Banner on products page ---
  var banner = document.createElement("div");
  banner.id = "customerSelectorBanner";
  banner.className = "customer-selector-banner";

  var labelWrap = document.createElement("span");
  labelWrap.className = "cs-label-wrap";
  labelWrap.innerHTML =
    '<svg class="cs-icon" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-3.33 0-8 1.67-8 5v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1c0-3.33-4.67-5-8-5z" fill="currentColor"/>' +
    "</svg>" +
    '<span class="cs-label">Pedir para</span>';

  var dropdown = _csCreateDropdown(
    "customerSelect",
    optionsData,
    currentVal,
    "cs-dropdown-banner",
    { searchable: true },
  );

  banner.appendChild(labelWrap);
  banner.appendChild(dropdown);

  var section = document.getElementById("productos");
  if (section) {
    var sortRow = section.querySelector(".sort-row");
    if (sortRow) {
      sortRow.insertBefore(banner, sortRow.firstChild);
    } else {
      var titleRow = section.querySelector(".section-title-row");
      if (titleRow) {
        titleRow.parentNode.insertBefore(banner, titleRow.nextSibling);
      } else {
        section.insertBefore(banner, section.firstChild);
      }
    }
  }

  // --- Selector in cart (above shipping) ---
  var cartCard = document.createElement("div");
  cartCard.id = "customerSelectorCart";
  cartCard.className = "ship-row";

  var cartInner = document.createElement("div");
  // .has-confirm activa el grid 2col (dropdown + botón) — mismo patrón
  // que la card de "Indicar dirección de entrega".
  cartInner.className = "ship-card has-confirm";

  var cartLabel = document.createElement("label");
  cartLabel.className = "ship-label";
  cartLabel.textContent = "Pedir para (Razón Social)";
  cartInner.appendChild(cartLabel);

  // Si el usuario tenía "Perfil vendedor" como currentVal pero el cart
  // dropdown no lo incluye → resetear a "" para no mostrar valor inválido.
  var currentValCart =
    currentVal === VENDOR_SELF_VALUE &&
    !optionsDataCart.some(function (o) { return o.value === VENDOR_SELF_VALUE; })
      ? ""
      : currentVal;
  var cartDropdown = _csCreateDropdown(
    "customerSelectCart",
    optionsDataCart,
    currentValCart,
    "cs-dropdown-card cs-dropdown-ship",
    { searchable: true },
  );
  cartInner.appendChild(cartDropdown);

  // Botón Confirmar — al costado del dropdown (mismo look que ship-confirm-btn)
  var custConfirmBtn = document.createElement("button");
  custConfirmBtn.type = "button";
  custConfirmBtn.id = "customerConfirmBtn";
  custConfirmBtn.className = "ship-confirm-btn";
  custConfirmBtn.textContent = "Confirmar";
  custConfirmBtn.addEventListener("click", function () {
    var sel = document.getElementById("customerSelectCart");
    var v = sel ? String(sel.value || "").trim() : "";
    // Sólo confirma si hay un cliente real seleccionado (no placeholder
    // ni "Perfil Vendedor").
    if (!v || v === VENDOR_SELF_VALUE) return;
    this.textContent = "Confirmada";
    this.classList.add("confirmed");
    this.disabled = true;
    if (typeof refreshSubmitEnabled === "function") refreshSubmitEnabled();
    if (typeof updateCart === "function") updateCart();
  });
  cartInner.appendChild(custConfirmBtn);

  var cartHint = document.createElement("div");
  cartHint.className = "ship-hint";
  cartHint.textContent =
    "Seleccioná un cliente para poder confirmar el pedido.";
  cartInner.appendChild(cartHint);

  cartCard.appendChild(cartInner);

  var shipRow = document.querySelector("#carrito .ship-row");
  if (shipRow && shipRow.parentNode) {
    shipRow.parentNode.insertBefore(cartCard, shipRow);
  }

  // Tick "Perfil vendedor" por fuera del dropdown (vendedor común).
  var bannerEl = document.getElementById("customerSelectorBanner");
  if (bannerEl && typeof buildVendorProfileTick === "function") {
    buildVendorProfileTick(bannerEl);
  }

  // Info extra SOLO para el vendedor 10006 (CUIT + expreso, localidad,
  // selector de sucursal en el banner). Idempotente.
  if (typeof updateVendor10006Info === "function") updateVendor10006Info();
}

/***********************
 * EXTRAS VENDEDOR 10006
 * CUIT + expreso bajo "Pedir para", localidad bajo dirección de entrega, y
 * selector de sucursal en el banner. Todo gateado a cod_cliente 10006.
 ***********************/
function isVendor10006() {
  return !!(
    _vendorOwnProfile &&
    String(_vendorOwnProfile.cod_cliente) === "10006"
  );
}

// Formatea CUIT de 11 dígitos como XX-XXXXXXXX-X.
function fmtCuit(cuit) {
  var d = String(cuit || "").replace(/\D/g, "");
  if (d.length === 11) return d.slice(0, 2) + "-" + d.slice(2, 10) + "-" + d.slice(10);
  return String(cuit || "").trim();
}

// Cache por customer_id de la RPC get_customer_geo.
var _geoCache = {};
async function loadCustomerGeo(customerId) {
  if (!customerId) return [];
  if (_geoCache[customerId]) return _geoCache[customerId];
  try {
    var res = await supabaseClient.rpc("get_customer_geo", {
      p_customer_id: customerId,
    });
    if (res.error) {
      console.warn("[geo] get_customer_geo error:", res.error.message);
      return [];
    }
    _geoCache[customerId] = res.data || [];
    return _geoCache[customerId];
  } catch (e) {
    console.warn("[geo] get_customer_geo ex:", e);
    return [];
  }
}

function _geoForSlot(geoRows, slot) {
  if (!geoRows || !geoRows.length) return null;
  var s = String(slot);
  return (
    geoRows.find(function (g) {
      return String(g.slot) === s;
    }) || null
  );
}

function _v10006Remove() {
  ["v10006CustInfo", "v10006ShipGeo", "sucursalBannerWrap"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.remove();
  });
}

// Setea deliveryChoice desde una <option> de sucursal (banner) cuando el
// carrito todavía no construyó su shippingSelect.
function _setDeliveryFromOpt(slot, opt) {
  deliveryChoice.slot = slot;
  deliveryChoice.label = (opt && opt.dataset.label) || "";
  deliveryChoice.zonaExpreso = (opt && opt.dataset.zonaExpreso) || "";
  deliveryChoice.direccionEntrega = (opt && opt.dataset.direccionEntrega) || "";
  if (typeof updateCart === "function") updateCart();
  if (typeof refreshSubmitEnabled === "function") refreshSubmitEnabled();
}

// Cambio en el selector de sucursal del banner → sincroniza con el carrito.
function onBannerSucursalChange(sel) {
  var slot = String(sel.value || "").trim();
  if (!slot) return;
  var opt = sel.options[sel.selectedIndex];
  var shipSel = document.getElementById("shippingSelect");
  var hasInShip =
    shipSel &&
    Array.prototype.some.call(shipSel.options, function (o) {
      return o.value === slot;
    });
  if (hasInShip) {
    // Reusar el flujo del carrito: setea deliveryChoice, resetea confirm, etc.
    shipSel.value = slot;
    if (typeof _csRefreshDropdownVisual === "function") _csRefreshDropdownVisual(shipSel);
    shipSel.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    _setDeliveryFromOpt(slot, opt);
  }
  updateVendor10006Info();
}

// Construye/actualiza el selector de sucursal del banner.
function buildBannerSucursal(banner, geoRows) {
  var old = document.getElementById("sucursalBannerWrap");
  if (old) old.remove();
  if (!banner || !geoRows || geoRows.length === 0) return;

  var wrap = document.createElement("div");
  wrap.id = "sucursalBannerWrap";
  wrap.className = "cs-suc-banner";

  // Segmento oscuro con ícono de pin + acento rojo (mismo look que "PEDIR PARA").
  var lbl = document.createElement("span");
  lbl.className = "cs-suc-label-wrap";
  lbl.innerHTML =
    '<svg class="cs-suc-icon" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z" fill="currentColor"/>' +
    "</svg>" +
    '<span class="cs-suc-label">Sucursal cliente</span>';
  wrap.appendChild(lbl);

  // Insertar DEBAJO de la fila superior (Pedir para + tick), dentro de la zona.
  var insertSuc = function () {
    var zone = _ensureVendorZone();
    if (zone) zone.appendChild(wrap);
    else if (banner.parentNode)
      banner.parentNode.insertBefore(wrap, banner.nextSibling);
  };

  if (geoRows.length === 1) {
    // Una sola sucursal → texto fijo (no dropdown).
    var g = geoRows[0];
    var txt = document.createElement("span");
    txt.className = "cs-suc-text";
    txt.textContent = g.label || "Sucursal " + g.slot;
    wrap.appendChild(txt);
    insertSuc();
    return;
  }

  // 2+ sucursales → dropdown.
  var sel = document.createElement("select");
  sel.id = "sucursalBannerSelect";
  var ph = document.createElement("option");
  ph.value = "";
  ph.disabled = true;
  ph.hidden = true;
  ph.textContent = "Elegir sucursal…";
  sel.appendChild(ph);
  geoRows.forEach(function (g) {
    var o = document.createElement("option");
    o.value = String(g.slot);
    o.textContent = g.slot + ": " + (g.label || "");
    o.dataset.label = g.label || "";
    o.dataset.zonaExpreso = g.zona_expreso || "";
    o.dataset.direccionEntrega = g.direccion_entrega || "";
    sel.appendChild(o);
  });
  sel.value = deliveryChoice && deliveryChoice.slot ? String(deliveryChoice.slot) : "";
  sel.addEventListener("change", function () {
    onBannerSucursalChange(sel);
  });
  wrap.appendChild(sel);
  insertSuc();

  if (typeof _csWrapNativeSelect === "function") {
    _csWrapNativeSelect(sel, {
      placeholder: "Elegir sucursal…",
      extraClass: "cs-dropdown-banner-suc",
    });
  }
}

// Actualiza la info del carrito (CUIT/expreso + provincia) para TODOS los
// vendedores, y el selector de sucursal del banner SOLO para 10006.
async function updateVendor10006Info() {
  // Info del carrito: cualquier vendedor real con un cliente elegido.
  if (!isActualVendor()) {
    _v10006Remove();
    return;
  }
  var cust = customerProfile;
  var isOwn =
    cust && _vendorOwnProfile && String(cust.id) === String(_vendorOwnProfile.id);
  if (!cust || !cust.id || isOwn) {
    _v10006Remove();
    return;
  }

  var geoRows = await loadCustomerGeo(cust.id);

  // Punto 3: selector de sucursal en el banner — SOLO para 10006.
  var banner = document.getElementById("customerSelectorBanner");
  if (banner) {
    if (isVendor10006()) {
      buildBannerSucursal(banner, geoRows);
    } else {
      var sbOld = document.getElementById("sucursalBannerWrap");
      if (sbOld) sbOld.remove();
    }
  }

  // Slot activo (el elegido, o el único si hay una sola sucursal).
  var activeSlot =
    deliveryChoice && deliveryChoice.slot
      ? String(deliveryChoice.slot)
      : geoRows.length === 1
        ? String(geoRows[0].slot)
        : "";
  var activeGeo =
    _geoForSlot(geoRows, activeSlot) ||
    (geoRows.length === 1 ? geoRows[0] : null);

  // Si el carrito ya tiene el shippingSelect y hay un slot activo, reflejarlo.
  var shipSel = document.getElementById("shippingSelect");
  if (shipSel && activeSlot && shipSel.value !== activeSlot) {
    var hasOpt = Array.prototype.some.call(shipSel.options, function (o) {
      return o.value === activeSlot;
    });
    if (hasOpt) {
      shipSel.value = activeSlot;
      if (typeof _csRefreshDropdownVisual === "function") _csRefreshDropdownVisual(shipSel);
    }
  }

  // Punto 1: CUIT + expreso bajo "Pedir para" (carrito).
  var cartCard = document.querySelector("#customerSelectorCart .ship-card");
  if (cartCard) {
    var info = document.getElementById("v10006CustInfo");
    if (!info) {
      info = document.createElement("div");
      info.id = "v10006CustInfo";
      info.className = "v10006-info";
      // CUIT/BARRIO justo debajo del dropdown; el hint "Seleccioná un
      // cliente..." queda al final.
      var hintEl = cartCard.querySelector(".ship-hint");
      if (hintEl) cartCard.insertBefore(info, hintEl);
      else cartCard.appendChild(info);
    }
    var cuitTxt = fmtCuit(cust.cuit);
    // Si hay nombre_expreso → transporte ("Expreso"). Si no (cliente
    // local/CABA), se muestra el barrio (zona_expreso) con label "Barrio".
    var nombreExp = (activeGeo && activeGeo.nombre_expreso) || "";
    var zonaExp =
      (activeGeo && activeGeo.zona_expreso) ||
      (deliveryChoice && deliveryChoice.zonaExpreso) ||
      "";
    var field = function (k, v) {
      return (
        '<span class="v10006-field"><span class="v10006-k">' +
        _csEscape(k) +
        '</span><span class="v10006-v">' +
        _csEscape(v) +
        "</span></span>"
      );
    };
    var parts = [];
    if (cuitTxt) parts.push(field("CUIT", cuitTxt));
    if (nombreExp) parts.push(field("Expreso", nombreExp));
    else if (zonaExp) parts.push(field("Expreso", zonaExp));
    info.innerHTML = parts.join("");
    info.style.display = parts.length ? "" : "none";
  }

  // Punto 2: localidad (zona + provincia del mapa) bajo dirección de entrega.
  var shipCard = shipSel ? shipSel.closest(".ship-card") : null;
  if (shipCard) {
    var geoEl = document.getElementById("v10006ShipGeo");
    if (!geoEl) {
      geoEl = document.createElement("div");
      geoEl.id = "v10006ShipGeo";
      geoEl.className = "v10006-geo";
      shipCard.appendChild(geoEl);
    }
    if (activeGeo) {
      var prov =
        activeGeo.provincia && activeGeo.provincia !== "Sin provincia"
          ? activeGeo.provincia
          : "";
      // CABA / Buenos Aires → mostrar localidad (barrio/partido).
      // Otra provincia → mostrar solo la provincia.
      var loc = activeGeo.localidad ? String(activeGeo.localidad).trim() : "";
      var geoTxt =
        prov === "CABA" || prov === "Buenos Aires" ? loc || prov : prov;
      geoEl.innerHTML = geoTxt
        ? '<span class="v10006-geo-pin" aria-hidden="true">📍</span> ' +
          _csEscape(geoTxt)
        : "";
      geoEl.style.display = geoTxt ? "" : "none";
    } else {
      geoEl.innerHTML = "";
      geoEl.style.display = "none";
    }
  }
}

async function onLinkedCustomerSelected(opts) {
  opts = opts || {};
  // fromRestore: page load via restoreSelectedCustomerIfAny — NUNCA wipear
  // carrito ni mostrar confirm. Solo recargar el perfil del cliente actual.
  var fromRestore = !!opts.fromRestore;

  var sel = document.getElementById("customerSelect");
  var selCart = document.getElementById("customerSelectCart");
  // EXPO: se puede pasar el id del cliente explícito (elegido desde el popup),
  // sin depender del <select> visible.
  var val = opts.customerId || (sel && sel.value) || (selCart && selCart.value) || "";

  if (val === VENDOR_SELF_VALUE) {
    // Volver al perfil propio del vendedor — sin necesidad de refresh
    var prevCustomerIdSelf = customerProfile && customerProfile.id;
    var prevCustomerNameSelf = customerProfile && customerProfile.business_name;
    var newSelfId = _vendorOwnProfile && _vendorOwnProfile.id;
    var isRealChangeSelf =
      prevCustomerIdSelf &&
      newSelfId &&
      String(prevCustomerIdSelf) !== String(newSelfId);

    // Confirm si hay items en el carrito y es un cambio real (NO en fromRestore)
    if (!fromRestore && isRealChangeSelf && cart.length > 0) {
      var okSelf = window.confirm(
        "Vas a cambiar de " +
          (prevCustomerNameSelf || "cliente") +
          " a tu Perfil Vendedor. El carrito actual (" +
          cart.length +
          " items) se va a vaciar.\n\n¿Continuar?"
      );
      if (!okSelf) {
        // Revertir
        _csSetValue("customerSelect", String(prevCustomerIdSelf));
        _csSetValue("customerSelectCart", String(prevCustomerIdSelf));
        return;
      }
    }

    if (_vendorOwnProfile) {
      customerProfile = Object.assign({}, _vendorOwnProfile);
    }
    // Solo limpiar carrito si realmente cambió el cliente Y no es restore
    if (!fromRestore && isRealChangeSelf) {
      cart.splice(0, cart.length);
      saveCartToLS();
    }
    // Persistir Perfil Vendedor con marcador especial para restoreSelected*
    try {
      localStorage.setItem(
        "lk_vendor_selected_cod_cliente",
        VENDOR_SELF_VALUE,
      );
      localStorage.removeItem("lk_vendor_selected_business_name");
      localStorage.removeItem("lk_vendor_selected_dto_vol");
    } catch (e) {}

    var nameSelf = (customerProfile && customerProfile.business_name || "").trim();
    var helloElSelf = $("helloNavText");
    if (helloElSelf)
      helloElSelf.innerText = nameSelf ? "Hola, " + nameSelf + " !" : "Hola!";

    // Mantener el badge "Modo Administrador" si el vendedor logueado es admin
    // (ej. Loekemeyer SRL). Para vendedores no-admin, queda en "".
    var noteSelf = $("customerNote");
    if (noteSelf) {
      var dtoSelf = Number((customerProfile && customerProfile.dto_vol) || 0);
      if (isAdmin) {
        noteSelf.innerText = "Modo Administrador";
      } else if (dtoSelf > 0) {
        noteSelf.innerText = "Ya está aplicado tu Dto x Volumen";
      } else {
        noteSelf.innerText = "";
      }
    }

    // Resetear shipping/pago como cuando se cambia de cliente
    deliveryChoice = { slot: "", label: "" };
    var shipConfirmBtnSelf = $("shipConfirmBtn");
    if (shipConfirmBtnSelf) {
      var shipCardSelf = shipConfirmBtnSelf.closest(".ship-card");
      if (shipCardSelf) shipCardSelf.classList.remove("has-confirm");
      shipConfirmBtnSelf.remove();
    }
    var paySelSelf = $("paymentSelect");
    if (paySelSelf) paySelSelf.value = "";
    document.querySelectorAll("#paymentButtons .pay-btn").forEach(function (b) {
      b.classList.remove("selected", "active");
    });
    var payLaterBtnSelf = $("payLaterBtn");
    if (payLaterBtnSelf) payLaterBtnSelf.classList.remove("selected", "active");
    syncPaymentButtons();

    try {
      myAssortmentIds = await loadMyAssortmentIds();
    } catch (e) {}
    renderProducts();
    updateCart();
    fillProfileSummaryUI();
    refreshSubmitEnabled();
    if (typeof updateMenuNotifVisibility === "function") {
      updateMenuNotifVisibility();
    }
    if (typeof updateVendor10006Info === "function") updateVendor10006Info();
    return;
  }

  if (!val) {
    if (fromRestore) {
      // En restore con val vacío, no tocar nada (no hay cliente válido a restaurar)
      return;
    }
    // Vendor deselected a customer — clear profile back to vendor's own
    try {
      localStorage.removeItem("lk_vendor_selected_cod_cliente");
      localStorage.removeItem("lk_vendor_selected_business_name");
      localStorage.removeItem("lk_vendor_selected_dto_vol");
    } catch (e) {}
    // Solo wipe + confirm si hay items y NO es restore
    if (cart.length > 0) {
      var okEmpty = window.confirm(
        "Vas a deseleccionar al cliente. El carrito actual (" +
          cart.length +
          " items) se va a vaciar.\n\n¿Continuar?"
      );
      if (!okEmpty) return;
    }
    cart.splice(0, cart.length);
    saveCartToLS();
    updateCart();
    refreshSubmitEnabled();
    return;
  }

  var customerId = val;

  // Capturar el customer ANTERIOR antes de pisarlo — para decidir si limpiar
  // el carrito (solo si REALMENTE cambia de cliente, y con confirm si hay items).
  var prevCustomerId = customerProfile && customerProfile.id;
  var prevCustomerName = customerProfile && customerProfile.business_name;
  var isRealChange =
    prevCustomerId && String(prevCustomerId) !== String(customerId);

  // Confirm SOLO si cambia de cliente Y hay items Y NO es fromRestore.
  if (!fromRestore && isRealChange && cart.length > 0) {
    var confirmMsg =
      "Vas a cambiar de " +
      (prevCustomerName || "cliente") +
      " a otro cliente. El carrito actual (" +
      cart.length +
      " items) se va a vaciar.\n\n¿Continuar?";
    var ok = window.confirm(confirmMsg);
    if (!ok) {
      _csSetValue("customerSelect", String(prevCustomerId));
      _csSetValue("customerSelectCart", String(prevCustomerId));
      return;
    }
  }

  var result = await supabaseClient
    .from("customers")
    .select(
      "id,business_name,dto_vol,cod_cliente,cuit,direccion_fiscal,localidad,vend,mail,debt,payment_term,credit_limit,escala_activa",
    )
    .eq("id", customerId)
    .maybeSingle();

  if (result.error || !result.data) {
    console.error("onLinkedCustomerSelected error:", result.error);
    return;
  }

  customerProfile = result.data;

  // Limpiar carrito SOLO si el cliente realmente CAMBIÓ Y no es restore.
  if (!fromRestore && isRealChange) {
    cart.splice(0, cart.length);
    saveCartToLS();
  }

  // Persist selected client for historial/sugerencias pages
  try {
    localStorage.setItem(
      "lk_vendor_selected_cod_cliente",
      customerProfile.cod_cliente || "",
    );
    localStorage.setItem(
      "lk_vendor_selected_business_name",
      customerProfile.business_name || "",
    );
    localStorage.setItem(
      "lk_vendor_selected_dto_vol",
      String(customerProfile.dto_vol || 0),
    );
  } catch (e) {}

  var name = (customerProfile.business_name || "").trim();
  var helloEl = $("helloNavText");
  if (helloEl) helloEl.innerText = name ? "Hola, " + name + " !" : "Hola!";

  var note = $("customerNote");
  if (note) {
    var dto = Number(customerProfile.dto_vol || 0);
    if (isAdmin) {
      note.innerText = "Modo Administrador";
    } else if (dto > 0) {
      note.innerText = "Ya esta aplicado tu Dto x Volumen";
    } else {
      note.innerText = "";
    }
  }

  // Resetear dirección de entrega y confirmación
  deliveryChoice = { slot: "", label: "" };
  var shipConfirmBtn = $("shipConfirmBtn");
  if (shipConfirmBtn) {
    var shipCard = shipConfirmBtn.closest(".ship-card");
    if (shipCard) shipCard.classList.remove("has-confirm");
    shipConfirmBtn.remove();
  }

  // Resetear método de pago
  var paySel = $("paymentSelect");
  if (paySel) paySel.value = "";
  document.querySelectorAll("#paymentButtons .pay-btn").forEach(function (b) {
    b.classList.remove("selected", "active");
  });
  var payLaterBtn = $("payLaterBtn");
  if (payLaterBtn) payLaterBtn.classList.remove("selected", "active");
  syncPaymentButtons();

  await loadDeliveryOptions();
  myAssortmentIds = await loadMyAssortmentIds();
  renderProducts();
  updateCart();
  fillProfileSummaryUI();
  // Si el perfil está abierto, refrescar historial/direcciones del nuevo cliente:
  // fillProfileSummaryUI ya actualiza la cabecera, pero el historial quedaba
  // mostrando los pedidos del cliente anterior hasta recargar la página.
  var perfilEl = document.getElementById("perfil");
  if (perfilEl && perfilEl.classList.contains("active")) {
    loadMyOrdersUI();
    loadMyAddressesUI();
  }
  refreshSubmitEnabled();
  if (typeof updateMenuNotifVisibility === "function") {
    updateMenuNotifVisibility();
  }
}

// Restaura el cliente seleccionado por el vendedor al volver de historial/sugerencias/etc.
async function restoreSelectedCustomerIfAny() {
  // EXPO: el cliente pudo elegirse del padrón (no queda en linkedCustomers tras
  // recargar la página al volver de historial/sugerencias). Se restaura desde su
  // propia clave, re-aplicándolo completo. fromRestore=true → NO vacía el carrito.
  if (EXPO_MODE && isAdmin) {
    var rawExpo = "";
    try {
      rawExpo = localStorage.getItem("lk_expo_selected_client") || "";
    } catch (e) {}
    if (rawExpo) {
      try {
        var ec = JSON.parse(rawExpo);
        if (ec && ec.id) {
          await expoApplyCustomer(
            {
              id: ec.id,
              cod_cliente: ec.cod_cliente,
              business_name: ec.business_name,
              dto_vol: ec.dto_vol,
              vend: ec.vend,
            },
            { forceExpoNew: !!ec.expoClientMode, fromRestore: true },
          );
          return;
        }
      } catch (e) { /* clave corrupta: seguir con la restauración normal */ }
    }
  }

  if (!linkedCustomers.length) return;
  var savedCod = "";
  try {
    savedCod = (
      localStorage.getItem("lk_vendor_selected_cod_cliente") || ""
    ).trim();
  } catch (e) {}
  if (!savedCod) return;

  // Marker especial = el vendedor había elegido "Perfil Vendedor"
  if (savedCod === VENDOR_SELF_VALUE) {
    _csSetValue("customerSelect", VENDOR_SELF_VALUE);
    _csSetValue("customerSelectCart", VENDOR_SELF_VALUE);
    await onLinkedCustomerSelected({ fromRestore: true });
    return;
  }

  var match = linkedCustomers.find(function (c) {
    return String(c.cod_cliente) === savedCod;
  });
  if (!match) return;

  _csSetValue("customerSelect", match.customer_id);
  _csSetValue("customerSelectCart", match.customer_id);

  await onLinkedCustomerSelected({ fromRestore: true });
}

/***********************
 * LOKE MODULE
 ***********************/
let lokeProducts = [];
let hasLokeAccess = false;

async function checkLokeAccess() {
  // Linea Loke retirada de Tierra Nativa: no forma parte de este sitio.
  // Se deja el acceso siempre desactivado para que la seccion quede
  // inalcanzable y no se ejecute nada de la logica de Loke.
  hasLokeAccess = false;
}

function updateLokeButton() {
  var link = document.getElementById("lokeLink");
  var mobileBtn = document.getElementById("mobileLokeBtn");
  if (link) link.style.display = hasLokeAccess ? "inline-flex" : "none";
  if (mobileBtn)
    mobileBtn.style.display = hasLokeAccess ? "inline-flex" : "none";
}

var lokeFilterAll = true;
var lokeFilterCats = new Set();
var lokeSortMode = "category";

function renderLokeSidebar() {
  var list = document.getElementById("lokeCategoriesList");
  if (!list) return;

  var cats = getOrderedCategoriesFrom(lokeProducts);

  var html =
    '<label class="toggle-row ' +
    (lokeFilterAll ? "active" : "") +
    '">' +
    '<span class="toggle-text">Todos los artículos</span>' +
    '<input type="checkbox" id="lokeToggleAll" ' +
    (lokeFilterAll ? "checked" : "") +
    ">" +
    '<span class="toggle-ui"></span>' +
    "</label>" +
    '<div class="toggle-sep"></div>';

  cats.forEach(function (cat) {
    html +=
      '<label class="toggle-row ' +
      (lokeFilterCats.has(cat) ? "active" : "") +
      '">' +
      '<span class="toggle-text">' +
      cat +
      "</span>" +
      '<input type="checkbox" class="loke-toggle-cat" data-cat="' +
      cat +
      '" ' +
      (lokeFilterCats.has(cat) ? "checked" : "") +
      ">" +
      '<span class="toggle-ui"></span>' +
      "</label>";
  });

  list.innerHTML = html;

  var allToggle = document.getElementById("lokeToggleAll");
  if (allToggle) {
    allToggle.addEventListener("change", function () {
      lokeFilterAll = allToggle.checked;
      if (lokeFilterAll) lokeFilterCats.clear();
      if (!lokeFilterAll && lokeFilterCats.size === 0) lokeFilterAll = true;
      renderLokeSidebar();
      renderLokeProducts();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  list.querySelectorAll(".loke-toggle-cat").forEach(function (inp) {
    inp.addEventListener("change", function () {
      var cat = inp.dataset.cat;
      if (inp.checked) lokeFilterCats.add(cat);
      else lokeFilterCats.delete(cat);
      if (lokeFilterCats.size > 0) lokeFilterAll = false;
      if (lokeFilterCats.size === 0) lokeFilterAll = true;
      renderLokeSidebar();
      renderLokeProducts();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

async function loadLokeProducts() {
  var result = await supabaseClient
    .from("loke_products")
    .select("id,cod,description,category,list_price,uxb,equiv_product_id")
    .eq("active", true)
    .order("category")
    .order("cod");
  if (result.error) {
    console.error("loadLokeProducts error:", result.error);
    lokeProducts = [];
    return;
  }
  var items = result.data || [];
  items.forEach(function (lp) {
    if (lp.equiv_product_id) {
      var equiv = products.find(function (p) {
        return String(p.id) === String(lp.equiv_product_id);
      });
      if (equiv) {
        lp.equiv_list_price = Number(equiv.list_price || 0);
        lp.equiv_contado = Math.round(
          lp.equiv_list_price *
            (1 - getDtoVol()) *
            (1 - WEB_ORDER_DISCOUNT) *
            (1 - 0.3),
        );
      }
    }
  });
  lokeProducts = items;
}

function renderLokeProducts() {
  var container = document.getElementById("lokeContainer");
  if (!container) return;
  container.innerHTML = "";
  renderLokeSidebar();

  var filtered = lokeProducts;
  if (searchTerm && String(searchTerm).trim()) {
    var term = normalizeText(searchTerm);
    filtered = lokeProducts.filter(function (p) {
      var hay = normalizeText(p.cod) + " " + normalizeText(p.description);
      return hay.includes(term);
    });
  }

  if (!lokeFilterAll && lokeFilterCats.size > 0) {
    filtered = filtered.filter(function (p) {
      return lokeFilterCats.has(String(p.category || "").trim());
    });
  }

  // Sort
  filtered = filtered.slice();
  if (lokeSortMode === "price_desc") {
    filtered.sort(function (a, b) {
      return Number(getPriceForCustomer(b) || 0) - Number(getPriceForCustomer(a) || 0);
    });
  } else if (lokeSortMode === "price_asc") {
    filtered.sort(function (a, b) {
      return Number(getPriceForCustomer(a) || 0) - Number(getPriceForCustomer(b) || 0);
    });
  }

  if (!filtered.length) {
    container.innerHTML =
      '<div style="padding:24px;color:rgba(255,255,255,0.4);">Sin resultados' +
      (searchTerm ? ' para "' + searchTerm + '"' : "") +
      ".</div>";
    return;
  }

  var lastCat = "";
  filtered.forEach(function (p) {
    var cat = String(p.category || "").trim();
    if (lokeSortMode === "category" && cat && cat !== lastCat) {
      container.insertAdjacentHTML(
        "beforeend",
        '<div class="loke-cat-title">' + cat + "</div>",
      );
      lastCat = cat;
    }

    var pid = String(p.id);
    var codSafe = String(p.cod || "").trim();
    var price = Number(getPriceForCustomer(p) || 0);
    var inCart = cart.find(function (i) {
      return String(i.productId) === pid;
    });
    var qty = inCart ? Number(inCart.qtyCajas || 0) : 0;
    var totalUni = qty * Number(p.uxb || 0);

    var html =
      '<div class="product-card loke-card" id="loke-card-' +
      pid +
      '">' +
      '<div class="badge-loke">LOKE</div>' +
      '<img src="' +
      primaryProductImage(p) +
      '" alt="' +
      String(p.description || "") +
      '" width="400" height="400" loading="lazy" onerror="this.onerror=null;this.src=\'img/no-image.jpg\'">' +
      '<div class="card-top">' +
      '<div class="card-row">' +
      '<div class="card-cod">Cod: <span>' +
      codSafe +
      "</span></div>" +
      '<div class="card-uxb">UxB: <span>' +
      p.uxb +
      "</span></div>" +
      "</div>" +
      '<div class="card-desc">' +
      String(p.description || "") +
      "</div>" +
      '<div class="card-prices">' +
      '<div class="card-price-line loke-price-main">Precio Loke: <strong>$' +
      formatMoney(price) +
      " + IVA</strong></div>" +
      (p.equiv_contado
        ? '<div class="card-price-line loke-price-equiv"><span class="loke-equiv-label">Loekemeyer contado:</span> <span class="loke-equiv-strike">$' +
          formatMoney(p.equiv_contado) +
          "</span></div>"
        : "") +
      "</div></div>";

    if (!currentSession) {
      html +=
        '<button class="add-btn add-login-btn" onclick="openLogin()">Iniciar sesion para ver precios</button>';
    } else if (qty <= 0) {
      // Vendor en browse mode: cambiar label y acción
      var vendorBrowseLoke =
        typeof isVendorProfileBrowseMode === "function" &&
        isVendorProfileBrowseMode();
      if (vendorBrowseLoke) {
        html +=
          '<button class="add-btn add-vendor-browse" onclick="scrollToCustomerSelector()" title="Elegí primero una razón social">' +
          "Elegir razón social</button>";
      } else {
        html +=
          '<button class="add-btn" onclick="lokeAddFirst(\'' +
          pid +
          "')\">Agregar al pedido</button>";
      }
    } else {
      var subtotalLoke = price * qty * Number(p.uxb || 0);
      html +=
        '<div class="card-cartbar">' +
        '<div class="cartbar-top">' +
        '<div class="cartbar-label">Subtotal</div>' +
        '<div class="cartbar-subtotal">' +
        '<strong class="cartbar-subv">$' + formatMoney(subtotalLoke) + "</strong>" +
        '<span class="cartbar-iva">+ IVA</span>' +
        "</div>" +
        "</div>" +
        '<div class="cartbar-controls"><div class="cartbar-left">' +
        '<div class="cartbar-stepper">' +
        '<button type="button" class="step-btn" onclick="changeQty(\'' +
        pid +
        "',-1);renderLokeProducts();\">-</button>" +
        '<input class="step-input" type="number" min="1" value="' +
        qty +
        '" onchange="manualQty(\'' +
        pid +
        "',this.value);renderLokeProducts();\">" +
        '<button type="button" class="step-btn" onclick="changeQty(\'' +
        pid +
        "',1);renderLokeProducts();\">+</button>" +
        "</div>" +
        '<button type="button" class="chip chip-5" onclick="changeQty(\'' +
        pid +
        "',5);renderLokeProducts();\">+5</button>" +
        "</div></div>" +
        '<div class="cartbar-units">Unidades: <strong>' +
        formatMoney(totalUni) +
        "</strong></div>" +
        "</div>";
    }

    html += "</div>";
    container.insertAdjacentHTML("beforeend", html);
  });

  // 🎬 Entrance stagger Loke: solo primera vez por carga de página
  if (!__lokeEntranceFired) {
    __lokeEntranceFired = true;
    container.classList.add("lk-animate-in");
    setTimeout(function () {
      container.classList.remove("lk-animate-in");
    }, 1500);
  }
}

var __lokeEntranceFired = false;

function lokeAddFirst(productId) {
  if (!currentSession) {
    openLogin();
    return;
  }
  // Guard: vendedor en browse mode (sin cliente seleccionado o "Perfil Vendedor")
  // → no puede comprar a su nombre, redirigir al selector
  if (
    typeof isVendorProfileBrowseMode === "function" &&
    isVendorProfileBrowseMode()
  ) {
    if (typeof scrollToCustomerSelector === "function") {
      scrollToCustomerSelector();
    }
    return;
  }
  var existing = cart.find(function (i) {
    return i.productId === productId;
  });
  if (existing) {
    existing.qtyCajas += 1;
  } else {
    cart.push({
      productId: productId,
      qtyCajas: 1,
      isLoke: true,
      source: "loke",
    });
    logCartAddEvent(productId, "loke");
  }
  updateCart();
  renderLokeProducts();
  scheduleViewOrderToastAfterAdd();
  triggerAddAnimations(productId);
}

window.lokeAddFirst = lokeAddFirst;
window.renderLokeProducts = renderLokeProducts;

// Helpers para que el carrito encuentre productos Loke
function findAnyProduct(productId) {
  var pid = String(productId);
  var p = products.find(function (x) {
    return String(x.id) === pid;
  });
  if (p) return p;
  var lp = lokeProducts.find(function (x) {
    return String(x.id) === pid;
  });
  if (lp) return lp;
  return null;
}

function isLokeItem(productId) {
  var pid = String(productId);
  return lokeProducts.some(function (x) {
    return String(x.id) === pid;
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  WEB_ORDER_DISCOUNT = await getWebOrderDiscount();
  // Sincronizar altura cart-col-right con cart-col-left (carrito 2 cols)
  // → la tabla se estira al alto exacto de la izquierda y scrollea internamente.
  // CASO ESPECIAL: si el módulo "Seguro que no necesitás esto?" está oculto,
  // dejamos que la col-right se ajuste al contenido del cart (no forzar alto
  // de la col-left → no quedan huecos vacíos abajo del cart).
  (function setupCartColHeightSync() {
    var left = document.querySelector("#carrito .cart-col-left");
    var right = document.querySelector("#carrito .cart-col-right");
    if (!left || !right) return;
    var _syncing = false;
    var _lastTotalsH = 0;
    function syncHeight() {
      if (_syncing) return; // evita loop de ResizeObserver
      _syncing = true;
      try {
        // Top row: cart-col-left/right toman alto natural. Cart-table scrollea
        // internamente via CSS (max-height: calc(100vh - 200px)).
        right.style.height = "";
        right.style.maxHeight = "";

        // Bottom row: missing assortment module debe igualar al alto de la
        // card de totales.
        var totalsCard = document.querySelector("#carrito .cart-bottom-row > .cart-total");
        var missingEl = document.getElementById("missingAssortmentModule");
        if (totalsCard && missingEl) {
          var totalsH = totalsCard.offsetHeight;
          // Solo si totals tiene un alto razonable (>50). Si la sección
          // carrito está oculta, offsetHeight=0 y NO debemos colapsar el
          // missing module — preservar el alto previo.
          if (totalsH > 50) {
            var targetH = Math.round(totalsH * 1.5) + 40;
            if (targetH !== _lastTotalsH) {
              _lastTotalsH = targetH;
              missingEl.style.height = targetH + "px";
              missingEl.style.maxHeight = targetH + "px";
            }
          }
        }
      } finally {
        // Liberar el flag en el próximo frame para no bloquear futuros syncs
        requestAnimationFrame(function () {
          _syncing = false;
        });
      }
    }
    if (typeof ResizeObserver !== "undefined") {
      var ro = new ResizeObserver(syncHeight);
      ro.observe(left);
      // Observar SOLO la card de totales (NO observar missing — crearia loop
      // porque syncHeight le escribe el style.height a missing).
      var totalsCardObs = document.querySelector("#carrito .cart-bottom-row > .cart-total");
      if (totalsCardObs) ro.observe(totalsCardObs);
    }
    window.addEventListener("resize", syncHeight);
    document.addEventListener("click", function (e) {
      if (e.target && e.target.closest && e.target.closest("[onclick*=\"showSection('carrito')\"]")) {
        setTimeout(syncHeight, 50);
      }
    });
    setTimeout(syncHeight, 100);
    // Exponer global para que renderMissingAssortmentModule pueda llamarlo
    window.__lkSyncCartColHeight = syncHeight;
  })();
  // ===== LOADER CONTROL (solo 1ra vez por página) =====
  (function () {
    const loader = document.getElementById("pageLoader");
    if (!loader) return;

    const key = `lk_loader_seen_v1:${location.pathname.split("/").pop()}`;

    if (localStorage.getItem(key) === "1") {
      loader.remove();
      return;
    }

    const delay = 5000 + Math.random() * 5000; // 5 a 10s

    setTimeout(() => {
      loader.style.transition = "opacity 0.5s ease";
      loader.style.opacity = "0";
      setTimeout(() => {
        try {
          localStorage.setItem(key, "1");
        } catch {}
        loader.remove();
      }, 500);
    }, delay);
  })();
  // Exponer funciones al HTML (onclick)
  // ✅ recuperar carrito guardado (si venís de sugerencias, etc.)
  const saved = loadCartFromLS();
  if (saved.length) {
    cart.splice(0, cart.length, ...saved);
  }

  window.showSection = showSection;
  window.goToProductsTop = goToProductsTop;
  window.openLogin = openLogin;
  window.closeLogin = closeLogin;
  window.login = login;
  window.logout = logout;
  window.elegirFormato = elegirFormato;
  window.recordarFormato = recordarFormato;
  window.openOsaFormatChooser = openOsaFormatChooser;
  window.closeOsaFormatChooser = closeOsaFormatChooser;

  window.addFirstBox = addFirstBox;
  window.changeQty = changeQty;
  window.manualQty = manualQty;
  window.removeItem = removeItem;
  window.updateCart = updateCart;
  window.submitOrder = submitOrder;
  window.openProfile = openProfile;
  window.missingStep = missingStep;

  // ✅ Funciones de la pantalla final

  window.volverMayorista = volverMayorista;
  window.descargarPedidoPDF = descargarPedidoPDF;
  window.descargarComprobantePedido = descargarComprobantePedido;

  // Pedidos sin Confirmar (drafts)
  window.openSaveDraftModal = openSaveDraftModal;
  window.closeSaveDraftModal = closeSaveDraftModal;
  window.saveCart = saveCart;
  window.loadDraftCarts = loadDraftCarts;
  window.loadDraftIntoCart = loadDraftIntoCart;
  window.deleteDraftCart = deleteDraftCart;
  window.deleteDraftFromModal = deleteDraftFromModal;
  window.openDraftsFromMenu = openDraftsFromMenu;

  // Agregar sucursal desde el carrito
  window.abrirModalSucursal = abrirModalSucursal;
  window.cerrarModalSucursal = cerrarModalSucursal;
  window.guardarNuevaSucursal = guardarNuevaSucursal;
  window.actualizarExpresoSegunCABA = actualizarExpresoSegunCABA;
  window.onExpresoInput = onExpresoInput;
  window.autocompletarDireccionExpreso = autocompletarDireccionExpreso;
  window.validarFormSucursal = validarFormSucursal;

  // ✅ Sacar "Cambiar contraseña" del menú aunque no tenga id
  function removeChangePassItems() {
    document
      .querySelectorAll(
        "#userMenu .user-menu-item, #userMenu button, #userMenu a, #userMenu div, #userMenu span",
      )
      .forEach((el) => {
        const t = (el.textContent || "").trim().toLowerCase();
        if (t === "cambiar contraseña" || t.includes("cambiar contraseña")) {
          el.remove();
        }
      });

    // mobile (por si también existe)
    document
      .querySelectorAll(
        "#mobileUserMenu .user-menu-item, #mobileUserMenu button, #mobileUserMenu a, #mobileUserMenu div, #mobileUserMenu span",
      )
      .forEach((el) => {
        const t = (el.textContent || "").trim().toLowerCase();
        if (t === "cambiar contraseña" || t.includes("cambiar contraseña")) {
          el.remove();
        }
      });
  }

  // correr al cargar y también después (por si se renderiza tarde)
  removeChangePassItems();
  setTimeout(removeChangePassItems, 300);
  setTimeout(removeChangePassItems, 1000);

  // =============================
  // SORT (desktop botones + selects + mobile) ✅ ÚNICO BLOQUE
  // =============================
  function applySortUI() {
    const wrap = $("desktopSortButtons");
    if (wrap) {
      wrap.querySelectorAll(".ds-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.sort === sortMode);
      });
    }

    const s1 = $("sortSelect");
    if (s1) s1.value = sortMode;

    const s2 = $("mobileSortSelect");
    if (s2) s2.value = sortMode;

    // Custom dropdown desktop "Filtrar por..."
    const trig = $("sortDropdownTrigger");
    const popup = $("sortDropdownPopup");
    if (trig && popup) {
      // Buscar opción que corresponde al sortMode actual
      const opt = popup.querySelector(`.sort-dd-option[data-value="${sortMode}"]`);
      // El trigger muestra "Filtrar por…" como label permanente cuando
      // el sort es el default "category" (Categorías). En cualquier otro
      // caso, muestra el label de la opción seleccionada.
      const label =
        sortMode === "category"
          ? "Filtrar por…"
          : (opt ? opt.dataset.label : "Filtrar por…");
      const labelEl = trig.querySelector(".sort-dd-label");
      if (labelEl) labelEl.textContent = label;
      // Marcar la opción seleccionada en el popup
      popup.querySelectorAll(".sort-dd-option").forEach((b) => {
        b.removeAttribute("data-selected");
      });
      if (opt) opt.setAttribute("data-selected", "true");
      // Estado "activo" del trigger (negro) cuando NO es default
      if (sortMode === "category") {
        trig.removeAttribute("data-active");
      } else {
        trig.setAttribute("data-active", "1");
      }
    }
  }

  function syncNewFilterBtn() {
    const b = $("btnFilterNew");
    if (b) b.classList.toggle("on", !!filterNewOnly);
  }

  $("btnFilterNew")?.addEventListener("click", () => {
    filterNewOnly = !filterNewOnly;
    syncNewFilterBtn();
    renderProducts();
  });

  function syncMyAssortmentBtn() {
    const b = $("btnFilterAssortment");
    if (b) b.classList.toggle("on", !!filterMyAssortment);
  }

  // estado inicial
  syncMyAssortmentBtn();

  $("btnFilterAssortment")?.addEventListener("click", async () => {
    if (!currentSession) return openLogin();

    if (!customerProfile?.cod_cliente) {
      await refreshAuthState();
    }

    filterMyAssortment = !filterMyAssortment;
    syncMyAssortmentBtn();

    if (filterMyAssortment) {
      myAssortmentIds = await loadMyAssortmentIds();
    }

    const banner = document.getElementById("assortmentBanner");
    if (banner) {
      banner.style.display = filterMyAssortment ? "block" : "none";
    }

    renderProducts();
  });

  // TOAST VER PEDIDOS
  window.addEventListener("resize", positionViewOrderToastBelowHeader);

  // al iniciar
  syncNewFilterBtn();

  async function setSortMode(next) {
    sortMode = String(next || "category");
    applySortUI();

    await loadProductsFromDB();
    renderProducts();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  $("desktopSortButtons")?.addEventListener("click", async (e) => {
    const btn = e.target.closest(".ds-btn");
    if (!btn) return;

    const nextSort = String(btn.dataset.sort || "").trim();
    if (!nextSort) return;

    await setSortMode(nextSort);
  });

  $("sortSelect")?.addEventListener("change", async (e) => {
    await setSortMode(e.target.value);
  });

  $("mobileSortSelect")?.addEventListener("change", async (e) => {
    await setSortMode(e.target.value);
  });

  // Custom dropdown desktop "Filtrar por..." (toggle open + select option)
  (function wireSortDropdown() {
    const trig = $("sortDropdownTrigger");
    const popup = $("sortDropdownPopup");
    if (!trig || !popup) return;

    function openPopup() {
      popup.hidden = false;
      trig.setAttribute("aria-expanded", "true");
    }
    function closePopup() {
      popup.hidden = true;
      trig.setAttribute("aria-expanded", "false");
    }
    function togglePopup() {
      if (popup.hidden) openPopup();
      else closePopup();
    }

    trig.addEventListener("click", function (e) {
      e.stopPropagation();
      togglePopup();
    });

    popup.addEventListener("click", async function (e) {
      const btn = e.target.closest(".sort-dd-option");
      if (!btn) return;
      const value = btn.dataset.value;
      closePopup();
      if (value) await setSortMode(value);
    });

    // Click afuera cierra
    document.addEventListener("click", function (e) {
      if (popup.hidden) return;
      if (e.target.closest("#sortDropdownWrap")) return;
      closePopup();
    });
    // ESC cierra
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !popup.hidden) closePopup();
    });
  })();

  applySortUI();

  // =============================
  // CUIT live format
  // =============================
  function formatCUITLive(value) {
    const d = String(value || "")
      .replace(/\D/g, "")
      .slice(0, 11);
    if (d.length <= 2) return d;
    if (d.length <= 10) return `${d.slice(0, 2)}-${d.slice(2)}`;
    return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
  }

  const cuitEl = $("cuitInput");
  if (cuitEl) {
    cuitEl.addEventListener("input", (e) => {
      const el = e.target;
      // Solo formatear como CUIT si no contiene letras
      if (/[a-zA-Z]/.test(el.value)) return;

      const start = el.selectionStart;
      const before = el.value;

      el.value = formatCUITLive(el.value);

      const diff = el.value.length - before.length;
      const next = (start ?? el.value.length) + diff;
      el.setSelectionRange(next, next);
    });
  }

  // =============================
  // CATEGORÍAS (UNA SOLA IMPLEMENTACIÓN)
  // =============================
  function closeCategoriesMenuFixed() {
    const menu = $("categoriesMenu");
    if (!menu) return;
    menu.classList.remove("open");
    menu.style.opacity = "0";
    menu.style.visibility = "hidden";
    menu.style.pointerEvents = "none";
    menu.style.transform = "translateY(6px)";
  }

  function toggleCategoriesMenuFixed() {
    const menu = $("categoriesMenu");
    if (!menu) return;

    const willOpen = !menu.classList.contains("open");
    closeUserMenu?.();

    menu.classList.toggle("open", willOpen);

    if (willOpen) {
      menu.style.opacity = "1";
      menu.style.visibility = "visible";
      menu.style.pointerEvents = "auto";
      menu.style.transform = "translateY(0)";
    } else {
      closeCategoriesMenuFixed();
    }
  }

  // si ya tenías funciones globales, las unificamos acá
  window.closeCategoriesMenu = closeCategoriesMenuFixed;
  window.toggleCategoriesMenu = toggleCategoriesMenuFixed;

  // estado inicial cerrado
  closeCategoriesMenuFixed();

  $("categoriesBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleCategoriesMenuFixed();
  });

  // Ver Pedido animacion
  document.getElementById("viewOrderBtn")?.addEventListener("click", () => {
    hideViewOrderToast();
    showSection("carrito");
  });

  // Botón dentro del perfil
  document
    .getElementById("btnOpenPassModal")
    ?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPassModal();
    });

  // Cierres
  document
    .getElementById("btnClosePassModal")
    ?.addEventListener("click", closePassModal);
  document
    .getElementById("passModalBackdrop")
    ?.addEventListener("click", closePassModal);
  document
    .getElementById("btnChangePass")
    ?.addEventListener("click", changePasswordUI);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePassModal();
  });

  // =============================
  // USER MENU DESKTOP (BOTÓN ÚNICO userToggleBtn)
  // =============================
  const userBtn = $("userToggleBtn");
  const userMenu = $("userMenu");

  function openUserMenuFixed() {
    if (!userMenu) return;
    userMenu.classList.add("open");
    userMenu.setAttribute("aria-hidden", "false");
    userBtn?.setAttribute("aria-expanded", "true");
  }

  function closeUserMenuFixed() {
    if (!userMenu) return;
    userMenu.classList.remove("open");
    userMenu.setAttribute("aria-hidden", "true");
    userBtn?.setAttribute("aria-expanded", "false");
  }

  function toggleUserMenuFixed() {
    if (!userMenu) return;
    const isOpen = userMenu.classList.contains("open");
    if (isOpen) closeUserMenuFixed();
    else openUserMenuFixed();
  }

  // forzar que tus otras partes usen estas funciones
  window.closeUserMenu = closeUserMenuFixed;
  window.toggleUserMenu = toggleUserMenuFixed;

  // estado inicial cerrado
  closeUserMenuFixed();

  if (userBtn) {
    userBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleUserMenuFixed();
    });
  }

  if (userMenu) {
    userMenu.addEventListener("click", (e) => e.stopPropagation());
  }

  // =============================
  // PAGO (botones)
  // =============================
  $("paymentButtons")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".pay-btn");
    if (!btn) return;

    // Toggle: si ya está seleccionado, deseleccionar
    if (btn.classList.contains("selected") || btn.classList.contains("active")) {
      const ps = $("paymentSelect");
      if (ps) ps.value = "";
      btn.classList.remove("selected", "active");
      updateCart();
      refreshSubmitEnabled();
      return;
    }

    // Resto: seleccionar normalmente
    setPaymentByValue(btn.dataset.value);
    document
      .querySelectorAll("#paymentButtons .pay-btn")
      .forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    $("payLaterBtn")?.classList.remove("selected", "active");

    updateCart();
    refreshSubmitEnabled();
  });

  $("payLaterBtn")?.addEventListener("click", () => {
    const payLaterBtn = $("payLaterBtn");
    // Toggle: si ya está seleccionado, deseleccionar
    if (
      payLaterBtn.classList.contains("selected") ||
      payLaterBtn.classList.contains("active")
    ) {
      const ps = $("paymentSelect");
      if (ps) ps.value = "";
      payLaterBtn.classList.remove("selected", "active");
      updateCart();
      refreshSubmitEnabled();
      return;
    }

    // Seleccionar
    const ps = $("paymentSelect");
    if (ps) ps.value = "LATER";
    document
      .querySelectorAll("#paymentButtons .pay-btn")
      .forEach((b) => b.classList.remove("selected", "active"));
    payLaterBtn.classList.add("selected", "active");

    updateCart();
    refreshSubmitEnabled();
  });

  // Pago (select)
  $("paymentSelect")?.addEventListener("change", () => {
    syncPaymentButtons();
    updateCart();
    refreshSubmitEnabled();
  });

  // Mobile: carrito -> Pedido
  $("mobileCartBtn")?.addEventListener("click", () => showSection("carrito"));

  // Mobile: avatar -> dropdown (si no logueado => login)
  $("mobileProfileBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!currentSession) return openLogin();
    toggleMobileUserMenu();
  });

  // PERFIL: WhatsApp + password
  $("btnAddAddress")?.addEventListener("click", () => {
    const name = (customerProfile?.business_name || "").trim();
    const cod = (customerProfile?.cod_cliente || "").trim();
    const msg = `Hola! Soy ${name}${cod ? ` (Cod Cliente ${cod})` : ""}. Quiero agregar una sucursal de entrega.`;
    window.open(waLink(msg), "_blank", "noopener");
  });

  $("btnReportError")?.addEventListener("click", () => {
    const name = (customerProfile?.business_name || "").trim();
    const cod = (customerProfile?.cod_cliente || "").trim();
    const msg = `Hola! Soy ${name}${cod ? ` (Cod Cliente ${cod})` : ""}. Quiero avisar que hay un error en la web mayorista.`;
    window.open(waLink(msg), "_blank", "noopener");
  });

  $("btnChangePass")?.addEventListener("click", () => changePasswordUI());

  // =============================
  // PERFIL - Modal contraseña (UNA SOLA VEZ)
  // =============================

  // Entregas
  const shipSel = $("shippingSelect");
  if (shipSel) {
    deliveryChoice = {
      slot: shipSel.value || "",
      label: "",
      direccionEntrega: "",
      zonaExpreso: "",
    };

    shipSel.addEventListener("change", () => {
      // Opción especial "+ Agregar sucursal" → abrir modal y resetear select
      if (shipSel.value === "__add__") {
        shipSel.value = deliveryChoice.slot || "";
        abrirModalSucursal();
        return;
      }
      const opt = shipSel.options[shipSel.selectedIndex];
      deliveryChoice.slot = shipSel.value || "";
      deliveryChoice.label = opt?.dataset?.label || opt?.textContent || "";
      deliveryChoice.direccionEntrega = opt?.dataset?.direccionEntrega || "";
      deliveryChoice.zonaExpreso = opt?.dataset?.zonaExpreso || "";

      // Si cambió la dirección, resetear el botón "Confirmada" → "Confirmar"
      // (forzar al usuario a re-confirmar la nueva dirección) + re-mostrar hint.
      var shipConfirmBtnReset = document.getElementById("shipConfirmBtn");
      if (shipConfirmBtnReset && shipConfirmBtnReset.classList.contains("confirmed")) {
        shipConfirmBtnReset.classList.remove("confirmed");
        shipConfirmBtnReset.textContent = "Confirmar";
        shipConfirmBtnReset.disabled = false;
        var shipCardChange = shipConfirmBtnReset.closest(".ship-card");
        if (shipCardChange) {
          var hintChange = shipCardChange.querySelector(".ship-hint");
          if (hintChange) hintChange.style.display = "";
        }
      }

      // Sin botón Confirmar: al elegir una dirección real, ocultar el hint
      // "Seleccioná una dirección…"; si vuelve a placeholder, mostrarlo.
      var shipCardSel = shipSel.closest(".ship-card");
      if (shipCardSel) {
        var hintSel = shipCardSel.querySelector(".ship-hint");
        if (hintSel) {
          hintSel.style.display =
            String(shipSel.value || "").trim() && shipSel.value !== "__add__"
              ? "none"
              : "";
        }
      }

      updateCart();
      refreshSubmitEnabled();
      // Refrescar localidad/expreso del vendedor 10006 al cambiar sucursal.
      if (typeof updateVendor10006Info === "function") updateVendor10006Info();
    });

    // Envolver con custom dropdown CS (mismo look que "Pedir para")
    // Sin flicker en Chrome+Win dark mode + look unificado.
    _csWrapNativeSelect(shipSel, {
      placeholder: "Elegir Sucursal",
      extraClass: "cs-dropdown-card cs-dropdown-ship",
    });
  }

  // =============================
  // Click afuera: cerrar menús (UNA SOLA VEZ)
  // =============================
  document.addEventListener("click", (e) => {
    // categorías
    const catBtn = $("categoriesBtn");
    const catMenu = $("categoriesMenu");
    const insideCat =
      (catBtn && catBtn.contains(e.target)) ||
      (catMenu && catMenu.contains(e.target));
    if (!insideCat) closeCategoriesMenuFixed();

    // user desktop
    const insideUser =
      (userBtn && userBtn.contains(e.target)) ||
      (userMenu && userMenu.contains(e.target));
    if (!insideUser) closeUserMenuFixed();

    // user mobile
    const mMenu = $("mobileUserMenu");
    const mBtn = $("mobileProfileBtn");
    if (mMenu && mBtn) {
      const insideM = mMenu.contains(e.target) || mBtn.contains(e.target);
      if (!insideM) closeMobileUserMenu();
    }
  });

  // Buscador NAV
  const navSearch = $("navSearch");
  if (navSearch) {
    navSearch.addEventListener("input", () => {
      searchTerm = String(navSearch.value || "").trim();
      renderProducts();
      if (hasLokeAccess) renderLokeProducts();
    });
  }

  // Buscador Mobile
  const mobileSearch = $("mobileSearch");
  if (mobileSearch) {
    mobileSearch.addEventListener("input", () => {
      searchTerm = String(mobileSearch.value || "").trim();
      renderProducts();
      if (hasLokeAccess) renderLokeProducts();
    });
  }

  // Mobile filtros overlay (Mi surtido / Nuevos / Ordenar)
  $("openFiltersBtn")?.addEventListener("click", () => openFiltersOverlay());
  $("filtersCancelBtn")?.addEventListener("click", () =>
    cancelPendingFilters(),
  );
  $("filtersApplyBtn")?.addEventListener("click", () => applyPendingFilters());

  $("filtersOverlay")?.addEventListener("click", (e) => {
    if (e.target.id === "filtersOverlay") closeFiltersOverlay();
  });

  // Mobile categorías overlay (Todos los artículos + categorías)
  $("openCategoriasBtn")?.addEventListener("click", () => openCategoriasOverlay());
  $("categoriasCancelBtn")?.addEventListener("click", () => closeCategoriasOverlay());
  $("categoriasApplyBtn")?.addEventListener("click", () => applyPendingCategorias());
  $("categoriasOverlay")?.addEventListener("click", (e) => {
    if (e.target.id === "categoriasOverlay") closeCategoriasOverlay();
  });

  // =============================
  // Cargar sesión inicial y productos
  // =============================
  await refreshAuthState();
  // Cliente OSA que abre la página ya logueado: ofrecer el selector de formato.
  maybeShowOsaFormatChooser();
  await loadProductsFromDB();

  // =============================
  // ✅ Importar agregados desde HISTORIAL
  // =============================
  (function importFromHistoryIfAny() {
    const HISTORY_PENDING_KEY = "lk_pending_adds_cod_v1";
    try {
      const raw = localStorage.getItem(HISTORY_PENDING_KEY);
      if (!raw) return;

      const list = JSON.parse(raw);
      if (!Array.isArray(list) || !list.length) return;

      list.forEach(({ cod, qty }) => {
        const c = String(cod || "").trim();
        const q = Math.max(1, parseInt(qty, 10) || 1);
        if (!c) return;

        const prod = products.find((p) => String(p.cod) === c);
        if (!prod) return;

        const found = cart.find(
          (ci) => String(ci.productId) === String(prod.id),
        );

        if (found) found.qtyCajas += q;
        else
          cart.push({
            productId: String(prod.id),
            qtyCajas: q,
            source: "historial",
          });
      });

      localStorage.removeItem(HISTORY_PENDING_KEY);
    } catch (e) {
      console.warn("Import history failed:", e);
    }
  })();

  renderCategoriesMenu();
  renderCategoriesSidebar();
  renderProducts();
  updateCart();
  syncPaymentButtons();

  // Linked customers (vendedores / multi-RS)
  await loadLinkedCustomers();
  renderCustomerSelector();
  await restoreSelectedCustomerIfAny();

  // Loke module
  await checkLokeAccess();
  updateLokeButton();
  if (hasLokeAccess) {
    await loadLokeProducts();
    renderLokeProducts();
  }

  // Loke sort buttons
  var lokeSortEl = document.getElementById("lokeSortButtons");
  if (lokeSortEl) {
    lokeSortEl.addEventListener("click", function (e) {
      var btn = e.target.closest(".ds-btn");
      if (!btn) return;
      var next = btn.dataset.lokeSort;
      if (!next) return;
      lokeSortMode = next;
      lokeSortEl.querySelectorAll(".ds-btn").forEach(function (b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      renderLokeProducts();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  setTimeout(() => {
    const shipSel = $("shippingSelect");
    if (
      shipSel &&
      shipSel.options.length <= 1 &&
      currentSession &&
      customerProfile?.id
    ) {
      loadDeliveryOptions();
    }
  }, 1200);

  // Reactividad login/logout
  let _wasLoggedIn = !!currentSession;

  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    const previouslyLoggedIn = _wasLoggedIn;
    currentSession = session;
    _wasLoggedIn = !!session;

    // Solo resetear UI en cambio REAL de sesión (login/logout genuino)
    // TOKEN_REFRESHED, INITIAL_SESSION y SIGNED_IN cuando ya estaba logueado
    // (tab return con token refresh) NO deben resetear la UI
    if (
      _event === "TOKEN_REFRESHED" ||
      _event === "INITIAL_SESSION" ||
      (_event === "SIGNED_IN" && previouslyLoggedIn && !!session)
    ) {
      return;
    }

    // Reset completo solo en cambio real de sesión (SIGNED_IN, SIGNED_OUT)
    filterMyAssortment = false;
    myAssortmentIds = null;
    syncMyAssortmentBtn?.();

    searchTerm = "";
    const ns = $("navSearch");
    if (ns) ns.value = "";

    await refreshAuthState(session);
    await loadProductsFromDB();
    myAssortmentIds = await loadMyAssortmentIds();

    renderCategoriesMenu();
    closeCategoriesMenuFixed();

    renderCategoriesSidebar();
    renderProducts();
    updateCart();

    syncPaymentButtons();

    // Re-check linked customers on auth change
    await loadLinkedCustomers();
    renderCustomerSelector();
    // En login genuino (SIGNED_IN), arrancar SIN cliente pre-elegido →
    // el dropdown queda en "Elegir razón social...". (En recargas con sesión
    // existente entra por INITIAL_SESSION/DOMContentLoaded y SÍ restaura.)
    if (_event === "SIGNED_IN") {
      try {
        localStorage.removeItem("lk_vendor_selected_cod_cliente");
        localStorage.removeItem("lk_vendor_selected_business_name");
        localStorage.removeItem("lk_vendor_selected_dto_vol");
      } catch (e) {}
    }
    await restoreSelectedCustomerIfAny();

    // Re-check Loke access on auth change
    await checkLokeAccess();
    updateLokeButton();
    if (hasLokeAccess) {
      await loadLokeProducts();
      renderLokeProducts();
    }

    // Cliente OSA: ofrecer elegir entre formato regular y "Formato OSA".
    if (_event === "SIGNED_IN") maybeShowOsaFormatChooser({ force: true });
  });

  // Al volver a la pestaña solo refrescar UI, no tocar auth (Supabase lo hace solo)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    renderProducts();
    updateCart();
    syncPaymentButtons();
  });
});

function getCodClienteForHistorial() {
  const dom = (
    document.getElementById("pfCodCliente")?.textContent || ""
  ).trim();

  const ls =
    localStorage.getItem("cod_cliente") ||
    localStorage.getItem("codCliente") ||
    localStorage.getItem("cliente") ||
    localStorage.getItem("customer") ||
    localStorage.getItem("customer_id") ||
    "";

  const v = (dom && dom !== "—" ? dom : ls || "").trim();
  return v && v !== "—" ? v : "";
}

function openHistorialFromMenu(v) {
  const vista = v || "hist"; // default seguro
  window.location.href = `./historial?v=${encodeURIComponent(vista)}`;
}

// ===== HISTORIAL / SUGERENCIAS / NOVEDADES =====

function getCodClienteFromProfileOrStorage() {
  const dom = (
    document.getElementById("pfCodCliente")?.textContent || ""
  ).trim();
  if (dom && dom !== "—") return dom;

  const ls =
    localStorage.getItem("cod_cliente") ||
    localStorage.getItem("codCliente") ||
    localStorage.getItem("cliente") ||
    localStorage.getItem("customer") ||
    localStorage.getItem("customer_id") ||
    "";

  return (ls || "").trim();
}

function abrirHistorial() {
  const path = window.location.pathname;
  const base = path.includes("/productos-main/")
    ? "/productos-main/"
    : path.includes("/productos/")
      ? "/productos/"
      : "/";

  window.location.href = base + "historial";
}

/* =========================================================
   ANIMACIÓN DE ÉXITO (Lottie)
========================================================= */
var successAnim = null;

function playSuccessAnimation() {
  var container = document.getElementById("successAnimation");
  if (!container) return;

  if (successAnim && typeof successAnim.destroy === "function") {
    try { successAnim.destroy(); } catch (e) {}
    successAnim = null;
  }

  // SVG checkmark inline (sin lottie) — bg transparente, sin caja blanca.
  // Animación: círculo verde aparece + check se traza con stroke-dashoffset.
  container.innerHTML =
    '<svg class="lk-success-svg" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<circle class="lk-success-circle" cx="60" cy="60" r="52" fill="#22c55e"/>' +
    '<path class="lk-success-check" d="M38 62 L54 78 L84 46" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>";
}

/* ============================================================
   BOTÓN "VOLVER ARRIBA" — aparece al scrollear > 400px, scroll
   smooth al hacer click.
   ============================================================ */
(function setupBackToTopBtn() {
  var btn = document.getElementById("backToTopBtn");
  if (!btn) return;
  var THRESHOLD = 400;
  var ticking = false;
  function update() {
    var y = window.pageYOffset || document.documentElement.scrollTop;
    btn.classList.toggle("visible", y > THRESHOLD);
    ticking = false;
  }
  window.addEventListener(
    "scroll",
    function () {
      if (!ticking) {
        requestAnimationFrame(update);
        ticking = true;
      }
    },
    { passive: true },
  );
  btn.addEventListener("click", function () {
    try {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      window.scrollTo(0, 0);
    }
  });
  update();
})();

/* ============================================================
   (14) STICKY HEADER SHRINK — body.is-scrolled cuando scrollY > 80
   ============================================================ */
(function setupHeaderShrink() {
  var body = document.body;
  if (!body) return;
  var ticking = false;
  function update() {
    var y = window.pageYOffset || document.documentElement.scrollTop;
    body.classList.toggle("is-scrolled", y > 80);
    ticking = false;
  }
  window.addEventListener("scroll", function () {
    if (!ticking) {
      requestAnimationFrame(update);
      ticking = true;
    }
  }, { passive: true });
  update();
})();

/* ============================================================
   (7) ATAJOS DE TECLADO
   - "/" → focus en el buscador de productos (#mainSearchInput o similar)
   - Esc → cierra modales abiertos, dropdowns, menús
   - Ctrl+K → quick action (focus buscador)
   ============================================================ */
(function setupKeyboardShortcuts() {
  document.addEventListener("keydown", function (e) {
    var t = e.target;
    var inEditable =
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT" ||
        t.isContentEditable);

    // Esc — cerrar overlays
    if (e.key === "Escape") {
      // Modal de contraseña
      var passModal = document.getElementById("passModal");
      if (passModal && passModal.classList.contains("open")) {
        if (typeof closePassModal === "function") closePassModal();
        return;
      }
      // Modal Vendedor (detalle pedido cliente)
      var vendorModal = document.querySelector(".vendor-modal-card");
      if (vendorModal && vendorModal.offsetParent !== null) {
        var closeBtn = vendorModal.querySelector("[onclick*='close']");
        if (closeBtn) closeBtn.click();
        return;
      }
      // User menu
      if (typeof closeUserMenu === "function") closeUserMenu();
      if (typeof closeMobileUserMenu === "function") closeMobileUserMenu();
      if (typeof closeCategoriesMenu === "function") closeCategoriesMenu();
      if (typeof closeMobileMenu === "function") closeMobileMenu();
      return;
    }

    // "/" o Ctrl+K — focus búsqueda (solo si NO estás escribiendo en input)
    if (!inEditable) {
      if (e.key === "/" || (e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey))) {
        var search =
          document.getElementById("mainSearchInput") ||
          document.getElementById("searchInput") ||
          document.querySelector("input[type='search']") ||
          document.querySelector("input[placeholder*='Buscar' i]");
        if (search) {
          e.preventDefault();
          search.focus();
          search.select && search.select();
        }
      }
    }
  });
})();

/* ============================================================
   (11) PRE-FETCH de imágenes del carrusel Novedades
   ============================================================ */
(function setupCarouselImagePrefetch() {
  function prefetch() {
    var imgs = document.querySelectorAll("#newCarouselTrack img[src]");
    imgs.forEach(function (img) {
      if (img.dataset.prefetched) return;
      var url = img.getAttribute("src");
      if (!url) return;
      var link = document.createElement("link");
      link.rel = "prefetch";
      link.as = "image";
      link.href = url;
      document.head.appendChild(link);
      img.dataset.prefetched = "1";
    });
  }
  // Observar el track del carrusel — cuando renderea, prefetch las próximas
  if (typeof MutationObserver !== "undefined") {
    var track = document.getElementById("newCarouselTrack");
    if (track) {
      new MutationObserver(prefetch).observe(track, { childList: true });
    }
  }
  // También una vez al cargar (si ya hay items)
  setTimeout(prefetch, 1500);
})();

/* ============================================================
   (8) DESACTIVADO — el carrito persiste en localStorage entre páginas
   (mayorista ↔ historial ↔ sugerencias). No hace falta beforeunload.
   ============================================================ */
(function setupUnsavedCartWarning() {
  // no-op intencional
})();

/* ============================================================
   (2, 13) SKELETON LOADER — placeholder cards mientras carga el grid
   ============================================================ */
function renderProductSkeletons(count) {
  var container = document.getElementById("productsContainer");
  if (!container) return;
  count = Number(count || 8);
  var cards = [];
  for (var i = 0; i < count; i++) {
    cards.push(
      '<div class="lk-skeleton-card">' +
        '<div class="lk-skeleton-img"></div>' +
        '<div class="lk-skeleton-line short"></div>' +
        '<div class="lk-skeleton-line long"></div>' +
        '<div class="lk-skeleton-line medium"></div>' +
        '<div class="lk-skeleton-line short"></div>' +
        '<div class="lk-skeleton-btn"></div>' +
      '</div>'
    );
  }
  container.innerHTML = '<div class="lk-skeleton-grid">' + cards.join("") + "</div>";
}
window.renderProductSkeletons = renderProductSkeletons;

/* ============================================================
   CART RECOVERY — re-hydratar desde LS si el cart en memoria
   está vacío pero LS tiene items. Cubre casos donde la app
   pierde el cart (ej: auth state change resetea pero LS sobrevive).
   ============================================================ */
function _lkRehydrateCartIfEmpty() {
  try {
    if (typeof cart === "undefined" || typeof loadCartFromLS !== "function") return;
    if (cart.length > 0) return; // ya tiene items, no tocar
    var saved = loadCartFromLS();
    if (!saved || !saved.length) return; // LS también vacío
    cart.splice(0, cart.length, ...saved);
    if (typeof updateCart === "function") updateCart();
    if (typeof renderProducts === "function") renderProducts();
  } catch (e) {
    console.warn("rehydrate cart error:", e);
  }
}
// pageshow cubre BACK button (bfcache) y carga inicial
window.addEventListener("pageshow", _lkRehydrateCartIfEmpty);
// visibilitychange cubre cuando tab vuelve a foreground
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible") _lkRehydrateCartIfEmpty();
});
// Hook adicional en showSection para cart
(function wrapShowSectionForCart() {
  var orig = window.showSection;
  if (typeof orig !== "function") return;
  window.showSection = function (id) {
    var r = orig.apply(this, arguments);
    if (id === "carrito") _lkRehydrateCartIfEmpty();
    return r;
  };
})();

/* ============================================================
   BROWSER BACK desde #perfil → vuelve a #productos
   Listener de popstate: cuando el usuario hace "atrás" en el navegador
   y la entry previa no era perfil, llama showSection('productos').
   ============================================================ */
window.addEventListener("popstate", function (e) {
  var st = e.state || {};
  var sec = st.lkSection;
  // Flag para que showSection no vuelva a pushear state (loop)
  window.__lkBackNav = true;
  try {
    if (sec === "perfil") {
      // Re-entró a perfil (forward del navegador) — re-mostrar
      if (typeof showSection === "function") showSection("perfil");
    } else {
      // Cualquier otro caso (back desde perfil, state null) → productos
      if (typeof showSection === "function") showSection("productos");
    }
  } finally {
    setTimeout(function () { window.__lkBackNav = false; }, 50);
  }
});

/* ============================================================
   INITIAL HASH HANDLER — si la página abre con #perfil o
   #perfil-analisis (ej: usuario abrió "Mi perfil" en nueva pestaña
   con click derecho), navegar a esa sección al cargar.
   ============================================================ */
window.addEventListener("load", function () {
  setTimeout(function () {
    var hash = (location.hash || "").trim();
    if (!hash || !currentSession) return;
    if (hash === "#perfil") {
      if (typeof openProfile === "function") openProfile();
    } else if (hash === "#perfil-analisis") {
      if (typeof openAnalisisFromMenu === "function") openAnalisisFromMenu();
    }
  }, 500); // esperar a que session + customerProfile estén listos
});

/* ============================================================
   LIGHTBOX — zoom de imagen al hacer click en cualquier producto
   ============================================================ */
function openImgZoom(src, alt) {
  if (!src) return;
  var overlay = document.getElementById("imgZoomOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "imgZoomOverlay";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.85);" +
      "display:flex;align-items:center;justify-content:center;cursor:zoom-out;" +
      "padding:24px;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);" +
      "opacity:0;transition:opacity 0.2s ease-out;";
    overlay.innerHTML =
      '<button type="button" id="imgZoomClose" aria-label="Cerrar" ' +
      'style="position:absolute;top:18px;right:24px;background:rgba(255,255,255,0.15);' +
      'color:white;border:none;border-radius:50%;width:44px;height:44px;font-size:28px;' +
      'line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:2">&times;</button>' +
      '<div id="imgZoomScroll" style="max-width:96vw;max-height:92vh;overflow:hidden;border-radius:8px;' +
      'box-shadow:0 20px 60px rgba(0,0,0,0.5)">' +
      '<img id="imgZoomPic" src="" alt="" ' +
      'style="display:block;max-width:90vw;max-height:88vh;object-fit:contain;cursor:zoom-in;' +
      'transform:scale(0.7);opacity:0;transition:transform 0.28s cubic-bezier(0.34,1.56,0.64,1),opacity 0.2s ease-out" ' +
      'data-zoomed="0">' +
      '</div>';
    // Click en overlay o en el scroll wrapper (fuera de imagen) cierra
    overlay.addEventListener("click", function (e) {
      if (e.target.id === "imgZoomOverlay" || e.target.id === "imgZoomScroll") {
        closeImgZoom();
      }
    });
    overlay.querySelector("#imgZoomClose").addEventListener("click", function (e) {
      e.stopPropagation();
      closeImgZoom();
    });
    // Click en la imagen → toggle zoom 2x (no cierra el popup)
    overlay.querySelector("#imgZoomPic").addEventListener("click", function (e) {
      e.stopPropagation();
      var img = e.currentTarget;
      var scroll = document.getElementById("imgZoomScroll");
      var isZoomed = img.dataset.zoomed === "1";
      if (isZoomed) {
        img.style.maxWidth = "90vw";
        img.style.maxHeight = "88vh";
        img.style.width = "";
        img.style.height = "";
        img.style.cursor = "zoom-in";
        img.dataset.zoomed = "0";
        if (scroll) scroll.style.overflow = "hidden";
      } else {
        img.style.maxWidth = "none";
        img.style.maxHeight = "none";
        img.style.width = (img.naturalWidth * 2) + "px";
        img.style.height = "auto";
        img.style.cursor = "zoom-out";
        img.dataset.zoomed = "1";
        if (scroll) scroll.style.overflow = "auto";
      }
    });
    document.body.appendChild(overlay);
  }
  var picEl = document.getElementById("imgZoomPic");
  var scrollEl = document.getElementById("imgZoomScroll");
  // Reset estado de zoom cada vez que se abre
  picEl.style.maxWidth = "90vw";
  picEl.style.maxHeight = "88vh";
  picEl.style.width = "";
  picEl.style.height = "";
  picEl.style.cursor = "zoom-in";
  picEl.dataset.zoomed = "0";
  if (scrollEl) scrollEl.style.overflow = "hidden";
  picEl.src = src;
  picEl.alt = alt || "";
  // Estado inicial de animación (oculto + chico)
  picEl.style.transform = "scale(0.7)";
  picEl.style.opacity = "0";
  overlay.style.display = "flex";
  overlay.style.opacity = "0";
  document.body.style.overflow = "hidden";
  // Trigger animación en el siguiente frame (sin esto el browser no transiciona)
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      overlay.style.opacity = "1";
      picEl.style.transform = "scale(1)";
      picEl.style.opacity = "1";
    });
  });
}
function closeImgZoom() {
  var overlay = document.getElementById("imgZoomOverlay");
  if (!overlay) return;
  var picEl = document.getElementById("imgZoomPic");
  overlay.style.opacity = "0";
  if (picEl) {
    picEl.style.transform = "scale(0.7)";
    picEl.style.opacity = "0";
  }
  setTimeout(function () {
    overlay.style.display = "none";
    document.body.style.overflow = "";
  }, 200);
}
window.openImgZoom = openImgZoom;
window.closeImgZoom = closeImgZoom;
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    var overlay = document.getElementById("imgZoomOverlay");
    if (overlay && overlay.style.display !== "none") closeImgZoom();
  }
});

/***********************
 * TRADUCCIÓN A CHINO MANDARÍN (Google Translate)
 ***********************/
function toggleChineseTranslate() {
  var frame = document.querySelector(".goog-te-menu-frame");
  if (frame) {
    var combo = document.querySelector(".goog-te-combo");
    if (combo) {
      if (combo.value === "zh-CN") {
        document.cookie = "googtrans=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/";
        document.cookie = "googtrans=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=." + location.hostname;
        location.reload();
      } else {
        combo.value = "zh-CN";
        combo.dispatchEvent(new Event("change"));
      }
      return;
    }
  }
  var tries = 0;
  var iv = setInterval(function () {
    var combo = document.querySelector(".goog-te-combo");
    if (combo) {
      clearInterval(iv);
      combo.value = "zh-CN";
      combo.dispatchEvent(new Event("change"));
    }
    if (++tries > 40) clearInterval(iv);
  }, 100);
}
window.toggleChineseTranslate = toggleChineseTranslate;

