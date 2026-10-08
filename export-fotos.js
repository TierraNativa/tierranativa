/**
 * export-fotos.js
 *
 * Requiere .env con SUPABASE_SERVICE_ROLE_KEY (ver .env.example).
 *
 * Baja las fotos ORIGINALES (no las miniaturas _sm) de todos los productos de
 * la tabla `products` y las deja en dos carpetas listas para zipear:
 *
 *   export/principales/{cod}.webp      ← la primera foto de cada producto
 *   export/todas/{cod}/1.webp, 2.webp  ← todas, en carpeta por codigo
 *
 * La lista sale de `products.images` (mismo criterio que getProductImages()
 * en script.js). Si un producto no tiene images, se prueba {cod}.webp en la
 * raiz del bucket. Al final escribe resumen.csv (en las dos carpetas) con lo
 * que se bajo.
 *
 * Uso:
 *   node export-fotos.js
 *
 * Se dispara desde Actions -> "Exportar fotos" -> Run workflow, que sube los
 * zips como artefacto de la corrida.
 */

const fs = require("fs");
const path = require("path");
const { createAdminClient } = require("./supabase-admin-client");

const BUCKET = "products-images";
const OUT = path.join(__dirname, "export");

const supabase = createAdminClient();

function parseImages(raw) {
  if (raw == null) return [];
  let list = raw;
  if (typeof list === "string") {
    const s = list.trim();
    try {
      list = s ? JSON.parse(s) : [];
    } catch (e) {
      list =
        s.startsWith("{") && s.endsWith("}")
          ? s
              .slice(1, -1)
              .split(",")
              .map((x) => x.replace(/^"|"$/g, "").trim())
          : [];
    }
  }
  return Array.isArray(list) ? list.filter(Boolean).map(String) : [];
}

// Acepta path del bucket ("631/1.webp") o URL publica completa.
function toBucketPath(entry) {
  let p = entry.split("?")[0];
  const marca = `/${BUCKET}/`;
  const i = p.indexOf(marca);
  if (i !== -1) p = p.substring(i + marca.length);
  return decodeURIComponent(p.replace(/^\/+/, ""));
}

function getExt(p) {
  const dot = p.lastIndexOf(".");
  return dot === -1 ? ".webp" : p.substring(dot).toLowerCase();
}

// Solo los digitos del codigo; si no tiene ninguno, el codigo tal cual.
function nombreCodigo(cod) {
  const s = String(cod).trim();
  const dig = s.replace(/\D/g, "");
  return dig || s.replace(/[\\/:*?"<>|]/g, "_");
}

async function fetchProducts() {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("products")
      .select("cod,active,images")
      .order("cod")
      .range(from, from + PAGE - 1);
    if (error) throw new Error("Error leyendo products: " + error.message);
    all.push(...data);
    if (data.length < PAGE) break;
  }
  return all;
}

async function download(p) {
  const { data, error } = await supabase.storage.from(BUCKET).download(p);
  if (error) return null;
  return Buffer.from(await data.arrayBuffer());
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, "principales"), { recursive: true });
  fs.mkdirSync(path.join(OUT, "todas"), { recursive: true });

  const products = await fetchProducts();
  console.log(`Productos en la tabla: ${products.length}\n`);

  const filas = [["cod", "nombre", "activo", "fotos_bajadas", "fotos_fallidas"]];
  const usados = new Map();
  let conFoto = 0;
  let sinFoto = 0;
  let totalFotos = 0;

  for (const prod of products) {
    let nombre = nombreCodigo(prod.cod);
    // Dos codigos distintos con los mismos digitos: no pisar.
    if (usados.has(nombre) && usados.get(nombre) !== prod.cod) {
      nombre = `${nombre}_${String(prod.cod).replace(/[^\w-]/g, "")}`;
    }
    usados.set(nombre, prod.cod);

    let rutas = parseImages(prod.images).map(toBucketPath);
    if (!rutas.length) rutas = [`${prod.cod}.webp`];

    let ok = 0;
    let fallidas = 0;
    for (let i = 0; i < rutas.length; i++) {
      const buf = await download(rutas[i]);
      if (!buf) {
        fallidas++;
        continue;
      }
      ok++;
      const ext = getExt(rutas[i]);
      if (ok === 1) {
        fs.writeFileSync(path.join(OUT, "principales", `${nombre}${ext}`), buf);
      }
      const dir = path.join(OUT, "todas", nombre);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${ok}${ext}`), buf);
    }

    totalFotos += ok;
    if (ok) conFoto++;
    else sinFoto++;
    filas.push([prod.cod, nombre, prod.active, ok, fallidas]);
    if (!ok) console.log(`   sin foto: ${prod.cod}`);
  }

  // Va dentro de cada carpeta para que viaje en los dos zips.
  const csv = filas.map((f) => f.join(";")).join("\n") + "\n";
  fs.writeFileSync(path.join(OUT, "principales", "resumen.csv"), csv);
  fs.writeFileSync(path.join(OUT, "todas", "resumen.csv"), csv);

  console.log(
    `\nProductos con foto: ${conFoto} · sin foto: ${sinFoto} · fotos bajadas: ${totalFotos}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
