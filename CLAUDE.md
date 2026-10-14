# CLAUDE.md

Guía para Claude Code (claude.ai/code) al trabajar en este repositorio.

## Overview

Sitio estático multipágina de **Tierra Nativa SA** (fábrica argentina de cuadros,
portarretratos, bandejas y deco en madera; marca comercial **Tierra Vintage**).
No hay build, ni bundler, ni tests: los archivos se sirven tal cual. Todo el JS
corre en el navegador y habla directo con Supabase.

**Este repo es un PORT de `loekemeyer/PaginaLK`**, el sitio de Loekemeyer SRL.
Los dos comparten casi todo el frontend del catálogo: `script.js`,
`css/styles.css`, `historial.*` y `sugerencias.*` son la misma base con la marca
y el backend cambiados. Cuando algo no se entiende acá, mirar cómo está resuelto
allá suele ser el camino más corto — pero **verificar antes de portar**: hay
divergencias deliberadas (ver *Diferencias contra PaginaLK*).

## Backend (Supabase)

- Project URL `https://zjvpzqhbekxnwxdczpof.supabase.co`. La anon key
  (`sb_publishable_...`, formato nuevo) está embebida en **cada** archivo JS que
  crea un cliente: `script.js`, `admin.js`, `historial.js`, `sugerencias.js`. Si
  se rota, hay que cambiarla en los cuatro lugares. Es pública a propósito (el
  repo se sirve por GitHub Pages), así que **la seguridad real es RLS**, no
  esconder la key.
- Auth con email/password sobre un email sintético: `<cuit-digits>@cuit.tierranativa`
  y un PIN de 6 dígitos como contraseña. **El dominio es `tierranativa`, no
  `loekemeyer`** — es el error de copy-paste más fácil de cometer al portar algo
  de PaginaLK.
- El rol admin se resuelve por presencia del `auth_user_id` del usuario en la
  tabla `admins`; las páginas de admin redirigen a `mayorista.html` si el chequeo
  falla.
- Tablas que toca el frontend de cliente: `customers`,
  `customer_delivery_addresses`, `admins`, `products`, `orders`, `order_items`,
  `order_tracking`, `app_settings`, `saved_carts`, `expresos`,
  `cart_add_events`, `novedades_impressions`, `loke_products`.
- RPCs que llama el lado cliente: `submit_order_fast`, `edit_order_fast`,
  `get_my_assortment_18m`, `get_my_linked_customers`, `get_my_group_customers`,
  `get_my_vendor_orders`, `get_customer_history`, `get_customer_geo`,
  `sugerencias_cliente`, `novedades_marca`, `set_my_pin`.
- Edge Functions llamadas por `fetch` (no por el SDK): `sheets-proxy` y
  `sheets-entregas-proxy` (empujan los pedidos confirmados a Google Sheets),
  `notify-new-address` y `notify-m3-mismatch`. La única versionada en el repo es
  `supabase/functions/admin-otp`.
- **Hacer el trabajo pesado en una RPC, no en el navegador.** La API REST de
  Supabase corta las respuestas en 1000 filas **sin error**: un
  `.from("...").select(...)` devuelve una tajada truncada y nada avisa. El rol
  `authenticated` además tiene `statement_timeout` de ~8 s.
- **Postgres le da `EXECUTE` a `PUBLIC` en cada función nueva, y `anon` hereda de
  `PUBLIC`.** O sea que toda RPC nueva nace ejecutable con la anon key; si además
  es `SECURITY DEFINER`, corre como `postgres` y saltea RLS. Una RPC nueva **no
  está protegida por omisión**: o lleva el chequeo de admin adentro, o hay que
  revocarle el `EXECUTE` a `PUBLIC`/`anon`.

## Imágenes de producto

Es la divergencia más grande contra PaginaLK y conviene tenerla clara.

- En PaginaLK hay **una** foto por producto, en la raíz del bucket:
  `products-images/{cod}.webp`.
- Acá hay **varias** fotos por producto, en **carpetas por código**
  (`products-images/{cod}/1.webp`, `2.webp`, …). La lista canónica vive en la
  columna `products.images`, que `getProductImages()` tolera como array, como
  JSON string o como array de Postgres (`{a,b}`).
