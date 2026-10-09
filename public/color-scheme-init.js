// Sets the colour-scheme attribute before first paint, so a stored dark preference never flashes
// light. External and render-blocking on purpose: the page's script policy is 'self' only.
// It mirrors what the UI library's provider does once React runs: storage keys "mui-mode",
// "mui-color-scheme-light", "mui-color-scheme-dark"; attribute data-light / data-dark on <html>.
(function () {
  try {
    var root = document.documentElement;
    var mode = localStorage.getItem("mui-mode") || "system";
    var dark = localStorage.getItem("mui-color-scheme-dark") || "dark";
    var light = localStorage.getItem("mui-color-scheme-light") || "light";
    var scheme = "";
    if (mode === "system") {
      scheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? dark : light;
    }
    if (mode === "light") scheme = light;
    if (mode === "dark") scheme = dark;
    if (scheme) {
      root.removeAttribute("data-" + light);
      root.removeAttribute("data-" + dark);
      root.setAttribute("data-" + scheme, "");
    }
  } catch {
    // Storage blocked: the provider falls back to the system scheme.
  }
})();
