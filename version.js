// Tierra Nativa — versión del sitio.
// NO editar a mano: la bumpea `hooks/pre-commit` en cada commit, que además
// sincroniza los `?v=` de todos los .js y .css de las HTML para invalidar el
// cache del navegador. Activar una vez por clon con:
//     git config core.hooksPath hooks
// El formato tiene que ser MAJOR.MINOR.PATCH numérico: el hook le suma 1 al
// patch con aritmética de shell, así que un sufijo de texto lo rompe.
const APP_VERSION = "2.7.38";
// Expuesto para reusar la MISMA versión en subpáginas (p. ej. el Formato OSA),
// así con cambiar solo esta línea se actualiza todo.
window.APP_VERSION = APP_VERSION;

document.addEventListener("DOMContentLoaded", function () {
  document.querySelectorAll("[data-app-version]").forEach(function (el) {
    el.textContent = "v" + APP_VERSION;
  });
});