- Si un producto no tiene `images`, se intenta **un solo** `{cod}.webp` en la
  raíz y el `onerror` cae a `img/no-image.jpg`. No disparar la cascada
  `.webp/.jpg/.jpeg/.png`: en este bucket fallan las cuatro.
- La grilla carga la **miniatura `_sm`** (~700 px) y el zoom usa la original
  (`data-full`), que recién se descarga al hacer click. `thumbUrl()` inserta
  `_sm` antes de la extensión. Si la miniatura todavía no existe, el `onerror`
  cae a la original.
- Las miniaturas las genera `make-thumbnails.js` contra el bucket. **No hace
  falta terminal**: se dispara desde Actions → *Generar miniaturas* → Run
  workflow. Necesita el secreto `SUPABASE_SERVICE_ROLE_KEY` en el repo.
- El resto de los scripts Node de la raíz (`optimize-images.js`,
  `compress-75kb.js`, `download-all-images.js`, `rename-images.js`,
  `storage-audit.js`, `storage-size.js`, `check-non-webp.js`,
  `recreate-bucket.js`) son mantenimiento de storage que se corre a mano. Leen
  `.env` (ver `.env.example`); **`.env` no se versiona y la service_role key
  nunca va al repo.**

## Páginas y sus scripts

| Página | Script | Rol |
|---|---|---|
| `index.html` | `script.index.js` + `css/styles.index.css` | Landing público: hero con video, Nosotros, Catálogo, Contacto, modales legales. No usa Supabase. |
| `mayorista.html` | `script.js` + `css/styles.css` | Catálogo B2B: login, navegación, carrito, envío de pedido, perfil. Un solo archivo con todas las "secciones" (`productos`, `carrito`, `perfil`, `pedidoConfirmado`, …); `showSection(id)` prende `.active` sobre los nodos `.section`. |
| `historial.html` | `historial.js` + `css/historial.css` | Pedidos anteriores del cliente. |
| `sugerencias.html` | `sugerencias.js` + `css/sugerencias.css` | Sugerencias y novedades por cliente (`sugerencias_cliente` / `novedades_marca`). |
| `admin.html` | `admin.js` + `css/admin.css` | Panel de admin con nav lateral (`data-page` en los `.nav-item`, deep-link por `location.hash`). |

## Convenciones del lado cliente (`script.js`)

- Es un archivo enorme sin módulos ni IIFE. Las funciones se exponen a los
  `onclick=` inline por `window.showSection = showSection` etc., cerca del final
  del archivo. **Al agregar un handler que se use desde HTML, re-exportarlo en
  `window`** o no existe para el markup.
- El estado global son `let`s de nivel superior: `products`, `cart`,
  `customerProfile`, `isAdmin`, `deliveryChoice`, `sortMode`… No hay framework:
  las funciones de render leen esos globales y escriben el DOM.
- **El orden de categorías está hardcodeado**: `CATEGORY_ORDER` (`Cuadros`,
  `Portaretratos`, `Deco`, `Importados`). Una categoría nueva no aparece en el
  menú hasta agregarla ahí.
- La categoría que se subdivide es **`Cuadros`** (`SUBCATEGORY_PARENT`), con
  `CUADROS_SUB_ORDER` siguiendo el Catálogo 2026 DIGITAL. En PaginaLK el
  equivalente es `Utensilios` / `UTENSILIOS_SUB_ORDER`.
- **Filtro por medida**: solo aplica a Cuadros. Las medidas se derivan de la
  descripción del producto (`medidasFromDescription`). `FEATURED_MEDIDAS` van
  primero y con 🔥; el resto queda detrás de un "Ver más".

## Diferencias contra PaginaLK

Lo que tiene Elías y allá no:
- Fotos múltiples por producto en carpetas + miniaturas `_sm` (arriba).
- Filtro por medida en Cuadros.
- `preconnect` / `dns-prefetch` al storage de Supabase en `mayorista.html`.
- El workflow de Actions para generar miniaturas.

Lo que tiene PaginaLK y acá **no corresponde** portar:
- **Línea Loke** (`has_loke_access`, botones `lokeLink` / `mobileLokeBtn`): se
  retiró de la nav en el commit `d33744f`. **Ojo: la sección `<section id="loke">`
  quedó en `mayorista.html` y ya no hay ningún `showSection('loke')` que la
  alcance — es código muerto.**
