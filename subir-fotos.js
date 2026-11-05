/**
 * subir-fotos.js
 *
 * REEMPLAZA las fotos de uno o más códigos en el bucket "products-images".
 *
 * Toma lo que haya en la carpeta del repo fotos-nuevas/{cod}/ (ej.
 * fotos-nuevas/619/1.webp y 1_sm.webp) y, por cada código:
 *   1. descarga a backup-images/{cod}/ todo lo que hoy hay en products-images/{cod}/
 *   2. borra esos archivos del bucket
 *   3. sube los archivos nuevos a products-images/{cod}/
 *   4. (opcional, --db) deja products.images = ["{cod}/1.webp", ...] con las
 *      originales nuevas (sin las _sm), en orden
 *
 * Por defecto es SIMULACIÓN: lista qué se borraría y qué se subiría, y muestra
 * el valor actual de products.images. No cambia nada.
 *
 * Uso:
 *   node subir-fotos.js            -> simulación
 *   node subir-fotos.js --run      -> backup + borrar + subir
 *   node subir-fotos.js --run --db -> además actualiza products.images
 *
 * Se corre desde Actions -> "Subir fotos" (usa el secreto
 * SUPABASE_SERVICE_ROLE_KEY). Después de una corrida exitosa, borrar la
 * carpeta fotos-nuevas/ del repo para que las fotos no queden versionadas.
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = "https://zjvpzqhbekxnwxdczpof.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = "products-images";
const ORIGEN = path.join(__dirname, "fotos-nuevas");
const BACKUP = path.join(__dirname, "backup-images");

const RUN = process.argv.includes("--run");
const DB = process.argv.includes("--db");

if (!KEY) {
  console.error("Falta SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, KEY, {
  auth: { persistSession: false },
});

const MIME = {
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".avif": "image/avif",
};

function esMiniatura(nombre) {
  return /_sm\.[a-z0-9]+$/i.test(nombre);
}

// Orden natural: 1.webp, 2.webp, ..., 10.webp
function ordenNatural(a, b) {
  return a.localeCompare(b, undefined, { numeric: true });
}

async function main() {
  if (!fs.existsSync(ORIGEN)) {
    console.error("No existe la carpeta fotos-nuevas/.");
    process.exit(1);
  }

  const codigos = fs
    .readdirSync(ORIGEN, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort(ordenNatural);

  if (!codigos.length) {
    console.error("fotos-nuevas/ no tiene carpetas por código.");
    process.exit(1);
  }

  console.log(
    RUN
      ? `🚀 APLICANDO${DB ? " (+ products.images)" : ""}\n`
      : "🔍 SIMULACIÓN — no se cambia nada (usar --run para aplicar)\n",
  );

  let errores = 0;

  for (const cod of codigos) {
    console.log(`── ${cod}`);

    const nuevos = fs
      .readdirSync(path.join(ORIGEN, cod))
      .filter((f) => MIME[path.extname(f).toLowerCase()])
      .sort(ordenNatural);

    if (!nuevos.length) {
      console.log("   (carpeta vacía, se saltea)\n");
      continue;
    }

    // Estado actual en el bucket.
    const { data: lista, error: errLista } = await supabase.storage
      .from(BUCKET)
      .list(cod, { limit: 1000 });
    if (errLista) {
      console.error(`   ✖ listando: ${errLista.message}`);
      errores++;
      continue;
    }
    const actuales = (lista || []).filter((i) => i.id !== null).map((i) => i.name);

    // Estado actual en la tabla.
    const { data: prod, error: errProd } = await supabase
      .from("products")
      .select("cod, images")
      .eq("cod", cod)
      .maybeSingle();
    if (errProd) console.log(`   ⚠ products: ${errProd.message}`);
    else if (!prod) console.log("   ⚠ el código NO existe en products");
    else console.log(`   products.images hoy: ${JSON.stringify(prod.images)}`);

    console.log(`   en el bucket hoy:     ${actuales.length ? actuales.join(", ") : "(nada)"}`);
    console.log(`   a subir:              ${nuevos.join(", ")}`);

    const originales = nuevos.filter((f) => !esMiniatura(f)).map((f) => `${cod}/${f}`);
    if (DB) console.log(`   products.images nuevo: ${JSON.stringify(originales)}`);

    if (!RUN) {
      console.log("");
      continue;
    }

    try {
      // 1) Backup.
      fs.mkdirSync(path.join(BACKUP, cod), { recursive: true });
      for (const f of actuales) {
        const { data, error } = await supabase.storage.from(BUCKET).download(`${cod}/${f}`);
        if (error) throw new Error(`backup ${cod}/${f}: ${error.message}`);
        fs.writeFileSync(path.join(BACKUP, cod, f), Buffer.from(await data.arrayBuffer()));
      }
      console.log(`   ✔ backup: ${actuales.length} archivo(s)`);

      // 2) Borrar.
      if (actuales.length) {
        const { error } = await supabase.storage
          .from(BUCKET)
          .remove(actuales.map((f) => `${cod}/${f}`));
        if (error) throw new Error(`borrando: ${error.message}`);
      }
      console.log(`   ✔ borrados: ${actuales.length}`);

      // 3) Subir.
      for (const f of nuevos) {
        const buf = fs.readFileSync(path.join(ORIGEN, cod, f));
        const { error } = await supabase.storage
          .from(BUCKET)
          .upload(`${cod}/${f}`, buf, {
            contentType: MIME[path.extname(f).toLowerCase()],
            upsert: true,
          });
        if (error) throw new Error(`subiendo ${f}: ${error.message}`);
      }
      console.log(`   ✔ subidos: ${nuevos.length}`);

      // 4) Tabla.
      if (DB) {
        if (!prod) throw new Error("no se actualiza products: el código no existe");
        const { error } = await supabase
          .from("products")
          .update({ images: originales })
          .eq("cod", cod);
        if (error) throw new Error(`products.images: ${error.message}`);
        const { data: check } = await supabase
          .from("products")
          .select("images")
          .eq("cod", cod)
          .maybeSingle();
        console.log(`   ✔ products.images verificado: ${JSON.stringify(check && check.images)}`);
      }
    } catch (e) {
      console.error(`   ✖ ${e.message}`);
      errores++;
    }
    console.log("");
  }

  if (errores) {
    console.error(`Terminó con ${errores} error(es).`);
    process.exit(1);
  }
  console.log("Listo.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
