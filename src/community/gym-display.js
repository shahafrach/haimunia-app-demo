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

  function gymDisplayMount() {
    document.documentElement.setAttribute("data-gym-display", "1");
    const shell = document.getElementById("appShell");
    if (shell) shell.style.display = "none";
    const loading = document.getElementById("loading");
    if (loading) loading.style.display = "none";
    const nav = document.getElementById("bottomNavWrap");
    if (nav) nav.style.display = "none";

    const root = gymDisplayEl("div", "gd-root");
    root.setAttribute("dir", "rtl");
    // aria-live so a screen reader on a kiosk announces a new result rather
    // than going silent; polite because nothing here is urgent.
    root.setAttribute("aria-live", "polite");
    document.body.appendChild(root);
    return root;
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

  function gymDisplayStart() {
    if (!gymDisplayWanted()) return;
    const root = gymDisplayMount();
    gymDisplayRender(root, null, null);
    const run = () => {
      gymDisplayTick(root).then((next) => {
        window.setTimeout(run, next || GYM_DISPLAY_REFRESH_MS);
      });
    };
    run();
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", gymDisplayStart);
    } else {
      gymDisplayStart();
    }
  }
