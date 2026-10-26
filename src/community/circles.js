// @ts-check
"use strict";
// ---- Circles: data and actions --------------------------------------------
//
// What the client does with the Circles RPCs (docs/circles/rpcs.md): load my
// circles, join through an invite, create and run a circle, post a workout day
// to the circles the member chose, read a circle's feed and week, react, tag
// and confirm "trained together", log the benchmark of the month, and keep the
// member's own target, pause and per-circle share settings.
//
// Classic <script>, no IIFE, loaded before cloud.js; it reads state, client,
// rerender, setMessage, communityRpc and friends from the shared scope, from
// inside function bodies only. The pure rules (what leaves the device, what a
// status means in Hebrew) are in circles-core.js and are tested alone.
//
// NO SQL IS WRITTEN HERE. Every server function this file calls is listed in
// docs/circles/rpcs.md. The ones the client must not assume exist are named
// in the PR.

  const CIRCLES = window.CirclesCore;
  const CIRCLE_CURRENT_KEY = "haimunia-demo:currentCircle";
  const CIRCLE_SKIPS_KEY = "haimunia-demo:circleShareSkips";
  const CIRCLE_FEED_PAGE = 30;

  // ---- Reading the URL -----------------------------------------------------
  // The invite token is in the fragment (after #). It is read once at boot,
  // removed from the address bar before anything renders, held in memory only,
  // and never logged, tracked or sent anywhere except join_circle's argument.
  // A token in a query string is NOT read: a query string reaches servers and
  // their logs, which is the whole reason the token is after the #.
  function captureInviteFromUrl() {
    let token = null;
    try {
      const loc = window.location;
      token = CIRCLES.parseInviteHash(String((loc && loc.hash) || ""));
      const hadHash = !!(loc && loc.hash && loc.hash.length > 1);
      const search = String((loc && loc.search) || "");
      const legacy = /(^|[?&])invite=/.test(search);
      if (hadHash || legacy) {
        const url = new URL(loc.href);
        if (legacy) url.searchParams.delete("invite");
        if (token || (hadHash && /^#(invite|join)=/i.test(loc.hash))) url.hash = "";
        window.history.replaceState(null, "", url.pathname + (url.search || "") + (url.hash || ""));
      }
    } catch (e) { token = null; }
    // app.js opens the Circle tab when this is set (communityInviteFlowPending).
    if (token) state.circles.join.token = token;
  }

  // ---- Small lookups ---------------------------------------------------------
  function circleById(id) { return state.circles.list.find((c) => c.id === id) || null; }
  function currentCircle() { return circleById(state.circles.currentId) || state.circles.list[0] || null; }
  function circleIsOwner(c) { return !!(c && c.role === "owner"); }
  function circleMemberCount(id) { const m = state.circles.members[id]; return Array.isArray(m) ? m.length : null; }
  function circleName(id) { const c = circleById(id); return c ? c.name : ""; }
  function inCircles() { return state.circles.list.length > 0; }
  function setCurrentCircle(id) {
    if (!circleById(id)) return;
    state.circles.currentId = id;
    try { localStorage.setItem(CIRCLE_CURRENT_KEY, id); } catch (e) { /* private mode: the first circle is current */ }
    // The cards look their post up in state.posts.held, which always holds the
    // circle on screen.
    const f = state.circles.feed[id];
    if (f && f.loaded) syncHeldPosts(id); else state.posts.held = [];
  }
  function circlesBusy(key, on) { if (on) state.circles.busy[key] = true; else delete state.circles.busy[key]; }

  // ---- My circles ------------------------------------------------------------
  const CLUB_COLUMNS = "id,name,type,emoji,mode,benchmark_enabled,invite_policy,welcome_line,benchmark,benchmark_month,created_by";
  async function loadMyCircles() {
    if (!client || !state.user) return;
    state.circles.loading = true;
    const { data, error } = await client.from("circle_members")
      .select("club_id,role,joined_at,share_defaults,clubs(" + CLUB_COLUMNS + ")")
      .eq("user_id", state.user.id).order("joined_at", { ascending: true });
    state.circles.loading = false;
    // A failed read must not turn "I am in three circles" into "I am in none":
    // the gate below would then send a member who is fine to the join screen.
    state.circles.loadError = !!error;
    if (error) return;
    const rows = Array.isArray(data) ? data : [];
    state.circles.list = rows.filter((r) => r && r.clubs).map((r) => ({
      id: r.club_id, role: r.role, joined_at: r.joined_at, share_defaults: r.share_defaults || {},
      name: r.clubs.name, type: r.clubs.type, emoji: r.clubs.emoji, mode: r.clubs.mode,
      benchmark_enabled: !!r.clubs.benchmark_enabled, invite_policy: r.clubs.invite_policy,
      welcome_line: r.clubs.welcome_line || "", benchmark: r.clubs.benchmark || null,
      benchmark_month: r.clubs.benchmark_month || null, created_by: r.clubs.created_by,
    }));
    state.circles.loaded = true;
    let stored = "";
    try { stored = localStorage.getItem(CIRCLE_CURRENT_KEY) || ""; } catch (e) { stored = ""; }
    if (!circleById(state.circles.currentId)) state.circles.currentId = circleById(stored) ? stored : (state.circles.list[0] ? state.circles.list[0].id : "");
  }

  // The one call the session-ready paths make: circles first, then any invite
  // that was waiting for a session, then the member's own numbers.
  async function circlesAfterSession() {
    if (!client || !state.user) return;
    await loadMyCircles();
    if (state.circles.join.token && !state.circles.join.busy) await joinCircleWithToken(state.circles.join.token);
    if (inCircles()) { loadMyTarget(); loadPendingTags(); }
    rerender();
  }

  // ---- Joining ---------------------------------------------------------------
  async function joinCircleWithToken(token) {
    const j = state.circles.join;
    if (!client || !state.user || !token || j.busy) return;
    j.busy = true;
    j.error = "";
    rerender();
    let status = "error";
    let clubId = null;
    try {
      const { data, error } = await client.rpc("join_circle", { p_token: token });
      if (!error && data && typeof data === "object") { status = String(data.status || "error"); clubId = data.club_id || null; }
      else if (error && isOfflineError(error)) status = "offline";
    } catch (e) { status = "offline"; }
    j.busy = false;
    if (status === "joined" || status === "already_member") {
      j.token = "";
      j.error = "";
      if (state.circles.sheet && state.circles.sheet.kind === "join") state.circles.sheet = null;
      await loadMyCircles();
      if (clubId && circleById(clubId)) setCurrentCircle(clubId);
      // A fresh anonymous account just got a bare profile from join_circle.
      if (typeof loadProfile === "function") await loadProfile();
      state.circles.section = "feed";
      loadMyTarget();
      loadPendingTags();
      setMessage(status === "joined" ? "הצטרפת למעגל" : CIRCLES.joinStatusText("already_member"));
      return;
    }
    if (status === "offline") {
      j.error = "אין חיבור כרגע. הקישור נשמר בדף הזה, אפשר לנסות שוב כשהחיבור חוזר.";
    } else if (status === "rate_limited") {
      // The token is kept: the attempt, not the link, was the problem.
      j.error = CIRCLES.joinStatusText("rate_limited");
    } else if (status === "error") {
      j.error = CIRCLES.joinStatusText("error");
    } else {
      // invalid / circle_full / too_many_circles: this token cannot work, so it
      // is dropped and the member is told which kind of "no" it was.
      j.token = "";
      j.error = CIRCLES.joinStatusText(status);
    }
    rerender();
  }
  // A pasted link or token, from the join form.
  async function joinFromForm(form) {
    const raw = String(form.elements.link.value || "");
    state.circles.join.draft = raw;
    const token = CIRCLES.extractInviteToken(raw);
    if (!token) return setFieldErrors("circleJoin", { link: "הדביקו את קישור ההזמנה כמו שקיבלתם אותו" });
    setFieldErrors("circleJoin", {});
    state.circles.join.token = token;
    state.circles.join.draft = "";
    await joinCircleWithToken(token);
  }
  function inviteFlowPending() { return !!(state.circles.join.token && !inCircles()); }
  function discardPendingInvite() { state.circles.join.token = ""; state.circles.join.error = ""; rerender(); }

  // ---- Creating and running a circle ----------------------------------------
  async function createCircle(form) {
    if (!client || !state.user || state.circles.busy.create) return;
    const type = String(form.elements.type.value || "");
    const name = cleanStr(form.elements.name.value, 80).trim();
    const emoji = cleanStr(form.elements.emoji.value, 16).trim();
    const errors = {};
    if (type !== "couple" && type !== "friends") errors.type = "בחרו סוג מעגל";
    if (!name) errors.name = "למעגל צריך שם";
    else if (name.length > 40) errors.name = "שם המעגל ארוך מדי (עד 40 תווים)";
    if (Object.keys(errors).length) return setFieldErrors("circleCreate", errors);
    circlesBusy("create", true);
    const { data, error } = await client.rpc("create_circle", { p_type: type, p_name: name, p_emoji: emoji || null });
    circlesBusy("create", false);
    if (error || !data) return setFieldErrors("circleCreate", { name: CIRCLES.circleErrorText(error, "יצירת המעגל נכשלה") });
    setFieldErrors("circleCreate", {});
    state.circles.sheet = null;
    await loadMyCircles();
    setCurrentCircle(String(data));
    state.circles.section = "feed";
    loadMyTarget();
    setMessage("המעגל נוצר");
  }

  async function saveCircleSettings(form) {
    const c = circleById(state.circles.sheet && state.circles.sheet.clubId);
    if (!c || !circleIsOwner(c) || state.circles.busy.settings) return;
    const name = cleanStr(form.elements.name.value, 80).trim();
    const emoji = cleanStr(form.elements.emoji.value, 16).trim();
    const welcome = cleanStr(form.elements.welcome_line.value, 200).trim();
    const errors = {};
    if (!name) errors.name = "למעגל צריך שם";
    else if (name.length > 40) errors.name = "שם המעגל ארוך מדי (עד 40 תווים)";
    if (welcome.length > 200) errors.welcome_line = "שורת הפתיחה ארוכה מדי (עד 200 תווים)";
    if (Object.keys(errors).length) return setFieldErrors("circleSettings", errors);
    const settings = {
      name: name,
      mode: form.elements.mode.value === "weekly_competition" ? "weekly_competition" : "together",
      benchmark_enabled: !!form.elements.benchmark_enabled.checked,
      invite_policy: form.elements.invite_policy.value === "any_member" ? "any_member" : "owner",
      welcome_line: welcome,
    };
    if (emoji) settings.emoji = emoji;
    circlesBusy("settings", true);
    const { error } = await client.rpc("update_circle", { p_club_id: c.id, p_settings: settings });
    circlesBusy("settings", false);
    if (error) return setFieldErrors("circleSettings", { name: CIRCLES.circleErrorText(error, "שמירת ההגדרות נכשלה") });
    setFieldErrors("circleSettings", {});
    state.circles.sheet = null;
    await loadMyCircles();
    setMessage("ההגדרות נשמרו");
  }

  // The benchmark of the month is the owner's pick from the eight named
  // benchmarks. Picking again in a new month re-stamps the month (server side).
  async function pickBenchmark(clubId, benchmarkId) {
    const c = circleById(clubId);
    if (!c || !circleIsOwner(c) || state.circles.busy.pick) return;
    const value = benchmarkId && CIRCLES.BENCHMARK_IDS.indexOf(benchmarkId) >= 0 ? benchmarkId : null;
    circlesBusy("pick", true);
    const { error } = await client.rpc("update_circle", { p_club_id: clubId, p_settings: { benchmark: value } });
    circlesBusy("pick", false);
    if (error) return setMessage(CIRCLES.circleErrorText(error, "בחירת הבנצ'מרק נכשלה"));
    await loadMyCircles();
    delete state.circles.benchmark[clubId];
    loadBenchmark(clubId);
    setMessage(value ? "הבנצ'מרק של החודש נבחר" : "הבנצ'מרק הוסר");
  }

  // ---- Invites ---------------------------------------------------------------
  function canInvite(c) { return !!c && (circleIsOwner(c) || c.invite_policy === "any_member"); }
  function inviteLinkFor(token) {
    const base = window.location.origin + window.location.pathname;
    return CIRCLES.inviteUrl(base, token);
  }
  async function createInvite(form) {
    const sheet = state.circles.sheet;
    const c = circleById(sheet && sheet.clubId);
    if (!c || !canInvite(c) || state.circles.busy.invite) return;
    const args = { p_club_id: c.id };
    const raw = form && form.elements && form.elements.max_uses ? String(form.elements.max_uses.value || "").trim() : "";
    if (raw) {
      const n = Math.floor(Number(raw));
      if (!isFinite(n) || n < 1 || n > 20) return setFieldErrors("circleInvite", { max_uses: "מספר בין 1 ל-20" });
      args.p_max_uses = n;
    }
    setFieldErrors("circleInvite", {});
    circlesBusy("invite", true);
    sheet.error = "";
    rerender();
    const { data, error } = await client.rpc("create_circle_invite", args);
    circlesBusy("invite", false);
    if (error || !data) { sheet.error = CIRCLES.circleErrorText(error, "יצירת ההזמנה נכשלה"); return rerender(); }
    // The raw token exists exactly once, here. It is kept only in this open
    // sheet and is gone when the sheet closes.
    sheet.link = inviteLinkFor(String(data));
    sheet.uses = args.p_max_uses || null;
    rerender();
  }
  // Web Share needs a tap of its own: it cannot be called after the network
  // round trip above and still count as part of that tap. Copy is the fallback
  // for browsers without it (and for a refused or cancelled share).
  async function shareInvite() {
    const sheet = state.circles.sheet;
    if (!sheet || !sheet.link) return;
    const c = circleById(sheet.clubId);
    const text = "הוזמנת להצטרף למעגל " + (c ? c.name : "") + " ב-" + brandName() + ". הקישור תקף שבוע:";
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title: brandName(), text: text, url: sheet.link });
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
        /* any other failure: fall through to copy */
      }
    }
    await copyInvite();
  }
  async function copyInvite() {
    const sheet = state.circles.sheet;
    if (!sheet || !sheet.link) return;
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(sheet.link); ok = true; }
    } catch (e) { ok = false; }
    sheet.copied = ok;
    sheet.error = ok ? "" : "ההעתקה לא הצליחה. אפשר ללחוץ על הקישור, לסמן אותו ולהעתיק ידנית.";
    rerender();
  }

  // ---- Leaving and removing ----------------------------------------------------
  async function leaveCircle(clubId) {
    const c = circleById(clubId);
    if (!c || state.circles.busy.leave) return;
    circlesBusy("leave", true);
    const { error } = await client.rpc("leave_circle", { p_club_id: clubId });
    circlesBusy("leave", false);
    if (error) return setMessage(CIRCLES.circleErrorText(error, "העזיבה נכשלה"));
    forgetCircle(clubId);
    state.circles.sheet = null;
    await loadMyCircles();
    setMessage("עזבת את המעגל");
  }
  async function removeMember(clubId, userId) {
    const c = circleById(clubId);
    if (!c || !circleIsOwner(c) || !userId) return;
    const { error } = await client.rpc("remove_member", { p_club_id: clubId, p_user_id: userId });
    if (error) return setMessage(CIRCLES.circleErrorText(error, "ההסרה נכשלה"));
    delete state.circles.members[clubId];
    delete state.circles.week[clubId];
    delete state.circles.feed[clubId];
    delete membersTried[clubId];
    await loadMembers(clubId);
    setMessage("החבר/ה הוסר/ה מהמעגל");
  }
  function forgetCircle(clubId) {
    delete state.circles.members[clubId];
    delete state.circles.feed[clubId];
    delete state.circles.week[clubId];
    delete state.circles.benchmark[clubId];
    if (state.circles.currentId === clubId) state.circles.currentId = "";
  }

  async function loadMembers(clubId) {
    if (!client || !state.user || !clubId) return;
    const { data, error } = await client.from("circle_members")
      .select("user_id,role,joined_at,profiles(display_name,emoji)").eq("club_id", clubId).order("joined_at", { ascending: true });
    if (error) return;
    state.circles.members[clubId] = (data || []).map((r) => ({
      user_id: r.user_id, role: r.role, joined_at: r.joined_at,
      display_name: (r.profiles && r.profiles.display_name) || "", emoji: (r.profiles && r.profiles.emoji) || "🙂",
    }));
    rerender();
  }

  // ---- The feed --------------------------------------------------------------
  function feedState(clubId) {
    if (!state.circles.feed[clubId]) state.circles.feed[clubId] = { rows: [], done: false, loading: false, error: false, loaded: false };
    return state.circles.feed[clubId];
  }
  async function loadFeed(clubId, more) {
    if (!client || !state.user || !clubId) return;
    const f = feedState(clubId);
    if (f.loading || (more && f.done)) return;
    f.loading = true;
    f.error = false;
    rerender();
    const cursor = more && f.rows.length ? f.rows[f.rows.length - 1].published_at : null;
    const { data, error } = await client.rpc("circle_feed", { p_club_id: clubId, p_cursor: cursor, p_limit: CIRCLE_FEED_PAGE });
    f.loading = false;
    if (error) { f.error = true; return rerender(); }
    const page = Array.isArray(data) ? data : [];
    f.rows = more ? f.rows.concat(page) : page;
    f.done = page.length < CIRCLE_FEED_PAGE;
    f.loaded = true;
    seedReactionsFromRows(page);
    syncHeldPosts(clubId);
    rerender();
  }
  // The cards read state.posts.held (findFeedPost); it always holds the posts
  // of the circle on screen, in the order they are drawn.
  function syncHeldPosts(clubId) {
    const f = feedState(clubId);
    state.posts.held = CIRCLES.feedOrder(f.rows).map((r) => Object.assign(CIRCLES.feedPost(r), { club_id: clubId }));
    const ids = state.posts.held.filter((p) => p.post_type === "POST_WORKOUT").map((p) => p.id);
    if (ids.length && typeof loadTrainingPartners === "function") loadTrainingPartners(ids).then(() => rerender());
  }
  function seedReactionsFromRows(rows) {
    for (const r of rows) {
      const prev = state.engagement.reactions[r.post_id];
      state.engagement.reactions[r.post_id] = {
        loaded: !!(prev && prev.loaded), list: (prev && prev.list) || [],
        counts: Object.assign({}, r.reaction_counts || {}),
        mine: Array.isArray(r.my_reactions) ? r.my_reactions.slice() : [],
      };
    }
  }

  // ---- The week ---------------------------------------------------------------
  async function loadWeek(clubId) {
    if (!client || !state.user || !clubId) return;
    const w = state.circles.week[clubId] || (state.circles.week[clubId] = { rows: [], loading: false, error: false, loaded: false });
    if (w.loading) return;
    w.loading = true;
    w.error = false;
    rerender();
    const { data, error } = await client.rpc("circle_week", { p_club_id: clubId });
    w.loading = false;
    if (error) { w.error = true; return rerender(); }
    w.rows = Array.isArray(data) ? data : [];
    w.loaded = true;
    rerender();
  }

  // ---- The member's own target and pause (Me) ---------------------------------
  async function loadMyTarget() {
    if (!client || !state.user) return;
    const { data, error } = await client.from("member_targets").select("weekly_target,paused_until").eq("user_id", state.user.id).maybeSingle();
    if (error) return;
    state.circles.mine.target = data ? Number(data.weekly_target) : null;
    state.circles.mine.pausedUntil = data && data.paused_until ? String(data.paused_until) : null;
    state.circles.mine.loaded = true;
    rerender();
  }
  async function saveWeeklyTarget(value) {
    const n = Math.floor(Number(value));
    if (!client || !state.user || !isFinite(n) || n < 1 || n > 21) return;
    const before = state.circles.mine.target;
    state.circles.mine.target = n;
    rerender();
    const { error } = await client.rpc("set_weekly_target", { p_target: n });
    if (error) { state.circles.mine.target = before; rerender(); return setMessage(CIRCLES.circleErrorText(error, "שמירת היעד נכשלה")); }
    setMessage("היעד השבועי נשמר");
    clearWeekCache();
  }
  function clearWeekCache() { state.circles.week = {}; }
  function pauseUntilDate(days) {
    const d = new Date(Date.now() + days * 86400000);
    return CIRCLES.jerusalemDay(d);
  }
  function isPausedNow() {
    const until = state.circles.mine.pausedUntil;
    return !!until && until >= CIRCLES.jerusalemDay(new Date());
  }
  async function savePause(days) {
    if (!client || !state.user) return;
    const until = days ? pauseUntilDate(days) : null;
    const { error } = await client.rpc("set_pause", { p_until: until });
    if (error) return setMessage(CIRCLES.circleErrorText(error, "שמירת ההפסקה נכשלה"));
    await loadMyTarget();
    clearWeekCache();
    setMessage(until ? "ההפסקה נשמרה. המעגל רואה שאת/ה בהפסקה" : "חזרתם מההפסקה");
  }

  // ---- What I share, per circle -------------------------------------------------
  async function setShareSetting(clubId, key, value) {
    const c = circleById(clubId);
    if (!c || CIRCLES.SHARE_KEYS.indexOf(key) < 0) return;
    const before = Object.assign({}, c.share_defaults);
    c.share_defaults = Object.assign({}, c.share_defaults, { [key]: !!value });
    rerender();
    const { error } = await client.rpc("set_share_defaults", { p_club_id: clubId, p_defaults: { [key]: !!value } });
    if (error) { c.share_defaults = before; rerender(); return setMessage(CIRCLES.circleErrorText(error, "השמירה נכשלה")); }
  }

  // ---- Logging is sharing -------------------------------------------------------
  // The member's workout day goes to the circles whose settings say so, the
  // moment it is saved. See circles-core.js workoutPostRow for exactly what a
  // circle may receive; this function only decides WHICH circles and writes.
  function loadSkips() {
    try { const v = JSON.parse(localStorage.getItem(CIRCLE_SKIPS_KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; }
  }
  function skipsFor(day) { const v = loadSkips()[day]; return Array.isArray(v) ? v : []; }
  function setSkip(day, clubId, skipped) {
    const all = loadSkips();
    const cur = new Set(Array.isArray(all[day]) ? all[day] : []);
    if (skipped) cur.add(clubId); else cur.delete(clubId);
    if (cur.size) all[day] = Array.from(cur); else delete all[day];
    // Keep the newest 60 days; the rest were never going to matter again.
    const days = Object.keys(all).sort();
    for (const d of days.slice(0, Math.max(0, days.length - 60))) delete all[d];
    try { localStorage.setItem(CIRCLE_SKIPS_KEY, JSON.stringify(all)); } catch (e) { /* the skip lasts this session only */ }
  }

  // Which circles already hold a post for this day (mine, in circles I am in).
  async function postedCircleIds(day) {
    const { data, error } = await client.from("workout_posts").select("id,club_id")
      .eq("author_id", state.user.id).eq("source_record_id", "day:" + day).is("deleted_at", null);
    if (error) return null;
    return (data || []).map((r) => ({ id: r.id, club_id: r.club_id }));
  }

  async function writeDayRows(rows) {
    let queued = false;
    let failed = null;
    for (const row of rows) {
      const res = await writeWorkoutSharePost(row);
      if (res.queued) queued = true;
      if (res.error) failed = res.error;
    }
    return { queued, error: failed };
  }

  /**
   * Called by app.js after a save. opts.refreshOnly: an edit, which only
   * updates the circles that already hold this day.
   */
  async function postWorkoutToCircles(type, id, opts) {
    if (!client || !state.user || !state.profile || !inCircles()) return;
    const item = typeof window.communityDayItemFor === "function" ? window.communityDayItemFor(type, id) : null;
    if (!item) return;
    const refreshOnly = !!(opts && opts.refreshOnly);
    let targets;
    if (refreshOnly) {
      const posted = await postedCircleIds(item.day);
      if (!posted || !posted.length) return;
      const ids = new Set(posted.map((p) => p.club_id));
      targets = state.circles.list.filter((c) => ids.has(c.id));
    } else {
      targets = CIRCLES.defaultWorkoutCircles(state.circles.list, skipsFor(item.day));
    }
    const rows = targets.map((c) => CIRCLES.workoutPostRow(item, c, CIRCLES.effectiveDefaults(c), state.user.id)).filter(Boolean);
    if (!rows.length) return;
    const result = await writeDayRows(rows);
    if (result.error) {
      setMessage(failText("שיתוף האימון נכשל", result.error));
      return;
    }
    if (refreshOnly) return;
    const sent = rows.map((r) => circleName(r.club_id)).filter(Boolean);
    showShareBar({ day: item.day, title: item.lines.length === 1 ? item.lines[0].title : "האימון", names: sent, queued: result.queued });
    track(A.WORKOUT_SHARED, { source_type: type, circles: rows.length });
  }
  window.postWorkoutToCircles = postWorkoutToCircles;
  // The ids of the member's circles, for the rest of the app (and for tests,
  // which cannot reach the shared lexical scope from outside).
  window.communityCircleIds = function () { return state.circles.list.map((c) => c.id); };
  // Re-read the member's circles (their settings, the benchmark pick): what a
  // screen does after something changed elsewhere.
  window.circlesReload = async function () { await loadMyCircles(); rerender(); };

  // A deleted set changes the day: the circles that hold it get the shorter
  // summary, or lose the post when nothing is left.
  async function refreshWorkoutDayInCircles(day) {
    if (!client || !state.user || !inCircles()) return;
    const summary = typeof window.communityDaySummary === "function" ? window.communityDaySummary(day) : null;
    const posted = await postedCircleIds(day);
    if (!posted || !posted.length) return;
    if (!summary || !summary.lines.length) {
      for (const p of posted) await client.rpc("post_delete", { post_id: p.id });
      return;
    }
    const ids = new Set(posted.map((p) => p.club_id));
    const rows = state.circles.list.filter((c) => ids.has(c.id))
      .map((c) => CIRCLES.workoutPostRow(summary, c, CIRCLES.effectiveDefaults(c), state.user.id)).filter(Boolean);
    if (rows.length) await writeDayRows(rows);
  }
  window.refreshWorkoutDayInCircles = refreshWorkoutDayInCircles;

  // The confirmation bar after a save, and the per-workout control.
  let shareBarTimer = null;
  function showShareBar(info) {
    state.circles.shareBar = info;
    if (shareBarTimer) clearTimeout(shareBarTimer);
    shareBarTimer = setTimeout(() => { shareBarTimer = null; if (state.circles.shareBar === info) { state.circles.shareBar = null; rerender(); } }, 12000);
    rerender();
  }
  function dismissShareBar() { state.circles.shareBar = null; rerender(); }

  // The circles-for-this-workout sheet: opened from the bar, or from a day's
  // share icon in Calendar and Progress.
  async function openShareSheet(day) {
    if (!day || !inCircles()) return;
    state.circles.shareBar = null;
    const sheet = { kind: "share", day: day, picked: null, loading: true, saving: false, error: "", posted: [] };
    state.circles.sheet = sheet;
    rerender();
    const posted = client && state.user ? await postedCircleIds(day) : null;
    if (state.circles.sheet !== sheet) return;
    sheet.loading = false;
    sheet.posted = posted || [];
    const have = new Set(sheet.posted.map((p) => p.club_id));
    // Ticked: where the day already is, or where the member's settings would send it.
    const auto = new Set(CIRCLES.defaultWorkoutCircles(state.circles.list, skipsFor(day)).map((c) => c.id));
    sheet.picked = state.circles.list.filter((c) => (posted ? have.has(c.id) : auto.has(c.id))).map((c) => c.id);
    rerender();
  }
  function toggleSharePick(clubId) {
    const s = state.circles.sheet;
    if (!s || s.kind !== "share" || !s.picked) return;
    const at = s.picked.indexOf(clubId);
    if (at >= 0) s.picked.splice(at, 1); else s.picked.push(clubId);
    rerender();
  }
  async function applySharePick() {
    const s = state.circles.sheet;
    if (!s || s.kind !== "share" || s.saving || !s.picked) return;
    const summary = typeof window.communityDaySummary === "function" ? window.communityDaySummary(s.day) : null;
    if (!summary || !summary.lines.length) { s.error = "לא נמצא אימון ביום הזה במכשיר"; return rerender(); }
    s.saving = true;
    s.error = "";
    rerender();
    const have = new Map(s.posted.map((p) => [p.club_id, p.id]));
    const want = new Set(s.picked);
    const adds = state.circles.list.filter((c) => want.has(c.id));
    // A circle the member ticks by hand gets the workout even where its
    // defaults would not: they asked for this one. Weights still follow
    // show_weights, which is never overridden.
    const rows = adds.map((c) => CIRCLES.workoutPostRow(summary, c, Object.assign({}, CIRCLES.effectiveDefaults(c), { share_workouts: true }), state.user.id)).filter(Boolean);
    let problem = null;
    const written = await writeDayRows(rows);
    if (written.error) problem = written.error;
    for (const c of state.circles.list) {
      if (want.has(c.id)) { setSkip(s.day, c.id, false); continue; }
      setSkip(s.day, c.id, true);
      const postId = have.get(c.id);
      if (postId) {
        const { error } = await client.rpc("post_delete", { post_id: postId });
        if (error) problem = error;
      }
    }
    s.saving = false;
    if (problem) { s.error = failText("השינוי לא הושלם", problem); return rerender(); }
    state.circles.sheet = null;
    setMessage(written.queued ? "האימון יישלח למעגלים כשהחיבור יחזור" : "השיתוף עודכן");
    for (const c of state.circles.list) delete state.circles.feed[c.id];
    clearWeekCache();
  }
  window.openCircleShareSheet = openShareSheet;

  // ---- A PR to the circles that take PRs ----------------------------------------
  // pr_share is one call per circle. p_weight is present only where the member
  // chose to show weights in that circle (circles-core.js prShareArgs).
  async function sharePrToCircles(record, clubIds, note) {
    const results = { sent: 0, queued: 0, failed: 0, error: null };
    for (const id of clubIds) {
      const c = circleById(id);
      const args = c ? CIRCLES.prShareArgs(record, c, note) : null;
      if (!args) continue;
      const { queued, data, error } = await communityRpc("pr_share", args);
      if (error || (!queued && !data)) { results.failed++; results.error = error || results.error; continue; }
      if (queued) results.queued++; else { results.sent++; emitPostCreated(data, "POST_PR"); }
    }
    return results;
  }
  // The product bus hears about every post that landed (a queued one has no id
  // yet, so it is not announced until it does).
  function emitPostCreated(postId, postType) {
    if (!postId || !window.HaimuniaEvents || !window.PRODUCT_EVENTS || !window.PRODUCT_EVENTS.POST_CREATED) return;
    try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.POST_CREATED, { post_id: postId, post_type: postType }); } catch (e) { /* the bus is optional */ }
  }
  async function shareAchievementToCircles(memberAchievementId, clubIds, caption) {
    const results = { sent: 0, queued: 0, failed: 0, error: null };
    for (const id of clubIds) {
      if (!circleById(id)) continue;
      const { queued, data, error } = await communityRpc("ach_share", { p_club_id: id, member_achievement_id: memberAchievementId, caption: caption || "" });
      if (error || (!queued && !data)) { results.failed++; results.error = error || results.error; continue; }
      if (queued) results.queued++; else { results.sent++; emitPostCreated(data, "POST_ACHIEVEMENT"); }
    }
    return results;
  }
  async function postTextToCircles(clubIds, body) {
    const results = { sent: 0, queued: 0, failed: 0, error: null };
    for (const id of clubIds) {
      if (!circleById(id)) continue;
      const { queued, data, error } = await communityRpc("post_create", { p_club_id: id, body: body });
      if (error || (!queued && !data)) { results.failed++; results.error = error || results.error; continue; }
      if (queued) results.queued++; else { results.sent++; emitPostCreated(data, "POST_TEXT"); }
    }
    return results;
  }

  // ---- Reactions: three kinds ------------------------------------------------------
  const circleReactionBusy = {};
  async function reactToPost(postId, kind) {
    if (!state.user || !postId || CIRCLES.REACTION_KINDS.indexOf(kind) < 0) return;
    const busyKey = postId + ":" + kind;
    if (circleReactionBusy[busyKey]) return;
    circleReactionBusy[busyKey] = true;
    const before = reactionStateFor(postId);
    const had = before.mine.indexOf(kind) >= 0;
    const optimistic = {
      loaded: before.loaded, list: before.list,
      counts: Object.assign({}, before.counts, { [kind]: Math.max(0, Number(before.counts[kind] || 0) + (had ? -1 : 1)) }),
      mine: had ? before.mine.filter((k) => k !== kind) : before.mine.concat(kind),
    };
    state.engagement.reactions[postId] = optimistic;
    state.engagement.reactionError = null;
    rerender();
    const { queued, error } = await communityRpc("toggle_reaction", { p_post_id: postId, p_kind: kind });
    circleReactionBusy[busyKey] = false;
    if (queued) { await refreshOutboxState(); return rerender(); }
    if (error) {
      state.engagement.reactions[postId] = before;
      state.engagement.reactionError = postId;
      setMessage(error.message === "rate_limited" ? "יותר מדי לחיצות, נסו שוב בעוד כמה דקות" : "לא ניתן היה להגיב כרגע");
      return;
    }
    if (!had && window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.REACTION_CREATED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.REACTION_CREATED, { post_id: postId }); } catch (e) { /* the bus is optional */ }
    }
  }

  // ---- Trained together --------------------------------------------------------------
  // Tagging (post_tag_training_partners, in posts.js) creates a PENDING tag. The
  // tagged member sees it here and confirms, or says it was not so.
  async function loadPendingTags() {
    if (!client || !state.user) return;
    const { data, error } = await client.from("post_training_partners")
      .select("post_id,club_id,tagged_by,created_at").eq("tagged_user_id", state.user.id).is("confirmed_at", null).order("created_at", { ascending: false }).limit(20);
    if (error) return;
    const tags = data || [];
    if (!tags.length) { state.circles.pendingTags = []; return rerender(); }
    const byIds = Array.from(new Set(tags.map((t) => t.tagged_by).filter(Boolean)));
    const postIds = tags.map((t) => t.post_id);
    const [people, posts] = await Promise.all([
      byIds.length ? client.from("profiles").select("id,display_name,emoji").in("id", byIds) : Promise.resolve({ data: [] }),
      client.from("workout_posts").select("id,occurred_on,title").in("id", postIds),
    ]);
    const nameOf = new Map((people.data || []).map((p) => [p.id, p]));
    const postOf = new Map((posts.data || []).map((p) => [p.id, p]));
    state.circles.pendingTags = tags.map((t) => ({
      post_id: t.post_id, club_id: t.club_id,
      by: (nameOf.get(t.tagged_by) || {}).display_name || "חבר/ה",
      emoji: (nameOf.get(t.tagged_by) || {}).emoji || "🙂",
      day: (postOf.get(t.post_id) || {}).occurred_on || "",
    }));
    rerender();
  }
  async function confirmTag(postId) {
    if (!postId || state.circles.busy["tag:" + postId]) return;
    circlesBusy("tag:" + postId, true);
    const { error } = await client.rpc("confirm_trained_together", { p_post_id: postId });
    circlesBusy("tag:" + postId, false);
    if (error) return setMessage(CIRCLES.circleErrorText(error, "האישור נכשל"));
    state.circles.pendingTags = state.circles.pendingTags.filter((t) => t.post_id !== postId);
    clearWeekCache();
    setMessage("האימון המשותף נספר לשבוע שלך");
  }
  async function declineTag(postId) {
    if (!postId) return;
    const { error } = await client.rpc("post_training_partner_remove", { p_post_id: postId });
    if (error) return setMessage(CIRCLES.circleErrorText(error, "ההסרה נכשלה"));
    state.circles.pendingTags = state.circles.pendingTags.filter((t) => t.post_id !== postId);
    rerender();
  }

  // ---- Benchmark of the month ----------------------------------------------------------
  function benchmarkIsCurrent(c) {
    return !!(c && c.benchmark_enabled && c.benchmark && c.benchmark_month === CIRCLES.benchmarkMonth(new Date()));
  }
  async function loadBenchmark(clubId) {
    const c = circleById(clubId);
    if (!client || !state.user || !c) return;
    const b = state.circles.benchmark[clubId] || (state.circles.benchmark[clubId] = { rows: [], loading: false, error: false, loaded: false });
    if (!benchmarkIsCurrent(c)) { b.rows = []; b.loaded = true; return rerender(); }
    if (b.loading) return;
    b.loading = true;
    b.error = false;
    rerender();
    // The database decides what comes back: others' rows only if mine exists.
    const { data, error } = await client.from("benchmark_results")
      .select("user_id,result,rx_or_scaled,created_at,profiles(display_name,emoji)")
      .eq("club_id", clubId).eq("benchmark", c.benchmark).eq("month", c.benchmark_month).order("created_at", { ascending: true });
    b.loading = false;
    if (error) { b.error = true; return rerender(); }
    b.rows = (data || []).map((r) => ({
      user_id: r.user_id, result: r.result, rx_or_scaled: r.rx_or_scaled,
      name: (r.profiles && r.profiles.display_name) || "חבר/ה", emoji: (r.profiles && r.profiles.emoji) || "🙂",
    }));
    b.loaded = true;
    rerender();
  }
  async function logBenchmark(form) {
    const c = currentCircle();
    if (!c || !benchmarkIsCurrent(c) || !state.user || state.circles.busy.bench) return;
    const result = cleanStr(form.elements.result.value, 40).trim();
    const level = form.elements.level.value === "scaled" ? "scaled" : "rx";
    if (!result) return setFieldErrors("circleBenchmark", { result: "כתבו את התוצאה (זמן, סבבים או משקל)" });
    setFieldErrors("circleBenchmark", {});
    circlesBusy("bench", true);
    const { error } = await client.from("benchmark_results").upsert({
      club_id: c.id, user_id: state.user.id, benchmark: c.benchmark, month: c.benchmark_month, result: result, rx_or_scaled: level,
    }, { onConflict: "club_id,user_id,benchmark,month" });
    circlesBusy("bench", false);
    if (error) return setFieldErrors("circleBenchmark", { result: "השמירה נכשלה. אולי הבנצ'מרק של החודש התחלף." });
    await loadBenchmark(c.id);
    setMessage("התוצאה נשמרה. עכשיו אפשר לראות את התוצאות של האחרים");
  }

  // ---- Sheets ---------------------------------------------------------------------------
  function openSheet(sheet) { state.circles.sheet = sheet; rerender(); }
  function closeSheet() { state.circles.sheet = null; rerender(); }
  function setSection(name) {
    state.circles.section = name;
    const c = currentCircle();
    if (c) { ensureSectionLoaded(c.id); if (name === "feed" && feedState(c.id).loaded) syncHeldPosts(c.id); }
    rerender();
  }
  // Loads what the section on screen needs, once. A failed load is not
  // retried by a render (that would be a loop); the retry button is.
  const membersTried = {};
  function ensureSectionLoaded(clubId) {
    if (!clubId || !client || !state.user) return;
    const sec = state.circles.section;
    const f = state.circles.feed[clubId];
    const w = state.circles.week[clubId];
    const b = state.circles.benchmark[clubId];
    if (sec === "feed" && !(f && (f.loaded || f.loading || f.error))) loadFeed(clubId);
    else if (sec === "week" && !(w && (w.loaded || w.loading || w.error))) loadWeek(clubId);
    else if (sec === "benchmark" && !(b && (b.loaded || b.loading || b.error))) loadBenchmark(clubId);
    // The member count in the header and the roster come from the same read.
    if (!state.circles.members[clubId] && !membersTried[clubId]) { membersTried[clubId] = true; loadMembers(clubId); }
  }
  function reactionStateFor(postId) {
    const r = state.engagement.reactions[postId];
    if (r) return { loaded: !!r.loaded, list: r.list || [], counts: Object.assign({}, r.counts || {}), mine: Array.isArray(r.mine) ? r.mine.slice() : [] };
    // Nothing has been tapped or loaded for this post yet: what circle_feed (or
    // whoever handed the post to the screen) said about it.
    const post = typeof findFeedPost === "function" ? findFeedPost(postId) : null;
    return { loaded: false, list: [], counts: Object.assign({}, (post && post.reaction_counts) || {}), mine: post && Array.isArray(post.my_reactions) ? post.my_reactions.slice() : [] };
  }

  // Drops everything a signed-out device must not keep about the last member.
  function resetCirclesState() {
    const c = state.circles;
    c.loaded = false; c.loading = false; c.loadError = false; c.list = []; c.currentId = "";
    c.section = "feed"; c.members = {}; c.feed = {}; c.week = {}; c.benchmark = {};
    c.mine = { target: null, pausedUntil: null, loaded: false };
    c.pendingTags = []; c.sheet = null; c.shareBar = null; c.busy = {};
    c.join.busy = false; c.join.error = "";
  }
