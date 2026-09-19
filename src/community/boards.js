"use strict";
// ---- Community: boards (COMM-210..212) ------------------------------------
//
// The two leaderboards — consistency and challenge — in both modes and both
// scopes, the "hide my result" opt-out, and the streaks they read. One server
// function (202608290015) backs every board here; the client picks a scope
// and renders rows, and renderRankedList() is the one place the ranked
// conventions (position, medal colours, self-highlight) are written down.
//
// Moved out of cloud.js unchanged — every line byte-identical to what it was
// there. Classic <script>, no IIFE, loaded before cloud.js; see
// src/community/events.js's header for why each of those matters.
//
// WHAT STAYED BEHIND, deliberately: staffWeekDates, loadStaffWeekBoards and
// renderStaffWeekStrip. They carry the word "board" but they are the desktop
// staff shell's week strip (PR #9), they render club WOD sessions rather than
// a ranking, and they sit beside window.renderStaffHome, which is what calls
// them. Nothing about the shell is worth moving for a shared noun.

  // Supabase Security Advisor, security_definer_view finding on the
  // community_streaks VIEW (202608270001/202609060002): a view without
  // security_invoker runs with its owner's rights rather than the
  // caller's. Real here, not a false positive - the view had to run as
  // owner to aggregate every member's activity_pings past that table's
  // owner-only RLS, and there was no way to prove from the client alone
  // that it re-applied every equivalent check by hand (it does; see the
  // migration). 202609080005 moved the same query into a SECURITY DEFINER
  // FUNCTION instead - the pattern every sibling aggregate here already
  // uses (feed_leaderboard, chal_progress, coach_celebrate_feed,
  // member_of_week_candidate_set) - which the advisor's rule does not
  // flag, and which makes "runs with elevated privilege" an explicit,
  // audited property instead of an implicit one. EXPAND phase: the old
  // view still exists and is intentionally left alone until this client
  // has had time to actually reach installed users; a later migration
  // drops it. Ordering and limiting now happen server-side inside the
  // function, matching feed_leaderboard's own call shape.
  async function loadStreaks() {
    if (!state.user) return;
    const { data, error } = await client.rpc("community_streaks", { p_limit: 50 });
    state.club.streaks = error ? [] : (data || []).filter((r) => r.current_streak > 0);
  }

  // Top 3 in full, then — if the viewer isn't in the top 3 — a divider and
  // their own row, instead of one long ranked list past the leaders. Same
  // underlying data, friendlier framing (principle: scoped/small-cohort
  // competition motivates more than "you're #18 of 40").
  function renderRankedList(items, selfKeyOf, formatValue) {
    if (!items.length) return `<div class="empty">אין נתונים עדיין</div>`;
    const selfId = state.user && state.user.id;
    // A screen whose whole job is "who is winning" gave emphasis only to
    // the viewer's own row - rank 1 rendered exactly like rank 40. The
    // leader gets a trophy and a brass tint; isSelf still owns the border
    // color when the two coincide, since "this is you" is the more useful
    // thing to confirm at a glance.
    const rowHtml = (it, index, isSelf) => {
      const isLeader = index === 0;
      const style = isSelf ? ' style="border-color:var(--energy);"' : (isLeader ? ' style="border-color:var(--brass);background:linear-gradient(90deg, color-mix(in srgb, var(--brass) 14%, transparent), transparent);"' : "");
      return `<div class="log-row"${style}><span>${isLeader ? "🏆 " : ""}${index + 1}. ${nameHtml(it.display_name, it.handle)}${isSelf ? " (את/ה)" : ""}</span><span class="mono" style="color:var(--brass);font-weight:${isLeader ? "800" : "400"};">${formatValue(it)}</span></div>`;
    };
    const top = items.slice(0, 3).map((it, i) => rowHtml(it, i, selfKeyOf(it) === selfId));
    const selfIndex = items.findIndex((it) => selfKeyOf(it) === selfId);
    const rows = selfIndex >= 3 ? [...top, `<div class="empty" style="padding:4px 0;font-size:16px;">···</div>`, rowHtml(items[selfIndex], selfIndex, true)] : top;
    return `<div class="log-list">${rows.join("")}</div>`;
  }

  // ==========================================================================
  // COMM-210 / COMM-211 / COMM-212 - feed_leaderboard, both modes, both scopes
  // ==========================================================================
  // One server function (202608290015) backs every board here, so the client
  // has exactly one fetch path, one row renderer and one set of states. The
  // rows come back already ranked, already tie-broken and already filtered on
  // in_leaderboards / visible_to_club / block edges; nothing below re-sorts,
  // re-ranks or re-filters them. `rank` is read off the row, never derived
  // from the array index, because the caller's own row is appended after the
  // visible cutoff and its index is therefore not its position.
  //
  // Three contract details drive the code below and are easy to get wrong:
  //
  // 1. Zero is a real ranked value, not "no data". Every eligible member is
  //    ranked including a 0-week streak, so "not enough data yet" is "no rows
  //    OR every value is 0", not "no rows".
  // 2. The caller's row is ALWAYS returned, appended last with its real rank
  //    when it fell outside p_limit. That is what makes "where do I stand"
  //    free; splitLeaderboardRows() below is what tells the two apart.
  // 3. "Hide my result" is a render choice on top of that row - never a
  //    parameter, never a privacy setting. See state.leaderboard.hideMine.
  // Post-Phase-3 Hebrew copy fix: "עוקבים" (followed), not "חברים" (club
  // members) - the app uses חברים everywhere else to mean club membership,
  // and labeling "people you follow" the same word was a real homonym
  // collision. visibilityLabel() below already uses עוקבים correctly for
  // the identical concept on posts; this scope now matches it.
  const LEADERBOARD_SCOPES = [
    { id: "club", label: "כל המועדון" },
    { id: "friends", label: "עוקבים" },
  ];
  // COMM-210 asks for 50, COMM-211's in-panel board for 20 with a full board
  // at 50. The server clamps to 1..100 regardless; these are what we request.
  const CONSISTENCY_BOARD_LIMIT = 50;
  const CHALLENGE_BOARD_LIMIT = 20;
  const CHALLENGE_BOARD_FULL_LIMIT = 50;
  const HIDE_MY_RESULT_KEY = "haimunia-demo:hideMyLeaderboardResult";
  const LEADERBOARD_ERROR_TEXT = "לא ניתן היה לטעון את הטבלה. נסו שוב.";

  function leaderboardRows(board) { return Array.isArray(board && board.rows) ? board.rows : []; }
  // Detail 1 above. A board of members who have all logged nothing yet is
  // "not enough data", even though every one of them carries a real rank.
  function leaderboardHasNoData(rows) {
    return !rows.length || rows.every((r) => Number((r && r.value) || 0) === 0);
  }
  // COMM-212's empty friends state is "no mutual follows yet", which on the
  // wire is "the only row is my own" - the caller is always included whatever
  // the scope, so an empty friends board is one row, not zero.
  function leaderboardHasNoFriends(rows) {
    return !rows.some((r) => r && !r.is_self);
  }
  // Detail 2 above. Only the LAST row can be the appended self row, and only
  // when its rank fell outside the limit we asked for. Everything before it is
  // the contiguous top block.
  function splitLeaderboardRows(rows, limit) {
    const last = rows[rows.length - 1];
    if (last && last.is_self && Number(last.rank) > Number(limit)) {
      return { top: rows.slice(0, -1), self: last };
    }
    return { top: rows, self: null };
  }
  function setHideMyLeaderboardResult(next) {
    state.leaderboard.hideMine = !!next;
    try { localStorage.setItem(HIDE_MY_RESULT_KEY, next ? "1" : "0"); } catch (e) { /* private mode */ }
    rerender();
  }

  // ---- Fetch: consistency board (COMM-210), club or friends (COMM-212) -----
  async function loadConsistencyLeaderboard() {
    // The profiles row is only written when the member saves the
    // "השלמת פרופיל" step, and feed_leaderboard() gates on my_role_code(),
    // which is null until it exists - so between redeeming the code and
    // finishing the profile this raised 'not authorized' on every render,
    // for a board the profile-completion card is covering anyway.
    if (!client || !state.user || !state.profile) return;
    const b = state.leaderboard;
    const scope = b.scope;
    b.loading = true; b.error = false;
    rerender();
    const { data, error } = await client.rpc("feed_leaderboard", {
      p_mode: "consistency", p_challenge_id: null, p_scope: scope, p_limit: CONSISTENCY_BOARD_LIMIT,
    });
    // A scope switch while this was in flight wins; the stale answer is
    // dropped rather than briefly painting the previous scope's rows.
    if (b.scope !== scope) return;
    b.loading = false; b.loaded = true;
    if (error) { b.error = true; b.rows = []; return rerender(); }
    b.rows = Array.isArray(data) ? data : [];
    track(A.LEADERBOARD_VIEWED, { board: "consistency", rows: b.rows.length, source: "boards" });
    rerender();
  }
  function setLeaderboardScope(scope) {
    if (!scope || state.leaderboard.scope === scope) return;
    // COMM-212: a scope change is a re-fetch of the same surface, never a
    // reload. The previous rows stay on screen under the skeleton gate below
    // only until the new ones land.
    state.leaderboard.scope = scope;
    state.leaderboard.rows = [];
    state.leaderboard.error = false;
    loadConsistencyLeaderboard();
  }

  // ---- Fetch: challenge progress board (COMM-211) --------------------------
  // Lives on the open challenge detail so it dies with it. Called from inside
  // refreshChallengeView() before the dialog drops its loading flag, so the
  // board and the rest of the detail appear together rather than the board
  // popping in a frame later.
  async function loadChallengeBoard(id, opts) {
    if (!client || !state.user) return;
    const v = state.challenges.view;
    if (!v || v.id !== id || !v.board) return;
    const b = v.board;
    const scope = b.scope, limit = b.limit;
    b.loading = true; b.error = false;
    if (opts && opts.rerender) rerender();
    const { data, error } = await client.rpc("feed_leaderboard", {
      p_mode: "progress", p_challenge_id: id, p_scope: scope, p_limit: limit,
    });
    const cur = state.challenges.view;
    if (!cur || cur.id !== id || cur.board !== b || b.scope !== scope || b.limit !== limit) return;
    b.loading = false; b.loaded = true;
    if (error) { b.error = true; b.rows = []; }
    else {
      b.rows = Array.isArray(data) ? data : [];
      track(A.LEADERBOARD_VIEWED, { board: "challenge_progress", rows: b.rows.length, source: "challenge" });
    }
    if (opts && opts.rerender) rerender();
  }
  function setChallengeBoardScope(scope) {
    const v = state.challenges.view;
    if (!v || !v.board || !scope || v.board.scope === scope) return;
    v.board.scope = scope;
    v.board.rows = [];
    v.board.error = false;
    loadChallengeBoard(v.id, { rerender: true });
  }
  // COMM-211's "50 on a dedicated full leaderboard screen if one is opened".
  // Rather than a second screen with a second fetch path, the same panel
  // re-asks for the full 50 in place - one code path, one set of states.
  function expandChallengeBoard() {
    const v = state.challenges.view;
    if (!v || !v.board || v.board.limit >= CHALLENGE_BOARD_FULL_LIMIT) return;
    v.board.limit = CHALLENGE_BOARD_FULL_LIMIT;
    v.board.rows = [];
    v.board.error = false;
    loadChallengeBoard(v.id, { rerender: true });
  }

  // ---- Render ---------------------------------------------------------------
  function leaderboardScopeSwitchHtml(action, active) {
    return `<div class="chip-row" role="group" aria-label="היקף הטבלה" style="margin:0 0 8px;">${LEADERBOARD_SCOPES.map((s) => `<button class="chip-btn${s.id === active ? " selected" : ""}" data-community-action="${action}" data-scope="${s.id}" aria-pressed="${s.id === active ? "true" : "false"}">${s.label}</button>`).join("")}</div>`;
  }
  // Deliberately worded so it cannot be mistaken for the server-enforced
  // opt-out: this hides a row from this device's view of the table, it does
  // not remove anyone from the table. The real opt-out is in_leaderboards,
  // reachable from the Privacy panel and from the link on the weekly board.
  function leaderboardHideToggleHtml() {
    return `<label class="log-row" style="justify-content:space-between;gap:12px;cursor:pointer;margin-top:8px;"><span style="font-size:13px;">הסתרת השורה שלי בתצוגה הזו<span style="color:var(--steel);display:block;font-size:11px;">במכשיר הזה בלבד. אינה משנה את הגדרת הפרטיות.</span></span><input type="checkbox" data-leaderboard-hide-self="1"${state.leaderboard.hideMine ? " checked" : ""} aria-label="הסתרת השורה שלי בתצוגה הזו"/></label>`;
  }
  function leaderboardSkeletonHtml(n) {
    const row = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:52%;background:var(--border);border-radius:6px;display:inline-block;"></span><span style="height:12px;width:18%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
    return `<div class="log-list" aria-busy="true" data-leaderboard-skeleton="1">${row.repeat(n || 4)}</div>`;
  }
  // Same "you" marking convention the challenge board and renderRankedList
  // already use: the energy border plus a "(את/ה)" suffix. Reused rather than
  // reinvented so one member reads the same on every ranked surface.
  function leaderboardRowHtml(row, formatValue) {
    const isSelf = !!row.is_self;
    const isLeader = Number(row.rank) === 1;
    const name = row.display_name || (row.handle ? "@" + row.handle : "חבר/ה");
    // Same leader emphasis as renderRankedList's rowHtml - isSelf still owns
    // the border color when the two coincide.
    const style = isSelf ? ` style="border-color:var(--energy);"` : (isLeader ? ` style="border-color:var(--brass);background:linear-gradient(90deg, color-mix(in srgb, var(--brass) 14%, transparent), transparent);"` : "");
    return `<div class="log-row" data-leaderboard-user="${esc(row.user_id)}"${isSelf ? ` data-leaderboard-self="1"` : ""}${style}><span>${isLeader ? "🏆 " : ""}${Number(row.rank)}. ${esc(name)}${isSelf ? " (את/ה)" : ""}</span><span class="mono" style="color:var(--brass);font-weight:${isLeader ? "800" : "400"};">${formatValue(row)}</span></div>`;
  }
  // COMM-212 / COMM-231. The friends empty state points at the members
  // directory, which is now the real people-finding surface (it ships its
  // own search, reusing COMM-228, so nothing is lost by pointing here
  // instead of the Account tab's search box).
  function leaderboardFriendsEmptyHtml() {
    return `<div class="empty" data-leaderboard-empty="friends">עקבו אחרי חברים כדי להשוות תוצאות.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="leaderboard-find-people">חיפוש אנשים</button></div></div>`;
  }
  function renderLeaderboardBody(board, opts) {
    const rows = leaderboardRows(board);
    if (board.loading && !rows.length) return leaderboardSkeletonHtml(4);
    if (board.error) {
      return `<div class="empty" role="alert" data-leaderboard-empty="error">${LEADERBOARD_ERROR_TEXT}<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="${opts.retryAction}">ניסיון חוזר</button></div></div>`;
    }
    if (board.scope === "friends" && leaderboardHasNoFriends(rows)) return leaderboardFriendsEmptyHtml();
    if (leaderboardHasNoData(rows)) return `<div class="empty" data-leaderboard-empty="no-data">${opts.emptyText}</div>`;
    const { top, self } = splitLeaderboardRows(rows, opts.limit);
    const hide = state.leaderboard.hideMine;
    const topHtml = top.filter((r) => !(hide && r.is_self)).map((r) => leaderboardRowHtml(r, opts.formatValue)).join("");
    // The divider marks the gap between the visible top and the caller's own
    // standing below it - the same "···" renderRankedList already uses.
    const selfHtml = (self && !hide)
      ? `<div class="empty" style="padding:4px 0;font-size:16px;">···</div>` + leaderboardRowHtml(self, opts.formatValue)
      : "";
    return `<div class="log-list" style="max-height:420px;overflow:auto;">${topHtml}${selfHtml}</div>`;
  }
  // COMM-210. The club-wide consistency board on the Boards sub-tab. Replaces
  // the older "רצפי התמדה" strip, which read community_streaks directly and
  // therefore ranked without the in_leaderboards / block filtering, without a
  // stable tie-break and without the caller's own row when they were outside
  // the top three. Same figure, same source of truth as community_profile's
  // current_streak - see consistency_week_streaks() in contracts.md - now
  // resolved server-side. loadStreaks()/state.club.streaks stay for the coach
  // Welcome surface, which reuses the same number per member.
  function renderConsistencyLeaderboardSection() {
    // COMM-321. feed_leaderboard() itself raises once this module is off
    // (a real RLS-equivalent enforcement point, not just a client hide) -
    // this guard only keeps the section shell/empty-card from flashing an
    // error-shaped state a member has no way to act on.
    if (!isModuleEnabled("leaderboards")) return "";
    const b = state.leaderboard;
    const body = renderLeaderboardBody(b, {
      limit: CONSISTENCY_BOARD_LIMIT,
      emptyText: "עדיין אין מספיק נתונים לטבלת עקביות.",
      retryAction: "leaderboard-retry",
      formatValue: (r) => `🔥 ${Number(r.value || 0)}`,
    });
    return `<div class="ach-section" data-leaderboard="consistency">${sectionHead("var(--purple)", "טבלת עקביות")}
      ${leaderboardScopeSwitchHtml("leaderboard-scope", b.scope)}
      ${body}
      ${leaderboardHideToggleHtml()}
      <!-- COMM-317 (Phase 3 QA sweep): this footer note dated back to
      COMM-210 (Phase 2), when the board was still ranking
      workout_posts-derived streaks and this line was an accurate
      "coming later" promise. COMM-306 (Phase 3) already replaced
      consistency_week_streaks()'s body with attendance_log - the board has
      been ranking real, trigger-derived training-log attendance since that
      ticket shipped, and the old copy was left unchanged, so it told every
      member the exact feature already under their feet was still pending.
      Corrected to describe what the board actually measures now, using
      COMM-300's own "verified means self-reported, not physically
      verified" framing: derived from the member's own private training
      log, not from a public feed post - never a claim of a physical
      check-in. -->
      <div class="footer-note" style="margin-top:8px;">הרצף מבוסס על אימונים שתועדו ביומן האימונים האישי, לא על פרסום בפיד.</div>
    </div>`;
  }
