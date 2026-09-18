// ---------------------------------------------------------------------
// DESKTOP LAYOUT DETECTION, AND THE STAFF GATE
// ---------------------------------------------------------------------
// Two facts, written onto <html> as two attributes, and nothing else. All
// of the layout itself is CSS (see the html[data-layout="desktop"] block in
// index.html); this file only answers the two questions that CSS cannot ask
// on its own.
//
//   data-layout="desktop"  the viewport is a real desktop browser
//   data-staff="1"         the person using it is staff
//
// WHY BOTH, AND WHY SEPARATE. The brief that started this work asked for a
// desktop layout for GYM STAFF ONLY, with the member experience untouched -
// so "wide enough" and "allowed to see it" are two different questions and
// mixing them into one attribute makes the second one invisible. Written
// apart, the rule a stylesheet expresses is exactly the rule in prose: the
// staff shell is html[data-layout="desktop"][data-staff="1"], and there is
// deliberately NO rule keyed on data-layout alone, which is what keeps a
// member at a laptop on precisely the layout they had before.
//
// WHY (pointer: fine) IS HALF THE QUERY. A 1024px tablet in landscape is
// wide enough for a three-column shell and completely wrong for one: every
// control in it is sized for a cursor. Width alone would hand the coach's
// iPad a layout built for a mouse.
//
// NO FRAMEWORK, NO HOOK, NO BUILD STEP. This is a classic <script> in a
// build-free app, the same as every other file in src/. It exports plain
// functions onto the global object the way src/format.js does.
const DESKTOP_LAYOUT_QUERY = "(min-width: 1024px) and (pointer: fine)";

// One MediaQueryList for the life of the page, built lazily: matchMedia is
// absent in jsdom unless a test provides one, and an unsupported query
// string is a real possibility on an old browser. Both resolve to "not
// desktop", which is the layout that already works everywhere.
let desktopLayoutMql = null;
let desktopLayoutMqlBuilt = false;
function desktopLayoutMedia() {
  if (desktopLayoutMqlBuilt) return desktopLayoutMql;
  desktopLayoutMqlBuilt = true;
  try {
    desktopLayoutMql = (typeof window !== "undefined" && window.matchMedia)
      ? window.matchMedia(DESKTOP_LAYOUT_QUERY) : null;
  } catch (e) { desktopLayoutMql = null; }
  return desktopLayoutMql;
}
function isDesktopLayout() {
  const mql = desktopLayoutMedia();
  return !!(mql && mql.matches);
}

// THE GATE. cloud.js owns the real answer - window.communityIsStaff() is
// coach rank or above, or an unlocked management session, and it mirrors the
// server's public.is_staff(). cloud.js is an optional precache asset (the
// offline training log boots without it), so a missing export reads as "not
// staff": the safe direction, because it costs a coach the shell until
// cloud.js loads, where the other direction would show a member a layout
// built around data the server will refuse them.
//
// THIS IS A LAYOUT DECISION, NOT A PERMISSION. Every RPC behind the staff
// columns is gated in Postgres against the caller's own role. A member who
// forces this attribute true gets a three-column page whose staff panels
// come back empty.
function isStaffViewer() {
  try {
    return typeof window !== "undefined" && typeof window.communityIsStaff === "function"
      && !!window.communityIsStaff();
  } catch (e) { return false; }
}

// Writes both attributes and returns true when the staff shell is on. Called
// from render() on every pass, not only when the query flips: staffness
// arrives asynchronously, so a coach signing in mid-session has to reach the
// shell without resizing the window to tell the app about it.
function applyDesktopLayout() {
  const desktop = isDesktopLayout();
  const staff = desktop && isStaffViewer();
  try {
    const root = (typeof document !== "undefined") && document.documentElement;
    if (!root) return false;
    if (desktop) root.setAttribute("data-layout", "desktop"); else root.removeAttribute("data-layout");
    if (staff) root.setAttribute("data-staff", "1"); else root.removeAttribute("data-staff");
  } catch (e) { return false; }
  return staff;
}

// The live switch. addEventListener("change") with an addListener fallback,
// because Safari only grew the modern form in 14 and this app's install base
// includes older iPads - three lines, and the difference between the layout
// switching as a window is dragged and switching on the next reload.
//
// Deliberately NOT a resize listener: matchMedia fires once per crossing of
// the boundary, where resize fires continuously through a drag and would
// re-render the whole app on every frame of it.
function startDesktopLayoutWatch(rerender) {
  applyDesktopLayout();
  const mql = desktopLayoutMedia();
  if (!mql) return function () {};
  const handler = function () {
    applyDesktopLayout();
    if (typeof rerender === "function") rerender();
  };
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", handler);
    return function () { mql.removeEventListener("change", handler); };
  }
  if (typeof mql.addListener === "function") {
    mql.addListener(handler);
    return function () { mql.removeListener(handler); };
  }
  return function () {};
}
