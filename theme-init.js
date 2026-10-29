// Runs before first paint (loaded early in <head>, blocking) so there is no
// flash of the wrong palette or theme. Kept as its own tiny file rather than an
// inline <script> because the CSP's script-src 'self' has no 'unsafe-inline'.
//
// It only stamps attributes; every color is a token in index.html's
// <style id="tokens">. Same keys and defaults as src/theme.js, which owns the
// logic once the app is running (test/theme-setting.test.mjs keeps them equal):
//   data-palette       classic | chalk | slate | cedar | sand | iris   (default classic)
//   data-theme         light | dark; left off to follow the system ("auto"). Default dark,
//                      the look this app always opened in.
//   data-transparency  on | off                              (default off)
(function () {
  var root = document.documentElement;
  var palette = "classic", theme = "dark", transparency = "off", large = false;
  try {
    var p = localStorage.getItem("haimunia-demo:palette");
    if (p === "classic" || p === "chalk" || p === "slate" || p === "cedar" || p === "sand" || p === "iris") palette = p;
    var t = localStorage.getItem("haimunia-demo:theme");
    if (t === "light" || t === "dark" || t === "auto") theme = t;
    if (localStorage.getItem("haimunia-demo:transparency") === "on") transparency = "on";
    large = localStorage.getItem("haimunia-demo:textScale") === "large";
  } catch (e) {}
  root.setAttribute("data-palette", palette);
  if (theme !== "auto") root.setAttribute("data-theme", theme);
  root.setAttribute("data-transparency", transparency);
  if (large) root.setAttribute("data-text-scale", "large");
})();
