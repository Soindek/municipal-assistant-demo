/**
 * Builds the standalone, dependency-free loader script served at GET /widget.js.
 *
 * Dropped onto any page with a single <script src=".../widget.js" defer></script>,
 * it renders a floating launcher button (Intercom/Crisp style) that opens a panel
 * containing the chat app in an iframe. The iframe is created LAZILY on first open
 * so it never slows the host page's initial load.
 *
 * Config (app origin, title, accent) is injected here so the script is self-
 * contained and tenant-aware — the browser side reads it from the CFG argument.
 */
export function buildWidgetScript(opts: {
  appOrigin: string;
  title: string;
  launcherLabel: string;
  accent: string;
  onPrimary: string;
  icon: string;
  version: string;
  versionBadge: string;
}): string {
  const cfg = JSON.stringify({
    origin: opts.appOrigin,
    title: opts.title,
    label: opts.launcherLabel,
    accent: opts.accent,
    onPrimary: opts.onPrimary,
    icon: opts.icon,
    version: opts.version,
    versionBadge: opts.versionBadge,
  });

  // The body below is plain browser JS (no backticks / template literals, so it
  // nests cleanly in this TS template string). It receives the injected CFG.
  return `(function (CFG) {
  "use strict";
  if (window.__municipalAssistantWidget) return;
  window.__municipalAssistantWidget = true;

  var NS = "maw";
  var FONT = "system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif";
  var GREETING_KEY = "maw-greeting-dismissed";
  var doc = document;

  var iframe = null;   // created lazily on first open
  var panel = null;
  var isOpen = false;
  var lastFocused = null;

  function styles() {
    var a = CFG.accent;
    var fg = CFG.onPrimary;
    return [
      "." + NS + "-launcher{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:inline-flex;align-items:center;gap:8px;padding:12px 18px;border:0;border-radius:999px;background:" + a + ";color:" + fg + ";font:600 15px/1 " + FONT + ";cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.22);transition:transform .15s ease,box-shadow .15s ease}",
      "." + NS + "-launcher:hover{transform:translateY(-1px);box-shadow:0 10px 28px rgba(0,0,0,.28)}",
      "." + NS + "-launcher:focus-visible{outline:3px solid rgba(0,0,0,.35);outline-offset:2px}",
      "." + NS + "-launcher-icon{font-size:21px;font-weight:700;line-height:1;flex:none}",
      "." + NS + "-panel{position:fixed;right:20px;bottom:90px;z-index:2147483000;width:380px;height:600px;max-height:calc(100vh - 120px);display:flex;flex-direction:column;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,.28);opacity:0;visibility:hidden;transform:translateY(12px);transition:opacity .18s ease,transform .18s ease,visibility .18s}",
      "." + NS + "-panel--open{opacity:1;visibility:visible;transform:none}",
      "." + NS + "-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;background:" + a + ";color:" + fg + ";font:600 15px/1.2 " + FONT + "}",
      "." + NS + "-title{font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "." + NS + "-ver{font-weight:400;font-size:12px;opacity:.85}",
      "." + NS + "-ver::before{content:'|';margin:0 7px;opacity:.55}",
      "." + NS + "-close{border:0;background:transparent;color:" + fg + ";cursor:pointer;padding:4px;border-radius:8px;display:inline-flex;line-height:0}",
      "." + NS + "-close:hover{background:rgba(0,0,0,.12)}",
      "." + NS + "-close:focus-visible{outline:2px solid rgba(0,0,0,.4);outline-offset:1px}",
      "." + NS + "-close svg{width:20px;height:20px}",
      "." + NS + "-iframe{flex:1 1 auto;width:100%;border:0;background:#fff}",
      "." + NS + "-greeting{position:fixed;right:20px;bottom:86px;z-index:2147482999;max-width:240px;background:#fff;color:#1a1a1a;border-radius:14px;padding:12px 34px 12px 14px;box-shadow:0 8px 28px rgba(0,0,0,.2);font:14px/1.4 " + FONT + ";cursor:pointer}",
      "." + NS + "-greeting-close{position:absolute;top:4px;right:6px;border:0;background:transparent;color:#6b7280;font-size:18px;cursor:pointer;line-height:1;padding:2px 6px}",
      "@media (max-width:480px){." + NS + "-panel{right:0;bottom:0;width:100%;height:100%;max-height:100%;border-radius:0}." + NS + "-launcher--open{display:none}." + NS + "-greeting{display:none}}"
    ].join("");
  }

  // --- inline SVG close icon (inherits currentColor) ---
  function iconClose() {
    return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  }

  var style = doc.createElement("style");
  style.textContent = styles();
  doc.head.appendChild(style);

  // --- launcher button ---
  var launcher = doc.createElement("button");
  launcher.type = "button";
  launcher.className = NS + "-launcher";
  launcher.setAttribute("aria-label", CFG.label);
  launcher.setAttribute("aria-expanded", "false");
  var icon = doc.createElement("span");
  icon.className = NS + "-launcher-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = CFG.icon; // tenant-configured glyph (e.g. §)
  var label = doc.createElement("span");
  label.className = NS + "-launcher-text";
  label.textContent = CFG.label;
  launcher.appendChild(icon);
  launcher.appendChild(label);
  launcher.addEventListener("click", toggle);

  function buildPanel() {
    panel = doc.createElement("div");
    panel.className = NS + "-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", CFG.title);

    var header = doc.createElement("div");
    header.className = NS + "-header";
    var title = doc.createElement("span");
    title.className = NS + "-title";
    title.textContent = CFG.title;
    var verParts = [];
    if (CFG.versionBadge) verParts.push(CFG.versionBadge);
    if (CFG.version) verParts.push("v" + CFG.version);
    if (verParts.length) {
      var ver = doc.createElement("span");
      ver.className = NS + "-ver";
      ver.textContent = verParts.join(" · ");
      title.appendChild(ver);
    }
    var close = doc.createElement("button");
    close.type = "button";
    close.className = NS + "-close";
    close.setAttribute("aria-label", "Bezárás");
    close.innerHTML = iconClose();
    close.addEventListener("click", closePanel);
    header.appendChild(title);
    header.appendChild(close);

    iframe = doc.createElement("iframe");
    iframe.className = NS + "-iframe";
    iframe.title = CFG.title;
    iframe.setAttribute("loading", "lazy");
    iframe.src = CFG.origin + "/?embed=widget";

    panel.appendChild(header);
    panel.appendChild(iframe);
    doc.body.appendChild(panel);
    panel._close = close;
  }

  function openPanel() {
    if (!panel) buildPanel();
    lastFocused = doc.activeElement;
    isOpen = true;
    // Force reflow so the open transition runs even right after creation.
    void panel.offsetWidth;
    panel.classList.add(NS + "-panel--open");
    launcher.classList.add(NS + "-launcher--open");
    launcher.setAttribute("aria-expanded", "true");
    dismissGreeting(true);
    setTimeout(function () {
      if (panel && panel._close) panel._close.focus();
    }, 60);
  }

  function closePanel() {
    isOpen = false;
    if (panel) panel.classList.remove(NS + "-panel--open");
    launcher.classList.remove(NS + "-launcher--open");
    launcher.setAttribute("aria-expanded", "false");
    if (lastFocused && lastFocused.focus) lastFocused.focus();
    else launcher.focus();
  }

  function toggle() {
    if (isOpen) closePanel();
    else openPanel();
  }

  // Esc closes the panel.
  doc.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isOpen) closePanel();
  });

  // The app may ask the host to close (postMessage) — only trust our own origin.
  window.addEventListener("message", function (e) {
    if (e.origin !== CFG.origin) return;
    if (e.data && e.data.type === "municipal-assistant:close") closePanel();
  });

  // --- discrete one-time greeting bubble (does NOT auto-open the panel) ---
  var greeting = null;
  function dismissGreeting(remember) {
    if (greeting && greeting.parentNode) greeting.parentNode.removeChild(greeting);
    greeting = null;
    if (remember) {
      try { localStorage.setItem(GREETING_KEY, "1"); } catch (err) {}
    }
  }
  function maybeShowGreeting() {
    var seen = false;
    try { seen = localStorage.getItem(GREETING_KEY) === "1"; } catch (err) {}
    if (seen) return;
    setTimeout(function () {
      if (isOpen || greeting) return;
      greeting = doc.createElement("div");
      greeting.className = NS + "-greeting";
      greeting.setAttribute("role", "button");
      greeting.setAttribute("tabindex", "0");
      greeting.appendChild(doc.createTextNode(CFG.label));
      var g = doc.createElement("button");
      g.type = "button";
      g.className = NS + "-greeting-close";
      g.setAttribute("aria-label", "Elvetés");
      g.textContent = "\\u00d7";
      g.addEventListener("click", function (e) { e.stopPropagation(); dismissGreeting(true); });
      greeting.appendChild(g);
      greeting.addEventListener("click", openPanel);
      greeting.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPanel(); }
      });
      doc.body.appendChild(greeting);
    }, 4000);
  }

  function mount() {
    doc.body.appendChild(launcher);
    maybeShowGreeting();
  }
  if (doc.body) mount();
  else doc.addEventListener("DOMContentLoaded", mount);
})(${cfg});
`;
}
