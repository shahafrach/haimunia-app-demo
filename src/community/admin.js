"use strict";
// ---- Community: admin and moderation (COMM-150..156, COMM-310) ------------
//
// Everything a role gates: the moderation queue and its decisions, member
// restrictions and the panel that tells a restricted member what happened,
// reports, roles and coach grants, invite codes and person invites with their
// QR encoder, incomplete signups, the member roster, the audit log, the bug
// reports inbox, the two locked management panels, and the community
// analytics dashboard.
//
// Moved out of cloud.js unchanged — every line byte-identical to what it was
// there. Classic <script>, no IIFE, loaded before cloud.js; see
// src/community/events.js's header for why each of those matters.
//
// NOTHING IN THIS FILE IS A SECURITY BOUNDARY. Every control here is drawn
// from hasPerm() and every write goes through a security-definer RPC or an
// RLS-covered table; the policy is the authority and this decides what to
// render. A reviewer should read that as "a bug here shows the wrong button",
// not "a bug here grants access".
//
// The QR encoder is ~500 lines of pure algorithm with one caller
// (renderInviteQrPanel). It is here rather than in a module of its own
// because a join QR is an invite, and an invite is an admin action.
//
// WHAT STAYED BEHIND, deliberately:
//
//   The Manage tab shell — MANAGE_ADMIN_AREAS, manageArea, manageAdminArea,
//   renderManageAttention, renderManagePanel. It composes panels from this
//   module AND from src/community/club.js, and it sits beside
//   window.renderManageApp, which is what app.js calls. It is the tab's
//   shell, like renderCommunityApp, not an admin feature.
//
//   isStaff(), isAdmin(), isCoachTier(), hasPerm(), PERM and the permission
//   loader, which every module in the layer reads.

  // ==========================================================================
  // COMM-153, the member's own side of it.
  //
  // A posting restriction was enforced in the database and announced nowhere.
  // The only channel that ever told a restricted member anything was
  // serverErrorText's 'posting_restricted' entry, and that fires on a FAILED
  // WRITE - so a member learned they had been sanctioned by being refused,
  // and learned neither the reason nor the end date, because an error string
  // carries no row.
  //
  // The row was readable by them the whole time. posting_restrictions_read
  // (202608280015) grants SELECT on `user_id = auth.uid()`, and that
  // migration states the intent outright: "A member always sees their own
  // restrictions, because 'you cannot post until 3 March, reason X' is
  // information they are owed." The data was one query away and nothing ran
  // it.
  //
  // WHY EXPIRY IS FILTERED HERE AND NOT IN THE QUERY. The server's own
  // predicate is `lifted_at is null and (expires_at is null or expires_at >
  // now())`. That OR needs PostgREST's .or(), and the now() side would have to
  // be a device clock regardless. The migration's index comment already
  // describes this exact split - it indexes `lifted_at is null` alone because
  // "a now() comparison is not immutable and cannot go in the index
  // predicate, so expiry is filtered at read time against a much smaller
  // candidate set." This is that same split moved one tier out: the server
  // returns the unlifted candidates, the expiry comparison happens here.
  //
  // WHAT THIS DELIBERATELY IS NOT. It is not an enforcement path and nothing
  // branches on it except the panel's own markup. post_create and
  // add_post_comment go on raising 'posting_restricted' whatever this client
  // believes, so a device with a skewed clock can render a stale panel for a
  // few minutes and can never talk itself out of a restriction. Five
  // candidates because overlapping unlifted rows are possible (a permanent
  // one added over a temporary one that was never lifted) and the newest is
  // not automatically the one still in force.
  function activeRestrictionRow(rows) {
    const now = Date.now();
    return (Array.isArray(rows) ? rows : []).find((r) => {
      if (!r || r.lifted_at) return false;
      // The schema constrains the pair together (a permanent row never has an
      // expiry, a temporary one always does), so either half answering
      // "permanent" is enough and neither has to trust the other.
      if (r.restriction_type === "permanent" || !r.expires_at) return true;
      const t = new Date(r.expires_at).getTime();
      return !Number.isNaN(t) && t > now;
    }) || null;
  }
  async function loadMyRestriction() {
    if (!state.user) return;
    const s = state.myRestriction;
    s.loading = true;
    rerender();
    // Security hunt round 10: a direct table read (this used to be
    // client.from("posting_restrictions").select(the-safe-columns)) only
    // ever hid moderator_id/lifted_by/source_report_id/lift_reason at the
    // CLIENT'S request - RLS is row-level, not column-level, so the same
    // session's own devtools could ask for those columns anyway and get
    // them, deanonymizing which staff member acted. my_posting_restrictions()
    // is a SECURITY DEFINER function that returns exactly this safe column
    // set server-side, so there is nothing left to ask for beyond it.
    const { data, error } = await client.rpc("my_posting_restrictions");
    s.loading = false;
    // `loaded` is set even on failure, deliberately. The lazy gate in
    // afterRenderCommunity fires on `!loaded && !loading`, and this function
    // ends in a rerender() - so leaving loaded false to "retry next render"
    // would be an unbroken load/render loop, not a retry. Same choice
    // loadMonthlyRecap makes, for the same mechanical reason.
    s.loaded = true;
    // A failed load clears the row rather than stranding a stale one: the
    // panel is a statement about the member's current standing, and a card
    // left over from a previous session is worse than no card.
    s.row = error ? null : activeRestrictionRow(data);
    rerender();
  }

  const MOD_QUEUE_STATUSES = [
    { id: "open", label: "פתוח" },
    { id: "reviewing", label: "בטיפול" },
    { id: "action_taken", label: "טופל" },
    { id: "dismissed", label: "נדחה" },
    { id: "all", label: "הכול" },
  ];
  const MOD_STATUS_LABEL = { open: "פתוח", reviewing: "בטיפול", action_taken: "טופל", dismissed: "נדחה" };
  // Launch-readiness audit, CQ-001. 202609050002_report_profile_target.sql
  // widened reports.target_type to include 'profile', but the queue row and
  // context overlay still used a two-way post/comment ternary, so a profile
  // report fell into the else branch and was labelled "פוסט" (post) - with
  // the reported member's own bio shown as the "post excerpt". Same shape as
  // pinTargetLabel()/auditTargetLabel() further down.
  const MOD_TARGET_LABEL = { post: "פוסט", comment: "תגובה", profile: "פרופיל" };
  // Reason codes match the report() RPC contract. inappropriate covers
  // "inappropriate content", privacy covers "privacy concern",
  // unsafe_advice covers "unsafe training advice".
  const REPORT_REASONS = [
    { id: "harassment", label: "הטרדה" },
    { id: "spam", label: "ספאם" },
    { id: "inappropriate", label: "תוכן לא הולם" },
    { id: "privacy", label: "פגיעה בפרטיות" },
    { id: "unsafe_advice", label: "המלצת אימון מסוכנת" },
    { id: "other", label: "אחר" },
  ];
  function reportReasonLabel(code) { const r = REPORT_REASONS.find((x) => x.id === code); return r ? r.label : (code || ""); }
  // mod_queue() returns a null author name for content whose author is gone.
  // One constant for the three surfaces that render it (queue row, context
  // overlay, action sheet) so a report and the dialog acting on it cannot
  // describe the same missing member differently.
  const MOD_UNKNOWN_AUTHOR_TEXT = "חבר/ה שהוסר/ה";
  // The five queue decisions. restrict_temp carries a duration; the rest
  // do not. Every one is passed straight to mod_review().
  //
  // Five-persona UX audit, defect 2. `effect` is the sentence the sheet shows
  // under the title, and it NAMES THE MEMBER: "הגבלת פרסום קבועה" on its own
  // told an admin what button they pressed and nothing about who it lands on,
  // in a queue where every row looks alike. {subject} is the placeholder
  // subjectSentenceHtml() fills with a bidi-isolated name - see
  // CONFIRM_SUBJECT_TOKEN. The label stays the button/title text.
  const MOD_DECISIONS = [
    { id: "remove", label: "הסרת התוכן", destructive: true, effect: "התוכן שפרסמ/ה {subject} יוסר מהפיד." },
    { id: "warn", label: "אזהרה לחבר/ה", effect: "אזהרה תירשם ל{subject}." },
    { id: "restrict_temp", label: "הגבלת פרסום זמנית", effect: "{subject} לא יוכל/תוכל לפרסם בקהילה עד תום התקופה שנבחרה." },
    { id: "restrict_permanent", label: "הגבלת פרסום קבועה", destructive: true, effect: "{subject} לא יוכל/תוכל לפרסם בקהילה יותר. ההגבלה נשארת עד שמנהל/ת מסיר/ה אותה." },
    { id: "dismiss", label: "דחיית הדיווח", effect: "הדיווח על {subject} ייסגר ללא פעולה." },
  ];
  const RESTRICT_TEMP_DAYS = [3, 7, 14, 30];

  // Read via mod_queue(), an admin-only path: the function checks
  // community.comment.moderate or real is_admin and only it can resolve the
  // reporter identities, which stay invisible to everyone else.
  // ACTIVE POSTING RESTRICTIONS, AND THE ONE CONTROL THAT ENDS THEM.
  //
  // mod_restrict_member() has been reachable since COMM-153 - a moderator
  // decides restrict_temp / restrict_permanent on a report and the member
  // stops being able to post. mod_lift_restriction() shipped in the same
  // migration and had NO client surface at all: it appeared in this file only
  // inside a comment. So the app could impose a sanction and had no way to
  // remove one. A permanent restriction was, in practice, permanent - the
  // only exit was somebody running SQL against production.
  //
  // That got worse rather than better when the member-facing panel landed:
  // the member can now read exactly why they are silenced, and for how long,
  // with no route back. A sanction a product cannot lift is not moderation,
  // it is an accident that lasts forever.
  //
  // No migration needed - posting_restrictions_read (202608280015:71) already
  // lets a holder of community.member.restrict or community.comment.moderate
  // read every row; only the UI was missing.
  async function loadRestrictions() {
    if (!state.user || state.admin.restrictionsLoading) return;
    if (!(hasPerm(PERM.MEMBER_RESTRICT) || hasPerm(PERM.COMMENT_MODERATE) || isAdmin())) { state.admin.restrictions = []; return; }
    state.admin.restrictionsLoading = true; state.admin.restrictionsError = false; rerender();
    const { data, error } = await client
      .from("posting_restrictions")
      .select("id,user_id,restriction_type,reason,expires_at,created_at")
      .is("lifted_at", null)
      .order("created_at", { ascending: false })
      .limit(50);
    state.admin.restrictionsLoading = false;
    state.admin.restrictionsLoaded = true;
    if (error) { state.admin.restrictionsError = true; state.admin.restrictions = []; rerender(); return; }
    // Names in a SECOND read rather than an embedded join. A restriction row
    // is the authoritative thing here; a missing display name must degrade to
    // "חבר/ה" rather than lose the row, and a join makes the whole read fail
    // together. Cheap: at most one extra request, only for ids actually
    // restricted, and only for staff.
    const ids = [...new Set((data || []).map((r) => r.user_id).filter(Boolean))];
    let names = {};
    if (ids.length) {
      const { data: profs } = await mgmtDb().from("profiles").select("id,handle,display_name").in("id", ids);
      for (const pr of (profs || [])) names[pr.id] = pr.display_name || pr.handle || "";
    }
    for (const r of (data || [])) r.member_name = names[r.user_id] || "";
    // An EXPIRED temporary restriction is no longer in force - is_posting_restricted()
    // filters on expires_at at read time - so it must not be listed as something
    // to lift, or staff would be lifting sanctions that already ended.
    const now = Date.now();
    state.admin.restrictions = (data || []).filter((r) => !r.expires_at || new Date(r.expires_at).getTime() > now);
    rerender();
  }
  async function liftRestriction(id) {
    if (!id || state.admin.restrictionLifting) return;
    state.admin.restrictionLifting = id; rerender();
    const { error } = await mgmtDb().rpc("mod_lift_restriction", { p_restriction_id: id, p_reason: "" });
    state.admin.restrictionLifting = "";
    if (error) { setMessage(serverErrorText(error)); rerender(); return; }
    setMessage("ההגבלה בוטלה");
    await loadRestrictions();
  }
  async function loadModQueue() {
    if (!state.user || !(hasPerm(PERM.COMMENT_MODERATE) || isAdmin())) { state.admin.modQueue = []; return; }
    state.admin.modQueueLoading = true; state.admin.modQueueError = false; rerender();
    const { data, error } = await mgmtDb().rpc("mod_queue", { p_status: state.admin.modQueueStatus, p_cursor: null, p_limit: 50 });
    state.admin.modQueueLoading = false;
    state.admin.modQueueLoaded = true;
    if (error) { state.admin.modQueueError = true; state.admin.modQueue = []; rerender(); return; }
    state.admin.modQueue = data || [];
    rerender();
  }
  function setModQueueStatus(status) {
    if (!MOD_QUEUE_STATUSES.some((s) => s.id === status) || state.admin.modQueueStatus === status) return;
    state.admin.modQueueStatus = status;
    loadModQueue();
  }
  function openModContext(reportId) {
    const item = (state.admin.modQueue || []).find((r) => r.report_id === reportId);
    if (!item) return;
    state.admin.modContext = item;
    rerender();
  }
  function closeModContext() { state.admin.modContext = null; rerender(); }
  function openModAction(reportId, decision) {
    const item = (state.admin.modQueue || []).find((r) => r.report_id === reportId);
    if (!item || !MOD_DECISIONS.some((d) => d.id === decision)) return;
    // subjectName is carried on the action rather than re-read from the queue
    // at render time: the queue reloads underneath an open sheet, and the
    // name in the confirmation must stay the one the admin clicked.
    state.admin.modAction = { reportId, decision, note: "", days: 7, saving: false, error: "", targetType: item.target_type, subjectName: item.content_author_name || "" };
    rerender();
  }
  function closeModAction() { state.admin.modAction = null; rerender(); }
  // Launch-readiness audit, CQ-002 (defensive second layer). The row
  // renderer already filters "remove" off a profile report's button list;
  // this is the fallback if that ever drifts, or if mod_review() adds a
  // future refusal - so the message names the real reason instead of
  // suggesting a retry that can never succeed.
  function modActionErrorText(error) {
    const msg = error && error.message;
    return {
      "a profile report has no content to remove": "אין תוכן להסרה בדיווח על פרופיל.",
    }[msg] || "לא ניתן היה להשלים את הפעולה. נסו שוב.";
  }
  async function runModAction() {
    const a = state.admin.modAction;
    if (!a || a.saving) return;
    a.saving = true; a.error = ""; rerender();
    const args = { p_report_id: a.reportId, p_decision: a.decision, p_note: String(a.note || "").slice(0, 500) };
    // Only a temporary restriction carries an end time; mod_review ignores
    // p_expires_at for every other decision.
    if (a.decision === "restrict_temp") args.p_expires_at = new Date(Date.now() + a.days * 86400000).toISOString();
    const { error } = await mgmtDb().rpc("mod_review", args);
    if (error) {
      a.saving = false;
      a.error = modActionErrorText(error);
      rerender();
      return;
    }
    state.admin.modAction = null;
    // The card carried a post that was removed - drop it from the feed too.
    if (a.decision === "remove" && a.targetType === "post") {
      const it = (state.admin.modQueue || []).find((r) => r.report_id === a.reportId);
      if (it && Array.isArray(state.feed.items)) state.feed.items = state.feed.items.filter((p) => p && p.id !== it.target_id);
    }
    setMessage("הפעולה נרשמה");
    await loadModQueue();
    await loadRestrictions();
  }
  // ---- Five-persona UX audit, defect 3. Reclaiming a ghost's invite ------
  //
  // THE CONFIRMATION NAMES ITS SUBJECT. A standing finding of this audit is
  // that no confirmation in this app says what it is about to act on:
  // askConfirm()'s message is a fixed sentence and renderConfirmSheet()
  // escapes it as plain text, so it structurally cannot carry a name that
  // mixes Latin and Hebrew without breaking bidi anyway. This is a dedicated
  // sheet on renderModActionSheet's model - which is already where an
  // optional note field lives - and the first thing inside it is WHO.
  function openGhostReclaim(userId) {
    // Second layer, not the only one: ghostRowHtml already withholds the
    // control from a non-admin, admin_reclaim_invite checks a real
    // profiles.is_admin server-side, and this is the fallback if a future
    // change ever renders the button more widely than it should.
    if (!isAdmin()) return;
    const item = (state.admin.incompleteSignups.items || []).find((r) => r.user_id === userId);
    if (!item) return;
    state.admin.reclaim = { userId, item, note: "", saving: false, error: "" };
    rerender();
  }
  function closeGhostReclaim() { state.admin.reclaim = null; rerender(); }
  // admin_reclaim_invite raises four named errors, and every one of them
  // means the admin is looking at a different situation than they think - so
  // each gets its own sentence naming the real reason and, where there is
  // one, the thing to do instead. NONE of them offers a retry: a generic
  // "try again" would be a lie for all four, because not one can ever
  // succeed on a second identical call.
  function ghostReclaimErrorText(error) {
    const msg = error && error.message;
    return {
      "member has a profile": "לחשבון הזה כבר יש פרופיל - זה חבר/ה במועדון ולא הרשמה שלא הושלמה. להסרה יש להשתמש בניהול חברים.",
      "signup is still in progress": `ההרשמה עדיין בתהליך. אפשר לשחרר הזמנה רק אחרי ${GHOST_GRACE_DAYS} ימים ללא השלמה, כדי לא לקחת קוד ממי שנמצא באמצע ההרשמה ברגע זה.`,
      "no invite to reclaim": "אין כאן הזמנה לשחרר. ייתכן שהיא כבר שוחררה - שווה לרענן את הרשימה.",
      "cannot reclaim your own invite": "אי אפשר לשחרר את ההזמנה של עצמך.",
      "target account required": "לא נבחר חשבון לשחרור.",
      "not authorized": "שחרור הזמנה שמור למנהל/ת.",
    }[msg] || "לא ניתן היה לשחרר את ההזמנה. נסו שוב.";
  }
  async function runGhostReclaim() {
    const a = state.admin.reclaim;
    if (!a || a.saving) return;
    a.saving = true; a.error = ""; rerender();
    const { data, error } = await mgmtDb().rpc("admin_reclaim_invite", {
      p_user_id: a.userId,
      // Capped at 500 like mod_review's note, and sent as null rather than an
      // empty string so the audit row carries "no reason given" instead of a
      // reason that is the empty string.
      p_note: String(a.note || "").slice(0, 500) || null,
    });
    if (error) {
      a.saving = false;
      a.error = ghostReclaimErrorText(error);
      rerender();
      return;
    }
    const result = data || {};
    // The name is carried over from the row rather than re-read: the reclaim
    // has just deleted this account's invite_redemptions row, which is the
    // row admin_incomplete_signups INNER JOINs on, so the reload below will
    // not return it and there would be nothing left to name it by.
    state.admin.reclaimResult = {
      name: ghostDisplayName(a.item),
      invite_source: result.invite_source || a.item.invite_source,
      welcome_posts_retracted: Number(result.welcome_posts_retracted || 0),
      purgeable: !!result.purgeable_by_purge_abandoned_profiles,
    };
    state.admin.reclaim = null;
    await loadIncompleteSignups(true);
  }
  // Admin-only member lookup/management - was previously only possible
  // through the Supabase SQL editor. Search by handle/name or paste an
  // exact user id; role changes and removal each check real is_admin
  // server-side too (admin_grant_coach/admin_revoke_coach/
  // admin_remove_member), this is only for deciding what to show.
  // Debounced for the same reason as searchPeople() (PERF-3): this fired an
  // admin_search_members RPC plus a full re-render on every keystroke.
  async function searchMembers(query) {
    state.members.search = query;
    if (memberSearchDebounceTimer) clearTimeout(memberSearchDebounceTimer);
    const q = String(query || "").trim();
    if (q.length < 2) { state.members.results = []; return rerender(); }
    memberSearchDebounceTimer = setTimeout(async () => {
      memberSearchDebounceTimer = null;
      const { data, error } = await mgmtDb().rpc("admin_search_members", { p_query: q });
      state.members.results = error ? [] : (data || []);
      rerender();
    }, SEARCH_DEBOUNCE_MS);
  }
  // COMM-156. HEAD_COACH is exposed in Phase 1; STAFF and OWNER are modelled
  // server-side but stay out of this list until Phase 2. A role change goes
  // through the same is_admin-gated promotion path, which writes an
  // admin_actions row of type role_change. The bare coach grant keeps the
  // original single-argument call so nothing that already drives it breaks;
  // head_coach passes p_role through.
  const GRANTABLE_ROLES = [
    { id: "member", label: "חבר/ה" },
    { id: "coach", label: "מאמן/ת" },
    { id: "head_coach", label: "מאמן/ת ראשי/ת" },
  ];
  function roleCodeLabel(code) { const r = GRANTABLE_ROLES.find((x) => x.id === code); return r ? r.label : code; }
  // BOTH SURFACES SHOW THE SAME ROW, SO BOTH HAVE TO BE RE-READ.
  //
  // renderMemberManagement()'s search panel and renderMemberRoster() render
  // the identical row through the identical template (memberManagementRowHtml),
  // and every control on that row - grant coach, promote, demote, revoke,
  // remove - was refreshing only the SEARCH half. The search half is
  // admin-only and starts empty until somebody types two characters into it,
  // so acting from the roster, which is the browsable list and the one a head
  // coach has at all, left the row you just changed sitting there unchanged.
  // Reported as "after giving coach permission, it's not changing": the RPC
  // had succeeded every time and the screen was showing a stale read.
  //
  // adminRemoveMember was given the roster reload when the remove control
  // moved onto the roster (202609160005) and the other three were not, which
  // is the same one-of-N fix this codebase keeps producing. One helper now,
  // so there is no fourth place to forget.
  //
  // The roster reload is skipped when nothing has loaded it, so an admin
  // working purely from search still pays for one round trip, not two.
  async function refreshMemberSurfaces() {
    await searchMembers(state.members.search);
    if (state.admin.roster.loaded) await loadRoster(true);
  }
  async function adminGrantCoach(userId) {
    if (!state.user || !isAdmin()) return;
    const { error } = await mgmtDb().rpc("admin_grant_coach", { p_user_id: userId });
    if (error) return setMessage(failText("הענקת ההרשאה נכשלה", error));
    setMessage("הרשאת מאמן/ת הוענקה");
    await refreshMemberSurfaces();
  }
  async function adminSetRole(userId, roleCode) {
    if (!state.user || !isAdmin()) return;
    if (roleCode === "member") return adminRevokeCoach(userId);
    if (roleCode === "coach") return adminGrantCoach(userId);
    if (roleCode !== "head_coach") return;
    const { error } = await mgmtDb().rpc("admin_grant_coach", { p_user_id: userId, p_role: "head_coach" });
    if (error) return setMessage(failText("שינוי ההרשאה נכשל", error));
    setMessage("ההרשאה עודכנה ל" + roleCodeLabel(roleCode));
    await refreshMemberSurfaces();
  }
  // Five-persona UX audit, defect 1. Granting coach asked "are you sure?";
  // revoking the same permission fired on a single click, from a list, with
  // no dialog at all - the destructive direction was the UNGUARDED one. This
  // is the one dialog definition for it, shared by the dedicated revoke
  // control and by admin-set-role's "member" branch (the other route into
  // the same RPC), so the two cannot diverge again. It is also marked
  // destructive: true, which grant deliberately is not.
  function askRevokeCoachConfirm(userId) {
    askConfirm({
      title: "ביטול הרשאת מאמן/ת",
      message: "להסיר הרשאת מאמן/ת מ{subject}? הגישה לכלי המאמנים ולניהול הקהילה תיפסק מיד.",
      subject: subjectNameFor(userId),
      confirmLabel: "ביטול ההרשאה",
      destructive: true,
      action: "admin-revoke-coach",
      payload: { userId },
    });
  }
  async function adminRevokeCoach(userId) {
    if (!state.user || !isAdmin()) return;
    const { error } = await mgmtDb().rpc("admin_revoke_coach", { p_user_id: userId });
    if (error) return setMessage(failText("ביטול ההרשאה נכשל", error));
    setMessage("הרשאת מאמן/ת בוטלה");
    await refreshMemberSurfaces();
  }
  // ---- COMM-376. Invite and code management -----------------------------
  // Two independent panels, gated on the two different permissions COMM-
  // 370/371 set up server-side (contracts.md's own "Needs from schema,
  // registration and invite management" section is the ground truth for
  // every signature below - COMM-376's own ticket text still names the
  // pre-hardening (p_code, p_role) shapes, which never shipped). A coach who
  // holds community.member.invite but not community.invite.manage_codes
  // sees the per-person panel only, matching that permission split exactly.
  function inviteCodeCreateErrorText(error) {
    const msg = error && error.message;
    return {
      "not authorized": "אין הרשאה ליצור קוד הצטרפות.",
      "invalid role": "תפקיד לא תקין.",
      "shared codes cannot grant coach": "קוד משותף לא יכול להעניק הרשאת מאמן/ת.",
      "max uses must be between 1 and 1000": "מספר השימושים חייב להיות בין 1 ל-1000.",
      "expiry must be in the future": "תאריך התפוגה חייב להיות בעתיד.",
    }[msg] || "יצירת הקוד נכשלה, נסו שוב.";
  }
  async function loadInviteCodes() {
    if (!state.user || !(hasPerm(PERM.INVITE_MANAGE_CODES) || isAdmin())) { state.admin.inviteCodes.items = []; return; }
    const ic = state.admin.inviteCodes;
    ic.loading = true; ic.error = false; rerender();
    const { data, error } = await mgmtDb().rpc("admin_invite_code_list");
    ic.loading = false; ic.loaded = true;
    if (error) { ic.error = true; rerender(); return; }
    ic.items = Array.isArray(data) ? data : [];
    rerender();
  }
  async function createInviteCode(form) {
    if (!state.user || !(hasPerm(PERM.INVITE_MANAGE_CODES) || isAdmin())) return;
    const maxUsesRaw = String((form.elements.maxUses && form.elements.maxUses.value) || "").trim();
    const expiresRaw = String((form.elements.expiresAt && form.elements.expiresAt.value) || "").trim();
    const errors = {};
    let maxUses = 100;
    if (maxUsesRaw) {
      maxUses = Number(maxUsesRaw);
      if (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > 1000) errors.maxUses = "מספר שימושים חייב להיות בין 1 ל-1000";
    }
    let expiresAtIso = null;
    if (expiresRaw) {
      const d = new Date(expiresRaw);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) errors.expiresAt = "תאריך התפוגה חייב להיות בעתיד";
      else expiresAtIso = d.toISOString();
    }
    if (Object.keys(errors).length) return setFieldErrors("communityInviteCodeCreate", errors);
    setFieldErrors("communityInviteCodeCreate", {});
    // p_role is always "member" - admin_invite_code_create refuses a coach
    // role unconditionally (COMM-371's own DEVIATION note: a shared code
    // with role='coach' would be permanently unredeemable, since
    // redeem_invite_code's shared branch never grants anything but member),
    // so there is no role selector here at all, not even for an admin.
    const { data, error } = await mgmtDb().rpc("admin_invite_code_create", { p_role: "member", p_expires_at: expiresAtIso, p_max_uses: maxUses });
    if (error) return setMessage(inviteCodeCreateErrorText(error));
    form.reset();
    state.admin.inviteCodes.created = data;
    // Forced open, not left to whatever it happened to be: the reveal
    // renders inside this same disclosure (see its own comment above), and
    // a coach who has to be somewhere else the instant the plaintext code
    // exists is exactly the "risk losing a credential that's never shown
    // again" case this fix closes.
    state.admin.openAreas[SHARED_CODE_DISCLOSURE_ID] = true;
    // The one moment the plaintext code exists in the mgmtDb(). Build the QR
    // now or never - admin_invite_code_list() below returns everything about
    // this row EXCEPT the code itself.
    openInviteQr(data && data.code, "shared");
    setMessage("קוד ההצטרפות נוצר");
    await loadInviteCodes();
  }
  async function setInviteCodeActive(codeId, active) {
    if (!state.user || !(hasPerm(PERM.INVITE_MANAGE_CODES) || isAdmin()) || state.admin.inviteCodes.busy) return;
    state.admin.inviteCodes.busy = codeId; rerender();
    const { error } = await mgmtDb().rpc("admin_invite_code_set_active", { p_code_id: codeId, p_active: active });
    state.admin.inviteCodes.busy = null;
    if (error) { setMessage(failText("עדכון הסטטוס נכשל", error)); rerender(); return; }
    await loadInviteCodes();
  }
  // Dismissing the reveal card and dismissing the QR are the same act - "the
  // plaintext code is off my screen now" - so either control performs both.
  // Leaving one of the two behind would have been a control that claims to
  // hide a credential and only hides half of it.
  function dismissInviteCodeCreated() { state.admin.inviteCodes.created = null; closeInviteQr(); }
  // WHY THE CONFIRMATION IS ON THE BUTTON AND NOT IN A MESSAGE BAR.
  // These handlers called setMessage(), and state.ui.message IS rendered -
  // once, at the TOP of the Community tab, just under the sub-tab bar. That
  // is the whole problem: it is nowhere near the control that was pressed.
  // Every copy button lives deep inside the Manage tab's invite panels, well
  // below the fold, so the confirmation painted somewhere the staff member
  // had already scrolled past and could not see. The feedback existed and was
  // invisible, which to the person tapping is the same as no feedback at all -
  // reported as "I don't know if I copied the text".
  //
  // A top-of-screen notice is right for something about the SCREEN ("could
  // not load the community"). It is wrong for the result of pressing one
  // button among several, which is a fact about that button.
  //
  // Feedback belongs ON the control that was pressed. copiedToken names WHAT
  // was copied, so the right button confirms even with several on screen, and
  // it clears itself so a stale "הועתק" can never be read as a fresh one. The
  // failure path stays a message: "ההעתקה נכשלה" has to say what to do
  // instead, and that does not fit on a chip.
  function markCopied(token) {
    state.ui.copiedToken = token;
    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      if (state.ui.copiedToken === token) { state.ui.copiedToken = ""; rerender(); }
    }, 2600);
    rerender();
  }
  function copyLabel(token, idle) { return state.ui.copiedToken === token ? "הועתק ✓" : idle; }
  function copyInviteCode(code) {
    if (!code) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(() => markCopied(code)).catch(() => setMessage("ההעתקה נכשלה, אפשר להעתיק ידנית"));
    } else {
      setMessage("ההעתקה נכשלה, אפשר להעתיק ידנית");
    }
  }
  const INVITE_STATUS_FILTERS = [
    { id: "all", label: "הכול" }, { id: "pending", label: "ממתין" }, { id: "redeemed", label: "מומש" },
    { id: "revoked", label: "בוטל" }, { id: "expired", label: "פג תוקף" },
  ];
  function inviteStatusLabel(s) { return { pending: "ממתין", redeemed: "מומש", revoked: "בוטל", expired: "פג תוקף" }[s] || s; }
  // A personal invite has no member behind it yet, so the only thing that can
  // identify it in a confirmation is the label the admin typed when creating
  // it ("שם המוזמן/ת" is literally what the field asks for). Single source,
  // shared with the row renderer, so the list and the dialog cannot describe
  // the same unlabelled invite two different ways.
  const INVITE_UNLABELLED_TEXT = "(ללא תווית)";
  function inviteSubjectName(inviteId) {
    const inv = (state.admin.invites.items || []).find((i) => i && i.id === inviteId);
    return (inv && inv.label) || INVITE_UNLABELLED_TEXT;
  }
  async function loadInvites(reset) {
    if (!state.user || !(hasPerm(PERM.MEMBER_INVITE) || isAdmin())) { state.admin.invites.items = []; return; }
    const iv = state.admin.invites;
    if (reset) { iv.items = []; iv.cursor = null; iv.cursorId = null; iv.end = false; iv.loading = true; } else { iv.loadingMore = true; }
    iv.error = false; rerender();
    const { data, error } = await mgmtDb().rpc("admin_invite_list", { p_status: iv.status, p_cursor: iv.cursor, p_cursor_id: iv.cursorId || null, p_limit: 25 });
    iv.loading = false; iv.loadingMore = false; iv.loaded = true;
    if (error) { iv.error = true; rerender(); return; }
    const page = Array.isArray(data) ? data : [];
    iv.items = reset ? page : iv.items.concat(page);
    iv.end = page.length < 25;
    const last = page[page.length - 1];
    // This list had no tie-break in its ORDER BY at all before 202609160002,
    // so its page boundary was not even deterministic between two calls.
    if (last) { iv.cursor = last.created_at; iv.cursorId = last.id || null; }
    rerender();
  }
  function setInviteStatusFilter(status) {
    if (!INVITE_STATUS_FILTERS.some((s) => s.id === status) || state.admin.invites.status === status) return;
    state.admin.invites.status = status;
    loadInvites(true);
  }
  function inviteCreateErrorText(error) {
    const msg = error && error.message;
    return {
      "not authorized": "אין הרשאה ליצור הזמנה מסוג זה.",
      "invalid role": "תפקיד לא תקין.",
      "label too long": "התווית ארוכה מדי (עד 120 תווים).",
      "expiry must be in the future": "תאריך התפוגה חייב להיות בעתיד.",
      "could not generate a unique invite code": "יצירת הקוד נכשלה, נסו שוב.",
    }[msg] || "יצירת ההזמנה נכשלה, נסו שוב.";
  }
  async function createInvite(form) {
    if (!state.user || !(hasPerm(PERM.MEMBER_INVITE) || isAdmin())) return;
    const roleInput = form.querySelector('input[name="role"]:checked');
    const role = roleInput ? roleInput.value : "member";
    const label = String((form.elements.label && form.elements.label.value) || "").trim().slice(0, 120);
    const expiresRaw = String((form.elements.expiresAt && form.elements.expiresAt.value) || "").trim();
    const errors = {};
    if (role !== "member" && role !== "coach") errors.label = "תפקיד לא תקין";
    // COMM-376's own mandate: a coach never even sees the coach radio (see
    // renderPersonInvitesPanel), but the server is the real boundary
    // (admin_invite_create's 202609030008 narrowing) - this is a defensive
    // second check in case that ever drifts, not the enforcement itself.
    if (role === "coach" && !isAdmin()) errors.label = "רק מנהל/ת יכול/ה ליצור הזמנת מאמן/ת";
    let expiresAtIso = null;
    if (expiresRaw) {
      const d = new Date(expiresRaw);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) errors.expiresAt = "תאריך התפוגה חייב להיות בעתיד";
      else expiresAtIso = d.toISOString();
    }
    if (Object.keys(errors).length) return setFieldErrors("communityInviteCreate", errors);
    setFieldErrors("communityInviteCreate", {});
    const { data, error } = await mgmtDb().rpc("admin_invite_create", { p_role: role, p_label: label || null, p_expires_at: expiresAtIso });
    if (error) return setFieldErrors("communityInviteCreate", { label: inviteCreateErrorText(error) });
    form.reset();
    state.admin.invites.created = data;
    // Same one-shot reveal as the shared code above, same reason.
    openInviteQr(data && data.code, "person");
    setMessage("ההזמנה נוצרה");
    await loadInvites(true);
  }
  // Same pairing as dismissInviteCodeCreated() above.
  function dismissInviteCreated() { state.admin.invites.created = null; closeInviteQr(); }
  async function revokeInvite(inviteId) {
    if (!state.user || !(hasPerm(PERM.MEMBER_INVITE) || isAdmin()) || state.admin.invites.revoking) return;
    state.admin.invites.revoking = inviteId; rerender();
    const { error } = await mgmtDb().rpc("admin_invite_revoke", { p_invite_id: inviteId });
    state.admin.invites.revoking = null;
    if (error) {
      setMessage(error.message === "already redeemed" ? "לא ניתן לבטל הזמנה שכבר מומשה" : "ביטול ההזמנה נכשל");
      rerender();
      return;
    }
    setMessage("ההזמנה בוטלה");
    await loadInvites(true);
  }
  function renderSharedCodesPanel() {
    if (!(hasPerm(PERM.INVITE_MANAGE_CODES) || isAdmin())) return "";
    const ic = state.admin.inviteCodes;
    const createdHtml = ic.created ? `<div class="chart-card" style="margin-bottom:10px;border:1px solid var(--brass);" data-invite-code-created="1">
      <div class="field-label" style="margin-bottom:4px;">הקוד נוצר - זו הפעם היחידה שהוא יוצג</div>
      <div class="flex gap-10" style="align-items:center;flex-wrap:wrap;">
        <code class="mono" style="font-size:15px;">${esc(ic.created.code)}</code>
        <button class="chip-btn" data-community-action="copy-invite-code" data-code="${esc(ic.created.code)}">${copyLabel(ic.created.code, "העתקה")}</button>
        <button class="chip-btn" data-community-action="reopen-invite-qr" data-code="${esc(ic.created.code)}" data-kind="shared">קוד QR</button>
        <button class="link-btn" data-community-action="dismiss-invite-code-created">סגירה</button>
      </div>
    </div>` : "";
    const form = `<form id="communityInviteCodeCreate" class="chart-card" style="margin-bottom:10px;">
      <div class="field-label" style="margin-bottom:6px;">קוד הצטרפות משותף חדש</div>
      ${field("communityInviteCodeCreate", "maxUses", "מקסימום שימושים", `<input class="text-input" name="maxUses" type="number" min="1" max="1000" placeholder="100"/>`)}
      ${dateField("communityInviteCodeCreate", "expiresAt", "תפוגה (רשות)", `<input class="text-input" name="expiresAt" type="date"/>`)}
      <button class="chip-btn primary" type="submit" style="margin-top:6px;">יצירת קוד</button>
    </form>`;
    let list;
    if (ic.loading && !ic.items.length) {
      const skRow = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:55%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
      list = `<div class="log-list" aria-busy="true" data-invite-codes-skeleton="1">${skRow.repeat(2)}</div>`;
    } else if (ic.error) {
      // A RETRY, like the person-invites panel seventy lines below on the
      // same screen. Live bug hunt, fresh round 7 (2026-09-15):
      // loadInviteCodes() sets loaded = true even on failure and the tab's
      // lazy-load guard only checks !loaded, so switching away and back never
      // retried either - one failed request left an admin permanently stuck
      // until a full app reload, while the sibling panel recovered in a tap.
      list = `<div class="empty">לא ניתן היה לטעון את הקודים.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="invite-codes-retry">ניסיון חוזר</button></div></div>`;
    } else if (!ic.items.length) {
      list = `<div class="empty">אין קודי הצטרפות משותפים עדיין</div>`;
    } else {
      // Live bug hunt (2026-09-11): admin_invite_code_create/set_active never
      // auto-deactivate a code on exhaustion or expiry - deactivation is a
      // separate, manual action, and `active` stays true regardless. This
      // badge used to print only off that raw boolean, so a code at its own
      // use-count cap, or one whose expires_at is already in the past,
      // still read "פעיל" indistinguishably from a genuinely usable one -
      // confirmed live, no on-screen cue either way. The person-invite
      // panel next to this one already shows a real "פג תוקף" (it comes
      // straight off that RPC's own computed status field); shared codes
      // have no such field, so it's derived here from the same raw
      // use_count/max_uses/expires_at this row already displays as text.
      list = `<div class="log-list">${ic.items.map((c) => {
        const exhausted = c.max_uses != null && Number(c.use_count || 0) >= Number(c.max_uses);
        const expired = !!c.expires_at && new Date(c.expires_at).getTime() <= Date.now();
        const statusLabel = !c.active ? "כבוי" : exhausted ? "נוצל" : expired ? "פג תוקף" : "פעיל";
        const statusDim = !c.active || exhausted || expired;
        return `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:6px;" data-invite-code-id="${esc(c.id)}">
        <div class="flex" style="justify-content:space-between;width:100%;">
          <span>${roleCodeLabel(c.role)} · נוצר ${esc(shortHebDate(c.created_at))}</span>
          <span class="admin-tag" style="${statusDim ? "opacity:.6;" : ""}">${statusLabel}</span>
        </div>
        <div style="color:var(--steel);font-size:12px;">${Number(c.redemption_count || 0)} מימושים · שימושים ${Number(c.use_count || 0)}${c.max_uses ? "/" + esc(c.max_uses) : ""}${c.expires_at ? " · תפוגה " + esc(shortHebDate(c.expires_at)) : ""}</div>
        <button class="chip-btn"${ic.busy ? " disabled" : ""} data-community-action="invite-code-toggle-active" data-id="${esc(c.id)}" data-active="${c.active ? "0" : "1"}">${c.active ? "כיבוי" : "הפעלה"}</button>
      </div>`;
      }).join("")}</div>`;
    }
    return `<div data-invite-codes-panel="1">
      <div class="field-label" style="margin:4px 0 8px;">קודי הצטרפות משותפים</div>
      <div class="footer-note" style="margin-bottom:8px;">כיבוי קוד לא משפיע על מי שכבר הצטרף/ה דרכו - הוא רק מפסיק להתקבל בהצטרפויות חדשות.</div>
      ${createdHtml}${form}${list}
    </div>`;
  }
  function renderPersonInvitesPanel() {
    if (!(hasPerm(PERM.MEMBER_INVITE) || isAdmin())) return "";
    const iv = state.admin.invites;
    const admin = isAdmin();
    const createdHtml = iv.created ? `<div class="chart-card" style="margin-bottom:10px;border:1px solid var(--brass);" data-invite-created="1">
      <div class="field-label" style="margin-bottom:4px;">ההזמנה נוצרה - זו הפעם היחידה שהקוד יוצג</div>
      <div class="flex gap-10" style="align-items:center;flex-wrap:wrap;">
        <code class="mono" style="font-size:15px;">${esc(iv.created.code)}</code>
        <button class="chip-btn" data-community-action="copy-invite-code" data-code="${esc(iv.created.code)}">${copyLabel(iv.created.code, "העתקה")}</button>
        <button class="chip-btn" data-community-action="reopen-invite-qr" data-code="${esc(iv.created.code)}" data-kind="person">קוד QR</button>
        <button class="link-btn" data-community-action="dismiss-invite-created">סגירה</button>
      </div>
    </div>` : "";
    const form = `<form id="communityInviteCreate" class="chart-card" style="margin-bottom:10px;">
      <div class="field-label" style="margin-bottom:6px;">הזמנה אישית חדשה</div>
      <div class="chip-row" style="margin-bottom:6px;">
        <label class="flex gap-6" style="align-items:center;"><input type="radio" name="role" value="member" checked/> חבר/ה</label>
        ${admin ? `<label class="flex gap-6" style="align-items:center;"><input type="radio" name="role" value="coach"/> מאמן/ת</label>` : `<span class="footer-note">הזמנת מאמן/ת זמינה רק למנהל/ת</span>`}
      </div>
      ${field("communityInviteCreate", "label", "תווית (רשות)", `<input class="text-input" name="label" maxlength="120" placeholder="למשל: שם המוזמן/ת"/>`)}
      ${dateField("communityInviteCreate", "expiresAt", "תפוגה (רשות)", `<input class="text-input" name="expiresAt" type="date"/>`)}
      <button class="chip-btn primary" type="submit" style="margin-top:6px;">יצירת הזמנה</button>
    </form>`;
    const filters = `<div class="chip-row" style="margin:0 0 10px;">${INVITE_STATUS_FILTERS.map((s) => `<button class="chip-btn${iv.status === s.id ? " selected" : ""}" data-community-action="invite-status-filter" data-status="${s.id}">${s.label}</button>`).join("")}</div>`;
    const rowHtml = (inv) => `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:4px;" data-invite-id="${esc(inv.id)}">
      <div class="flex" style="justify-content:space-between;width:100%;">
        <span>${bidiText(inv.label || INVITE_UNLABELLED_TEXT)} · ${roleCodeLabel(inv.role)}</span>
        <span class="admin-tag">${inviteStatusLabel(inv.status)}</span>
      </div>
      <div style="color:var(--steel);font-size:12px;">נוצר ${esc(shortHebDate(inv.created_at))}${inv.expires_at ? " · תפוגה " + esc(shortHebDate(inv.expires_at)) : ""}</div>
      ${inv.status === "redeemed" ? `<div style="color:var(--steel);font-size:12px;">מומש/ה ע"י ${esc(inv.redeemed_by_display_name || inv.redeemed_by_handle || "חבר/ה")} · ${esc(shortHebDate(inv.redeemed_at))}</div>` : ""}
      ${inv.status === "pending" ? `<button class="chip-btn danger"${iv.revoking === inv.id ? " disabled" : ""} data-community-action="invite-revoke" data-id="${esc(inv.id)}">ביטול</button>` : ""}
    </div>`;
    let list;
    if (iv.loading && !iv.items.length) {
      const skRow = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:55%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
      list = `<div class="log-list" aria-busy="true" data-person-invites-skeleton="1">${skRow.repeat(3)}</div>`;
    // `&& !iv.items.length`: a failure while paging must not erase the rows
    // already on screen. Live bug hunt, fresh round 7 (2026-09-15) - the same
    // error flag serves the first load and every "load more", so one blip on
    // page three replaced three pages of loaded invites with an error box.
    // renderDirectorySection() has carried this guard since COMM-377 and its
    // own comment explains why; these three paginated siblings never got it.
    } else if (iv.error && !iv.items.length) {
      list = `<div class="empty">לא ניתן היה לטעון את ההזמנות.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="invite-list-retry">ניסיון חוזר</button></div></div>`;
    } else if (!iv.items.length) {
      list = `<div class="empty">עדיין לא נוצרו הזמנות אישיות</div>`;
    } else {
      list = `<div class="log-list">${iv.items.map(rowHtml).join("")}</div>${iv.end ? "" : `<div class="chip-row" style="justify-content:center;margin-top:8px;"><button class="chip-btn" data-community-action="invite-list-more"${iv.loadingMore ? " disabled" : ""}>${iv.loadingMore ? "טוען…" : "טעינת עוד"}</button></div>`}`;
    }
    return `<div data-person-invites-panel="1" style="margin-top:14px;">
      <div class="field-label" style="margin:4px 0 8px;">הזמנות אישיות</div>
      ${createdHtml}${form}${filters}${list}
    </div>`;
  }

  // Per version, at error-correction level M:
  // [total codewords, EC codewords per block, group-1 blocks, group-1 data
  //  codewords, group-2 blocks, group-2 data codewords].
  // Versions 1-12 only: version 12 holds 290 data codewords, which is far
  // more than any origin + 128-character code can reach, and every row costs
  // six numbers. qrEncode() returns null rather than guessing past the table.
  const QR_M_BLOCKS = {
    1: [26, 10, 1, 16, 0, 0],
    2: [44, 16, 1, 28, 0, 0],
    3: [70, 26, 1, 44, 0, 0],
    4: [100, 18, 2, 32, 0, 0],
    5: [134, 24, 2, 43, 0, 0],
    6: [172, 16, 4, 27, 0, 0],
    7: [196, 18, 4, 31, 0, 0],
    8: [242, 22, 2, 38, 2, 39],
    9: [292, 22, 3, 36, 2, 37],
    10: [346, 26, 4, 43, 1, 44],
    11: [404, 30, 1, 50, 4, 51],
    12: [466, 22, 6, 36, 2, 37],
  };
  // Alignment-pattern centre coordinates per version (row and column alike).
  const QR_ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    11: [6, 30, 54], 12: [6, 32, 58],
  };
  const QR_MAX_VERSION = 12;

  // GF(256) with the QR primitive polynomial 0x11D. Computed once rather than
  // written out as two 256-entry literals.
  const QR_EXP = new Uint8Array(512);
  const QR_LOG = new Uint8Array(256);

  function qrMul(a, b) { return (a && b) ? QR_EXP[QR_LOG[a] + QR_LOG[b]] : 0; }
  // The Reed-Solomon generator polynomial of the given degree, highest power
  // first: the product of (x - alpha^i) for i in 0..deg-1.
  function qrGenPoly(deg) {
    let poly = [1];
    for (let i = 0; i < deg; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= qrMul(poly[j], QR_EXP[i]);
      }
      poly = next;
    }
    return poly;
  }
  function qrEcBytes(data, ecLen) {
    const gen = qrGenPoly(ecLen);
    const res = new Array(data.length + ecLen).fill(0);
    for (let i = 0; i < data.length; i++) res[i] = data[i];
    for (let i = 0; i < data.length; i++) {
      const factor = res[i];
      if (!factor) continue;
      for (let j = 0; j < gen.length; j++) res[i + j] ^= qrMul(gen[j], factor);
    }
    return res.slice(data.length);
  }
  function qrDataCodewordCount(version) {
    const b = QR_M_BLOCKS[version];
    return b[2] * b[3] + b[4] * b[5];
  }
  function qrPickVersion(byteLen) {
    for (let v = 1; v <= QR_MAX_VERSION; v++) {
      // 4 mode bits + the character count (8 bits below version 10, 16 from
      // version 10 up) + the payload itself.
      if (4 + (v < 10 ? 8 : 16) + byteLen * 8 <= qrDataCodewordCount(v) * 8) return v;
    }
    return 0;
  }
  function qrCodewords(bytes, version) {
    const bits = [];
    const push = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1); };
    push(4, 4); // byte mode
    push(bytes.length, version < 10 ? 8 : 16);
    for (let i = 0; i < bytes.length; i++) push(bytes[i], 8);
    const totalBits = qrDataCodewordCount(version) * 8;
    for (let i = 0; i < 4 && bits.length < totalBits; i++) bits.push(0); // terminator
    while (bits.length % 8) bits.push(0);
    const words = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      words.push(b);
    }
    // The two alternating pad codewords the spec names, 0b11101100 / 0b00010001.
    const pads = [0xec, 0x11];
    for (let i = 0; words.length < totalBits / 8; i++) words.push(pads[i % 2]);
    return words;
  }
  // Split into blocks, parity each block, then interleave: one codeword from
  // every block in turn, data first and then parity. Interleaving is what
  // makes a QR survive a coffee ring - a physical smudge lands across many
  // blocks a little rather than one block fatally.
  function qrInterleave(words, version) {
    const spec = QR_M_BLOCKS[version];
    const ecLen = spec[1];
    const blocks = [];
    let at = 0;
    for (let i = 0; i < spec[2]; i++) { blocks.push(words.slice(at, at + spec[3])); at += spec[3]; }
    for (let i = 0; i < spec[4]; i++) { blocks.push(words.slice(at, at + spec[5])); at += spec[5]; }
    const parity = blocks.map((b) => qrEcBytes(b, ecLen));
    const out = [];
    const maxData = Math.max(spec[3], spec[5]);
    for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < ecLen; i++) for (const b of parity) out.push(b[i]);
    return out;
  }
  // Format information: 2 bits of EC level (M is 0b00) + 3 mask bits, through
  // BCH(15,5) with generator 0x537, XORed with the spec's 0x5412 so an
  // all-zero format is never all-zero on the symbol.
  function qrFormatBits(mask) {
    const data = mask; // (0b00 << 3) | mask
    let d = data << 10;
    for (let i = 14; i >= 10; i--) if (d & (1 << i)) d ^= 0x537 << (i - 10);
    return ((data << 10) | d) ^ 0x5412;
  }
  // Version information, carried only from version 7 up: 6 bits through
  // BCH(18,6) with generator 0x1F25, no mask.
  function qrVersionBits(version) {
    let d = version << 12;
    for (let i = 17; i >= 12; i--) if (d & (1 << i)) d ^= 0x1f25 << (i - 12);
    return (version << 12) | d;
  }
  // Everything that is not data: the three finders and their separators, the
  // two timing lines, the alignment patterns, the dark module, and the
  // reserved (not yet written) format and version areas. `fixed` marks every
  // module the data zigzag must skip.
  function qrSkeleton(version) {
    const size = version * 4 + 17;
    const mod = [];
    const fixed = [];
    for (let r = 0; r < size; r++) { mod.push(new Uint8Array(size)); fixed.push(new Uint8Array(size)); }
    const set = (r, c, v) => { if (r >= 0 && c >= 0 && r < size && c < size) { mod[r][c] = v; fixed[r][c] = 1; } };
    for (const corner of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const dark = r >= 0 && r <= 6 && c >= 0 && c <= 6
            && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
          set(corner[0] + r, corner[1] + c, dark ? 1 : 0);
        }
      }
    }
    for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0 ? 1 : 0); set(i, 6, i % 2 === 0 ? 1 : 0); }
    const centres = QR_ALIGN[version];
    for (const r of centres) {
      for (const c of centres) {
        // The three corners already carry finder patterns.
        if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) === 1 ? 0 : 1);
          }
        }
      }
    }
    set(size - 8, 8, 1); // the always-dark module
    // Reserve the format areas. Index 6 is skipped in both arms: that is the
    // timing pattern passing through, not a format module.
    for (let i = 0; i <= 8; i++) { if (i !== 6) { set(8, i, 0); set(i, 8, 0); } }
    for (let i = 0; i < 8; i++) { set(8, size - 1 - i, 0); set(size - 1 - i, 8, 0); }
    set(size - 8, 8, 1);
    if (version >= 7) {
      for (let i = 0; i < 18; i++) {
        set(Math.floor(i / 3), size - 11 + (i % 3), 0);
        set(size - 11 + (i % 3), Math.floor(i / 3), 0);
      }
    }
    return { size: size, mod: mod, fixed: fixed };
  }
  // The zigzag: two-module-wide columns walked right to left, alternating
  // upward and downward, skipping the vertical timing column entirely.
  function qrPlaceData(sk, codewords) {
    let bitIndex = 0;
    const nextBit = () => {
      const byte = codewords[bitIndex >> 3];
      const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1;
      bitIndex++;
      return bit;
    };
    let up = true;
    for (let col = sk.size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let i = 0; i < sk.size; i++) {
        const row = up ? sk.size - 1 - i : i;
        for (const c of [col, col - 1]) {
          if (sk.fixed[row][c]) continue;
          sk.mod[row][c] = nextBit();
        }
      }
      up = !up;
    }
  }
  const QR_MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  function qrApplyFormat(sk, mask) {
    const bits = qrFormatBits(mask);
    for (let i = 0; i < 15; i++) {
      const b = (bits >> i) & 1;
      // Copy 1: down column 8, then along row 8, around the top-left finder.
      if (i < 6) sk.mod[i][8] = b;
      else if (i < 8) sk.mod[i + 1][8] = b;
      else sk.mod[sk.size - 15 + i][8] = b;
      // Copy 2: the mirrored halves beside the other two finders, so a symbol
      // with one damaged corner still reports its own mask.
      if (i < 8) sk.mod[8][sk.size - 1 - i] = b;
      else if (i === 8) sk.mod[8][7] = b;
      else sk.mod[8][14 - i] = b;
    }
    sk.mod[sk.size - 8][8] = 1;
  }
  function qrApplyVersion(sk, version) {
    if (version < 7) return;
    const bits = qrVersionBits(version);
    for (let i = 0; i < 18; i++) {
      const b = (bits >> i) & 1;
      sk.mod[Math.floor(i / 3)][sk.size - 11 + (i % 3)] = b;
      sk.mod[sk.size - 11 + (i % 3)][Math.floor(i / 3)] = b;
    }
  }
  // The four penalty rules, lower is better. This is what decides which of
  // the eight masks ships: all eight are valid symbols, but the winner is the
  // one a phone camera locks onto fastest in bad light on a noticeboard.
  function qrPenalty(mod, size) {
    let score = 0;
    // Rule 1: runs of five or more same-coloured modules in a line.
    for (let i = 0; i < size; i++) {
      const readers = [(k) => mod[i][k], (k) => mod[k][i]];
      for (const read of readers) {
        let run = 1;
        for (let k = 1; k < size; k++) {
          if (read(k) === read(k - 1)) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; }
          else run = 1;
        }
      }
    }
    // Rule 2: every 2x2 block of a single colour.
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = mod[r][c];
        if (v === mod[r][c + 1] && v === mod[r + 1][c] && v === mod[r + 1][c + 1]) score += 3;
      }
    }
    // Rule 3: the 1:1:3:1:1 finder look-alike with four light modules beside
    // it - the pattern that makes a scanner mistake noise for a corner.
    const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (let i = 0; i < size; i++) {
      for (let k = 0; k + 11 <= size; k++) {
        let h1 = true, h2 = true, v1 = true, v2 = true;
        for (let j = 0; j < 11; j++) {
          if (mod[i][k + j] !== p1[j]) h1 = false;
          if (mod[i][k + j] !== p2[j]) h2 = false;
          if (mod[k + j][i] !== p1[j]) v1 = false;
          if (mod[k + j][i] !== p2[j]) v2 = false;
        }
        if (h1) score += 40;
        if (h2) score += 40;
        if (v1) score += 40;
        if (v2) score += 40;
      }
    }
    // Rule 4: how far the dark/light balance strays from 50/50.
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += mod[r][c];
    score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return score;
  }
  // The only entry point. Returns { size, version, mask, modules } where
  // modules[row][col] is 1 for a dark module, or null when the text is longer
  // than version 12 at level M can carry.
  function qrEncode(text) {
    const bytes = [];
    for (const ch of String(text)) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) bytes.push(cp);
      else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
      else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    const version = qrPickVersion(bytes.length);
    if (!version) return null;
    const codewords = qrInterleave(qrCodewords(bytes, version), version);
    const base = qrSkeleton(version);
    qrPlaceData(base, codewords);
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const mod = base.mod.map((row) => Uint8Array.from(row));
      for (let r = 0; r < base.size; r++) {
        for (let c = 0; c < base.size; c++) {
          if (!base.fixed[r][c] && QR_MASKS[mask](r, c)) mod[r][c] ^= 1;
        }
      }
      const sk = { size: base.size, mod: mod, fixed: base.fixed };
      qrApplyFormat(sk, mask);
      qrApplyVersion(sk, version);
      const score = qrPenalty(mod, base.size);
      if (!best || score < best.score) best = { score: score, mod: mod, mask: mask };
    }
    return { size: base.size, version: version, mask: best.mask, modules: best.mod };
  }

  // ---- The deep link ------------------------------------------------------
  //
  // SHAPE: <origin><path>?tab=community&invite=<code>
  //
  // Both halves are existing conventions, not new ones. `?tab=` is app.js's
  // own boot parameter (VALID_TABS, app.js:83) and "community" is already a
  // valid value - so the link lands on the right top-level tab with no
  // cross-file change at all. `?invite=` is the second query parameter this
  // app has ever had, and it follows `?notif=`'s rules exactly (app.js:287):
  // read once at boot, stripped from the URL immediately, consumed by
  // cloud.js. It is NOT a /community/... path deep link like the
  // notification targets resolveNotifTarget() parses - those are internal
  // route strings the server writes into notifications.deep_link and never
  // appear in the address bar. This one has to survive being typed, printed,
  // and opened cold on a device that has never run the app, which on a
  // static host (GitHub Pages, no rewrites) means a query on a real file
  // path and nothing else.
  //
  // Same client-side shape redeem_invite_code enforces server-side. A code
  // that does not match is dropped rather than pre-filled, so a mistyped or
  // tampered link never reaches the RPC and never shows the member an error
  // about something they did not type.
  const INVITE_CODE_PATTERN = /^[a-f0-9]{40,128}$/;
  function inviteDeepLink(code) {
    if (!INVITE_CODE_PATTERN.test(String(code || ""))) return "";
    const loc = window.location || {};
    const origin = String(loc.origin || "");
    if (!origin || origin === "null") return "";
    return origin + String(loc.pathname || "/") + "?tab=community&invite=" + code;
  }
  // Read at boot, exactly once, and stripped from the address bar before
  // anything renders.
  //
  // AN INVITE CODE IS A LIVE CREDENTIAL, and a URL is the leakiest place a
  // credential can sit: it lands in browser history, in the back-stack, in
  // whatever the member screenshots, and in the Referer of any later
  // navigation. history.replaceState() below removes it from all of those
  // the moment it has been read into memory - the same treatment, for the
  // same reason, that ?notif= gets in app.js. Nothing here logs the code,
  // and no analytics event carries it: track() is never called on this path.
  function captureInviteDeepLink() {
    let code = "";
    try {
      const search = String((window.location && window.location.search) || "");
      if (!search || search.indexOf("invite=") === -1) return;
      code = String(new URLSearchParams(search).get("invite") || "").trim().toLowerCase();
      const url = new URL(window.location.href);
      url.searchParams.delete("invite");
      // Strip first, validate second: a malformed code must leave the URL too.
      window.history.replaceState(null, "", url.pathname + (url.search || "") + url.hash);
    } catch (e) { return; /* an exotic URL is not worth breaking boot over */ }
    if (!INVITE_CODE_PATTERN.test(code)) return;
    state.ui.inviteCodeDraft = code;
    // Land on the invite step itself rather than the neutral
    // log-in-or-start-fresh screen. Someone who scanned a joining QR has
    // already answered that question. renderCommunityApp()'s own gates still
    // decide everything else: an existing member with a redemption never sees
    // the invite screen at all, and the "כבר יש לכם חשבון?" link on it puts
    // the login form back for a returning member who scanned by mistake.
    state.signupStarted = true;
  }

  // ---- Rendering, sharing and printing the QR ------------------------------
  const INVITE_QR = Object.freeze({
    // 720px square: eight times the largest symbol this can produce
    // (version 12 is 73 modules plus an 8-module quiet zone), so every module
    // is a whole number of pixels with no resampling blur, and big enough to
    // print at 6cm without a scanner hunting.
    PIXELS: 720,
    // Four modules of light margin on every side. The spec's minimum, and the
    // single most common reason a QR that "looks fine" will not scan.
    QUIET: 4,
    FILE_NAME: "haimunia-invite-qr.png",
  });
  // Pure black on pure white, deliberately NOT the app's dark palette. A
  // scanner needs dark modules on a light ground; the brand-coloured card
  // buildOutwardShareSpec() paints is the right answer for a result someone
  // posts to Instagram and the wrong one for something a camera has to read.
  function paintInviteQr(ctx, matrix, pixels) {
    const modules = matrix.size + INVITE_QR.QUIET * 2;
    const scale = Math.floor(pixels / modules);
    const offset = Math.floor((pixels - scale * modules) / 2);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, pixels, pixels);
    ctx.fillStyle = "#000000";
    for (let r = 0; r < matrix.size; r++) {
      for (let c = 0; c < matrix.size; c++) {
        if (!matrix.modules[r][c]) continue;
        ctx.fillRect(
          offset + (c + INVITE_QR.QUIET) * scale,
          offset + (r + INVITE_QR.QUIET) * scale,
          scale, scale,
        );
      }
    }
  }
  // outwardCreateCanvas()/outwardCanvasToBlob() are the outward-share work's
  // own OffscreenCanvas-or-<canvas> and convertToBlob-or-toBlob shims
  // (5c08110), reused rather than re-derived; OUTWARD_CARD.MIME is already
  // image/png. Canvas drawing and toBlob are not CSP-governed, and the object
  // URL is only ever an <img src>, never a fetch() - connect-src 'self' does
  // not cover blob:, so fetching our own object URL would be blocked.
  async function renderInviteQrBlob(link) {
    const matrix = qrEncode(link);
    if (!matrix) throw new Error("qr_too_long");
    const canvas = outwardCreateCanvas(INVITE_QR.PIXELS, INVITE_QR.PIXELS);
    const ctx = canvas.getContext ? canvas.getContext("2d") : null;
    if (!ctx) throw new Error("no_canvas");
    paintInviteQr(ctx, matrix, INVITE_QR.PIXELS);
    const blob = await outwardCanvasToBlob(canvas);
    if (!blob) throw new Error("no_canvas");
    return blob;
  }
  function revokeInviteQrPreview() {
    const q = state.admin.inviteQr;
    if (q && q.previewUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      try { URL.revokeObjectURL(q.previewUrl); } catch (e) { /* already revoked */ }
    }
  }
  const INVITE_QR_ERROR_TEXT = Object.freeze({
    qr_too_long: "הכתובת של האפליקציה ארוכה מדי לקוד QR. אפשר לשתף את הקישור או את הקוד עצמו.",
    no_canvas: "הדפדפן הזה לא הצליח לצייר את הקוד. אפשר לשתף את הקישור או את הקוד עצמו.",
    bad_code: "הקוד שהתקבל אינו בפורמט תקין. יש ליצור קוד חדש.",
  });
  function inviteQrErrorText(key) { return INVITE_QR_ERROR_TEXT[key] || INVITE_QR_ERROR_TEXT.no_canvas; }
  // Opened by the two create paths only. admin_invite_code_list() never
  // returns the code itself - the plaintext exists in the client for exactly
  // one render, right after creation - so this is not a "pick a code and show
  // its QR" panel and cannot be. That constraint is the right one anyway: the
  // QR is generated at the moment a code is made, printed, and then the
  // plaintext is gone from the client for good.
  function openInviteQr(code, kind) {
    const link = inviteDeepLink(code);
    revokeInviteQrPreview();
    state.admin.inviteQr = {
      code: String(code || ""), kind: kind || "shared", link: link,
      status: link ? "rendering" : "failed", previewUrl: "", blob: null,
      sharing: false, result: "", error: link ? "" : "bad_code",
    };
    if (link) refreshInviteQr();
  }
  function closeInviteQr() {
    revokeInviteQrPreview();
    state.admin.inviteQr = {
      code: "", kind: "", link: "", status: "idle", previewUrl: "",
      blob: null, sharing: false, result: "", error: "",
    };
    // The other half of the pairing described on dismissInviteCodeCreated():
    // the two reveal cards hold the same plaintext, so hiding the QR hides
    // them too.
    state.admin.inviteCodes.created = null;
    state.admin.invites.created = null;
    rerender();
  }
  async function refreshInviteQr() {
    const q = state.admin.inviteQr;
    if (!q || !q.link) return;
    q.status = "rendering";
    q.error = "";
    rerender();
    let blob = null;
    try {
      blob = await renderInviteQrBlob(q.link);
    } catch (err) {
      if (state.admin.inviteQr !== q) return; // closed or replaced mid-render
      q.status = "failed";
      q.blob = null;
      q.error = (err && err.message) || "no_canvas";
      return rerender();
    }
    if (state.admin.inviteQr !== q) return;
    revokeInviteQrPreview();
    q.blob = blob;
    q.previewUrl = (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") ? URL.createObjectURL(blob) : "";
    q.status = "ready";
    rerender();
  }
  // The text that rides along with the image. It carries the link, which
  // carries the code - that is the whole point of "send it to their phone",
  // and it only ever happens from this button's own click.
  function inviteShareText(link) {
    const club = (state.club.row && state.club.row.name) || "המועדון";
    return `הצטרפות ל${club} באפליקציית ${brandName()}:\n${link}`;
  }
  // Same three tiers, same order and the same feature detection as
  // performOutwardShare(): image first, text second, clipboard last, with
  // AbortError read as "the member changed their mind" rather than a failure.
  // outwardShareFile/outwardCanShareFile/outwardCanShareText/outwardCanCopy
  // and the OUTWARD_SHARE_RESULTS vocabulary are reused as-is; only the
  // payload differs, which is why this is a sibling of that function rather
  // than a spec contorted to fit it.
  async function performInviteShare(link, file) {
    const text = inviteShareText(link);
    const title = "הצטרפות למועדון";
    if (outwardCanShareFile(file)) {
      try {
        await navigator.share({ files: [file], text: text, title: title });
        return OUTWARD_SHARE_RESULTS.SHARED_IMAGE;
      } catch (err) {
        if (err && err.name === "AbortError") return OUTWARD_SHARE_RESULTS.CANCELLED;
      }
    }
    if (outwardCanShareText()) {
      try {
        await navigator.share({ text: text, title: title });
        return OUTWARD_SHARE_RESULTS.SHARED_TEXT;
      } catch (err) {
        if (err && err.name === "AbortError") return OUTWARD_SHARE_RESULTS.CANCELLED;
      }
    }
    if (outwardCanCopy()) {
      try {
        await navigator.clipboard.writeText(text);
        return OUTWARD_SHARE_RESULTS.COPIED;
      } catch (err) { /* fall through to the honest failure */ }
    }
    return OUTWARD_SHARE_RESULTS.FAILED;
  }
  async function shareInviteQr() {
    const q = state.admin.inviteQr;
    if (!q || !q.link || q.sharing) return;
    q.sharing = true;
    q.result = "";
    rerender();
    const result = await performInviteShare(q.link, outwardShareFile(q.blob));
    if (state.admin.inviteQr !== q) return;
    q.sharing = false;
    q.result = result;
    setMessage(outwardShareResultText(result));
    if (typeof window.showToast === "function") window.showToast(outwardShareResultText(result));
    rerender();
  }
  function copyInviteLink(link) {
    if (!link) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(() => markCopied(link)).catch(() => setMessage("ההעתקה נכשלה, אפשר להעתיק ידנית"));
    } else {
      setMessage("ההעתקה נכשלה, אפשר להעתיק ידנית");
    }
  }
  // The noticeboard path. window.print() rather than a generated PDF or a
  // popup: index.html's own @media print rules hide the whole app except
  // [data-invite-print], so what comes out of the printer is the card below
  // and nothing else. No new window (which a popup blocker would eat), no
  // download (the artifact sandbox and some in-app browsers refuse
  // script-started saves), and nothing that needs a CSP change.
  function printInviteQr() {
    const q = state.admin.inviteQr;
    if (!q || q.status !== "ready") return;
    if (typeof window.print === "function") window.print();
  }
  // Last resort, and the one path that works wherever a canvas does: save the
  // PNG. Same <a download> shape and same reasoning as outwardDownloadImage().
  function downloadInviteQr() {
    const q = state.admin.inviteQr;
    if (!q || !q.previewUrl) return;
    const a = document.createElement("a");
    a.href = q.previewUrl;
    a.download = INVITE_QR.FILE_NAME;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setMessage("קוד ה-QR נשמר במכשיר.");
  }

  // What a member is walked through, in the order the front desk says it out
  // loud. Kept as data so the printed card and the on-screen card cannot
  // drift into two different sets of instructions.
  const INVITE_QR_STEPS = Object.freeze([
    "פותחים את המצלמה בטלפון ומכוונים לקוד.",
    "האפליקציה נפתחת עם קוד ההצטרפות כבר במקום.",
    "בוחרים שם כניסה וסיסמה, וזהו.",
  ]);
  // Said plainly, next to the thing it is about. A joining code is a live
  // credential: anyone who photographs this sheet can join the club as a
  // member, and a manager deciding where to pin it deserves to know that
  // before they pin it rather than after.
  const INVITE_QR_WARNING = "כל מי שסורק את הקוד יכול להצטרף למועדון. אין לפרסם אותו מחוץ למועדון, ורצוי לכבות את הקוד כשמסיימים לגייס.";

  function renderInviteQrPanel() {
    // Exactly the union of the two panels that can create a code. A coach who
    // holds neither never sees this, and never could have created a code to
    // put in it.
    if (!(hasPerm(PERM.INVITE_MANAGE_CODES) || hasPerm(PERM.MEMBER_INVITE) || isAdmin())) return "";
    const q = state.admin.inviteQr;
    const head = sectionHead("var(--energy)", "קוד QR להצטרפות", true);
    if (!q.code) {
      return `<div class="ach-section" style="margin-top:18px;" data-invite-qr-section="1">${head}${emptyStateHtml({
        key: "invite-qr", icon: "people",
        headline: "כאן ייווצר קוד QR להדפסה ולשיתוף",
        body: "כל קוד הצטרפות שתיצרו למטה מקבל כאן קוד QR שנסרק ישר מהמצלמה, פותח את האפליקציה וממלא את הקוד לבד.",
        when: "הקוד מוצג פעם אחת בלבד, מיד אחרי היצירה — אז כדאי להדפיס או לשתף אותו אז.",
      })}</div>`;
    }
    const kindLabel = q.kind === "person" ? "הזמנה אישית" : "קוד הצטרפות משותף";
    let figure;
    if (q.status === "ready" && q.previewUrl) {
      figure = `<img src="${esc(q.previewUrl)}" width="240" height="240" alt="קוד QR להצטרפות למועדון" data-invite-qr-image="1" style="width:240px;height:240px;max-width:100%;border-radius:12px;background:#FFFFFF;"/>`;
    } else if (q.status === "failed") {
      figure = `<div class="empty" style="margin:0;" data-invite-qr-error="1">${bidiText(inviteQrErrorText(q.error))}<div class="chip-row" style="justify-content:center;"><button class="chip-btn" data-community-action="invite-qr-retry">ניסיון חוזר</button></div></div>`;
    } else {
      figure = `<div aria-busy="true" data-invite-qr-skeleton="1" style="width:240px;height:240px;max-width:100%;border-radius:12px;background:var(--border);opacity:.35;"></div>`;
    }
    // Every exit the device might actually have, and never a control that
    // cannot work: share is only offered where navigator.share exists at all,
    // and the download sits underneath as the path that always does.
    const shareBtn = outwardCanShareText()
      ? `<button class="chip-btn primary"${q.sharing ? " disabled" : ""} data-community-action="invite-qr-share" style="min-height:44px;">${q.sharing ? "משתפים…" : "שליחה לטלפון"}</button>`
      : "";
    const controls = `<div class="chip-row" style="margin-top:10px;">
      ${shareBtn}
      <button class="chip-btn"${q.status === "ready" ? "" : " disabled"} data-community-action="invite-qr-print" style="min-height:44px;">הדפסה</button>
      <button class="chip-btn"${q.status === "ready" ? "" : " disabled"} data-community-action="invite-qr-download" style="min-height:44px;">שמירת תמונה</button>
    </div>`;
    // Rule 4 of the invite work: the QR is useless over the phone. The raw
    // code and the raw link both stay visible and copyable beside it, in
    // dir="ltr" mono so a hex string is never reordered by the Hebrew around
    // it, and with the same "shown once" warning the creation card carries.
    const credentials = `<div class="chart-card" style="margin-top:10px;">
      <div class="field-label" style="margin-bottom:4px;">${bidiText(`${kindLabel} — הקוד עצמו`)}</div>
      <div class="flex gap-10" style="align-items:center;flex-wrap:wrap;">
        <code class="mono" dir="ltr" style="font-size:13px;word-break:break-all;" data-invite-qr-code="1">${esc(q.code)}</code>
        <button class="chip-btn" data-community-action="copy-invite-code" data-code="${esc(q.code)}">${copyLabel(q.code, "העתקת הקוד")}</button>
      </div>
      <div class="field-label" style="margin:10px 0 4px;">הקישור המלא</div>
      <div class="flex gap-10" style="align-items:center;flex-wrap:wrap;">
        <code class="mono" dir="ltr" style="font-size:12px;word-break:break-all;" data-invite-qr-link="1">${esc(q.link)}</code>
        <button class="chip-btn"${q.link ? "" : " disabled"} data-community-action="copy-invite-link" data-link="${esc(q.link)}">${copyLabel(q.link, "העתקת הקישור")}</button>
      </div>
    </div>`;
    const steps = `<ol style="margin:10px 0 0;padding-inline-start:20px;color:var(--steel);font-size:12.5px;line-height:1.8;">${INVITE_QR_STEPS.map((s) => `<li>${bidiText(s)}</li>`).join("")}</ol>`;
    // The printed sheet. Always in the DOM when a QR is ready (a print
    // stylesheet cannot reveal markup that was never rendered), visually
    // hidden on screen, and the only thing @media print leaves visible.
    const printCard = q.status === "ready" && q.previewUrl ? `<div data-invite-print="1" aria-hidden="true" class="invite-print-card">
      <div class="invite-print-club">${bidiText((state.club.row && state.club.row.name) || "המועדון")}</div>
      <div class="invite-print-title">הצטרפות לקהילת המועדון</div>
      <img src="${esc(q.previewUrl)}" alt="" class="invite-print-qr"/>
      <ol class="invite-print-steps">${INVITE_QR_STEPS.map((s) => `<li>${bidiText(s)}</li>`).join("")}</ol>
      <div class="invite-print-code-label">אם המצלמה לא קוראת, אפשר להקליד את הקוד ידנית:</div>
      <code class="invite-print-code" dir="ltr">${esc(q.code)}</code>
    </div>` : "";
    const resultLine = q.result ? `<div class="footer-note" role="status" style="margin-top:8px;">${bidiText(outwardShareResultText(q.result))}</div>` : "";
    return `<div class="ach-section" style="margin-top:18px;" data-invite-qr-section="1">${head}
      <div class="chart-card" style="border-color:var(--brass);">
        <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start;">
          <div style="flex:0 0 auto;">${figure}</div>
          <div style="flex:1 1 220px;min-width:200px;">
            <div style="font-weight:800;font-size:14px;">${bidiText(kindLabel)}</div>
            ${steps}
          </div>
        </div>
        ${controls}
        ${resultLine}
        <div class="footer-note" style="margin-top:10px;color:var(--brass);">${bidiText(INVITE_QR_WARNING)}</div>
        <div class="chip-row" style="margin-top:8px;"><button class="link-btn" data-community-action="invite-qr-close">כיבוי הקוד מהמסך</button></div>
      </div>
      ${credentials}
      ${printCard}
    </div>`;
  }

  // Reported directly: inviting one member was "way more complicated than
  // it needs to be." It was two full forms competing for attention side
  // by side (a personal invite for one named person, and a shared/bulk
  // code meant for a printable front-desk flyer - a genuinely different,
  // rarer task) plus a QR panel rendered ABOVE both, before either had
  // created anything to show a code for. Nothing about WHAT these do or
  // their permission gating changed - every form id, field name,
  // data-action and data-*-panel marker below is identical to what the
  // invite tests already assert on, checked against those tests before
  // this was written, not just eyeballed. What changed is order and
  // default visibility: the common case (invite the one person in front
  // of you) is what a coach/admin sees first and un-collapsed; the rarer
  // bulk/shared code sits behind a <details> disclosure, present in the
  // DOM exactly as before (dispatchEvent/requestSubmit on it in the unit
  // tests don't care about open/closed state) but not competing for the
  // first glance.
  // Live bug hunt (2026-09-11): this <details> had no id and no tracked
  // open state at all - every rerender (including createInviteCode()'s OWN
  // success path) rebuilt it plain-closed. createInviteCode() builds the
  // one-shot "the code is X, shown only now" reveal card to render INSIDE
  // this same disclosure - so the instant a code was created, the
  // disclosure that had to be open to reach the create form in the first
  // place collapsed right back, taking the reveal (and its own close
  // button, now genuinely unreachable - confirmed live, a real click
  // timed out) down with it. Since the raw code is never retrievable again
  // after this screen, that risked losing it outright. Fixed by tracking
  // its open state the same way manageAdminArea() does for the five
  // top-level areas (state.admin.openAreas, an id, a "toggle" listener
  // reattached after every render - see afterRenderManage()) - WITHOUT
  // adopting the `.manage-area` class itself, which also carries that
  // system's own chevron/heading-font styling meant for a top-level
  // accordion row, not this smaller nested disclosure; only the
  // persistence behavior is reused, not the look. createInviteCode() now
  // also forces it open the moment it has a reveal to show.
  const SHARED_CODE_DISCLOSURE_ID = "inviteSharedCodeDisclosure";
  function renderInviteManagement() {
    const shared = renderSharedCodesPanel();
    const person = renderPersonInvitesPanel();
    if (!shared && !person) return "";
    const open = Object.prototype.hasOwnProperty.call(state.admin.openAreas, SHARED_CODE_DISCLOSURE_ID)
      ? state.admin.openAreas[SHARED_CODE_DISCLOSURE_ID] : false;
    const sharedDisclosure = shared
      ? `<details id="${SHARED_CODE_DISCLOSURE_ID}" style="margin-top:14px;"${open ? " open" : ""}><summary class="link-btn" style="cursor:pointer;">עוד אפשרות: קוד הצטרפות משותף (להדפסה/שיתוף עם כמה אנשים)</summary><div style="margin-top:10px;">${shared}</div></details>`
      : "";
    return `<div class="ach-section" style="margin-top:18px;" data-invite-management-section="1">${sectionHead("var(--purple)", "הזמנת חבר/ה", true)}${person}${sharedDisclosure}</div>`;
  }
  // ---- Admin community analytics dashboard (COMM-310) ------------------
  // One RPC, analytics_dashboard(p_period_start, p_period_end)
  // (202609010006), answers all 18 metrics in docs/community/metrics.md's
  // Core (5) and Additional (13) sections in one call - see that
  // migration's own header comment for the full jsonb shape, mirrored
  // key-for-key by the render functions below. Gated on
  // community.analytics.view or real is_admin(), the same asymmetry
  // recap_monthly_publish() and this file's own canPublish already encode:
  // NARROWER than isStaff(), so a plain coach (isStaff() true) is refused
  // server-side and the nav entry is gated on the permission, never on
  // staffness, to match.
  //
  // Monday-based UTC weeks/months only, matching analytics_week_buckets()'s
  // own TIMEZONE note - this client makes the same "UTC ISO week, not the
  // club's local week" choice the schema half already recorded, not a
  // different one.
  function adminAnalyticsMondayUtc(d) {
    const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = dt.getUTCDay();
    dt.setUTCDate(dt.getUTCDate() + (day === 0 ? -6 : 1 - day));
    return dt;
  }
  function adminAnalyticsIsoDate(d) { return d.toISOString().slice(0, 10); }
  // The resolved {start, end} (both inclusive, matching the RPC's own
  // contract) for whichever week or month contains anchorIso (default:
  // today). Pure - never reads or mutates state - so both the mode switch
  // and the prev/next paging below can share it.
  function adminAnalyticsDefaultPeriod(mode, anchorIso) {
    const anchor = anchorIso ? new Date(anchorIso + "T00:00:00.000Z") : new Date();
    if (mode === "month") {
      const y = anchor.getUTCFullYear(), m = anchor.getUTCMonth();
      const start = new Date(Date.UTC(y, m, 1));
      const end = new Date(Date.UTC(y, m + 1, 0));
      return { start: adminAnalyticsIsoDate(start), end: adminAnalyticsIsoDate(end) };
    }
    const start = adminAnalyticsMondayUtc(anchor);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    return { start: adminAnalyticsIsoDate(start), end: adminAnalyticsIsoDate(end) };
  }
  // The four real Postgres errors analytics_dashboard() raises (the
  // migration's own comment on that function, verbatim), mapped to short
  // Hebrew - the same error.message === "..." pattern
  // MONTHLY_RECAP_ERROR_LABELS above already uses. Any other error
  // (network, a permission revoked mid-session) falls back to COMM-310's
  // own frontend-states copy for the Error state, "לא ניתן היה לטעון את
  // הנתונים." - not a generic retry line invented for this surface.
  const ADMIN_ANALYTICS_ERROR_LABELS = {
    "not authorized": "אין לך הרשאה לצפות בנתונים אלו.",
    "period required": "יש לבחור טווח תאריכים.",
    "period end before start": "תאריך הסיום קודם לתאריך ההתחלה.",
    "period exceeds 366 days": "טווח התאריכים ארוך מדי (מקסימום 366 ימים).",
  };
  function adminAnalyticsErrorText(error) {
    const msg = error && error.message;
    return (msg && ADMIN_ANALYTICS_ERROR_LABELS[msg]) || "לא ניתן היה לטעון את הנתונים.";
  }
  async function loadAdminAnalyticsDashboard() {
    if (!state.user || !(hasPerm(PERM.ANALYTICS_VIEW) || isAdmin())) { state.analytics.dashboard.data = null; return; }
    const a = state.analytics.dashboard;
    if (!a.start || !a.end) Object.assign(a, adminAnalyticsDefaultPeriod(a.mode));
    // Live bug hunt (2026-09-11): a.data used to stay truthy across a period
    // switch, so renderAdminAnalyticsDashboard()'s skeleton guard
    // (`a.loading && !a.data`) only ever fired on the very FIRST load - every
    // later mode toggle or prev/next page showed the OLD period's numbers
    // under the NEW period's already-updated date header for the whole RPC
    // round-trip, with no loading indicator at all. Confirmed live: paging
    // week -> month showed "שיא שבועי999" (the old week's fixture) under a
    // header already reading the new month's date range. Clearing a.data
    // here makes every re-fetch, not just the first, show the skeleton
    // instead of a stale number that no longer matches the header above it.
    a.data = null;
    a.loading = true; a.error = false; a.errorText = "";
    rerender();
    const { data, error } = await mgmtDb().rpc("analytics_dashboard", { p_period_start: a.start, p_period_end: a.end });
    a.loading = false; a.loaded = true;
    if (error) { a.error = true; a.errorText = adminAnalyticsErrorText(error); rerender(); return; }
    a.data = data || null;
    rerender();
    // COMM-311's own section only ever renders inside this same populated
    // branch (renderAdminAnalyticsDashboard() appends it after the two
    // metrics.md groups, inside the `else` where a.data is truthy) - so its
    // own load only ever needs to fire from this one place, the instant
    // a.data just became truthy, rather than being wired into
    // setAdminAnalyticsMode()/shiftAdminAnalyticsPeriod() separately or
    // into the account tab's own lazy-load gate a second time. That is the
    // "reusing the same period selector and load cycle, not a second nav
    // destination or a second RPC-driven load cycle" COMM-310's own commit
    // message asked a later ticket to do. Not awaited: this function's own
    // render must not wait on an RPC it does not itself depend on.
    loadMemberSegments();
    // COMM-379, same precedent, same reasoning: fires the instant a.data
    // becomes truthy, not awaited, no second period selector.
    loadRegistrationFunnel();
  }
  function setAdminAnalyticsMode(mode) {
    if (mode !== "week" && mode !== "month") return;
    const a = state.analytics.dashboard;
    if (a.mode === mode) return;
    a.mode = mode;
    Object.assign(a, adminAnalyticsDefaultPeriod(mode, a.start));
    loadAdminAnalyticsDashboard();
  }
  // dir < 0 is the previous period, dir > 0 the next one - one week or one
  // calendar month at a time, per the current mode. Anchored off a.start
  // (always day 1 of the month in month mode, always a Monday in week
  // mode), so paging never drifts off that anchor the way adding/
  // subtracting a flat 30 days would.
  function shiftAdminAnalyticsPeriod(dir) {
    const a = state.analytics.dashboard;
    if (!a.start) return;
    const anchor = new Date(a.start + "T00:00:00.000Z");
    if (a.mode === "month") anchor.setUTCMonth(anchor.getUTCMonth() + (dir < 0 ? -1 : 1));
    else anchor.setUTCDate(anchor.getUTCDate() + (dir < 0 ? -7 : 7));
    Object.assign(a, adminAnalyticsDefaultPeriod(a.mode, adminAnalyticsIsoDate(anchor)));
    loadAdminAnalyticsDashboard();
  }
  // ---- Member engagement segmentation (COMM-311) ----------------------
  // member_segments(p_as_of date) (202609010007) takes ONE as-of date, not
  // a range like analytics_dashboard() - so there is no second period
  // selector to build. Instead this reuses COMM-310's own selected period,
  // capped at today: a week or month period's own `end` can be in the
  // future (the current week/month is not over), and member_segments()
  // REFUSES a future as-of date outright rather than clamping it
  // server-side (the migration's own "a clamped date would put a
  // segmentation on screen labelled with a date it was not computed for"
  // note). Capping once here, client-side, is simpler than teaching this
  // section a second period concept only it would use.
  function memberSegmentsAsOf() {
    const todayIso = adminAnalyticsIsoDate(new Date());
    const end = state.analytics.dashboard.end;
    return (end && end < todayIso) ? end : todayIso;
  }
  // The two real Postgres errors member_segments() raises (the migration's
  // own comment on that function, verbatim), mapped to short Hebrew - same
  // error.message === "..." pattern ADMIN_ANALYTICS_ERROR_LABELS uses right
  // above. Anything else (network, a permission revoked mid-session) falls
  // back to COMM-311's own frontend-states copy for the Error state,
  // exactly as written in that ticket: "לא ניתן היה לטעון את הפילוח."
  const MEMBER_SEGMENTS_ERROR_LABELS = {
    "not authorized": "אין לך הרשאה לצפות בפילוח זה.",
    "as-of date is in the future": "לא ניתן להציג פילוח לתאריך עתידי.",
  };
  function memberSegmentsErrorText(error) {
    const msg = error && error.message;
    return (msg && MEMBER_SEGMENTS_ERROR_LABELS[msg]) || "לא ניתן היה לטעון את הפילוח.";
  }
  async function loadMemberSegments() {
    if (!state.user || !(hasPerm(PERM.ANALYTICS_VIEW) || isAdmin())) { state.analytics.segments.data = null; return; }
    const ms = state.analytics.segments;
    const asOf = memberSegmentsAsOf();
    ms.loading = true; ms.error = false; ms.errorText = ""; ms.asOf = asOf;
    rerender();
    const { data, error } = await mgmtDb().rpc("member_segments", { p_as_of: asOf });
    ms.loading = false; ms.loaded = true;
    if (error) { ms.error = true; ms.errorText = memberSegmentsErrorText(error); rerender(); return; }
    // setof jsonb comes back as a plain array from PostgREST; defensive
    // Array.isArray() guard only, no reshaping - the six-way grouping
    // happens at render time in groupMemberSegments(), never here, the same
    // "server is the one definition" posture data itself already follows.
    ms.data = Array.isArray(data) ? data : [];
    rerender();
  }
  // ---- COMM-379. Registration funnel analytics --------------------------
  // Same gate as the shell itself (community.analytics.view or real
  // is_admin() - registration_funnel()'s own AUTH note says NOT is_staff(),
  // matching analytics_dashboard exactly), so a coach who can browse the
  // roster (COMM-377, is_staff()) is still refused here, the one asymmetry
  // this cluster keeps consistent everywhere it appears.
  const REGISTRATION_FUNNEL_ERROR_LABELS = {
    "not authorized": "אין לך הרשאה לצפות בנתוני ההרשמה.",
    "period required": "יש לבחור טווח תאריכים.",
    "period end before start": "תאריך הסיום קודם לתאריך ההתחלה.",
    "period exceeds 366 days": "טווח התאריכים ארוך מדי (מקסימום 366 ימים).",
  };
  function registrationFunnelErrorText(error) {
    const msg = error && error.message;
    return (msg && REGISTRATION_FUNNEL_ERROR_LABELS[msg]) || "לא ניתן היה לטעון את נתוני ההרשמה.";
  }
  async function loadRegistrationFunnel() {
    if (!state.user || !(hasPerm(PERM.ANALYTICS_VIEW) || isAdmin())) { state.analytics.registrationFunnel.data = null; return; }
    const a = state.analytics.dashboard;
    const rf = state.analytics.registrationFunnel;
    rf.loading = true; rf.error = false; rf.errorText = "";
    rerender();
    const { data, error } = await mgmtDb().rpc("registration_funnel", { p_period_start: a.start, p_period_end: a.end });
    rf.loading = false; rf.loaded = true;
    if (error) { rf.error = true; rf.errorText = registrationFunnelErrorText(error); rerender(); return; }
    rf.data = data || null;
    rerender();
  }
  // A segment card's own drill-down toggle - independent of anything
  // COMM-310's period selector owns, and never reset by a period change (a
  // card a staff member opened stays open across paging, matching how
  // nothing else on this screen collapses on a period change either).
  function toggleMemberSegment(segment) {
    const ms = state.analytics.segments;
    ms.expanded[segment] = !ms.expanded[segment];
    rerender();
  }
  // ---- Retention correlation views (COMM-313) --------------------------
  // Three security-definer functions (202609010008), all gated on real
  // is_admin() ALONE - see state.analytics.retention's own comment for why that is
  // deliberately narrower than every other section in this cluster.
  // retention_cohorts(p_cohort_months) returns the cohort retention curve
  // itself; retention_onboarding_correlation() and
  // retention_welcome_correlation() take NO parameter at all (both use a
  // fixed 6-month window server-side, named constants the client cannot
  // move) and each return a two-group comparison. p_cohort_months is passed
  // explicitly as 6 here - the same window the two parameter-less
  // correlations are hardcoded to - so all three curves this section can
  // ever show share one x-axis's worth of members, rather than leaving the
  // cohort curve's own window to drift from the two correlations' fixed one
  // by relying on the RPC's own default matching it by coincidence.
  const RETENTION_COHORT_MONTHS = 6;
  // The one real Postgres error all three functions raise (identical
  // message, since the gate is identical) - same error.message === "..."
  // pattern ADMIN_ANALYTICS_ERROR_LABELS/MEMBER_SEGMENTS_ERROR_LABELS use.
  // Anything else (network, a permission revoked mid-session) falls back to
  // COMM-313's own frontend-states copy for the Error state, verbatim:
  // "לא ניתן היה לטעון את נתוני השימור."
  const RETENTION_ERROR_LABELS = {
    "not authorized": "אין לך הרשאה לצפות בנתוני השימור.",
  };
  function retentionErrorText(error) {
    const msg = error && error.message;
    return (msg && RETENTION_ERROR_LABELS[msg]) || "לא ניתן היה לטעון את נתוני השימור.";
  }
  // All three RPCs fire together on one lazy load, not staggered behind a
  // toggle click - COMM-311's own loadMemberSegments() precedent piggybacks
  // on COMM-310's load instead, but this section has no shared parent load
  // to piggyback on (its gate is narrower, so it cannot live inside
  // loadAdminAnalyticsDashboard() without also loosening that gate), so it
  // is its own lazy load wired into the account tab directly, same shape as
  // loadAdminAnalyticsDashboard() itself. The two overlays fetch eagerly
  // alongside the main curve rather than on first toggle: both are cheap,
  // pooled, parameter-less queries, and fetching them only on toggle would
  // mean a second loading state this ticket's own frontend-states list does
  // not name.
  async function loadRetentionCorrelations() {
    if (!state.user || !isAdmin()) { state.analytics.retention.cohorts = []; state.analytics.retention.onboarding = []; state.analytics.retention.welcome = []; return; }
    const r = state.analytics.retention;
    r.loading = true; r.error = false; r.errorText = "";
    rerender();
    const [cohortsRes, onboardingRes, welcomeRes] = await Promise.all([
      mgmtDb().rpc("retention_cohorts", { p_cohort_months: RETENTION_COHORT_MONTHS }),
      mgmtDb().rpc("retention_onboarding_correlation"),
      mgmtDb().rpc("retention_welcome_correlation"),
    ]);
    r.loading = false; r.loaded = true;
    // The cohort curve is this section's primary content - if it fails, the
    // whole section shows COMM-313's own Error state, matching how COMM-310
    // treats its own primary RPC. A correlation cut failing on its own
    // (while the main curve loaded fine) does not blank the section; it just
    // leaves that one overlay with nothing to show, same as an overlay
    // nobody has been stamped with yet - see renderRetentionOnboardingOverlay.
    if (cohortsRes.error) { r.error = true; r.errorText = retentionErrorText(cohortsRes.error); rerender(); return; }
    r.cohorts = Array.isArray(cohortsRes.data) ? cohortsRes.data : [];
    r.onboarding = (!onboardingRes.error && Array.isArray(onboardingRes.data)) ? onboardingRes.data : [];
    r.welcome = (!welcomeRes.error && Array.isArray(welcomeRes.data)) ? welcomeRes.data : [];
    rerender();
  }
  function toggleRetentionOnboardingOverlay() { state.analytics.retention.showOnboarding = !state.analytics.retention.showOnboarding; rerender(); }
  function toggleRetentionWelcomeOverlay() { state.analytics.retention.showWelcome = !state.analytics.retention.showWelcome; rerender(); }
  function setRetentionOnboardingStep(step) {
    if (!RETENTION_ONBOARDING_STEPS.some((s) => s.id === step)) return;
    if (state.analytics.retention.onboardingStep === step) return;
    state.analytics.retention.onboardingStep = step;
    rerender();
  }
  // ---- Community health score (COMM-312) --------------------------------
  // ONE read path: community_health_history(p_weeks default 12) returns
  // setof jsonb, {week_start, score, components} per row - security definer,
  // gated on real is_admin() ALONE (202609010009), same narrower bar as
  // COMM-313's three functions and, like them, NOT the hasPerm(PERM.
  // ANALYTICS_VIEW) || isAdmin() pair COMM-310/311 use. There is no write
  // path reachable from here at all: community_health_generate() is
  // service_role only, revoked from authenticated, so this half is read-only
  // by construction - no "recompute now" button exists here because one
  // would just 42501.
  const COMMUNITY_HEALTH_WEEKS = 12;
  // The one real Postgres error community_health_history() raises, mapped to
  // short Hebrew - same error.message === "..." pattern
  // RETENTION_ERROR_LABELS/MEMBER_SEGMENTS_ERROR_LABELS use. Anything else
  // (network, a permission revoked mid-session) falls back to COMM-312's own
  // frontend-states copy for the Error state, verbatim: "לא ניתן היה לטעון
  // את הציון."
  const COMMUNITY_HEALTH_ERROR_LABELS = {
    "not authorized": "אין לך הרשאה לצפות בציון זה.",
  };
  function communityHealthErrorText(error) {
    const msg = error && error.message;
    return (msg && COMMUNITY_HEALTH_ERROR_LABELS[msg]) || "לא ניתן היה לטעון את הציון.";
  }
  async function loadCommunityHealth() {
    if (!state.user || !isAdmin()) { state.analytics.health.weeks = []; return; }
    const h = state.analytics.health;
    h.loading = true; h.error = false; h.errorText = "";
    rerender();
    const { data, error } = await mgmtDb().rpc("community_health_history", { p_weeks: COMMUNITY_HEALTH_WEEKS });
    h.loading = false; h.loaded = true;
    if (error) { h.error = true; h.errorText = communityHealthErrorText(error); rerender(); return; }
    // setof jsonb comes back as a plain array from PostgREST; defensive
    // Array.isArray() guard only - the RPC itself already returns it OLDEST
    // FIRST, so nothing here re-sorts it.
    h.weeks = Array.isArray(data) ? data : [];
    rerender();
  }
  // ---- Admin audit view (COMM-154) -----------------------------------
  // Read-only, gated on community.analytics.view. admin_actions_page checks
  // the same permission again inside the function and once more via the
  // table's own select policy, so a client-only gate here changes nothing.
  async function loadAuditLog(reset) {
    if (!state.user || !hasPerm(PERM.ANALYTICS_VIEW)) { state.admin.auditLog = []; return; }
    if (state.admin.auditLoading) return;
    state.admin.auditLoading = true; state.admin.auditError = false;
    if (reset) { state.admin.auditLog = []; state.admin.auditCursor = null; state.admin.auditCursorId = null; state.admin.auditCursorId = null; state.admin.auditEnd = false; }
    rerender();
    const filters = {};
    if (state.admin.auditFilters.action_type) filters.action_type = state.admin.auditFilters.action_type;
    if (state.admin.auditFilters.admin_id) filters.admin_id = state.admin.auditFilters.admin_id;
    // The cursor is a ROW, not a moment. Live bug hunt, fresh round 7
    // (2026-09-15): paging on created_at alone dropped every row sharing the
    // last-shown row's timestamp - 300 seeded audit rows rendered 296. Ties
    // are the normal case here, not an edge one: actioning a report writes
    // report_review and content_delete in ONE transaction. feed_page's cursor
    // already worked this way; these two never caught up.
    const { data, error } = await mgmtDb().rpc("admin_actions_page", { p_cursor: state.admin.auditCursor, p_cursor_id: state.admin.auditCursorId, p_limit: 25, p_filters: filters });
    state.admin.auditLoading = false;
    state.admin.auditLoaded = true;
    if (error) { state.admin.auditError = true; rerender(); return; }
    const rows = data || [];
    state.admin.auditLog = reset ? rows : state.admin.auditLog.concat(rows);
    state.admin.auditCursor = rows.length ? rows[rows.length - 1].created_at : state.admin.auditCursor;
    state.admin.auditCursorId = rows.length ? rows[rows.length - 1].id : state.admin.auditCursorId;
    state.admin.auditEnd = rows.length < 25;
    // Fresh-eyes audit: admin_actions_page() returns admin_id as a bare
    // uuid - renderAuditLog() used to print its first 8 characters
    // verbatim ("מנהל/ת a1b2c3d4"), which tells an owner nothing about who
    // actually did what. Batched the same way loadCoachEngageFlags()
    // resolves flagged members: one extra query for the ids on THIS page,
    // merged into the running map rather than replacing it, so names
    // already resolved from an earlier page survive "load more".
    const { map: moreAdmins } = await loadProfilesById(rows.map((r) => r.admin_id));
    state.admin.auditAdminProfiles = Object.assign({}, state.admin.auditAdminProfiles, moreAdmins);
    rerender();
  }
  function setAuditFilter(key, value) {
    state.admin.auditFilters = Object.assign({}, state.admin.auditFilters);
    if (value) state.admin.auditFilters[key] = value; else delete state.admin.auditFilters[key];
    loadAuditLog(true);
  }
  // ---- Report flow (COMM-151) --------------------------------------
  // A member reports a post or a comment, picks a reason, optionally adds
  // detail, and gets a plain acknowledgement. Nothing about what follows is
  // disclosed. Duplicate reports on the same target by the same member
  // collapse server-side; the reporter count still moves once.
  function openReportSheet(targetType, targetId) {
    if (!state.user) return;
    state.admin.reportSheet = { targetType, targetId, reason: "", note: "", saving: false, error: "", done: false };
    rerender();
  }
  function closeReportSheet() { state.admin.reportSheet = null; rerender(); }
  function setReportReason(reason) { if (state.admin.reportSheet) { state.admin.reportSheet.reason = reason; state.admin.reportSheet.error = ""; rerender(); } }
  async function submitReportSheet() {
    const s = state.admin.reportSheet;
    if (!s || s.saving) return;
    if (!REPORT_REASONS.some((r) => r.id === s.reason)) { s.error = "יש לבחור סיבה"; return rerender(); }
    s.saving = true; s.error = ""; rerender();
    const { error } = await client.rpc("report", {
      p_target_type: s.targetType,
      p_target_id: s.targetId,
      p_reason: s.reason,
      p_note: String(s.note || "").slice(0, 500),
    });
    if (error) {
      s.saving = false;
      s.error = (error.message || "") === "rate_limited"
        ? "יותר מדי דיווחים, נסו שוב בעוד כמה דקות"
        : "לא ניתן היה לשלוח את הדיווח. נסו שוב.";
      return rerender();
    }
    // COMM-151. A post report also records a feed interaction so the ranker
    // learns from it. Comments are not feed items and record nothing.
    if (s.targetType === "post") trackFeedInteraction(s.targetId, "hide");
    // COMM-170. The reason code only. The free-text note is member-authored
    // content about another member and never enters the analytics table.
    track(A.REPORT_SUBMITTED, { target_type: s.targetType, reason: s.reason });
    s.saving = false; s.done = true;
    rerender();
    if (s.targetType === "post") loadFeed();
  }
  const removeMemberBusy = {};
  async function adminRemoveMember(userId) {
    // 202609160005 widened the server gate from is_admin() to
    // is_admin OR community.member.remove, plus a rank guard. This mirrors
    // both halves so the button is never drawn onto a call that will be
    // refused; the server re-derives the ranks itself and remains the
    // authority.
    if (!state.user || !(isAdmin() || hasPerm(PERM.MEMBER_REMOVE))) return;
    if (removeMemberBusy[userId]) return;
    removeMemberBusy[userId] = true;
    const { error } = await mgmtDb().rpc("admin_remove_member", { p_user_id: userId });
    removeMemberBusy[userId] = false;
    if (error) return setMessage(failText("הסרת החבר/ה נכשלה", error));
    setMessage("החבר/ה הוסר/ה");
    await refreshMemberSurfaces();
  }
  // 2026-09-05 launch-readiness fix. Login emails are synthetic
  // (usernameToEmail() - never a real deliverable address), so there is no
  // self-service "email me a reset link" path. This calls the
  // admin_reset_password Edge Function, which verifies the caller is a
  // real admin server-side (never trusting this client), then uses the
  // Supabase Admin SDK to set a new temporary password - the officially
  // supported way to do that, not a direct write to auth.users. The
  // returned password is shown exactly once (server never stores or
  // re-shows it) so the admin can relay it to the member directly.
  const resetPasswordBusy = {};
  async function adminResetPassword(userId) {
    if (!state.user || !isAdmin()) return;
    if (resetPasswordBusy[userId]) return;
    // AN UNREAD ONE-TIME SECRET IS NOT OVERWRITTEN WITHOUT ASKING. There is
    // one reveal slot; resetting a second member while the first card is
    // still up used to replace it silently, and the first password was then
    // unrecoverable - the server had already rotated it. Stopping here is the
    // conservative answer: the admin closes the card they have read, and only
    // then resets the next member.
    const pending = state.admin.passwordResetResult;
    if (pending && pending.userId !== userId) {
      setMessage(`יש סיסמה זמנית שעדיין לא נסגרה (${pending.name || "חבר/ה"}). סגרו אותה קודם.`);
      return;
    }
    resetPasswordBusy[userId] = true;
    rerender();
    const { data, error } = await mgmtDb().functions.invoke("admin_reset_password", { body: { target_user_id: userId } });
    resetPasswordBusy[userId] = false;
    if (error || !data || !data.temp_password) { rerender(); return setMessage("איפוס הסיסמה נכשל"); }
    // NAMED, and never silently replaced. Live bug hunt, fresh round 6
    // (2026-09-15).
    //
    // The reveal card showed a bare temporary password and nothing else - not
    // a name, not a handle, not even the id it already had in state. Reset a
    // second member's password without closing the first card and the single
    // slot silently flipped to the new secret: the first was gone forever,
    // the server had already rotated it, and it had never been shown with any
    // identifying context at all. Even a screenshot taken a moment too late
    // was ambiguous about whose password it was, which is a direct route to
    // sending the wrong one to the wrong person.
    //
    // subjectNameFor() is the same resolver the confirm dialog already used to
    // name this member a moment earlier - the name was available the whole
    // time and simply never carried across.
    state.admin.passwordResetResult = { userId, name: subjectNameFor(userId), tempPassword: data.temp_password };
    rerender();
  }

  // COMM-151. Opens the reason sheet for a post. The acknowledgement after
  // submit is plain ("הדיווח התקבל.") and says nothing about what follows.
  function report(postId) { openReportSheet("post", postId); }
  // 2026-09-05 launch-readiness fix. Posts and comments could be reported;
  // a member's profile (bio, display name) could not, even though it's
  // just as visible to the whole club. Requires the schema widening
  // reports.target_type/report() to accept 'profile' (2026-09-05 migration).
  function reportProfile(userId) { openReportSheet("profile", userId); }
  // COMM-321. Optimistic, same shape as savePrivacyField just above - the
  // write path is admin_set_club_feature(), not a direct table write
  // (club_features has no write policy at all, only the definer RPC).
  async function toggleClubFeature(key, enabled) {
    if (!state.user || CLUB_MODULE_KEYS.indexOf(key) < 0 || state.club.moduleBusy) return;
    const prevRow = state.club.features[key];
    const prevEnabled = prevRow ? prevRow.enabled : true;
    if (prevEnabled === enabled) return;
    state.club.features[key] = { enabled, config: (prevRow && prevRow.config) || {} };
    state.club.moduleBusy = key;
    rerender();
    const { error } = await mgmtDb().rpc("admin_set_club_feature", { p_module_key: key, p_enabled: enabled });
    state.club.moduleBusy = null;
    if (error) {
      state.club.features[key] = { enabled: prevEnabled, config: (prevRow && prevRow.config) || {} };
      setMessage("לא ניתן היה לעדכן את המודול");
      return rerender();
    }
    setMessage("הגדרת המודול נשמרה");
    rerender();
  }
  // 202609220002. The thresholds behind a switch, through the SAME RPC the
  // switch itself uses - admin_set_club_feature(key, enabled, config) has
  // taken a config argument since 202609010012 and nothing had ever sent one.
  //
  // `enabled` is re-sent unchanged from what the client holds, because that
  // RPC upserts the whole row: omitting it would silently reset the module to
  // its default. NOT optimistic, unlike the toggle above - a threshold is a
  // number an admin will read back off the screen to check, so it is shown
  // only once the server has taken it.
  //
  // AN EMPTY FIELD REMOVES THE KEY rather than writing 0. That is what makes
  // "clear it to go back to the default" true: club_feature_number() falls
  // back to its own default for an absent key, and a written 0 would be a
  // real, clamped, very different number.
  //
  // IT STARTS FROM THE CONFIG THAT IS THERE, and only the keys this form owns
  // are added or removed. The config object is not this form's property: the
  // server writes `enabled_at` into it when a module is switched on
  // (club_features_stamp_enabled_at, 202609220002) and no_contact_30 counts
  // its quiet period from that stamp, so a form that sent only its own seven
  // fields would be asking the server to drop a fact the club did not type.
  //
  // The server refuses to drop THAT one - the trigger carries enabled_at
  // forward across every write that is not a fresh enable, because a record
  // of something the club did must not be erasable through a button that says
  // "save". This merge is therefore not the thing standing between the club
  // and a flooded task list; it is what keeps the panel from round-tripping a
  // config it did not author, which matters for the next server-owned key as
  // much as for this one.
  async function saveClubFeatureConfig(key) {
    const def = CLUB_MODULE_TOGGLES.concat(COACH_MODULE_TOGGLES).find((m) => m.key === key);
    if (!state.user || !def || !def.settings || state.club.moduleBusy || state.club.configBusy) return;
    const existing = (state.club.features[key] && state.club.features[key].config) || {};
    const config = Object.assign({}, existing);
    for (const sett of def.settings) delete config[sett.id];
    for (const sett of def.settings) {
      const el = document.querySelector(`[data-club-feature-setting="${key}"][data-setting-key="${sett.id}"]`);
      const raw = el ? String(el.value).trim() : "";
      if (raw === "") continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      config[sett.id] = Math.round(n);
    }
    const prev = state.club.features[key] || { enabled: true, config: {} };
    state.club.configBusy = key;
    rerender();
    const { error } = await mgmtDb().rpc("admin_set_club_feature", {
      p_module_key: key, p_enabled: !!prev.enabled, p_config: config,
    });
    state.club.configBusy = null;
    if (error) { setMessage("לא ניתן היה לשמור את הערכים"); return rerender(); }
    state.club.features[key] = { enabled: !!prev.enabled, config };
    setMessage("הערכים נשמרו");
    rerender();
  }

  // COMM-152/153. The moderation queue. Visible to a community.comment.moderate
  // holder or a real admin; mod_queue() enforces both and is the only path
  // that can resolve the reporter identities. Each row carries the content,
  // the reported member, the reporter count, the reason, the date and the
  // status. Actions (COMM-153) all open a sheet that calls mod_review().
  function renderRestrictionsPanel() {
    if (!(hasPerm(PERM.MEMBER_RESTRICT) || hasPerm(PERM.COMMENT_MODERATE) || isAdmin())) return "";
    const a = state.admin;
    if (a.restrictionsLoading && !a.restrictions.length) {
      return `<div class="chart-card" style="margin-bottom:12px;">${sectionHead("var(--red)", "הגבלות פרסום פעילות")}<div class="log-list" aria-busy="true"><div class="log-row" aria-hidden="true"><span style="height:12px;width:55%;background:var(--border);border-radius:6px;display:inline-block;"></span></div></div></div>`;
    }
    if (a.restrictionsError) {
      return `<div class="chart-card" style="margin-bottom:12px;">${sectionHead("var(--red)", "הגבלות פרסום פעילות")}<div class="empty">לא ניתן היה לטעון את ההגבלות.<div class="chip-row" style="justify-content:center;margin-top:6px;"><button class="chip-btn" data-community-action="restrictions-retry">ניסיון חוזר</button></div></div></div>`;
    }
    // Nothing to show is the healthy state, and saying so beats an empty box.
    if (!a.restrictions.length) {
      if (!a.restrictionsLoaded) return "";
      return `<div class="chart-card" style="margin-bottom:12px;">${sectionHead("var(--red)", "הגבלות פרסום פעילות")}<div class="empty">אין כרגע הגבלות פרסום.</div></div>`;
    }
    // Bug found by scripts/audit-role-coverage.mjs (permission-gate-mismatch
    // check): this panel's own OUTER gate is an OR across three tiers
    // (MEMBER_RESTRICT / COMMENT_MODERATE / isAdmin()) so a plain coach -
    // who holds comment.moderate but not member.restrict - could see the
    // whole panel, which is fine (coaches should see that a restriction
    // exists). But the lift button was rendered unconditionally to
    // everyone who could see the panel at all, and mod_lift_restriction()
    // independently requires community.member.restrict (head_coach+ only)
    // - the same "coarse gate covers a stricter action" shape the
    // moderation-queue restrict buttons had, just in a different panel
    // this session's manual role audit did not happen to check.
    const canLift = hasPerm(PERM.MEMBER_RESTRICT);
    const rows = a.restrictions.map((r) => {
      const who = r.member_name || "חבר/ה";
      const permanent = r.restriction_type === "permanent";
      const until = permanent ? "ללא תאריך סיום" : `עד ${hebrewDateEchoText(String(r.expires_at || "").slice(0, 10)) || esc(String(r.expires_at || "").slice(0, 10))}`;
      const busy = a.restrictionLifting === r.id;
      return `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:6px;">
        <div style="font-weight:700;font-size:14px;">${bidiText(who)}</div>
        <div style="color:var(--steel);font-size:12px;">${permanent ? "הגבלה קבועה" : "הגבלה זמנית"} · ${esc(until)}</div>
        ${r.reason ? `<div style="color:var(--steel);font-size:12.5px;">${bidiText(r.reason)}</div>` : ""}
        ${canLift ? `<button class="chip-btn" data-community-action="lift-restriction" data-id="${esc(r.id)}"${busy ? " disabled" : ""} style="margin-top:2px;">${busy ? "מבטל…" : "ביטול ההגבלה"}</button>` : ""}
      </div>`;
    }).join("");
    return `<div class="chart-card" style="margin-bottom:12px;">
      ${sectionHead("var(--red)", "הגבלות פרסום פעילות")}
      <div class="footer-note" style="margin:0 0 10px;">ביטול ההגבלה מחזיר מיד את היכולת לפרסם ולהגיב.</div>
      <div class="log-list">${rows}</div>
    </div>`;
  }

  function renderModeration() {
    if (!(hasPerm(PERM.COMMENT_MODERATE) || isAdmin())) return "";
    const filters = `<div class="chip-row" style="margin:0 0 10px;">${MOD_QUEUE_STATUSES.map((s) =>
      `<button class="chip-btn${state.admin.modQueueStatus === s.id ? " selected" : ""}" data-community-action="mod-queue-status" data-status="${s.id}">${s.label}</button>`).join("")}</div>`;
    let body;
    if (state.admin.modQueueLoading && !state.admin.modQueue.length) {
      body = `<div class="log-list" aria-busy="true">${`<div class="log-row" aria-hidden="true"><span style="height:12px;width:60%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`.repeat(3)}</div>`;
    } else if (state.admin.modQueueError) {
      body = `<div class="empty">לא ניתן היה לטעון את התור.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="mod-queue-retry">ניסיון חוזר</button></div></div>`;
    } else if (!state.admin.modQueue.length) {
      body = `<div class="empty">אין מה לבדוק.</div>`;
    } else {
      const rowHtml = (r) => {
        const done = r.status === "action_taken" || r.status === "dismissed";
        const reasons = Array.isArray(r.reasons) && r.reasons.length ? r.reasons : (r.latest_reason ? [r.latest_reason] : []);
        return `<div class="chart-card" style="margin-bottom:10px;" data-mod-report-id="${esc(r.report_id)}">
          <div class="flex" style="justify-content:space-between;align-items:flex-start;gap:10px;">
            <div style="min-width:0;">
              <div style="font-weight:800;">${esc(MOD_TARGET_LABEL[r.target_type] || "פוסט")} · ${bidiText(r.content_author_name || MOD_UNKNOWN_AUTHOR_TEXT)}</div>
              <div style="color:var(--steel);font-size:12.5px;margin-top:4px;white-space:pre-wrap;">${bidiText(String(r.content_excerpt || "התוכן הוסר").slice(0, 240))}</div>
            </div>
            <span class="admin-tag" style="${r.status === "open" ? "background:rgba(194,57,44,.12);border-color:var(--red);color:var(--red-text);" : ""}">${esc(MOD_STATUS_LABEL[r.status] || r.status)}</span>
          </div>
          <div style="color:var(--steel);font-size:12px;margin-top:8px;">
            ${(() => { const rc = Number(r.reporter_count || 0); return rc === 1 ? "דיווח אחד" : `${rc} דיווחים`; })()} · ${reasons.map(reportReasonLabel).map(esc).join(", ") || "—"} · ${relativeTime(r.created_at)}
          </div>
          ${r.note ? `<div style="color:var(--steel);font-size:12px;margin-top:4px;">״${esc(String(r.note).slice(0, 240))}״</div>` : ""}
          <div class="chip-row" style="margin-top:10px;">
            <button class="chip-btn" data-community-action="mod-context" data-id="${esc(r.report_id)}">צפייה בהקשר</button>
            ${done ? "" : MOD_DECISIONS.filter((d) => d.id !== "remove" || r.target_type !== "profile")
              // Real bug found by a role-coverage audit: comment.moderate
              // (coach and up) rendered these two decisions same as every
              // other one, but mod_restrict_member() independently requires
              // community.member.restrict, seeded to head_coach and up only
              // - a coach clicking either restrict button got a hard
              // "not authorized" failure every time, with no indication why.
              .filter((d) => (d.id !== "restrict_temp" && d.id !== "restrict_permanent") || hasPerm(PERM.MEMBER_RESTRICT))
              .map((d) =>
              `<button class="chip-btn${d.destructive ? " danger" : ""}" data-community-action="mod-action" data-id="${esc(r.report_id)}" data-decision="${d.id}">${d.label}</button>`).join("")}
          </div>
        </div>`;
      };
      body = state.admin.modQueue.map(rowHtml).join("");
    }
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--red)", "תור מודרציה", true)}${filters}${body}</div>`;
  }
  // COMM-154. Read-only admin audit view, gated on community.analytics.view.
  function auditActionLabel(t) {
    return {
      content_delete: "הסרת תוכן", content_hide: "הסתרת תוכן", member_restrict: "הגבלת חבר/ה",
      member_unrestrict: "ביטול הגבלה", role_change: "שינוי הרשאה", challenge_edit: "עריכת אתגר",
      achievement_edit: "עריכת מדליה", privacy_config: "הגדרת פרטיות", content_pin: "הצמדת תוכן",
      content_unpin: "ביטול הצמדה", report_review: "בדיקת דיווח",
      // The three action types added after COMM-154. Without these the log
      // rendered the raw English action_type ("club_feature_toggle · club")
      // in an otherwise all-Hebrew list, and the filter row had no chip to
      // narrow by them at all.
      member_of_week_publish: "פרסום חבר/ת השבוע", monthly_recap_publish: "פרסום סיכום חודשי",
      club_feature_toggle: "שינוי מודול מועדון",
      // 6 more action_type values that were already live in
      // admin_actions_action_type_check (202609030001, 202609030002,
      // 202609030004, 202609050001) but never got a client label - the log
      // rendered them same as the three above did before COMM-154's fix.
      invite_created: "יצירת הזמנה", invite_revoked: "ביטול הזמנה",
      shared_code_created: "יצירת קוד שיתוף", shared_code_status_changed: "שינוי סטטוס קוד שיתוף",
      onboarding_content_updated: "עדכון תוכן קליטה", member_password_reset: "איפוס סיסמה לחבר/ה",
      // Five-persona UX audit, defect 3 (202609060023). admin_reclaim_invite
      // writes one invite_reclaimed row per reclaim, so without this the
      // feature's own audit trail renders as raw English in an otherwise
      // all-Hebrew log - the exact gap the two comments above already record
      // for nine earlier action types.
      invite_reclaimed: "שחרור הזמנה",
    }[t] || t;
  }
  // The other half of an audit row's headline. admin_actions.target_type is
  // a closed 13-value list (202608280002 and the migrations that widened it);
  // rendering it raw put English next to the Hebrew action label on every
  // row. Same shape as pinTargetLabel() further down.
  function auditTargetLabel(t) {
    return {
      post: "פוסט", comment: "תגובה", member: "חבר/ה", role: "הרשאה", challenge: "אתגר",
      achievement: "מדליה", event: "אירוע", announcement: "הודעה", report: "דיווח",
      club: "מועדון", monthly_club_recap: "סיכום חודשי",
      challenge_participant: "משתתף/ת באתגר", challenge_team: "קבוצה באתגר",
      // 3 more target_type values already live in admin_actions_target_type_check
      // (202609030001, 202609030004) but never labelled here.
      invite: "הזמנה", invite_code: "קוד הזמנה", onboarding_step: "שלב קליטה",
    }[t] || t;
  }
  const AUDIT_ACTION_TYPES = ["content_delete", "content_hide", "member_restrict", "member_unrestrict", "role_change", "challenge_edit", "achievement_edit", "privacy_config", "content_pin", "content_unpin", "report_review", "member_of_week_publish", "monthly_recap_publish", "club_feature_toggle", "invite_created", "invite_revoked", "shared_code_created", "shared_code_status_changed", "onboarding_content_updated", "member_password_reset", "invite_reclaimed", "bug_report_status"];
  // Usability pass: 22 chips plus "הכול" wrapped across several rows - noisy
  // for a tool staff open occasionally, not weekly. These four stay visible
  // (what a moderator's actual filtering reaches for: a report decision, a
  // deletion, a restriction, a role change); the rest sit behind the same
  // <details> disclosure renderInviteManagement() already uses for its own
  // rarer option. The disclosure opens itself when the ACTIVE filter is one
  // of the hidden ones, so a selected chip is never invisible.
  const AUDIT_COMMON_TYPES = ["report_review", "content_delete", "member_restrict", "role_change"];
  // Real device feedback: the audit log used to render one full row per
  // admin_actions record, so a genuinely repeated action on the same
  // target (a coach toggling one shared code's status several times while
  // testing, say) painted the whole screen with near-identical rows -
  // same action label, same target, same actor, same relative-time
  // bucket, nothing to tell them apart at a glance. Rows already arrive
  // ordered by created_at desc (admin_actions_page's own ORDER BY), so a
  // single linear pass collapses a CONSECUTIVE run of the exact same
  // (action_type, target_type, target_id, admin_id) into one entry with a
  // count - genuinely different targets, actors or action types never
  // merge, only true repeats do. The collapsed entry keeps the most
  // recent row's timestamp (relativeTime of the newest occurrence) since
  // that is what "how long ago did this last happen" actually means.
  function groupConsecutiveAuditActions(rows) {
    const groups = [];
    for (const a of rows) {
      const last = groups[groups.length - 1];
      if (last && last.action_type === a.action_type && last.target_type === a.target_type
          && last.target_id === a.target_id && last.admin_id === a.admin_id) {
        last.count++;
      } else {
        groups.push({ action_type: a.action_type, target_type: a.target_type, target_id: a.target_id, admin_id: a.admin_id, created_at: a.created_at, count: 1 });
      }
    }
    return groups;
  }
  // Fresh-eyes audit: falls back to the old truncated-uuid text only when
  // loadAuditLog()'s batched lookup genuinely found nothing (a deleted
  // profile, a race with a page still loading) - never silently blank, so
  // a gap is visible as a gap rather than read as "the system".
  function auditActorName(adminId) {
    const p = state.admin.auditAdminProfiles[adminId];
    if (p) return (p.display_name || (p.handle ? "@" + p.handle : "")) || `מנהל/ת ${String(adminId || "").slice(0, 8)}`;
    return `מנהל/ת ${String(adminId || "").slice(0, 8)}`;
  }
  // =====================================================================
  // Bug reports inbox (202609150002)
  // =====================================================================
  // The collection half of the support feature. app.js's openSupport() still
  // composes a report locally and hands it to WhatsApp/mail - that path must
  // never depend on a working session, because reporting a bug is exactly
  // when the session may be what is broken - but when Community IS available
  // the report is also filed here, so it gets a status, a history, and a
  // second admin who can see it was handled.
  const BUG_STATUS_LABELS = Object.freeze({
    open: "פתוח", in_progress: "בטיפול", resolved: "טופל", wont_fix: "לא יטופל",
  });
  // Opened by default only while something is actually waiting, matching how
  // the moderation area above it behaves. An empty inbox should not push the
  // audit log down the screen every time an admin opens this tab.
  function openBugReportsByDefault() {
    // Always open on the admin panel now. It was conditional while this sat
    // among five collapsed areas on a screen shared with the head coach;
    // the admin panel's whole job is this queue plus the audit log.
    return true;
  }
  async function loadBugReports(force) {
    if (!state.user || !isStaff()) return;
    if (state.admin.bugsLoading) return;
    if (state.admin.bugsLoaded && !force) return;
    state.admin.bugsLoading = true; state.admin.bugsError = false; rerender();
    const { data, error } = await mgmtDb().rpc("bug_report_list_all", {
      p_status: state.admin.bugsStatus === "all" ? null : state.admin.bugsStatus,
      p_limit: 100,
    });
    state.admin.bugsLoading = false;
    if (error) { state.admin.bugsError = true; rerender(); return; }
    state.admin.bugs = data || [];
    state.admin.bugsLoaded = true;
    rerender();
  }
  async function setBugReportStatus(id, status) {
    if (!state.user || !isAdmin()) return;
    state.admin.bugsSaving = id; rerender();
    const { error } = await mgmtDb().rpc("bug_report_set_status", { p_id: id, p_status: status, p_note: null });
    state.admin.bugsSaving = "";
    if (error) { setMessage(failText("עדכון הדיווח נכשל", error)); rerender(); return; }
    await loadBugReports(true);
  }
  // The device block the member already saw before sending. Rendered as
  // plain labelled lines rather than raw JSON: an admin reading this is
  // triaging, not debugging a payload.
  function bugDiagnosticsHtml(d) {
    if (!d || typeof d !== "object") return "";
    const rows = Object.keys(d).map((k) => `${k}: ${String(d[k])}`);
    if (!rows.length) return "";
    return `<pre class="mono" style="white-space:pre-wrap;word-break:break-word;font-size:11px;color:var(--steel);margin:6px 0 0;">${esc(rows.join("\n"))}</pre>`;
  }
  // =====================================================================
  // The two management panels and the lock on them
  // =====================================================================
  // Both panels are locked, and both open a SEPARATE management session
  // rather than re-checking the member who is signed in - see makeMgmtClient()
  // at the top of this file for why there are two clients at all.
  //
  // Both, not just the admin panel: adding and removing members, lifting
  // restrictions and editing what every new member reads is not a smaller
  // responsibility than reading the audit log, it is just a different one.
  //
  // 15 minutes: long enough to triage a queue and read the audit log without
  // retyping, short enough that a phone left on a bench re-locks before
  // anyone wanders past. Re-checked on every render rather than on a timer,
  // so a backgrounded app is locked the moment it is looked at again - and
  // when the last panel's window runs out, mgmtExpireIfStale() drops the
  // management session with it, so an idle phone stops holding one at all.
  // 30 minutes, and it SLIDES - see mgmtTouch(). Was a fixed 15, which is
  // fine for "read one thing and leave" and wrong for the job people actually
  // do here: triage the bug inbox, cross-check the audit log, fix a role,
  // answer a member. That runs past fifteen minutes routinely, and being
  // asked to retype a password mid-task - on a phone, in an LTR field, in an
  // RTL app - is the kind of friction that makes an owner stop using the
  // panel. Sliding means the clock measures IDLE time, not total time: it is
  // the unattended phone this guards against, and an unattended phone is by
  // definition not being touched.
  const ADMIN_UNLOCK_MINUTES = 30;
  // Where this device remembers WHICH management account was last used. The
  // account name only - never the password, which lives in Supabase Auth and
  // in the phone's own password manager, and nowhere else. Saves retyping
  // "haimuniya@gmail.com" on a phone keyboard every time, and lets the
  // password manager match a filled-in username to its saved entry.
  const MGMT_ACCOUNT_KEY = "haimunia-demo:mgmtAccount";
  function rememberedMgmtAccount() {
    try { return localStorage.getItem(MGMT_ACCOUNT_KEY) || ""; } catch (e) { return ""; }
  }
  function panelUnlocked(panel) {
    // Both halves must hold. The timer alone is not enough: a management
    // session that failed to load, or was torn down by a sign-out, must
    // re-lock the panel even if its 15 minutes have not run out.
    return !!state.admin.mgmt && Date.now() < (Number(state.admin.panelUnlockedUntil[panel]) || 0);
  }
  // What the MANAGEMENT account may do - deliberately parallel to isAdmin()
  // and isStaff(), and deliberately not them. Those two answer about the
  // member using the app; these answer about the account that signed into
  // the gate. Mixing them up is the entire bug this design exists to avoid.
  function mgmtIsAdmin() { return !!(state.admin.mgmt && state.admin.mgmt.isAdmin); }
  function mgmtIsStaff() { return !!(state.admin.mgmt && state.admin.mgmt.isStaff); }
  // Drops the management session. Called on lock expiry, on sign-out, and
  // whenever an unlock attempt fails part-way - so a half-built session can
  // never be left behind for mgmtDb() to pick up.
  async function mgmtTeardown() {
    const c = mgmtClient;
    mgmtClient = null;
    state.admin.mgmt = null;
    state.admin.panelUnlockedUntil = { admin: 0, club: 0 };
    // The change-password form belongs to the session that opened it. Live bug
    // hunt, fresh round 1: these three survived a teardown, so locking with
    // the form open handed it - still open, still showing the previous
    // account's error - to whoever unlocked next. Worst case reproduced was an
    // admin's "this is your current password" error greeting the HEAD COACH by
    // name in their own brand-new session. No value leaked (the inputs are
    // rebuilt empty), but a session bar built to answer "which of my two
    // accounts is this" must not open wearing the other one's state.
    state.admin.mgmtPasswordOpen = false;
    state.admin.mgmtPasswordError = "";
    state.admin.mgmtPasswordBusy = false;
    // Best-effort: revokes the refresh token server-side. The session is
    // memory-only either way, so a failure here loses nothing - the object
    // is already unreachable.
    if (c) { try { await c.auth.signOut(); } catch (e) {} }
  }
  // Re-locks a panel whose window has run out, and tears the management
  // session down with it once NEITHER panel is still open. Called from the
  // render path, so a backgrounded phone re-locks the moment it is looked at
  // again rather than on a timer that a sleeping tab would not fire.
  // Extends every unlock this session already holds. Called from the panel's
  // render path, which is to say on every interaction with it - so the window
  // measures time since the manager last did something, not time since they
  // signed in. Never GRANTS a panel: a zero stays zero, so a session that was
  // only ever entitled to the club cannot slide its way into the app panel.
  function mgmtTouch() {
    if (!state.admin.mgmt) return;
    const until = Date.now() + ADMIN_UNLOCK_MINUTES * 60 * 1000;
    const u = state.admin.panelUnlockedUntil;
    if (u.admin) u.admin = until;
    if (u.club) u.club = until;
  }
  function mgmtExpireIfStale() {
    if (!state.admin.mgmt) return;
    const now = Date.now();
    const u = state.admin.panelUnlockedUntil;
    if (now >= (Number(u.admin) || 0) && now >= (Number(u.club) || 0)) mgmtTeardown();
  }
  const PANEL_UNLOCK_COPY = Object.freeze({
    admin: {
      title: "אזור ניהול האפליקציה",
      body: "כאן נמצאים דיווחי התקלות, יומן הפעולות, ההרשאות ואיפוס הסיסמאות. האזור הזה עובד עם חשבון ניהול נפרד — צריך להזין את שם המשתמש או האימייל שלו, ואת הסיסמה.",
      cta: "כניסה לאזור הניהול",
      denied: "חשבון הניהול שהוזן אינו מורשה לנהל את האפליקציה.",
    },
    club: {
      title: "אזור ניהול המועדון",
      body: "כאן מוסיפים ומסירים חברים, מנהלים את רשימת המועדון, את המודרציה ואת מה שחברים חדשים רואים. האזור הזה עובד עם חשבון ניהול נפרד — צריך להזין את שם המשתמש או האימייל שלו, ואת הסיסמה.",
      cta: "כניסה לניהול המועדון",
      denied: "חשבון הניהול שהוזן אינו מורשה לנהל את המועדון.",
    },
  });
  // THE GATE. Takes an email as well as a password, because the management
  // account is a separate identity - "no, i want it to be seperate from the
  // regular user". It does NOT name the current user and does not ask them to
  // confirm their own password: whoever is signed in to train is irrelevant
  // here, and prefilling their address would suggest otherwise.
  //
  // The reassurance in the footer is the thing the owner actually asked to be
  // true, so it is stated on the screen where the worry arises rather than
  // left for them to discover: signing in here does not disturb the account
  // they train with.
  function renderPanelUnlockGate(panel) {
    const a = state.admin;
    const copy = PANEL_UNLOCK_COPY[panel];
    const busy = a.panelUnlockBusy === panel;
    // AUTOCOMPLETE username / current-password, not "off".
    //
    // "off" was a mistake, and the expensive kind: it is what tells iOS and
    // Android NOT to offer to save these credentials and not to fill them
    // back in. The reasoning behind it was sound - do not prefill the
    // signed-in MEMBER's details, because this is not their password being
    // asked for - but the fix for that is to not prefill the member, which
    // this does by seeding the field from the remembered MANAGEMENT account
    // instead. Blocking the password manager just meant typing a long address
    // and a long password by hand, on a phone, every single time.
    const remembered = rememberedMgmtAccount();
    return `<div class="chart-card">
      <div style="font-weight:800;font-size:16px;margin-bottom:6px;">${esc(copy.title)}</div>
      <div style="color:var(--steel);font-size:13px;line-height:1.7;margin-bottom:12px;">${bidiText(copy.body)}</div>
      <form id="panelUnlock" data-panel="${esc(panel)}">
        ${field("panelUnlock", "email", "שם משתמש או אימייל של חשבון הניהול", `<input class="text-input" name="email" type="text" dir="ltr" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="username" placeholder="headcoach" value="${esc(remembered)}" required/>`)}
        ${field("panelUnlock", "password", "סיסמה", `<input class="text-input" name="password" type="password" dir="ltr" autocomplete="current-password" placeholder="סיסמה" required/>`)}
        <button class="save-btn" type="submit"${busy ? " disabled" : ""} style="margin-top:12px;">${busy ? "בודקים…" : esc(copy.cta)}</button>
      </form>
      ${a.panelUnlockError ? `<div class="field-error" role="alert" style="margin-top:10px;">${esc(a.panelUnlockError)}</div>` : ""}
      <div class="footer-note" style="margin:12px 0 0;">${bidiText(`הכניסה לכאן לא משנה את החשבון שאיתו אתם מחוברים באפליקציה — האימונים שלכם נשארים בחשבון שלכם. הכניסה נשמרת ל-${ADMIN_UNLOCK_MINUTES} דקות, ומתאפסת בכל פתיחה מחדש של האפליקציה.`)}</div>
    </div>`;
  }
  // A MANAGEMENT ACCOUNT CHANGES ITS OWN PASSWORD.
  //
  // The gap this closes, asked about directly: "How I change the password?"
  // The answer was two bad options. The roster's איפוס סיסמה works on any
  // account including this one, but admin_reset_password generates the
  // password server-side and refuses to accept one from the client by design
  // - so it rotates a credential to a random string you then have to keep,
  // rather than to one you will remember. The alternative was the Supabase
  // dashboard, in a browser, outside the app entirely.
  //
  // Neither is acceptable for the credential that now guards real database
  // authority. A password nobody can comfortably change is a password nobody
  // changes, and this one has to be rotatable on demand.
  //
  // It lives on the session bar rather than inside either panel's areas,
  // because it is not app administration or club administration - it is this
  // SESSION's own business, and the head coach needs it exactly as much as the
  // admin does. The bar renders in both panels, so both get it from one place.
  //
  // Re-authentication is already done: nothing reaches this without having
  // just typed this account's current password into the gate, which is the
  // check a change-password form would otherwise have to make for itself.
  function renderMgmtPasswordChange() {
    const a = state.admin;
    if (!a.mgmtPasswordOpen) return "";
    return `<div class="chart-card" style="margin-bottom:12px;">
      <div style="font-weight:800;font-size:15px;margin-bottom:4px;">שינוי הסיסמה של חשבון הניהול</div>
      <div style="color:var(--steel);font-size:12px;line-height:1.6;margin-bottom:10px;">${bidiText(`הסיסמה של ${esc(a.mgmt && (a.mgmt.displayName || a.mgmt.email) || "")} תתחלף מיד. החשבון שאיתו אתם מחוברים באפליקציה לא מושפע.`)}</div>
      <form id="mgmtPassword">
        ${field("mgmtPassword", "password", "סיסמה חדשה", `<input class="text-input" name="password" type="password" dir="ltr" autocomplete="new-password" placeholder="${esc(PASSWORD_RULE_TEXT)}" required/>`)}
        ${field("mgmtPassword", "passwordConfirm", "אימות סיסמה", `<input class="text-input" name="passwordConfirm" type="password" dir="ltr" autocomplete="new-password" placeholder="שוב, לאימות" required/>`)}
        <div class="chip-row" style="margin-top:12px;">
          <button class="save-btn" type="submit"${a.mgmtPasswordBusy ? " disabled" : ""} style="flex:1;">${a.mgmtPasswordBusy ? "שומרים…" : "שמירת הסיסמה"}</button>
          <button class="chip-btn" type="button" data-community-action="mgmt-password-cancel">ביטול</button>
        </div>
      </form>
      ${a.mgmtPasswordError ? `<div class="field-error" role="alert" style="margin-top:10px;">${esc(a.mgmtPasswordError)}</div>` : ""}
      <div class="footer-note" style="margin:10px 0 0;">${bidiText("אם שמרתם את הסיסמה במנהל הסיסמאות של הטלפון, עדכנו אותה גם שם.")}</div>
    </div>`;
  }
  async function mgmtChangePassword(form) {
    if (!mgmtClient || !state.admin.mgmt) return;
    // Same missing guard as panelUnlock() above, same reason - a double click
    // here issued two updateUser calls for one intent.
    if (state.admin.mgmtPasswordBusy) return;
    const password = String(form.elements.password.value || "");
    const confirm = String(form.elements.passwordConfirm.value || "");
    // The same two validators every other password in this app goes through,
    // so the rule is stated once and the management account is held to it
    // rather than being a quiet exception. passwordRuleError() mirrors
    // supabase/config.toml's own minimum, so a member gets this message
    // instead of a raw Supabase rejection.
    const errors = {};
    const ruleError = passwordRuleError(password);
    if (ruleError) errors.password = ruleError;
    if (password !== confirm) errors.passwordConfirm = "הסיסמאות לא תואמות";
    if (Object.keys(errors).length) { state.admin.mgmtPasswordError = ""; return setFieldErrors("mgmtPassword", errors); }

    state.admin.mgmtPasswordBusy = true; state.admin.mgmtPasswordError = ""; rerender();
    // On mgmtClient, so it changes the MANAGEMENT account's password. On
    // `client` it would change the password of the member using the app -
    // which is the single worst thing this feature could do, and the reason
    // the two clients are never interchangeable.
    let error = null;
    try {
      const r = await withCaptcha((captchaToken) =>
        mgmtClient.auth.updateUser({ password }, captchaToken ? { captchaToken } : undefined));
      error = r && r.error ? r.error : null;
    } catch (e) { error = { message: "failed" }; }
    state.admin.mgmtPasswordBusy = false;
    if (error) {
      // Supabase refuses a password identical to the current one, which is a
      // real thing someone will do and deserves its own message rather than a
      // generic failure they cannot act on.
      state.admin.mgmtPasswordError = /same|different from the old/i.test(error.message || "")
        ? "הסיסמה החדשה זהה לנוכחית. בחרו סיסמה אחרת."
        : "שינוי הסיסמה נכשל, נסו שוב";
      rerender();
      return;
    }
    state.admin.mgmtPasswordOpen = false;
    state.admin.mgmtPasswordError = "";
    setFieldErrors("mgmtPassword", {});
    // The panel stays open. updateUser() refreshes the tokens this client
    // already holds rather than invalidating them, so there is no reason to
    // make someone sign in again immediately after proving who they are.
    setMessage("הסיסמה של חשבון הניהול הוחלפה");
    rerender();
  }
  async function panelUnlock(form) {
    if (!configured || !window.supabase) return;
    // ONE ATTEMPT AT A TIME. Live bug hunt, fresh round 1 (2026-09-15), found
    // twice independently: the busy flag was set after the synchronous prelude
    // rather than checked at the top, and the submit button is only disabled
    // by the re-render that follows it - so two real mouse clicks in quick
    // succession (observed: __mockClientCount 1 -> 3) each built their own
    // client and ran a full sign-in plus three profile round trips.
    //
    // The visible outcome was benign, which is what made it worth fixing
    // rather than shrugging at: whichever attempt lost the last-write-wins
    // race on `mgmtClient` was left AUTHENTICATED and unreferenced, and
    // mgmtTeardown() only ever signs out the one client it can still see. A
    // live session nothing can reach is a session nothing can revoke.
    if (state.admin.panelUnlockBusy) return;
    const panel = form.dataset.panel === "club" ? "club" : "admin";
    const typed = String(form.elements.email.value || "").trim().toLowerCase();
    const password = String(form.elements.password.value || "");
    if (!typed || !password) { state.admin.panelUnlockError = "יש להזין שם משתמש או אימייל, וסיסמה"; rerender(); return; }
    // A USERNAME IS ACCEPTED TOO, and this is not a convenience - without it
    // the head coach could not get in at all. That account has no real email
    // address: it signs in as `headcoach`, which the app maps onto a synthetic
    // @members.haimuniya.invalid address (usernameToEmail), exactly as it does
    // for every member. Demanding the synthetic form here would mean asking
    // someone to type an address that does not exist and that they have never
    // been shown. The admin account is the other case - it has a real mailbox,
    // because it is the one that has to be able to receive a password reset -
    // so both forms have to work. The "@" test is the same one login() uses.
    const email = typed.includes("@") ? typed : usernameToEmail(typed);
    state.admin.panelUnlockBusy = panel; state.admin.panelUnlockError = ""; rerender();

    // A FRESH client per attempt, discarded on every failure path below. Not
    // reused across attempts: a client that half-signed-in on a previous try
    // could otherwise carry a stale session into this one.
    const c = makeMgmtClient();
    if (!c) { state.admin.panelUnlockBusy = ""; state.admin.panelUnlockError = "לא ניתן להתחבר כרגע"; rerender(); return; }

    let uid = null;
    try {
      const { data, error } = await c.auth.signInWithPassword({ email, password });
      if (!error && data && data.user) uid = data.user.id;
    } catch (e) { uid = null; }
    if (!uid) {
      // One message for wrong credentials and for a failed request alike: an
      // error that told them apart would tell someone probing a borrowed
      // phone which half they had already got right.
      //
      // The member's session is untouched on this path - a failed sign-in on
      // a DIFFERENT client cannot sign anyone out of `client`, which is the
      // structural reason the old same-account step-up had to be careful here
      // and this one does not.
      try { await c.auth.signOut(); } catch (e) {}
      state.admin.panelUnlockBusy = "";
      state.admin.panelUnlockError = "שם המשתמש או הסיסמה שגויים";
      rerender();
      return;
    }

    // Signed in. Now ask the SERVER what this account may do, through the
    // management client, so the answer is about the management account and
    // carries its JWT. profiles/invite_redemptions/my_permissions are the
    // same three sources the member path uses (loadProfile, loadRedemption,
    // loadPermissions) - read here rather than reused, because those three
    // write into state.profile/state.redemption/state.permissions, which
    // must keep describing the member.
    let prof = null, redemption = null, perms = [];
    try {
      const [{ data: p }, { data: r }, { data: pm }] = await Promise.all([
        c.from("profiles").select("id,display_name,handle,is_admin").eq("id", uid).maybeSingle(),
        c.from("invite_redemptions").select("role").eq("user_id", uid).maybeSingle(),
        c.rpc("my_permissions"),
      ]);
      prof = p || null; redemption = r || null; perms = Array.isArray(pm) ? pm : [];
    } catch (e) { prof = null; }

    const role = redemption && redemption.role ? String(redemption.role) : "";
    const acctIsAdmin = !!(prof && prof.is_admin) || role === "admin" || role === "owner";
    const acctIsStaff = acctIsAdmin || role === "coach" || role === "head_coach";
    // The panel decides against the account that just signed in, not against
    // the member. Admin panel needs admin; club panel needs staff.
    const allowed = panel === "admin" ? acctIsAdmin : acctIsStaff;
    if (!prof || !allowed) {
      // Correct password, wrong account. Said plainly - this is not a
      // credential-probing signal, it is a real person who typed the wrong
      // one of their two management logins, and telling them so is the
      // difference between a five-second fix and a support call.
      try { await c.auth.signOut(); } catch (e) {}
      state.admin.panelUnlockBusy = "";
      state.admin.panelUnlockError = prof ? PANEL_UNLOCK_COPY[panel].denied : "לא ניתן לאמת את חשבון הניהול";
      rerender();
      return;
    }

    // Belt and braces behind the guard above: never overwrite a live client
    // without revoking it first. If one is somehow still here, it is an
    // attempt that raced past the guard, and dropping the reference would
    // strand its session exactly as described there.
    if (mgmtClient && mgmtClient !== c) { const prev = mgmtClient; try { prev.auth.signOut(); } catch (e) {} }
    mgmtClient = c;
    state.admin.mgmt = {
      email, userId: uid, displayName: (prof.display_name || prof.handle || ""),
      isAdmin: acctIsAdmin, isStaff: acctIsStaff, role, perms,
    };
    state.admin.panelUnlockBusy = "";
    state.admin.panelUnlockError = "";
    try { localStorage.setItem(MGMT_ACCOUNT_KEY, typed); } catch (e) {}
    // EVERY PANEL THIS ACCOUNT MAY OPEN, not only the one that was asked for.
    //
    // This was per-panel, on the reasoning that unlocking the club must not
    // silently hand over the app. That reasoning belonged to the OLD design,
    // where the lock was a step-up on the member's own password and the two
    // panels could be held by two different people on one account.
    //
    // It does not survive the move to a separate identity. What stands here
    // now is a real authentication as a specific account, and that account's
    // entitlements are not a matter of which door it happened to knock on.
    // Asking the same person for the same credentials a second time, to reach
    // a panel the session already proves they may use, protects nothing - it
    // is a second password prompt whose only possible answer is the one just
    // given. On a phone it is pure friction, and friction on a security
    // control is how the control ends up disabled.
    //
    // The entitlement still decides: an account that is staff but not admin
    // gets the club window and a zero for the app, so the app panel stays
    // locked and says why. The separation that matters - between the two
    // JOBS - is preserved exactly; what is gone is a second login for one
    // person who has already proved who they are.
    const until = Date.now() + ADMIN_UNLOCK_MINUTES * 60 * 1000;
    state.admin.panelUnlockedUntil = {
      admin: acctIsAdmin ? until : 0,
      club: acctIsStaff ? until : 0,
    };
    rerender();
  }
  function renderBugReports() {
    if (!isStaff()) return `<div class="empty">אין לך הרשאה לצפות בדיווחי תקלות.</div>`;
    const a = state.admin;
    const filters = ["open", "in_progress", "resolved", "wont_fix", "all"].map((st) =>
      `<button class="chip-btn${a.bugsStatus === st ? " selected" : ""}" data-community-action="bugs-filter" data-status="${esc(st)}">${esc(st === "all" ? "הכול" : BUG_STATUS_LABELS[st])}</button>`).join("");
    let body;
    if (a.bugsLoading && !a.bugsLoaded) body = `<div class="empty">טוען דיווחים…</div>`;
    else if (a.bugsError) body = `<div class="empty">לא ניתן לטעון דיווחים.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="bugs-retry">ניסיון חוזר</button></div></div>`;
    else if (!a.bugsLoaded) body = `<div class="empty">טוען דיווחים…</div>`;
    else if (!a.bugs.length) body = `<div class="empty">${a.bugsStatus === "open" ? "אין דיווחים פתוחים." : "אין דיווחים בסטטוס הזה."}</div>`;
    else body = a.bugs.map((b) => {
      const who = b.reporter_display_name || b.reporter_handle || "חבר/ה שהחשבון שלו/ה נמחק";
      const saving = a.bugsSaving === b.id;
      // Only an admin may act; a coach reads. Mirrors the server, which
      // gates the read on is_staff() and the write on is_admin().
      const actions = isAdmin() ? `<div class="chip-row" style="margin-top:8px;">${
        ["open", "in_progress", "resolved", "wont_fix"].filter((st) => st !== b.status).map((st) =>
          `<button class="chip-btn${st === "resolved" ? " primary" : ""}"${saving ? " disabled" : ""} data-community-action="bugs-set-status" data-id="${esc(b.id)}" data-status="${esc(st)}">${esc(BUG_STATUS_LABELS[st])}</button>`).join("")
      }</div>` : "";
      return `<div class="chart-card" style="margin-bottom:10px;" data-bug-report-id="${esc(b.id)}">
        <div class="flex" style="justify-content:space-between;align-items:flex-start;gap:10px;">
          <div style="min-width:0;">
            <div style="font-weight:800;">${bidiText(who)}</div>
            <div style="color:var(--steel);font-size:12px;margin-top:2px;">${esc(shortHebDate(b.created_at))}</div>
          </div>
          <span class="admin-tag"${b.status === "open" ? ` style="background:rgba(194,57,44,.12);border-color:var(--red);color:var(--red-text);"` : ""}>${esc(BUG_STATUS_LABELS[b.status] || b.status)}</span>
        </div>
        <div style="margin-top:8px;white-space:pre-wrap;word-break:break-word;">${bidiText(b.body || "")}</div>
        ${bugDiagnosticsHtml(b.diagnostics)}
        ${b.admin_note ? `<div class="footer-note" style="margin:8px 0 0;">${bidiText(`הערה פנימית: ${b.admin_note}`)}</div>` : ""}
        ${actions}
      </div>`;
    }).join("");
    return `<div class="chip-row" style="margin:0 0 10px;">${filters}</div>${body}`;
  }
  function renderAuditLog() {
    // is_admin(), not ANALYTICS_VIEW. 202609150004 re-gated admin_actions_page()
    // from has_perm('community.analytics.view') to is_admin(), because the audit
    // log is not analytics and leaving it on that permission meant granting
    // head_coach analytics handed them the record of their own actions. This
    // client check was left on the old permission - latent rather than live,
    // since the audit AREA is only rendered in admin mode, but a client gate
    // that disagrees with its server gate is a trap for whoever renders this
    // function somewhere else. Matched to the server deliberately.
    if (!isAdmin()) return "";
    const selected = state.admin.auditFilters.action_type;
    const restTypes = AUDIT_ACTION_TYPES.filter((t) => !AUDIT_COMMON_TYPES.includes(t));
    const auditChip = (t) => `<button class="chip-btn${selected === t ? " selected" : ""}" data-community-action="audit-filter" data-type="${t}">${auditActionLabel(t)}</button>`;
    const filterChips = `<div class="chip-row" style="margin:0 0 10px;">
      <button class="chip-btn${!selected ? " selected" : ""}" data-community-action="audit-filter" data-type="">הכול</button>
      ${AUDIT_COMMON_TYPES.map(auditChip).join("")}
    </div>
    <details style="margin:0 0 10px;"${selected && restTypes.includes(selected) ? " open" : ""}>
      <summary class="link-btn" style="cursor:pointer;">עוד סינונים</summary>
      <div class="chip-row" style="margin-top:8px;">${restTypes.map(auditChip).join("")}</div>
    </details>`;
    let body;
    if (state.admin.auditLoading && !state.admin.auditLog.length) {
      body = `<div class="log-list" aria-busy="true">${`<div class="log-row" aria-hidden="true"><span style="height:12px;width:55%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`.repeat(4)}</div>`;
    } else if (state.admin.auditError && !state.admin.auditLog.length) {
      body = `<div class="empty">לא ניתן היה לטעון את היומן.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="audit-retry">ניסיון חוזר</button></div></div>`;
    } else if (!state.admin.auditLog.length) {
      body = `<div class="empty">עדיין לא נרשמו פעולות ניהול.</div>`;
    } else {
      const grouped = groupConsecutiveAuditActions(state.admin.auditLog);
      body = `<div class="log-list">${grouped.map((a) => `<div class="log-row" style="flex-direction:column;align-items:flex-start;gap:3px;">
        <div style="font-weight:700;">${esc(auditActionLabel(a.action_type))} · ${esc(auditTargetLabel(a.target_type))}${a.count > 1 ? ` <span class="mono" style="color:var(--steel);font-weight:400;">× ${a.count}</span>` : ""}</div>
        <div style="color:var(--steel);font-size:11px;">${esc(auditActorName(a.admin_id))} · ${relativeTime(a.created_at)}</div>
      </div>`).join("")}</div>${state.admin.auditEnd ? "" : `<div class="chip-row" style="justify-content:center;margin-top:8px;"><button class="chip-btn" data-community-action="audit-more"${state.admin.auditLoading ? " disabled" : ""}>${state.admin.auditLoading ? "טוען…" : "טעינת עוד"}</button></div>`}`;
    }
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--steel)", "יומן פעולות ניהול", true)}${filterChips}${body}</div>`;
  }
  function memberRoleLabel(m) {
    if (m.is_admin) return "מנהל/ת";
    return roleCodeLabel(m.role) || (m.role === "member" ? "חבר/ה" : "לא הצטרף/ה עדיין");
  }
  // COMM-156. member -> coach and coach -> member keep the original
  // dedicated controls. head_coach is the added selectable role. `readOnly`
  // (COMM-377) renders the exact same buttons, disabled, with a tooltip -
  // for a staff viewer who is not a real admin, browsing the roster - rather
  // than a second control set: the server-side boundary (admin_grant_coach/
  // admin_revoke_coach's own inline is_admin()) is unchanged either way,
  // this only decides whether the control looks clickable.
  function memberRoleButtonsHtml(m, readOnly) {
    const role = m.role || "member";
    const dis = readOnly ? ' disabled title="שינוי הרשאה זמין למנהל/ת בלבד"' : "";
    const btns = [];
    if (role === "coach" || role === "head_coach") {
      btns.push(`<button class="chip-btn"${dis} data-community-action="admin-revoke-coach" data-id="${esc(m.id)}">ביטול הרשאת מאמן/ת</button>`);
    } else {
      btns.push(`<button class="chip-btn"${dis} data-community-action="admin-grant-coach" data-id="${esc(m.id)}">הענקת הרשאת מאמן/ת</button>`);
    }
    if (role !== "head_coach") {
      btns.push(`<button class="chip-btn"${dis} data-community-action="admin-set-role" data-id="${esc(m.id)}" data-role="head_coach">הפיכה למאמן/ת ראשי/ת</button>`);
    } else {
      btns.push(`<button class="chip-btn"${dis} data-community-action="admin-set-role" data-id="${esc(m.id)}" data-role="coach">הורדה למאמן/ת</button>`);
    }
    // Same touch-screen defect the ghost-reclaim button had (real device
    // report, 2026-09-15): `dis` carries the only explanation in a `title`,
    // which never appears on a phone, so a staff-but-not-admin viewer sees
    // two greyed buttons and no reason. One note for the row, not one per
    // button - the reason is identical for all of them.
    if (readOnly) btns.push(`<div class="footer-note" style="margin:6px 0 0;width:100%;">שינוי הרשאה זמין למנהל/ת בלבד.</div>`);
    return btns.join("");
  }
  // COMM-377. The exact row shape and renderer admin_search_members'
  // results already use, shared verbatim with the roster's own rows
  // (admin_member_roster returns the identical eight columns, pgTAP 0060's
  // own assertion) - no second row template. `opts.readOnly` disables the
  // role buttons (a staff-but-not-admin roster viewer); `opts.showRemove`
  // (default true) is the CALLER's half of whether the destructive
  // remove-member control is drawn, and canRemoveMember() is the other half
  // - permission plus a target strictly below the viewer's own rank.
  //
  // The roster passed showRemove:false from COMM-377 until 202609160005, on
  // that ticket's reading that removal belonged only to the search panel
  // below. That made the roster read-only for the one role that needs it:
  // the search panel is inside renderMemberManagement(), which returns ""
  // for anyone who is not is_admin(), so a head coach had no removal surface
  // at all. The roster is now both halves of the job - browse the club, and
  // take someone off it - and the rank guard is what makes that safe.
  // `last_activity_on` here comes from admin_member_roster /
  // admin_search_members, both of which read activity_pings - days the member
  // OPENED THE APP, not days they trained. This row used to render a null as
  // "מעולם לא" ("never"), the same false assertion 202609060020 removed from
  // the coach lists: a member with no ping row is a member we have no data
  // about, which is a fact about our records and not about them. The label
  // now names the app, and the empty case says so.
  //
  // THE RESET BUTTON'S DISABLED REASON IS THE THIRD COPY OF ONE DEFECT.
  // `title` is invisible on a touch screen, which is every screen this app
  // ships to. ghostRowHtml() was fixed for that first (real device
  // report, 2026-09-15), memberRoleButtonsHtml() above second, and the
  // reset button at the bottom of this row was missed both times although
  // it sits in the same row and is disabled by the same readOnly flag - so
  // a head coach browsing the roster saw one greyed control with a reason
  // and another right under it with none, which reads as a broken button
  // rather than as a boundary. Its note now uses the same .footer-note
  // element, class and placement as the role note, so the two cannot look
  // like different kinds of message.
  function memberManagementRowHtml(m, opts) {
    opts = opts || {};
    const readOnly = !!opts.readOnly;
    const showRemove = opts.showRemove !== false;
    return `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:6px;">
      <div class="flex gap-10" style="align-items:center;">${avatarHtml(m.display_name || m.handle, 32, m.avatar_url)}<div><div style="font-weight:700;">${nameHtml(m.display_name, m.handle)}${isCoachRole(m.role) ? " " + coachBadgeHtml(m.role) : ""}</div><div style="color:var(--steel);font-size:11px;"><bdi>@${esc(m.handle)}</bdi> · ${memberRoleLabel(m)}</div></div></div>
      <div style="color:var(--steel);font-size:11px;">הצטרף/ה: ${m.redeemed_at ? esc(shortHebDate(m.redeemed_at)) : "—"} · פעילות אחרונה באפליקציה: ${m.last_activity_on ? esc(m.last_activity_on) : "אין נתונים"}</div>
      <div class="footer-note" style="margin:0;font-size:10.5px;">${esc(m.id)}</div>
      ${m.is_admin ? "" : `<div class="chip-row" style="margin-top:0;">
        ${memberRoleButtonsHtml(m, readOnly)}
        ${showRemove && canRemoveMember(m) ? `<button class="chip-btn danger" data-community-action="admin-remove-member" data-id="${esc(m.id)}">הסרת חבר/ה</button>` : ""}
      </div>`}
      <div class="chip-row" style="margin-top:0;">
        <button class="chip-btn"${readOnly ? ' disabled title="זמין למנהל/ת בלבד"' : ""} data-community-action="admin-reset-password" data-id="${esc(m.id)}">איפוס סיסמה</button>
        ${readOnly ? `<div class="footer-note" style="margin:6px 0 0;width:100%;">איפוס סיסמה זמין למנהל/ת בלבד.</div>` : ""}
      </div>
    </div>`;
  }
  // ONE REVEAL SLOT, SO ONE RENDERER. state.admin.passwordResetResult is a
  // single slot by design (adminResetPassword() refuses to overwrite an
  // unread one), and the card that reveals it is now drawn from two places:
  // this club-panel section, and renderPasswordResetPanel() on the system
  // admin panel. Copying the markup would have been the fourth instance of
  // this repository's characteristic defect in one file - and the copy that
  // drifts is the one showing a one-time secret without saying whose it is,
  // which is the exact bug the name on this card was added to fix.
  //
  // Both panels never render at once (renderManagePanel draws one mode), so
  // there is no question of two cards for one slot.
  function passwordResetResultHtml() {
    const pr = state.admin.passwordResetResult;
    if (!pr) return "";
    return `<div class="chart-card" style="margin-bottom:10px;border:1px solid var(--brass);" data-password-reset-created="1">
      <div class="field-label" style="margin-bottom:4px;">${bidiText(`הסיסמה של ${pr.name || "חבר/ה"} אופסה — זו הפעם היחידה שהיא תוצג. מסרו אותה ישירות.`)}</div>
      <div class="flex gap-10" style="align-items:center;flex-wrap:wrap;">
        <code class="mono" style="font-size:15px;">${esc(pr.tempPassword)}</code>
        <button class="chip-btn" data-community-action="copy-invite-code" data-code="${esc(pr.tempPassword)}">העתקה</button>
        <button class="link-btn" data-community-action="close-password-reset-result">סגירה</button>
      </div>
    </div>`;
  }
  // COMM-379. THE CONTROL THE SPLIT LEFT WITH NOBODY.
  //
  // renderManagePanel()'s own division of labour is explicit: "ADMIN runs
  // the APP - bug reports, the audit log, who holds which role, password
  // resets, and which modules are switched on." Password resets were named
  // in that list and never moved. They live inside renderMemberManagement()
  // below, which is rendered only from the CLUB panel's "המועדון" tab - and
  // that function then self-gates on isAdmin(), so on the club panel a head
  // coach cannot see it and on the admin panel nobody renders it at all.
  // The one control the design assigned to the admin was the one control
  // the admin had no screen for; the only way to reach it was to hold the
  // club role as well and go looking on the other panel.
  //
  // Everything here is the existing path, reached from a new place:
  // admin_search_members through searchMembers() (the same state.members
  // slice, the same debounce), the same data-community-action that opens
  // the same askConfirm() dialog, adminResetPassword() unchanged, and
  // passwordResetResultHtml() above for the reveal. No new RPC, no new
  // permission, no second copy of anything.
  //
  // DELIBERATELY RESET-ONLY, not memberManagementRowHtml(). That row also
  // carries grant/promote/demote/remove, and this section is answering one
  // question - "which member has lost their password" - on a panel whose
  // whole premise is that running the club is somebody else's job. A row
  // with five controls would have re-imported the club panel into the admin
  // panel by the back door. The role controls are a real second gap and are
  // called out in the PR rather than fixed here; they are a different
  // decision from this one.
  function renderPasswordResetPanel() {
    if (!isAdmin()) return "";
    const results = state.members.results;
    const typed = state.members.search.trim();
    const rows = results.map((m) => `<div class="log-row" style="justify-content:space-between;gap:10px;align-items:center;">
      <span style="min-width:0;">
        <span style="font-weight:700;">${nameHtml(m.display_name, m.handle)}</span>
        <span style="color:var(--steel);font-size:11px;"> · <bdi>@${esc(m.handle)}</bdi> · ${memberRoleLabel(m)}</span>
      </span>
      <button class="chip-btn" data-community-action="admin-reset-password" data-id="${esc(m.id)}">איפוס סיסמה</button>
    </div>`).join("");
    const body = results.length
      ? `<div class="log-list">${rows}</div>`
      : typed.length >= 2
        ? `<div class="empty">לא נמצאו חברים תואמים</div>`
        : `<div class="empty">חיפוש לפי handle, שם, או מזהה משתמש (UUID)</div>`;
    return `<div class="ach-section" style="margin-top:18px;" data-password-reset-panel="1">${sectionHead("var(--brass)", "איפוס סיסמה לחבר/ה", true)}
      <div style="color:var(--steel);font-size:12px;line-height:1.6;margin-bottom:8px;">${bidiText("הכניסה לאפליקציה היא שם משתמש וסיסמה בלבד - אין כתובת מייל אמיתית לשלוח אליה קישור איפוס, ולכן האיפוס נעשה כאן. נוצרת סיסמה זמנית שמוצגת פעם אחת בלבד, ויש למסור אותה לחבר/ה ישירות.")}</div>
      ${passwordResetResultHtml()}
      <div class="search-box"><input id="adminPasswordResetSearch" placeholder="חיפוש לפי handle, שם, או הדבקת מזהה משתמש" aria-label="חיפוש חבר/ה לאיפוס סיסמה" value="${esc(state.members.search)}"/></div>
      ${body}
    </div>`;
  }
  function renderMemberManagement() {
    if (!isAdmin()) return "";
    const results = state.members.results;
    const passwordResetHtml = passwordResetResultHtml();
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--purple)", "ניהול חברים", true)}
      ${passwordResetHtml}
      <div class="search-box"><input id="adminMemberSearch" placeholder="חיפוש לפי handle, שם, או הדבקת מזהה משתמש" aria-label="חיפוש חברים לניהול" value="${esc(state.members.search)}"/></div>
      ${results.length ? `<div class="log-list">${results.map((m) => memberManagementRowHtml(m, { readOnly: false, showRemove: true })).join("")}</div>` : state.members.search.trim().length >= 2 ? `<div class="empty">לא נמצאו חברים תואמים</div>` : `<div class="empty">חיפוש לפי handle, שם, או מזהה משתמש (UUID)</div>`}
    </div>`;
  }
  // ---- COMM-377. Member roster -------------------------------------------
  // A new browse entry point onto the SAME member-management area
  // renderMemberManagement() already offers by search - not a second
  // implementation. Read gate is is_staff() (admin_member_roster's own
  // AUTH), deliberately looser than renderMemberManagement()'s is_admin():
  // a coach may browse every row and act on none, via the readOnly role
  // buttons above.
  const ROSTER_PAGE_SIZE = 25;
  async function loadRoster(reset) {
    if (!state.user || !isStaff()) { state.admin.roster.items = []; return; }
    const r = state.admin.roster;
    if (reset) { r.items = []; r.cursor = null; r.cursorId = null; r.end = false; r.loading = true; } else { r.loadingMore = true; }
    r.error = false; rerender();
    const { data, error } = await mgmtDb().rpc("admin_member_roster", { p_cursor: r.cursor, p_cursor_id: r.cursorId || null, p_limit: ROSTER_PAGE_SIZE });
    r.loading = false; r.loadingMore = false; r.loaded = true;
    if (error) { r.error = true; rerender(); return; }
    const page = Array.isArray(data) ? data : [];
    r.items = reset ? page : r.items.concat(page);
    const last = page[page.length - 1];
    // 202609180001 CLOSED THE GAP that was flagged here and in
    // docs/community/backlog.md's COMM-377 paragraph. admin_member_roster
    // sorts and pages on coalesce(invite_redemptions.redeemed_at,
    // profiles.created_at) and used to return only redeemed_at, so a profile
    // with no invite_redemptions row (mid-signup, or a pre-invite-gate legacy
    // account) sorted on a created_at this client never saw and pagination
    // had to stop one page early - resending a null cursor would not advance,
    // since the RPC reads a null p_cursor as "no bound at all" and restarts
    // from the very top. The RPC now returns that coalesced value as
    // sort_key, so the cursor is simply that.
    //
    // The redeemed_at fallback is the un-migrated-server case, not a second
    // rule: a client that ships ahead of its migrations finds sort_key
    // undefined and behaves exactly as it did before, stopping at a
    // null-redeemed_at boundary row rather than looping. Nothing shown is
    // ever wrong in either direction, which is why the two halves can deploy
    // in either order.
    const lastSortKey = last ? (last.sort_key != null ? last.sort_key : last.redeemed_at) : null;
    r.end = page.length < ROSTER_PAGE_SIZE || !last || lastSortKey == null;
    r.cursor = last ? lastSortKey : r.cursor;
    // 202609160002: the id half of the cursor. Without it the RPC pages on the
    // join date alone and drops every member sharing the last-shown member's
    // timestamp - the normal case for a club that onboarded in one sitting.
    r.cursorId = last ? (last.id || null) : r.cursorId;
    rerender();
  }
  // Fresh-eyes audit: an admin-persona review scrolled a ~15-member roster
  // by hand looking for one member, unaware "ניהול חברים" above this
  // section already searches (admin_search_members) - a real feature, just
  // disconnected from the plain browse list it sits next to, and admin-only
  // besides, so a coach viewing this SAME roster had no search at all. A
  // client-side filter over whatever pages are already loaded fixes the
  // actual roster a viewer is looking at, for coach and admin alike, with
  // no new permission surface - it only ever filters what is_staff() (or
  // is_admin()'s admin_search_members) already legitimately returned to
  // this session. Filters loaded pages only; "טעינת עוד" still exists for
  // a club whose member the search hasn't reached yet.
  function rosterSearchMatches(m, q) {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return (m.display_name || "").toLowerCase().includes(needle) || (m.handle || "").toLowerCase().includes(needle);
  }
  function renderMemberRoster() {
    if (!isStaff()) return "";
    const r = state.admin.roster;
    let body;
    if (r.loading && !r.items.length) {
      const skRow = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:55%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
      body = `<div class="log-list" aria-busy="true" data-member-roster-skeleton="1">${skRow.repeat(4)}</div>`;
    } else if (r.error && !r.items.length) {
      body = `<div class="empty">לא ניתן היה לטעון את רשימת החברים.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="roster-retry">ניסיון חוזר</button></div></div>`;
    } else {
      const readOnly = !isAdmin();
      // COMM-377's own rule (see the zero-row-page test below) is that an
      // empty ROSTER never gets a special empty message - only the section
      // header. A search that matches nothing among what IS loaded is a
      // different case (the data is real, the filter just excluded all of
      // it), so only THAT gets an empty-state line.
      const filtered = r.items.filter((m) => rosterSearchMatches(m, r.search || ""));
      const searching = !!(r.search || "").trim();
      const list = filtered.length
        ? `<div class="log-list">${filtered.map((m) => memberManagementRowHtml(m, { readOnly, showRemove: true })).join("")}</div>`
        : (searching ? `<div class="empty">לא נמצאו חברים תואמים בין החברים שכבר נטענו</div>` : "");
      body = `${list}${r.end ? "" : `<div class="chip-row" style="justify-content:center;margin-top:8px;"><button class="chip-btn" data-community-action="roster-more"${r.loadingMore ? " disabled" : ""}>${r.loadingMore ? "טוען…" : "טעינת עוד"}</button></div>`}`;
    }
    const searchBox = r.items.length || r.search
      ? `<div class="search-box"><input id="rosterSearch" placeholder="חיפוש ברשימה הטעונה, לפי שם או handle" aria-label="חיפוש ברשימת החברים" value="${esc(r.search || "")}"/></div>`
      : "";
    return `<div class="ach-section" style="margin-top:18px;" data-member-roster-section="1">${sectionHead("var(--teal)", "רשימת חברים", true)}${searchBox}${body}</div>`;
  }
  // ==========================================================================
  // Five-persona UX audit, defect 3. Incomplete signups ("ghost accounts"),
  // the client half of migration 202609060023.
  //
  // WHAT THESE ARE, because nobody meeting this list has seen them before.
  // Signup is two-stage and the stages are separated by a three-slide intro
  // carousel: redeem_invite_code() consumes the invite and creates the real
  // auth.users account, and the public.profiles row is written only after the
  // carousel. Close the tab in between and what is left is a real
  // authenticated account holding a spent invite with no profiles row at all.
  //
  // Every roster surface in this module starts `from public.profiles`
  // (admin_member_roster, admin_search_members, admin_user_directory), so a
  // row that does not exist cannot be listed by any of them: the club can see
  // that four invites went missing and has no way to find out whose they
  // were. registration_funnel can see the SHAPE of the gap and names nobody.
  // Until this section existed the only way to look was the Supabase SQL
  // editor, which defeats the purpose of having an admin screen at all.
  //
  // TWO GATES, DELIBERATELY DIFFERENT, and this UI has to show both:
  //   * LISTING is is_staff() - admin_member_roster's own read-only browse
  //     rank. A coach chasing a member who never appeared is the obvious
  //     first user of it.
  //   * RECLAIMING is a real profiles.is_admin, the same rank
  //     admin_remove_member takes, because it un-memberships an account.
  // A coach therefore sees every row and is offered NO reclaim control -
  // not a disabled one. The roster above disables its role buttons for a
  // coach because those controls belong to a screen a coach does legitimately
  // share; here there is no path from a coach to this action at all, and a
  // greyed-out button would imply one they simply have not found yet.
  const GHOST_PAGE_SIZE = 25;
  // admin_reclaim_invite's own p_older_than_days default, which the server
  // ALSO floors at 1 so no caller can shorten it to "right now". Mirrored
  // here only to disable a control that cannot succeed and to say why; the
  // server refuses regardless, and its named refusal is what the sheet
  // reports if this client-side mirror is ever wrong.
  const GHOST_GRACE_DAYS = 7;
  async function loadIncompleteSignups(reset) {
    if (!state.user || !isStaff()) { state.admin.incompleteSignups.items = []; return; }
    const g = state.admin.incompleteSignups;
    if (reset) { g.items = []; g.cursor = null; g.cursorId = null; g.end = false; g.loading = true; } else { g.loadingMore = true; }
    g.error = false; rerender();
    const { data, error } = await mgmtDb().rpc("admin_incomplete_signups", { p_cursor: g.cursor, p_cursor_id: g.cursorId || null, p_limit: GHOST_PAGE_SIZE });
    g.loading = false; g.loadingMore = false; g.loaded = true;
    if (error) { g.error = true; rerender(); return; }
    const page = Array.isArray(data) ? data : [];
    g.items = reset ? page : g.items.concat(page);
    const last = page[page.length - 1];
    // admin_incomplete_signups pages backwards on invite_redemptions.redeemed_at
    // and INNER JOINs that table, so unlike admin_member_roster (see
    // loadRoster's own GAP comment) redeemed_at can never come back null here.
    // The same guard is kept anyway and costs nothing: the RPC reads a null
    // p_cursor as "no bound at all" and would restart from the very top,
    // looping the same page forever rather than paging.
    g.end = page.length < GHOST_PAGE_SIZE || !last || last.redeemed_at == null;
    g.cursor = last ? last.redeemed_at : g.cursor;
    g.cursorId = last ? (last.user_id || null) : g.cursorId; // see loadRoster (202609160002)
    rerender();
  }
  // The ONLY two identifying strings a ghost has, in the order they come to
  // exist. `username` is the local part of the synthetic login address this
  // app mints (usernameToEmail) and exists only once they reached the
  // credentials slide; `label` is the admin-authored label on the per-person
  // invite ("דנה מהבוקר של שני"), which for someone who abandoned BEFORE
  // credentials is the sole identifying string anywhere in the system. There
  // is no display name and no handle - those live on profiles, which is
  // exactly the row that was never written, and that is the whole point.
  //
  // Neither is guaranteed: a shared code abandoned on the username slide
  // leaves nothing at all. That row says so plainly rather than rendering a
  // blank line where a name should be.
  function ghostName(g) { return (g && (g.username || g.label)) || ""; }
  function ghostDisplayName(g) { return ghostName(g) || "הרשמה ללא שם"; }
  function ghostSourceLabel(source) {
    return source === "person_invite" ? "הזמנה אישית" : "קוד הצטרפות משותף";
  }
  function ghostStalledText(days) {
    const d = Number(days || 0);
    if (d <= 0) return "התחיל/ה היום";
    if (d === 1) return "תקוע/ה יום אחד";
    return `תקוע/ה ${d} ימים`;
  }
  // What happens to the ACCOUNT, stated per row rather than once for the
  // section, because the two answers are genuinely different and an admin
  // cannot infer which one they are looking at.
  //
  // purgeable_after_reclaim is auth.users.is_anonymous - whether
  // purge_abandoned_profiles() would ever collect this account once the
  // reclaim removes the redemption row that currently disqualifies it.
  // CHOOSING A USERNAME AND PASSWORD FLIPS IT TO FALSE, verified against a
  // real ghost made through the real signup flow. So for the COMMON ghost -
  // someone who got as far as credentials and then abandoned the carousel -
  // the empty account is never collected by anything and simply persists. A
  // blanket "it will be cleaned up later" would be false for exactly the case
  // an admin meets most often, and this audit has already found two screens
  // asserting things that were not true. The false branch says so out loud
  // instead of merely omitting the reassurance.
  function ghostAfterwardsText(g) {
    return g.purgeable_after_reclaim
      ? "אחרי השחרור החשבון הריק ייאסף בהמשך על ידי ניקוי החשבונות הנטושים."
      : "החשבון הזה יישאר קיים גם אחרי השחרור, ולא יימחק מעצמו - כבר נבחרו לו שם משתמש וסיסמה.";
  }
  function ghostRowHtml(g, admin) {
    const stalled = Number(g.stalled_days || 0);
    const ready = stalled >= GHOST_GRACE_DAYS;
    // Both identifiers when both exist: the label is what the admin typed
    // when they created the invite, and it is often the only thing that turns
    // a username back into a person they remember.
    const secondary = g.username && g.label
      ? `<div style="color:var(--steel);font-size:12.5px;margin-top:2px;">${bidiText(`תווית ההזמנה: ${g.label}`)}</div>` : "";
    const meta = [ghostSourceLabel(g.invite_source), ghostStalledText(stalled), `מימש/ה ${shortHebDate(g.redeemed_at)}`];
    const control = !admin
      ? `<div class="footer-note" style="margin:10px 0 0;">שחרור ההזמנה שמור למנהל/ת.</div>`
      // Real device report (2026-09-15): an admin tapped this button on a
      // phone, nothing happened, and they reported it as broken. It was not
      // broken - stalled was 6 and GHOST_GRACE_DAYS is 7, so `disabled` is
      // exactly right. The defect is that the ONLY explanation lived in a
      // `title`, and a touch screen has no hover, so the button read as dead
      // rather than as not-yet. The "עדיין בתהליך" tag above says the state
      // but not the rule, and the rule is the part that tells the admin to
      // come back tomorrow instead of filing a bug. Printed as visible text
      // now, the same way a locked medal prints its rule; the title stays for
      // desktop hover, but nothing depends on it any more.
      : `<div class="chip-row" style="margin-top:10px;">
          <button class="chip-btn danger"${ready ? "" : ` disabled title="${esc(`אפשר לשחרר רק אחרי ${GHOST_GRACE_DAYS} ימים ללא השלמה`)}"`} data-community-action="ghost-reclaim" data-id="${esc(g.user_id)}">שחרור ההזמנה</button>
        </div>
        ${ready ? "" : `<div class="footer-note" style="margin:6px 0 0;">${esc(`אפשר לשחרר רק אחרי ${GHOST_GRACE_DAYS} ימים ללא השלמה — עוד ${Math.max(1, GHOST_GRACE_DAYS - stalled) === 1 ? "יום אחד" : `${Math.max(1, GHOST_GRACE_DAYS - stalled)} ימים`}.`)}</div>`}`;
    return `<div class="chart-card" style="margin-bottom:10px;" data-ghost-user-id="${esc(g.user_id)}">
      <div class="flex" style="justify-content:space-between;align-items:flex-start;gap:10px;">
        <div style="min-width:0;">
          <div style="font-weight:800;">${bidiText(ghostDisplayName(g))}</div>
          ${secondary}
        </div>
        <span class="admin-tag"${ready ? ` style="background:rgba(194,57,44,.12);border-color:var(--red);color:var(--red-text);"` : ""}>${ready ? "ניתן לשחרור" : "עדיין בתהליך"}</span>
      </div>
      <div style="color:var(--steel);font-size:12px;margin-top:8px;">${meta.map(bidiText).join(" · ")}</div>
      <div style="color:var(--steel);font-size:12px;margin-top:4px;">${bidiText(ghostAfterwardsText(g))}</div>
      <div class="footer-note" style="margin:6px 0 0;font-size:10.5px;">${esc(g.user_id)}</div>
      ${control}
    </div>`;
  }
  // The explainer. Shown ALWAYS, not only when the list has rows: an admin
  // opening this for the first time has to be able to tell that a list of
  // near-nameless accounts is not an error report and not a wave of spam
  // signups. Plain warm register, and explicit about what reclaiming does NOT
  // do - which is the part an admin will otherwise assume wrongly, in the
  // more alarming direction.
  // Usability pass: three always-visible paragraphs above a list an admin
  // opens to reclaim one stalled invite - real content (the "not spam, not
  // a bug" reassurance matters the first time), but it doesn't need to cost
  // three paragraphs of height on every later visit. Same <details>
  // disclosure renderInviteManagement() already uses for its own rarer
  // option, closed by default; the explanation is one tap away, not gone.
  function ghostExplainerHtml() {
    return `<details style="margin:-2px 0 12px;">
      <summary class="link-btn" style="cursor:pointer;">מה זה?</summary>
      <div style="color:var(--steel);font-size:12.5px;line-height:1.7;margin-top:8px;">
        <div>${bidiText("אלה חשבונות שנעצרו באמצע ההרשמה. מישהו הזין קוד הזמנה והתחיל להירשם, ואז עצר לפני שהשלים פרופיל - סגר את האפליקציה, נקרא לאימון, התחרט. זו לא תקלה ואלה לא חשבונות ספאם.")}</div>
        <div style="margin-top:6px;">${bidiText("בלי פרופיל הם לא מופיעים ברשימת החברים ולא בשום מקום אחר באפליקציה, אבל ההזמנה שלהם כבר נוצלה - ולכן הם כאן.")}</div>
        <div style="margin-top:6px;">${bidiText("שחרור ההזמנה מחזיר אותה למחזור: קוד משותף מקבל בחזרה שימוש אחד, והזמנה אישית חוזרת להמתנה כך שאפשר להשתמש שוב באותו קוד. השחרור לא מוחק את החשבון של מי שהתחיל להירשם, לא שולח לו שום הודעה, ולא מונע ממנו להירשם שוב.")}</div>
      </div>
    </details>`;
  }
  // The result card. admin_reclaim_invite() returns exactly what it did, and
  // an admin who has just taken a destructive-sounding action deserves to
  // read it rather than a bare "done" - especially welcome_posts_retracted,
  // which is a change to the club's own feed that nothing else would tell
  // them about.
  function ghostReclaimResultHtml() {
    const r = state.admin.reclaimResult;
    if (!r) return "";
    const releasedLine = r.invite_source === "person_invite"
      ? "ההזמנה האישית חזרה להמתנה - אפשר להשתמש שוב באותו קוד."
      : "שימוש אחד הוחזר לקוד ההצטרפות המשותף.";
    const posts = Number(r.welcome_posts_retracted || 0);
    const postsLine = posts > 0
      ? `${posts} פוסטי הצטרפות למועדון הוסרו מהפיד.`
      : "לא היה פוסט הצטרפות להסרה.";
    const accountLine = r.purgeable
      ? "החשבון לא נמחק. הוא ריק, ולכן ייאסף בהמשך על ידי ניקוי החשבונות הנטושים."
      : "החשבון לא נמחק והוא יישאר קיים - מי שהתחיל להירשם יכול להיכנס אליו ולהתחיל מחדש עם קוד חדש.";
    return `<div class="chart-card" style="margin-bottom:10px;border:1px solid var(--brass);" data-reclaim-result="1" role="status">
      <div class="field-label" style="margin-bottom:6px;">${bidiText(`ההזמנה של ${r.name} שוחררה`)}</div>
      <div style="color:var(--steel);font-size:12.5px;line-height:1.7;">
        <div>${bidiText(releasedLine)}</div>
        <div>${bidiText(postsLine)}</div>
        <div>${bidiText(accountLine)}</div>
      </div>
      <div class="chip-row" style="margin-top:8px;"><button class="link-btn" data-community-action="reclaim-result-close">סגירה</button></div>
    </div>`;
  }
  function renderIncompleteSignups() {
    if (!isStaff()) return "";
    const g = state.admin.incompleteSignups;
    let body;
    if (g.loading && !g.items.length) {
      const skRow = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:55%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
      body = `<div class="log-list" aria-busy="true" data-incomplete-signups-skeleton="1">${skRow.repeat(3)}</div>`;
    } else if (g.error) {
      body = `<div class="empty">לא ניתן היה לטעון את ההרשמות שלא הושלמו.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="ghosts-retry">ניסיון חוזר</button></div></div>`;
    } else if (!g.items.length) {
      // A real empty state, not a blank area. This is the GOOD outcome and it
      // should read like one - an admin who finds nothing here has learned
      // something, and the screen should say what.
      body = `<div class="empty">אין הרשמות שלא הושלמו<div style="color:var(--steel);font-size:12px;line-height:1.6;margin-top:6px;">${bidiText("כל מי שהזין קוד הזמנה גם השלים פרופיל. אין כרגע הזמנה תקועה אצל אף אחד.")}</div></div>`;
    } else {
      const admin = isAdmin();
      body = `${g.items.map((row) => ghostRowHtml(row, admin)).join("")}${g.end ? "" : `<div class="chip-row" style="justify-content:center;margin-top:8px;"><button class="chip-btn" data-community-action="ghosts-more"${g.loadingMore ? " disabled" : ""}>${g.loadingMore ? "טוען…" : "טעינת עוד"}</button></div>`}`;
    }
    return `<div class="ach-section" style="margin-top:18px;" data-incomplete-signups-section="1">${sectionHead("var(--yellow)", "הרשמות שלא הושלמו", true)}${ghostExplainerHtml()}${ghostReclaimResultHtml()}${body}</div>`;
  }
  // COMM-321 Club Modules. Same gating idiom the other four admin-only
  // account sections already use (renderModeration, renderMemberManagement,
  // renderAdminAnalyticsDashboard, renderAuditLog): `if (!allowed) return ""`
  // at the top, unconditionally appended into accountTab - no dedicated
  // sub-tab, matching this codebase's own precedent that a single admin
  // screen never gets one (only "coach", a whole role tier's toolset, does).
  // Shared row renderer for both groups below - toggleClubFeature() is
  // single-flight (it returns early while state.club.moduleBusy is set), so
  // EVERY row across BOTH groups has to be disabled while any one write is
  // in flight, not just the one being written: leaving the others live let
  // a second tap flip a checkbox that the guard then dropped with no
  // message, and the next rerender silently put it back - which is exactly
  // "the toggles don't work". Same busy/anyBusy split renderMemberOfWeekPickForm
  // already uses: `busy` still labels only the row actually saving.
  // PER ROW, NOT PER GROUP. The group blurb used to carry the whole
  // enforcement story, naming 'directory' as the single client-only
  // exception. That was true for one day. It was already wrong by
  // 202609150014 (five more clientOnly rows), wronger by 202609160004, and
  // 202609190002's seven would have made a prose sentence that has to list
  // eleven exceptions - which is the point at which a sentence stops being
  // read. The marker is on the row it describes now, derived from the same
  // `clientOnly` flag the registry already carried, so it cannot drift from
  // it: there is nothing to keep in sync.
  //
  // "בפיתוח" is the second marker and a different claim. clientOnly says
  // WHERE a switch is enforced; planned says there is nothing behind it to
  // enforce yet. An admin can switch a planned row today - that is what
  // 202609190002 is for - and the row states plainly that doing so changes
  // nothing until the feature lands.
  function clubModuleMarkersHtml(m) {
    const chip = (text, color) => `<span style="font-size:10px;line-height:1.6;color:${color};border:1px solid ${color};border-radius:999px;padding:0 6px;white-space:nowrap;">${esc(text)}</span>`;
    return `${m.planned ? chip("בפיתוח", "var(--brass)") : ""}${chip(m.clientOnly ? "בתצוגה בלבד" : "נאכף בשרת", "var(--steel)")}`;
  }
  // 202609220002. THE FIRST TWO MODULES WITH NUMBERS BEHIND THE SWITCH.
  //
  // club_features.config has existed since 202609010012 and its own comment
  // said "none does today" about modules needing sub-structure. coach_tasks
  // and onboarding_challenge do: their rules are thresholds a club retunes
  // (welcome by day 7? day 5? a goal of 8 sessions or 12?), and a migration
  // per retune is not a thing a gym can do.
  //
  // RENDERED OUTSIDE THE <label>, not inside it. The row is a label wrapping
  // its own checkbox; a second form control inside the same label is invalid
  // HTML and one browser quirk away from a number field that toggles the
  // module when you click it.
  //
  // COLLAPSED, because seven number fields under one switch turn a list of
  // twenty modules into a form nobody reads. Same reasoning the panel's own
  // .manage-area disclosures use.
  //
  // THE SERVER IS THE AUTHORITY ON THE RANGE. min/max here match the clamps
  // club_feature_number() applies in Postgres, and the server clamps whatever
  // arrives regardless - these attributes are a keyboard convenience, not the
  // validation.
  function clubModuleSettingsHtml(m, anyBusy) {
    if (!m.settings || !m.settings.length) return "";
    const row = state.club.features[m.key] || { enabled: true, config: {} };
    const cfg = row.config || {};
    const busy = state.club.configBusy === m.key;
    const fields = m.settings.map((sett) => {
      // The DEFAULT is shown as the placeholder rather than pre-filled into
      // the value, so an admin can tell "nobody has set this, the shipped
      // number applies" from "somebody chose exactly the shipped number".
      // Clearing a field is how you go back to the default.
      const v = Object.prototype.hasOwnProperty.call(cfg, sett.id) && cfg[sett.id] !== null ? String(cfg[sett.id]) : "";
      return `<label class="field" style="margin:0;">
        <span class="field-label" style="font-size:11.5px;">${esc(sett.label)}</span>
        <input class="text-input" type="number" inputmode="numeric" dir="ltr"
               min="${esc(String(sett.min))}" max="${esc(String(sett.max))}"
               placeholder="${esc(String(sett.def))}" value="${esc(v)}"
               data-club-feature-setting="${esc(m.key)}" data-setting-key="${esc(sett.id)}"${anyBusy ? " disabled" : ""}/>
      </label>`;
    }).join("");
    const detailsId = `clubModuleSettings-${m.key}`;
    return `<details class="club-module-settings" id="${detailsId}" data-club-feature-settings="${esc(m.key)}"${state.admin.openAreas[detailsId] ? " open" : ""} style="margin:-4px 0 8px;padding:0 4px;">
      <summary style="cursor:pointer;color:var(--steel);font-size:12px;padding:4px 0;">כיוונון הערכים</summary>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin:6px 0;">${fields}</div>
      <div style="color:var(--steel);font-size:11.5px;line-height:1.6;margin-bottom:6px;">${bidiText("שדה ריק = ערך ברירת המחדל שמופיע בו. ערך מחוץ לטווח מוחזר לגבול הקרוב בשרת.")}</div>
      <button class="chip-btn" data-community-action="save-club-feature-config" data-key="${esc(m.key)}"${anyBusy ? " disabled" : ""}>${busy ? "שומר…" : "שמירת הערכים"}</button>
    </details>`;
  }
  function clubModuleRow(m, anyBusy) {
    const row = state.club.features[m.key] || { enabled: true, config: {} };
    const busy = state.club.moduleBusy === m.key;
    // aria-describedby rather than folding the sentence into aria-label:
    // the label is what the switch IS, the description is what it does, and
    // a screen reader announcing both as one run-on name is how a 13-word
    // checkbox name happens. Keyed on the module key, which is unique
    // across both groups by CLUB_MODULE_KEYS' own construction.
    const descId = m.desc ? `clubModuleDesc-${m.key}` : "";
    return `<label class="log-row" style="justify-content:space-between;gap:12px;cursor:pointer;">
      <span style="display:flex;flex-direction:column;gap:3px;min-width:0;">
        <span style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:13px;">${esc(m.label)}${busy ? " (שומר…)" : ""}${clubModuleMarkersHtml(m)}</span>
        ${m.desc ? `<span id="${descId}" style="color:var(--steel);font-size:11.5px;line-height:1.5;">${bidiText(m.desc)}</span>` : ""}
      </span>
      <input type="checkbox" data-club-feature="${m.key}"${row.enabled ? " checked" : ""}${anyBusy ? " disabled" : ""} aria-label="${esc(m.label)}"${descId ? ` aria-describedby="${descId}"` : ""}/>
    </label>${clubModuleSettingsHtml(m, anyBusy)}`;
  }
  function renderClubModulesPanel() {
    if (!(hasPerm(PERM.CLUB_MANAGE_MODULES) || isAdmin())) return "";
    const anyBusy = !!(state.club.moduleBusy || state.club.configBusy);
    // Which rows are server-enforced and which only hide a control is now
    // stated on each row by clubModuleMarkersHtml() - see its comment for
    // why that stopped being a sentence in the group blurb below.
    const communityRows = CLUB_MODULE_TOGGLES.map((m) => clubModuleRow(m, anyBusy)).join("");
    const coachRows = COACH_MODULE_TOGGLES.map((m) => clubModuleRow(m, anyBusy)).join("");
    return `<div class="ach-section" style="margin-top:18px;" data-club-modules-panel="1">${sectionHead("var(--green)", "מודולים למועדון", true)}
      <div style="font-weight:800;font-size:13px;margin:4px 0 6px;">תכני קהילה</div>
      <div style="color:var(--steel);font-size:12px;line-height:1.6;margin-bottom:8px;">כיבוי מודול מסתיר אותו לגמרי מכל חברי המועדון - אין טאב, כרטיס, כפתור או התראה. כל שורה מסומנת: "נאכף בשרת" - גם מי שיעקוף את המסך לא יקבל את המידע; "בתצוגה בלבד" - ההסתרה היא במסך, וההרשאות בשרת נשארות כשהיו. שורה מסומנת "בפיתוח" היא מתג לפיצ'ר שעוד לא נבנה: אפשר להחליט עליו כבר עכשיו, והוא ייכנס לתוקף ביום שהפיצ'ר יעלה.</div>
      <div class="log-list">${communityRows}</div>
      <div style="font-weight:800;font-size:13px;margin:16px 0 6px;">כלי מאמנים</div>
      <div style="color:var(--steel);font-size:12px;line-height:1.6;margin-bottom:8px;">שולט אילו חלקים מלוח המאמנים גלויים לצוות. "לוח מאמנים (הכל)" מכבה את כל הטאב. גם כאן הסימון על כל שורה הוא הקובע: "בתצוגה בלבד" הוא נוחות ארגונית ולא הרשאה - הפעולות עצמן שמורות למי שמורשה/ית לבצע אותן בכל מקרה - ואילו "נאכף בשרת" עוצר את הפעולה עצמה, גם כשאיש אינו צופה במסך.</div>
      <div class="log-list">${coachRows}</div>
    </div>`;
  }
  // ==========================================================================
  // COMM-310. Admin community analytics dashboard - render half.
  //
  // Small shared building blocks first (period selector, value formatters,
  // a plain metric-card wrapper), then one render function per metric - 5
  // for "core", 13 for "additional", named and grouped exactly the way
  // analytics_dashboard()'s own response and docs/community/metrics.md's
  // own section headers are, so a reviewer can match a render function to
  // its metrics.md bullet without re-deriving the mapping. THE SHELL a
  // later ticket (COMM-311/312/313) extends is renderAdminAnalyticsDashboard()
  // itself: append a call to a new section-render function after the two
  // metrics.md groups, inside the same populated branch, reusing the same
  // state.analytics.dashboard.start/end and the same period selector - not a
  // second nav entry, not a second RPC-driven load cycle.
  // ==========================================================================
  function renderAdminAnalyticsPeriodSelector() {
    const a = state.analytics.dashboard;
    const modeBtn = (id, label) => `<button class="chip-btn${a.mode === id ? " selected" : ""}" data-community-action="admin-analytics-mode" data-mode="${id}">${label}</button>`;
    return `<div class="chip-row" style="margin:0 0 10px;align-items:center;">
      ${modeBtn("week", "שבוע")}${modeBtn("month", "חודש")}
      <button class="chip-btn" data-community-action="admin-analytics-shift" data-dir="-1" aria-label="התקופה הקודמת">‹ קודם</button>
      <span style="color:var(--steel);font-size:12px;white-space:nowrap;">${esc(a.start || "")} — ${esc(a.end || "")}</span>
      <button class="chip-btn" data-community-action="admin-analytics-shift" data-dir="1" aria-label="התקופה הבאה">הבא ›</button>
    </div>`;
  }
  // null/undefined (the RPC's own "ratio over a zero denominator" convention,
  // analytics_ratio() in 202609010006) renders as an em dash, never a false
  // "0" or "0%" - COMM-310's own rule, quoted in the migration's comments.
  function adminAnalyticsRatioText(v, asPercent) {
    if (v === null || v === undefined) return "—";
    const n = Number(v);
    if (!isFinite(n)) return "—";
    return asPercent ? (Math.round(n * 1000) / 10) + "%" : String(n);
  }
  function adminAnalyticsCount(v) { return (v === null || v === undefined) ? "—" : esc(v); }
  function adminAnalyticsRow(label, value) {
    return `<div class="log-row"><span>${esc(label)}</span><span class="mono" style="color:var(--brass);">${value}</span></div>`;
  }
  // A jsonb {key: count} breakdown - ten of the eighteen metrics carry one,
  // per analytics_breakdown()'s own "count by one prop" shape - rendered
  // largest-first. The keys are enum-shaped values a member's own client
  // wrote (scope, source, tab, reason...), rendered verbatim rather than
  // translated: a raw string here is more honest than a label table this
  // file would have to keep in sync with every producer's own prop values.
  function adminAnalyticsBreakdownList(obj) {
    const entries = Object.entries(obj || {}).sort((x, y) => Number(y[1]) - Number(x[1]));
    if (!entries.length) return `<div class="empty" style="padding:4px 0;">אין נתונים בתקופה זו</div>`;
    return `<div class="log-list">${entries.map(([k, v]) => adminAnalyticsRow(k, adminAnalyticsCount(v))).join("")}</div>`;
  }
  function adminAnalyticsCard(title, bodyHtml) {
    return `<div class="chart-card" style="margin-bottom:10px;"><h3 class="field-label" style="margin-bottom:6px;">${esc(title)}</h3>${bodyHtml}</div>`;
  }
  // ---- Core metrics (metrics.md "## Core metrics", 5) --------------------
  function renderAdminAnalyticsWcam(core) {
    const w = core.wcam || {};
    const share = core.wcam_share || {};
    const weeks = Array.isArray(w.weeks) ? w.weeks : [];
    const weeksHtml = weeks.length
      ? `<div class="log-list">${weeks.map((wk) => adminAnalyticsRow(`${esc(wk.week_start)}${wk.partial ? " (חלקי)" : ""}`, adminAnalyticsCount(wk.active_members))).join("")}</div>`
      : `<div class="empty" style="padding:4px 0;">אין נתונים בתקופה זו</div>`;
    return adminAnalyticsCard("חברים פעילים שבועית (WCAM)",
      weeksHtml
      + adminAnalyticsRow("ממוצע שבועי", adminAnalyticsCount(w.average_weekly))
      + adminAnalyticsRow("שיא שבועי", adminAnalyticsCount(w.peak_weekly))
      + adminAnalyticsRow("נתח מהחברים (ממוצע שבועי, לא WCAM עצמו)", adminAnalyticsRatioText(share.average_share, true))
      + adminAnalyticsRow("סה״כ פעילים בתקופה כולה (לא WCAM)", adminAnalyticsCount(w.period_active_members)));
  }
  function renderAdminAnalyticsPosting(core) {
    const p = core.posting_members || {};
    const weeks = Array.isArray(p.weeks) ? p.weeks : [];
    const weeksHtml = weeks.length
      ? `<div class="log-list">${weeks.map((wk) => adminAnalyticsRow(`${esc(wk.week_start)}${wk.partial ? " (חלקי)" : ""}`, adminAnalyticsCount(wk.posting_members))).join("")}</div>`
      : `<div class="empty" style="padding:4px 0;">אין נתונים בתקופה זו</div>`;
    return adminAnalyticsCard("חברים שפרסמו, לפי שבוע",
      weeksHtml
      + adminAnalyticsRow("ממוצע שבועי", adminAnalyticsCount(p.average_weekly))
      + adminAnalyticsRow("סה״כ מפרסמים בתקופה כולה", adminAnalyticsCount(p.period_posting_members)));
  }
  function renderAdminAnalyticsEngagement(core) {
    const e = core.engagement_per_post || {};
    const period = e.period || {};
    const cross = e.table_cross_check || {};
    return adminAnalyticsCard("מעורבות לפוסט",
      adminAnalyticsRow("פוסטים בתקופה", adminAnalyticsCount(period.posts))
      + adminAnalyticsRow("עידודים", adminAnalyticsCount(period.reactions))
      + adminAnalyticsRow("תגובות", adminAnalyticsCount(period.comments))
      + adminAnalyticsRow("מעורבות לפוסט (מהאירועים)", adminAnalyticsRatioText(period.engagement_per_post))
      + adminAnalyticsRow("מעורבות לפוסט (בקרת הצלבה מהטבלאות)", adminAnalyticsRatioText(cross.engagement_per_post)));
  }
  function renderAdminAnalyticsFeedReach(core) {
    const f = core.feed_reach || {};
    return adminAnalyticsCard("חשיפה בפיד",
      adminAnalyticsRow("פוסטים שפורסמו", adminAnalyticsCount(f.posts_published))
      + adminAnalyticsRow("פוסטים שקיבלו חשיפה", adminAnalyticsCount(f.posts_with_impressions))
      + adminAnalyticsRow("נתח פוסטים שנחשפו", adminAnalyticsRatioText(f.reach_share, true))
      + adminAnalyticsRow("סה״כ הופעות בפיד", adminAnalyticsCount(f.impressions_total))
      + adminAnalyticsRow("הופעות לפוסט שנחשף", adminAnalyticsRatioText(f.impressions_per_reached_post)));
  }
  function renderAdminAnalyticsCoreGroup(data) {
    const core = data.core || {};
    return `<div class="field-label" style="margin:4px 0 8px;">מדדי ליבה</div>`
      + renderAdminAnalyticsWcam(core)
      + renderAdminAnalyticsPosting(core)
      + renderAdminAnalyticsEngagement(core)
      + renderAdminAnalyticsFeedReach(core);
  }
  // ---- Additional metrics (metrics.md "## Additional metrics", 13) -------
  function renderAdminAnalyticsOpenRate(add) {
    const obj = add.open_rate || {};
    const keys = Object.keys(obj);
    const body = keys.length
      ? `<div class="log-list">${keys.map((k) => adminAnalyticsRow(k, `${adminAnalyticsCount(obj[k].opens)}/${adminAnalyticsCount(obj[k].impressions)} · ${adminAnalyticsRatioText(obj[k].open_rate, true)}`)).join("")}</div>`
      : `<div class="empty" style="padding:4px 0;">אין נתונים בתקופה זו</div>`;
    return adminAnalyticsCard("אחוז פתיחה לפי סוג פוסט", body);
  }
  function renderAdminAnalyticsFilterUse(add) {
    const fu = add.filter_use || {};
    const sessions = fu.sessions || {};
    return adminAnalyticsCard("שימוש בסינון הפיד",
      `<div class="field-label" style="margin:6px 0 4px;font-size:11px;">לפי scope</div>${adminAnalyticsBreakdownList(fu.by_scope)}`
      + `<div class="field-label" style="margin:8px 0 4px;font-size:11px;">לפי מקור</div>${adminAnalyticsBreakdownList(fu.by_source)}`
      + adminAnalyticsRow("שיעור שינוי סינון (בבסיס חבר/יום, ראו הערה)", adminAnalyticsRatioText(sessions.scope_change_share, true))
      + `<div class="footer-note" style="margin-top:4px;">הבסיס הוא זוג (חבר/ה, יום קלנדרי) ולא סשן ממשי - ראו תיעוד המדד.</div>`);
  }
  function renderAdminAnalyticsSubTab(add) {
    const s = add.sub_tab_split || {};
    return adminAnalyticsCard("פילוח תת-לשוניות (Club Tab)",
      adminAnalyticsRow("סה״כ צפיות", adminAnalyticsCount(s.total)) + adminAnalyticsBreakdownList(s.by_tab));
  }
  function renderAdminAnalyticsNotifEff(add) {
    const obj = add.notification_effectiveness || {};
    const keys = Object.keys(obj);
    const body = keys.length
      ? `<div class="log-list">${keys.map((k) => adminAnalyticsRow(k, `${adminAnalyticsCount(obj[k].opened_unread)}/${adminAnalyticsCount(obj[k].delivered)} · ${adminAnalyticsRatioText(obj[k].open_rate, true)}`)).join("")}</div>`
      : `<div class="empty" style="padding:4px 0;">אין נתונים בתקופה זו</div>`;
    return adminAnalyticsCard("אפקטיביות התראות (פתיחה שלא-חוזרת / נמסרו)", body);
  }
  function renderAdminAnalyticsSocial(add) {
    const s = add.social_graph_growth || {};
    const mf = s.member_followed || {};
    const po = s.profile_opened || {};
    return adminAnalyticsCard("צמיחת הגרף החברתי",
      adminAnalyticsRow("עוקבים חדשים (סה״כ בתקופה)", adminAnalyticsCount(mf.total))
      + adminAnalyticsRow("עוקבים חדשים (ממוצע לשבוע)", adminAnalyticsRatioText(mf.per_week))
      + adminAnalyticsRow("צפיות בפרופיל של חבר/ה אחר/ת", adminAnalyticsCount(po.other))
      + adminAnalyticsRow("צפיות בפרופיל העצמי", adminAnalyticsCount(po.self))
      + adminAnalyticsRow("שיעור המרה לצפייה←מעקב", adminAnalyticsRatioText(s.follow_conversion, true)));
  }
  function renderAdminAnalyticsChallengePull(add) {
    const c = add.challenge_leaderboard_pull || {};
    const cv = c.challenge_viewed || {}, lv = c.leaderboard_viewed || {}, cj = c.challenge_joined || {};
    return adminAnalyticsCard("משיכת אתגרים ולוחות מובילים",
      adminAnalyticsRow("צפיות באתגר", adminAnalyticsCount(cv.total))
      + adminAnalyticsRow("צפיות בלוח מובילים", adminAnalyticsCount(lv.total))
      + adminAnalyticsRow("הצטרפויות לאתגר", adminAnalyticsCount(cj.total))
      + adminAnalyticsRow("שיעור המרה: צפייה←הצטרפות", adminAnalyticsRatioText(c.join_rate, true)));
  }
  function renderAdminAnalyticsModerationLoad(add) {
    const m = add.moderation_load || {};
    const rs = m.reports_submitted || {};
    const q = m.queue || {};
    return adminAnalyticsCard("עומס מודרציה",
      adminAnalyticsRow("דיווחים שנשלחו (אירועים)", adminAnalyticsCount(rs.total))
      + adminAnalyticsRow("שורות שנוצרו בתור בתקופה", adminAnalyticsCount(q.rows_created_in_period))
      + adminAnalyticsRow("פתוחים בתור כרגע (לא מוגבל לתקופה)", adminAnalyticsCount(q.open_now)));
  }
  function renderAdminAnalyticsShareIntent(add) {
    const s = add.share_intent_split || {};
    const ws = s.workout_shared || {}, ach = s.achievement_shared || {};
    return adminAnalyticsCard("כוונת שיתוף",
      adminAnalyticsRow("שיתופי אימון", adminAnalyticsCount(ws.total))
      + adminAnalyticsRow("שיתופי הישג", adminAnalyticsCount(ach.total)));
  }
  function renderAdminAnalyticsRecap(add) {
    const r = add.recap_pull_through || {};
    const opened = r.opened || {}, shared = r.shared || {};
    return adminAnalyticsCard("חדירת התקציר השבועי",
      adminAnalyticsRow("פתיחות תקציר", adminAnalyticsCount(opened.total))
      + adminAnalyticsRow("התראות תקציר שנשלחו", adminAnalyticsCount(r.notifications_sent))
      + adminAnalyticsRow("שיעור פתיחה (יכול לעבור 100%, ראו הערה)", adminAnalyticsRatioText(r.open_rate, true))
      + adminAnalyticsRow("שיתופי תקציר", adminAnalyticsCount(shared.total))
      + adminAnalyticsRow("שיעור שיתוף", adminAnalyticsRatioText(r.share_rate, true)));
  }
  function renderAdminAnalyticsDiscovery(add) {
    const d = add.discovery_split || {};
    const sp = d.search_performed || {}, dir = d.directory_opened || {};
    return adminAnalyticsCard("פילוח גילוי (חיפוש מול מדריך חברים)",
      adminAnalyticsRow("חיפושים", adminAnalyticsCount(sp.total))
      + adminAnalyticsRow("חיפושים ללא תוצאות", adminAnalyticsCount(sp.zero_member_result))
      + adminAnalyticsRow("שיעור אפס תוצאות", adminAnalyticsRatioText(sp.zero_member_rate, true))
      + adminAnalyticsRow("פתיחות מדריך חברים", adminAnalyticsCount(dir.total))
      + adminAnalyticsRow("חיפוש מול מדריך (יחס)", adminAnalyticsRatioText(d.search_vs_directory)));
  }
  function renderAdminAnalyticsCoachReach(add) {
    const c = add.coach_reach || {};
    const cong = c.congratulations || {};
    return adminAnalyticsCard("היקף פניות מאמנים",
      adminAnalyticsRow("ברכות שנשלחו", adminAnalyticsCount(cong.total))
      + adminAnalyticsRow("פריטים זכאים לברכה (סף עליון, לא שידור מדויק)", adminAnalyticsCount(c.celebrate_items_eligible))
      + adminAnalyticsRow("כיסוי (סף תחתון)", adminAnalyticsRatioText(c.coverage, true)));
  }
  function renderAdminAnalyticsPush(add) {
    const p = add.push_adoption || {};
    const oi = p.opt_in_events || {}, subs = p.subscriptions || {};
    return adminAnalyticsCard("אימוץ התראות Push",
      adminAnalyticsRow("הצטרפויות ל-push (אירועים בתקופה)", adminAnalyticsCount(oi.total))
      + adminAnalyticsRow("מנויים פעילים כרגע (לא מוגבל לתקופה)", adminAnalyticsCount(subs.active_now))
      + adminAnalyticsRow("מנויים שבוטלו", adminAnalyticsCount(subs.revoked_now))
      + adminAnalyticsRow("חברים ברי-הגעה כרגע", adminAnalyticsCount(subs.members_reachable_now)));
  }
  function renderAdminAnalyticsClassmates(add) {
    const c = add.trained_with_you_reach || {};
    const cv = c.card_views || {};
    return adminAnalyticsCard("חשיפת ״התאמנו איתך״",
      adminAnalyticsRow("צפיות בכרטיס", adminAnalyticsCount(cv.total))
      + adminAnalyticsRow("סה״כ חברי אימון שהוצגו", adminAnalyticsCount(c.classmates_shown_total))
      + adminAnalyticsRow("ממוצע חברי אימון לכרטיס", adminAnalyticsRatioText(c.classmates_per_card))
      + adminAnalyticsRow("שיעור הופעת כרטיס מתוך אימונים שנרשמו", adminAnalyticsRatioText(c.card_rate, true))
      // The server ships this caveat as an English `note`; every other
      // footer-note in this dashboard is client-side Hebrew copy
      // (renderAdminAnalyticsFilterUse just above does the same), so the
      // Hebrew is written here rather than echoing the server string.
      + `<div class="footer-note" style="margin-top:4px;">שיעור ההופעה מוגבל מלכתחילה באימוץ של הגדרת ״נוכחות בשיעורים גלויה״: שני הצדדים בכל זוג חייבים להפעיל אותה, וברירת המחדל היא כבוי. ערך נמוך מעיד על אימוץ, לא על כרטיס תקול.</div>`);
  }
  function renderAdminAnalyticsAdditionalGroup(data) {
    const add = data.additional || {};
    return `<div class="field-label" style="margin:14px 0 8px;">מדדים נוספים</div>`
      + renderAdminAnalyticsOpenRate(add)
      + renderAdminAnalyticsFilterUse(add)
      + renderAdminAnalyticsSubTab(add)
      + renderAdminAnalyticsNotifEff(add)
      + renderAdminAnalyticsSocial(add)
      + renderAdminAnalyticsChallengePull(add)
      + renderAdminAnalyticsModerationLoad(add)
      + renderAdminAnalyticsShareIntent(add)
      + renderAdminAnalyticsRecap(add)
      + renderAdminAnalyticsDiscovery(add)
      + renderAdminAnalyticsCoachReach(add)
      + renderAdminAnalyticsPush(add)
      + renderAdminAnalyticsClassmates(add);
  }
  // ---- Member engagement segmentation (COMM-311) --------------------------
  // Renders as a new section appended INSIDE renderAdminAnalyticsDashboard()'s
  // own populated branch (see that function, below), after the two
  // metrics.md groups - not a second nav destination, not a second period
  // selector. member_segments()'s six buckets, in the SAME precedence order
  // the migration's CASE expression uses (new > declining > highly_active >
  // steady > occasional > dormant) - display order mirrors decision order on
  // purpose, so a reviewer reading top-to-bottom sees the same priority the
  // server actually applied. Hebrew labels and one-line descriptions are
  // written to match those definitions exactly, not loosely.
  const MEMBER_SEGMENT_ORDER = ["new", "declining", "highly_active", "steady", "occasional", "dormant"];
  const MEMBER_SEGMENT_LABELS = {
    new: "חדשים/ות", declining: "בירידה", highly_active: "פעילים/ות מאוד",
    steady: "יציבים/ות", occasional: "מזדמנים/ות", dormant: "רדומים/ות",
  };
  const MEMBER_SEGMENT_DESCRIPTIONS = {
    new: "בתוך 30 הימים הראשונים לחברות",
    declining: "יש דגל ירידה בהגעה פתוח (COMM-304)",
    highly_active: "פעילים בכל אחד מ-4 השבועות המלאים האחרונים",
    steady: "פעילים בלפחות 4 מתוך 8 השבועות המלאים האחרונים",
    occasional: "פעילים ב-1 עד 3 מתוך 8 השבועות המלאים האחרונים",
    dormant: "ללא פעילות ב-8 השבועות המלאים האחרונים",
  };
  // One row per club member, grouped by its own `segment` field - never
  // re-derived or re-sorted client-side, and every one of the six named
  // buckets is pre-seeded with an empty array so a segment with nobody in it
  // still renders "0" (COMM-311's own Empty state) rather than being an
  // omitted card. An unrecognised segment string (a future tuning pass that
  // added a seventh bucket without a client update) still gets its own
  // group rather than being silently dropped, so a count can never go
  // missing from the total.
  function groupMemberSegments(rows) {
    const groups = {};
    for (const key of MEMBER_SEGMENT_ORDER) groups[key] = [];
    for (const row of rows || []) {
      const seg = row && row.segment;
      if (!groups[seg]) groups[seg] = [];
      groups[seg].push(row);
    }
    return groups;
  }
  // A member with visible_to_club = false comes back with user_id,
  // display_name AND handle all null TOGETHER (the migration's own "the
  // three identifying fields are nulled together, never separately" rule) -
  // and handle is `not null unique` on profiles, so a real, visible member
  // row can never carry a null handle. user_id == null is therefore an exact
  // test for "this row was redacted for privacy", not a heuristic.
  function memberSegmentIsRedacted(row) { return !row || row.user_id == null; }
  function memberSegmentName(row) {
    if (memberSegmentIsRedacted(row)) return "חבר/ה (פרופיל מוסתר)";
    return row.display_name || (row.handle ? "@" + row.handle : "חבר/ה");
  }
  function renderMemberSegmentCard(segmentKey, rows, total, isExpanded) {
    const count = rows.length;
    const share = total > 0 ? adminAnalyticsRatioText(count / total, true) : "—";
    const label = MEMBER_SEGMENT_LABELS[segmentKey] || segmentKey;
    const desc = MEMBER_SEGMENT_DESCRIPTIONS[segmentKey] || "";
    const listHtml = !isExpanded ? "" : (count
      ? `<div class="log-list">${rows.map((r) => `<div class="log-row"><span>${esc(memberSegmentName(r))}</span></div>`).join("")}</div>`
      : `<div class="empty" style="padding:4px 0;">אין חברים בפילוח זה</div>`);
    return `<div class="chart-card" style="margin-bottom:10px;" data-member-segment-card="${esc(segmentKey)}">
      <button type="button" class="log-row" style="width:100%;background:none;border:none;cursor:pointer;text-align:inherit;padding:0;" data-community-action="member-segments-toggle" data-segment="${esc(segmentKey)}" aria-expanded="${isExpanded ? "true" : "false"}">
        <span>${esc(label)}</span>
        <span class="mono" style="color:var(--brass);">${count} · ${share}</span>
      </button>
      <div class="footer-note" style="margin:2px 0 0;">${esc(desc)}</div>
      ${listHtml}
    </div>`;
  }
  // Frontend states, COMM-311's own list: loading is a skeleton
  // (data-member-segments-skeleton, six blank rows for the six buckets);
  // error is the ticket's own copy unless the server named one of the two
  // real refusals; empty (a segment with nobody in it) is not a separate
  // branch - every one of the six cards always renders, honest "0" and all,
  // because groupMemberSegments() pre-seeds every bucket.
  function renderMemberSegments() {
    if (!(hasPerm(PERM.ANALYTICS_VIEW) || isAdmin())) return "";
    const ms = state.analytics.segments;
    let body;
    if (ms.loading && !ms.data) {
      const skRow = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:45%;background:var(--border);border-radius:6px;display:inline-block;"></span><span style="height:12px;width:20%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
      const skCard = `<div class="chart-card" style="margin-bottom:10px;">${skRow}</div>`;
      body = `<div aria-busy="true" data-member-segments-skeleton="1">${skCard.repeat(6)}</div>`;
    } else if (ms.error) {
      body = `<div class="empty">${esc(ms.errorText || "לא ניתן היה לטעון את הפילוח.")}<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="member-segments-retry">ניסיון חוזר</button></div></div>`;
    } else if (!ms.data) {
      // WHAT THIS BRANCH ACTUALLY IS, which the copy it replaced got wrong.
      // loadMemberSegments() ends with `ms.data = Array.isArray(data) ? data
      // : []`, so after ANY successful load ms.data is truthy - an empty
      // array included. This branch is therefore unreachable as a "the club
      // has no data" state; it is only ever "the fetch has not run yet"
      // (the render pass before afterRenderManage()'s lazy trigger fires, or
      // a permission gate that nulled it). Saying `אין עדיין נתונים לתצוגה`
      // told a staff member the club was empty when the truth was that the
      // panel had not loaded - so the headline now promises the panel and
      // slot 4 is the real button that fetches it, which is the one action
      // here that genuinely fills the state.
      body = emptyStateHtml({
        key: "member-segments", icon: "chart",
        headline: "כאן יופיע פילוח המעורבות",
        body: "הפילוח נבנה מפעילות החברים במועדון בתקופה שנבחרה.",
        action: "member-segments-retry", actionLabel: "טעינת הפילוח",
      });
    } else {
      const groups = groupMemberSegments(ms.data);
      const total = ms.data.length;
      body = `<div class="footer-note" style="margin:0 0 8px;">סה״כ חברי מועדון: ${total}${ms.asOf ? ` · נכון לתאריך ${esc(ms.asOf)}` : ""}</div>`
        + MEMBER_SEGMENT_ORDER.map((key) => renderMemberSegmentCard(key, groups[key] || [], total, !!ms.expanded[key])).join("");
    }
    return `<div style="margin-top:14px;" data-member-segments-section="1"><div class="field-label" style="margin:4px 0 8px;">פילוח מעורבות חברים</div>${body}</div>`;
  }
  // ---- COMM-379. Registration funnel analytics ---------------------------
  // Same "appended inside the shell's own populated branch" shape as
  // renderMemberSegments() just above - reuses COMM-310's own period
  // selector and load cycle, carries its own independent loading/error/
  // populated switch on state.analytics.registrationFunnel.
  function renderRegistrationFunnel() {
    const rf = state.analytics.registrationFunnel;
    let body;
    if (rf.loading && !rf.data) {
      const skRow = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:55%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
      const skCard = `<div class="chart-card" style="margin-bottom:10px;">${skRow}</div>`;
      body = `<div aria-busy="true" data-registration-funnel-skeleton="1">${skCard.repeat(3)}</div>`;
    } else if (rf.error) {
      body = `<div class="empty">${esc(rf.errorText || "לא ניתן היה לטעון את נתוני ההרשמה.")}<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="registration-funnel-retry">ניסיון חוזר</button></div></div>`;
    } else if (!rf.data) {
      // Same "not loaded yet, not empty" reading as renderMemberSegments'
      // own branch above - loadRegistrationFunnel() only leaves rf.data null
      // when the RPC has not run (or returned SQL NULL), never because the
      // club had a quiet period: a quiet period comes back as a funnel of
      // honest zeros and renders through the populated branch below.
      body = emptyStateHtml({
        key: "registration-funnel", icon: "chart",
        headline: "כאן יופיע משפך ההרשמה",
        body: "המשפך נבנה מהזמנות אישיות שהופצו ומומשו בתקופה שנבחרה.",
        action: "registration-funnel-retry", actionLabel: "טעינת המשפך",
      });
    } else {
      const d = rf.data;
      const sc = d.shared_codes || {};
      const pp = d.per_person_invites || {};
      const f = d.funnel || {};
      // An ORDERED set of steps, each with its own count and, from the
      // second step on, a real percentage of the PREVIOUS step - not four
      // independent counters (COMM-379's own acceptance criterion). The
      // three rate fields are already computed step-over-previous-step
      // server-side (202609030006: redeemed_rate = redeemed/invites_issued,
      // profile_completed_rate = profile_completed/redeemed, verified_rate =
      // verified/profile_completed), so this only has to render them in
      // order, never re-derive them.
      // `hasRate: false` marks the FIRST step, which structurally has no
      // previous step to compare against - true `null` from a step's own
      // rate field (a zero denominator, e.g. no redemptions this period)
      // still renders through adminAnalyticsRatioText, which is what turns
      // it into an em dash rather than omitting the rate entirely - the
      // two are different claims and must not look the same as "no rate at
      // all" the way the first step's own blank rightly does.
      const steps = [
        { label: "הזמנות אישיות שהופצו", value: f.invites_issued, hasRate: false, rate: null },
        { label: "מומשו", value: f.redeemed, hasRate: true, rate: f.redeemed_rate },
        { label: "השלימו פרופיל", value: f.profile_completed, hasRate: true, rate: f.profile_completed_rate },
        { label: "אומתו", value: f.verified, hasRate: true, rate: f.verified_rate },
      ];
      const funnelHtml = `<div class="log-list">${steps.map((s) =>
        adminAnalyticsRow(s.label, adminAnalyticsCount(s.value) + (s.hasRate ? " · " + adminAnalyticsRatioText(s.rate, true) : ""))).join("")}</div>`;
      const sharedHtml = adminAnalyticsCard("קודי הצטרפות משותפים (כרגע)",
        adminAnalyticsRow("קודים פעילים", adminAnalyticsCount(sc.active_count))
        + adminAnalyticsRow("מימושים בתקופה", adminAnalyticsCount(sc.redemptions_in_period)));
      const personHtml = adminAnalyticsCard("הזמנות אישיות",
        adminAnalyticsRow("נוצרו בתקופה", adminAnalyticsCount(pp.created_in_period))
        + adminAnalyticsRow("מומשו בתקופה", adminAnalyticsCount(pp.redeemed_in_period))
        + adminAnalyticsRow("בוטלו בתקופה", adminAnalyticsCount(pp.revoked_in_period))
        + adminAnalyticsRow("ממתינות כרגע", adminAnalyticsCount(pp.pending_now))
        + adminAnalyticsRow("פגות תוקף ולא מומשו, כרגע", adminAnalyticsCount(pp.expired_unredeemed_now)));
      body = `<div class="footer-note" style="margin-bottom:8px;">״הזמנות שהופצו״ סופר רק הזמנות אישיות - מי שהצטרף/ה דרך קוד משותף לא נספר/ת כאן, ולכן סה״כ המומשים יכול לעלות על מספר ההזמנות שהופצו.</div>`
        + adminAnalyticsCard("משפך הרשמה", funnelHtml)
        + sharedHtml + personHtml;
    }
    return `<div style="margin-top:14px;" data-registration-funnel-section="1"><div class="field-label" style="margin:4px 0 8px;">משפך הרשמה</div>${body}</div>`;
  }
  // ---- The shell itself ---------------------------------------------------
  // Frontend states (COMM-310's own "Frontend states" list): loading is a
  // skeleton (data-admin-analytics-skeleton, the same aria-busy skeleton
  // shape every other lazy admin panel in this cluster uses); error is the
  // ticket's own copy unless the server named one of the four real refusals,
  // in which case that refusal's own short Hebrew shows instead; empty (a
  // genuinely quiet period) is not a separate branch at all - it is the
  // populated branch, rendering honest zeros and em-dashes, because
  // analytics_dashboard() always returns the same 18 keys whether the
  // period was busy or quiet.
  function renderAdminAnalyticsDashboard() {
    if (!(hasPerm(PERM.ANALYTICS_VIEW) || isAdmin())) return "";
    const a = state.analytics.dashboard;
    let body;
    if (a.loading && !a.data) {
      const skRow = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:55%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
      const skCard = `<div class="chart-card" style="margin-bottom:10px;"><div class="log-list">${skRow.repeat(3)}</div></div>`;
      body = `<div aria-busy="true" data-admin-analytics-skeleton="1">${skCard.repeat(3)}</div>`;
    } else if (a.error) {
      body = `<div class="empty">${esc(a.errorText || "לא ניתן היה לטעון את הנתונים.")}<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="admin-analytics-retry">ניסיון חוזר</button></div></div>`;
    } else if (!a.data) {
      // The shell's own header comment already says it: "empty (a genuinely
      // quiet period) is not a separate branch at all - it IS the populated
      // branch, rendering honest zeros and em-dashes, because
      // analytics_dashboard() always returns the same 18 keys whether the
      // period was busy or quiet." Which makes this branch, unambiguously,
      // the not-yet-fetched one - and `אין עדיין נתונים לתצוגה` a claim about
      // the club that the code right above it contradicts.
      body = emptyStateHtml({
        key: "admin-analytics", icon: "chart",
        headline: "כאן יופיעו נתוני המועדון",
        body: "הנתונים נמשכים מפעילות המועדון בתקופה שנבחרה למעלה.",
        action: "admin-analytics-retry", actionLabel: "טעינת הנתונים",
      });
    } else {
      // COMM-311 appends here, inside this same populated branch, per
      // COMM-310's own commit message: "a later ticket's own section is
      // meant to be a new render function appended inside the same
      // populated branch ... not a second nav destination or a second date
      // picker." renderMemberSegments() carries its own independent
      // loading/error/populated switch on state.analytics.segments, so it is
      // not itself gated on a.data beyond appearing here.
      //
      // Redesign, Phase 1: the plan's first draft moved renderRegistrationFunnel()
      // out to the Manage tab's "קליטה" (Onboarding) sub-tab. Reverted after
      // tracing loadRegistrationFunnel() (~line 2507): it fires only as a
      // side effect of loadAdminAnalyticsDashboard()'s OWN completion, and
      // the funnel renders with no period selector of its own - it reuses
      // this dashboard's, by design (COMM-379). Moving the render call
      // without also inventing an independent load trigger and an
      // independent period selector would have shipped a funnel that never
      // loads for a staff member who visits Onboarding before Analytics.
      // Stays here, byte-identical to before this phase.
      body = renderAdminAnalyticsCoreGroup(a.data) + renderAdminAnalyticsAdditionalGroup(a.data) + renderMemberSegments() + renderRegistrationFunnel();
    }
    return `<div class="ach-section" style="margin-top:18px;" data-admin-analytics-dashboard="1">${sectionHead("var(--energy)", "לוח בקרה: אנליטיקת קהילה", true)}${renderAdminAnalyticsPeriodSelector()}${body}</div>`;
  }
  // ---- Retention correlation views (COMM-313) --------------------------
  //
  // WHY A SEPARATE TOP-LEVEL SECTION, NOT APPENDED INSIDE
  // renderAdminAnalyticsDashboard() THE WAY COMM-311's renderMemberSegments()
  // WAS.
  //
  // COMM-310's own shell is gated on `hasPerm(PERM.ANALYTICS_VIEW) ||
  // isAdmin()`, and every section appended inside it so far (COMM-311's
  // segments) shares exactly that gate - there was never a reason to check
  // again. COMM-313 is the first ticket in this cluster whose own gate is a
  // STRICT SUBSET of the shell's: real is_admin() alone, no
  // community.analytics.view alternative (the migration's own "THE GATE IS
  // is_admin() ALONE" header, and the ticket's own acceptance criterion,
  // "matching COMM-312's narrower bar"). A community.analytics.view holder
  // who is not an admin is meant to see the dashboard and the segments and
  // NOT this - the one negative case COMM-313 calls out as genuinely
  // different from COMM-310/311.
  //
  // Nesting this section inside renderAdminAnalyticsDashboard()'s own
  // populated branch and re-gating just this call would still be CORRECT
  // (the inner isAdmin()-only check below would still hide it from that
  // permission holder), but it would bury a narrower permission boundary
  // inside a container whose own header and period selector belong to a
  // broader one - a reviewer skimming renderAdminAnalyticsDashboard() would
  // reasonably assume everything inside it shares its gate, and the next
  // person to add a section there could copy that assumption straight into
  // a real bug. Keeping it as its own ach-section, with its own isAdmin()
  // check at the very top (the same standalone `if (!isAdmin()) return "";`
  // shape renderMemberManagement() already uses, not the OR-with-permission
  // shape), makes the boundary visible at the call site instead of implicit
  // inside a shared container. It still lives in the same admin-moderation
  // cluster, right next to the dashboard in the account tab, and it reuses
  // every rendering building block (adminAnalyticsCard/Row/RatioText,
  // sectionHead, the aria-busy skeleton shape) COMM-310 already built - nothing
  // here is a new visual language, only a new permission boundary.
  //
  // RENDERING APPROACH: reuses COMM-310's own "weeks" pattern
  // (renderAdminAnalyticsWcam/Posting: a log-list of one row per week,
  // adminAnalyticsRow(label, value)) rather than inventing a chart. Each
  // series (a cohort month, or one side of a correlation cut) is its own
  // adminAnalyticsCard with a log-list of "שבוע N: share% (מתוך n חברים)"
  // rows - a "standard retention curve" read top-to-bottom instead of drawn,
  // which is what COMM-310's own precedent already does for a single series
  // and this section does once per series. Correctness over visual polish,
  // per the ticket's own instruction for an internal admin tool.
  const RETENTION_ONBOARDING_STEPS = [
    { id: "welcomed_at", label: "ברכת פתיחה" },
    { id: "first_week_shown_at", label: "סיכום שבוע ראשון" },
    { id: "first_month_shown_at", label: "סיכום חודש ראשון" },
    { id: "first_class_shown_at", label: "שיעור ראשון" },
    { id: "third_class_shown_at", label: "שיעור שלישי" },
  ];
  // The correlation-not-causation caveat, stated once and shown PERSISTENTLY
  // next to the two overlay toggles (not in a tooltip) - the ticket's own
  // wording. Carries no "effect"/"impact"/"lift"/"uplift" word, the same
  // restraint 202609010008's own field naming keeps (see that migration's
  // "CORRELATION, NOT CAUSATION" header): a stamped onboarding step or a
  // coach Welcome both partly just measure whether the member came back or
  // was around to be reached at all, so the gap between the two curves is a
  // ceiling on anything causal, never proof of one.
  const RETENTION_CORRELATION_NOTE = "זהו מתאם, לא סיבתיות. שלב הכוונה מסומן רק כשהחבר/ה פותח/ת את האפליקציה ורואה אותו, ופנייה של מאמן/ת נוטה להגיע דווקא למי שממילא נמצא/ת בסביבה - כך שחלק ניכר מהפער בין שתי העקומות פשוט משקף מי חזר/ה להיות פעיל/ה בכלל, לא רק את הצעד עצמו. הפער בין העקומות הוא לכל היותר תקרה עליונה למשהו סיבתי, לא הוכחה לו.";
  // One row per week, sorted, for a single series (a cohort month, or one
  // side of a correlation cut). A suppressed tail (this section's rows never
  // gap - see 202609010008's own "TRUNCATES A LINE, NEVER PUNCHES A HOLE"
  // note) simply means the log-list stops short; nothing here bridges it or
  // draws a placeholder for a week that was never emitted.
  function retentionWeekRows(rows) {
    const sorted = (rows || []).slice().sort((x, y) => Number(x.week_number) - Number(y.week_number));
    if (!sorted.length) return `<div class="empty" style="padding:4px 0;">אין מספיק חברים לתצוגה יציבה</div>`;
    return `<div class="log-list">${sorted.map((r) => adminAnalyticsRow(`שבוע ${esc(r.week_number)}`, `${adminAnalyticsRatioText(r.retained_share, true)} (מתוך ${adminAnalyticsCount(r.member_count)})`)).join("")}</div>`;
  }
  // cohort_month is 'YYYY-MM' or the literal 'other' (202609010008's own
  // rule - a real month key can never collide with that string); 'other'
  // sorts last, named months sort chronologically, exactly the order the
  // RPC itself already returns them in - this re-sort is defensive, not a
  // correction of the server's own ordering.
  function retentionCohortSortKey(a, b) {
    if (a === "other" && b !== "other") return 1;
    if (b === "other" && a !== "other") return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  function renderRetentionCohortCurves(cohortRows) {
    const byMonth = new Map();
    for (const row of cohortRows || []) {
      const key = row && row.cohort_month;
      if (key == null) continue;
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key).push(row);
    }
    const months = Array.from(byMonth.keys()).sort(retentionCohortSortKey);
    // The genuine empty of the retention section - the fetch succeeded and
    // there is no cohort yet - as opposed to renderRetentionCorrelations'
    // own `!r.loaded` branch, which is the pre-fetch one. Restated for the
    // same reason as the health card's pair above: one card must not show
    // two different registers depending on which of its two empties it hit.
    // NO ACTION: nothing an admin can press creates a joining cohort.
    if (!months.length) return emptyStateHtml({
      key: "retention-cohorts", icon: "people",
      headline: "כאן יופיעו קבוצות ההצטרפות",
      body: "כל קבוצה נמדדת לפי החודש שבו החברים בה הצטרפו למועדון.",
      when: "אחרי שקבוצת הצטרפות ראשונה תשלים חודש, היא תופיע כאן.",
    });
    return months.map((m) => adminAnalyticsCard(
      `קבוצת הצטרפות: ${m === "other" ? "קבוצות קטנות (מאוחדות)" : esc(m)}`,
      retentionWeekRows(byMonth.get(m)),
    )).join("");
  }
  function renderRetentionOverlayToggles() {
    const r = state.analytics.retention;
    return `<div class="chip-row" style="margin:10px 0;" data-retention-overlay-toggles="1">
      <button class="chip-btn${r.showOnboarding ? " selected" : ""}" data-community-action="retention-toggle-onboarding" aria-pressed="${r.showOnboarding ? "true" : "false"}">שכבת-על: שלבי הכוונה</button>
      <button class="chip-btn${r.showWelcome ? " selected" : ""}" data-community-action="retention-toggle-welcome" aria-pressed="${r.showWelcome ? "true" : "false"}">שכבת-על: פניית מאמן/ת ראשונית</button>
    </div>`;
  }
  // stamped=true is rendered first (matching the RPC's own `order by ...
  // stamped desc`), stamped=false second - "did the member ever see this
  // step" vs. "never did", for whichever step the chip row currently
  // selects. A step nobody has ever been stamped with (both COMM-316 columns
  // right after deploy, since 202609010003 does not backfill them) returns
  // only the false side from the server; the true side then falls through to
  // retentionWeekRows()'s own empty state rather than a missing card, so a
  // reviewer sees "not enough members yet" instead of a card that silently
  // vanished.
  function renderRetentionOnboardingOverlay() {
    const r = state.analytics.retention;
    if (!r.showOnboarding) return "";
    const stepChips = RETENTION_ONBOARDING_STEPS.map((s) => `<button class="chip-btn${r.onboardingStep === s.id ? " selected" : ""}" data-community-action="retention-onboarding-step" data-step="${s.id}">${esc(s.label)}</button>`).join("");
    const stepRows = (r.onboarding || []).filter((row) => row && row.step === r.onboardingStep);
    const stamped = stepRows.filter((row) => row.stamped === true);
    const notStamped = stepRows.filter((row) => row.stamped === false);
    return `<div style="margin-top:6px;" data-retention-onboarding-overlay="1">
      <div class="chip-row" style="margin:0 0 8px;">${stepChips}</div>
      ${adminAnalyticsCard("השלב סומן (stamped)", retentionWeekRows(stamped))}
      ${adminAnalyticsCard("השלב לא סומן", retentionWeekRows(notStamped))}
    </div>`;
  }
  // contacted=true first (matching the RPC's own `order by contacted desc`),
  // false second. No step selector here - retention_welcome_correlation()
  // has only the one cut.
  function renderRetentionWelcomeOverlay() {
    const r = state.analytics.retention;
    if (!r.showWelcome) return "";
    const contacted = (r.welcome || []).filter((row) => row && row.contacted === true);
    const notContacted = (r.welcome || []).filter((row) => row && row.contacted === false);
    return `<div style="margin-top:6px;" data-retention-welcome-overlay="1">
      ${adminAnalyticsCard("פנייה מאמן/ת ב-14 הימים הראשונים", retentionWeekRows(contacted))}
      ${adminAnalyticsCard("ללא פנייה כזו", retentionWeekRows(notContacted))}
    </div>`;
  }
  // Frontend states, COMM-313's own list: loading is a skeleton
  // (data-retention-skeleton); error is the ticket's own copy unless the
  // server named the one real refusal ('not authorized'), in which case that
  // refusal's own short Hebrew shows instead; a cohort folded into 'other'
  // for being under the 5-member floor is not a separate branch - it is just
  // one more card in the populated branch, labelled as pooled rather than
  // omitted (renderRetentionCohortCurves' own 'other' handling); populated is
  // the cohort curves plus the two toggle-able overlays, with the
  // correlation-not-causation note shown persistently above the toggles
  // (not hidden inside either overlay, since it applies to both, and not a
  // tooltip).
  function renderRetentionCorrelations() {
    if (!isAdmin()) return "";
    const r = state.analytics.retention;
    let body;
    if (r.loading && !r.loaded) {
      const skRow = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:55%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
      const skCard = `<div class="chart-card" style="margin-bottom:10px;"><div class="log-list">${skRow.repeat(3)}</div></div>`;
      body = `<div aria-busy="true" data-retention-skeleton="1">${skCard.repeat(3)}</div>`;
    } else if (r.error) {
      body = `<div class="empty">${esc(r.errorText || "לא ניתן היה לטעון את נתוני השימור.")}<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="retention-retry">ניסיון חוזר</button></div></div>`;
    } else if (!r.loaded) {
      // Gated on `!r.loaded` rather than on the data, so this one is
      // strictly-by-construction the pre-fetch state: once loadRetention
      // Correlations() returns, r.loaded is true and a club with no cohorts
      // falls through to renderRetentionCohortCurves' own empty state below,
      // which says something different because it means something different.
      body = emptyStateHtml({
        key: "retention", icon: "chart",
        headline: "כאן יופיעו עקומות השימור",
        body: "העקומות נבנות מקבוצות ההצטרפות של החודשים האחרונים.",
        action: "retention-retry", actionLabel: "טעינת נתוני השימור",
      });
    } else {
      body = renderRetentionCohortCurves(r.cohorts)
        + `<div class="footer-note" data-retention-correlation-note="1" style="margin:12px 0 0;">${esc(RETENTION_CORRELATION_NOTE)}</div>`
        + renderRetentionOverlayToggles()
        + renderRetentionOnboardingOverlay()
        + renderRetentionWelcomeOverlay();
    }
    return `<div class="ach-section" style="margin-top:18px;" data-retention-correlations="1">${sectionHead("var(--purple)", "מתאמי שימור (מנהלים בלבד)", true)}${body}</div>`;
  }
  // ---- Community health score rendering (COMM-312) -----------------------
  // Deliberately simpler than COMM-313's cohort curves, per the ticket's own
  // "just one score per week, one line": one score card for the latest
  // computed week, its four-component breakdown, and a trend line that is a
  // plain week-by-week list of scores (this codebase draws every other trend
  // - see renderAdminAnalyticsWcam's own weeks list - the same way; there is
  // no charting library here to reach for).
  //
  // Key order matches components' own jsonb_build_object key order in
  // 202609010009 (wcam_share, engagement_per_post, moderation_load,
  // retention) rather than the weights' narrative order in that migration's
  // comments, or AC1's prose order - the stored row is the one definition.
  const COMMUNITY_HEALTH_COMPONENT_ORDER = ["wcam_share", "engagement_per_post", "moderation_load", "retention"];
  const COMMUNITY_HEALTH_COMPONENT_LABELS = {
    wcam_share: "נוכחות שבועית (WCAM)",
    engagement_per_post: "מעורבות לפוסט",
    moderation_load: "עומס דיווחים (הפוך)",
    retention: "שימור",
  };
  // `value` is in the component's own units (a share, a per-post ratio, a
  // per-100-members rate) - never the 0..1 sub_score, which is an internal
  // mapping this card does not surface. null/undefined (component
  // unavailable - community_health_component()'s own null rule) renders as
  // an em dash, the same convention adminAnalyticsRatioText() uses.
  function communityHealthComponentValueText(key, comp) {
    const v = comp && comp.value;
    if (v === null || v === undefined) return "—";
    const n = Number(v);
    if (!isFinite(n)) return "—";
    if (key === "wcam_share" || key === "retention") return (Math.round(n * 1000) / 10) + "%";
    if (key === "moderation_load") return (Math.round(n * 10) / 10) + " דיווחים ל-100 חברים";
    return (Math.round(n * 100) / 100) + " לפוסט";
  }
  // THE CAVEAT. community_health_component()'s own comment: weight_applied
  // is 0 "when the component had no data" and the migration's own composite
  // block says a partial-component score "does not announce that on its
  // face" unless a reader is told. So a weight_applied of 0 (or a null
  // sub_score - the same condition, restated defensively) renders a visible
  // "not included this week" line INSTEAD OF a 0% weight, rather than next
  // to it - 0% read on its own looks like a rounding artefact, not an
  // exclusion.
  function communityHealthComponentDropped(comp) {
    if (!comp) return true;
    if (comp.sub_score === null || comp.sub_score === undefined) return true;
    const wa = Number(comp.weight_applied);
    return !isFinite(wa) || wa === 0;
  }
  function renderCommunityHealthComponents(components) {
    if (!components || typeof components !== "object") return "";
    const rows = COMMUNITY_HEALTH_COMPONENT_ORDER.map((key) => {
      const comp = components[key];
      if (!comp) return "";
      const dropped = communityHealthComponentDropped(comp);
      const valueText = communityHealthComponentValueText(key, comp);
      const weightHtml = dropped
        ? `<span data-community-health-dropped="1" style="color:var(--red-text);">לא נכלל בציון השבוע</span>`
        : `<span style="color:var(--steel);">במשקל ${Math.round(Number(comp.weight_applied) * 1000) / 10}%</span>`;
      return `<div class="log-row" data-community-health-component="${key}">
        <span>${esc(COMMUNITY_HEALTH_COMPONENT_LABELS[key] || key)}</span>
        <span class="mono" style="color:var(--brass);text-align:left;">${esc(valueText)}<br/>${weightHtml}</span>
      </div>`;
    }).join("");
    return `<div class="log-list" data-community-health-components="1">${rows}</div>`;
  }
  function communityHealthScoreText(row) {
    const s = row && row.score;
    if (s === null || s === undefined) return "—";
    const n = Number(s);
    return isFinite(n) ? String(Math.round(n * 10) / 10) : "—";
  }
  function renderCommunityHealthScoreCard(row) {
    if (!row) return "";
    return `<div class="chart-card" style="margin-bottom:10px;" data-community-health-score-card="1">
      <div style="font-size:12px;color:var(--steel);margin-bottom:4px;">שבוע ${esc(row.week_start || "")}</div>
      <div style="font-size:34px;font-weight:800;color:var(--brass);" data-community-health-score-value="1">${esc(communityHealthScoreText(row))}</div>
      <div style="font-size:12px;color:var(--steel);margin-bottom:8px;">מתוך 100</div>
      ${renderCommunityHealthComponents(row.components)}
    </div>`;
  }
  // ONE ROW: no trend line at all, per the ticket's own empty-state wording
  // ("fewer than 2 computed weeks shows the latest score with no trend line
  // rather than a broken chart") - the caller does not even call this
  // helper below that count. TWO OR MORE: every stored week, oldest first
  // (community_health_history()'s own return order - no re-sort here),
  // rendered as a plain log-list the same shape renderAdminAnalyticsWcam()
  // already uses for a weekly series.
  function renderCommunityHealthTrend(weeks) {
    const rows = (weeks || []).map((w) => adminAnalyticsRow(w.week_start || "", communityHealthScoreText(w))).join("");
    return adminAnalyticsCard("מגמת ציון הקהילה", `<div class="log-list" data-community-health-trend="1">${rows}</div>`);
  }
  // Frontend states, COMM-312's own list: loading is a skeleton
  // (data-community-health-skeleton); error is the ticket's own exact copy
  // ("לא ניתן היה לטעון את הציון.") unless the server named the one real
  // refusal ('not authorized'); 0 computed weeks is a true empty state
  // (data-community-health-empty, "no scheduler wired yet" is the expected
  // common case until one exists, same as several other Phase 3 schema
  // halves); 1 week shows the score card with no trend line; 2+ weeks shows
  // the score card plus the trend line.
  function renderCommunityHealthScore() {
    if (!isAdmin()) return "";
    const h = state.analytics.health;
    let body;
    if (h.loading && !h.loaded) {
      const skRow = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:55%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
      body = `<div class="chart-card" style="margin-bottom:10px;" aria-busy="true" data-community-health-skeleton="1">
        <div style="height:34px;width:90px;background:var(--border);border-radius:8px;margin-bottom:10px;"></div>
        <div class="log-list">${skRow.repeat(4)}</div>
      </div>`;
    } else if (h.error) {
      body = `<div class="empty">${esc(h.errorText || "לא ניתן היה לטעון את הציון.")}<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="community-health-retry">ניסיון חוזר</button></div></div>`;
    } else if (!h.loaded) {
      // Pre-fetch, same `!loaded` construction as COMM-313's retention
      // branch: a real load button, because pressing it really does fill
      // this space.
      body = emptyStateHtml({
        key: "community-health", icon: "chart",
        headline: "כאן יופיע ציון בריאות הקהילה",
        body: "הציון נבנה מפעילות, מעורבות ושימור, שבוע אחר שבוע.",
        action: "community-health-retry", actionLabel: "טעינת הציון",
      });
    } else if (!h.weeks.length) {
      // The GENUINE empty of this card, and the one place in this cluster
      // where the two must not be confused: the fetch succeeded and the club
      // simply has no computed week yet. Not in the ticket's list of five,
      // restated anyway - the same card would otherwise show a four-slot
      // state before the load and a bare one-liner after it, which is a
      // worse inconsistency than the one being fixed.
      //
      // NO ACTION SLOT, on purpose. community_health_history() is filled by
      // a scheduled job (which, per this function's own header, may not be
      // wired for this club yet). There is no button an admin can press that
      // computes a week, so slot 4 is a `when` - spec §2.1's own fallback.
      // The retry button the branch above carries would be a lie here: it
      // would re-fetch, succeed, and change nothing on screen.
      body = emptyStateHtml({
        key: "community-health-empty", icon: "chart", attr: 'data-community-health-empty="1"',
        headline: "כאן יופיע ציון בריאות הקהילה",
        body: "הציון מחושב פעם בשבוע מפעילות, מעורבות ושימור במועדון.",
        when: "אחרי החישוב השבועי הראשון יופיעו כאן הציון והמגמה.",
      });
    } else {
      const latest = h.weeks[h.weeks.length - 1];
      body = renderCommunityHealthScoreCard(latest) + (h.weeks.length >= 2 ? renderCommunityHealthTrend(h.weeks) : "");
    }
    return `<div class="ach-section" style="margin-top:18px;" data-community-health-score="1">${sectionHead("var(--brass)", "ציון בריאות הקהילה (מנהלים בלבד)", true)}${body}</div>`;
  }

  // A full, unambiguous moment for the restriction panel - "3 במרץ 2027,
  // בשעה 14:30". Note the contrast with the input echoes above, which is
  // deliberate and not an inconsistency: THOSE restate a zone-less string the
  // member typed and must therefore never construct a Date, while expires_at
  // and created_at are real UTC instants that have to be resolved against
  // some clock to be read at all. This uses eventLocalParts(), the same
  // local-clock conversion every other stored timestamp in this file displays
  // through, so a restriction end time reads on the same clock as the event
  // times beside it.
  function restrictionMomentText(iso) {
    const p = eventLocalParts(iso);
    if (!p) return "";
    return `${Number(p.da)} ב${HEB_MONTHS[Number(p.mo) - 1]} ${p.y}, בשעה ${p.h}:${p.mi}`;
  }
  // ==========================================================================
  // The surface COMM-153 never built: what a restricted member is told, and
  // where.
  //
  // PLACEMENT. The Account tab, as a card among the member's own settings,
  // rather than a banner over the feed or a dialog on load. A sanction is
  // standing information about this person's account - the same category as
  // their privacy toggles and their deletion request, both of which live here
  // - not an interruption to re-deliver on every visit. It sits FIRST on the
  // tab, above the profile form: it is the one thing on this screen a member
  // may have come specifically to read, and burying it under the avatar
  // picker would repeat, more quietly, the original defect of making them
  // hunt for it.
  //
  // REGISTER. Modelled on 05e1ee5's incomplete-signups copy and a42f9d1's
  // error mapping, which is to say: name the thing plainly, say exactly what
  // it does and does not cover, and end at a person who can change it. This
  // is somebody being told they are in trouble, so the two failure modes to
  // avoid are opposite ones - cold ("your posting privileges have been
  // revoked") and evasive ("there may be a temporary limitation on some
  // activity"). Every line below is a fact the row actually holds.
  //
  // WHAT IT REFUSES TO INVENT. There is no appeal button, because there is no
  // appeal endpoint - mod_lift_restriction() is moderator-only and takes no
  // member-initiated request, so a button here would be the dead door the
  // empty-state pattern forbids. The route to a human is a sentence, which is
  // what the app can honestly offer.
  function renderMyRestrictionPanel() {
    const r = state.myRestriction.row;
    // Error and "not restricted" are the same render. A member who is not
    // restricted must never see a card about restrictions, and a load that
    // failed must not invent one - the write path still refuses with the
    // mapped error, so nobody is left with no channel at all.
    if (!r) return "";
    const permanent = r.restriction_type === "permanent" || !r.expires_at;
    // reason is `not null default ''`, so "no reason recorded" arrives as an
    // empty string rather than null. It is a real state and gets a real
    // sentence: staying silent about a missing reason is the evasive failure
    // mode, and the member is owed the knowledge that nothing was written
    // down as much as they are owed the reason itself.
    const reason = String(r.reason || "").trim();
    const until = permanent ? "" : restrictionMomentText(r.expires_at);
    const since = restrictionMomentText(r.created_at);
    const line = (text) => `<div style="color:var(--steel);font-size:13px;line-height:1.7;margin-top:8px;">${bidiText(text)}</div>`;
    // The duration line. The temporary case says the restriction lapses on
    // its own, which is true of the server predicate (`expires_at > now()`,
    // with no lifting step) and is the single most useful thing a member in
    // this position can be told. The permanent case says the opposite just as
    // plainly rather than softening it into "for now".
    const durationText = permanent
      ? "להגבלה הזו לא נקבע מועד סיום, והיא לא תיפתח מעצמה. רק צוות המועדון יכול להסיר אותה."
      : `ההגבלה מסתיימת ב-${until}. היא נפתחת מעצמה במועד הזה — אין מה לעשות ואין למי לפנות כדי שזה יקרה.`;
    const reasonText = reason
      ? `הסיבה שנרשמה: ${reason}`
      : "לא נרשמה סיבה יחד עם ההגבלה. אפשר לבקש אותה מצוות המועדון.";
    return `<div class="ach-section" data-my-restriction-panel="1" style="margin-top:0;margin-bottom:18px;">
      ${sectionHead("var(--yellow)", "הגבלת פרסום על החשבון")}
      <div class="chart-card">
        ${line("צוות המועדון הגביל את הפרסום מהחשבון הזה, ולכן פוסטים ותגובות חדשים לא נשלחים.")}
        ${since ? line(`ההגבלה נכנסה לתוקף ב-${since}.`) : ""}
        ${line(durationText)}
        ${line(reasonText)}
        ${line("מה שלא מושפע: אפשר להמשיך לקרוא את הפיד, להגיב בלייק, להירשם לאירועים ולהצטרף לאתגרים כרגיל, ורישום האימונים הפרטי לא נוגע בזה בכלל.")}
        ${line("לשאלות על ההגבלה או על הסרתה אפשר לפנות למאמן/ת.")}
      </div>
    </div>`;
  }

  // COMM-151. The report reason sheet. Reasons are a fixed list, an optional
  // capped free-text note, and a plain acknowledgement that discloses
  // nothing about what happens next.
  function renderReportSheet() {
    const s = state.admin.reportSheet;
    if (!s) return "";
    if (s.done) {
      return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="reportSheetTitle" data-cloud-dialog="reportSheet" style="align-items:center;padding:0 20px;">
        <div class="modal-sheet" style="border-radius:22px;max-height:none;">
          <div style="padding:24px 22px calc(env(safe-area-inset-bottom,0px) + 20px);">
            <h2 id="reportSheetTitle" style="margin-top:0;color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:8px;">הדיווח התקבל.</h2>
            <div class="chip-row" style="margin-top:8px;"><button class="chip-btn primary" data-community-action="report-close">סגירה</button></div>
          </div>
        </div>
      </div>`;
    }
    const reasons = REPORT_REASONS.map((r) => `<label class="log-row" style="justify-content:space-between;gap:12px;cursor:pointer;">
      <span style="font-size:13px;">${r.label}</span>
      <input type="radio" name="reportReason" data-report-reason="${r.id}"${s.reason === r.id ? " checked" : ""} aria-label="${esc(r.label)}"/>
    </label>`).join("");
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="reportSheetTitle" data-cloud-dialog="reportSheet" style="align-items:center;padding:0 20px;">
      <div class="modal-sheet" style="border-radius:22px;max-height:none;">
        <div style="padding:24px 22px calc(env(safe-area-inset-bottom,0px) + 20px);">
          <h2 id="reportSheetTitle" style="margin-top:0;color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:12px;">דיווח על ${s.targetType === "comment" ? "תגובה" : "פוסט"}</h2>
          <div class="log-list">${reasons}</div>
          <label class="field" style="margin-top:12px;"><span class="field-label">פרטים נוספים (רשות)</span>
            <textarea class="text-input" data-report-note maxlength="500" placeholder="אפשר להוסיף הקשר">${esc(s.note || "")}</textarea></label>
          ${s.error ? `<div class="footer-note" role="alert" style="color:var(--red-text);">${esc(s.error)}</div>` : ""}
          <div class="chip-row" style="margin-top:12px;">
            <button class="chip-btn" data-community-action="report-close">ביטול</button>
            <button class="chip-btn primary" data-community-action="report-submit"${s.saving ? " disabled" : ""}>${s.saving ? "שולח…" : "שליחת דיווח"}</button>
          </div>
        </div>
      </div>
    </div>`;
  }
  // COMM-153. The queue action sheet: a confirm with an optional note, plus
  // a duration picker for a temporary restriction. Every decision here is
  // handed to mod_review().
  function renderModActionSheet() {
    const a = state.admin.modAction;
    if (!a) return "";
    const def = MOD_DECISIONS.find((d) => d.id === a.decision) || { label: a.decision };
    const days = a.decision === "restrict_temp" ? `<label class="field" style="margin-top:10px;"><span class="field-label">משך ההגבלה</span>
      <div class="chip-row" style="margin:0;">${RESTRICT_TEMP_DAYS.map((d) => `<button class="chip-btn${a.days === d ? " selected" : ""}" data-community-action="mod-action-days" data-days="${d}">${d} ימים</button>`).join("")}</div></label>` : "";
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="modActionTitle" data-cloud-dialog="modAction" style="align-items:center;padding:0 20px;">
      <div class="modal-sheet" style="border-radius:22px;max-height:none;">
        <div style="padding:24px 22px calc(env(safe-area-inset-bottom,0px) + 20px);">
          <h2 id="modActionTitle" style="margin-top:0;color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:8px;">${esc(def.label)}</h2>
          ${def.effect ? `<div style="color:var(--steel);font-size:12.5px;line-height:1.6;margin-bottom:10px;" data-mod-action-subject="1">${subjectSentenceHtml(def.effect, a.subjectName || MOD_UNKNOWN_AUTHOR_TEXT)}</div>` : ""}
          ${days}
          <label class="field" style="margin-top:10px;"><span class="field-label">הערה (רשות)</span>
            <textarea class="text-input" data-mod-note maxlength="500" placeholder="נרשמת ביומן">${esc(a.note || "")}</textarea></label>
          ${a.error ? `<div class="footer-note" role="alert" style="color:var(--red-text);">${esc(a.error)}</div>` : ""}
          <div class="chip-row" style="margin-top:12px;">
            <!-- "חזרה", not "ביטול" (2026-09-15). Every other dismissal in this
                 app says ביטול and that consistency is normally right - but here
                 it collides with the domain: the restrictions panel beside this
                 one uses "ביטול ההגבלה" to mean REVOKE the restriction. So a
                 button reading ביטול next to a title reading "הגבלת פרסום
                 קבועה" genuinely reads two ways - dismiss this dialog, or undo
                 the restriction. Hebrew has a collision English does not, and
                 the dismissal is the one that has to move. -->
            <button class="chip-btn" data-community-action="mod-action-cancel">חזרה</button>
            <!-- The primary repeats the TITLE's verb+noun instead of saying
                 "אישור". A destructive confirm labelled "Confirm" makes the
                 member re-read the title to find out what they are confirming,
                 at the exact moment they are deciding whether to. The sibling
                 sheet in this file (renderGhostReclaimSheet) already does this
                 correctly - its button says "שחרור ההזמנה" - so this was the
                 odd one out rather than a house style. -->
            <button class="chip-btn primary${def.destructive ? " danger" : ""}" data-community-action="mod-action-run"${a.saving ? " disabled" : ""}>${a.saving ? "מבצע…" : esc(def.label)}</button>
          </div>
        </div>
      </div>
    </div>`;
  }
  // Five-persona UX audit, defect 3. The reclaim confirmation - the one
  // confirmation in this app that names its subject. Structure follows
  // renderModActionSheet above (title, body, optional note, error line, two
  // buttons), with the subject card added at the top: an admin about to
  // release someone's invite must be able to see WHOSE without leaving the
  // sheet, and for a ghost that never set credentials the invite's own label
  // is the only string that can identify them at all.
  function renderGhostReclaimSheet() {
    const a = state.admin.reclaim;
    if (!a) return "";
    const g = a.item;
    const meta = [ghostSourceLabel(g.invite_source), ghostStalledText(g.stalled_days)];
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="ghostReclaimTitle" data-cloud-dialog="reclaimInvite" style="align-items:center;padding:0 20px;">
      <div class="modal-sheet" style="border-radius:22px;max-height:none;">
        <div style="padding:24px 22px calc(env(safe-area-inset-bottom,0px) + 20px);">
          <h2 id="ghostReclaimTitle" style="margin-top:0;color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:8px;">שחרור ההזמנה</h2>
          <div class="chart-card" style="margin-bottom:10px;" data-reclaim-subject="1">
            <div style="font-weight:800;">${bidiText(ghostDisplayName(g))}</div>
            <div style="color:var(--steel);font-size:12px;margin-top:4px;">${meta.map(bidiText).join(" · ")}</div>
          </div>
          <div style="color:var(--steel);font-size:12.5px;line-height:1.7;margin-bottom:10px;">
            <div>${bidiText(g.invite_source === "person_invite" ? "ההזמנה האישית תחזור להמתנה, ואפשר יהיה להשתמש שוב באותו קוד." : "שימוש אחד יוחזר לקוד ההצטרפות המשותף.")}</div>
            <div>${bidiText("אם נוצר בפיד פוסט על הצטרפות למועדון, הוא יוסר.")}</div>
            <div style="margin-top:6px;">${bidiText("החשבון לא יימחק ולא תישלח שום הודעה. מי שהתחיל להירשם פשוט יחזור למסך קוד ההזמנה.")}</div>
            <div style="margin-top:6px;">${bidiText(ghostAfterwardsText(g))}</div>
          </div>
          <label class="field" style="margin-top:10px;"><span class="field-label">הערה (רשות)</span>
            <textarea class="text-input" data-reclaim-note maxlength="500" placeholder="נרשמת ביומן הניהול">${esc(a.note || "")}</textarea></label>
          ${a.error ? `<div class="footer-note" role="alert" style="color:var(--red-text);">${esc(a.error)}</div>` : ""}
          <div class="chip-row" style="margin-top:12px;">
            <button class="chip-btn" data-community-action="reclaim-cancel">ביטול</button>
            <button class="chip-btn primary danger" data-community-action="reclaim-run"${a.saving ? " disabled" : ""}>${a.saving ? "משחרר…" : "שחרור ההזמנה"}</button>
          </div>
        </div>
      </div>
    </div>`;
  }
  // COMM-152. "View context" opens the reported content in place. Light by
  // design: the excerpt the queue row already carries plus a shortcut into
  // the feed for a post.
  function renderModContextOverlay() {
    const c = state.admin.modContext;
    if (!c) return "";
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="modContextTitle" data-cloud-dialog="modContext" style="align-items:center;padding:0 20px;">
      <div class="modal-sheet" style="border-radius:22px;max-height:none;">
        <div style="padding:24px 22px calc(env(safe-area-inset-bottom,0px) + 20px);">
          <h2 id="modContextTitle" style="margin-top:0;color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:8px;">הקשר הדיווח</h2>
          <div style="color:var(--steel);font-size:12.5px;">${esc(MOD_TARGET_LABEL[c.target_type] || "פוסט")} מאת ${bidiText(c.content_author_name || MOD_UNKNOWN_AUTHOR_TEXT)}</div>
          <div class="chart-card" style="margin-top:8px;white-space:pre-wrap;">${bidiText(String(c.content_excerpt || "התוכן הוסר"))}</div>
          ${Array.isArray(c.reporters) && c.reporters.length ? `<div style="color:var(--steel);font-size:12px;margin-top:8px;">דווח ע״י: ${c.reporters.map((r) => esc(r.name || r.id)).join(", ")}</div>` : ""}
          <div class="chip-row" style="margin-top:12px;">
            <button class="chip-btn" data-community-action="mod-context-close">סגירה</button>
            ${c.target_type === "post" ? `<button class="chip-btn primary" data-community-action="mod-context-open-feed">פתיחה בפיד</button>` : ""}
          </div>
        </div>
      </div>
    </div>`;
  }
