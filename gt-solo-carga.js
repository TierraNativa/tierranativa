/* gt-solo-carga.js — Tomás G, 05/11/2026.
   GT (app de Tierra Nativa, otro proyecto) agrega «Cargar pedido» con el MISMO patrón que Gestión Virgilio:
   un iframe que embebe ESTE admin con ?gt_cp=1#carga-pedidos. No copia el loader: lo que cambie acá se ve en GT solo.
   En ese modo el menú muestra sólo el grupo «Carga Pedidos» (Cargar Cotizadores, Cotizadores Súper, Excel Krikos);
   el resto del menú, el logo y el footer quedan ocultos. Es comodidad, NO un permiso nuevo: la sesión es la del admin
   y la valida la base igual que siempre (login propio del mayorista dentro del iframe). Espejo de
   Gestion-Virgilio/admin/gv-solo-carga.js (ahí el disparador es gv_cp=1). */
(function () {
  "use strict";
  var MODO = /(?:^|&)gt_cp=1(?:&|$)/.test(location.search.slice(1));
  window.GT_SOLO_CARGA = MODO;
  if (!MODO) return;
  document.documentElement.classList.add("gt-cp");
  var css =
    // sólo el grupo «Carga Pedidos»: se esconden los otros grupos, los ítems sueltos, el logo y el footer.
    ".gt-cp .sidebar-nav .nav-group:not([data-group=\"carga-pedidos\"])," +
    ".gt-cp .sidebar-nav > .nav-item,.gt-cp .sidebar-nav > a.nav-item," +
    ".gt-cp .sidebar-logo,.gt-cp .sidebar-footer{display:none!important}" +
    // el submenú del grupo queda siempre abierto (el admin lo colapsa por acordeón).
    ".gt-cp .nav-group[data-group=\"carga-pedidos\"] .nav-submenu{max-height:none!important;opacity:1!important;" +
    "pointer-events:auto!important;padding:2px 0 4px 14px!important}" +
    ".gt-cp .nav-group[data-group=\"carga-pedidos\"] .nav-chevron{display:none!important}";
  var st = document.createElement("style");
  st.id = "gtSoloCargaCss";
  st.textContent = css;
  (document.head || document.documentElement).appendChild(st);
  // Si el admin abre otra pestaña por defecto, se vuelve a «Cargar Cotizadores» una sola vez, cuando aparece el shell.
  function asegurar() {
    var activa = document.querySelector(".nav-item.active[data-page]");
    var grupo = document.querySelector('.nav-group[data-group="carga-pedidos"]');
    if (activa && grupo && grupo.contains(activa)) return;
    var b = document.querySelector('.nav-group[data-group="carga-pedidos"] .nav-item[data-page="carga-pedidos"]');
    if (b) b.click();
  }
  function alCargar() {
    var shell = document.getElementById("appShell");
    if (!shell) { setTimeout(asegurar, 0); return; }
    var hecho = false;
    var mo = new MutationObserver(function () {
      if (hecho || shell.style.display === "none") return;
      hecho = true; mo.disconnect();
      setTimeout(asegurar, 0);
    });
    mo.observe(shell, { attributes: true, attributeFilter: ["style"] });
    if (shell.style.display !== "none") { hecho = true; mo.disconnect(); setTimeout(asegurar, 0); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", alCargar);
  else alCargar();
})();
