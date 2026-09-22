"use strict";
// ---- Community: the directory and member relationships --------------------
//
// Who is in the club and how members relate to one another: the alphabetical
// roster, community search, "people you may know", the profile overlay with
// its follower/following lists, follow and block, the privacy toggles that
// decide what a profile exposes, and the trained-with-you-today card.
//
// Moved out of cloud.js unchanged — every line byte-identical to what it was
// there. Classic <script>, no IIFE, loaded before cloud.js; see
// src/community/events.js's header for why each of those matters.
//
// canViewProfileField() and PRIVACY_FIELDS are the client half of a rule the
// server enforces in can_view_profile_field(). They are here because this is
// where a profile is rendered, NOT because this is where the decision is
// made — the policy is the authority and this only decides what to draw.
//
// blockFilteredList() and isBlockedUser() live here with the rest of the
// relationship model although the feed, comments and boards all call them.
// One block predicate, read from everywhere, is the point.
//
// WHAT STAYED BEHIND, deliberately: report() and reportProfile(), which sit
// between search and privacy in cloud.js. Reporting is the entry point to
// moderation, and it moves with admin.

  // COMM-125. A block edge in EITHER direction hides that member's comments
  // and reaction avatars from the viewer. feed_page already anti-joins blocked
  // authors server-side; this is the comment and reaction read half, a client
  // echo of the same rule rather than the enforcement point.
  async function loadBlockedIds() {
    if (!state.user) { state.members.blockedIds = []; state.members.blocksLoaded = true; state.members.blockedByMe = []; state.members.blockedByMeNames = {}; state.members.blockedByMeLoaded = true; return; }
    const ids = {};
    const a = await client.from("blocks").select("blocked_id").eq("blocker_id", state.user.id);
    for (const r of (a.data || [])) ids[r.blocked_id] = true;
    const b = await client.from("blocks").select("blocker_id").eq("blocked_id", state.user.id);
    for (const r of (b.data || [])) ids[r.blocker_id] = true;
    state.members.blockedIds = Object.keys(ids);
    state.members.blocksLoaded = true;
    // Live bug hunt (2026-09-11): only MY blocks (the `a` query above) are
    // mine to ever list for unblocking - see blockedByMe's own comment.
    // Names in a second read, same pattern loadRestrictions() already uses.
    const mine = (a.data || []).map((r) => r.blocked_id);
    state.members.blockedByMe = mine;
    if (mine.length) {
      const { data: profs } = await client.from("profiles").select("id,handle,display_name").in("id", mine);
      const names = {};
      for (const p of (profs || [])) names[p.id] = p.display_name || p.handle || "";
      state.members.blockedByMeNames = names;
    } else {
      state.members.blockedByMeNames = {};
    }
    state.members.blockedByMeLoaded = true;
  }
  // Live bug hunt (2026-09-11): blocking had no reverse path anywhere in the
  // app - no unblock() function, no "blocked members" list, nothing on the
  // full profile overlay - confirmed live, a permanent one-way action for
  // the life of both accounts (recoverable only via direct DB access). Same
  // busy-guard shape follow()/block() (further down this file) already use.
  async function unblock(userId) {
    if (!state.user || state.members.unblocking) return;
    state.members.unblocking = userId; rerender();
    const { error } = await client.from("blocks").delete().eq("blocker_id", state.user.id).eq("blocked_id", userId);
    state.members.unblocking = "";
    if (error) { setMessage(failText("ביטול החסימה נכשל. נסו שוב", error)); rerender(); return; }
    await loadBlockedIds();
    setMessage("החסימה בוטלה");
    rerender();
  }
  // Live bug hunt (2026-09-11): unblock()'s own client surface, wired into
  // the Account tab's privacy panel. See loadBlockedIds()'s comment for why
  // blockedByMe (not blockedIds) is what this lists.
  function renderBlockedMembersPanel() {
    const ids = state.members.blockedByMe || [];
    if (!ids.length) return "";
    const names = state.members.blockedByMeNames || {};
    const rows = ids.map((id) => `<div class="log-row" style="align-items:center;">
      <span>${bidiText(names[id] || "חבר/ה")}</span>
      <button class="chip-btn"${state.members.unblocking === id ? " disabled" : ""} data-community-action="unblock" data-id="${esc(id)}">${state.members.unblocking === id ? "מבטלים…" : "ביטול חסימה"}</button>
    </div>`).join("");
    return `<div class="ach-section" style="margin-top:18px;" data-blocked-members-section="1">${sectionHead("var(--blue)", "חברים חסומים")}<div class="log-list">${rows}</div></div>`;
  }
  function isBlockedUser(userId) { return !!userId && state.members.blockedIds.indexOf(userId) >= 0; }
  // FILTER WHEN RENDERING, not when blocking.
  //
  // Live bug hunt, fresh round 8 (2026-09-15), and the bug it fixes was
  // committed by round 7's own fix to this exact problem. block() purges the
  // member-row caches it knows about - and it had just been widened from one
  // to three, with a comment saying "EVERY surface that renders a member row"
  // - while two more went on rendering a blocked member with live "פרופיל"
  // and "מעקב" buttons for the rest of the session: the people-you-may-know
  // strip and the trained-with-you-today card. Both are loaded once and never
  // invalidated. The block dialog promises "לא תראו זה את זה בקהילה"; two of
  // the app's own surfaces did not honour it.
  //
  // Enumerating caches is what produced the bug twice, so this stops doing
  // that. Reactors, comments, mentions and mention-search already filter with
  // isBlockedUser() AT RENDER TIME, which is the pattern that cannot rot: a
  // stale cache is then harmless, and a surface added later inherits the
  // behaviour by using the same helper rather than by someone remembering to
  // add it to a purge list.
  //
  // Returns a shallow copy so the cached list itself is untouched - an
  // unblock must be able to bring those rows straight back without a reload.
  function blockFilteredList(slice) {
    if (!slice || !Array.isArray(slice.items)) return slice;
    const kept = slice.items.filter((m) => !m || !isBlockedUser(m.id || m.user_id));
    return kept.length === slice.items.length ? slice : Object.assign({}, slice, { items: kept });
  }

  async function loadFollowingIds() {
    if (!state.user) { state.members.followingIds = []; state.members.followingLoaded = true; return; }
    const { data } = await client.from("follows").select("followed_id").eq("follower_id", state.user.id);
    state.members.followingIds = (data || []).map((r) => r.followed_id);
    state.members.followingLoaded = true;
  }
  function isFollowingUser(userId) { return !!userId && state.members.followingIds.indexOf(userId) >= 0; }
  // Every "מעקב" button in the app shares this so the label/disabled-state/
  // data-action stay identical everywhere rather than five copies drifting.
  // Once already following, the button still triggers the same follow()
  // toggle (an unfollow) - same control, no separate unfollow affordance to
  // keep in sync with this one.
  function followButtonHtml(userId) {
    const following = isFollowingUser(userId);
    const busy = !!state.members.followBusy[userId];
    return `<button class="chip-btn${following ? " selected" : ""}" data-community-action="follow" data-id="${esc(userId)}"${busy ? " disabled" : ""}>${busy ? "…" : (following ? "עוקבים" : "מעקב")}</button>`;
  }

  // COMM-228. Members, events and challenges in one round trip. The RPC is
  // security definer and unions three rules that already exist as RLS
  // policies (profiles_read_authenticated, events_read, challenges_read),
  // so it never returns a row the caller could not already have read one at
  // a time - see "## Realtime and search" in docs/community/contracts.md.
  const SEARCH_MIN_CHARS = 2;
  const SEARCH_GROUP_LIMIT = 10;
  let searchToken = 0;
  // The exact characters the RPC strips server-side. Sanitizing here too is
  // not redundant: it is what makes the under-2-chars check agree with the
  // server's, so a query of only "%_,()" never costs a round trip.
  // A LEADING "@" IS STRIPPED. Live bug hunt, fresh round 7 (2026-09-15).
  //
  // "@handle" is the form this app SHOWS a member everywhere their display
  // name is missing - search rows, suggestion cards, a post byline. So it is
  // the form they copy and type back. It found nothing: the ILIKE pattern
  // became %@ritz% against a handle column that never contains an "@", so
  // typing what was on screen returned zero results while typing the same
  // handle without it matched. Only the LEADING one goes - an "@" inside a
  // query is ordinary text and might be part of a name.
  function sanitizeSearchQuery(query) { return String(query || "").trim().replace(/^@+/, "").replace(/[%_,()]/g, ""); }
  // COMM-233. One search_performed per search the member actually made,
  // not one per keystroke. Both boxes fire a request on every input event
  // (there is no debounce on the fetch itself - COMM-228 chose latency over
  // batching and the token guard makes it safe), so tracking the raw call
  // would put three rows in the table for a member typing "noam" and turn
  // "searches per week" into "characters typed per week". The last result
  // set to settle inside the window is the one recorded, which is the query
  // the member actually meant. Never the query text itself: only its
  // length and the size of each result group, and the helper's own
  // HAND_PROP_KEYS allow-list drops anything else a future call site adds.
  const SEARCH_TRACK_DEBOUNCE_MS = 600;
  let searchTrackTimer = null;
  function trackSearchPerformed(props) {
    if (searchTrackTimer) clearTimeout(searchTrackTimer);
    searchTrackTimer = setTimeout(() => { searchTrackTimer = null; track(A.SEARCH_PERFORMED, props); }, SEARCH_TRACK_DEBOUNCE_MS);
  }
  // Clearing the box, or backspacing under the two-character floor, is the
  // member abandoning the search. Nothing was searched, so nothing pending
  // is worth recording.
  function cancelSearchTracking() { if (searchTrackTimer) { clearTimeout(searchTrackTimer); searchTrackTimer = null; } }
  function clearSearchResults() { state.members.people = []; state.search.events = []; state.search.challenges = []; }
  async function communitySearch(query) {
    if (!state.user) return;
    // state.search.query keeps what the member typed, so a re-render does not
    // rewrite the box under their cursor; only the request is sanitized.
    state.search.query = String(query || "");
    const q = sanitizeSearchQuery(query);
    const token = ++searchToken;
    // Under two characters is empty results, no request and no error -
    // the same threshold the RPC re-applies for a caller that skips it.
    if (q.length < SEARCH_MIN_CHARS) { cancelSearchTracking(); clearSearchResults(); state.search.loading = false; return rerender(); }
    state.search.loading = true;
    rerender();
    const { data, error } = await client.rpc("community_search", { p_query: q, p_limit: SEARCH_GROUP_LIMIT });
    // A slower earlier keystroke must not overwrite a later one's results.
    if (token !== searchToken) return;
    state.search.loading = false;
    // Failure clears rather than showing a broken state, matching what the
    // members-only search did before this ticket widened it.
    const groups = (!error && data && typeof data === "object") ? data : {};
    // allow_follows comes back in the members group so the follow button can
    // be hidden for a member who turned follows off. The server still
    // rejects the insert (follows_insert_self checks the same column plus
    // block edges), this is only so the button does not lie.
    state.members.people = Array.isArray(groups.members) ? groups.members : [];
    state.search.events = Array.isArray(groups.events) ? groups.events : [];
    state.search.challenges = Array.isArray(groups.challenges) ? groups.challenges : [];
    trackSearchPerformed({
      source: "community_search",
      query_length: q.length,
      member_count: state.members.people.length,
      event_count: state.search.events.length,
      challenge_count: state.search.challenges.length,
    });
    rerender();
    // COMM-160. Resolve the coach badge for the result set from the shared
    // server role cache, then re-render.
    loadMemberRoles(state.members.people.map((p) => p.id)).then(() => rerender());
  }
  // The search box's input handler keeps its original name: it is still the
  // members-first entry point every existing caller wired, COMM-228 only
  // widened what one keystroke fetches.
  // Launch-readiness audit, PERF-3. Every keystroke used to fire a
  // community_search RPC AND a full #content rebuild. The existing
  // searchToken guard stops an out-of-order response overwriting a newer
  // one, but it does not stop the requests being made: typing "deadlift"
  // was 8 round trips and 8 whole-page re-renders, on a codebase whose
  // render model rebuilds the entire tab.
  //
  // 220 ms is below the ~250 ms at which typing starts to feel laggy and
  // comfortably above a fast typist's inter-key interval, so a normal word
  // now costs one request instead of one per character. The token guard is
  // kept as well - debounce reduces the number of in-flight requests, it
  // does not guarantee ordering of the ones that still overlap.
  const SEARCH_DEBOUNCE_MS = 220;
  let searchDebounceTimer = null;
  let memberSearchDebounceTimer = null;
  function searchPeople(query) {
    // The typed value is stored synchronously so the input never fights the
    // member's cursor while the request is still pending.
    state.search.query = String(query || "");
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = null;
      communitySearch(query);
    }, SEARCH_DEBOUNCE_MS);
  }
  // COMM-018. The single client entry point to the server's per-field
  // privacy resolver. Feed, profile, leaderboard and search all resolve a
  // hidden field through this RPC (or the equivalent RLS policy) so one
  // surface cannot leak what another hides. Returns false on any error or
  // null caller, matching the function's own contract.
  async function canViewProfileField(targetUserId, fieldName) {
    if (!state.user || !targetUserId) return false;
    const { data, error } = await client.rpc("can_view_profile_field", { p_target: targetUserId, p_field: fieldName });
    return !error && data === true;
  }
  // Exposed so the feed, engagement and search surfaces owned by other
  // agents resolve hidden fields through the same one place.
  window.canViewProfileField = canViewProfileField;
  // COMM-018. Every toggle is a direct own-row RLS upsert into profiles.
  // protect_is_admin() pins is_admin, club_id and recovery_verified_at on
  // any authenticated write, so sending just the one boolean is safe. The
  // enforcement point is the server (profiles_read_authenticated,
  // follows_insert_self, can_view_profile_field); this only records the
  // member's choice. Optimistic, reverts the toggle on error.
  const PRIVACY_FIELDS = [
    { key: "visible_to_club", label: "הפרופיל שלי גלוי לחברי המועדון" },
    { key: "show_workout_results", label: "תוצאות האימונים שלי גלויות לחברי המועדון" },
    { key: "show_prs", label: "שיאים אישיים (PR) גלויים" },
    { key: "show_achievements", label: "הישגים ומדליות גלויות" },
    { key: "show_attendance", label: "נוכחות בשיעורים גלויה" },
    { key: "show_upcoming_booking", label: "רישום קרוב לשיעור גלוי" },
    { key: "show_in_attendee_lists", label: "הופעה ברשימת הנרשמים לשיעור" },
    { key: "in_leaderboards", label: "הכללה בטבלאות המובילים" },
    { key: "allow_follows", label: "אפשר לחברי המועדון לעקוב אחריי" },
    { key: "allow_mentions", label: "אפשר אזכור שלי בתגובות (@)" },
    // Real bug found by a role-coverage audit: this panel offered a toggle
    // for "allow private messages to me" (allow_messages) with no direct-
    // messaging feature anywhere in the app to gate - a member could set a
    // privacy preference for something that doesn't exist. The
    // `profiles.allow_messages` column and its RLS clause stay in the
    // schema (harmless, and ready the day DMs actually ship); only the
    // misleading client control is removed. PROFILE_COLUMNS below no
    // longer fetches it either, since nothing reads it now.
  ];
  const PRIVACY_KEYS = PRIVACY_FIELDS.map((f) => f.key);
  async function savePrivacyField(field, value) {
    if (!state.user || !state.profile || PRIVACY_KEYS.indexOf(field) < 0) return;
    const prev = state.profile[field];
    if (prev === value) return;
    state.profile[field] = value;
    rerender();
    // update, not upsert - same reason as saveAvatarUrl() above: the row
    // exists (this returns early without state.profile), and an upsert makes
    // Postgres evaluate profiles_insert_self, which refuses once
    // recovery_verified_at is set.
    const { error } = await client.from("profiles").update({ [field]: value }).eq("id", state.user.id);
    // Domain message, not serverErrorText(): a member needs to know WHICH
    // thing failed to save, and "לא ניתן לשמור הגדרה זו" says that where a
    // generic server string would not. The avatar path is the opposite
    // case - there the cause is what was missing.
    if (error) { state.profile[field] = prev; setMessage(failText("לא ניתן לשמור הגדרה זו", error)); return; }
    setMessage("הגדרת הפרטיות נשמרה");
  }

  // COMM-230. Returns { error } so a caller that needs to know whether the
  // toggle actually succeeded (the following list's own optimistic
  // remove/rollback) can tell, without a second write path: every follow or
  // unfollow anywhere in the app - search, suggestions, the profile header,
  // the directory, the following surface - still goes through this one
  // function. Callers that never read the return value (most of them, still)
  // are unaffected.
  async function follow(userId) {
    if (!state.user) return { error: { message: "not signed in" } };
    // Live bug hunt (2026-09-11): no in-flight guard meant a fast double-tap
    // (the natural reaction to a button that never visibly changed) fired
    // this twice - the second call's insert always hits the first call's
    // still-fresh row and 23505s, which the branch below turns into an
    // unfollow. Same shape as reactionBusy on the cheer button.
    if (state.members.followBusy[userId]) return { error: null };
    state.members.followBusy[userId] = true;
    rerender();
    const { error } = await client.from("follows").insert({ follower_id: state.user.id, followed_id: userId });
    let finalError = error || null;
    let nowFollowing = !error;
    if (error && error.code === "23505") {
      const del = await client.from("follows").delete().eq("follower_id", state.user.id).eq("followed_id", userId);
      finalError = del.error || null;
      nowFollowing = false;
    }
    // COMM-170. This control toggles: the 23505 branch above is an
    // unfollow, and a rejected insert is neither. Only a real new follow
    // edge is tracked, and there is no member_unfollowed in the event set.
    else if (!error) track(A.MEMBER_FOLLOWED, { user_id: userId });
    if (!finalError) {
      const ids = state.members.followingIds;
      state.members.followingIds = nowFollowing
        ? (ids.indexOf(userId) >= 0 ? ids : ids.concat([userId]))
        : ids.filter((id) => id !== userId);
    }
    delete state.members.followBusy[userId];
    await loadFeed();
    // Distinct wording per direction - "המעקב עודכן" for both left a member
    // with zero confirmation of which action just happened, on a button
    // that itself never visibly changed either (see followButtonHtml()).
    setMessage(finalError ? "עדכון המעקב נכשל" : (nowFollowing ? "התחלתם לעקוב" : "הפסקתם לעקוב"));
    return { error: finalError };
  }
  async function block(userId) {
    if (!state.user) return;
    const { error } = await client.from("blocks").upsert({ blocker_id: state.user.id, blocked_id: userId });
    if (error) { setMessage(failText("לא ניתן היה לחסום. נסו שוב", error)); return; }
    await client.from("follows").delete().eq("follower_id", state.user.id).eq("followed_id", userId);
    // EVERY surface that renders a member row, not just the search array.
    // Live bug hunt, fresh round 7 (2026-09-15): searchMemberRowHtml() is
    // shared by community search AND the members directory, but block() only
    // filtered state.members.people - so blocking someone from the directory
    // left their row on screen with a live follow button. Tapping it failed
    // server-side (the database refuses a follow across a block edge), so the
    // harm was a stale, actionable row rather than a bad write; a row that
    // still offers an action after you have blocked its owner is the bug.
    state.members.people = state.members.people.filter((person) => person.id !== userId);
    const dir = state.members.directory;
    if (dir) {
      if (Array.isArray(dir.items)) dir.items = dir.items.filter((m) => m && m.id !== userId);
      if (Array.isArray(dir.searchResults)) dir.searchResults = dir.searchResults.filter((m) => m && m.id !== userId);
    }
    // COMM-125. Refresh the block set so comments and reaction avatars from
    // the newly blocked member drop out of the current view too.
    await loadBlockedIds();
    state.engagement.comments = {}; state.engagement.reactions = {};
    await loadFeed();
    setMessage("המשתמש נחסם");
  }

  // ==========================================================================
  // COMM-232 - "אנשים שאולי תכירו"
  // ==========================================================================
  // PLACEMENT NOTE. COMM-232 named the members directory (COMM-231) as this
  // strip's real home; it rendered on the Account sub-tab only as a stand-in
  // until that screen existed. Now that COMM-231 has shipped,
  // renderPeopleSuggestions() is called from renderDirectorySection() only -
  // moved, not duplicated, since a member who has already followed everyone
  // suggested on one surface should not see the same cards again on another.
  //
  // The error state is unusual on purpose: the strip is omitted entirely
  // rather than showing a retry, because this is a secondary surface and a
  // broken recommendation row is worse than no recommendation row.
  const PEOPLE_SUGGESTIONS_LIMIT = 10;
  const SUGGESTION_REASONS = {
    challenge: "אתגר משותף",
    interaction: "פעילות משותפת בפיד",
    event: "אירוע משותף",
  };
  async function loadPeopleSuggestions() {
    // Same pre-profile guard as loadConsistencyLeaderboard: people_suggestions()
    // gates on my_role_code() too.
    if (!client || !state.user || !state.profile) return;
    const s = state.members.suggestions;
    s.loading = true; s.error = false;
    rerender();
    const { data, error } = await client.rpc("people_suggestions", { p_limit: PEOPLE_SUGGESTIONS_LIMIT });
    s.loading = false; s.loaded = true;
    if (error) { s.error = true; s.items = []; return rerender(); }
    // Rendered in the order returned: people_suggestions() already ranks by
    // strongest signal (a shared live challenge outranks any number of shared
    // reactions), and re-sorting here would throw that away.
    s.items = (Array.isArray(data) ? data : []).filter(Boolean);
    rerender();
  }
  // Reuses follow() - the same insert-or-delete path the search UI's follow
  // button uses - rather than a second write. COMM-230's following surface is
  // not built yet; when it is, this stays pointed at the same action.
  // The card is dropped locally afterwards because the server already excludes
  // a follow edge in either direction, so a refetch would drop it anyway.
  async function followSuggestion(userId) {
    if (!userId) return;
    const s = state.members.suggestions;
    s.busy[userId] = true;
    rerender();
    await follow(userId);
    delete s.busy[userId];
    s.items = s.items.filter((it) => it && it.user_id !== userId);
    rerender();
  }
  function suggestionCardHtml(item) {
    const name = item.display_name || (item.handle ? "@" + item.handle : "חבר/ה");
    const reason = SUGGESTION_REASONS[item.reason] || "";
    const busy = !!state.members.suggestions.busy[item.user_id];
    return `<div class="chart-card" data-suggestion-user="${esc(item.user_id)}" style="flex:0 0 auto;min-width:148px;max-width:170px;text-align:center;margin:0;">
      ${avatarHtml(name, 44, item.avatar_url)}
      <div style="font-weight:700;margin-top:6px;font-size:13px;">${esc(name)}</div>
      ${item.handle ? `<div style="color:var(--steel);font-size:12px;"><bdi>@${esc(item.handle)}</bdi></div>` : ""}
      ${reason ? `<div style="color:var(--steel);font-size:11px;margin-top:4px;">${esc(reason)}</div>` : ""}
      <div class="chip-row" style="justify-content:center;margin-top:6px;">
        <button class="chip-btn primary" data-community-action="suggestion-follow" data-id="${esc(item.user_id)}"${busy ? " disabled" : ""}>${busy ? "…" : "מעקב"}</button>
        <button class="chip-btn" data-community-action="view-profile" data-id="${esc(item.user_id)}">פרופיל</button>
      </div>
    </div>`;
  }
  function renderPeopleSuggestions() {
    const s = blockFilteredList(state.members.suggestions);
    // COMM-232: on error the strip is not rendered at all - no heading, no
    // empty state, no retry. Nothing tells the member a thing failed.
    if (s.error) return "";
    const head = sectionHead("var(--teal)", "אנשים שאולי תכירו");
    if (!s.loaded) {
      const card = `<div class="chart-card" aria-hidden="true" style="flex:0 0 auto;min-width:148px;height:118px;margin:0;"></div>`;
      return `<div class="ach-section" style="margin-top:18px;" data-people-suggestions="loading">${head}<div class="flex gap-10" aria-busy="true" style="overflow-x:auto;padding-bottom:4px;">${card.repeat(3)}</div></div>`;
    }
    if (!s.items.length) {
      return `<div class="ach-section" style="margin-top:18px;" data-people-suggestions="empty">${head}<div class="empty">עדיין אין המלצות. התחילו לבלות בקהילה כדי לקבל הצעות.</div></div>`;
    }
    return `<div class="ach-section" style="margin-top:18px;" data-people-suggestions="ready">${head}
      <div class="flex gap-10" style="overflow-x:auto;padding-bottom:4px;align-items:stretch;">${s.items.map(suggestionCardHtml).join("")}</div>
    </div>`;
  }

  // ==========================================================================
  // COMM-231 - members directory
  // ==========================================================================
  // A browsable, alphabetical roster of every club member with
  // visible_to_club on - what search never was (search only ever answers
  // "is there a member named X"; this answers "who is in this club").
  // Paginated by display_name, page size DIRECTORY_PAGE_SIZE, cursor = the
  // last row's own display_name (COMM-113's convention: the audit log's
  // cursor is its last row's created_at the same way, with the same
  // accepted duplicate-value edge case - this is not a new risk, it is the
  // existing one, on a different column). The caller's own row is excluded,
  // matching community_search's own convention: a member finds their own
  // profile through the Account tab, not a roster of "everyone including
  // me". A blocked member never appears - profiles_read_authenticated
  // already drops a block edge in either direction, same as every other
  // profiles read in this file.
  const DIRECTORY_PAGE_SIZE = 40;
  const DIRECTORY_ERROR_TEXT = "לא ניתן היה לטעון את רשימת החברים. נסו שוב.";
  const DIRECTORY_EMPTY_TEXT = "אין חברים להצגה.";
  async function loadDirectory(reset) {
    if (!state.user) return;
    const d = state.members.directory;
    if (reset) { d.items = []; d.cursor = null; d.end = false; d.loaded = false; }
    if (d.loading || d.loadingMore) return;
    if (reset) d.loading = true; else d.loadingMore = true;
    d.error = false;
    rerender();
    let q = client.from("profiles").select("id,handle,display_name,avatar_url,allow_follows,visible_to_club")
      .neq("id", state.user.id).order("display_name", { ascending: true }).limit(DIRECTORY_PAGE_SIZE);
    if (d.cursor) q = q.gt("display_name", d.cursor);
    const { data, error } = await q;
    d.loading = false; d.loadingMore = false;
    // Set before the error check, same as loadAuditLog's own cursor read:
    // a failed load still counts as "the first attempt happened", so the
    // afterRenderCommunity() lazy-load trigger (gated on !d.loaded) does not
    // re-fire this on every render and loop forever retrying a failure the
    // member has not asked to retry yet.
    d.loaded = true;
    if (error) { d.error = true; rerender(); return; }
    const raw = Array.isArray(data) ? data : [];
    // Defence in depth, not a second real gate: profiles_read_authenticated
    // already lets the caller's own row through regardless of
    // visible_to_club (dropped above by neq()) and a real admin's read
    // through regardless of the target's visible_to_club (is_admin() OR in
    // the policy) - a roster of "everyone visible to the club" is not the
    // right surface for an admin's widened read, so this filters strictly
    // on the column itself rather than trusting the policy's own reason for
    // returning the row.
    const visible = raw.filter((r) => r && r.visible_to_club);
    d.items = d.items.concat(visible);
    d.cursor = raw.length ? raw[raw.length - 1].display_name : d.cursor;
    d.end = raw.length < DIRECTORY_PAGE_SIZE;
    rerender();
    loadMemberRoles(visible.map((r) => r.id)).then(() => rerender());
  }
  let directorySearchToken = 0;
  // Reuses community_search (COMM-228) for two characters or more - the
  // same members group, the same sanitization, the same result shape
  // searchMemberRowHtml already renders - rather than inventing a second
  // search path. Below that threshold community_search would answer empty
  // anyway (its own documented floor), so this falls back to a client-side
  // substring filter over whatever page of the roster is already loaded,
  // per the ticket's own "falling back to the existing client-side filter"
  // clause. Clearing the box returns to the plain paginated roster.
  let directorySearchTimer = null;
  function directorySearchDebounced(query) {
    state.members.directory.query = String(query || "");
    if (directorySearchTimer) clearTimeout(directorySearchTimer);
    directorySearchTimer = setTimeout(() => {
      directorySearchTimer = null;
      directorySearch(query);
    }, SEARCH_DEBOUNCE_MS);
  }
  async function directorySearch(query) {
    const d = state.members.directory;
    d.query = String(query || "");
    const q = sanitizeSearchQuery(query);
    const token = ++directorySearchToken;
    if (q.length < SEARCH_MIN_CHARS) { cancelSearchTracking(); d.searchResults = null; d.searchLoading = false; return rerender(); }
    d.searchLoading = true;
    rerender();
    const { data, error } = await client.rpc("community_search", { p_query: q, p_limit: DIRECTORY_PAGE_SIZE });
    if (token !== directorySearchToken) return; // a slower earlier keystroke must not overwrite a later one's results
    d.searchLoading = false;
    if (error) { d.searchResults = []; return rerender(); }
    const members = (data && Array.isArray(data.members)) ? data.members : [];
    d.searchResults = members;
    // The roster's box asks community_search for the members group only, so
    // the other two counts are absent rather than zero - an absent prop and
    // a zero prop mean different things and the difference is worth keeping.
    trackSearchPerformed({ source: "directory", query_length: q.length, member_count: members.length });
    rerender();
    loadMemberRoles(members.map((m) => m.id)).then(() => rerender());
  }
  function directoryRows() {
    const d = state.members.directory;
    const q = String(d.query || "").trim();
    if (!q) return d.items;
    if (Array.isArray(d.searchResults)) return d.searchResults;
    const needle = q.toLowerCase();
    return d.items.filter((m) => (m.display_name || "").toLowerCase().indexOf(needle) >= 0 || (m.handle || "").toLowerCase().indexOf(needle) >= 0);
  }
  function directorySkeletonHtml(n) {
    const row = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:52%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
    return `<div class="log-list" aria-busy="true" data-directory-skeleton="1">${row.repeat(n || 6)}</div>`;
  }
  // Coach/head_coach members split to their own group above everyone else
  // (COMM-160's badge, reused, not reinvented) - each group keeps the
  // alphabetical order the roster (or the search result) already came back
  // in, so splitting never re-sorts anything.
  function splitDirectoryStaff(rows) {
    const staff = [], rest = [];
    rows.forEach((m) => (isCoachRole(memberRole(m.id)) ? staff : rest).push(m));
    return { staff, rest };
  }
  function renderDirectorySection() {
    const d = state.members.directory;
    const q = String(d.query || "").trim();
    const searchBox = `<input class="text-input" id="communityDirectorySearch" placeholder="חיפוש לפי שם" value="${esc(d.query || "")}" aria-label="חיפוש חברים" style="margin-bottom:10px;"/>`;
    const stillSearching = !!q && q.length >= SEARCH_MIN_CHARS && d.searchLoading && d.searchResults == null;
    let body;
    if (d.loading && !d.items.length) body = directorySkeletonHtml(6);
    else if (d.error && !d.items.length) {
      body = `<div class="empty" role="alert" data-directory-empty="error">${DIRECTORY_ERROR_TEXT}<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="directory-retry">ניסיון חוזר</button></div></div>`;
    } else if (stillSearching) {
      body = directorySkeletonHtml(3);
    } else {
      const rows = directoryRows();
      if (!rows.length) {
        // Live bug hunt (2026-09-11): same class of bug COMM-377 already
        // fixed for the admin roster (renderMemberRoster() above) - a
        // zero-length list meant two different things (a genuinely empty
        // directory, or a search that matched nobody) and both rendered the
        // identical "אין חברים להצגה" text/attribute, reading as "this
        // club's directory is broken" to a member who just mistyped a
        // clubmate's name. `q` (already computed above) is exactly what
        // roster's own `searching` flag tracks - just never threaded into
        // this branch.
        body = q
          ? `<div class="empty" data-directory-empty="no-results">לא נמצאו חברים תואמים לחיפוש</div>`
          : `<div class="empty" data-directory-empty="empty">${DIRECTORY_EMPTY_TEXT}</div>`;
      } else {
        const { staff, rest } = splitDirectoryStaff(rows);
        const staffHtml = staff.length ? `<div class="log-list" data-directory-group="staff">${staff.map(searchMemberRowHtml).join("")}</div>` : "";
        const restHtml = rest.length ? `<div class="log-list" data-directory-group="members"${staff.length ? ' style="margin-top:10px;"' : ""}>${rest.map(searchMemberRowHtml).join("")}</div>` : "";
        // Paging only applies to the plain roster - a search result set
        // (community_search or the client-side filter) is already the whole
        // answer for that query, not a page of one.
        const moreHtml = (!q && !d.end) ? `<div class="chip-row" style="justify-content:center;margin-top:8px;"><button class="chip-btn" data-community-action="directory-more"${d.loadingMore ? " disabled" : ""}>${d.loadingMore ? "טוען…" : "טעינת עוד"}</button></div>` : "";
        body = staffHtml + restHtml + moreHtml;
      }
    }
    // COMM-232's suggestions strip lives here now - see the PLACEMENT NOTE
    // above renderPeopleSuggestions(): this is the surface COMM-232 always
    // named as its real home, the Account tab was only ever the stand-in
    // until this screen existed.
    return `<div class="ach-section">${sectionHead("var(--blue)", "חברי המועדון")}${searchBox}${body}</div>${renderPeopleSuggestions()}`;
  }

  // ---- COMM-228 grouped search -------------------------------------------
  // One box, three labeled groups, never interleaved: a member row is not
  // comparable to an event row, and mixing them would force an ordering
  // (relevance across types) the RPC deliberately does not compute.
  function searchGroupHtml(label, rowsHtml) {
    return `<div class="search-group" data-search-group="${label}" style="margin-top:10px;">
      <h3 class="field-label" style="margin-bottom:6px;">${searchGroupTitle(label)}</h3>
      ${rowsHtml ? `<div class="log-list">${rowsHtml}</div>` : `<div class="empty" style="padding:6px 0;">אין תוצאות</div>`}
    </div>`;
  }
  // Post-Phase-3 Hebrew copy fix: "חברים" (members), matching the term used
  // everywhere else in the app (200+ instances) - "מתאמנים" (trainees) was
  // a one-off outlier only in this search grouping.
  function searchGroupTitle(key) {
    return { members: "חברים", events: "אירועים", challenges: "אתגרים" }[key] || key;
  }
  function searchMemberRowHtml(person) {
    return `<div class="log-row"><div class="flex gap-10" style="align-items:center;">${avatarHtml(person.display_name || person.handle, 32, person.avatar_url)}<div style="min-width:0;"><div class="member-name" style="font-weight:700;">${nameHtml(person.display_name, person.handle)}${isCoachRole(memberRole(person.id)) ? " " + coachBadgeHtml(memberRole(person.id)) : ""}</div><div style="color:var(--steel);font-size:12px;"><bdi>@${esc(person.handle)}</bdi> ${bidiText(person.bio || "")}</div></div></div><div class="chip-row" style="margin-top:0;"><button class="chip-btn" data-community-action="view-profile" data-id="${esc(person.id)}">פרופיל</button>${person.allow_follows === false ? "" : followButtonHtml(person.id)}<button class="chip-btn" data-community-action="block" data-id="${esc(person.id)}">חסימה</button></div></div>`;
  }
  function searchEventRowHtml(ev) {
    // No event detail surface exists yet (COMM-213 builds it), so the row
    // records the view and says what it knows. It does not pretend to
    // navigate somewhere that is not built.
    const when = ev.start_at ? String(ev.start_at).slice(0, 16).replace("T", " ") : "";
    const meta = [when, ev.status === "draft" ? "טיוטה" : ev.status === "cancelled" ? "בוטל" : ""].filter(Boolean);
    return `<div class="log-row" data-search-event-id="${esc(ev.id)}"><div><div style="font-weight:700;">📅 ${bidiText(ev.title || "אירוע")}</div>${meta.length ? `<div style="color:var(--steel);font-size:12px;">${meta.map(bidiText).join(" · ")}</div>` : ""}</div><div class="chip-row" style="margin-top:0;"><button class="chip-btn" data-community-action="open-event" data-id="${esc(ev.id)}" data-source="search">פרטים</button></div></div>`;
  }
  function searchChallengeRowHtml(c) {
    const meta = [challengeTypeDef(c.challenge_type).label, challengeStatusLabel(c), c.end_at ? `עד ${formatChallengeDate(c.end_at)}` : ""].filter(Boolean);
    return `<div class="log-row" data-search-challenge-id="${esc(c.id)}"><div><div style="font-weight:700;">${esc(challengeTypeDef(c.challenge_type).icon)} ${bidiText(c.title || "אתגר")}</div><div style="color:var(--steel);font-size:12px;">${meta.map(bidiText).join(" · ")}</div></div><div class="chip-row" style="margin-top:0;"><button class="chip-btn" data-community-action="open-challenge" data-id="${esc(c.id)}" data-source="search">פרטים</button></div></div>`;
  }
  function renderCommunitySearch() {
    const box = `<div class="search-box"><input id="communityPeopleSearch" placeholder="חיפוש חברים, אירועים ואתגרים" aria-label="חיפוש בקהילה" value="${esc(state.search.query || "")}"/></div>`;
    let body;
    if (sanitizeSearchQuery(state.search.query).length < SEARCH_MIN_CHARS) {
      // Under the threshold there is nothing to show and nothing was asked
      // of the server - not an error, and not an empty-results claim.
      body = `<div class="footer-note" style="margin:6px 0 0;">הקלידו לפחות ${SEARCH_MIN_CHARS} תווים</div>`;
    } else if (state.search.loading) {
      body = `<div class="empty" role="status" style="padding:8px 0;">מחפש...</div>`;
    } else {
      body = searchGroupHtml("members", state.members.people.map(searchMemberRowHtml).join(""))
        + searchGroupHtml("events", state.search.events.map(searchEventRowHtml).join(""))
        + searchGroupHtml("challenges", state.search.challenges.map(searchChallengeRowHtml).join(""));
    }
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--steel)", "חיפוש בקהילה")}${box}${body}</div>`;
  }

  // ---- Trained-with-you-today card in the feed top area (COMM-307) -----------
  // The client half of COMM-307, closing COMM-P05. The schema half shipped as
  // 202608310005; read its header and contracts.md's
  // "attendance_classmates_today(p_limit int default 6)" entry before changing
  // anything here, because three of the decisions below are only correct
  // because of what that function already guarantees.
  //
  // WHAT THIS CARD SAYS, and nothing more: these members logged a session on
  // the same day you did. No count, no streak, no time of day, no "trained 2
  // hours ago" - attendance_log records a day, not a time, and the function
  // deliberately returns four keys and no fifth. Anything more would be the
  // client inventing a claim the data does not make.
  //
  // THE OMISSION IS THE WHOLE DESIGN. An empty result renders NOTHING - no
  // heading, no empty state, no retry - which is COMM-232's "on no signal,
  // show nothing" precedent adopted by name in COMM-307's acceptance criteria.
  // The server returns an empty set in three indistinguishable cases: the
  // caller did not train today, the caller trained but nobody else did, and
  // the caller's own show_attendance is off (a direct profiles column read
  // inside the function - it is a reciprocity rule, and it is enforced there
  // rather than here because every boundary in this module is server-side).
  // Nothing in this file tries to tell those three apart. It cannot, by
  // design, and the card would look identical if it could.
  //
  // NO CLIENT-SIDE "TODAY". `current_date` is the server's UTC day, the same
  // day attendance_log's trigger compares against when it writes the row this
  // card reads. A client-side date check for "did I train today" would drift
  // from that by up to a timezone and gate the card on a different day than
  // the one that produced it, so there is no date arithmetic here at all: the
  // client calls, and renders what comes back.
  //
  // NO "MESSAGE" AFFORDANCE, per the phase's standing no-messaging
  // resolution. Direct messaging was removed from scope entirely; there is no
  // Message button anywhere in this file and this card does not add the first.
  //
  // LIMIT. 6, the function's own default, passed explicitly rather than
  // relied on: the clamp range (1..20) is the server's and is fixed, but
  // 202608310005 records that "the default inside it is the client half's to
  // revisit", so the number the card actually wants lives here, at the card.
  // Six is two rows of three or six list rows - a card in COMM-115's feed top
  // area, where people_suggestions' 10 is a horizontally scrolling strip.
  const CLASSMATES_TODAY_LIMIT = 6;
  // COMM-307. One classmates_card_viewed per feed-session load of this card,
  // never one per re-render - the same shape as lastClubTabView above. A
  // cheer, a comment arriving over realtime or a photo URL resolving all
  // re-render the feed, and none of them is a second view of this card.
  // Cleared when a fresh load starts (a new session, or a scope change that
  // re-enters the feed), so the next real render counts again.
  let classmatesCardViewLogged = false;
  async function loadClassmatesToday() {
    // Same anonymous-signup-session guard as pingActivity():
    // attendance_classmates_today() raises 'not authorized' for a session
    // with no profile row, which the signup screens were hitting.
    if (!client || !state.user || !state.profile) return;
    const s = state.members.classmatesToday;
    s.loading = true; s.error = false;
    classmatesCardViewLogged = false;
    rerender();
    const { data, error } = await client.rpc("attendance_classmates_today", { p_limit: CLASSMATES_TODAY_LIMIT });
    s.loading = false; s.loaded = true;
    // Silently omitted on a failed fetch, the same choice people_suggestions
    // makes for its own strip: a secondary surface that failed is worse than
    // a surface that is not there, and a retry button on a card most members
    // will never see is a permanent fixture built out of an error path.
    if (error) { s.error = true; s.items = []; return rerender(); }
    // Rendered in the order returned. attendance_classmates_today() orders by
    // recorded_at desc then display name then id - a total order, so the cut
    // at p_limit is the server's and re-sorting here would throw away the one
    // ordering decision the function actually made.
    s.items = (Array.isArray(data) ? data : []).filter(Boolean);
    rerender();
  }
  // THE SAME CARD, DRAWN AS A STRIP, at the top of the feed instead of a few
  // cards down the rail. This is now the only renderer of it -
  // renderClassmatesTodayCard(), the stacked-log-list form, is gone rather
  // than left beside this one unreferenced. Every word about privacy above this function still
  // applies unchanged and is the reason this is safe to move: the rows come
  // from attendance_classmates_today(), which enforces the reciprocity rule
  // (the caller's own show_attendance) and each member's own visibility
  // server-side, blockFilteredList() drops the block edges, and an empty
  // answer - which is what most of the club gets, because show_attendance
  // defaults to false - still renders NOTHING AT ALL. Moving where a card is
  // drawn does not move where its boundary is enforced, and this branch adds
  // no new read.
  //
  // WHY A STRIP. In the rail it competed for one of two slots above the feed
  // against the pinned note and today's programming, and lost to both often
  // enough that the post-class moment it exists for usually arrived below
  // them. A horizontal row of faces costs about a quarter of the height the
  // stacked log-list did, so it fits above the feed without taking a slot
  // from anything.
  //
  // data-classmates-today="ready" moves WITH it, unchanged, because
  // noteClassmatesCardView() finds the card by that attribute - it is how
  // cloud.js learns the card is on screen rather than merely fetched, and
  // the strip must count as the same view the card did, not as a second one.
  function renderClassmatesTodayStrip() {
    const s = blockFilteredList(state.members.classmatesToday);
    // THE THREE NO-CARD BRANCHES, inherited unchanged from the card and
    // written out for the same reason they were written out there.
    //
    // A FAILED FETCH is belt-and-braces and says so: loadClassmatesToday()
    // already empties items on an error, so the `!s.items.length` check
    // below would catch it anyway. It stays because "error omits the card"
    // is one of COMM-307's four named frontend states, and a state that is
    // only satisfied as a side effect of another branch is one refactor away
    // from becoming a retry button.
    if (s.error) return "";
    // LOADING RENDERS NOTHING, and so does an answer with no rows. There is
    // deliberately no skeleton: show_attendance defaults to FALSE, so out of
    // the box this is empty for every member of the club, which makes
    // "usually nothing" the common case and not the edge one - a placeholder
    // would then be the thing most members see, a grey box that appears on
    // every visit to the Feed sub-tab and vanishes. The pattern this slot has
    // is the upcoming-event card's: show nothing until there is something. A
    // reload with rows already on screen keeps them (the condition is
    // `!s.items.length`), the same way the leaderboard holds its previous
    // rows under a refresh.
    if (!s.items.length) return "";
    // THE FOLLOW CONTROL SURVIVES THE MOVE, and it is the same
    // followButtonHtml() the card rendered.
    //
    // IT IS ALWAYS RENDERED, which is where this differs from
    // memberRowHtml()/followListRowHtml() - both of those write
    // `allow_follows === false ? "" : button`. Those two read profiles
    // directly and get the column; attendance_classmates_today() returns
    // four keys and allow_follows is not one of them, on purpose -
    // contracts.md: "this is not a follow strip, it is 'who trained today',
    // and hiding a classmate who simply does not want followers would be
    // wrong." Copying the guard here would compare undefined to false, never
    // hide anything, and read as if it were doing something. So the control
    // is shown for everyone and a refusal is the SERVER'S to make:
    // follows_insert_self (202608280003) enforces allow_follows on the
    // insert, and follow() already turns a rejected write into the same
    // "עדכון המעקב נכשל" message every other follow button produces. No new
    // follow mechanism, no new error path, and no pre-filter that would leak
    // another member's setting into the strip.
    //
    // It is .classmate-chip-follow only for size; the
    // element, the action, the data-id and the follow() path behind it are
    // untouched. Dropping it here would have been the quiet kind of
    // regression this move is not: the strip is a new layout for the card,
    // not a smaller feature.
    //
    // The chip is a <button> and the follow control is a second <button>, so
    // they are siblings inside the cell rather than nested - a button inside
    // a button is invalid HTML and only one of the two would ever be
    // clickable.
    const faces = s.items.map((item) => {
      const name = item.display_name || (item.handle ? "@" + item.handle : "חבר/ה");
      return `<div class="classmate-cell" data-classmate-user="${esc(item.user_id)}">
        <button class="classmate-chip" data-community-action="view-profile" data-id="${esc(item.user_id)}">
          ${avatarHtml(name, 44, item.avatar_url)}
          <span class="classmate-chip-name">${esc(name)}</span>
          ${/* THE HANDLE IS NOT DROPPED, only unprinted. The card printed it
                under the name and a 62px cell cannot, but the handle is what
                tells two members with the same display name apart - so it
                stays in the accessible name, where a screen reader reads it
                and where the sighted reader gets it on the profile one tap
                away. .sr-only is index.html's existing utility; this adds no
                rule of its own. */""}
          ${item.handle ? `<span class="sr-only"><bdi>@${esc(item.handle)}</bdi></span>` : ""}
        </button>
        <span class="classmate-chip-follow">${followButtonHtml(item.user_id)}</span>
      </div>`;
    }).join("");
    return `<div class="classmates-strip" data-classmates-today="ready">
      <h3 class="field-label" style="margin:0 0 6px;">💪 התאמנו היום</h3>
      <div class="classmates-strip-row">${faces}</div>
    </div>`;
  }
  // COMM-307's analytics, called from afterRenderCommunity() for the same
  // reason noteClubTabView() is: that hook is the only place cloud.js learns
  // the card is actually on screen, rather than merely fetched. It is
  // recorded once per load of the card (the guard above), it carries the row
  // count and the surface and nothing member-identifying, and it does NOT
  // count for WCAM - see ACTIVE_MEMBER_EVENTS in src/analytics.js and the
  // reasoning leaderboard_viewed already uses: viewing is not participation.
  function noteClassmatesCardView() {
    if (classmatesCardViewLogged) return;
    if (!state.user || !state.profile) return;
    if (!document.querySelector('[data-classmates-today="ready"]')) return;
    classmatesCardViewLogged = true;
    track(A.CLASSMATES_CARD_VIEWED, { rows: state.members.classmatesToday.items.length, source: "feed" });
  }

  // ---- Member profile community section (COMM-180) --------------------
  async function viewCommunityProfile(userId) {
    if (!userId) return;
    state.posts.openMenu = null;
    // COMM-170. Counted on the open, not on the RPC answering: a member who
    // opened a profile that then failed to load still opened it. The
    // overlay is torn down and rebuilt on each open, so a re-render of an
    // already-open profile does not reach this line.
    track(A.PROFILE_OPENED, { user_id: userId, self: userId === (state.user && state.user.id) });
    // COMM-230. followLists holds the follower/following expand state for
    // this open profile: one entry per side, each independently
    // collapsed/loaded/erroring. Reset on every open, same as the rest of
    // profileView, so a stale expanded list from a previously viewed member
    // never bleeds into the next one.
    state.members.profileView = {
      userId, loading: true, tab: "overview", data: null, error: false,
      followLists: {
        followers: { open: false, loading: false, loaded: false, error: false, items: [] },
        // actionError is separate from error: error means the list itself
        // failed to load (the whole section falls back to the error state);
        // actionError means the list loaded fine but the last unfollow tap
        // failed, in which case the restored row stays visible and only a
        // banner is added above it - tapping "הפסקת מעקב" again is the retry.
        following: { open: false, loading: false, loaded: false, error: false, actionError: false, items: [] },
      },
    };
    rerender();
    const { data, error } = await client.rpc("community_profile", { user_id: userId });
    if (!state.members.profileView || state.members.profileView.userId !== userId) return;
    state.members.profileView.loading = false;
    if (error || !data) state.members.profileView.error = true;
    else {
      state.members.profileView.data = data;
      // COMM-160. community_profile already returns the server role; seed the
      // shared cache so the same badge shows here and on any surface opened
      // next, and resolve the roles of the authors on the Posts tab.
      if (data.role != null) state.members.roles[userId] = data.role;
      loadMemberRoles((Array.isArray(data.posts) ? data.posts : []).map((p) => p && p.author_id)).then(() => rerender());
    }
    rerender();
  }
  function closeCommunityProfile() { state.members.profileView = null; rerender(); }
  function setProfileViewTab(tab) { if (state.members.profileView) { state.members.profileView.tab = tab; rerender(); } }
  const PROFILE_ROLE_LABELS = { owner: "בעלים", admin: "מנהל/ת", staff: "צוות", head_coach: "מאמן/ת ראשי/ת", coach: "מאמן/ת", member: "חבר/ה" };
  // "חבר/ה · חבר/ה מאז 15.9.2026" - the word twice, back to back.
  //
  // Live bug hunt, fresh round 2 (2026-09-15). The role label and the "member
  // since" phrase were concatenated blind, and for the `member` role they are
  // the SAME WORD: PROFILE_ROLE_LABELS.member is "חבר/ה" and the trailing
  // phrase hardcodes "חבר/ה מאז". It reads correctly only for coach, admin
  // and staff, where the role label happens to differ from the generic noun.
  //
  // So this was wrong on the most prominent line of EVERY ordinary member's
  // profile - which will be almost every profile in this club - and had been
  // since the surface shipped. The existing profile test asserts the "member
  // since" phrase appears somewhere in the text and never looked at what sat
  // immediately before it.
  //
  // For a plain member the role adds nothing the next phrase does not already
  // say, so it is dropped rather than de-duplicated with punctuation.
  function profileRoleAndSince(roleLabel, memberSince) {
    const since = memberSince ? `חבר/ה מאז ${esc(shortHebDate(memberSince))}` : "";
    const role = roleLabel && roleLabel !== PROFILE_ROLE_LABELS.member ? esc(roleLabel) : "";
    if (role && since) return `${role} · ${since}`;
    return role || since || esc(roleLabel || "");
  }

  // ==========================================================================
  // COMM-230 - following surface (follower/following lists on a profile)
  // ==========================================================================
  // The counts (follower_count/following_count) already come back from
  // community_profile, gated by the same visible_to_club check the RPC
  // applies to every other optional key - present on the caller's own
  // profile, present on another member's only when it passes, absent
  // otherwise, in which case this section renders nothing at all.
  //
  // The actual list of who is on each side is a *different* read: a direct
  // RLS select on `follows`, per the ticket's own contract (no new RPC).
  // follows_visible (202608260001) is `follower_id = auth.uid() or
  // followed_id = auth.uid()` - it returns a row only when the caller is one
  // of its two ends. For the caller's own profile that is exactly the two
  // queries below (my followers = followed_id = me, who I follow =
  // follower_id = me), so the list is complete and correct. For another
  // member's profile it is not: RLS would silently narrow "their followers"
  // down to "the one row that happens to also be me", which is not their
  // follower list, it is a coin flip that looks like one. Rather than render
  // a list that is quietly wrong, EXPAND is only offered on the caller's own
  // profile; another member's profile keeps the plain count it already had
  // pre-COMM-230. This is a deliberate scope call, not a partial
  // implementation - enumerating a third party's real follower list would
  // need a new definer RPC, which is out of this ticket's stated scope.
  const FOLLOW_LIST_ERROR_TEXT = "לא ניתן היה לעדכן את המעקב. נסו שוב.";
  const FOLLOW_LIST_EMPTY_TEXT = { followers: "עדיין אין עוקבים", following: "עדיין לא עוקבים אחרי אף אחד." };
  function followListCanExpand(pv) { return !!(pv && state.user && pv.userId === state.user.id); }
  async function loadFollowList(pv, side) {
    const st = pv.followLists[side];
    st.loading = true; st.error = false;
    rerender();
    const matchCol = side === "followers" ? "followed_id" : "follower_id";
    const idCol = side === "followers" ? "follower_id" : "followed_id";
    const { data, error } = await client.from("follows").select(idCol + ",created_at").eq(matchCol, pv.userId).order("created_at", { ascending: false });
    if (state.members.profileView !== pv) return; // the profile closed or moved on while this was in flight
    st.loading = false;
    if (error) { st.error = true; st.items = []; rerender(); return; }
    const ids = (Array.isArray(data) ? data : []).map((r) => r[idCol]).filter(Boolean);
    if (!ids.length) { st.items = []; st.loaded = true; rerender(); return; }
    const { map: byId, error: perr } = await loadProfilesById(ids, "allow_follows");
    if (state.members.profileView !== pv) return;
    if (perr) { st.error = true; st.items = []; rerender(); return; }
    // Preserve the follows-table order (most recent edge first); a member
    // hidden from this caller by RLS (blocked, or - not applicable to self,
    // but kept for symmetry - visible_to_club) simply drops out rather than
    // rendering a blank row.
    st.items = ids.map((id) => byId[id]).filter(Boolean);
    st.loaded = true;
    rerender();
    loadMemberRoles(st.items.map((m) => m.id)).then(() => rerender());
  }
  function toggleFollowListSection(side) {
    const pv = state.members.profileView;
    if (!followListCanExpand(pv) || (side !== "followers" && side !== "following")) return;
    const st = pv.followLists[side];
    st.open = !st.open;
    if (st.open && !st.loaded && !st.loading) loadFollowList(pv, side);
    rerender();
  }
  function retryFollowList(side) {
    const pv = state.members.profileView;
    if (!followListCanExpand(pv) || (side !== "followers" && side !== "following")) return;
    loadFollowList(pv, side);
  }
  // The "following" list is the one place a plain tap really does remove a
  // row: everyone in it is, by definition, someone the caller already
  // follows, so this always means unfollow, and it is a real unfollow -
  // follow() itself decides insert vs. delete. No confirmation dialog per
  // the ticket (low-stakes, reversible). Optimistic: the row disappears
  // immediately and is put back with the shared error copy if the write
  // failed - never a silent drop.
  async function unfollowFromFollowingList(userId) {
    const pv = state.members.profileView;
    if (!pv || !userId) return;
    const st = pv.followLists.following;
    const idx = st.items.findIndex((m) => m && m.id === userId);
    if (idx < 0) return;
    const removed = st.items[idx];
    st.items = st.items.slice(0, idx).concat(st.items.slice(idx + 1));
    // The COUNT beside the list is part of the list. Live bug hunt, fresh
    // round 7 (2026-09-15): following_count came from the one-shot
    // viewCommunityProfile() payload and nothing updated it here, so the row
    // vanished while the label above it still read the old number - "(2)"
    // over a single row. Adjusted optimistically and restored below on the
    // same failure path the row itself uses, so the two never disagree.
    if (pv.data && typeof pv.data.following_count === "number") pv.data.following_count = Math.max(0, pv.data.following_count - 1);
    st.actionError = false;
    rerender();
    const result = await follow(userId); // same single toggle every follow control uses
    if (state.members.profileView !== pv) return;
    if (result && result.error) {
      // Put the row back exactly where it was and say so - the list itself
      // is fine (st.error stays false), only this one tap failed, so tapping
      // "הפסקת מעקב" again on the restored row is the retry: no separate
      // control needed.
      st.items = st.items.slice(0, idx).concat([removed], st.items.slice(idx));
      if (pv.data && typeof pv.data.following_count === "number") pv.data.following_count += 1;
      st.actionError = true;
    } else {
      st.actionError = false;
    }
    rerender();
  }
  function followListSkeletonHtml() {
    const row = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:52%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
    return `<div class="log-list" aria-busy="true" data-follow-list-skeleton="1">${row.repeat(3)}</div>`;
  }
  function followListRowHtml(m, side) {
    const name = m.display_name || (m.handle ? "@" + m.handle : "חבר/ה");
    const badge = isCoachRole(memberRole(m.id)) ? " " + coachBadgeHtml(memberRole(m.id)) : "";
    const actionBtn = side === "following"
      ? `<button class="chip-btn" data-community-action="following-unfollow" data-id="${esc(m.id)}">הפסקת מעקב</button>`
      : (m.allow_follows === false ? "" : followButtonHtml(m.id));
    // THE HANDLE, because two members can share a display name. Live bug hunt,
    // fresh round 7 (2026-09-15): a search row and a suggestion card both show
    // "@handle" beside the name; this row showed the bare name only. With two
    // members called נועם - ordinary in a thirty-person club - there was no
    // way to tell from this list which one you were about to unfollow.
    // Suppressed when the name IS the handle fallback, so it cannot read
    // "@ritz @ritz".
    const handleLine = (m.handle && m.display_name)
      ? `<span style="color:var(--steel);font-size:12px;"><bdi>@${esc(m.handle)}</bdi></span>`
      : "";
    return `<div class="log-row"><button class="link-btn" data-community-action="view-profile" data-id="${esc(m.id)}" style="padding:0;display:flex;gap:10px;align-items:center;color:inherit;text-align:right;min-width:0;">${avatarHtml(name, 32, m.avatar_url)}<span style="min-width:0;"><span class="member-name" style="font-weight:700;">${esc(name)}${badge}</span>${handleLine ? `<br>${handleLine}` : ""}</span></button><div class="chip-row" style="margin-top:0;">${actionBtn}</div></div>`;
  }
  function followListSectionHtml(pv, side, label, count) {
    if (count == null) return "";
    if (!followListCanExpand(pv)) {
      return `<div class="log-row"><span>${esc(label)}</span><span class="mono" style="color:var(--brass);">${Number(count) || 0}</span></div>`;
    }
    const st = pv.followLists[side];
    const toggleBtn = `<button class="chip-btn" data-community-action="following-toggle" data-side="${side}" aria-expanded="${st.open ? "true" : "false"}">${esc(label)} (${Number(count) || 0})${st.open ? " ▲" : " ▼"}</button>`;
    if (!st.open) return `<div style="margin-bottom:8px;">${toggleBtn}</div>`;
    let body;
    if (st.loading && !st.loaded) body = followListSkeletonHtml();
    else if (st.error) {
      body = `<div class="empty" role="alert" data-follow-list-error="${side}">${FOLLOW_LIST_ERROR_TEXT}<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="following-retry" data-side="${side}">ניסיון חוזר</button></div></div>`;
    } else if (!st.items.length) {
      body = `<div class="empty" data-follow-list-empty="${side}">${FOLLOW_LIST_EMPTY_TEXT[side]}</div>`;
    } else {
      // A failed unfollow (following side only) keeps the list on screen
      // and restores the row - the banner is additive, never a replacement.
      const actionBanner = (side === "following" && st.actionError)
        ? `<div class="empty" role="alert" data-follow-list-action-error="1">${FOLLOW_LIST_ERROR_TEXT}</div>` : "";
      body = actionBanner + `<div class="log-list">${st.items.map((m) => followListRowHtml(m, side)).join("")}</div>`;
    }
    return `<div style="margin-bottom:14px;">${toggleBtn}<div style="margin-top:8px;">${body}</div></div>`;
  }
  // The whole "Following" tab. Absent entirely (no tab shown at all) when
  // neither count came back from community_profile - the same "an absent
  // key means the field is hidden" rule every other optional section here
  // already follows.
  function followingTabAvailable(d) { return d.follower_count != null || d.following_count != null; }
  function renderFollowingTab(pv, d) {
    return followListSectionHtml(pv, "followers", "עוקבים", d.follower_count)
      + followListSectionHtml(pv, "following", "עוקב/ת אחרי", d.following_count);
  }
  function renderCommunityProfileOverlay() {
    const pv = state.members.profileView;
    if (!pv) return "";
    const d = pv.data || {};
    // "@handle" NEEDS nameHtml(). Live bug hunt, fresh round 7 (2026-09-15):
    // this header built the same handle fallback nameHtml() builds, then
    // rendered it with a bare esc() - so in this RTL document the "@" was
    // painted to the RIGHT of the handle and a member with no display name
    // saw their own title as "noam-cohen@". nameHtml() exists precisely to
    // wrap that fallback in <bdi>, and the identical member rendered
    // correctly in a search row, which does use it.
    const name = [d.first_name, d.last_name].filter(Boolean).join(" ") || d.display_name || (d.handle ? "@" + d.handle : "חבר/ה");
    const roleLabel = PROFILE_ROLE_LABELS[d.role] || (d.role ? esc(d.role) : "");
    const profileTabs = [
      { id: "overview", label: "סקירה" },
      { id: "progress", label: "התקדמות" },
      { id: "achievements", label: "הישגים" },
      { id: "posts", label: "פוסטים" },
    ];
    // COMM-230. Present only when community_profile actually returned at
    // least one of the two counts - the caller's own profile always has it,
    // another member's only when their visible_to_club passes, matching the
    // gating community_profile already applies to these two keys.
    if (followingTabAvailable(d)) profileTabs.push({ id: "following", label: "עוקבים" });
    const active = pv.tab || "overview";
    let bodyHtml;
    if (pv.loading) bodyHtml = `<div class="empty">טוען פרופיל…</div>`;
    else if (pv.error) bodyHtml = `<div class="empty">לא ניתן לטעון את הפרופיל.</div>`;
    else if (active === "overview") {
      const rows = [];
      if (d.training_frequency != null) rows.push(["תדירות אימונים", d.training_frequency]);
      if (d.current_streak != null) rows.push(["רצף נוכחי", "🔥 " + d.current_streak]);
      if (d.active_challenge) rows.push(["אתגר פעיל", d.active_challenge.title || d.active_challenge]);
      if (d.recent_achievement) rows.push(["הישג אחרון", d.recent_achievement.title || d.recent_achievement]);
      const recent = Array.isArray(d.recent_workouts) ? d.recent_workouts : [];
      const rowsHtml = rows.length ? `<div class="log-list">${rows.map(([k, v]) => `<div class="log-row"><span>${esc(k)}</span><span class="mono" style="color:var(--brass);">${esc(v)}</span></div>`).join("")}</div>` : "";
      const recentHtml = recent.length ? `<div class="log-list" style="margin-top:8px;">${recent.map((w) => `<div class="log-row"><span>${bidiText(w.title || w.name || "")}</span><span style="color:var(--steel);font-size:12px;">${esc(String(w.date || w.occurred_on || "").slice(0, 10))}</span></div>`).join("")}</div>` : "";
      bodyHtml = (rowsHtml + recentHtml) || `<div class="empty">אין מידע להצגה</div>`;
    } else if (active === "progress") {
      const prs = Array.isArray(d.prs) ? d.prs : null;
      bodyHtml = prs == null ? `<div class="empty">ההתקדמות מוסתרת</div>`
        : prs.length ? `<div class="log-list">${prs.map((x) => `<div class="log-row"><span>${esc(x.movement || x.title || "")}</span><span class="mono" style="color:var(--brass);">${esc(x.result || x.value || "")}</span></div>`).join("")}</div>`
        : `<div class="empty">אין עדיין שיאים</div>`;
    } else if (active === "achievements") {
      const ach = Array.isArray(d.achievements) ? d.achievements : null;
      bodyHtml = ach == null ? `<div class="empty">ההישגים מוסתרים</div>`
        : ach.length ? `<div class="badge-grid">${ach.map((a) => `<div class="chart-card" style="flex:0 0 auto;padding:8px 10px;">${esc(a.badge_icon || "🏅")} ${esc(a.title || "")}</div>`).join("")}</div>`
        : `<div class="empty">אין עדיין הישגים</div>`;
    } else if (active === "posts") {
      const posts = Array.isArray(d.posts) ? d.posts : [];
      bodyHtml = posts.length ? `<div class="log-list">${posts.map((pp) => renderPostCard(pp)).join("")}</div>` : `<div class="empty">אין עדיין פוסטים</div>`;
    } else {
      // COMM-230's "following" tab, only reachable when followingTabAvailable(d)
      // pushed it above.
      bodyHtml = renderFollowingTab(pv, d);
    }
    // Never on your OWN profile. Live bug hunt, fresh round 2 (2026-09-15):
    // tapping your own byline on your own post opened your profile with a
    // working "מעקב" button on it. The insert is refused by the database
    // (follows carries `check (follower_id <> followed_id)`), but follow()
    // only special-cases 23505 (already following, which it turns into an
    // unfollow) - a check violation is a different code, so it fell through
    // to the generic "עדכון המעקב נכשל" and dead-ended.
    //
    // The sibling reportProfileBtn two lines down already carries exactly
    // this self-check, which is what makes it an oversight rather than a
    // decision. It surfaced now because reaching your own profile this way is
    // the one route available to a member alone in an empty club - and
    // tapping your own byline right after your first post is precisely what
    // a curious first member does.
    const isSelfProfile = !!(state.user && pv.userId === state.user.id);
    const followBtn = (isSelfProfile || d.allow_follows === false) ? "" : followButtonHtml(pv.userId);
    // 2026-09-05. A member's bio/display name were reportable nowhere - only
    // posts and comments were. Own profile has no report button.
    const reportProfileBtn = (state.user && pv.userId === state.user.id) ? "" : `<button class="chip-btn" data-community-action="report-profile" data-id="${esc(pv.userId)}">דיווח</button>`;
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="profileViewTitle" data-cloud-dialog="profileView" style="align-items:center;padding:20px 12px;">
      <div class="modal-sheet" style="border-radius:20px;max-height:88vh;overflow:auto;width:100%;max-width:520px;">
        <div style="padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 16px);">
          <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div class="flex gap-10" style="align-items:center;min-width:0;">
              ${avatarHtml(name, 44, d.avatar_url)}
              <div style="min-width:0;">
                <h2 id="profileViewTitle" class="member-name" style="margin-top:0;font-weight:800;font-size:16px;margin-bottom:0;">${(!d.first_name && !d.last_name && !d.display_name) ? nameHtml(null, d.handle) : esc(name)}${isCoachRole(d.role) ? " " + coachBadgeHtml(d.role) : ""}</h2>
                <div style="color:var(--steel);font-size:12px;">${profileRoleAndSince(roleLabel, d.member_since)}</div>
              </div>
            </div>
            <button class="link-btn" data-community-action="close-profile" aria-label="סגירה">סגירה</button>
          </div>
          <div class="chip-row" style="margin-top:0;">${followBtn}${reportProfileBtn}</div>
          <div class="subtabbar" style="margin-top:12px;">${profileTabs.map((t) => `<button class="subtabbtn${t.id === active ? " active" : ""}" data-community-action="profile-tab" data-tab="${t.id}">${t.label}</button>`).join("")}</div>
          <div style="margin-top:12px;">${bodyHtml}</div>
        </div>
      </div>
    </div>`;
  }
