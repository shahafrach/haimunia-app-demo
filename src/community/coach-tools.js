"use strict";
// ---- Community: coach tools (COMM-223..226, COMM-304) ---------------------
//
// The coach dashboard — Celebrate, Welcome, Engage — plus member of the week,
// the monthly club recap a coach publishes, and the two Account-tab lists
// that report who has gone quiet.
//
// Moved out of cloud.js unchanged — every line byte-identical to what it was
// there. Classic <script>, no IIFE, loaded before cloud.js; see
// src/community/events.js's header for why each of those matters.
//
// Read coachAppSignalNote() and renderCoachAppActivitySection() before
// touching the Engage half. The honesty rules there are deliberate and were
// argued for: "אין נתונים" is a statement about our records, and the earlier
// "מעולם לא" was a statement about the member that was frequently false. The
// section goes red only when there is something to act on.
//
// WHAT STAYED BEHIND, deliberately: activeRestrictionRow, loadMyRestriction
// and renderMyRestrictionPanel, which sit in the middle of this code in
// cloud.js. They are the member's own side of a moderation decision, not a
// coach tool, and they move with admin.

  async function loadInactiveMembers() {
    if (!state.user || !isStaff()) return;
    const { data, error } = await client.rpc("coach_inactive_members");
    state.club.inactiveMembers = error ? [] : (data || []);
  }
  async function loadNewMembers() {
    if (!state.user || !isStaff()) return;
    const { data, error } = await client.rpc("coach_new_members");
    state.club.newMembers = error ? [] : (data || []);
  }
  // Whether the two lists above have any data behind them AT ALL.
  //
  // An empty inactive list means one of two completely different things -
  // "everyone is active" or "we have never received a single data point" -
  // and the list itself cannot tell them apart. This section used to assert
  // the first in both cases ("כולם פעילים"), which on a brand-new club is a
  // confident all-clear over an empty table. Distinguishing them needs a
  // fact, not a heuristic, which is what coach_activity_signal_status()
  // (202609060020) returns: aggregate counts, no member identities.
  async function loadActivitySignal() {
    if (!state.user || !isStaff()) return;
    const { data, error } = await client.rpc("coach_activity_signal_status");
    state.club.activitySignal = error ? null : ((data || [])[0] || null);
  }

  // ==========================================================================
  // COMM-223..226 coach-tools cluster. Coach Dashboard: Celebrate, Welcome,
  // Engage (scaffold, hidden). Challenges re-surfaces renderChallengesListSection()
  // (COMM-201..207) unchanged - see the render function below - so it owns no
  // state or load function here. Schema shipped in 202608290013; see the
  // three "###" subsections under "Needs from schema, coach-tools" in
  // contracts.md for the exact shapes read below.
  //
  // Read-path note (COMM-224 "new members"), RESOLVED by 202609060020 - both
  // halves of what used to be recorded here as open follow-ups.
  //
  // JOIN DATE. The ticket asked for invite_redemptions.redeemed_at. That
  // table has exactly one SELECT policy, invite_redemptions_self_select
  // (202608270003, `user_id = auth.uid()`), so a coach's cross-user select of
  // it returns nothing but their own row - the "looks like it works, does
  // nothing" failure mode 202608290013's own comments flag for the
  // Assign-coach column. This section used profiles.created_at instead and
  // logged a follow-up. The follow-up is closed the third way: the read moved
  // INTO a SECURITY DEFINER function (coach_new_members), which reads
  // redeemed_at across users without widening any policy - the same thing
  // coach_celebrate_feed() already does for anniversaries. redeemed_at is now
  // the canonical join date, with created_at as the fallback.
  //
  // SESSIONS LOGGED. There genuinely was no coach-readable lifetime session
  // count when this section shipped, and community_streaks.current_streak was
  // reused as a stand-in. That was wrong in a way worth naming: it counts
  // CONSECUTIVE DAYS THE MEMBER OPENED THE APP, and it sat beside a new
  // member's name under the label "רצף נוכחי" where a coach reads it as
  // training. coach_new_members().sessions_logged replaces it - a real count
  // of attendance_log days, delivered as an AGGREGATE by the definer function
  // precisely so that 202609060013's rule (raw attendance rows are admin
  // rank, not coach rank) keeps holding.
  function celebrateItemKey(item) { return `${item.kind}|${item.user_id}|${item.occurred_at}`; }
  async function loadCoachCelebrate() {
    if (!state.user || !isStaff()) return;
    state.coach.celebrate.loading = true;
    state.coach.celebrate.error = false;
    rerender();
    const { data, error } = await client.rpc("coach_celebrate_feed", { p_days: 7 });
    state.coach.celebrate.loading = false;
    state.coach.celebrate.loaded = true;
    if (error) { state.coach.celebrate.error = true; state.coach.celebrate.items = []; rerender(); return; }
    // The RPC already sorts newest-first; never re-sorted here.
    const items = data || [];
    state.coach.celebrate.items = items;
    // Fresh-eyes audit: without this, `congratulated` only ever reflected
    // the current tab's memory, so a fresh load showed "ברכה" (not done)
    // for an item a coach - possibly this same coach, in an earlier
    // session - had already congratulated, inviting a real duplicate
    // comment/post on the very next tap. Reconstructed the same way
    // congratulateCelebrateItem()'s own pre-write check works: an exact
    // match on celebrateTemplateBody()'s deterministic text against what's
    // really on the post/feed, not client memory.
    const postIds = items.filter((it) => it.post_id).map((it) => it.post_id);
    const [commentRows, coachPostRows] = await Promise.all([
      postIds.length ? client.from("post_comments").select("post_id,body").in("post_id", postIds) : Promise.resolve({ data: [] }),
      client.from("workout_posts").select("body").eq("post_type", "POST_COACH"),
    ]);
    const comments = commentRows.data || [];
    const coachPosts = coachPostRows.data || [];
    const congratulated = {};
    for (const it of items) {
      const body = celebrateTemplateBody(it);
      const already = it.post_id
        ? comments.some((c) => c.post_id === it.post_id && c.body === body)
        : coachPosts.some((p) => p.body === body);
      if (already) congratulated[celebrateItemKey(it)] = true;
    }
    state.coach.celebrate.congratulated = congratulated;
    rerender();
  }
  // COMM-225 templates. Short, Hebrew, kind-specific, and well under the
  // 1000-char comment/post cap add_post_comment and post_create both
  // already enforce server-side.
  function celebrateTemplateBody(item) {
    const name = item.display_name || (item.handle ? "@" + item.handle : "חבר/ה");
    const d = item.detail || {};
    if (item.kind === "pr") {
      const movement = d.movement ? ` ב${d.movement}` : "";
      const result = d.result ? ` (${d.result})` : "";
      return `כל הכבוד ל${name} על שיא חדש${movement}${result}! 💪`;
    }
    if (item.kind === "anniversary") {
      const years = Number(d.years) || 0;
      const yearsLabel = years === 1 ? "שנה" : `${years} שנים`;
      return `מזל טוב ל${name} על ${yearsLabel} במועדון! 🎉`;
    }
    if (item.kind === "challenge_completion") {
      const title = d.title ? ` את האתגר ${d.title}` : " את האתגר";
      return `כל הכבוד ל${name} על השלמת${title}! 🏆`;
    }
    return `כל הכבוד ל${name}! 🎉`;
  }
  // COMM-225. post_id present -> add_post_comment on that post. post_id
  // null -> post_create (always lands POST_TEXT, 202608280023) followed by
  // one direct own-row update to post_type 'POST_COACH', the exact
  // workaround the events cluster already established for post_create's own
  // type gaps (see ensureEventCompanionPost below) rather than a new RPC or
  // a schema change this ticket does not own. No confirmation dialog: the
  // tap itself is the confirmation. congratulated/busy are keyed by
  // celebrateItemKey() so a second tap on an already-sent item, or a tap
  // while the first is still in flight, is a no-op before the server rate
  // limit would even see it.
  async function congratulateCelebrateItem(item) {
    if (!item) return;
    const key = celebrateItemKey(item);
    if (state.coach.celebrate.congratulated[key] || state.coach.celebrate.busy === key) return;
    state.coach.celebrate.busy = key;
    rerender();
    const body = celebrateTemplateBody(item);
    // Security hunt (2026-09-11): this used to be an exact-body-text SELECT
    // against post_comments/workout_posts, followed by two direct RPCs
    // (add_post_comment / post_create). Confirmed live against real local
    // Postgres: calling either RPC directly - any member's own devtools,
    // bypassing this file entirely - produced real duplicate congratulation
    // comments with no server-side objection, since neither the SELECT nor
    // the in-memory `congratulated` map is a server boundary.
    // coach_congratulate() (202609110002) is the actual fix: it claims a
    // unique (coach, kind, target member, occurred_at) row - the same triple
    // celebrateItemKey() already uses - before writing anything, so a second
    // call for the same real event, from any source, writes nothing and
    // returns null instead of a new id. That claim is this function's whole
    // duplicate check now; the SELECT above is gone, not duplicated.
    const { data: resultId, error } = await client.rpc("coach_congratulate", {
      p_kind: item.kind,
      p_target_user_id: item.user_id,
      p_occurred_at: item.occurred_at,
      p_post_id: item.post_id || null,
      p_parent_comment_id: null,
      p_body: body,
    });
    state.coach.celebrate.busy = null;
    if (error) { setMessage("לא ניתן היה לשלוח ברכה. נסו שוב."); rerender(); return; }
    // A null resultId means the claim was already taken - a genuine replay
    // (reload, second coach, second device) - and nothing new was written.
    // The item is still marked done, matching what a fresh loadCoachCelebrate()
    // would show, but COMM-233's tracking below fires only on a REAL write:
    // tracking a no-op replay would reopen the exact gameable-metric half of
    // this finding the claim above just closed on the write side.
    state.coach.celebrate.congratulated[key] = true;
    setMessage("");
    if (resultId) track(A.COACH_CONGRATULATE_SENT, { kind: item.kind || null, via: item.post_id ? "comment" : "post" });
    rerender();
  }

  // ---- Welcome (COMM-224) --------------------------------------------------
  async function loadCoachWelcome() {
    if (!state.user || !isStaff()) return;
    state.coach.welcome.loading = true;
    state.coach.welcome.error = false;
    rerender();
    // ONE call where there used to be two (a profiles range-scan plus a
    // batched member_contact_log read). Not consolidation for its own sake:
    // `sessions_logged` cannot be obtained client-side at all, because
    // 202609060013 deliberately narrowed attendance_log's staff read to
    // has_perm('community.analytics.view') - admin rank - so a coach's own
    // select of it returns zero rows. The count has to come from a definer
    // function, and coach_new_members() is the one that already answers every
    // other question this section asks.
    const { data, error } = await client.rpc("coach_new_members", { p_within_days: 30 });
    if (error) {
      state.coach.welcome.loading = false; state.coach.welcome.loaded = true; state.coach.welcome.error = true; state.coach.welcome.members = [];
      rerender();
      return;
    }
    // The RPC excludes soft-deleted profiles server-side, so there is nothing
    // left for a client-side filter to add here.
    const rows = data || [];
    // Mapped onto the shape renderCoachWelcomeRow() and the assign/contact
    // handlers already use (id, created_at), so this is a change of data
    // SOURCE and not a rewrite of the section.
    state.coach.welcome.members = rows.map((r) => ({
      id: r.user_id,
      handle: r.handle,
      display_name: r.display_name,
      avatar_url: r.avatar_url,
      created_at: r.joined_on,
      assigned_coach_id: r.assigned_coach_id,
      days_since_join: r.days_since_join,
      sessions_logged: r.sessions_logged,
      has_opened_app: r.has_opened_app,
    }));
    // Contact status rides along on the same row now. coachMarkContacted()
    // still writes into this map directly, so an optimistic update after a
    // "Mark contacted" tap behaves exactly as before.
    const contactedIds = {};
    for (const r of rows) if (r.contacted) contactedIds[r.user_id] = true;
    state.coach.welcome.contactedIds = contactedIds;
    state.coach.welcome.loading = false;
    state.coach.welcome.loaded = true;
    rerender();
    // Live bug hunt (2026-09-11): "ברכה" had no duplicate-send guard at
    // all beyond the in-flight lock in coachWelcomeMember() below - once
    // that call finished, the button was available again for a fresh,
    // deliberate second tap (or the SAME data surviving a navigate-away-
    // and-back), with nothing remembering "already welcomed". A coach
    // could spam unlimited duplicate welcome comments on one member.
    // Reconstructed from real server data, same shape as
    // loadCoachCelebrate()'s own congratulated map just above: one
    // unscoped POST_NEW_MEMBER fetch (mirrors findNewMemberPost()'s own
    // query, batched here instead of once per member) to find each
    // member's post, then one batched comment lookup for an exact-body
    // match against WELCOME_TEMPLATE_BODY.
    const { data: newMemberPosts } = await client.from("workout_posts").select("id,metadata").eq("post_type", "POST_NEW_MEMBER");
    const postIdByMember = {};
    for (const p of (newMemberPosts || [])) {
      if (p.metadata && p.metadata.member_id) postIdByMember[p.metadata.member_id] = p.id;
    }
    const postIds = Object.values(postIdByMember);
    const { data: welcomeComments } = postIds.length
      ? await client.from("post_comments").select("post_id,body").in("post_id", postIds)
      : { data: [] };
    const welcomed = {};
    for (const memberId of Object.keys(postIdByMember)) {
      const pid = postIdByMember[memberId];
      if ((welcomeComments || []).some((c) => c.post_id === pid && c.body === WELCOME_TEMPLATE_BODY)) welcomed[memberId] = true;
    }
    state.coach.welcome.welcomed = welcomed;
    rerender();
  }
  // Same lookup shape ensureEventCompanionPost() below already uses for
  // "does a companion post already exist for this record": no stored
  // pointer from profiles back to the POST_NEW_MEMBER row, so the metadata
  // carried on the post itself (member_id, set the way
  // community-post-cards.test.mjs's fixture and renderNewMemberPostCard's
  // own reading of it both already assume) is the source of truth.
  //
  // COMM-107's producer shipped in 202608290014 (invite_redemptions_new_member_post,
  // pgTAP-verified against real Postgres: supabase/tests/0033_new_member_post_test.sql,
  // 26/26). This comment used to say the producer was never built - stale
  // as of that migration, and worth a note for whoever finds this next:
  // the mock backend (test/helpers/mockSupabase.mjs) does not simulate the
  // trigger, so a mock-only session (a Playwright script, a manual QA pass
  // against installMockCloud) will see "Welcome" fail exactly like the
  // pre-fix bug described here, even though it works against a real
  // project. Fresh-eyes audit: independently confirmed this the hard way -
  // a coach-persona review reported it as dead on arrival before this
  // comment was corrected, on a mock run. The standard error message still
  // covers a genuine "no matching post found" the same way it covers a
  // failed RPC, rather than pretending the tap worked.
  async function findNewMemberPost(memberId) {
    const { data, error } = await client.from("workout_posts").select("id,post_type,metadata").eq("post_type", "POST_NEW_MEMBER");
    if (error) return null;
    return (data || []).find((r) => r.metadata && r.metadata.member_id === memberId) || null;
  }
  // Reuses welcomeNewMember(postId) (COMM-107/COMM-124) rather than a second
  // add_post_comment call with a near-duplicate template - one Hebrew
  // welcome string, one place it is sent from.
  async function coachWelcomeMember(memberId) {
    // welcomeNewMember() itself is now the authoritative duplicate-send
    // guard (its own comment explains why - two entry points share it);
    // this proactive check is what keeps the dashboard button from ever
    // reading "ברכה" for a member already welcomed in an earlier session,
    // same as congratulated/reachedOut elsewhere in this file.
    // PER MEMBER, not one shared flag. Live bug hunt, fresh round 6
    // (2026-09-15). busy held a single memberId and every guard tested it for
    // truthiness, so while one member's action was in flight a tap on ANY
    // other member returned silently - while renderCoachWelcomeRow() disabled
    // only the row actually in flight, so the other buttons still looked
    // live. A coach working down a list of new members, which is exactly what
    // this section is for on a club onboarding a cohort, lost taps with no
    // toast, no error and no visible change: they believed they had welcomed
    // someone the app never touched.
    //
    // A map, matching resetPasswordBusy and challengeJoinBusy elsewhere in
    // this file. A scalar could not be made correct here even with a matching
    // guard: two members in flight at once would have one completion clear
    // the other's flag.
    if (!memberId || state.coach.welcome.busy[memberId] || state.coach.welcome.welcomed[memberId]) return;
    state.coach.welcome.busy[memberId] = true;
    rerender();
    const post = await findNewMemberPost(memberId);
    if (!post) {
      delete state.coach.welcome.busy[memberId];
      setMessage("לא ניתן היה לבצע את הפעולה. נסו שוב.");
      rerender();
      return;
    }
    const welcomed = await welcomeNewMember(post.id, "coach_section");
    if (welcomed) state.coach.welcome.welcomed[memberId] = true;
    delete state.coach.welcome.busy[memberId];
    rerender();
  }
  // Assign coach (optional). Only write path is coach_assign_coach() -
  // profiles has exactly one UPDATE policy and it is own-row only
  // (202608290013's own correction to this ticket's original "direct RLS
  // update" ask). p_coach_id null clears the assignment. There is no
  // staff-readable directory RPC on this schema to build a real dropdown of
  // coaches from (admin_search_members is real-is_admin-only, not
  // is_staff() - 202608270011), so the picker is: assign to me (always
  // valid, the caller is staff by construction of this whole surface),
  // clear, or resolve another coach by their handle through the same
  // club-wide profiles read every other lookup here already uses - the
  // server still validates the target is staff and raises otherwise, so a
  // typo or a plain member's handle fails safely rather than silently
  // mis-assigning. A real staff-directory RPC would turn this into an
  // actual dropdown; noted as a follow-up rather than invented here.
  async function coachAssignCoach(memberId, coachId) {
    if (!memberId || state.coach.welcome.busy[memberId]) return;
    state.coach.welcome.busy[memberId] = true;
    rerender();
    const { error } = await client.rpc("coach_assign_coach", { p_user_id: memberId, p_coach_id: coachId || null });
    delete state.coach.welcome.busy[memberId];
    if (error) { setMessage(failText("לא ניתן היה לבצע את הפעולה. נסו שוב.", error)); rerender(); return; }
    const m = state.coach.welcome.members.find((x) => x.id === memberId);
    if (m) m.assigned_coach_id = coachId || null;
    setMessage(coachId ? "המאמן/ת שויכ/ה" : "השיוך בוטל");
    rerender();
  }
  async function coachAssignByHandle(memberId) {
    const handle = String((state.coach.welcome.assignDrafts || {})[memberId] || "").trim().toLowerCase().replace(/^@/, "");
    if (!handle) return;
    const { data } = await client.from("profiles").select("id").eq("handle", handle).maybeSingle();
    if (!data || !data.id) { setMessage("לא ניתן היה לבצע את הפעולה. נסו שוב."); rerender(); return; }
    await coachAssignCoach(memberId, data.id);
  }
  // Mark contacted. Staff-only insert, contacted_by defaults to auth.uid()
  // server-side (202608290013), so the client sends only {user_id, note}.
  async function coachMarkContacted(memberId) {
    if (!memberId || state.coach.welcome.busy[memberId]) return;
    state.coach.welcome.busy[memberId] = true;
    rerender();
    const note = String((state.coach.welcome.contactDrafts || {})[memberId] || "").trim().slice(0, 500);
    const { error } = await client.from("member_contact_log").insert({ user_id: memberId, note });
    delete state.coach.welcome.busy[memberId];
    if (error) { setMessage(failText("לא ניתן היה לבצע את הפעולה. נסו שוב.", error)); rerender(); return; }
    state.coach.welcome.contactedIds[memberId] = true;
    setMessage("סומן כנוצר קשר");
    rerender();
  }

  // ---- Engage (COMM-226 scaffold, COMM-304 real data + actions) ------------
  // Flag-gated (state.featureFlags.coachEngage, defaults ON as of COMM-304)
  // on top of the staff gate every other section here already has - COMM-226
  // asked that no code path reach coach_engagement_flags outside the
  // flag-gated staff surface, and that still holds: this is never called
  // from refreshSession() the way the always-on staff loads above are, only
  // from the coach tab's own lazy load. The table's own RLS
  // (`user_id <> auth.uid()`, COMM-011, re-asserted against real rows by
  // 202608310008) is the real boundary that keeps a flagged member from ever
  // reading their own row, staff or not; nothing here works around it.
  //
  // COLUMNS DELIBERATELY NOT SELECTED: baseline_sessions_per_week and
  // recent_sessions_per_week. COMM-304's own "Frontend states" wording -
  // "no raw session numbers shown to anyone but the reviewing staff member"
  // - is a narrower bar than "staff may see them", so this reads the same
  // five columns COMM-226 already selected and no more: id, user_id, level,
  // status, flagged_at. The level bucket is the signal a coach needs to
  // decide whether to act; the two figures behind it are not rendered
  // anywhere in this file.
  //
  // PROFILE JOIN, AND A KNOWN GAP: display name/handle/avatar are a second,
  // separate `.from("profiles")` read batched over every flagged user_id -
  // the same shape coachWelcome.contactedIds already uses for
  // member_contact_log - rather than an embedded `coach_engagement_flags`
  // select with `profiles(...)` nested in it. Worth flagging for a reviewer:
  // profiles_read_authenticated (202608280003) only bypasses a member's own
  // `visible_to_club = false` for `is_admin()`, not for `is_staff()` - so a
  // coach who is not an admin resolving a flagged member who has hidden
  // their own profile from the club gets nothing back for that id, and the
  // row below falls back to the generic "חבר/ה" label instead of a name.
  // Same failure mode COMM-224's own comment already logged for
  // invite_redemptions ("looks like it works, does nothing" for a coach,
  // not for an admin) - not fixed here, since fixing it is a policy change
  // this client-only ticket does not own.
  async function loadCoachEngageFlags() {
    if (!state.user || !isStaff() || !state.featureFlags.coachEngage) return;
    state.coach.engage.loading = true;
    state.coach.engage.error = false;
    rerender();
    const { data, error } = await client.from("coach_engagement_flags").select("id,user_id,level,status,flagged_at").eq("status", "open").order("flagged_at", { ascending: false });
    if (error) {
      state.coach.engage.loading = false; state.coach.engage.loaded = true; state.coach.engage.error = true; state.coach.engage.items = [];
      rerender();
      return;
    }
    const items = data || [];
    const { map: profiles } = await loadProfilesById(items.map((it) => it.user_id));
    // Fresh-eyes audit: reachedOut used to be a purely in-memory dedupe that
    // reset on every reload - a coach who reopened the dashboard saw "פנייה"
    // again for a member already reached out to, and a second tap wrote a
    // real, duplicate outreach post. member_contact_log is the exact table
    // Welcome's own "mark contacted" already uses for the identical
    // question ("has staff already reached this member"), any staff can
    // read any row (member_contact_log_staff_select), so this reconstructs
    // reachedOut from real data instead of client memory - correct across
    // reloads AND across coaches/devices. Scoped to contacted_at >= this
    // flag's own flagged_at, not "ever contacted": an old Welcome-era
    // contact-log row from months ago must not silently mark a brand-new
    // decline as already handled.
    const flaggedIds = items.map((it) => it.user_id);
    let reachedOut = {};
    if (flaggedIds.length) {
      const { data: contacts } = await client.from("member_contact_log").select("user_id,contacted_at").in("user_id", flaggedIds);
      for (const it of items) {
        if ((contacts || []).some((c) => c.user_id === it.user_id && c.contacted_at >= it.flagged_at)) reachedOut[it.id] = true;
      }
    }
    state.coach.engage.items = items;
    state.coach.engage.profiles = profiles;
    state.coach.engage.reachedOut = reachedOut;
    state.coach.engage.loading = false;
    state.coach.engage.loaded = true;
    rerender();
  }
  // The three level buckets coach_detect_engagement_decline() writes
  // (202608310008), translated for display - the raw enum value never
  // reaches the DOM as text. Colour is severity only, not a new signal:
  // `inactive` reuses the same red the section header already carries.
  const ENGAGE_LEVEL_LABELS = { mild: "ירידה קלה בהגעה", significant: "ירידה משמעותית בהגעה", inactive: "לא פעיל/ה" };
  const ENGAGE_LEVEL_COLORS = { mild: "var(--brass)", significant: "var(--energy)", inactive: "var(--red)" };
  function engageLevelLabel(level) { return ENGAGE_LEVEL_LABELS[level] || level || ""; }
  function engageLevelColor(level) { return ENGAGE_LEVEL_COLORS[level] || "var(--steel)"; }
  function engageMemberName(userId) {
    const p = state.coach.engage.profiles[userId] || {};
    return p.display_name || (p.handle ? "@" + p.handle : "חבר/ה");
  }
  // COMM-304's "reach out" one-tap action, modeled directly on COMM-225's
  // congratulateCelebrateItem(): no confirmation dialog (the tap itself is
  // the confirmation), deduped by reachedOut so a second tap - or a tap
  // while the first is still in flight - is a no-op. It always takes
  // congratulateCelebrateItem's post_create branch, never its
  // add_post_comment one: an engagement flag has no source post the way a
  // PR or an anniversary does, so there is nothing to comment on. No new
  // "Message" affordance is added - this is the same public
  // post_create + own-row POST_COACH update path Celebrate already uses,
  // per the phase's standing no-direct-messaging resolution.
  //
  // The template is deliberately generic and carries no per-level text -
  // the same warm check-in a coach could send any member, unrelated to why
  // this one was flagged. It never mentions attendance, a session figure or
  // a level. `user_id <> auth.uid()` on this table exists so the flagged
  // member never learns they were flagged; a post that says "we noticed
  // you've been away" would leak exactly that fact, just through a
  // different door than the table it is trying to protect.
  function engageReachOutTemplateBody(name) {
    return `היי ${name}, רק רצינו לומר שלום ולראות מה שלומך! נשמח לראות אותך באימון בקרוב 😊`;
  }
  async function coachEngageReachOut(flagId) {
    if (!flagId) return;
    if (state.coach.engage.reachedOut[flagId] || (state.coach.engage.busy && state.coach.engage.busy.id === flagId)) return;
    const item = state.coach.engage.items.find((it) => it.id === flagId);
    if (!item) return;
    state.coach.engage.busy = { id: flagId, action: "reach-out" };
    rerender();
    const body = engageReachOutTemplateBody(engageMemberName(item.user_id));
    let ok = false;
    const { data: postId, error } = await client.rpc("post_create", { body, visibility: "club", media: [], links: null });
    if (!error && postId) {
      const { error: updErr } = await client.from("workout_posts").update({ post_type: "POST_COACH" }).eq("id", postId);
      ok = !updErr;
    }
    state.coach.engage.busy = null;
    // Fresh-eyes audit: this used to only flip client memory. Also writing
    // a real member_contact_log row (the same table Welcome's "mark
    // contacted" writes) is what makes loadCoachEngageFlags() able to
    // reconstruct reachedOut correctly on the next load, instead of every
    // reload forgetting this outreach ever happened. Best-effort: the
    // outreach post itself already succeeded, so a failure to log it here
    // must not be reported as the reach-out having failed - it only means
    // a reload might show the button re-enabled, not that the member gets
    // messaged twice on its own.
    if (ok) {
      client.from("member_contact_log").insert({ user_id: item.user_id, note: "פנייה יזומה בעקבות ירידה בפעילות" }).then(() => {});
      state.coach.engage.reachedOut[flagId] = true; setMessage("");
      // The engagement_alerts module's one event. After the outreach post
      // actually wrote, inside the `ok` branch, so an alert a coach looked at
      // and could not act on is not recorded as one they acted on.
      //
      // `level` is the coarse engagement enum the row already carries and the
      // row's own badge already shows a coach. The flagged member's id is NOT
      // a prop: a table of "who the club thinks is drifting away", readable by
      // anyone holding community.analytics.view, is exactly the kind of row
      // this module's server-side gate exists to keep narrow.
      //
      // Not a WCAM event. Triaging a queue is staff administration; the coach
      // becomes an active member through the POST_COACH post this just
      // published, which post_created already counts.
      track(A.ENGAGEMENT_FLAG_ACTIONED, { action: "reach_out", level: item.level || null });
    }
    else setMessage("לא ניתן היה לשלוח פנייה. נסו שוב.");
    rerender();
  }
  // Review / dismiss. A direct RLS update on `status`, `reviewed_by`,
  // `reviewed_at` - COMM-304's schema half (202608310008) verified rather
  // than assumed that coach_engagement_flags_staff_update (Phase 0,
  // 202608280011) already covers all three columns for any staff member
  // acting on another member's row, so no migration backs this call. Once
  // resolved, a flag falls out of the open list this section reads (it only
  // ever selects status='open'), so the row is removed locally rather than
  // re-fetched.
  async function coachEngageResolveFlag(flagId, status) {
    if (!flagId || (state.coach.engage.busy && state.coach.engage.busy.id === flagId)) return;
    state.coach.engage.busy = { id: flagId, action: status };
    rerender();
    const { error } = await client.from("coach_engagement_flags")
      .update({ status, reviewed_by: state.user.id, reviewed_at: new Date().toISOString() })
      .eq("id", flagId);
    state.coach.engage.busy = null;
    if (error) { setMessage(failText("לא ניתן היה לבצע את הפעולה. נסו שוב.", error)); rerender(); return; }
    // Read BEFORE the filter below removes the row - `level` lives on the
    // item and the next line is what drops it.
    const resolved = state.coach.engage.items.find((it) => it.id === flagId);
    track(A.ENGAGEMENT_FLAG_ACTIONED, { action: status === "reviewed" ? "reviewed" : "dismissed", level: (resolved && resolved.level) || null });
    state.coach.engage.items = state.coach.engage.items.filter((it) => it.id !== flagId);
    delete state.coach.engage.reachedOut[flagId];
    setMessage(status === "reviewed" ? "סומן כנבדק" : "הפריט נדחה");
    rerender();
  }

  // ---- Member of the Week (COMM-315) ---------------------------------------
  // Staff-only fifth section of the Coach Dashboard. Schema shipped in
  // 202609010001 (see contracts.md, "Needs from schema, member of the week").
  // member_of_week_candidates() is the whole read: one jsonb envelope, always
  // exactly one row (data[0], no client-side join or reshape), carrying the
  // week's rotation category, its (at most 3) computed candidates - or []
  // for the coachs_pick week, which is that category's definition and not an
  // empty result - whether the week is already published, and last week's
  // member so the free-selection form can name them rather than a coach
  // discovering the once-per-two-weeks rule by hitting it. Never
  // auto-published: COMM-309's generated-draft/staff-publishes shape, the
  // same one Celebrate already uses.
  async function loadCoachMemberOfWeek() {
    if (!state.user || !isStaff()) return;
    state.coach.memberOfWeek.loading = true;
    state.coach.memberOfWeek.error = false;
    rerender();
    const { data, error } = await client.rpc("member_of_week_candidates", { p_week_start: null });
    if (error || !data || !data[0]) {
      state.coach.memberOfWeek.loading = false;
      state.coach.memberOfWeek.loaded = true;
      state.coach.memberOfWeek.error = true;
      state.coach.memberOfWeek.envelope = null;
      rerender();
      return;
    }
    const envelope = data[0];
    state.coach.memberOfWeek.envelope = envelope;
    // One small, separate profile read (loadProfilesById - the shared shape
    // coachEngage/loadFollowList also use, rather than an embedded join)
    // for the two ids the envelope names but does not itself carry a
    // display name for.
    const { map: profiles } = await loadProfilesById([envelope.published && envelope.published.user_id, envelope.previous_week_user_id]);
    state.coach.memberOfWeek.publishedProfile = envelope.published ? (profiles[envelope.published.user_id] || null) : null;
    state.coach.memberOfWeek.previousProfile = envelope.previous_week_user_id ? (profiles[envelope.previous_week_user_id] || null) : null;
    state.coach.memberOfWeek.loading = false;
    state.coach.memberOfWeek.loaded = true;
    state.coach.memberOfWeek.error = false;
    rerender();
  }
  // The five real Postgres errors member_of_week_publish() raises (COMM-315's
  // schema half, verbatim), mapped to short Hebrew - the same
  // setMessage()-surfaced pattern coachAssignByHandle/coachMarkContacted and
  // coachEngageResolveFlag already use for a failed staff action, not a new
  // display mechanism. Any other error (network, a future server message)
  // falls back to the same generic retry copy the rest of this cluster uses.
  const MEMBER_OF_WEEK_ERROR_LABELS = {
    "week already published": "השבוע הזה כבר פורסם.",
    "member was recognised last week": "לא ניתן לבחור שוב בחבר/ה שנבחר/ה כבר בשבוע שעבר.",
    "member not found": "לא נמצא/ה חבר/ה כזה/כזאת.",
    "member is not visible to the club": "לא ניתן לפרסם עבור חבר/ה שאינו/ה גלוי/ה למועדון.",
    "reason required for a coach's pick": "יש להזין סיבה לבחירת המאמן/ת.",
  };
  function memberOfWeekErrorText(error) {
    const msg = error && error.message;
    return (msg && MEMBER_OF_WEEK_ERROR_LABELS[msg]) || "הפרסום נכשל. נסו שוב.";
  }
  // One publish path for both the computed-candidate "Publish" button and the
  // free-selection ("coach's pick") form - member_of_week_publish() itself
  // decides which category the row records (on the shortlist -> the week's
  // rotation category, off it -> coachs_pick), so the client never sends a
  // category and never needs two write paths to keep in sync. p_reason is
  // trimmed and capped at 500 client-side too (the same shape
  // coachMarkContacted's member_contact_log.note write already applies); the
  // server re-trims and re-caps regardless, this only keeps what the client
  // sends honest before it does. On success the whole envelope is re-fetched
  // rather than patched by hand, since the server - not the client - resolves
  // which category the row actually records.
  async function publishMemberOfWeek(userId, reason, busyKey) {
    if (!userId || state.coach.memberOfWeek.busy) return;
    state.coach.memberOfWeek.busy = busyKey || userId;
    state.coach.memberOfWeek.publishErr = "";
    rerender();
    const p_reason = String(reason || "").trim().slice(0, 500);
    const { error } = await client.rpc("member_of_week_publish", { p_week_start: null, p_user_id: userId, p_reason });
    if (error) {
      state.coach.memberOfWeek.busy = null;
      state.coach.memberOfWeek.publishErr = memberOfWeekErrorText(error);
      setMessage(state.coach.memberOfWeek.publishErr);
      // THE WEEK MOVED ON WITHOUT US - reload, do not just apologise.
      //
      // Live bug hunt, fresh round 6 (2026-09-15). The success path reloads
      // the candidate list; this path did not, and loadCoachMemberOfWeek() is
      // gated on `!loaded`, so nothing else would ever reload it either -
      // switching sub-tabs and back does not. A second coach publishing first
      // left this one looking at a live-looking list of candidates whose
      // publish buttons were all still enabled, getting the same refusal on
      // every tap, with no way to learn the week was settled short of a full
      // page reload.
      //
      // Only for a conflict. A network failure should leave the list alone so
      // the coach can simply try again - reloading there would replace a
      // retryable state with a spinner and possibly a second failure.
      if (/already published|כבר פורסם/i.test(String((error && error.message) || "") + state.coach.memberOfWeek.publishErr)) {
        state.coach.memberOfWeek.loaded = false;
        await loadCoachMemberOfWeek();
      }
      rerender();
      return;
    }
    memberOfWeekPickReset();
    state.coach.memberOfWeek.pickReason = "";
    setMessage("חבר/ת השבוע פורסמ/ה");
    await loadCoachMemberOfWeek();
    // The member_of_week module's one event, recorded after the reload
    // because the SERVER - not this client - resolves which category the row
    // records (see this function's own header), so the envelope is the only
    // honest source for `category`. `source` is the client's own half of the
    // same question: which of the two controls published, the computed
    // shortlist or the coach's free pick.
    //
    // It counts for WCAM, for the publishing coach, on exactly
    // coach_congratulate_sent's reasoning: the row's user_id is the actor.
    // The recognised member is never made active by somebody else choosing
    // them - never a prop here either, for the same reason.
    track(A.MEMBER_OF_WEEK_PUBLISHED, {
      category: (state.coach.memberOfWeek.envelope && state.coach.memberOfWeek.envelope.category) || null,
      source: busyKey === "pick" ? "manual" : "candidate",
    });
    state.coach.memberOfWeek.busy = null;
    rerender();
  }
  // A computed-candidate publish carries no typed reason - the category
  // itself is the reason, exactly as the three computed categories' own
  // shortlist already states it (COMM-315's schema half only requires a
  // reason when the resolved category is coachs_pick, which a shortlisted
  // candidate's publish can never resolve to).
  function memberOfWeekPublishCandidate(userId) { publishMemberOfWeek(userId, ""); }
  // ---- the picker's own handlers -------------------------------------------
  // Back to the box, with the query cleared: "שינוי" means "I picked the
  // wrong person", and leaving the old name in the search field would make
  // the coach delete it before they could look for the right one.
  function memberOfWeekPickReset() {
    const s = state.coach.memberOfWeek;
    s.pickUserId = null;
    s.pickChosen = null;
    s.pickQuery = "";
    s.pickResults = null;
    s.pickSearching = false;
  }
  function memberOfWeekPickClear() { memberOfWeekPickReset(); state.coach.memberOfWeek.publishErr = ""; rerender(); }
  // The whole row is stored, not just the id: the chosen row has to keep
  // naming the member across every rerender, and re-reading a profile this
  // client already has in hand would be a round trip to learn nothing.
  function memberOfWeekPickSelect(userId) {
    const s = state.coach.memberOfWeek;
    if (!userId || s.busy) return;
    const env = s.envelope;
    if (env && env.previous_week_user_id === userId) return; // the row is disabled; this is the second lock
    const row = memberOfWeekPickSuggestions().find((m) => m.id === userId);
    if (!row) return;
    s.pickUserId = userId;
    s.pickChosen = { display_name: row.display_name, handle: row.handle, avatar_url: row.avatar_url };
    s.publishErr = "";
    rerender();
  }
  // Debounced and token-guarded, the same two protections directorySearch()
  // carries and for the same two reasons: one request per typed word rather
  // than one per character, and a slower earlier keystroke must never
  // overwrite a later one's results.
  let mowPickSearchTimer = null;
  let mowPickSearchToken = 0;
  function memberOfWeekPickSearchDebounced(query) {
    state.coach.memberOfWeek.pickQuery = String(query || "");
    if (mowPickSearchTimer) clearTimeout(mowPickSearchTimer);
    mowPickSearchTimer = setTimeout(() => { mowPickSearchTimer = null; memberOfWeekPickSearch(query); }, SEARCH_DEBOUNCE_MS);
  }
  async function memberOfWeekPickSearch(query) {
    const s = state.coach.memberOfWeek;
    s.pickQuery = String(query || "");
    const q = sanitizeSearchQuery(query);
    const token = ++mowPickSearchToken;
    // Below the threshold community_search answers empty by its own
    // documented floor, so this asks nothing and falls back to the roster
    // filter - exactly what directorySearch() does at the same boundary.
    if (q.length < SEARCH_MIN_CHARS) { s.pickResults = null; s.pickSearching = false; return rerender(); }
    s.pickSearching = true;
    rerender();
    const { data, error } = await client.rpc("community_search", { p_query: q, p_limit: DIRECTORY_PAGE_SIZE });
    if (token !== mowPickSearchToken) return;
    s.pickSearching = false;
    // A failed search is not an empty club. Dropping back to null returns
    // the list to the roster filter, which is a real (if narrower) answer,
    // rather than asserting "no matches" off a request that never landed.
    s.pickResults = (!error && data && Array.isArray(data.members)) ? data.members : null;
    rerender();
  }
  // The free-selection ("coach's pick") form. The member is now an id chosen
  // from the picker rather than a handle typed from memory, so there is no
  // profiles lookup left on this path at all - one fewer round trip, and the
  // "לא נמצא/ה חבר/ה עם שם המשתמש הזה" branch it needed is gone with it (the
  // server's own "member not found" refusal is still mapped, and is still the
  // real authority). The non-empty reason is still checked client-side before
  // ever calling the server, matching COMM-315's own definition of a coach's
  // pick ("a free staff selection... with a short reason staff types") - the
  // server enforces the same rule regardless; this only saves a round trip
  // for the obvious case.
  async function memberOfWeekPublishPick() {
    if (state.coach.memberOfWeek.busy) return;
    const userId = state.coach.memberOfWeek.pickUserId;
    const reason = String(state.coach.memberOfWeek.pickReason || "").trim();
    if (!userId) { state.coach.memberOfWeek.publishErr = "יש לבחור חבר/ה מהרשימה."; setMessage(state.coach.memberOfWeek.publishErr); rerender(); return; }
    if (!reason) { state.coach.memberOfWeek.publishErr = "יש להזין סיבה לבחירת המאמן/ת."; setMessage(state.coach.memberOfWeek.publishErr); rerender(); return; }
    // "pick" rather than userId: the whole free-selection form (not one
    // candidate row) is what should read as busy while this is in flight -
    // the same literal the state comment in cloud.js documents.
    await publishMemberOfWeek(userId, reason, "pick");
  }

  // ---- Monthly club recap (COMM-309) ---------------------------------------
  // Schema half shipped in 202609010002_monthly_club_recap.sql. The client
  // never calls or triggers generation - `recap_monthly_generate()` is
  // service_role-only, granted to nobody else - it only reads
  // `monthly_club_recaps` directly under RLS and calls
  // `recap_monthly_publish(p_id)`. See the migration's own comments and
  // contracts.md, "Needs from schema, monthly club recap (COMM-309, Phase
  // 3)" for the full reasoning.
  //
  // Two separate loaders for two separate audiences reading the same table
  // under two different RLS policies, not one shared function:
  //   loadCoachMonthlyRecap() - the Coach Dashboard staff preview. No
  //     `published_at` filter at all: monthly_club_recaps_staff_select lets
  //     a staff/community.analytics.view reader see ANY row, draft or
  //     published, and the preview's whole job is to show the newest month
  //     regardless of its state.
  //   loadMonthlyRecap() - the member-facing surface. Filters
  //     `published_at is not null` itself, in the query, rather than
  //     leaning on RLS to do it: RLS enforces the same boundary for a real
  //     plain member, but a staff member (who can also read drafts) lands
  //     on the Account tab too, and this filter is what keeps a draft from
  //     leaking into their own member-facing card. Both loaders use the
  //     same "select, order desc, limit 1, read data[0]" shape
  //     refreshRecapView already uses for "no explicit week" rather than
  //     .maybeSingle(), since order()+limit() only apply to a real query,
  //     not to a .maybeSingle() short-circuit.
  async function loadCoachMonthlyRecap() {
    if (!state.user || !isStaff()) return;
    state.coach.monthlyRecap.loading = true;
    state.coach.monthlyRecap.error = false;
    rerender();
    const { data, error } = await client.from("monthly_club_recaps").select("*")
      .order("month_start", { ascending: false }).limit(1);
    state.coach.monthlyRecap.loading = false;
    state.coach.monthlyRecap.loaded = true;
    if (error) {
      state.coach.monthlyRecap.error = true;
      state.coach.monthlyRecap.row = null;
      rerender();
      return;
    }
    state.coach.monthlyRecap.error = false;
    state.coach.monthlyRecap.row = (Array.isArray(data) && data.length) ? data[0] : null;
    rerender();
  }
  async function loadMonthlyRecap() {
    if (!state.user) return;
    state.recaps.monthly.loading = true;
    state.recaps.monthly.error = false;
    rerender();
    const { data, error } = await client.from("monthly_club_recaps").select("*")
      .not("published_at", "is", null).order("month_start", { ascending: false }).limit(1);
    state.recaps.monthly.loading = false;
    state.recaps.monthly.loaded = true;
    if (error) {
      state.recaps.monthly.error = true;
      state.recaps.monthly.row = null;
      rerender();
      return;
    }
    state.recaps.monthly.error = false;
    state.recaps.monthly.row = (Array.isArray(data) && data.length) ? data[0] : null;
    rerender();
  }

  // The two real Postgres errors recap_monthly_publish() raises (the schema
  // half's own comment on that function, verbatim), mapped to short Hebrew -
  // the same setMessage()-surfaced, error.message === "..." pattern
  // coachEngageResolveFlag and memberOfWeekErrorText both already use for a
  // failed staff action. Any other error (network, "not authorized" for a
  // caller whose permission changed between page-load and click) falls back
  // to the same generic retry copy the rest of this cluster uses.
  const MONTHLY_RECAP_ERROR_LABELS = {
    "recap not found": "התקציר לא נמצא.",
    "recap already published": "התקציר כבר פורסם.",
  };
  function monthlyRecapErrorText(error) {
    const msg = error && error.message;
    return (msg && MONTHLY_RECAP_ERROR_LABELS[msg]) || "הפרסום נכשל. נסו שוב.";
  }
  // recap_monthly_publish(p_id) is narrower than the staff read policy - it
  // requires community.analytics.view or real is_admin(), which a plain
  // coach does not hold (the migration's own long comment on this asymmetry
  // is the reason renderCoachMonthlyRecapSection() gates the button on
  // hasPerm(PERM.ANALYTICS_VIEW) || isAdmin(), not on isStaff()). This
  // function does not re-check that client-side before calling - the button
  // it is wired to is already absent for a caller who lacks it, and the
  // server is the real authority regardless - it only maps the refusal if
  // one somehow arrives anyway (e.g. a permission revoked mid-session).
  async function publishMonthlyRecap(id) {
    if (!id || state.coach.monthlyRecap.busy) return;
    state.coach.monthlyRecap.busy = id;
    state.coach.monthlyRecap.publishErr = "";
    rerender();
    const { error } = await client.rpc("recap_monthly_publish", { p_id: id });
    if (error) {
      state.coach.monthlyRecap.busy = null;
      state.coach.monthlyRecap.publishErr = monthlyRecapErrorText(error);
      setMessage(state.coach.monthlyRecap.publishErr);
      rerender();
      return;
    }
    setMessage("התקציר החודשי פורסם");
    await loadCoachMonthlyRecap();
    state.coach.monthlyRecap.busy = null;
    rerender();
  }

  // ==========================================================================
  // COMM-223..226 coach-tools cluster rendering. renderCoachTab() is only
  // ever reached through the "coach" sub-tab, and that sub-tab is only ever
  // added to the tab bar for isStaff() (see the render function below) - so
  // nothing in here repeats a ternary staff-only render gate of its own; the
  // surrounding tab is the gate. A forced state.ui.tab = "coach" for
  // a non-staff caller still falls back to the feed tab there, since the
  // tab bar's own tabs array has no "coach" entry to find.
  // ==========================================================================
  function renderCoachCelebrateItem(item) {
    const key = celebrateItemKey(item);
    const done = !!state.coach.celebrate.congratulated[key];
    const busy = state.coach.celebrate.busy === key;
    const d = item.detail || {};
    const what = item.kind === "pr"
      ? `שיא חדש${d.movement ? ": " + d.movement : ""}${d.result ? " — " + d.result : ""}`
      : item.kind === "anniversary"
      ? `${Number(d.years) || ""} ${Number(d.years) === 1 ? "שנה" : "שנים"} במועדון`
      : item.kind === "challenge_completion"
      ? `השלים/ה את האתגר: ${d.title || ""}`
      : "";
    return `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:8px;">
      <div class="flex gap-10" style="align-items:center;">
        ${avatarHtml(item.display_name || item.handle, 32, item.avatar_url)}
        <div>
          <button class="link-btn" data-community-action="view-profile" data-id="${esc(item.user_id)}" style="padding:0;font-weight:800;color:inherit;">${nameHtml(item.display_name, item.handle)}</button>
          <div style="color:var(--steel);font-size:12px;">${esc(what)} · ${relativeTime(item.occurred_at)}</div>
        </div>
      </div>
      <button class="chip-btn${done ? "" : " primary"}" data-community-action="coach-congratulate" data-key="${esc(key)}"${done || busy ? " disabled" : ""}>${busy ? "שולח…" : done ? "ברכתם" : "ברכה"}</button>
    </div>`;
  }
  function renderCoachCelebrateSection() {
    const c = state.coach.celebrate;
    const body = (c.loading && !c.loaded)
      ? `<div aria-busy="true">${`<div class="chart-card" style="height:56px;background:var(--border);opacity:.35;margin-bottom:10px;"></div>`.repeat(2)}</div>`
      : c.error
      ? `<div class="empty">לא ניתן היה לטעון את לוח המאמנים. נסו שוב.<div class="chip-row" style="justify-content:center;"><button class="chip-btn" data-community-action="coach-celebrate-retry">ניסיון חוזר</button></div></div>`
      : c.items.length ? `<div class="log-list">${c.items.map(renderCoachCelebrateItem).join("")}</div>` : emptyLineHtml({
        // NO ACTION. This feed is built entirely out of things MEMBERS do -
        // a PR logged in the personal training log, a birthday, a club
        // anniversary, a challenge finished. There is no button a coach can
        // press that puts a row here, and per the audit an invented one that
        // goes nowhere is worse than none.
        //
        // ONE LINE, still specific to THIS feed rather than generic - see
        // emptyLineHtml()'s own header for why the four-slot card is the
        // wrong shape on a tab that stacks seven sections. The celebrate
        // list is empty because nobody hit a PR this week, which is a
        // different sentence from the welcome list being empty because
        // nobody joined, and a coach who reads both in one scroll should
        // still be able to tell them apart. What the shorter form drops is
        // the icon and the paragraph that restated the line.
        key: "coach-celebrate",
        text: "שיא אישי, יום הולדת או ותק יופיעו כאן עם כפתור ברכה.",
      });
    return `<div class="ach-section">${sectionHead("var(--energy)", "לחגוג")}${body}</div>`;
  }
  function renderCoachWelcomeRow(m) {
    // days_since_join is computed server-side against the real join date now,
    // so this no longer parses a timestamp in the browser's timezone to
    // answer a question about a calendar day.
    const days = Number.isFinite(Number(m.days_since_join))
      ? Number(m.days_since_join)
      : Math.max(0, Math.floor((Date.now() - new Date(m.created_at).getTime()) / 86400000));
    // WAS: `רצף נוכחי` read off state.club.streaks, i.e.
    // community_streaks.current_streak - which counts CONSECUTIVE DAYS THE
    // MEMBER OPENED THE APP. Shown beside a brand-new member's name, a coach
    // reads that as training. It never was. COMM-224 asked for "sessions
    // attended" and the read-path note above this file's loader recorded that
    // no coach-readable session count existed; 202609060020 added one, as an
    // aggregate count on coach_new_members() (a coach still cannot read the
    // attendance rows themselves - 202609060013 keeps those at admin rank).
    const sessions = Number(m.sessions_logged) || 0;
    // Live bug hunt (2026-09-11): "1 אימונים באפליקציה" - missing singular.
    const trained = sessions === 1 ? "אימון אחד באפליקציה" : sessions ? `${sessions} אימונים באפליקציה` : "לא רשמו אימון באפליקציה";
    const contacted = !!state.coach.welcome.contactedIds[m.id];
    const welcomed = !!state.coach.welcome.welcomed[m.id];
    const busy = !!state.coach.welcome.busy[m.id];
    const assignDraft = (state.coach.welcome.assignDrafts || {})[m.id] || "";
    const contactDraft = (state.coach.welcome.contactDrafts || {})[m.id] || "";
    return `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:8px;">
      <div class="flex gap-10" style="align-items:center;">
        ${avatarHtml(m.display_name || m.handle, 32, m.avatar_url)}
        <div>
          <div style="font-weight:700;">${nameHtml(m.display_name, m.handle)}</div>
          <div style="color:var(--steel);font-size:12px;">${bidiText(`${days === 0 ? "הצטרף/ה היום" : days === 1 ? "הצטרף/ה לפני יום" : `לפני ${days} ימים`} · ${trained} · ${contacted ? "נוצר קשר" : "טרם נוצר קשר"}`)}</div>
          ${m.has_opened_app === false ? `<div style="color:var(--brass);font-size:12px;">${bidiText("עדיין לא נכנס/ה לאפליקציה")}</div>` : ""}
        </div>
      </div>
      <div class="chip-row">
        <button class="chip-btn" data-community-action="coach-welcome-member" data-id="${esc(m.id)}"${(busy || welcomed) ? " disabled" : ""}>${welcomed ? "ברכה נשלחה" : "ברכה"}</button>
        <button class="chip-btn" data-community-action="view-profile" data-id="${esc(m.id)}">צפייה בפרופיל</button>
        ${m.assigned_coach_id
          ? `<button class="chip-btn" data-community-action="coach-assign-clear" data-id="${esc(m.id)}"${busy ? " disabled" : ""}>ביטול שיוך מאמן/ת</button>`
          : `<button class="chip-btn" data-community-action="coach-assign-self" data-id="${esc(m.id)}"${busy ? " disabled" : ""}>שיוך אליי</button>`}
        <button class="chip-btn${contacted ? "" : " primary"}" data-community-action="coach-mark-contacted" data-id="${esc(m.id)}"${busy ? " disabled" : ""}>סימון כנוצר קשר</button>
      </div>
      ${!m.assigned_coach_id ? `<div class="flex gap-6" style="align-items:center;">
        <input class="text-input" style="max-width:160px;" placeholder="שם משתמש מאמן/ת אחר/ת" dir="ltr" data-coach-assign-handle="${esc(m.id)}" value="${esc(assignDraft)}"/>
        <button class="chip-btn" data-community-action="coach-assign-handle" data-id="${esc(m.id)}"${busy ? " disabled" : ""}>שיוך</button>
      </div>` : ""}
      <input class="text-input" placeholder="הערה קצרה לגבי הקשר (אופציונלי)" data-coach-contact-note="${esc(m.id)}" value="${esc(contactDraft)}"/>
    </div>`;
  }
  function renderCoachWelcomeSection() {
    // Redesign, Phase 2. Same shell-hiding shape as renderChallengesListSection's
    // own club_features guard - a coach-only UI section, not member data, so
    // this is the only enforcement point (see CLUB_MODULE_TOGGLES' clientOnly
    // comment); the underlying loaders/RPCs keep their own is_staff() gate
    // regardless of this flag.
    if (!isModuleEnabled("welcome_flow")) return "";
    const w = state.coach.welcome;
    const body = (w.loading && !w.loaded)
      ? `<div aria-busy="true">${`<div class="chart-card" style="height:56px;background:var(--border);opacity:.35;margin-bottom:10px;"></div>`.repeat(2)}</div>`
      : w.error
      ? `<div class="empty">לא ניתן היה לבצע את הפעולה. נסו שוב.<div class="chip-row" style="justify-content:center;"><button class="chip-btn" data-community-action="coach-welcome-retry">ניסיון חוזר</button></div></div>`
      : w.members.length ? `<div class="log-list">${w.members.map(renderCoachWelcomeRow).join("")}</div>` : emptyLineHtml({
        // NO ACTION, and this is the one of the four where that was a
        // genuinely close call. There IS a causal action a coach can take -
        // PERM.MEMBER_INVITE is held by coach and up, so a coach really can
        // create a per-person invite. But that form lives in the Manage TOP-
        // LEVEL tab (renderInviteManagement, manageTab "invites"), and this
        // section is a sub-tab of Community. cloud.js owns setCommunityTab()
        // and setManageTab() and nothing that switches the top-level tab -
        // that nav belongs to app.js. A button here would either not
        // navigate at all or would need a cross-file change, and shipping
        // the first of those is exactly the dead-end button the audit
        // forbids. Raised as a follow-up instead.
        key: "coach-welcome",
        text: "כל מי שהצטרף למועדון בחודש האחרון יופיע כאן לקבלת פנים.",
      });
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--green)", "קבלת פנים")}${body}</div>`;
  }
  // ---- Member of the Week (COMM-315) ---------------------------------------
  // Category-shaped detail text, one branch per member_of_week_candidate_set()
  // shape (contracts.md pins these three: {streak_weeks, rank}, {pr_count},
  // {completions, titles}) - never a raw JSON dump, the same "translate the
  // shape, don't print it" rule ENGAGE_LEVEL_LABELS already applies to the
  // level enum above.
  function memberOfWeekCandidateDetailText(category, detail) {
    const d = detail || {};
    if (category === "consistency_streak") return `רצף של ${(Number(d.streak_weeks) || 0) === 1 ? "שבוע אחד" : `${Number(d.streak_weeks) || 0} שבועות`} · דירוג #${d.rank != null ? esc(d.rank) : "?"}`;
    // Guarded like consistency_streak three lines up. Round 4 fixed that one
    // branch and left its two siblings in the same function untouched - which
    // is the drift shape this hunt keeps finding, here committed by the fix
    // itself. A member's FIRST PR of the week is exactly the === 1 case.
    if (category === "most_prs") return `${(Number(d.pr_count) || 0) === 1 ? "שיא אישי אחד השבוע" : `${Number(d.pr_count) || 0} שיאים אישיים השבוע`}`;
    if (category === "challenge_completion") {
      const titles = Array.isArray(d.titles) ? d.titles.filter(Boolean).join(", ") : "";
      // The third branch of the same trio - see most_prs above.
      const n = Number(d.completions) || 0;
      return `${n === 1 ? "השלמת אתגר אחת" : `${n} השלמות אתגר`}${titles ? `: ${titles}` : ""}`;
    }
    return "";
  }
  function renderMemberOfWeekCandidate(c, category) {
    const busy = state.coach.memberOfWeek.busy === c.user_id;
    return `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:8px;">
      <div class="flex gap-10" style="align-items:center;">
        ${avatarHtml(c.display_name || c.handle, 32, c.avatar_url)}
        <div>
          <button class="link-btn" data-community-action="view-profile" data-id="${esc(c.user_id)}" style="padding:0;font-weight:800;color:inherit;">${nameHtml(c.display_name, c.handle)}</button>
          <div style="color:var(--steel);font-size:12px;">${esc(memberOfWeekCandidateDetailText(category, c.detail))}</div>
        </div>
      </div>
      <button class="chip-btn primary" data-community-action="coach-mow-publish-candidate" data-id="${esc(c.user_id)}"${state.coach.memberOfWeek.busy ? " disabled" : ""}>${busy ? "מפרסם/ת…" : "פרסום"}</button>
    </div>`;
  }
  // The free-selection ("coach's pick") form. Rendered whenever the week is
  // not yet published - alongside the computed candidates when the category
  // has any (COMM-315's own "Populated" frontend state names both the
  // suggestion list and this form together), alongside the empty message
  // when it does not (the ticket's own "staff can fall back to coach's pick"
  // empty state), and alone for the coachs_pick week itself (candidates is
  // always [] there by definition, so there is nothing to show beside it).
  // previous_week_user_id is now BOTH named and disabled. It used to be only
  // named, and the reason given was that the input was a free-text handle
  // "rather than a picker with real options to grey out one of" - so the
  // greying out COMM-315's schema comments ask for was expressed as a
  // visible warning instead. There is a picker now, so the ineligible member
  // is greyed out where they appear AND the warning stays: the note explains
  // why the row is unpressable, which a disabled row on its own does not.
  //
  // ---- THE PICKER -----------------------------------------------------------
  //
  // WAS: `<input dir="ltr" placeholder="שם משתמש">`. To recognise a member a
  // coach had to already know their @handle and spell it exactly - a
  // Latin-script username, typed into an RTL Hebrew form, for a person the
  // coach knows by their Hebrew first name. A miss produced
  // "לא נמצא/ה חבר/ה עם שם המשתמש הזה" with no way to find out what the
  // handle actually was without leaving the tab for the roster.
  //
  // The old comment on memberOfWeekPublishPick() said there was "no
  // staff-readable directory RPC to build a real member picker from". That
  // was never quite true and is plainly not true now: the Directory tab's
  // own roster (loadDirectory - a plain profiles select any signed-in member
  // may run, filtered to visible_to_club) and community_search are both
  // existing reads, used here unchanged. NO NEW MIGRATION, no new RPC, no
  // widened policy - the picker sees exactly what the member browsing the
  // roster already sees, which is also exactly the set
  // member_of_week_publish() will accept ("member is not visible to the
  // club" is one of its five refusals).
  //
  // TWO SOURCES, one list, in this order:
  //   1. Typed nothing, or fewer than SEARCH_MIN_CHARS - the roster page
  //      already in memory, so the field opens with real names in it rather
  //      than as an empty box that demands a guess.
  //   2. Typed enough - the same community_search RPC the roster's own box
  //      debounces, because the roster is PAGINATED (DIRECTORY_PAGE_SIZE) and
  //      a club with more members than one page would otherwise have members
  //      the picker could not reach. Until that answers, the local filter
  //      still renders, so typing is never a blank pause.
  const MOW_PICK_SUGGESTION_LIMIT = 6;
  function memberOfWeekPickSuggestions() {
    const s = state.coach.memberOfWeek;
    const q = sanitizeSearchQuery(s.pickQuery).toLowerCase();
    // The server's answer wins once it exists for a real query; below the
    // threshold no request was made and none is coming, so the roster is the
    // only honest source.
    const rows = (q.length >= SEARCH_MIN_CHARS && Array.isArray(s.pickResults))
      ? s.pickResults
      : (state.members.directory.items || []).filter((m) => !q
          || (m.display_name || "").toLowerCase().indexOf(q) >= 0
          || (m.handle || "").toLowerCase().indexOf(q) >= 0);
    // The same render-time block filter every other member list in this file
    // carries (see blockFilteredList()). A coach who has blocked someone
    // should not be offered them as the club's member of the week.
    return rows.filter((m) => m && m.id && !isBlockedUser(m.id)).slice(0, MOW_PICK_SUGGESTION_LIMIT);
  }
  function memberOfWeekPickSuggestionRow(m, prevId, anyBusy) {
    const ineligible = !!prevId && m.id === prevId;
    const meta = `@${esc(m.handle || "")}${ineligible ? " · נבחר/ה בשבוע שעבר" : ""}`;
    // A `.log-row` that happens to be a button, the same shape the staff
    // rail's own tappable rows and the Manage attention strip already use -
    // so a suggestion looks and measures like every other member row in the
    // app rather than like a bespoke dropdown. No background/border
    // overrides: `.log-row` beats the bare `button` reset on specificity, and
    // `button:disabled{opacity:.45}` already greys the ineligible row, so the
    // only thing this style adds is the full width and the start alignment a
    // button does not take by default.
    return `<button type="button" class="log-row" data-community-action="coach-mow-pick-select" data-id="${esc(m.id)}" data-mow-pick-option="1"${(ineligible || anyBusy) ? " disabled" : ""} style="width:100%;text-align:start;">
      <div class="flex gap-10" style="align-items:center;min-width:0;">
        ${avatarHtml(m.display_name || m.handle, 32, m.avatar_url)}
        <div style="min-width:0;">
          <div style="font-weight:700;">${nameHtml(m.display_name, m.handle)}</div>
          <div style="color:var(--steel);font-size:12px;"><bdi>${meta}</bdi></div>
        </div>
      </div>
    </button>`;
  }
  function memberOfWeekPickSuggestionsHtml(prevId, anyBusy) {
    const s = state.coach.memberOfWeek;
    const d = state.members.directory;
    const q = sanitizeSearchQuery(s.pickQuery);
    const rows = memberOfWeekPickSuggestions();
    // The roster load is kicked off by afterRenderCommunity() the first time
    // this tab renders, the same lazy shape every other sub-tab load uses.
    // Until it answers there is nothing to filter, and saying "no matches"
    // about a list that has not loaded is the same class of false statement
    // renderCoachAppActivitySection() refuses to make about activity data.
    if (!rows.length && !d.loaded && !Array.isArray(s.pickResults)) {
      return `<div class="footer-note" role="status" style="margin-top:6px;" data-mow-pick-suggestions="loading">${d.error ? "לא ניתן היה לטעון את רשימת החברים." : "טוען את רשימת החברים…"}</div>`;
    }
    if (!rows.length) {
      return `<div class="footer-note" role="status" style="margin-top:6px;" data-mow-pick-suggestions="none">${s.pickSearching ? "מחפש…" : q ? "לא נמצאו חברים תואמים." : "רשימת החברים ריקה."}</div>`;
    }
    return `<div class="log-list" data-mow-pick-suggestions="list" style="margin-top:6px;">${rows.map((m) => memberOfWeekPickSuggestionRow(m, prevId, anyBusy)).join("")}</div>`;
  }
  // `primary` decides whether this form's publish button carries the orange
  // fill, and it is the caller's call rather than this function's because the
  // answer is about the SCREEN, not the form: one main action per screen. The
  // form is the only publish control on the empty/free-selection branches, so
  // there it IS the main action; alongside a computed shortlist, each of whose
  // rows already carries an orange one-tap "פרסום", it is the second way to do
  // the same thing and takes .secondary.
  function renderMemberOfWeekPickForm(env, primary) {
    const s = state.coach.memberOfWeek;
    const busy = s.busy === "pick";
    const anyBusy = !!s.busy;
    const prevId = env.previous_week_user_id;
    const prevProfile = s.previousProfile;
    const prevName = prevProfile ? (prevProfile.display_name || "@" + prevProfile.handle) : "חבר/ה";
    const prevNote = prevId ? `<div class="footer-note" style="margin-top:4px;">לא ניתן לבחור שוב ב${esc(prevName)} — נבחר/ה כבר בשבוע שעבר.</div>` : "";
    const chosen = s.pickUserId ? (s.pickChosen || {}) : null;
    const member = chosen
      ? `<div class="log-row" data-mow-pick-chosen="${esc(s.pickUserId)}" style="align-items:center;">
          <div class="flex gap-10" style="align-items:center;min-width:0;">
            ${avatarHtml(chosen.display_name || chosen.handle, 32, chosen.avatar_url)}
            <div style="min-width:0;">
              <div style="font-weight:700;">${nameHtml(chosen.display_name, chosen.handle)}</div>
              <div style="color:var(--steel);font-size:12px;"><bdi>@${esc(chosen.handle || "")}</bdi></div>
            </div>
          </div>
          <button class="chip-btn" data-community-action="coach-mow-pick-clear"${anyBusy ? " disabled" : ""}>שינוי</button>
        </div>`
      : `<input class="text-input" data-mow-pick-search placeholder="חיפוש לפי שם או שם משתמש" aria-label="חיפוש חבר/ה לבחירת המאמן/ת" value="${esc(s.pickQuery)}"${anyBusy ? " disabled" : ""}/>${memberOfWeekPickSuggestionsHtml(prevId, anyBusy)}`;
    return `<div class="chart-card" style="margin-top:8px;">
      <h3 class="field-label" style="margin-bottom:6px;">בחירת מאמן/ת</h3>
      <div class="field"><span class="field-label">חבר/ה</span>${member}</div>
      <label class="field"><span class="field-label">סיבה (חובה)</span><textarea class="text-input" rows="3" maxlength="500" data-mow-pick-reason placeholder="למה החבר/ה הזה/הזאת נבחר/ה השבוע"${anyBusy ? " disabled" : ""}>${esc(s.pickReason)}</textarea></label>
      <div data-mow-pick-counter style="text-align:left;font-size:11px;color:var(--steel);min-height:14px;">${s.pickReason.length}/500</div>
      ${s.publishErr ? `<div class="field-error" role="alert">${esc(s.publishErr)}</div>` : ""}
      ${prevNote}
      <button class="chip-btn ${primary ? "primary" : "secondary"}" data-community-action="coach-mow-publish-pick"${anyBusy ? " disabled" : ""}>${busy ? "מפרסם/ת…" : "פרסום בחירת המאמן/ת"}</button>
    </div>`;
  }
  // Once published is non-null the publish action is spent for the week -
  // this replaces the suggestion UI entirely rather than sitting beside it
  // (COMM-315's own "shows what/who was published instead" instruction).
  function renderMemberOfWeekPublished(env) {
    const pub = env.published;
    const p = state.coach.memberOfWeek.publishedProfile;
    const name = p ? (p.display_name || "@" + p.handle) : "חבר/ה";
    return `<div class="chart-card" style="margin-top:8px;">
      <div class="flex gap-10" style="align-items:center;">
        ${avatarHtml(p && (p.display_name || p.handle), 36, p && p.avatar_url)}
        <div>
          <button class="link-btn" data-community-action="view-profile" data-id="${esc(pub.user_id)}" style="padding:0;font-weight:800;color:inherit;">${esc(name)}</button>
          <div style="color:var(--steel);font-size:12px;">${esc(env.category_label)}</div>
        </div>
      </div>
      ${pub.reason ? `<div style="margin-top:8px;white-space:pre-wrap;">${esc(pub.reason)}</div>` : ""}
      <div style="color:var(--steel);font-size:11px;margin-top:6px;">פורסם ${relativeTime(pub.published_at)}</div>
    </div>`;
  }
  function renderCoachMemberOfWeekSection() {
    // Redesign, Phase 2. Same clientOnly UI-section guard as
    // renderCoachWelcomeSection just above.
    if (!isModuleEnabled("member_of_week")) return "";
    const s = state.coach.memberOfWeek;
    const head = sectionHead("var(--brass)", s.envelope ? `חבר/ת השבוע · ${esc(s.envelope.category_label)}` : "חבר/ת השבוע");
    if (s.loading && !s.loaded) {
      return `<div class="ach-section" style="margin-top:18px;">${head}<div aria-busy="true"><div class="chart-card" style="height:64px;background:var(--border);opacity:.35;"></div></div></div>`;
    }
    if (s.error || !s.envelope) {
      return `<div class="ach-section" style="margin-top:18px;">${head}<div class="empty">לא ניתן היה לטעון את המועמדים.<div class="chip-row" style="justify-content:center;"><button class="chip-btn" data-community-action="coach-mow-retry">ניסיון חוזר</button></div></div></div>`;
    }
    const env = s.envelope;
    let body;
    if (env.published) {
      body = renderMemberOfWeekPublished(env);
    } else if (env.free_selection) {
      // free_selection: the coachs_pick week itself. The form is the only
      // publish control on screen, so it carries the screen's one orange.
      body = renderMemberOfWeekPickForm(env, true);
    } else if (env.candidates && env.candidates.length) {
      // Same complication the invite flow had: a form that's always fully
      // open competes for attention with the actual suggestions above it.
      // Collapsed by <details> here, not removed - the coach's-pick form
      // stays exactly as reachable (same ids/data-actions, same DOM), just
      // tucked behind a summary when there's already something to publish
      // with one tap. The empty/free_selection/coachs_pick branches below
      // leave it open, since there it's the only action on screen.
      body = `<div class="log-list">${env.candidates.map((c) => renderMemberOfWeekCandidate(c, env.category)).join("")}</div><details style="margin-top:8px;"><summary class="link-btn" style="cursor:pointer;">בחירה ידנית של חבר/ת השבוע</summary>${renderMemberOfWeekPickForm(env, false)}</details>`;
    } else {
      // NO BUTTON - because the action already exists, one element further
      // down. renderMemberOfWeekPickForm() renders directly underneath this
      // state and lets a coach pick ANY member, so a button here would be a
      // second door onto a form already on screen. The line points at it
      // instead, which is what the spec's own "must actually fill the state"
      // rule asks for once the thing that fills it is already rendered.
      body = emptyLineHtml({
        key: "coach-member-of-week",
        text: "בקטגוריה הזו אפשר לבחור כל חבר/ה ידנית, בטופס שמתחת.",
      }) + renderMemberOfWeekPickForm(env, true);
    }
    return `<div class="ach-section" style="margin-top:18px;">${head}${body}</div>`;
  }
  // ---- Monthly club recap (COMM-309) ----------------------------------------
  // The five aggregate figures, shared verbatim between the staff preview
  // (draft or published) and the member-facing card (published only) - same
  // shape, same labels, same order the migration lists them in. No member
  // name, handle or per-member figure anywhere in this row by table design
  // (monthly_club_recaps has no user_id column at all), so nothing here has
  // to filter anything out - rendering exactly what came back is already
  // aggregate-only.
  function renderMonthlyRecapFigures(r) {
    return `<div class="log-list">
      <div class="log-row"><span>אימונים שנרשמו</span><span class="mono" style="color:var(--brass);">${esc(r.sessions_logged)}</span></div>
      <div class="log-row"><span>פוסטים</span><span class="mono" style="color:var(--brass);">${esc(r.posts_created)}</span></div>
      <div class="log-row"><span>חברים חדשים</span><span class="mono" style="color:var(--brass);">${esc(r.new_members)}</span></div>
      <div class="log-row"><span>אתגרים שהושלמו</span><span class="mono" style="color:var(--brass);">${esc(r.challenges_completed)}</span></div>
      <div class="log-row"><span>אירועים שהתקיימו</span><span class="mono" style="color:var(--brass);">${esc(r.events_held)}</span></div>
    </div>`;
  }
  // The Coach Dashboard's sixth section: the staff preview + publish
  // control. Frontend states, in order, exactly as COMM-309 names them:
  // loading (skeleton, same shape renderCoachMemberOfWeekSection's own
  // skeleton uses), error ("לא ניתן היה לטעון את התקציר לתצוגה מקדימה." -
  // COMM-309's own copy, verbatim), no-row-yet (an honest empty state - see
  // loadCoachMonthlyRecap's own comment on why null is a real, expected
  // state here and not a load failure, since there is no scheduler yet),
  // populated-draft (figures + a gated "פרסם" control) and
  // populated-published (figures, read-only, no control at all - COMM-309's
  // own "a published recap cannot be un-published or edited").
  //
  // THE PERMISSION GATE. canPublish combines hasPerm(PERM.ANALYTICS_VIEW)
  // and isAdmin() with the same OR the moderation queue already uses for
  // its own two-permission gates (hasPerm(PERM.COMMENT_MODERATE) ||
  // isAdmin(), see loadModQueue/renderModQueue) - not a new mechanism, just
  // this ticket's own pair. It is the exact pair
  // recap_monthly_publish() itself requires server-side
  // (`has_perm('community.analytics.view') or is_admin()`). Deliberately
  // NOT isStaff(): the migration's own long comment on
  // monthly_club_recaps_staff_select spells out that a coach may PREVIEW a
  // draft (is_staff() is enough for the read policy) but may NOT publish
  // one (the function's check is narrower) - gating the button on
  // isStaff() would show a coach a control the database refuses.
  // THE MONTHLY CLUB RECAP IS THE HEAD COACH'S, confirmed by the owner
  // 2026-09-15: "Monthly recap is head coach."
  //
  // Recorded here because the arrangement looks like a bug from two different
  // angles and is neither. This section lives on the coach board, which is
  // coach-tier only - a redeemed coach/head_coach role, never the is_admin
  // flag - while recap_monthly_publish() still gates on
  // `has_perm('community.analytics.view') or is_admin()`. So:
  //
  //   head_coach  holds both halves (coach tier for the board, analytics for
  //               the gate) and is the intended publisher.
  //   coach       sees the draft and gets no publish control - correct, and
  //               asserted in community-monthly-recap-publish.mjs.
  //   admin       may publish as far as the SERVER is concerned and has
  //               nowhere to press it.
  //
  // That last line is the one that reads like a defect. It is not: the
  // monthly club recap is club content, the club is the head coach's job, and
  // the owner has confirmed that division. The server gate is deliberately
  // left as it is rather than narrowed to match - roles are additive on one
  // account, so an admin who also coaches keeps the capability, and tightening
  // it would remove the only route back if the head coach account were ever
  // lost. Do not "fix" the asymmetry by moving this section to the admin
  // panel; it was put here on purpose.
  function renderCoachMonthlyRecapSection() {
    // Redesign, Phase 2. Same clientOnly UI-section guard as the two coach
    // sections above.
    if (!isModuleEnabled("monthly_recap")) return "";
    const s = state.coach.monthlyRecap;
    const head = sectionHead("var(--purple)", "סיכום חודשי למועדון");
    if (s.loading && !s.loaded) {
      return `<div class="ach-section" style="margin-top:18px;">${head}<div aria-busy="true"><div class="chart-card" style="height:120px;background:var(--border);opacity:.35;"></div></div></div>`;
    }
    if (s.error) {
      return `<div class="ach-section" style="margin-top:18px;">${head}<div class="empty">לא ניתן היה לטעון את התקציר לתצוגה מקדימה.<div class="chip-row" style="justify-content:center;"><button class="chip-btn" data-community-action="coach-monthly-recap-retry">ניסיון חוזר</button></div></div></div>`;
    }
    if (!s.row) {
      // A clean "nothing yet" is a real state, not an error. This used to
      // read "no scheduler is built, so a draft only exists once someone
      // has run recap_monthly_generate() by hand" - true when COMM-309
      // shipped, no longer true since 202609050005 scheduled the
      // 'recap_monthly' job for 04:41 on the 1st. The empty state stands on
      // its own without that reason: the very first month of a new club has
      // no completed prior month to summarise, so the newest-row query
      // honestly answers nothing until the job's first run.
      // NO ACTION, and here that is forced rather than chosen: nothing a
      // coach can press generates this row. recap_monthly_generate() is a
      // scheduled job, so the only honest thing to say is the schedule
      // itself. The date is stated because "בקרוב" would leave a coach
      // checking back daily. Deliberately does not name who may press
      // "פרסום": that button is gated on analytics-view-or-admin, narrower
      // than the coaches who can reach this preview (see this function's own
      // header), so a promise here would be false for exactly the coach
      // reading it.
      return `<div class="ach-section" style="margin-top:18px;">${head}${emptyLineHtml({
        key: "coach-monthly-recap",
        text: "התקציר נבנה לבד ב-1 בכל חודש, עבור החודש שהסתיים, ויופיע כאן קודם כטיוטה.",
      })}</div>`;
    }
    const r = s.row;
    const canPublish = hasPerm(PERM.ANALYTICS_VIEW) || isAdmin();
    const busy = s.busy === r.id;
    let control;
    if (r.published_at) {
      control = `<div style="color:var(--steel);font-size:11px;margin-top:8px;">פורסם ${relativeTime(r.published_at)}</div>`;
    } else if (canPublish) {
      control = `<div class="chip-row" style="margin-top:8px;"><button class="chip-btn primary" data-community-action="coach-monthly-recap-publish" data-id="${esc(r.id)}"${s.busy ? " disabled" : ""}>${busy ? "מפרסם/ת…" : "פרסום"}</button></div>${s.publishErr ? `<div class="field-error" role="alert">${esc(s.publishErr)}</div>` : ""}`;
    } else {
      // A coach previewing a draft, per the asymmetry above - named rather
      // than simply omitted, so a coach understands why there is no button
      // rather than wondering if the draft is broken.
      control = `<div class="footer-note" style="margin-top:8px;">רק בעל/ת הרשאת אנליטיקה או מנהל/ת יכול/ה לפרסם.</div>`;
    }
    return `<div class="ach-section" style="margin-top:18px;">${head}<div class="chart-card"><h3 class="field-label" style="margin-bottom:6px;">${esc(r.month_start)}${r.published_at ? "" : " · טיוטה"}</h3>${renderMonthlyRecapFigures(r)}${control}</div></div>`;
  }
  // The member-facing surface: an inline Account-tab card, sibling to the
  // COMM-221 "View Week" entry (recapEntry in the tab builder below), not a
  // new nav destination and not a dialog - there is one club-wide row to
  // show, not a per-member history to browse. Renders nothing at all - not
  // a skeleton, not an empty-state card - until state.recaps.monthly.row is
  // actually populated: COMM-309's own "Empty (member view)" frontend state
  // is explicit that the surface simply does not show a monthly recap entry
  // before a month is published, and loadMonthlyRecap's own query already
  // guarantees row is only ever a published row.
  function renderMonthlyRecapMemberSection() {
    const r = state.recaps.monthly.row;
    if (!r) return "";
    // data-monthly-recap-section: the scrollIntoView anchor a
    // `target.recapMonth` notification tap (navigateToNotifTarget) uses.
    // There is only ever one row to show (the newest published month), so
    // unlike the weekly recap's per-week dialog this never needs to
    // distinguish which month by id - landing on this one section IS
    // landing on the exact item the notification pointed at.
    return `<div class="ach-section" data-monthly-recap-section style="margin-top:18px;">${sectionHead("var(--purple)", "סיכום החודש של הקהילה")}<div class="chart-card"><h3 class="field-label" style="margin-bottom:6px;">${esc(r.month_start)}</h3>${renderMonthlyRecapFigures(r)}</div></div>`;
  }

  // COMM-226 built this absent entirely (not merely styled hidden) unless
  // the flag is on; COMM-304 flips that flag default-on and gives it real
  // rows, but the same absent-when-off gate stays exactly as it was, for
  // whichever future ticket needs to turn it back off again.
  function renderCoachEngageRow(it) {
    const busy = !!(state.coach.engage.busy && state.coach.engage.busy.id === it.id);
    const reachBusy = busy && state.coach.engage.busy.action === "reach-out";
    const reached = !!state.coach.engage.reachedOut[it.id];
    const name = engageMemberName(it.user_id);
    const prof = state.coach.engage.profiles[it.user_id];
    return `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:8px;">
      <div class="flex gap-10" style="align-items:center;">
        ${avatarHtml(prof && (prof.display_name || prof.handle), 32, prof && prof.avatar_url)}
        <div>
          <button class="link-btn" data-community-action="view-profile" data-id="${esc(it.user_id)}" style="padding:0;font-weight:800;color:inherit;">${esc(name)}</button>
          <div style="margin-top:2px;"><span class="admin-tag" style="background:${engageLevelColor(it.level)};">${esc(engageLevelLabel(it.level))}</span></div>
        </div>
      </div>
      <div class="chip-row">
        <button class="chip-btn${reached ? "" : " primary"}" data-community-action="coach-engage-reach-out" data-id="${esc(it.id)}"${reached || busy ? " disabled" : ""}>${reachBusy ? "שולח…" : reached ? "פנייה נשלחה" : "פנייה"}</button>
        <button class="chip-btn" data-community-action="coach-engage-review" data-id="${esc(it.id)}"${busy ? " disabled" : ""}>סימון כנבדק</button>
        <button class="chip-btn" data-community-action="coach-engage-dismiss" data-id="${esc(it.id)}"${busy ? " disabled" : ""}>דחייה</button>
      </div>
    </div>`;
  }
  function renderCoachEngageSection() {
    if (!state.featureFlags.coachEngage) return "";
    const e = state.coach.engage;
    const body = (e.loading && !e.loaded)
      ? `<div aria-busy="true"><div class="log-row" style="height:40px;background:var(--border);opacity:.35;"></div></div>`
      : e.error
      ? `<div class="empty">לא ניתן היה לטעון את הנתונים.<div class="chip-row" style="justify-content:center;"><button class="chip-btn" data-community-action="coach-engage-retry">ניסיון חוזר</button></div></div>`
      : e.items.length
      ? `<div class="log-list">${e.items.map(renderCoachEngageRow).join("")}</div>`
      : emptyLineHtml({
        // The GOOD outcome, written like one - the same instinct
        // renderIncompleteSignups() already committed to ("an admin who
        // finds nothing here has learned something, and the screen should
        // say what"). An empty engagement list is not a gap in the data, it
        // is the club being fine. The four-slot card was introduced here
        // because a BARE one-liner under a red section dot read like a panel
        // that had failed; the line below is not bare - it states the
        // all-clear itself, which is what was actually missing.
        //
        // NO ACTION: there is nobody to reach out to. The reach-out, review
        // and dismiss buttons live on the rows, and a row is what this state
        // is the absence of.
        key: "coach-engage",
        text: "כל החברים בקצב טוב כרגע — מי שקצב האימונים שלו יירד יופיע כאן.",
      });
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--red)", "מעקב מעורבות")}${body}</div>`;
  }
  // ---- "nothing needs attention", said ONCE ---------------------------------
  //
  // The other half of the empty-state fix (see emptyLineHtml() in cloud.js).
  // Shortening six cards to six lines stops the tab being two screens of
  // illustrated apologies, but it still makes a coach read six lines and do
  // the AND themselves to learn the one thing they opened the tab for. This
  // says it at the top, once, and only when it is true.
  //
  // WHAT "QUIET" MEANS, per section, and why each test is shaped the way it
  // is. A section counts as quiet when it is OFF (nothing to be quiet about),
  // or LOADED, not errored, and holding no row that wants a coach. It counts
  // as NOISY the moment it holds one. Crucially it counts as NEITHER while it
  // is still loading or has failed: an unanswered read is not an all-clear,
  // and this summary must never be the thing that tells a coach the club is
  // fine because a query timed out. Anything not-yet-known suppresses the
  // summary entirely, which is the honest default - the sections below still
  // say their own piece either way.
  //
  // Deliberately NOT a count of empty sections in the rendered HTML. That
  // would be the same string-scraping shortcut that makes a summary drift
  // away from the thing it summarises the first time a section changes shape.
  function coachBoardQuiet() {
    const known = [];
    // A section reports [quiet?] or nothing at all when its answer is not in
    // yet. `push(false)` is a real "something is here"; pushing nothing is
    // "we do not know", and one of those is enough to withhold the summary.
    function report(off, loaded, error, hasRows) {
      if (off) return known.push(true);
      if (!loaded || error) return; // unknown - not an all-clear
      known.push(!hasRows);
    }
    const t = state.coach.tasks, c = state.coach.celebrate, w = state.coach.welcome, e = state.coach.engage, m = state.coach.memberOfWeek, r = state.coach.monthlyRecap;
    report(!isModuleEnabled("coach_tasks"), t.loaded, t.error, (t.items || []).some((x) => x && !isBlockedUser(x.user_id)));
    report(false, c.loaded, c.error, (c.items || []).length > 0);
    report(!isModuleEnabled("welcome_flow"), w.loaded, w.error, (w.members || []).length > 0);
    report(!state.featureFlags.coachEngage, e.loaded, e.error, (e.items || []).length > 0);
    // Member of the week is quiet when the week is settled (already
    // published) or when there is nobody computed to publish. An unpublished
    // week WITH candidates is a one-tap action waiting, so it is noisy.
    report(!isModuleEnabled("member_of_week"), m.loaded, m.error || !m.envelope, !!(m.envelope && !m.envelope.published && m.envelope.candidates && m.envelope.candidates.length));
    // The monthly recap is quiet unless there is an unpublished draft sitting
    // in it. No row at all is quiet; a published month is quiet.
    report(!isModuleEnabled("monthly_recap"), r.loaded, r.error, !!(r.row && !r.row.published_at));
    // Challenges is read straight off the list the section itself renders,
    // rather than given a state branch of its own: the module being off makes
    // challenges_read return nothing, so an empty list already covers it.
    const ch = state.challenges;
    if (!isModuleEnabled("challenges")) known.push(true);
    else if (ch.loaded && !ch.error) known.push(!(ch.items || []).some((x) => x && x.status === "active" && !isOnboardingContainer(x)));
    // Every section answered, and every answer was "quiet".
    return known.length === 7 && known.every(Boolean);
  }
  function renderCoachBoardSummary() {
    if (!coachBoardQuiet()) return "";
    return `<div class="ach-section" data-coach-board-summary="1" style="margin-top:0;">${sectionHead("var(--green)", "אין מה לטפל בו כרגע")}
      <div class="chart-card" style="color:var(--steel);font-size:13px;line-height:1.7;">${bidiText("אין משימות פתוחות, הישגים לברך עליהם או חברים שהקצב שלהם ירד. הרשימות למטה מתמלאות לבד מהנתונים של המועדון.")}</div></div>`;
  }
  function renderCoachTab() {
    // The summary first and the tasks straight after it, deliberately.
    // Everything else on this tab is something a coach may want to look at;
    // tasks is the only part that is a list of things somebody has to do
    // today, and burying a work queue under three browsable sections is how
    // it stops being one. The summary renders only when that queue and every
    // other section is empty, so it never pushes real work down the screen.
    //
    // `true` to renderChallengesListSection: the coach-board rendering, whose
    // empty state is a line rather than the four-slot card the same section
    // shows a member on Boards. See its own comment.
    return renderCoachBoardSummary() + renderCoachTasksSection() + renderCoachCelebrateSection() + renderCoachMemberOfWeekSection() + renderCoachWelcomeSection() + renderChallengesListSection(true) + renderCoachEngageSection() + renderCoachMonthlyRecapSection();
  }

  // ---- Coach tasks (202609220002) ------------------------------------------
  // The five rules become one list. Everything here reads
  // coach_tasks_refresh(), which syncs and returns in one call, and every
  // action is either the member_contact_log insert this codebase already had
  // or the one UPDATE coach_tasks' own policy allows.
  //
  // THE MODULE GATE IS REAL HERE, unlike most sections on this tab. The RPC
  // returns nothing and the table's RLS returns nothing while coach_tasks is
  // off, so this `return ""` hides an empty shell rather than being the only
  // thing standing between a coach and the data.
  const COACH_TASK_RULES = {
    welcome:              { label: "קבלת פנים", accent: "var(--green)" },
    first_class_followup: { label: "אחרי האימון הראשון", accent: "var(--teal)" },
    low_attendance:       { label: "כמעט לא הגיע/ה", accent: "var(--brass)" },
    day_60_checkin:       { label: "שיחת יום 60", accent: "var(--teal)" },
    no_contact_30:        { label: "בלי קשר חודש", accent: "var(--red)" },
  };
  function coachTaskRule(key) { return COACH_TASK_RULES[key] || { label: key || "", accent: "var(--steel)" }; }
  async function loadCoachTasks() {
    if (!state.user || !isStaff() || !isModuleEnabled("coach_tasks")) return;
    state.coach.tasks.loading = true;
    rerender();
    const { data, error } = await client.rpc("coach_tasks_refresh", { p_include_closed: false, p_limit: 100 });
    state.coach.tasks.loading = false;
    state.coach.tasks.loaded = true;
    // A FAILED READ IS NOT AN EMPTY LIST - the same rule
    // renderStaffWeekStrip() states for the week. On failure the previous
    // answer is left alone and the section says so, because "no tasks today"
    // is exactly the wrong thing to tell a coach whose list did not load.
    state.coach.tasks.error = !!error;
    if (!error) state.coach.tasks.items = data || [];
    rerender();
  }
  // Closing a task by making contact, which is the ordinary path: one
  // member_contact_log row, written through the SAME insert
  // coachMarkContacted() already used, and the trigger closes every open task
  // for that member. Nothing here writes coach_tasks.
  async function coachTaskContact(taskId) {
    const task = (state.coach.tasks.items || []).find((t) => t.id === taskId);
    if (!task || state.coach.tasks.busy) return;
    state.coach.tasks.busy = taskId;
    rerender();
    const note = String((state.coach.tasks.contactDrafts || {})[task.user_id] || "").trim().slice(0, 500);
    const { error } = await client.from("member_contact_log").insert({ user_id: task.user_id, note });
    state.coach.tasks.busy = null;
    if (error) { setMessage(failText("לא ניתן היה לבצע את הפעולה. נסו שוב.", error)); return rerender(); }
    delete state.coach.tasks.contactDrafts[task.user_id];
    // The rule and whether it was late, never the member: a coach task is a
    // named person the club thinks needs a call.
    track(A.COACH_TASK_CLOSED, { action: "contacted", rule: task.rule_key || null, overdue: !!task.overdue });
    setMessage("סומן כנוצר קשר");
    // Re-read rather than splice: one contact closes every open task for that
    // member, and guessing which ones from here would be a second copy of the
    // close rule that lives in the database.
    loadCoachTasks();
  }
  // Closing a task WITHOUT a contact - "this one does not apply". The
  // direct UPDATE coach_tasks_staff_close permits; the guard trigger stamps
  // closed_by and refuses anything that is not open -> closed.
  async function coachTaskDismiss(taskId) {
    if (!taskId || state.coach.tasks.busy) return;
    const task = (state.coach.tasks.items || []).find((t) => t.id === taskId);
    state.coach.tasks.busy = taskId;
    rerender();
    const { error } = await client.from("coach_tasks").update({ closed_at: new Date().toISOString() }).eq("id", taskId);
    state.coach.tasks.busy = null;
    if (error) { setMessage(failText("לא ניתן היה לבצע את הפעולה. נסו שוב.", error)); return rerender(); }
    track(A.COACH_TASK_CLOSED, { action: "dismissed", rule: (task && task.rule_key) || null, overdue: !!(task && task.overdue) });
    state.coach.tasks.items = state.coach.tasks.items.filter((t) => t.id !== taskId);
    setMessage("המשימה נסגרה");
    rerender();
  }
  function renderCoachTaskRow(t) {
    const rule = coachTaskRule(t.rule_key);
    const busy = state.coach.tasks.busy === t.id;
    const anyBusy = !!state.coach.tasks.busy;
    const days = Number(t.days_since_join);
    // Singular branches on both, because "לפני 1 ימים" is the defect this
    // file has now been through three times (renderCoachWelcomeRow,
    // renderCoachNewMembersSection, memberOfWeekCandidateDetailText).
    const joined = !Number.isFinite(days) ? "" : days === 0 ? "הצטרף/ה היום" : days === 1 ? "הצטרף/ה אתמול" : `במועדון ${days} ימים`;
    const sessions = Number(t.sessions_logged) || 0;
    // Says what the number IS. A count of workouts logged in the app is not a
    // count of classes attended, and a coach must not read it as one - the
    // same sentence renderCoachNewMembersSection() carries for the same
    // number.
    const trained = sessions === 1 ? "אימון אחד באפליקציה" : sessions ? `${sessions} אימונים באפליקציה` : "לא רשמו אימון באפליקציה";
    const owner = t.assigned_coach_name ? `אחריות: ${t.assigned_coach_name}` : "בלי מאמן/ת אחראי/ת";
    const draft = String((state.coach.tasks.contactDrafts || {})[t.user_id] || "");
    return `<div class="log-row" data-coach-task="${esc(t.id)}" style="align-items:flex-start;flex-direction:column;gap:6px;">
      <div class="flex gap-6" style="align-items:center;flex-wrap:wrap;">
        <span class="tag" style="border-color:${rule.accent};color:${rule.accent};">${esc(rule.label)}</span>
        ${t.overdue ? `<span class="tag tag-brass">באיחור</span>` : ""}
        <button class="link-btn" data-community-action="view-profile" data-id="${esc(t.user_id)}" style="padding:0;font-weight:800;color:inherit;">${nameHtml(t.display_name, t.handle)}</button>
      </div>
      <span style="color:var(--steel);font-size:12px;">${bidiText([joined, trained, owner].filter(Boolean).join(" · "))}</span>
      <span style="color:var(--steel);font-size:12px;">${bidiText(`יעד: ${t.due_on || ""}`)}</span>
      <input class="text-input" placeholder="הערה קצרה לגבי הקשר (אופציונלי)" data-coach-task-note="${esc(t.user_id)}" value="${esc(draft)}"/>
      <div class="chip-row">
        <button class="chip-btn primary" data-community-action="coach-task-contact" data-id="${esc(t.id)}"${anyBusy ? " disabled" : ""}>${busy ? "שומר…" : "סימון כנוצר קשר"}</button>
        <button class="chip-btn" data-community-action="coach-task-dismiss" data-id="${esc(t.id)}"${anyBusy ? " disabled" : ""}>לא רלוונטי</button>
      </div>
    </div>`;
  }
  function renderCoachTasksSection() {
    if (!isModuleEnabled("coach_tasks")) return "";
    const s = state.coach.tasks;
    const rows = (s.items || []).filter((t) => !t || !isBlockedUser(t.user_id));
    const body = (s.loading && !s.loaded)
      ? `<div aria-busy="true">${`<div class="chart-card" style="height:56px;background:var(--border);opacity:.35;margin-bottom:10px;"></div>`.repeat(2)}</div>`
      : s.error
      ? `<div class="empty" role="alert">לא ניתן היה לטעון את המשימות.<div class="chip-row" style="justify-content:center;margin-top:6px;"><button class="chip-btn" data-community-action="coach-tasks-retry">ניסיון חוזר</button></div></div>`
      : rows.length
      ? `<div class="log-list">${rows.map(renderCoachTaskRow).join("")}</div>`
      : emptyLineHtml({
        key: "coach-tasks",
        text: "משימה תיפתח כאן לבד כשמישהו יצטרף, יגיע לאימון ראשון או ייעלם לחודש.",
      });
    const overdue = rows.filter((t) => t.overdue).length;
    const count = rows.length
      ? `<span style="color:var(--steel);font-size:12px;">${esc(overdue ? `${rows.length} משימות, ${overdue} באיחור` : `${rows.length} משימות`)}</span>`
      : "";
    return `<div class="ach-section" style="margin-top:18px;" data-coach-tasks-section="1">${sectionHead(overdue ? "var(--red)" : "var(--teal)", "משימות להיום", true)}
      <div class="flex" style="justify-content:space-between;align-items:baseline;margin:-2px 0 8px;">
        <span style="color:var(--steel);font-size:12px;line-height:1.6;">${bidiText("נסגרת לבד ברגע שנרשם קשר עם החבר/ה.")}</span>${count}
      </div>${body}</div>`;
  }

  // The permanent sub-note under the section head. Not conditional on
  // anything: a coach reading a list of names needs to know what the list
  // measures every single time they read it, not only when it is empty.
  // Arbox is named explicitly because a coach's default assumption for any
  // list like this is class attendance, and this product cannot see it -
  // scheduling and rosters are deliberately out of scope.
  function coachAppSignalNote() {
    return `<div style="color:var(--steel);font-size:12px;line-height:1.6;margin:-2px 0 10px;">${bidiText("מבוסס על כניסות לאפליקציה בלבד, לא על נוכחות בשיעורים. נוכחות בשיעורים מנוהלת ב-Arbox.")}</div>`;
  }

  function renderCoachNewMembersSection() {
    // "חברים חדשים" - the exact phrase COMM-107's welcome post and the
    // coach-tools Welcome section already use for the same concept.
    // Same render-time block filter as every other member list - see
    // blockFilteredList(). A coach who has blocked someone should not be
    // handed them as a task.
    const rows = (state.club.newMembers || []).filter((m) => !m || !isBlockedUser(m.id || m.user_id));
    const body = rows.length
      ? `<div class="log-list">${rows.map((m) => {
          const days = Number(m.days_since_join);
          // Live bug hunt (2026-09-11): missing singular branches, same as
          // renderCoachWelcomeRow() above - both read the same server field.
          const joined = !Number.isFinite(days) ? "" : days === 0 ? "הצטרף/ה היום" : days === 1 ? "הצטרף/ה לפני יום" : `לפני ${days} ימים`;
          const sessions = Number(m.sessions_logged) || 0;
          // Says what the number IS. A count of workouts logged in the app is
          // not a count of classes attended, and a coach must not read it as
          // one.
          const trained = sessions === 1 ? "אימון אחד באפליקציה" : sessions ? `${sessions} אימונים באפליקציה` : "לא רשמו אימון באפליקציה";
          const contacted = m.contacted ? "נוצר קשר" : "טרם נוצר קשר";
          // THE MEMBER THIS WHOLE FIX EXISTS FOR. Before 202609060020
          // coach_new_members() INNER JOINed activity_pings, so someone who
          // registered and never opened the app again had no row to join to
          // and could not appear in this list at all - the one person day-0
          // retention outreach is actually for.
          const never = m.has_opened_app === false
            ? `<div style="color:var(--brass);font-size:12px;margin-top:2px;">${bidiText("עדיין לא נכנס/ה לאפליקציה")}</div>`
            : "";
          return `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:2px;">
            <span style="font-weight:700;">${nameHtml(m.display_name, m.handle)}</span>
            <span style="color:var(--steel);font-size:12px;">${bidiText([joined, trained, contacted].filter(Boolean).join(" · "))}</span>
            ${never}
          </div>`;
        }).join("")}</div>`
      : `<div class="empty">אין חברים חדשים לאחרונה</div>`;
    // margin-top:0, unlike every other section in this file: since the
    // Account tab grouped its staff-only blocks, this is the FIRST child of
    // that group rather than the next section after a member setting, and an
    // 18px gap under the group's own label read as a break rather than as
    // membership. See the staff area in cloud.js.
    //
    // NO "ניהול" TAG on this head or on renderCoachAppActivitySection's,
    // for the same reason: the group they now sit in carries one, and three
    // identical badges in one block is the badge saying nothing. The tag is
    // still exactly where it was - on the thing that is staff-only - it is
    // just on the group rather than on each of its two members.
    return `<div class="ach-section" style="margin-top:0;">${sectionHead("var(--green)", "חברים חדשים")}${body}</div>`;
  }

  function renderCoachAppActivitySection() {
    const all = state.club.inactiveMembers || [];
    const lapsed = all.filter((m) => m.state === "lapsed");
    const unknown = all.filter((m) => m.state === "no_data");
    const sig = state.club.activitySignal;

    // Rule 2. The honest empty state, and the highest-priority branch: if no
    // member in the club has ever produced a single ping, this section knows
    // nothing and says so. It does NOT say everyone is fine, and it does not
    // list anybody - on an empty signal every member would qualify as
    // "no recent activity", which is exactly the 8-of-8 failure.
    if (sig && Number(sig.members_with_app_activity) === 0) {
      return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--steel)", "לא נכנסו לאפליקציה לאחרונה")}${coachAppSignalNote()}<div class="empty">${bidiText("אין עדיין נתוני פעילות")}<div style="color:var(--steel);font-size:12px;line-height:1.6;margin-top:6px;">${bidiText("הנתונים מתחילים להצטבר כשחברים נכנסים לאפליקציה. עד אז אין כאן מה להציג.")}</div></div></div>`;
    }

    // Rule 1, first half: the actionable list. Only members we have real
    // evidence about, each with the date that evidence ran out.
    const lapsedHtml = lapsed.length
      ? `<div class="log-list">${lapsed.map((m) => {
          const days = Number(m.days_since_activity);
          const gap = Number.isFinite(days) ? `כניסה אחרונה: לפני ${days} ימים` : "כניסה אחרונה";
          return `<div class="log-row">
            <span>${nameHtml(m.display_name, m.handle)}</span>
            <span style="color:var(--steel);font-size:12px;">${bidiText(`${gap} · ${m.last_activity_on || ""}`)}</span>
          </div>`;
        }).join("")}</div>`
      // Now a true statement rather than a guess: we reach here only when the
      // club HAS activity data and nobody in it has gone quiet.
      : `<div class="empty">${bidiText("כולם נכנסו לאפליקציה לאחרונה ✓")}</div>`;

    // Rule 1, second half. A separate group, a neutral colour and no date.
    // "אין נתונים" is a statement about our records; "מעולם לא" was a
    // statement about the member, and it was frequently false.
    const unknownHtml = unknown.length
      ? `<div style="margin-top:14px;">
          <div style="font-weight:700;font-size:13px;color:var(--steel);margin-bottom:4px;">${bidiText("אין לנו מספיק מידע")}</div>
          <div style="color:var(--steel);font-size:12px;line-height:1.6;margin-bottom:8px;">${bidiText("לא רשומות אצלנו כניסות לאפליקציה עבור החברים האלה. זה לא אומר שהם לא מתאמנים.")}</div>
          <div class="log-list">${unknown.map((m) => `<div class="log-row">
            <span>${nameHtml(m.display_name, m.handle)}</span>
            <span style="color:var(--steel);font-size:12px;">${bidiText("אין נתונים")}</span>
          </div>`).join("")}</div>
        </div>`
      : "";

    // Red only when there is something to act on. A club whose only entries
    // are members we know nothing about is not a club in trouble, and
    // colouring it as one is the same overclaim in a different medium.
    const accent = lapsed.length ? "var(--red)" : "var(--steel)";
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead(accent, "לא נכנסו לאפליקציה לאחרונה")}${coachAppSignalNote()}${lapsedHtml}${unknownHtml}</div>`;
  }
