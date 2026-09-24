"use strict";
// ---- Community: מסך תצוגה במועדון, the screen on the wall ------------------
//
// WHAT THIS IS (202609230005). A television in the training room, opened once
// at `?display=1` and left running. It shows today's club WOD and who has
// posted a result, and it is the only surface in this app with no navigation
// at all: there is nothing to tap, and no way to get from it to anything else.
//
// WHY IT TAKES THE WHOLE PAGE OVER rather than being a sixth tab. A tab lives
// inside the app shell, which carries a menu, a bottom bar and a route to
// every member surface. On a screen anybody in the room can reach, each of
// those is a way in. This hides the shell and draws its own page, so the only
// thing on the glass is the board.
//
// WHAT IT TRUSTS: nothing. The board comes from `gym_display_board()`, which
// refuses unless the caller holds the gym_display role AND the club has the
// module on, and which masks names in the database rather than here. This
// file renders what it is handed.
//
// EVERY TOP-LEVEL NAME IS gymDisplay-PREFIXED, on purpose. These modules are
// classic scripts sharing one global lexical scope - no IIFE, because that
// would cut the file off from `state`, `client` and `esc` the way its
// siblings reach them - so a bare `render` or `start` here would be a
// redeclaration that takes down whichever script loads second. The first
// draft of this file was an IIFE with exactly those names and the suite
// caught all three violations at once.
  const GYM_DISPLAY_PARAM = "display";
  const GYM_DISPLAY_REFRESH_MS = 60000;
  // A wall screen runs for weeks. Back off rather than hammer when the network
  // or the project is down, and recover on its own when it returns.
  const GYM_DISPLAY_BACKOFF_MS = 300000;

  function gymDisplayWanted() {
    try {
      return new URLSearchParams(location.search).get(GYM_DISPLAY_PARAM) === "1";
    } catch (e) { return false; }
  }

  function gymDisplayEl(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function gymDisplayClock(d) {
    try {
      return new Intl.DateTimeFormat("he-IL", { hour: "2-digit", minute: "2-digit" }).format(d);
    } catch (e) { return ""; }
  }

  function gymDisplayRender(root, board, failed) {
    root.textContent = "";

    const head = gymDisplayEl("div", "gd-head");
    // brandName(), never a literal - the product name is configuration, and a
    // quoted copy is exactly the kind of thing that rides along with moved code.
    head.appendChild(gymDisplayEl("div", "gd-brand",
      typeof brandName === "function" ? brandName() : ""));
    head.appendChild(gymDisplayEl("div", "gd-clock", gymDisplayClock(new Date())));
    root.appendChild(head);

    if (failed) {
      const e = gymDisplayEl("div", "gd-empty");
      e.appendChild(gymDisplayEl("div", "gd-empty-title", "אין חיבור כרגע"));
      e.appendChild(gymDisplayEl("div", "gd-empty-sub", "המסך ינסה שוב עוד כמה דקות."));
      root.appendChild(e);
      return;
    }

    const wod = board && board.wod;
    if (!wod) {
      const none = gymDisplayEl("div", "gd-empty");
      none.appendChild(gymDisplayEl("div", "gd-empty-title", "אין אימון מועדון היום"));
      none.appendChild(gymDisplayEl("div", "gd-empty-sub", "נתראה באימון הבא."));
      root.appendChild(none);
      return;
    }

    // A custom WOD carries its own name; a benchmark's name lives in the
    // client's WOD_LIBRARY and has no row in club_wods, which is why the
    // server sends wod_id too. Same resolution every other surface does.
    let title = wod.name;
    if (!title && typeof wodById === "function") {
      const w = wodById(wod.wod_id);
      if (w && w.name) title = w.name;
    }
    root.appendChild(gymDisplayEl("h1", "gd-title", title || wod.wod_id || ""));
    if (wod.note) root.appendChild(gymDisplayEl("div", "gd-note", wod.note));

    const results = (board && board.results) || [];
    if (!results.length) {
      const waiting = gymDisplayEl("div", "gd-empty");
      waiting.appendChild(gymDisplayEl("div", "gd-empty-title", "עוד אין תוצאות"));
      waiting.appendChild(gymDisplayEl("div", "gd-empty-sub", "התוצאה הראשונה תופיע כאן."));
      root.appendChild(waiting);
      return;
    }

    const list = gymDisplayEl("ol", "gd-list");
    results.forEach((r, i) => {
      const li = gymDisplayEl("li", "gd-row");
      li.appendChild(gymDisplayEl("span", "gd-rank", String(i + 1)));
      li.appendChild(gymDisplayEl("span", "gd-name", r.name || ""));
      const res = gymDisplayEl("span", "gd-result", r.result_text || "");
      if (r.rx) res.appendChild(gymDisplayEl("span", "gd-rx", "Rx"));
      li.appendChild(res);
      list.appendChild(li);
    });
    root.appendChild(list);

    // Says out loud that only opted-in members are listed, so an absence does
    // not read as a slight.
    root.appendChild(gymDisplayEl("div", "gd-foot", "מוצגים רק מי שבחרו להופיע בלוחות"));
  }

  // What the mount hid, so a switch turned off under a running screen can hand
  // the page back exactly as it found it rather than guessing at defaults.
  let gymDisplayRoot = null;
  let gymDisplayTimer = null;
  let gymDisplayHidden = [];

  // THE SWITCH WINS OVER THE URL. `?display=1` is a request, not a key: with
  // club_features.gym_display off, the page is the ordinary app, exactly as if
  // the parameter were absent. Read through app.js's cached map (clubFeatureOn)
  // rather than isModuleEnabled(), because that one defaults to ON before the
  // features load and this must default to OFF - an unknown answer, a cold
  // cache and a device that never signed in all mean "no board".
  function gymDisplayOn() {
    return typeof clubFeatureOn === "function" && clubFeatureOn("gym_display");
  }

  function gymDisplayMount() {
    document.documentElement.setAttribute("data-gym-display", "1");
    gymDisplayHidden = [];
    for (const id of ["appShell", "loading", "bottomNavWrap"]) {
      const node = document.getElementById(id);
      if (!node) continue;
      gymDisplayHidden.push([node, node.style.display]);
      node.style.display = "none";
    }

    const root = gymDisplayEl("div", "gd-root");
    root.setAttribute("dir", "rtl");
    // aria-live so a screen reader on a kiosk announces a new result rather
    // than going silent; polite because nothing here is urgent.
    root.setAttribute("aria-live", "polite");
    document.body.appendChild(root);
    return root;
  }

  // The switch went off while the screen was up - by the admin panel, or by
  // the server refusing the board. Give the page back to the app.
  function gymDisplayUnmount() {
    if (gymDisplayTimer) window.clearTimeout(gymDisplayTimer);
    gymDisplayTimer = null;
    if (gymDisplayRoot) gymDisplayRoot.remove();
    gymDisplayRoot = null;
    for (const [node, display] of gymDisplayHidden) node.style.display = display;
    gymDisplayHidden = [];
    document.documentElement.removeAttribute("data-gym-display");
  }

  async function gymDisplayTick(root) {
    // One function, published by cloud.js. The display never holds the
    // Supabase client itself - see the note where that door is defined.
    if (typeof window.gymDisplayBoard !== "function") {
      gymDisplayRender(root, null, true);
      return GYM_DISPLAY_BACKOFF_MS;
    }
    try {
      const res = await window.gymDisplayBoard();
      if (res && res.error) {
        // The server's own copy of the switch (gym_display_board() raises
        // before anything else while the module is off). It outranks a stale
        // cached map: stand down rather than show "no connection" forever.
        if (/gym_display disabled/.test(String(res.error.message || ""))) return null;
        gymDisplayRender(root, null, true);
        return GYM_DISPLAY_BACKOFF_MS;
      }
      gymDisplayRender(root, res && res.data, null);
      return GYM_DISPLAY_REFRESH_MS;
    } catch (e) {
      gymDisplayRender(root, null, true);
      return GYM_DISPLAY_BACKOFF_MS;
    }
  }

  // Called on load and again by app.js whenever its feature map changes (the
  // cache read at boot, and every answer from club_features_for_caller), so
  // the screen follows the switch in both directions without a reload.
  function gymDisplaySync() {
    if (!gymDisplayWanted()) return;
    if (!gymDisplayOn()) {
      if (gymDisplayRoot) gymDisplayUnmount();
      return;
    }
    if (gymDisplayRoot) return;
    const root = gymDisplayRoot = gymDisplayMount();
    gymDisplayRender(root, null, null);
    const run = () => {
      gymDisplayTick(root).then((next) => {
        if (gymDisplayRoot !== root) return;
        if (next === null) { gymDisplayUnmount(); return; }
        gymDisplayTimer = window.setTimeout(run, next || GYM_DISPLAY_REFRESH_MS);
      });
    };
    run();
  }

  // Published on window for app.js, the way cloud.js hands app.js its doors:
  // a bare function name is not reliably shared across script evaluations.
  window.gymDisplaySync = gymDisplaySync;

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", gymDisplaySync);
    } else {
      gymDisplaySync();
    }
  }