- "Importar Excels Megashops" (`vendor-import-excel.js`, vendedor 10006).
- Formato OSA / Torres y Liva. **`FORMATO_CLIENTES` quedó como array vacío**, así
  que `formatoDeCliente()` siempre devuelve `null` y todo ese UI queda en
  `display:none`. Los `href="osa/index.html"` de `mayorista.html`
  (`menuFormatoOsa`, `osaFormatLink`) apuntan a una carpeta que no existe en este
  repo: son markup muerto, inalcanzable mientras el array siga vacío.
- Todo el módulo de cruce con Chef, el Ranking Inactivos y Gerente de ventas.

## Secciones del landing que PaginaLK tiene y acá se decidieron NO tener

Las dos estaban como código muerto heredado del port y se borraron a pedido del
dueño. **No volver a portarlas por iniciativa propia.**

- **Feed de Instagram.** Estaba comentado entero en `index.html`, con un widget de
  Elfsight que apuntaba a la cuenta de **loekemeyer**, no a tierranativasa —
  descomentarlo habría mostrado el feed de la otra empresa. Se borró junto con su
  CSS (`.social-section`, `.ig-widget-wrap`, las reglas que escondían el branding
  de Elfsight). **Sigue estando el botón flotante de Instagram** abajo a la
  derecha (`a.ig`), que apunta a `instagram.com/tierranativasa` y sí es correcto.
- **"Empresas que confían en nosotros."** El carrusel rebotando de logos de
  clientes. El markup nunca se portó, pero habían quedado `initClientesBounce()`
  en `script.index.js` y unas 70 líneas de `.clientes-*` en el CSS, apuntando a
  un `#clientesBounce` que no existía. Todo eso se borró.

## El acceso mayorista es abierto

`#btnMayorista` del hero es un `<a href="mayorista.html">` y navega solo. **No
hay JS de por medio y no debe volver a haberlo.**

Hubo un modal "Sitio en construcción" que le interceptaba el click y pedía una
contraseña **escrita en el HTML** (`var PASS = "..."`). Nunca fue seguridad —
cualquiera que abriera el código fuente la veía, y el repo es público— sino un
cartel de "todavía no abrimos". Se retiró al abrir el sitio, junto con el CSS
muerto de una pantalla "en desarrollo" anterior (`.dev-box`, `#enDesarrollo`).

La protección real de los datos es el login de Supabase (CUIT + PIN) más RLS, y
nunca dependió del modal.

## Operaciones comunes

- **Correr local**: abrir `index.html` o `mayorista.html` en el navegador, o
  servir la carpeta con cualquier server estático (`python -m http.server`). No
  hay dev server.
