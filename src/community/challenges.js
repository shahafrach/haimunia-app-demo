"use strict";
// ---- Community: challenges (COMM-201..208, COMM-308) ----------------------
//
// All six challenge types, the cooperative and team variants with their team
// management, join/leave, manual and automatic progress, the coach entry
// roster, the challenge detail dialog, and the two product-event consumers
// (PR_CREATED and WORKOUT_COMPLETED) that feed individual challenges.
//
// Moved out of cloud.js unchanged — every line byte-identical to what it was
// there. Classic <script>, no IIFE, loaded before cloud.js; see
// src/community/events.js's header for why each of those matters.
//
// WHAT STAYED BEHIND, deliberately:
//
//   renderChallengeLinkCard — one of thirteen siblings dispatched from
//   POST_CARD_RENDERERS. It moves with posts, for the same reason
//   renderEventLinkCard did not move with events.
//
//   The WEEKLY challenge (challengeKeyChoices, loadWeeklyChallenge,
//   setWeeklyChallenge, activeWeeklyChallenge). Despite the name it is the
//   club's programming surface — a coach sets one comparison lift for the
//   week — and it shares neither the challenges table nor any of the code
//   below. It belongs with club management.
//
//   ensureChallengeRealtime / onChallengeRealtime, which are part of the one
//   Realtime block that also serves feed and notifications. Platform, not a
//   feature.

  // ---- Challenges (COMM-201..207) -----------------------------------------
  // Generalizes the old single hardcoded weekly challenge (loadWeeklyChallenge
  // / setWeeklyChallenge / weeklyLeaderboard, still above, still serving the
  // legacy weekly_challenges table read-only) into the six challenge_type
  // model. Nothing here reads or writes weekly_challenges; the two systems
  // sit side by side, which is what COMM-201 asks for ("stop being the write
  // and read path for new challenges", not "delete the historical board").
  const CHALLENGE_TYPES = [
    { id: "individual_target", label: "יעד אישי", icon: "🎯" },
    { id: "individual_performance", label: "ביצוע אישי", icon: "📈" },
    { id: "cooperative", label: "שיתופי", icon: "🤝" },
    { id: "team", label: "קבוצתי", icon: "🏳️" },
    { id: "consistency", label: "עקביות", icon: "📅" },
    { id: "coach", label: "מותאם אישית", icon: "🏋️" },
  ];
  function challengeTypeDef(id) { return CHALLENGE_TYPES.find((t) => t.id === id) || { id, label: id || "", icon: "🏆" }; }
  function challengeStatusLabel(c) { return { draft: "טיוטה", active: "פעיל", completed: "הושלם", archived: "בארכיון" }[c && c.status] || (c && c.status) || ""; }
  function formatChallengeDate(iso) { return iso ? String(iso).slice(0, 10) : ""; }
  function daysRemaining(endAt) {
    if (!endAt) return null;
    return Math.max(0, Math.ceil((new Date(endAt).getTime() - Date.now()) / 86400000));
  }
  function challengeProgressBarHtml(pct) {
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    return `<div class="progress-track"><div style="width:${clamped}%;"></div></div>`;
  }

  async function loadChallenges() {
    if (!state.user) { state.challenges.items = []; state.challenges.participation = {}; state.challenges.aggregates = {}; state.challenges.loaded = false; return; }
    state.challenges.loading = true;
    rerender();
    // Launch-readiness audit, PERF-2. Was an unbounded select("*") with no
    // limit: every challenge the club has ever run, fetched in full on
    // every load of this tab. 200 is far above any realistic active count
    // (the board shows current programming, not history) while making the
    // query bounded rather than growing forever with the club.
    const { data, error } = await client.from("challenges").select("*").order("end_at", { ascending: true }).limit(200);
    if (error) { state.challenges.loading = false; state.challenges.error = true; return rerender(); }
    state.challenges.items = data || [];
    state.challenges.error = false;
    const { data: myRows, error: myErr } = await client.from("challenge_participants").select("*").eq("user_id", state.user.id);
    state.challenges.participation = {};
    if (!myErr) for (const row of (myRows || [])) state.challenges.participation[row.challenge_id] = row;
    // chal_progress() is fetched for every active challenge, not lazily per
    // card: this is a single small club, active challenges are few, and the
    // list card needs a real participant_count and (for cooperative/team) a
    // real aggregate rather than a stale one, per COMM-207's card contract.
    const active = state.challenges.items.filter((c) => c.status === "active");
    await Promise.all(active.map(async (c) => {
      const { data: p, error: pErr } = await client.rpc("chal_progress", { challenge_id: c.id });
      if (!pErr && p) state.challenges.aggregates[c.id] = p;
    }));
    state.challenges.loading = false;
    state.challenges.loaded = true;
    rerender();
  }

  // ---- Detail (COMM-207) --------------------------------------------------
  async function openChallenge(id, source) {
    if (!id) return;
    track(A.CHALLENGE_VIEWED, { challenge_id: id, challenge_key: null, source: source || "boards" });
    state.challenges.view = {
      id, loading: true, error: false, challenge: null, progress: null, teams: [], participants: [], contributors: [], myParticipant: null,
      joining: false, leaving: false, teamJoining: null, sharing: false,
      logForm: { delta: "", note: "", busy: false, error: "" },
      // Launch-readiness audit item 2. Own state for the consistency "week
      // hit" tap, separate from logForm above: logForm is a manual numeric
      // entry the member types, while this tap now goes through a real
      // attendance_log read with no form input at all - reusing logForm's
      // busy/error would make an unrelated manual-entry error message
      // linger under the consistency button, or vice versa.
      consistencyCheck: { busy: false, error: "" },
      coachEntry: { drafts: {}, busy: {}, error: "" },
      // COMM-211/212. feed_leaderboard(mode='progress') rows for this
      // challenge, fetched only for the two types whose panel shows a board.
      // Starts `loading` so the first paint is the skeleton, not an empty
      // state we have not asked the server about yet.
      board: { scope: "club", limit: CHALLENGE_BOARD_LIMIT, rows: [], loading: true, loaded: false, error: false },
      // COMM-308. A community.challenge.create holder's team management
      // block inside the `team` panel - create/rename/delete challenge_teams
      // rows, move a participant (chal_reassign_team) and set/clear a
      // captain (chal_set_captain). `loading` is this block's own skeleton
      // flag, set only around a refetch this block itself triggers (a
      // mutation here can change team_totals, participants and captains all
      // at once, so the whole detail is re-read rather than patched by
      // hand) - separate from the dialog-level `loading` above, which only
      // ever covers the very first open. Untouched by anything a plain
      // member does; nothing here is ever visible to one.
      teamMgmt: { createName: "", createBusy: false, createError: "", renameDrafts: {}, renameBusy: {}, deleteBusy: {}, captainBusy: {}, reassignBusy: {}, loading: false, error: "" },
    };
    rerender();
    await refreshChallengeView(id);
  }
  // COMM-209. Leaving the detail closes its two channels immediately rather
  // than waiting for the next render to notice, so a member who opens and
  // closes several challenges never holds more than one pair open.
  function closeChallengeView() { state.challenges.view = null; ensureChallengeRealtime(); rerender(); }
  async function refreshChallengeView(id) {
    const v = state.challenges.view;
    if (!v || v.id !== id) return;
    const [{ data: challenge, error: cErr }, { data: progress, error: pErr }] = await Promise.all([
      client.from("challenges").select("*").eq("id", id).maybeSingle(),
      client.rpc("chal_progress", { challenge_id: id }),
    ]);
    if (!state.challenges.view || state.challenges.view.id !== id) return;
    if (cErr || !challenge) { state.challenges.view.loading = false; state.challenges.view.error = true; return rerender(); }
    state.challenges.view.challenge = challenge;
    state.challenges.view.progress = pErr ? null : progress;
    if (challenge.status === "active" && !pErr && progress) state.challenges.aggregates[id] = progress;
    const { data: participants } = await client.from("challenge_participants")
      .select("*, profiles(display_name,handle,avatar_url,visible_to_club)")
      .eq("challenge_id", id).order("joined_at", { ascending: true });
    state.challenges.view.participants = participants || [];
    const mine = (participants || []).find((p) => p.user_id === (state.user && state.user.id)) || null;
    state.challenges.view.myParticipant = mine;
    if (state.user) { if (mine) state.challenges.participation[id] = mine; else delete state.challenges.participation[id]; }
    if (challenge.challenge_type === "team") {
      const { data: teams } = await client.from("challenge_teams").select("*").eq("challenge_id", id).order("name", { ascending: true });
      state.challenges.view.teams = teams || [];
    }
    if (challenge.challenge_type === "cooperative") {
      const { data: contrib } = await client.from("challenge_progress")
        // Names the foreign key for the same reason loadCommentsFor() does:
        // challenge_progress references profiles twice (user_id and
        // entered_by), so a bare `profiles(...)` is PGRST201-ambiguous and
        // the contributor list came back empty every time.
        .select("user_id,delta,created_at,profiles!challenge_progress_user_id_fkey(display_name,handle,avatar_url,visible_to_club)")
        .eq("challenge_id", id).gt("delta", 0).order("created_at", { ascending: false }).limit(30);
      const seen = new Set();
      const list = [];
      for (const row of (contrib || [])) {
        if (seen.has(row.user_id)) continue;
        seen.add(row.user_id);
        // COMM-203. A contributor who turned visible_to_club off still
        // counts toward club_total (that sum is chal_progress's, computed
        // server-side over every row) but is omitted from this named list.
        if (row.profiles && row.profiles.visible_to_club === false) continue;
        list.push(row);
        if (list.length >= 10) break;
      }
      state.challenges.view.contributors = list;
    }
    // COMM-211. Awaited before the dialog drops its loading flag so the board
    // and the rest of the detail land in the same paint. Only the two types
    // whose panel is a leaderboard ask for it; nothing else touches
    // feed_leaderboard from the challenge detail at all.
    if (challenge.challenge_type === "individual_performance" || challenge.challenge_type === "coach") {
      await loadChallengeBoard(id, { rerender: false });
      if (!state.challenges.view || state.challenges.view.id !== id) return;
    } else if (state.challenges.view.board) {
      state.challenges.view.board.loading = false;
    }
    state.challenges.view.loading = false;
    rerender();
  }

  // ---- Join / leave / team pick (COMM-204, COMM-207) -----------------------
  // Live bug hunt, round 10 (2026-09-11): v.joining only ever guarded the
  // OPEN DETAIL DIALOG's own join button - the list-card "הצטרפות" button
  // (renderChallengeCard()) had no busy/disabled guard at all. Confirmed
  // live on a throttled connection: two taps ~150ms apart fired
  // joinChallenge() twice; challenge_participants' real primary key
  // (challenge_id, user_id) let the first insert win and correctly rejected
  // the second with a genuine 23505 duplicate-key error, which then
  // overwrote the real "הצטרפת לאתגר" success toast with "לא ניתן היה
  // להצטרף לאתגר" - a member told their join failed when it had actually
  // succeeded. Same shape as reactionBusy/followBusy elsewhere in this
  // file: a per-id guard both entry points share.
  const challengeJoinBusy = {};
  async function joinChallenge(id, source) {
    if (!state.user || challengeJoinBusy[id]) return;
    challengeJoinBusy[id] = true;
    const v = state.challenges.view;
    const c = (v && v.challenge) || state.challenges.items.find((x) => x.id === id);
    if (v && v.id === id) v.joining = true;
    rerender(); // shows the list-card's own busy state even when the detail dialog for this id isn't open
    // Launch-readiness audit item 5. challenge_progress is NOT deleted when
    // a member leaves - there is no FK from challenge_progress to
    // challenge_participants at all (only to challenges and profiles, both
    // on delete cascade for THOSE rows' own deletion), and 202608280009's
    // own comment on challenge_progress.team_id says so directly: a
    // "departed member's historical contributions would have no team to be
    // attributed to once their participant row was gone" is exactly why
    // that snapshot column exists. Only the challenge_participants row (and
    // its progress_value cache) goes away on leave. A plain re-insert would
    // leave the new row at the table's default progress_value of 0, which
    // would render as "0 / target" even though every prior contribution is
    // still sitting in challenge_progress and still counts toward a
    // cooperative club_total or a team_total for the whole time the member
    // was away - a silent full progress loss on the member's own read of
    // their own standing. This re-sums the member's own prior
    // challenge_progress rows for this challenge (self-read, already
    // allowed under challenge_progress_read, the same table
    // maybeCelebrateChallengeCompletion's callers already read from) and
    // seeds the new row with that real total, plus - for the two types
    // challenge_progress_apply itself auto-completes - the same completion
    // flip a first-time insert of that total would have triggered, so a
    // rejoin cannot land a member who already cleared the target back in
    // 'active'.
    const { data: priorRows, error: priorErr } = await client.from("challenge_progress")
      .select("delta").eq("challenge_id", id).eq("user_id", state.user.id);
    const priorTotal = priorErr ? 0 : (priorRows || []).reduce((sum, r) => sum + Number(r.delta || 0), 0);
    // status is set explicitly rather than left to the column's own
    // 'active' default - the same reasoning as everywhere else in this
    // model: a status this client computed from a real completion check
    // should never be one accidental column omission away from silently
    // reading as whatever the table default happens to be.
    const insertPayload = { challenge_id: id, user_id: state.user.id, progress_value: priorTotal, status: "active" };
    const canComplete = c && ["individual_target", "individual_performance"].indexOf(c.challenge_type) >= 0
      && c.target_value != null && priorTotal >= Number(c.target_value);
    if (canComplete) { insertPayload.status = "completed"; insertPayload.completed_at = new Date().toISOString(); }
    const { error } = await client.from("challenge_participants").insert(insertPayload);
    if (v && v.id === id) v.joining = false;
    delete challengeJoinBusy[id];
    // Live bug hunt, round 10 (2026-09-11): a losing duplicate-key race
    // (23505 on the real (challenge_id, user_id) primary key) means the
    // member IS a participant now - a second device, a retried request
    // after a flaky response, or (before the busy guard above) a
    // double-tap all land here having genuinely succeeded. Treat it the
    // same as a win, not a failure.
    if (error && error.code !== "23505") { setMessage(failText("לא ניתן היה להצטרף לאתגר. נסו שוב.", error)); return rerender(); }
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.CHALLENGE_JOINED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.CHALLENGE_JOINED, { challenge_id: id, challenge_type: c && c.challenge_type }); } catch (e) {}
    }
    setMessage("הצטרפת לאתגר");
    if (c && c.challenge_type === "team" && c.join_mode === "auto") await autoAssignChallengeTeam(id);
    await loadChallenges();
    if (state.challenges.view && state.challenges.view.id === id) await refreshChallengeView(id);
    rerender();
  }
  async function autoAssignChallengeTeam(id) {
    if (!state.user) return;
    const { data: teams } = await client.from("challenge_teams").select("*").eq("challenge_id", id);
    const { data: parts } = await client.from("challenge_participants").select("team_id,status").eq("challenge_id", id);
    if (!teams || !teams.length) return;
    const counts = {};
    for (const t of teams) counts[t.id] = 0;
    for (const p of (parts || [])) if (p.status !== "withdrawn" && p.team_id) counts[p.team_id] = (counts[p.team_id] || 0) + 1;
    const chosen = teams.slice().sort((a, b) => (counts[a.id] || 0) - (counts[b.id] || 0))[0];
    if (!chosen) return;
    await client.from("challenge_participants").update({ team_id: chosen.id }).eq("challenge_id", id).eq("user_id", state.user.id);
  }
  async function pickChallengeTeam(challengeId, teamId) {
    if (!state.user) return;
    const v = state.challenges.view;
    if (v) { v.teamJoining = teamId; rerender(); }
    const { error } = await client.from("challenge_participants").update({ team_id: teamId }).eq("challenge_id", challengeId).eq("user_id", state.user.id);
    if (v) v.teamJoining = null;
    if (error) { setMessage(failText("לא ניתן היה להצטרף לקבוצה. נסו שוב.", error)); return rerender(); }
    if (state.challenges.view && state.challenges.view.id === challengeId) await refreshChallengeView(challengeId);
    rerender();
  }

  // ---- Team management (COMM-308) ------------------------------------------
  // A community.challenge.create holder only, layered onto the `team` panel
  // COMM-204 already shipped. Team creation/rename/delete stay the same
  // direct-RLS write COMM-006/COMM-204 always used (challenge_teams'
  // policies are unchanged by the schema half); moving a participant and
  // naming a captain are the two new security-definer RPCs
  // (chal_reassign_team, chal_set_captain), the same coach-past-RLS shape
  // chal_record_progress already established. Every mutation here re-reads
  // the whole detail through refreshChallengeView rather than patching state
  // by hand, because a single reassignment can move a team_totals number, a
  // participant's team_id AND (via challenge_teams_release_captain, schema
  // half) a captain_id all in one server transaction - the client should
  // show what the server actually did, not what it assumes happened.
  //
  // The nine real Postgres errors chal_reassign_team/chal_set_captain raise
  // (verbatim, schema half), mapped to short Hebrew - the same
  // setMessage()-surfaced pattern memberOfWeekErrorText/monthlyRecapErrorText
  // already use for a failed staff action. Any other error (network, a
  // failed direct challenge_teams write) falls back to the ticket's own
  // generic copy, "הפעולה נכשלה. נסו שוב.".
  const CHALLENGE_TEAM_MGMT_ERROR_LABELS = {
    "not authorized": "אין הרשאה לבצע פעולה זו.",
    "challenge and target participant are required": "חסרים פרטים לביצוע ההעברה.",
    "challenge not found": "האתגר לא נמצא.",
    "not a team challenge": "האתגר הזה אינו אתגר קבוצתי.",
    "not an active participant": "המשתתף/ת אינו/ה פעיל/ה באתגר.",
    "team does not belong to this challenge": "הקבוצה אינה שייכת לאתגר הזה.",
    "team is required": "יש לבחור קבוצה.",
    "team not found": "הקבוצה לא נמצאה.",
    "captain must be an active participant on this team": "הקפטן/ית חייב/ת להיות משתתף/ת פעיל/ה בקבוצה.",
    "team not empty": "יש לפנות את הקבוצה מחברים לפני מחיקתה.",
  };
  function challengeTeamMgmtErrorText(error) {
    const msg = error && error.message;
    return (msg && CHALLENGE_TEAM_MGMT_ERROR_LABELS[msg]) || "הפעולה נכשלה. נסו שוב.";
  }
  // Re-reads the whole detail after a team-management write, with its own
  // skeleton flag around just that (state.challenges.view.teamMgmt.loading),
  // not the dialog-level one refreshChallengeView() itself never sets after
  // the first open - see the state comment in openChallenge().
  async function refreshAfterTeamMgmt(id) {
    const v = state.challenges.view;
    if (!v || v.id !== id) return;
    v.teamMgmt.loading = true;
    rerender();
    await refreshChallengeView(id);
    const after = state.challenges.view;
    if (after && after.id === id) { after.teamMgmt.loading = false; rerender(); }
  }
  async function createChallengeTeam() {
    const v = state.challenges.view;
    if (!v || !v.challenge || v.teamMgmt.createBusy) return;
    const name = String(v.teamMgmt.createName || "").trim();
    if (!name || name.length > 80) { v.teamMgmt.createError = "יש להזין שם קבוצה, עד 80 תווים"; return rerender(); }
    v.teamMgmt.createBusy = true; v.teamMgmt.createError = ""; rerender();
    const { error } = await client.from("challenge_teams").insert({ id: newFeedId(), challenge_id: v.id, name });
    v.teamMgmt.createBusy = false;
    if (error) { v.teamMgmt.createError = "הפעולה נכשלה. נסו שוב."; return rerender(); }
    v.teamMgmt.createName = "";
    setMessage("הקבוצה נוצרה");
    await refreshAfterTeamMgmt(v.id);
  }
  async function renameChallengeTeam(teamId) {
    const v = state.challenges.view;
    if (!v || !v.challenge || v.teamMgmt.renameBusy[teamId]) return;
    const existing = (v.teams || []).find((t) => t.id === teamId);
    const draft = v.teamMgmt.renameDrafts[teamId];
    const name = String(draft != null ? draft : (existing ? existing.name : "")).trim();
    if (!name || name.length > 80) { v.teamMgmt.error = "יש להזין שם קבוצה, עד 80 תווים"; return rerender(); }
    v.teamMgmt.renameBusy[teamId] = true; v.teamMgmt.error = ""; rerender();
    const { error } = await client.from("challenge_teams").update({ name }).eq("id", teamId);
    v.teamMgmt.renameBusy[teamId] = false;
    if (error) { v.teamMgmt.error = challengeTeamMgmtErrorText(error); return rerender(); }
    delete v.teamMgmt.renameDrafts[teamId];
    setMessage("שם הקבוצה עודכן");
    await refreshAfterTeamMgmt(v.id);
  }
  // COMM-308's own rule: a team with an active (non-withdrawn) participant
  // refuses deletion server-side ('team not empty'). The delete control is
  // disabled client-side whenever this client already knows the team has a
  // member (renderTeamManagementPanel), so this call only ever reaches the
  // server for a genuinely empty team from this client's own point of view -
  // the error mapping stays as a defensive fallback for the race a second
  // coach's tab can create, not the primary guard.
  function confirmDeleteChallengeTeam(teamId) {
    askConfirm({ title: "מחיקת קבוצה", message: "למחוק את הקבוצה? הפעולה אינה ניתנת לביטול.", confirmLabel: "מחיקה", destructive: true, action: "challenge-team-delete-confirm", payload: { teamId } });
  }
  async function deleteChallengeTeam(teamId) {
    const v = state.challenges.view;
    if (!v || !v.challenge || v.teamMgmt.deleteBusy[teamId]) return;
    v.teamMgmt.deleteBusy[teamId] = true; v.teamMgmt.error = ""; rerender();
    const { error } = await client.from("challenge_teams").delete().eq("id", teamId);
    v.teamMgmt.deleteBusy[teamId] = false;
    if (error) { v.teamMgmt.error = challengeTeamMgmtErrorText(error); return rerender(); }
    setMessage("הקבוצה נמחקה");
    await refreshAfterTeamMgmt(v.id);
  }
  async function reassignChallengeParticipant(challengeId, userId, teamId) {
    const v = state.challenges.view;
    if (!v || v.teamMgmt.reassignBusy[userId]) return;
    v.teamMgmt.reassignBusy[userId] = true; v.teamMgmt.error = ""; rerender();
    const { error } = await client.rpc("chal_reassign_team", { p_challenge_id: challengeId, p_user_id: userId, p_team_id: teamId || null });
    v.teamMgmt.reassignBusy[userId] = false;
    if (error) { v.teamMgmt.error = challengeTeamMgmtErrorText(error); return rerender(); }
    setMessage("המשתתף/ת הועבר/ה לקבוצה");
    await refreshAfterTeamMgmt(v.id);
  }
  async function setChallengeTeamCaptain(teamId, userId) {
    const v = state.challenges.view;
    if (!v || v.teamMgmt.captainBusy[teamId]) return;
    v.teamMgmt.captainBusy[teamId] = true; v.teamMgmt.error = ""; rerender();
    const { error } = await client.rpc("chal_set_captain", { p_team_id: teamId, p_user_id: userId || null });
    v.teamMgmt.captainBusy[teamId] = false;
    if (error) { v.teamMgmt.error = challengeTeamMgmtErrorText(error); return rerender(); }
    setMessage(userId ? "הקפטן/ית עודכן/ה" : "הקפטן/ית הוסר/ה");
    await refreshAfterTeamMgmt(v.id);
  }

  function confirmLeaveChallenge(id) {
    askConfirm({ title: "עזיבת אתגר", message: "לעזוב את האתגר? ההתקדמות שכבר נרשמה תישאר בסטטיסטיקות המועדון.", confirmLabel: "עזיבה", destructive: true, action: "leave-challenge", payload: { challengeId: id } });
  }
  async function leaveChallenge(id) {
    if (!state.user) return;
    const v = state.challenges.view;
    if (v && v.id === id) { v.leaving = true; rerender(); }
    const { error } = await client.from("challenge_participants").delete().eq("challenge_id", id).eq("user_id", state.user.id);
    if (v && v.id === id) v.leaving = false;
    if (error) { setMessage(failText("לא ניתן היה לעזוב את האתגר. נסו שוב.", error)); return rerender(); }
    delete state.challenges.participation[id];
    setMessage("עזבת את האתגר");
    await loadChallenges();
    if (state.challenges.view && state.challenges.view.id === id) await refreshChallengeView(id);
    rerender();
  }

  // ---- Self-logged progress (COMM-202, COMM-203, COMM-204, COMM-205) ------
  function maybeCelebrateChallengeCompletion(challengeType, challengeId, wasStatus, isStatus) {
    if (wasStatus === "completed" || isStatus !== "completed") return;
    setMessage("כל הכבוד! השלמת את האתגר");
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.CHALLENGE_COMPLETED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.CHALLENGE_COMPLETED, { challenge_id: challengeId, challenge_type: challengeType }); } catch (e) {}
    }
  }
  async function submitChallengeLog() {
    const v = state.challenges.view;
    if (!v || !v.challenge || v.logForm.busy) return;
    const raw = String(v.logForm.delta || "").trim();
    const delta = Number(raw);
    if (!raw || !Number.isFinite(delta) || delta === 0) { v.logForm.error = "יש להזין ערך מספרי"; return rerender(); }
    v.logForm.busy = true; v.logForm.error = ""; rerender();
    const wasStatus = v.myParticipant && v.myParticipant.status;
    const note = String(v.logForm.note || "").trim().slice(0, 500) || null;
    const { error } = await client.from("challenge_progress").insert({ challenge_id: v.id, user_id: state.user.id, delta, source_type: "manual", note });
    v.logForm.busy = false;
    if (error) { v.logForm.error = "לא ניתן היה לעדכן את ההתקדמות."; return rerender(); }
    v.logForm.delta = ""; v.logForm.note = "";
    await refreshChallengeView(v.id);
    await loadChallenges();
    const after = state.challenges.view && state.challenges.view.myParticipant;
    if (after) maybeCelebrateChallengeCompletion(v.challenge.challenge_type, v.id, wasStatus, after.status);
    rerender();
  }
  // COMM-205. Consistency has no numeric delta from the member: one tap logs
  // exactly one "week hit" once a week's target is reached. Detail-only, no
  // dedicated dialog.
  //
  // Launch-readiness audit item 2. This used to just call submitChallengeLog()
  // with a hardcoded delta of "1" on every tap - an unrated, unlimited
  // client-side action with no read of anything real. A member could tap
  // "week completed" as many times as they liked with zero relationship to
  // whether they had actually trained. onWorkoutCompletedForChallenges'
  // consistency branch below DOES tally real sessions per ISO week, but that
  // fires on a training-log completion event (WORKOUT_COMPLETED), which has
  // no producer anywhere in this codebase (see the comment above that
  // function) - this button is the only path actually reachable from the
  // UI (data-community-action="challenge-log-week-hit"), so it is the one
  // that needed real verification, not the dormant one.
  //
  // "Real verification" here means attendance_log (COMM-300): the member's
  // own, server-recorded, per-calendar-day training log, one row per day by
  // its own unique(user_id, occurred_on) constraint, read under
  // attendance_log_self_select the same direct-RLS way
  // loadOnboardingAttendance() already reads it elsewhere in this file. This
  // reads the caller's own attendance_log rows for the current ISO week
  // (Monday-Sunday, isoWeekBounds()) and only logs the week-hit delta once
  // that real count actually reaches config.times_per_week.
  //
  // A second, independent guard: challenge_progress is append-only and this
  // is a direct RLS insert, so nothing server-side stops a second click on
  // an already-qualifying week from inserting a second delta. This checks
  // the caller's own prior challenge_progress rows for THIS challenge with
  // source_type 'attendance_week_hit' whose created_at already falls inside
  // this ISO week and refuses a repeat - a real server-data check, not only
  // an in-memory flag that would reset on reload.
  async function logConsistencyWeekHit() {
    const v = state.challenges.view;
    if (!v || !v.challenge || v.consistencyCheck.busy) return;
    const challengeId = v.id;
    const timesPerWeek = Number((v.challenge.config && v.challenge.config.times_per_week) || 0);
    v.consistencyCheck.busy = true; v.consistencyCheck.error = ""; rerender();
    const { start, end } = isoWeekBounds();
    const [alreadyRes, attendedRes] = await Promise.all([
      client.from("challenge_progress").select("id")
        .eq("challenge_id", challengeId).eq("user_id", state.user.id).eq("source_type", "attendance_week_hit")
        .gte("created_at", start + "T00:00:00.000Z").lte("created_at", end + "T23:59:59.999Z"),
      client.from("attendance_log").select("occurred_on")
        .eq("user_id", state.user.id).gte("occurred_on", start).lte("occurred_on", end),
    ]);
    if (alreadyRes.error || attendedRes.error) {
      v.consistencyCheck.busy = false;
      v.consistencyCheck.error = "לא ניתן היה לבדוק את הנוכחות. נסו שוב.";
      return rerender();
    }
    if (Array.isArray(alreadyRes.data) && alreadyRes.data.length) {
      v.consistencyCheck.busy = false;
      v.consistencyCheck.error = "השבוע הזה כבר נרשם.";
      return rerender();
    }
    const attendedCount = Array.isArray(attendedRes.data) ? attendedRes.data.length : 0;
    if (!timesPerWeek || attendedCount < timesPerWeek) {
      v.consistencyCheck.busy = false;
      v.consistencyCheck.error = `עדיין לא הגעת ${timesPerWeek === 1 ? "פעם אחת" : `${timesPerWeek} פעמים`} השבוע (${attendedCount} מתוך ${timesPerWeek}).`;
      return rerender();
    }
    const { error } = await client.from("challenge_progress")
      .insert({ challenge_id: challengeId, user_id: state.user.id, delta: 1, source_type: "attendance_week_hit" });
    v.consistencyCheck.busy = false;
    if (error) {
      v.consistencyCheck.error = "לא ניתן היה לעדכן את ההתקדמות.";
      return rerender();
    }
    await refreshChallengeView(challengeId);
    await loadChallenges();
    // challenge_progress_apply (contracts.md, "Needs from schema,
    // challenges") deliberately excludes consistency and team from its
    // auto-complete list - my_status there stays whatever the participant
    // row already carried. COMM-205 still asks for "completing all required
    // weeks marks the participant completed", so the client does that one
    // direct-RLS status update itself: challenge_participants_update_self
    // already allows a self-row update with no column restriction, so this
    // needs no new policy or function, matching COMM-201's "no new write
    // RPC" rule.
    const after = state.challenges.view;
    if (!after || after.id !== challengeId || !after.myParticipant || !after.challenge) return;
    const weeks = Number((after.challenge.config && after.challenge.config.weeks) || 0);
    if (after.myParticipant.status !== "completed" && weeks > 0 && Number(after.myParticipant.progress_value || 0) >= weeks) {
      const { error } = await client.from("challenge_participants")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("challenge_id", challengeId).eq("user_id", state.user.id);
      if (!error) {
        maybeCelebrateChallengeCompletion("consistency", challengeId, "active", "completed");
        await refreshChallengeView(challengeId);
        await loadChallenges();
        rerender();
      }
    }
  }

  // ---- Coach manual entry (COMM-206) ---------------------------------------
  async function submitCoachEntry(userId) {
    const v = state.challenges.view;
    if (!v || !v.challenge || !userId) return;
    const d = v.coachEntry.drafts[userId] || {};
    const delta = Number(String(d.delta || "").trim());
    if (!d.delta || !Number.isFinite(delta) || delta === 0) { v.coachEntry.error = "יש להזין ערך מספרי"; return rerender(); }
    v.coachEntry.busy[userId] = true; v.coachEntry.error = ""; rerender();
    const targetParticipant = v.participants.find((p) => p.user_id === userId);
    const wasStatus = targetParticipant && targetParticipant.status;
    const note = String(d.note || "").trim().slice(0, 500) || null;
    const { error, queued } = await communityRpc("chal_record_progress", { p_challenge_id: v.id, p_user_id: userId, p_delta: delta, p_note: note });
    v.coachEntry.busy[userId] = false;
    if (queued) {
      // The highest-value queued action in the app: a coach's progress
      // entry is an append-only DELTA, so before the idempotency key
      // (202609060014) a retry silently double-counted it. Clearing the
      // draft is safe precisely because the queued op cannot be applied
      // twice.
      v.coachEntry.drafts[userId] = { delta: "", note: "" };
      await refreshOutboxState();
      setMessage("אין חיבור — העדכון יישלח כשהחיבור יחזור");
      return rerender();
    }
    // Same omission as the composer above: the offline path for this very RPC
    // maps its errors, and this one did not - so a coach updating a
    // participant who had quietly left the challenge was told "couldn't save,
    // try again" forever, with no hint that retrying was futile.
    if (error) { v.coachEntry.error = failText("לא ניתן היה לשמור את העדכון.", error); return rerender(); }
    v.coachEntry.drafts[userId] = { delta: "", note: "" };
    await refreshChallengeView(v.id);
    const after = state.challenges.view && state.challenges.view.participants.find((p) => p.user_id === userId);
    if (after) maybeCelebrateChallengeCompletion(v.challenge.challenge_type, v.id, wasStatus, after.status);
    rerender();
  }

  // ---- Share Progress (COMM-207) -------------------------------------------
  async function shareChallengeProgress() {
    const v = state.challenges.view;
    if (!v || !v.challenge || v.sharing) return;
    v.sharing = true; rerender();
    const c = v.challenge, p = v.progress || {};
    const lines = [c.title];
    if (c.challenge_type === "cooperative" && p.club_total != null) lines.push(`${p.club_total}${c.target_value != null ? ` / ${c.target_value}` : ""}`);
    else if (p.my_progress != null) lines.push(`${p.my_progress}${c.target_value != null ? ` / ${c.target_value}` : ""}`);
    const body = lines.join("\n");
    // COMM-207 asks Share Progress to call post_create with links.challenge_id
    // set, producing a POST_CHALLENGE post. post_create's shipped signature
    // (202608280023) only merges workout_id/achievement_id/event_id out of
    // `links` into metadata and only ever writes POST_TEXT or POST_PHOTO -
    // there is no server path yet that turns a member's own share into a
    // POST_CHALLENGE row with challenge_id/progress in its metadata. Sending
    // challenge_id anyway costs nothing (an unknown links key is dropped, not
    // rejected) and is exactly what a follow-up post_create migration needs
    // to start honouring; until then this still produces a real, truthful
    // POST_TEXT post carrying the same progress line in its body. Recorded
    // as an open gap in the handoff notes, not silently worked around.
    const { data, error } = await client.rpc("post_create", { body, visibility: "club", media: [], links: { challenge_id: c.id } });
    v.sharing = false;
    if (error || !data) { setMessage("שיתוף ההתקדמות נכשל, אפשר לנסות שוב"); return rerender(); }
    setMessage("ההתקדמות שותפה לקהילה");
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.POST_CREATED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.POST_CREATED, { post_id: data, post_type: "POST_TEXT" }); } catch (e) {}
    }
    rerender();
  }

  // ---- Create / edit form (COMM-201) ---------------------------------------
  function openChallengeForm(existing) {
    state.challenges.form = existing ? {
      mode: "edit", id: existing.id, status: existing.status, challengeType: existing.challenge_type,
      title: existing.title, description: existing.description || "",
      metricType: existing.metric_type, targetValue: existing.target_value != null ? String(existing.target_value) : "",
      startAt: formatChallengeDate(existing.start_at), endAt: formatChallengeDate(existing.end_at),
      rulesText: (existing.config && existing.config.rules_text) || "",
      metricLabel: (existing.config && existing.config.metric_label) || "",
      timesPerWeek: (existing.config && existing.config.times_per_week) || "",
      weeks: (existing.config && existing.config.weeks) || "",
      // Launch-readiness audit item 4. submitChallengeForm's edit path used
      // to write `config` (built fresh from only the fields the CURRENT
      // form type shows) straight over the row's whole config column, so
      // any key not on that form - a future image_url, or simply a
      // property this ticket's own two managed types (coach, consistency)
      // do not both share - silently vanished on save. Kept here so submit
      // can merge onto it instead of replacing it outright; see there for
      // exactly which keys get overwritten vs. preserved.
      originalConfig: existing.config || {},
      teamNames: "", saving: false, error: "",
    } : {
      mode: "create", id: null, status: "draft", challengeType: "individual_target",
      title: "", description: "", metricType: "", targetValue: "", startAt: "", endAt: "",
      rulesText: "", metricLabel: "", timesPerWeek: "", weeks: "", teamNames: "", saving: false, error: "",
    };
    rerender();
  }
  function closeChallengeForm() { state.challenges.form = null; setFieldErrors("communityChallengeForm", {}); rerender(); }
  function setChallengeFormType(type) { if (state.challenges.form && state.challenges.form.mode !== "edit") { state.challenges.form.challengeType = type; rerender(); } }
  async function submitChallengeForm(form) {
    const f = state.challenges.form;
    if (!f || f.saving) return;
    const fd = new FormData(form);
    const title = String(fd.get("title") || "").trim();
    const description = String(fd.get("description") || "").trim();
    const metricType = String(fd.get("metricType") || "").trim();
    const targetRaw = String(fd.get("targetValue") || "").trim();
    const startAt = String(fd.get("startAt") || "");
    const endAt = String(fd.get("endAt") || "");
    const errors = {};
    if (title.length < 1 || title.length > 120) errors.title = "כותרת נדרשת, עד 120 תווים";
    if (description.length > 2000) errors.description = "עד 2000 תווים";
    if (!metricType || metricType.length > 60) errors.metricType = "שדה נדרש, עד 60 תווים";
    if (!startAt) errors.startAt = "יש לבחור תאריך התחלה";
    if (!endAt) errors.endAt = "יש לבחור תאריך סיום";
    if (startAt && endAt && !(new Date(endAt).getTime() > new Date(startAt).getTime())) errors.endAt = "תאריך הסיום חייב להיות אחרי ההתחלה";
    const config = {};
    let teamNames = [];
    if (f.challengeType === "coach") {
      const rulesText = String(fd.get("rulesText") || "").trim().slice(0, 1000);
      const metricLabel = String(fd.get("metricLabel") || "").trim();
      if (!rulesText) errors.rulesText = "יש לתאר את חוקי האתגר";
      config.rules_text = rulesText;
      if (metricLabel) config.metric_label = metricLabel;
    }
    if (f.challengeType === "consistency") {
      const timesPerWeek = Number(fd.get("timesPerWeek"));
      const weeks = Number(fd.get("weeks"));
      if (!Number.isInteger(timesPerWeek) || timesPerWeek < 1) errors.timesPerWeek = "מספר שלם חיובי נדרש";
      if (!Number.isInteger(weeks) || weeks < 1) errors.weeks = "מספר שלם חיובי נדרש";
      config.times_per_week = timesPerWeek;
      config.weeks = weeks;
    }
    if (f.challengeType === "team" && f.mode === "create") {
      teamNames = String(fd.get("teamNames") || "").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 20);
      if (teamNames.length < 2) errors.teamNames = "יש להזין לפחות שתי קבוצות";
    }
    if (Object.keys(errors).length) return setFieldErrors("communityChallengeForm", errors);
    setFieldErrors("communityChallengeForm", {});
    f.saving = true; f.error = ""; rerender();
    // Launch-readiness audit item 4. `config` above is built fresh every
    // submit from only the fields f.challengeType's form currently shows -
    // exactly right for `create` (there is no prior config to lose), but
    // an `edit` save used to write it straight over the row's whole config
    // column, silently dropping any key that form does not manage (a future
    // image_url, or any key this ticket's two managed types - coach,
    // consistency - do not both carry). This merges onto the challenge's
    // real config instead: start from what openChallengeForm actually read
    // off the row (f.originalConfig, the exact source the edit form's own
    // prefill already uses), clear only the keys THIS type's form is
    // authoritative for (so a field the member intentionally blanked out,
    // e.g. metricLabel, still clears rather than reverting to its old
    // value), then lay this submit's freshly-validated values back on top.
    // Type cannot change in edit mode (setChallengeFormType refuses once
    // f.mode === "edit"), so the "this type's own keys" set below always
    // matches the config the row was actually created with.
    let finalConfig = config;
    if (f.mode === "edit") {
      finalConfig = Object.assign({}, f.originalConfig || {});
      if (f.challengeType === "coach") { delete finalConfig.rules_text; delete finalConfig.metric_label; }
      if (f.challengeType === "consistency") { delete finalConfig.times_per_week; delete finalConfig.weeks; }
      Object.assign(finalConfig, config);
    }
    const payload = {
      title, description, metric_type: metricType,
      target_value: targetRaw ? Number(targetRaw) : null,
      start_at: new Date(startAt).toISOString(), end_at: new Date(endAt).toISOString(),
      visibility: "club", config: finalConfig,
    };
    let error;
    if (f.mode === "create") {
      payload.id = newFeedId();
      payload.challenge_type = f.challengeType;
      payload.created_by = state.user.id;
      payload.status = fd.get("publishNow") ? "active" : "draft";
      payload.join_mode = f.challengeType === "team" ? (fd.get("teamAuto") ? "auto" : "open") : "open";
      ({ error } = await client.from("challenges").insert(payload));
      if (!error && f.challengeType === "team" && teamNames.length) {
        await client.from("challenge_teams").insert(teamNames.map((name) => ({ id: newFeedId(), challenge_id: payload.id, name })));
      }
    } else {
      ({ error } = await client.from("challenges").update(payload).eq("id", f.id));
    }
    f.saving = false;
    if (error) { f.error = "לא ניתן היה לשמור את האתגר. נסו שוב."; return rerender(); }
    state.challenges.form = null;
    setMessage("האתגר נשמר");
    await loadChallenges();
    rerender();
  }
  // THE ONLY WAY TO END A CHALLENGE WAS BURIED INSIDE THE EDIT FORM.
  //
  // archiveChallenge() has existed since COMM-207, but its single call site
  // was one button inside renderChallengeForm(), reachable only by opening
  // the challenge, pressing "עריכה", and scrolling past every field to the
  // form's footer. A coach asking "how do I take this challenge down" had no
  // answer on any screen they were actually looking at, and there was no
  // delete at all - the RLS policy challenges_delete_perm (202608280009) has
  // always allowed one for a community.challenge.create holder, and no
  // client ever called it.
  //
  // Both now sit in the challenge's own staff toolbar, and they are
  // deliberately two separate actions rather than one:
  //   ARCHIVE keeps the challenge, its participants and every logged
  //     contribution, and moves it under "אתגרים שהסתיימו". This is what
  //     "the challenge is over" means and it is the one offered first.
  //   DELETE removes the row, and the three child tables cascade with it
  //     (challenge_teams, challenge_participants, challenge_progress - all
  //     `on delete cascade`, and challenge_teams_block_delete's own escape
  //     hatch exists precisely so a team challenge with members stays
  //     deletable). Nothing survives it, so its confirmation says so.
  // `wasDraft` only changes what the two messages call the thing. Deleting a
  // draft used to run a near-identical second function; one function with one
  // flag is one place to fix, which is the whole lesson of this codebase.
  async function deleteChallenge(id, wasDraft) {
    if (!hasPerm(PERM.CHALLENGE_CREATE)) return;
    const { error } = await client.from("challenges").delete().eq("id", id);
    if (error) return setMessage(failText(wasDraft ? "מחיקת הטיוטה נכשלה" : "מחיקת האתגר נכשלה", error));
    state.challenges.form = null;
    // The detail view is looking at a row that no longer exists; refreshing
    // it would render an error state over a deletion that succeeded. Closing
    // back to the list is the honest outcome.
    if (state.challenges.view && state.challenges.view.id === id) state.challenges.view = null;
    delete state.challenges.participation[id];
    delete state.challenges.aggregates[id];
    setMessage(wasDraft ? "הטיוטה נמחקה" : "האתגר נמחק");
    await loadChallenges();
    rerender();
  }
  async function archiveChallenge(id) {
    const { error } = await client.from("challenges").update({ status: "archived" }).eq("id", id);
    if (error) return setMessage(failText("הפעולה נכשלה", error));
    state.challenges.form = null;
    setMessage("האתגר הועבר לארכיון");
    await loadChallenges();
    if (state.challenges.view && state.challenges.view.id === id) await refreshChallengeView(id);
    rerender();
  }
  async function publishChallengeDraft(id) {
    const { error } = await client.from("challenges").update({ status: "active" }).eq("id", id);
    if (error) return setMessage(failText("הפעולה נכשלה", error));
    state.challenges.form = null;
    setMessage("האתגר פורסם");
    await loadChallenges();
    rerender();
  }
  // ---- Automatic progress from the product event bus (COMM-202, COMM-205) -
  // Sourced from the same non-attendance signals the achievement engine
  // reacts to (COMM-130/132), never from attendance. WORKOUT_COMPLETED has no
  // producer anywhere in this codebase yet - only PR_CREATED and the
  // ach_claim path fire in production today - so this consumer is wired and
  // ready but dormant until a workout-logging surface starts emitting it; a
  // test exercises it by emitting the event directly on the bus.
  function activeChallengeParticipations(types) {
    if (!state.user) return [];
    return state.challenges.items.filter((c) => c.status === "active" && types.indexOf(c.challenge_type) >= 0
      && state.challenges.participation[c.id] && state.challenges.participation[c.id].status === "active");
  }
  async function logAutoChallengeProgress(challengeId, delta, sourceType, consistencyKey) {
    if (!state.user || !delta) return;
    const { error } = await client.from("challenge_progress").insert({ challenge_id: challengeId, user_id: state.user.id, delta, source_type: sourceType || "auto" });
    if (!error) {
      await loadChallenges();
      if (state.challenges.view && state.challenges.view.id === challengeId) await refreshChallengeView(challengeId);
      rerender();
    } else if (consistencyKey) {
      // The caller sets _consistencyWeekLogged[key] optimistically before
      // this insert resolves (COMM-205's in-memory guard, needed to avoid
      // double-counting from a fire-and-forget call). A failed write must
      // not permanently burn that week's consistency credit with no retry -
      // roll the flag back so the next qualifying session tries again.
      delete state.challenges._consistencyWeekLogged[consistencyKey];
    }
  }
  // ISO 8601 week, e.g. "2026-W35" - the same week boundary the achievement
  // engine's week-streak metric already uses.
  function isoWeekKey(when) {
    const date = new Date(when || Date.now());
    const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNr = (target.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayNr + 3);
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const weekNr = 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
    return `${target.getUTCFullYear()}-W${String(weekNr).padStart(2, "0")}`;
  }
  // Launch-readiness audit item 2. The Monday-Sunday calendar-day bounds of
  // the same ISO week isoWeekKey() names, as plain "YYYY-MM-DD" strings -
  // what logConsistencyWeekHit() needs to scope a real attendance_log read
  // (a date column) and a challenge_progress dedupe read (a timestamptz
  // column, so `start`/`end` are widened to whole-day UTC bounds at the
  // call site) to "this week", the same week boundary the rest of this
  // cluster already uses.
  function isoWeekBounds(when) {
    const date = new Date(when || Date.now());
    const truncated = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNr = (truncated.getUTCDay() + 6) % 7;
    const monday = new Date(truncated); monday.setUTCDate(monday.getUTCDate() - dayNr);
    const sunday = new Date(monday); sunday.setUTCDate(sunday.getUTCDate() + 6);
    const fmt = (d) => d.toISOString().slice(0, 10);
    return { start: fmt(monday), end: fmt(sunday) };
  }
  function onWorkoutCompletedForChallenges() {
    if (!state.user) return;
    // individual_target: every logged session is one unit toward a
    // session-count target. Launch-readiness audit item 1 asked whether
    // this branch also needs a metric_type-vs-movement check like
    // onPrCreatedForChallenges got. Deliberately NOT added here: this
    // comment's own "every logged session is one unit" is the documented
    // intent of the type, i.e. movement-agnostic by design (a 12-sessions-
    // this-month target counts any session, not sessions of one specific
    // movement) - individual_performance is the type this app uses when a
    // challenge is about one specific metric/movement. Gating this branch on
    // metric_type would silently stop counting most real sessions against a
    // target that was never meant to be movement-scoped.
    for (const c of activeChallengeParticipations(["individual_target"])) {
      logAutoChallengeProgress(c.id, 1, "workout_completed");
    }
    // consistency: tally sessions per ISO week on this device and log one
    // "week hit" delta the first time this week crosses times_per_week -
    // never a second time for the same week on this device.
    const week = isoWeekKey();
    for (const c of activeChallengeParticipations(["consistency"])) {
      const key = c.id + ":" + week;
      state.challenges._consistencySessionCounts[key] = (state.challenges._consistencySessionCounts[key] || 0) + 1;
      const target = Number((c.config && c.config.times_per_week) || 0);
      if (target > 0 && state.challenges._consistencySessionCounts[key] >= target && !state.challenges._consistencyWeekLogged[key]) {
        state.challenges._consistencyWeekLogged[key] = true;
        logAutoChallengeProgress(c.id, 1, "workout_completed", key);
      }
    }
  }
  // Consumes the same PR_CREATED payload onPrCreated already reacts to. Only
  // a genuinely numeric result drives an individual_performance challenge -
  // a formatted display string like '140 ק״ג" is deliberately never parsed
  // here, so a malformed or unexpected payload silently no-ops instead of
  // writing a wrong progress delta.
  //
  // Launch-readiness audit item 1. This was dead code end to end: the real
  // (and only) producer, emitCommunityPrCreated() in app.js, never emitted
  // `new_result_value` or `new_value_numeric` - it only ever set
  // new_result/previous_result/improvement, all formatted display strings,
  // so `Number(value)` was NaN on every real PR and this path never fired.
  // Fixed at the source: emitCommunityPrCreated now also sets
  // `new_value_numeric` (the raw weight or estimated 1RM, before
  // formatting). `new_result_value` is kept as a fallback key only so a
  // differently-shaped future producer (or a test) is not forced to use
  // this exact name.
  //
  // metric_type match. challenges.metric_type is free text a coach typed
  // once (submitChallengeForm), independently of record.movement (a
  // movement display name from the exercise library) - the two are never
  // guaranteed to be drawn from the same list. Exact string equality is too
  // strict for two independently-typed free-text values (a trailing space
  // or one different letter would silently stop every future PR from
  // counting), so this normalizes to a trimmed, case-insensitive compare -
  // a sensible minimum bar. It deliberately stops there and does not go on
  // to fuzzy/partial matching (e.g. "squat" matching "back squat"): a
  // partial match risks crediting a challenge from the wrong movement
  // entirely, which is worse than a real PR occasionally not matching a
  // sloppily-typed metric_type. A coach who wants exact metric-type
  // matching needs to type it the same way (case aside) as the movement's
  // display name - a support-story tradeoff, not a hidden one.
  function challengeMetricMatchesMovement(metricType, movement) {
    const a = String(metricType || "").trim().toLowerCase();
    const b = String(movement || "").trim().toLowerCase();
    return !!a && !!b && a === b;
  }
  function onPrCreatedForChallenges(payload) {
    if (!state.user) return;
    const record = payload && (payload.record || payload);
    const value = record && (record.new_result_value != null ? record.new_result_value : record.new_value_numeric);
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    const movement = record && record.movement;
    for (const c of activeChallengeParticipations(["individual_performance"])) {
      if (!challengeMetricMatchesMovement(c.metric_type, movement)) continue;
      logAutoChallengeProgress(c.id, numeric, "pr_created");
    }
  }

  // ---- Rendering: list card (COMM-207) -------------------------------------
  function myChallengeCardProgressHtml(c) {
    const part = state.challenges.participation[c.id];
    if (!part) return "";
    if (c.challenge_type === "cooperative") {
      const agg = state.challenges.aggregates[c.id];
      if (!agg || agg.club_total == null) return "";
      const pct = c.target_value ? Math.round((agg.club_total / c.target_value) * 100) : null;
      return `<div class="mono" style="color:var(--brass);font-size:12px;">${esc(agg.club_total)}${c.target_value != null ? ` / ${esc(c.target_value)}` : ""}</div>${pct != null ? challengeProgressBarHtml(pct) : ""}`;
    }
    if (c.challenge_type === "team") {
      const agg = state.challenges.aggregates[c.id];
      const mine = agg && Array.isArray(agg.team_totals) ? agg.team_totals.find((t) => t.team_id === part.team_id) : null;
      return mine ? `<div class="mono" style="color:var(--brass);font-size:12px;">${esc(mine.name)}: ${esc(mine.total)}</div>` : (part.team_id ? "" : `<div style="color:var(--steel);font-size:12px;">טרם נבחרה קבוצה</div>`);
    }
    if (c.challenge_type === "consistency") {
      const weeks = Number((c.config && c.config.weeks) || 0);
      // Live bug hunt (2026-09-11): "0 / 1 שבועות" for a 1-week challenge -
      // missing singular, same class as TIER_LABELS' own "שיא אישי" ternary.
      return `<div class="mono" style="color:var(--brass);font-size:12px;">${esc(part.progress_value)}${weeks ? ` / ${weeks === 1 ? "שבוע אחד" : `${weeks} שבועות`}` : ""}</div>`;
    }
    const pct = c.target_value ? Math.round((Number(part.progress_value || 0) / c.target_value) * 100) : null;
    return `<div class="mono" style="color:var(--brass);font-size:12px;">${esc(part.progress_value)}${c.target_value != null ? ` / ${esc(c.target_value)}` : ""}</div>${pct != null ? challengeProgressBarHtml(pct) : ""}`;
  }
  function renderChallengeCard(c) {
    const def = challengeTypeDef(c.challenge_type);
    const part = state.challenges.participation[c.id];
    const agg = state.challenges.aggregates[c.id];
    const isPast = c.status === "completed" || c.status === "archived";
    const image = (c.config && c.config.image_url)
      ? `<img src="${esc(c.config.image_url)}" alt="" style="width:44px;height:44px;border-radius:12px;object-fit:cover;"/>`
      : `<span aria-hidden="true" style="width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;background:var(--border);">${def.icon}</span>`;
    const meta = [def.label, `${formatChallengeDate(c.start_at)}–${formatChallengeDate(c.end_at)}`];
    if (agg && agg.participant_count != null) meta.push(participantsLabel(agg.participant_count));
    if (c.status === "draft") meta.push(challengeStatusLabel(c));
    return `<article class="chart-card" data-challenge-id="${esc(c.id)}" data-challenge-status="${esc(c.status)}" style="margin-bottom:10px;">
      <div class="flex gap-10" style="align-items:flex-start;">
        ${image}
        <div style="flex:1;min-width:0;">
          <button class="link-btn" data-community-action="open-challenge" data-id="${esc(c.id)}" data-source="boards" style="padding:0;text-align:right;font-weight:800;font-size:15px;color:inherit;display:block;">${bidiText(c.title)}</button>
          <div style="color:var(--steel);font-size:11.5px;margin-top:2px;">${meta.map(esc).join(" · ")}</div>
          ${myChallengeCardProgressHtml(c)}
        </div>
      </div>
      <div class="chip-row" style="margin-top:8px;">
        <button class="chip-btn" data-community-action="open-challenge" data-id="${esc(c.id)}" data-source="boards">פרטים</button>
        ${!isPast && c.status === "active" && !part ? `<button class="chip-btn primary" data-community-action="join-challenge" data-id="${esc(c.id)}"${challengeJoinBusy[c.id] ? " disabled" : ""}>${challengeJoinBusy[c.id] ? "מצטרפ/ת…" : "הצטרפות"}</button>` : ""}
        ${!isPast && part ? `<span class="tag tag-brass">נרשמת</span>` : ""}
      </div>
    </article>`;
  }
  function renderChallengesListSection() {
    // COMM-321. RLS already makes challenges_read return nothing (including
    // a staff creator's own draft, per the migration's own OR-branch gate)
    // once this module is off - this keeps the shell/create-button from
    // showing beside an always-empty list.
    if (!isModuleEnabled("challenges")) return "";
    const staff = hasPerm(PERM.CHALLENGE_CREATE);
    const active = state.challenges.items.filter((c) => c.status === "active" || (staff && c.status === "draft"));
    const past = state.challenges.items.filter((c) => c.status === "completed" || c.status === "archived");
    const createBtn = staff ? `<button class="chip-btn primary" data-community-action="open-challenge-form" style="margin-bottom:10px;">אתגר חדש</button>` : "";
    const list = (state.challenges.loading && !state.challenges.loaded)
      ? `<div aria-busy="true">${`<div class="chart-card" style="height:64px;background:var(--border);opacity:.35;margin-bottom:10px;"></div>`.repeat(2)}</div>`
      : state.challenges.error
      ? `<div class="empty">לא ניתן היה לטעון את האתגר. נסו שוב.<div class="chip-row" style="justify-content:center;"><button class="chip-btn" data-community-action="challenges-retry">ניסיון חוזר</button></div></div>`
      : active.length ? active.map(renderChallengeCard).join("") : emptyStateHtml({
        key: "challenges-active",
        icon: "trophy",
        // AUDIENCE, which is the whole reason this one was left out of the
        // original eleven. renderChallengesListSection is NOT a coach-only
        // surface: it renders on the Boards sub-tab, which every member has,
        // and is then re-surfaced unchanged inside the coach dashboard. The
        // hesitation was sound - copy written at a coach ("open one") is
        // simply wrong for the member reading it, who cannot. The resolution
        // is that the headline and the explanation are written for the
        // MEMBER, who is both the larger audience and the one with no way to
        // act, and only slot 4 forks.
        headline: "אתגרי המועדון יופיעו כאן",
        body: "אתגר הוא יעד משותף לזמן קצוב — מספר אימונים בחודש, מרחק ריצה מצטבר, שיא בתרגיל — ומי שמצטרף רואה את ההתקדמות שלו לצד זו של כל המשתתפים.",
        // A when-line for BOTH audiences rather than an action, for two
        // different reasons. A member has no button that fills this space:
        // only staff can open a challenge, so a button here would be the
        // "door that goes nowhere" the pattern forbids. Staff DOES have one -
        // but "אתגר חדש" is already rendered immediately above this block
        // (createBtn), and the Member-of-the-Week state set the precedent
        // that an empty state points at a control already on screen instead
        // of opening a second door onto it.
        when: staff
          ? "הכפתור \"אתגר חדש\" שלמעלה פותח אתגר למועדון, ומרגע הפרסום הוא מופיע כאן לכל החברים."
          : "כשצוות המועדון יפתח אתגר חדש הוא יופיע כאן, ואפשר יהיה להצטרף אליו בלחיצה.",
      });
    const pastHtml = past.length ? `<div style="margin-top:16px;"><div class="field-label" style="margin-bottom:6px;">אתגרים שהסתיימו</div>${past.map(renderChallengeCard).join("")}</div>` : "";
    return `<div class="ach-section">${sectionHead("var(--energy)", "אתגרי המועדון")}${createBtn}${state.challenges.form ? renderChallengeForm() : ""}${list}${pastHtml}</div>`;
  }


  // ---- Rendering: create/edit form (COMM-201) ------------------------------
  function renderChallengeForm() {
    const f = state.challenges.form;
    const typePicker = `<div class="chip-row" role="group" aria-label="סוג אתגר" style="margin-bottom:10px;">${CHALLENGE_TYPES.map((t) => `<button type="button" class="chip-btn${f.challengeType === t.id ? " selected" : ""}" data-community-action="challenge-form-type" data-type="${t.id}"${f.mode === "edit" ? " disabled" : ""}>${t.icon} ${esc(t.label)}</button>`).join("")}</div>`;
    const typeFields = f.challengeType === "coach" ? `
        ${field("communityChallengeForm", "rulesText", "חוקי האתגר", `<textarea class="text-input" name="rulesText" maxlength="1000" required>${esc(f.rulesText)}</textarea>`)}
        ${field("communityChallengeForm", "metricLabel", "יחידת מדידה (לתצוגה)", `<input class="text-input" name="metricLabel" value="${esc(f.metricLabel)}" placeholder="למשל בורפיז"/>`)}`
      : f.challengeType === "consistency" ? `
        <div class="flex gap-16 field">
          ${field("communityChallengeForm", "timesPerWeek", "אימונים בשבוע", `<input class="text-input" name="timesPerWeek" type="number" min="1" value="${esc(f.timesPerWeek)}" required/>`)}
          ${field("communityChallengeForm", "weeks", "מספר שבועות", `<input class="text-input" name="weeks" type="number" min="1" value="${esc(f.weeks)}" required/>`)}
        </div>`
      : (f.challengeType === "team" && f.mode === "create") ? `
        ${field("communityChallengeForm", "teamNames", "שמות הקבוצות (שורה לכל קבוצה)", `<textarea class="text-input" name="teamNames" placeholder="קבוצת בוקר&#10;קבוצת ערב">${esc(f.teamNames)}</textarea>`)}
        <label class="field flex gap-6" style="align-items:center;"><input type="checkbox" name="teamAuto"/><span style="font-size:12.5px;color:var(--steel);">שיבוץ אוטומטי לקבוצה עם פחות משתתפים</span></label>`
      : "";
    const showTarget = f.challengeType !== "coach";
    return `<form id="communityChallengeForm" class="chart-card admin-card" style="margin-top:10px;">
      <div style="font-weight:800;margin-bottom:10px;">${f.mode === "edit" ? "עריכת אתגר" : "אתגר חדש"}<span class="admin-tag">ניהול</span></div>
      ${typePicker}
      ${field("communityChallengeForm", "title", "שם האתגר", `<input class="text-input" name="title" value="${esc(f.title)}" maxlength="120" required/>`)}
      ${field("communityChallengeForm", "description", "תיאור", `<textarea class="text-input" name="description" maxlength="2000">${esc(f.description)}</textarea>`)}
      ${field("communityChallengeForm", "metricType", "מדד", `<input class="text-input" name="metricType" value="${esc(f.metricType)}" placeholder="למשל session_count" required/>`)}
      ${showTarget ? field("communityChallengeForm", "targetValue", "יעד", `<input class="text-input" name="targetValue" type="number" step="any" value="${esc(f.targetValue)}"/>`) : ""}
      <div class="flex gap-16 field">
        ${dateField("communityChallengeForm", "startAt", "תאריך התחלה", `<input class="text-input" name="startAt" type="date" value="${esc(f.startAt)}" required/>`)}
        ${dateField("communityChallengeForm", "endAt", "תאריך סיום", `<input class="text-input" name="endAt" type="date" value="${esc(f.endAt)}" required/>`)}
      </div>
      ${typeFields}
      ${f.mode === "create" ? `<label class="field flex gap-6" style="align-items:center;"><input type="checkbox" name="publishNow"/><span style="font-size:12.5px;color:var(--steel);">פרסום מיידי (אחרת יישמר כטיוטה)</span></label>` : ""}
      ${f.error ? `<div class="field-error" role="alert">${esc(f.error)}</div>` : ""}
      <div class="chip-row" style="margin-top:10px;">
        <button class="chip-btn primary" type="submit"${f.saving ? " disabled" : ""}>${f.saving ? "שומר…" : "שמירה"}</button>
        <button class="chip-btn" type="button" data-community-action="challenge-form-cancel">ביטול</button>
        ${f.mode === "edit" && f.status === "draft" ? `<button class="chip-btn" type="button" data-community-action="challenge-publish" data-id="${esc(f.id)}">פרסום</button>` : ""}
        ${f.mode === "edit" && f.status === "draft" ? `<button class="chip-btn danger" type="button" data-community-action="challenge-delete-draft" data-id="${esc(f.id)}">מחיקת טיוטה</button>` : ""}
        ${f.mode === "edit" && (f.status === "active" || f.status === "completed") ? `<button class="chip-btn" type="button" data-community-action="challenge-archive" data-id="${esc(f.id)}">העברה לארכיון</button>` : ""}
      </div>
    </form>`;
  }

  // ---- Rendering: detail dialog (COMM-202..207) ----------------------------
  function renderChallengeActions(v) {
    const c = v.challenge;
    if (c.status === "completed" || c.status === "archived") return "";
    if (c.status === "draft") return `<div class="footer-note" style="margin-bottom:10px;">האתגר עדיין בטיוטה ואינו פתוח להצטרפות.</div>`;
    if (v.myParticipant) {
      return `<div class="chip-row" style="margin-bottom:10px;"><button class="chip-btn" data-community-action="leave-challenge" data-id="${esc(c.id)}"${v.leaving ? " disabled" : ""}>${v.leaving ? "עוזב/ת…" : "עזיבת האתגר"}</button></div>`;
    }
    return `<div class="chip-row" style="margin-bottom:10px;"><button class="chip-btn primary" data-community-action="join-challenge" data-id="${esc(c.id)}"${v.joining ? " disabled" : ""}>${v.joining ? "מצטרפ/ת…" : "הצטרפות לאתגר"}</button></div>`;
  }
  function renderChallengeLogForm(v) {
    const lf = v.logForm;
    return `<div class="chart-card" style="margin-bottom:10px;">
      <div class="field-label" style="margin-bottom:6px;">עדכון התקדמות</div>
      <div class="flex gap-10" style="align-items:flex-end;">
        <label class="field" style="flex:1;margin-bottom:0;"><span class="field-label">כמות</span><input class="text-input" type="number" step="any" data-challenge-log-delta value="${esc(lf.delta)}"/></label>
        <button class="chip-btn primary" data-community-action="challenge-log-submit"${lf.busy ? " disabled" : ""}>${lf.busy ? "שומר…" : "עדכון"}</button>
      </div>
      ${lf.error ? `<div class="field-error" role="alert" style="margin-top:6px;">${esc(lf.error)}</div>` : ""}
    </div>`;
  }
  function renderMyChallengeProgress(v) {
    const c = v.challenge, part = v.myParticipant;
    if (!part || c.challenge_type === "cooperative" || c.challenge_type === "team" || c.challenge_type === "consistency") return "";
    const completed = part.status === "completed";
    const pct = c.target_value ? (Number(part.progress_value || 0) / c.target_value) * 100 : null;
    return `<div class="chart-card" style="margin-bottom:10px;">
      <div class="field-label" style="margin-bottom:4px;">ההתקדמות שלי</div>
      ${part.progress_value ? `<div class="mono" style="color:var(--brass);font-size:16px;">${esc(part.progress_value)}${c.target_value != null ? ` / ${esc(c.target_value)}` : ""}</div>` : `<div class="empty">עדיין לא נרשמה התקדמות.</div>`}
      ${pct != null ? challengeProgressBarHtml(pct) : ""}
      ${completed ? `<div style="color:var(--brass);font-weight:800;margin-top:6px;">האתגר הושלם 🎉</div>` : ""}
    </div>${(!completed && c.challenge_type !== "coach") ? renderChallengeLogForm(v) : ""}`;
  }
  function renderCooperativePanel(v) {
    const c = v.challenge, p = v.progress || {};
    if (p.club_total == null) return `<div class="empty">לא ניתן היה לטעון את התקדמות האתגר.</div>`;
    const pct = c.target_value ? (p.club_total / c.target_value) * 100 : 0;
    const days = daysRemaining(c.end_at);
    const contributors = v.contributors || [];
    const contributorsHtml = contributors.length
      ? `<div class="log-list" style="margin-top:8px;">${contributors.map((row) => {
          const prof = row.profiles || {};
          const name = prof.display_name || (prof.handle ? "@" + prof.handle : "חבר/ה");
          return `<div class="log-row"><span>${esc(name)}</span><span class="mono" style="color:var(--brass);">+${esc(row.delta)}</span></div>`;
        }).join("")}</div>`
      : `<div class="empty">עדיין לא נאספה התקדמות משותפת.</div>`;
    return `<div class="chart-card" style="margin-bottom:10px;">
      <div class="field-label" style="margin-bottom:4px;">התקדמות המועדון</div>
      <div class="mono" style="color:var(--brass);font-size:18px;">${esc(p.club_total)}${c.target_value != null ? ` / ${esc(c.target_value)}` : ""}</div>
      ${challengeProgressBarHtml(pct)}
      <div style="color:var(--steel);font-size:12px;margin-top:4px;">${Math.round(Math.min(100, pct))}% מהיעד${days != null ? ` · ${daysRemainingLabel(days)}` : ""}</div>
      <div class="field-label" style="margin:10px 0 4px;">תורמים אחרונים</div>
      ${contributorsHtml}
    </div>${v.myParticipant ? renderChallengeLogForm(v) : ""}`;
  }
  // COMM-308. Loading skeleton for just the team-management block - not the
  // whole dialog, which already has its own ("טוען את האתגר…") for the very
  // first open. Shown only while refreshAfterTeamMgmt() is re-reading the
  // detail after a mutation this block itself made.
  function challengeTeamMgmtSkeletonHtml() {
    const row = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:60%;background:var(--border);border-radius:6px;display:inline-block;"></span><span style="height:12px;width:20%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
    return `<div class="chart-card" style="margin-bottom:10px;" data-team-mgmt="1">
      <div class="field-label" style="margin-bottom:6px;">ניהול קבוצות</div>
      <div class="log-list" aria-busy="true" data-team-mgmt-skeleton="1">${row.repeat(3)}</div>
    </div>`;
  }
  // COMM-308. A community.challenge.create holder's team-management block:
  // rename/delete each existing team, create a new one, set/clear a captain
  // per team, and reassign any active participant to another team (or to no
  // team at all). Entirely separate markup from the member-visible columns
  // renderTeamPanel already builds above - so a plain member's view (the
  // ONLY thing COMM-204 shipped) is untouched byte-for-byte, exactly what
  // this ticket's "a plain member's view is unchanged from COMM-204" line
  // asks for. Never called for a non-holder (renderTeamPanel gates the call).
  function renderTeamManagementPanel(v) {
    const tm = v.teamMgmt;
    if (tm.loading) return challengeTeamMgmtSkeletonHtml();
    const rawTeams = v.teams || [];
    const totalsByTeam = {};
    (Array.isArray(v.progress && v.progress.team_totals) ? v.progress.team_totals : []).forEach((t) => { totalsByTeam[t.team_id] = t.total; });
    const activeParticipants = (v.participants || []).filter((p) => p.status !== "withdrawn");
    const countByTeam = {};
    for (const p of activeParticipants) if (p.team_id) countByTeam[p.team_id] = (countByTeam[p.team_id] || 0) + 1;

    const teamRows = rawTeams.map((t) => {
      const memberCount = countByTeam[t.id] || 0;
      const total = totalsByTeam[t.id] != null ? totalsByTeam[t.id] : 0;
      const teamMembers = activeParticipants.filter((p) => p.team_id === t.id);
      const captain = t.captain_id ? teamMembers.find((p) => p.user_id === t.captain_id) : null;
      const captainProf = captain ? (captain.profiles || {}) : null;
      const captainName = captainProf ? (captainProf.display_name || (captainProf.handle ? "@" + captainProf.handle : "חבר/ה")) : null;
      const captainOptions = `<option value="">ללא קפטן/ית</option>` + teamMembers.map((p) => {
        const prof = p.profiles || {};
        const name = prof.display_name || (prof.handle ? "@" + prof.handle : "חבר/ה");
        return `<option value="${esc(p.user_id)}"${t.captain_id === p.user_id ? " selected" : ""}>${esc(name)}</option>`;
      }).join("");
      const renameBusy = !!tm.renameBusy[t.id], deleteBusy = !!tm.deleteBusy[t.id], captainBusy = !!tm.captainBusy[t.id];
      const nameValue = tm.renameDrafts[t.id] != null ? tm.renameDrafts[t.id] : t.name;
      return `<div class="log-row" style="flex-direction:column;align-items:stretch;gap:6px;" data-team-mgmt-row="${esc(t.id)}">
        <div class="flex gap-6" style="align-items:center;">
          <input class="text-input" type="text" data-challenge-team-rename-name="${esc(t.id)}" value="${esc(nameValue)}" maxlength="80" style="flex:1;" aria-label="שם הקבוצה"/>
          <button class="chip-btn" data-community-action="challenge-team-rename" data-id="${esc(t.id)}"${renameBusy ? " disabled" : ""}>${renameBusy ? "שומר…" : "שמירה"}</button>
          <button class="chip-btn" data-community-action="challenge-team-delete" data-id="${esc(t.id)}"${(deleteBusy || memberCount > 0) ? " disabled" : ""}${memberCount > 0 ? ` title="יש לפנות את הקבוצה מחברים לפני מחיקתה"` : ""}>${deleteBusy ? "מוחק…" : "מחיקה"}</button>
        </div>
        <div style="font-size:12px;color:var(--steel);">${participantsLabel(memberCount)} · ${esc(total)} סה״כ${captainName ? ` · 👑 ${esc(captainName)}` : ""}</div>
        <div class="flex gap-6" style="align-items:center;">
          <select class="text-input" data-challenge-team-captain-select="${esc(t.id)}" style="flex:1;"${(captainBusy || !teamMembers.length) ? " disabled" : ""} aria-label="קפטן/ית הקבוצה">${captainOptions}</select>
        </div>
      </div>`;
    }).join("");

    const reassignHtml = rawTeams.length ? `<div style="margin-top:10px;">
      <div class="field-label" style="margin-bottom:6px;">העברת משתתפים בין קבוצות</div>
      <div class="log-list">${activeParticipants.map((p) => {
        const prof = p.profiles || {};
        const name = prof.display_name || (prof.handle ? "@" + prof.handle : "חבר/ה");
        const busy = !!tm.reassignBusy[p.user_id];
        const options = `<option value="">ללא קבוצה</option>` + rawTeams.map((t) => `<option value="${esc(t.id)}"${p.team_id === t.id ? " selected" : ""}>${esc(t.name)}</option>`).join("");
        return `<div class="log-row" style="justify-content:space-between;gap:8px;">
          <span>${esc(name)}</span>
          <select class="text-input" data-challenge-team-reassign-select="${esc(p.user_id)}"${busy ? " disabled" : ""} style="max-width:160px;" aria-label="קבוצה של ${esc(name)}">${options}</select>
        </div>`;
      }).join("")}</div>
    </div>` : "";

    return `<div class="chart-card" style="margin-bottom:10px;" data-team-mgmt="1">
      <div class="field-label" style="margin-bottom:6px;">ניהול קבוצות<span class="admin-tag">ניהול</span></div>
      ${teamRows ? `<div class="log-list">${teamRows}</div>` : ""}
      <div class="flex gap-6" style="align-items:flex-end;margin-top:8px;">
        <label class="field" style="flex:1;margin-bottom:0;"><span class="field-label">קבוצה חדשה</span><input class="text-input" type="text" data-challenge-team-create-name value="${esc(tm.createName)}" maxlength="80"/></label>
        <button class="chip-btn primary" data-community-action="challenge-team-create"${tm.createBusy ? " disabled" : ""}>${tm.createBusy ? "יוצר…" : "צור קבוצה"}</button>
      </div>
      ${tm.createError ? `<div class="field-error" role="alert" style="margin-top:6px;">${esc(tm.createError)}</div>` : ""}
      ${tm.error ? `<div class="field-error" role="alert" style="margin-top:6px;">${esc(tm.error)}</div>` : ""}
      ${reassignHtml}
    </div>`;
  }
  function renderTeamPanel(v) {
    const c = v.challenge, p = v.progress || {};
    const teams = Array.isArray(p.team_totals) ? p.team_totals : [];
    const staff = hasPerm(PERM.CHALLENGE_CREATE);
    if (!teams.length) return `<div class="empty">המאמן/ת עדיין לא הגדיר/ה קבוצות.</div>${staff ? renderTeamManagementPanel(v) : ""}`;
    const myTeamId = v.myParticipant && v.myParticipant.team_id;
    const canPick = v.myParticipant && !myTeamId;
    const cols = teams.map((t) => `<div class="chart-card" style="flex:1;min-width:130px;${t.team_id === myTeamId ? "border-color:var(--energy);" : ""}">
        <div style="font-weight:800;font-size:13px;">${bidiText(t.name)}${t.team_id === myTeamId ? " · הקבוצה שלי" : ""}</div>
        <div class="mono" style="color:var(--brass);font-size:16px;margin-top:4px;">${esc(t.total)}</div>
        ${canPick ? `<button class="chip-btn" data-community-action="challenge-pick-team" data-id="${esc(c.id)}" data-team="${esc(t.team_id)}"${v.teamJoining === t.team_id ? " disabled" : ""} style="margin-top:6px;">${v.teamJoining === t.team_id ? "מצטרפ/ת…" : "הצטרפות לקבוצה"}</button>` : ""}
      </div>`).join("");
    return `<div class="flex gap-10" style="flex-wrap:wrap;margin-bottom:10px;">${cols}</div>${staff ? renderTeamManagementPanel(v) : ""}${(v.myParticipant && myTeamId) ? renderChallengeLogForm(v) : ""}`;
  }
  function renderConsistencyPanel(v) {
    const c = v.challenge, part = v.myParticipant;
    const weeks = Number((c.config && c.config.weeks) || 0);
    const timesPerWeek = Number((c.config && c.config.times_per_week) || 0);
    // Live bug hunt (2026-09-11): weeksLabel closes the same missing-singular
    // gap for both renderConsistencyPanel strings below ("X שבועות").
    const weeksLabel = weeks === 1 ? "שבוע אחד" : `${weeks} שבועות`;
    if (!part) return `<div style="color:var(--steel);font-size:12px;margin-bottom:10px;">${weeksLabel} · ${sessionsPerWeekLabel(timesPerWeek)}</div>`;
    const hit = Number(part.progress_value || 0);
    const boxes = Array.from({ length: weeks }, (_, i) => `<span aria-hidden="true" style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;margin:2px;font-size:11px;font-weight:800;${i < hit ? "background:var(--brass);color:#0c0c0c;" : "background:var(--border);color:var(--steel);"}">${i + 1}</span>`).join("");
    const emptyMsg = hit === 0 ? `<div class="empty">השבוע הראשון בעיצומו.</div>` : "";
    const completeMsg = part.status === "completed" ? `<div style="color:var(--brass);font-weight:800;margin-top:6px;">האתגר הושלם 🎉</div>` : "";
    return `<div class="chart-card" style="margin-bottom:10px;">
      <div class="field-label" style="margin-bottom:6px;">${hit} מתוך ${weeksLabel} · ${sessionsPerWeekLabel(timesPerWeek)}</div>
      <div>${boxes}</div>
      ${emptyMsg}${completeMsg}
      ${part.status !== "completed" ? `<button class="chip-btn" data-community-action="challenge-log-week-hit" style="margin-top:8px;"${v.consistencyCheck.busy ? " disabled" : ""}>${v.consistencyCheck.busy ? "בודק/ת נוכחות…" : "בדיקת נוכחות ועדכון השבוע"}</button>` : ""}
      ${v.consistencyCheck.error ? `<div class="field-error" role="alert" style="margin-top:6px;">${esc(v.consistencyCheck.error)}</div>` : ""}
    </div>`;
  }
  // COMM-211. This panel used to rank chal_progress()'s own simpler
  // `leaderboard` key (202608290003), which numbers rows by array index and
  // applies neither in_leaderboards nor a stable tie-break, and which drops
  // the caller entirely once they are past the twentieth row. It now reads
  // feed_leaderboard(mode='progress') instead - same panel, same slot, same
  // 20-row cap, but the server's rank, the server's privacy filtering and the
  // caller's own row always present. chal_progress's key is left untouched
  // (contracts.md calls widening it an additive follow-up, not a break); this
  // client just no longer reads it. In progress mode a caller who never
  // joined the challenge has no row at all, which is correct: there is no
  // standing in a challenge you did not enter.
  function renderChallengeLeaderboardPanel(v) {
    const b = v.board || { scope: "club", limit: CHALLENGE_BOARD_LIMIT, rows: [], loading: true, error: false };
    const body = renderLeaderboardBody(b, {
      limit: b.limit,
      emptyText: "עדיין אין תוצאות לדירוג.",
      retryAction: "challenge-board-retry",
      formatValue: (r) => esc(r.value),
    });
    const canExpand = !b.loading && !b.error && leaderboardRows(b).length && b.limit < CHALLENGE_BOARD_FULL_LIMIT;
    const expand = canExpand ? `<div class="chip-row" style="margin-top:6px;"><button class="chip-btn" data-community-action="challenge-board-full">צפייה בטבלה המלאה</button></div>` : "";
    return `<div class="chart-card" style="margin-bottom:10px;" data-leaderboard="challenge">
      <div class="field-label" style="margin-bottom:6px;">דירוג${b.limit >= CHALLENGE_BOARD_FULL_LIMIT ? " מלא" : ""}</div>
      ${leaderboardScopeSwitchHtml("challenge-board-scope", b.scope)}
      ${body}${expand}
      ${leaderboardHideToggleHtml()}
    </div>`;
  }
  function renderCoachEntryPanel(v) {
    const active = (v.participants || []).filter((p) => p.status === "active");
    const rosterHtml = active.length ? active.map((p) => {
      const prof = p.profiles || {};
      const name = prof.display_name || (prof.handle ? "@" + prof.handle : "חבר/ה");
      const d = v.coachEntry.drafts[p.user_id] || { delta: "", note: "" };
      const busy = !!v.coachEntry.busy[p.user_id];
      return `<div class="log-row" style="flex-direction:column;align-items:stretch;gap:6px;">
        <div class="flex" style="justify-content:space-between;"><span>${esc(name)}</span><span class="mono" style="color:var(--brass);">${esc(p.progress_value)}</span></div>
        <div class="flex gap-6">
          <input class="text-input" type="number" step="any" data-challenge-coach-delta="${esc(p.user_id)}" value="${esc(d.delta)}" placeholder="כמות" style="flex:1;"/>
          <button class="chip-btn primary" data-community-action="challenge-coach-submit" data-id="${esc(p.user_id)}"${busy ? " disabled" : ""}>${busy ? "שומר…" : "עדכון"}</button>
        </div>
      </div>`;
    }).join("") : `<div class="empty">אף אחד עדיין לא הצטרף לאתגר.</div>`;
    return `<div class="chart-card" style="margin-bottom:10px;">
      <div class="field-label" style="margin-bottom:6px;">עדכון התקדמות משתתפים</div>
      <div class="log-list">${rosterHtml}</div>
      ${v.coachEntry.error ? `<div class="field-error" role="alert" style="margin-top:6px;">${esc(v.coachEntry.error)}</div>` : ""}
    </div>`;
  }
  function renderChallengeParticipants(v) {
    // visible_to_club is honoured here for the same reason COMM-203 honours it
    // in the cooperative contributors list: a member who turned club visibility
    // off still COUNTS (the count below is the server's participant_count over
    // every row) but is never NAMED. The cooperative list got this filter and
    // this one — every other challenge type — did not, even though both select
    // the same visible_to_club column from the same query.
    const list = (v.participants || [])
      .filter((p) => p.status !== "withdrawn")
      .filter((p) => !(p.profiles && p.profiles.visible_to_club === false))
      .slice(0, 30);
    if (!list.length) return "";
    const count = (v.progress && v.progress.participant_count != null) ? v.progress.participant_count : list.length;
    return `<div style="margin-top:12px;">
      <div class="field-label" style="margin-bottom:6px;">משתתפים (${esc(count)})</div>
      <div class="log-list">${list.map((p) => {
        const prof = p.profiles || {};
        const name = prof.display_name || (prof.handle ? "@" + prof.handle : "חבר/ה");
        return `<div class="log-row"><span>${esc(name)}</span>${p.status === "completed" ? `<span class="tag tag-brass">הושלם</span>` : ""}</div>`;
      }).join("")}</div>
    </div>`;
  }
  function renderChallengeViewBody(v) {
    const c = v.challenge;
    const def = challengeTypeDef(c.challenge_type);
    const staff = hasPerm(PERM.CHALLENGE_CREATE);
    const meta = `<div style="color:var(--steel);font-size:12px;margin-bottom:10px;">${esc(def.label)} · ${formatChallengeDate(c.start_at)}–${formatChallengeDate(c.end_at)} · ${esc(challengeStatusLabel(c))}</div>`;
    const description = c.description ? `<div style="font-size:13.5px;line-height:1.6;margin-bottom:10px;white-space:pre-wrap;">${bidiText(c.description)}</div>` : "";
    const rules = (c.config && c.config.rules_text) ? `<div class="chart-card" style="margin-bottom:10px;"><div class="field-label" style="margin-bottom:4px;">חוקי האתגר</div><div style="font-size:13px;white-space:pre-wrap;">${bidiText(c.config.rules_text)}</div></div>` : "";
    // Real bug found by a role-coverage audit: content.pin covers challenges
    // (pinTargetLabel() has always listed "challenge"), but until now no
    // challenge surface offered a pin control - see isPinnedTarget()'s
    // comment. Gated separately from `staff` (CHALLENGE_CREATE, coach+):
    // CONTENT_PIN starts at head_coach, so a plain coach who can edit this
    // challenge still won't see a pin toggle, correctly.
    const pinBtn = hasPerm(PERM.CONTENT_PIN) ? `<button class="chip-btn" data-community-action="${isPinnedTarget("challenge", c.id) ? "unpin" : "pin"}" data-type="challenge" data-id="${esc(c.id)}" data-note="${esc(c.title)}">${isPinnedTarget("challenge", c.id) ? "ביטול הצמדה" : "הצמדה למעלה"}</button>` : "";
    // "סיום" is offered only while there is something to end - a draft was
    // never running and an already-archived challenge has nowhere to go -
    // but DELETE is offered for every status, including the draft that was
    // opened by mistake and the finished challenge nobody wants in the list.
    const canEnd = c.status === "active" || c.status === "completed";
    const endBtn = staff && canEnd ? `<button class="chip-btn" data-community-action="challenge-archive" data-id="${esc(c.id)}">סיום</button>` : "";
    const deleteBtn = staff ? `<button class="chip-btn danger" data-community-action="challenge-delete" data-id="${esc(c.id)}">מחיקה</button>` : "";
    // B2, and the numbers are measured, not estimated. Four chips - עריכה,
    // הצמדה למעלה, סיום, מחיקה - need 347px inside this dialog. At a 390px
    // viewport the row has 328px (390 less the overlay's 12px sides and the
    // card's 18px ones), so it wrapped 3 + 1 with מחיקה orphaned underneath,
    // reading as a layout accident. At the app's large text setting (zoom
    // 1.2) it is worse and differently worse: 410px needed against 316px, so
    // it broke 2 + 2 and put מחיקה directly beside סיום - delete-forever
    // adjacent to the one action that keeps every participant's progress.
    //
    // Shortening הצמדה למעלה was the tempting fix and the wrong one: that
    // string is shared with the post menu and the event toolbar, and changing
    // it here only is the drift this codebase is made of.
    //
    // So the break is made deliberate instead. The destructive action gets
    // its own row behind the same hairline the post menu uses to fence its
    // own destructive items - a pattern already in the app, not a new one
    // invented here. Measured after: 390px normal breaks 3 + 1 exactly as
    // before but now with a separator above it, and large text becomes three
    // lines rather than pairing סיום with מחיקה.
    const staffToolbar = (staff || pinBtn) ? `<div class="chip-row" style="margin-bottom:${deleteBtn ? "0" : "10px"};">${staff ? `<button class="chip-btn" data-community-action="challenge-edit" data-id="${esc(c.id)}">עריכה</button>` : ""}${pinBtn}${endBtn}</div>${deleteBtn ? `<div class="chip-row" style="margin-top:10px;margin-bottom:10px;padding-top:10px;border-top:1px solid var(--border);">${deleteBtn}</div>` : ""}` : "";
    const myProgress = renderMyChallengeProgress(v);
    const typePanel = c.challenge_type === "cooperative" ? renderCooperativePanel(v)
      : c.challenge_type === "team" ? renderTeamPanel(v)
      : c.challenge_type === "consistency" ? renderConsistencyPanel(v)
      : (c.challenge_type === "individual_performance" || c.challenge_type === "coach") ? renderChallengeLeaderboardPanel(v)
      : "";
    const coachPanel = (c.challenge_type === "coach" && staff) ? renderCoachEntryPanel(v) : "";
    const actions = renderChallengeActions(v);
    const shareBtn = v.myParticipant ? `<div class="chip-row" style="margin-top:8px;"><button class="chip-btn" data-community-action="share-challenge-progress"${v.sharing ? " disabled" : ""}>${v.sharing ? "משתף…" : "שיתוף התקדמות"}</button></div>` : "";
    const participantsHtml = renderChallengeParticipants(v);
    // Comments (COMM-207) reuse the engagement component, which threads off
    // a real post id - the milestone/share POST_CHALLENGE rows the trigger
    // and shareChallengeProgress() write. There is no dedicated companion
    // post created at challenge-creation time (unlike POST_EVENT for
    // events), so there is no single thread to open until one of those
    // exists; a pointer to the feed is what's shown instead. See the
    // handoff notes for the schema follow-up this needs.
    const commentsNote = `<div class="footer-note" style="margin-top:12px;">עדכונים ותגובות על האתגר מופיעים בפיד המועדון בכל שיתוף שקשור אליו.</div>`;
    return `${meta}${staffToolbar}${description}${rules}${actions}${myProgress}${typePanel}${coachPanel}${shareBtn}${participantsHtml}${commentsNote}`;
  }
  // THESE SIX DIALOGS ARE FLOATING CARDS, NOT BOTTOM SHEETS, and they were
  // pinned to the top of the screen.
  //
  // .modal-overlay defaults to align-items:flex-end - eleven dialogs in this
  // file are bottom sheets that slide up, flush to the bottom edge, with only
  // their top corners rounded. Six are not: challengeView, eventView,
  // recapView, profileView, notifCenter and clubWodBoard are cards with all
  // four corners rounded and a margin on every side, and each overrode the
  // default with the same copied `align-items:flex-start;padding:20px 12px`.
  //
  // flex-start pins a card to the TOP. Measured on a 390x844 phone, the
  // challenge detail rendered 349px tall at 20px from the top - leaving 475px
  // of empty overlay beneath it, more than half the screen, with the card and
  // its controls up by the status bar and away from the thumb. Reported as
  // "the challenge window is too high", which is exactly what it was.
  //
  // center, not flex-end: these are cards and should stay cards. Centering
  // costs nothing for tall content (max-height:88vh and overflow:auto still
  // do the work, and a card at 88vh is centered and top-anchored at once)
  // while short content - which is most of them - lands where the eye and
  // the thumb already are. All six move together; leaving five behind is how
  // this file got six copies of one style string in the first place.
  function renderChallengeViewOverlay() {
    const v = state.challenges.view;
    if (!v) return "";
    const bodyHtml = v.loading ? `<div class="empty">טוען את האתגר…</div>`
      : (v.error || !v.challenge) ? `<div class="empty">לא ניתן היה לטעון את האתגר. נסו שוב.</div>`
      : renderChallengeViewBody(v);
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="challengeViewTitle" data-cloud-dialog="challengeView" style="align-items:center;padding:20px 12px;">
      <div class="modal-sheet" style="border-radius:20px;max-height:88vh;overflow:auto;width:100%;max-width:560px;">
        <div style="padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 16px);">
          <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:12px;">
            <h2 id="challengeViewTitle" style="margin-top:0;font-weight:800;font-size:17px;margin-bottom:0;">${v.challenge ? bidiText(v.challenge.title) : "אתגר"}</h2>
            <button class="chip-btn" data-community-action="close-challenge-view" aria-label="סגירה">✕</button>
          </div>
          ${bodyHtml}
        </div>
      </div>
    </div>`;
  }