- **Deploy: se despliega SOLO con el push a `main`.** El sitio se publica por
  **GitHub Pages**, que rebuildea con cada push (workflow *"pages build and
  deployment"*). Tarda de 30 s a un par de minutos; si el cambio no se ve, lo más
  probable es que la corrida esté en cola. No hay nada que copiar a mano después
  del push, solo `Ctrl+F5`.
- El dominio del negocio es `tierravintage.com.ar` (así está declarado en
  `robots.txt` y `sitemap.xml`), pero el sitio se sirve desde
  `loekemeyer.github.io/Elias/`. Si la publicación definitiva queda en otra URL,
  actualizar los dos archivos.
- **`web.config` es para IIS y hoy es inerte** (GitHub Pages lo ignora). Se
  versiona por si alguna vez se sirve desde IIS: sin su `<staticContent>`, IIS
  devuelve 404 para toda extensión que no tenga declarada (`.webp`, `.woff2`,
  `.avif`). Si el despliegue a IIS usara espejo (`robocopy /MIR`,
  `rsync --delete`), pisaría el del servidor.
- **Librerías de terceros** por CDN en los HTML (Supabase JS v2, Chart.js, xlsx,
  jsPDF, lottie-web). No hay bundler: se agregan igual, con un `<script src=…>`.

## Versionamiento automático

Los hooks viven en **`hooks/`** (versionados) y automáticamente:
- Incrementan el patch de `version.js` (2.7.0 → 2.7.1).
- Actualizan los `?v=XXX` de **todos** los `.js` y `.css` en los HTML, que es el
  cache busting del navegador.
- Reescriben el mensaje de commit con la lista de archivos cambiados.

**Activación (una vez por clon):**
```bash
git config core.hooksPath hooks
```
Sin eso los hooks **no** corren: `.git/hooks` no se versiona, así que un clon
nuevo —o una sesión de Claude en un contenedor— arranca sin ellos. Si ves un
commit sin `bump:` en el mensaje, es que faltó este paso y los `?v=` quedaron
viejos.

**El formato de `APP_VERSION` tiene que ser `MAJOR.MINOR.PATCH` numérico.** El
hook le suma 1 al patch con aritmética de shell y corre con `set -e`: un sufijo
de texto (`2.7.0-miniaturas`) aborta el commit.

`prepare-commit-msg` corre DESPUÉS de `pre-commit`, así que cuando lee
`version.js` ya está bumpeada. Por eso saca la versión vieja de
`git show HEAD:version.js` y no restándole 1 al archivo.

## SEO / crawling

- `robots.txt` allow-listea explícitamente los crawlers de IA y buscadores
  (GPTBot, ClaudeBot, Google-Extended, PerplexityBot, bingbot, CCBot…) y declara
  el sitemap.
- `sitemap.xml` lista solo las dos entradas públicas: `/` y `/mayorista.html`.
  Las páginas detrás del login (`historial.html`, `sugerencias.html`,
  `admin.html`) **no** van: su contenido vive detrás de Supabase auth, no es
  rastreable, y llevan `<meta name="robots" content="noindex">`.
- Al agregar una página pública, actualizar `sitemap.xml` (con `<lastmod>`) y la
  nav que corresponda.

## Gotchas

- **El WhatsApp de Tierra Nativa es `5491131181185`. El `1131181021` es el de
  Loekemeyer.** Los dos empiezan igual (3118) y se confunden fácil. Hasta el
  4/8/2026 `mayorista.html` tenía CINCO links al número de Loekemeyer, heredados
  del port: un cliente de Tierra Nativa que pedía su contraseña le escribía a la
  otra empresa. Al tocar un `wa.me`, verificar contra el teléfono que declara la
  política de privacidad en `script.index.js`.
- **Los `wa.me` de móviles argentinos llevan el `9`**: `54` + `9` + área + número.
  Sin el 9 (`541131181185`) WhatsApp lo toma como fijo y el link no abre chat.
  Había cuatro así. **PaginaLK todavía tiene links sin el 9** — si se porta algo
  de allá, revisarlo.
- **El idioma es español** en textos de UI, nombres de variables y comentarios.
  Seguir el estilo de lo que está alrededor.
- `admin.js` usa `var` y JS de función-scope a la vieja; `script.js`,
  `historial.js` y `sugerencias.js` usan `const`/`let` y arrow functions. **No
  "modernizar" `admin.js` de paso** — es consistente consigo mismo.
- El bloque de URL/anon key/helpers de imagen está **duplicado a propósito** en
  varios archivos (no hay sistema de módulos). Al cambiar cualquiera de esas
  constantes, grepear en todo el repo.
- `.gitattributes` fuerza `* -text` para que git no normalice a CRLF: sin eso los
  diffs del port contra PaginaLK son 100% ruido.
- `.locks/` está en `.gitignore`. El protocolo de file-locks que usa PaginaLK
  (varias personas editando sobre un share SMB) **no aplica acá**.
- El mapa de `argentina-map-data.js` carga `argentina-provinces.json` **local**
  (extensión `.json`, no `.geojson`, porque IIS 404ea las extensiones que no
  tiene declaradas). Si ese archivo falta, la carga cae a dos CDN y, si esos
  tampoco responden, a un fallback simplificado que son **rectángulos, no
  Argentina**.

## Planify (registro de tareas de las sesiones de Claude)

- Proyecto Supabase `hrxfctzncixxqmpfhskv`, schema `planify` (no es el backend
  del sitio).
- Trabajo → crear tarea al empezar en `planify.tasks` (nombre ≤60, nota 1-3
  líneas, `done=false`); consulta → no. Al cumplir el objetivo, preguntar si falta
  algo y recién ahí `done=true`.
- Thomas Loekemeyer → `employee_id` 20, prefijo "Th ". Otros empleados:
  `SELECT id,nombre FROM planify.employees WHERE activo AND nombre ILIKE '%<apellido>%';`
