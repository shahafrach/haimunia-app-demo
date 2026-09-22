"use strict";
// ---- Community: the feed (COMM-110..115) ----------------------------------
//
// Cursor pagination over feed_page(), the two scopes, the impression and
// interaction telemetry behind them, the IntersectionObservers that produce
// it, and pinning — which is an admin action but a feed property, and reads
// as one here.
//
// Moved out of cloud.js unchanged — every line byte-identical to what it was
// there. Classic <script>, no IIFE, loaded before cloud.js; see
// src/community/events.js's header for why each of those matters.
//
// RANKING IS NOT HERE, and that is the design. feed_page() ranks and
// diversifies server-side; this module sends a cursor and renders what comes
// back in the order it comes back. A sort in this file would be a second
// ranking rule competing with the first.
//
// NEITHER IS THE ORDER, since 202609220003. The club's feed is chronological
// by default - newest first, with pinned posts, coach posts and
// announcements and today's club WOD held above the stream - and an admin
// can switch it back to the ranked order from the modules panel. The setting
// is club_features.config -> feed -> order, it is read inside feed_page(),
// and nothing on this side knows or needs to know which order it is looking
// at: both arrive as one page of rows in the order they belong in.
//
// WHAT STAYED BEHIND, deliberately: ensureFeedRealtime, realtimePostId,
// onFeedCommentRealtime and onFeedReactionRealtime — part of the one Realtime
// block that also serves notifications and challenges.

  // ---- Pinned content (COMM-155) --------------------------------------
  // Read is open to every member; pin_set / pin_clear are the only write
  // paths and both check community.content.pin and write admin_actions in
  // one transaction. The cap of 3 is a slot column server-side, so a fourth
  // pin_set raises pin_limit_reached rather than silently succeeding.
  async function loadPins() {
    if (!state.user) { state.admin.pins = []; return; }
    const { data, error } = await client.from("pins")
      .select("id,target_type,target_id,slot,note,created_at")
      .order("slot", { ascending: true });
    state.admin.pins = error ? [] : (data || []);
    state.admin.pinsLoaded = !error;
  }
  // In-flight guard for pin/unpin - a fast double-click on either used to be
  // able to fire the RPC twice before the first response landed. Keyed by
  // action+target (not just target) so a pin and a following unpin on the
  // same target never see each other's flag.
  const pinBusy = {};
  async function pinTarget(targetType, targetId, note) {
    if (!state.user || !hasPerm(PERM.CONTENT_PIN)) return;
    const key = "pin:" + targetType + ":" + targetId;
    if (pinBusy[key]) return;
    pinBusy[key] = true;
    state.admin.pinError = "";
    const { error } = await client.rpc("pin_set", { p_target_type: targetType, p_target_id: targetId, p_note: String(note || "").slice(0, 200) });
    pinBusy[key] = false;
    if (error) {
      state.admin.pinError = (error.message || "") === "pin_limit_reached"
        ? "אפשר להצמיד עד שלושה פריטים. יש לבטל הצמדה קיימת קודם."
        : "לא ניתן היה לעדכן את ההצמדות.";
      // Live bug hunt (2026-09-11): state.admin.pinError only ever renders
      // inside renderPinnedStrip() (Feed tab's own club rail) - pinning is
      // reachable from post/challenge/event surfaces too, so hitting the
      // cap from any of THOSE looked like the tap did nothing at all unless
      // the member happened to also be on the Feed tab. setMessage() is
      // this app's global, viewport-anchored notice channel (see its own
      // comment above) and already carries the SUCCESS case just below -
      // the failure case belongs on the same channel, not a second,
      // narrower one only success uses consistently.
      setMessage(state.admin.pinError);
      return;
    }
    await loadPins();
    setMessage("הפריט הוצמד");
  }
  async function unpinTarget(targetType, targetId) {
    if (!state.user || !hasPerm(PERM.CONTENT_PIN)) return;
    const key = "unpin:" + targetType + ":" + targetId;
    if (pinBusy[key]) return;
    pinBusy[key] = true;
    state.admin.pinError = "";
    const { error } = await client.rpc("pin_clear", { p_target_type: targetType, p_target_id: targetId });
    pinBusy[key] = false;
    if (error) {
      state.admin.pinError = "לא ניתן היה לעדכן את ההצמדות.";
      setMessage(state.admin.pinError);
      return;
    }
    await loadPins();
    setMessage("ההצמדה בוטלה");
  }

  const FEED_PAGE_SIZE = 20;              // COMM-113: 20 first load, 20 per page
  const FEED_IMPRESSION_BATCH = 50;       // the server caps one call at 50 rows
  const FEED_IMPRESSION_DWELL_MS = 1000;  // COMM-114: half visible for one second
  // COMM-111. Order matters, the first entry is the default.
  const FEED_SCOPES = [
    { id: "for_you", label: "בשבילך", empty: "פעילות המועדון תופיע כאן." },
    { id: "following", label: "אחרי מי שאני עוקב/ת", empty: "אין עדיין פוסטים ממי שאתם עוקבים אחריו." },
    { id: "achievements", label: "הישגים", empty: "אין עדיין הישגים לשתף." },
    { id: "coach", label: "פוסטים מהמאמנים", empty: "אין עדיין פוסטים מהמאמנים." },
    // COMM-P01's "השיעורים שלי" chip is GONE from this list, by an explicit
    // product decision rather than as cleanup.
    //
    // It rendered disabled, labelled "בקרוב", on every load of the feed. What
    // it was waiting for is class attendance, and class scheduling and
    // attendance are Arbox's job, not this app's - so "soon" had no owner and
    // no date. A permanently disabled control is not honesty, it is a promise
    // the product has not made, taking real space on the one screen a member
    // opens most.
    //
    // THE SERVER SIDE IS DELIBERATELY LEFT ALONE. feed_ranked() still accepts
    // 'my_classes' as a known scope and still returns nothing for it, and its
    // tests still pin that. That is defence in depth, not dead code: a client
    // that has cached an old scope value - one already sitting in a member's
    // localStorage right now - must still get a valid empty answer rather than
    // an error. Removing the chip is a UI decision; the scope stays a word the
    // server understands until something is actually built behind it.
  ];
  function feedScopeDef(id) { return FEED_SCOPES.find((s) => s.id === id) || FEED_SCOPES[0]; }

  function newFeedId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    // jsdom and older WebViews. Only ever used as a correlation key.
    const hex = "0123456789abcdef";
    let out = "";
    for (let i = 0; i < 36; i++) out += (i === 8 || i === 13 || i === 18 || i === 23) ? "-" : hex[Math.floor(Math.random() * 16)];
    return out;
  }

  // A feed session is one continuous read of one scope: the first page plus
  // every "load more" after it. A new session starts on a scope change, a
  // refresh, or a sign-in - and the previous session's impressions are
  // flushed before the new id is minted, so a row can never be attributed to
  // the wrong session.
  function startFeedSession() {
    flushFeedImpressions();
    state.feed.sessionId = newFeedId();
    state.feed.seen = {};
  }

  // COMM-110/113. One page. The cursor is opaque: the client stores it and
  // hands it back, it never parses or derives one.
  async function fetchFeedPage() {
    // THE SCOPE THIS PAGE WAS ASKED FOR, remembered before the request goes
    // out. Live bug hunt, fresh round 9 (2026-09-16): rows were appended
    // unconditionally, with no check that the member was still looking at the
    // same filter. Boot fires a "for_you" load; tap "Following" before it
    // resolves and the slow first response lands afterwards, so a post from
    // someone the member does not follow appears under a Following chip that
    // is still shown as selected. loadMoreFeed() had the same hole.
    //
    // Every other loader in this file already guards this way - the challenge
    // board, the profile view and the event detail all check that the thing
    // they were loading for is still the thing on screen before applying a
    // response. The feed, the most-used surface of the lot, did not.
    const requestedScope = state.feed.scope;
    const { data, error } = await client.rpc("feed_page", {
      p_cursor: state.feed.cursor,
      p_limit: FEED_PAGE_SIZE,
      p_scope: state.feed.scope,
    });
    if (error) return false;
    // Moved on while this was in flight: drop it rather than mixing one
    // filter's rows into another's list.
    if (state.feed.scope !== requestedScope) return false;
    const rows = Array.isArray(data) ? data : (data ? [data] : []);
    // Appended in the order feed_page returned them. No sort, no filter, no
    // re-ordering of any kind on this side.
    for (const row of rows) state.feed.items.push(row);
    state.feed.pagesLoaded += 1;
    const next = rows.length ? rows[rows.length - 1].next_cursor : null;
    state.feed.cursor = next || null;
    state.feed.end = !next;
    for (const row of rows) {
      if (row && row.photo_path) resolvePhotoUrl(row.photo_path);
      for (const m of (row && row.media) || []) if (m && m.storage_path && !m.url) resolvePhotoUrl(m.storage_path);
    }
    // COMM-160. The post author coach badge reads the same cached server
    // role set the comments do. One lookup per page; a re-render follows
    // when it resolves so the badge is not gated on the feed round-trip.
    if (rows.length) loadMemberRoles(rows.map((r) => r && r.author_id)).then(() => rerender());
    // 202609220005 "התאמנו יחד". One post_training_partners_for() call per
    // page, alongside the role lookup and for the same reason: the tags are
    // not a column on feed_page's fixed `returns table (...)`, and adding one
    // would mean dropping and rebuilding the ranking function to carry a list
    // a single extra round trip fetches. Not awaited - a card renders without
    // its partners line and gains it when this resolves, the same way the
    // coach badge does.
    if (rows.length) loadTrainingPartners(rows.map((r) => r && r.id)).then(() => rerender());
    return true;
  }

  // Reloads the feed from the top as a fresh session. It restores however
  // many pages were already loaded, so a caller that just reacted or
  // commented deep in the list does not get collapsed back to twenty items.
  async function loadFeed() {
    if (!state.user) return;
    // COMM-321-style module gate (same reasoning as renderEventsListSection's
    // and renderChallengesListSection's own guards): loadFeed() sits
    // unconditionally in the boot Promise.all, so a club that has turned the
    // feed module off was still paying for the feed_page ranking RPC on
    // every single boot for no reason - nothing ever renders feedTab's
    // content in that state.
    if (!isModuleEnabled("feed")) { state.feed.items = []; state.feed.error = false; state.feed.loading = false; return; }
    // Same early-return shape, for the other state in which this RPC can only
    // ever be refused: a signed-in member who has not redeemed an invite yet is
    // not an is_community_member(), and feed_page is gated on exactly that.
    //
    // REPORTED FROM A REAL PHONE as "can't sign in". Sign-in had worked fine.
    // loadFeed ran, feed_page refused as designed, and the failure was written
    // into state.ui.message - which the INVITE-CODE gate renders at its own
    // foot. So the screen asking for an invite code carried a red "the
    // community cannot be loaded right now" underneath it: a broken-looking app
    // in the one moment the reader most needs to believe the next step will
    // work. Nothing was broken. The message was.
    //
    // Safe to key on state.redemption here: loadRedemption() is awaited in the
    // same Promise.all as loadProfile(), and ensureCommunityDataLoaded() will
    // not call this until state.profile exists - so by now a null redemption
    // means "not a member", never "not loaded yet".
    if (!state.redemption) { state.feed.items = []; state.feed.error = false; state.feed.loading = false; return; }
    const pages = Math.max(1, state.feed.pagesLoaded || 1);
    // Whatever the pill was counting is about to be IN the list, or was never
    // ours to show. Either way it is no longer news, so the count is cleared
    // by the read itself rather than only by the pill that triggered one -
    // every other caller of loadFeed (a scope change, a retry, a publish, a
    // block) is just as much a fresh read.
    clearIncomingPosts();
    // A fresh read of the feed is also the retry path for the per-card club
    // WOD board reads - see resetClubWodBoardAsks() for why those are not
    // retried on their own.
    resetClubWodBoardAsks();
    startFeedSession();
    state.ui.loading = true;
    state.feed.loading = true;
    state.feed.error = false;
    state.feed.moreError = false;
    state.feed.items = [];
    state.feed.cursor = null;
    state.feed.end = false;
    state.feed.pagesLoaded = 0;
    let ok = true;
    for (let i = 0; i < pages; i++) {
      ok = await fetchFeedPage();
      if (!ok || state.feed.end) break;
    }
    state.feed.error = !ok;
    state.ui.message = ok ? "" : "לא ניתן לטעון את הקהילה כרגע";
    state.feed.loading = false;
    state.ui.loading = false;
  }

  // COMM-113. The "load more" control and the intersection sentinel both
  // land here. Earlier items are kept on failure, per the ticket.
  async function loadMoreFeed() {
    if (!state.user || state.feed.loadingMore || state.feed.end || !state.feed.cursor) return;
    state.feed.loadingMore = true;
    state.feed.moreError = false;
    rerender();
    const ok = await fetchFeedPage();
    state.feed.moreError = !ok;
    state.feed.loadingMore = false;
    rerender();
  }

  // COMM-111. Switching a filter is a new feed session, not a re-filter of
  // what is already in memory: the ranking is per scope and only the server
  // knows it.
  function setFeedScope(scope) {
    const def = FEED_SCOPES.find((s) => s.id === scope);
    if (!def || def.parked || def.id === state.feed.scope) return;
    state.feed.scope = def.id;
    state.feed.pagesLoaded = 0;
    // COMM-170. A scope change is a new read of the feed, so it is a second
    // feed_viewed, distinguished from the tab entry by `source`. It is not
    // tracked in loadFeed(), which also runs after a reaction, a comment or
    // a block, none of which is a member viewing the feed.
    track(A.FEED_VIEWED, { scope: def.id, source: "scope_change" });
    loadFeed().then(rerender);
    rerender();
  }

  // COMM-115. Club name, mark, member count, the active challenge shortcut
  // and the unread notification count, in one call.
  async function loadClubSummary() {
    if (!state.user) return;
    const { data, error } = await client.rpc("club_summary");
    state.club.row = error ? null : (data || null);
  }

  // --- COMM-114 impressions and interactions --------------------------------
  // A card counts as seen once it has been at least half visible for a
  // second. Rows queue up and are written in one batched call per feed
  // session (or per 50 rows, which is the server's cap), never on the render
  // path - nothing here is awaited by anything that draws.
  function noteFeedImpression(postId, position) {
    if (!postId || !state.feed.sessionId) return;
    if (state.feed.seen[postId]) return;
    state.feed.seen[postId] = true;
    // COMM-170. The ranking pipeline reads feed_impressions (COMM-114);
    // the product metric reads analytics_events. Two tables, two consumers,
    // one trigger - and the state.feed.seen guard above is what makes both
    // of them exactly once per post per feed session.
    track(A.POST_IMPRESSION, { post_id: postId, position: Math.max(0, Number(position) || 0), feed_session_id: state.feed.sessionId });
    // The new_member_posts module's one event, and it rides this trigger on
    // purpose rather than getting its own. The module is a SERVER trigger
    // (post_new_member_on_join, 202609160004) that writes one card into
    // everybody's feed; the only thing a client can observe about it is
    // whether that card was ever actually seen, which is precisely what the
    // impression guard above already measures exactly once per post per feed
    // session. A second name and a second guard for the same moment would be
    // two counters that can disagree.
    //
    // post_impression carries only the post id, so it cannot answer "how many
    // of those impressions were welcome cards" without a join against
    // workout_posts - a table the analytics reader may not hold. This can.
    // No id, no member: the card is about a named newcomer and the count is
    // the whole question.
    const impressed = typeof findFeedPost === "function" ? findFeedPost(postId) : null;
    if (impressed && impressed.post_type === "POST_NEW_MEMBER") track(A.NEW_MEMBER_POST_VIEWED, { source: "feed" });
    state.feed.pending.push({
      post_id: postId,
      position: Math.max(0, Number(position) || 0),
      feed_session_id: state.feed.sessionId,
      shown_at: new Date().toISOString(),
    });
    if (state.feed.pending.length >= FEED_IMPRESSION_BATCH) flushFeedImpressions();
  }
  function flushFeedImpressions() {
    if (!client || !state.user || !state.feed.pending.length) return;
    const rows = state.feed.pending;
    state.feed.pending = [];
    for (let i = 0; i < rows.length; i += FEED_IMPRESSION_BATCH) {
      const chunk = rows.slice(i, i + FEED_IMPRESSION_BATCH);
      try { Promise.resolve(client.rpc("feed_record_impressions", { p_rows: chunk })).catch(() => {}); } catch (e) {}
    }
  }
  const FEED_INTERACTION_KINDS = ["open", "react", "comment", "share", "hide", "save", "profile_open"];
  // Fire and forget. A failed measurement must never surface as a failed
  // action, so nothing here is awaited and nothing here sets a message.
  function trackFeedInteraction(postId, kind) {
    if (!client || !state.user || !postId) return;
    if (FEED_INTERACTION_KINDS.indexOf(kind) < 0) return;
    // p_feed_session_id is required server-side (202609060010): the
    // interaction's opened/engaged back-stamp is scoped to the impression
    // row from THIS session, never to every impression that member has
    // ever had for the post.
    try { Promise.resolve(client.rpc("feed_record_interaction", { p_post_id: postId, p_kind: kind, p_feed_session_id: state.feed.sessionId })).catch(() => {}); } catch (e) {}
  }
  // Exposed so a later share affordance on a card (posts cluster) can record
  // the `share` kind without reaching into the feed's internals.
  window.trackFeedInteraction = trackFeedInteraction;

  // Which click on a card counts as which interaction. The post id is taken
  // from the enclosing card, so the same action name used outside the feed
  // (a profile opened from member search, say) records nothing.
  const FEED_ACTION_KINDS = {
    "cheer": "react",
    "toggle-comments": "open",
    "post-hide": "hide",
    "post-save": "save",
    "view-profile": "profile_open",
  };
  function trackFeedClick(el) {
    const kind = FEED_ACTION_KINDS[el && el.dataset && el.dataset.communityAction];
    if (!kind) return;
    const card = el.closest && el.closest("[data-post-id]");
    if (!card) return;
    trackFeedInteraction(card.getAttribute("data-post-id"), kind);
  }

  // The observer is rebuilt on every render because the card elements are
  // replaced wholesale by rerender(). Without IntersectionObserver (jsdom,
  // very old WebViews) a rendered card is counted after the same dwell,
  // which is the honest fallback: the environment cannot report visibility.
  let feedObserver = null;
  const feedDwellTimers = {};
  function observeFeedImpressions() {
    if (!state.user || !state.feed.sessionId) return;
    if (feedObserver) { try { feedObserver.disconnect(); } catch (e) {} feedObserver = null; }
    const cards = Array.prototype.slice.call(document.querySelectorAll("#communityFeedList [data-post-id]"));
    if (!cards.length) return;
    const positionOf = (el) => {
      const id = el.getAttribute("data-post-id");
      const idx = state.feed.items.findIndex((p) => p && String(p.id) === id);
      return idx < 0 ? 0 : idx;
    };
    if (typeof window.IntersectionObserver !== "function") {
      for (const el of cards) {
        const id = el.getAttribute("data-post-id");
        if (state.feed.seen[id] || feedDwellTimers[id]) continue;
        feedDwellTimers[id] = setTimeout(() => {
          delete feedDwellTimers[id];
          noteFeedImpression(id, positionOf(el));
        }, FEED_IMPRESSION_DWELL_MS);
      }
      return;
    }
    feedObserver = new window.IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = entry.target.getAttribute("data-post-id");
        if (!id) continue;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          if (state.feed.seen[id] || feedDwellTimers[id]) continue;
          feedDwellTimers[id] = setTimeout(() => {
            delete feedDwellTimers[id];
            noteFeedImpression(id, positionOf(entry.target));
          }, FEED_IMPRESSION_DWELL_MS);
        } else if (feedDwellTimers[id]) {
          clearTimeout(feedDwellTimers[id]);
          delete feedDwellTimers[id];
        }
      }
    }, { threshold: [0.5] });
    for (const el of cards) feedObserver.observe(el);
  }

  // COMM-113. The sentinel triggers the next page before the member reaches
  // the end of the list. The button under it is the same call, for anyone
  // without IntersectionObserver or reaching it by keyboard.
  let feedSentinelObserver = null;
  function observeFeedSentinel() {
    if (feedSentinelObserver) { try { feedSentinelObserver.disconnect(); } catch (e) {} feedSentinelObserver = null; }
    const sentinel = document.getElementById("communityFeedSentinel");
    if (!sentinel || typeof window.IntersectionObserver !== "function") return;
    feedSentinelObserver = new window.IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMoreFeed();
    }, { rootMargin: "200px" });
    feedSentinelObserver.observe(sentinel);
  }

  // COMM-155. The pinned strip at the very top of the Club home, above the
  // club top card. Up to three chips; staff with community.content.pin get
  // an unpin control on each.
  function pinTargetLabel(t) { return { announcement: "הודעה", challenge: "אתגר", event: "אירוע", post: "פוסט" }[t] || t; }
  // Real bug found by a role-coverage audit: the backend and pinTargetLabel()
  // both model four pinnable target types, but the only place that ever
  // rendered a "pin" (as opposed to "unpin") control was the announcements
  // list - a head_coach/admin wanting to pin a challenge, event or post to
  // club home had no button anywhere, only a raw window.eval escape hatch
  // (which is exactly how this file's own test suite exercised the "pin a
  // post" path, having no real button to click). isPinnedTarget() and
  // pinToggleHtml() are the one shared implementation every target-type
  // surface below now calls, instead of each screen re-deriving its own
  // (and, as happened here, three of the four forgetting to).
  function isPinnedTarget(type, id) { return state.admin.pins.some((p) => p.target_type === type && p.target_id === id); }
  function pinToggleHtml(type, id, note) {
    if (!hasPerm(PERM.CONTENT_PIN)) return "";
    const pinned = isPinnedTarget(type, id);
    return `<button class="link-btn" data-community-action="${pinned ? "unpin" : "pin"}" data-type="${esc(type)}" data-id="${esc(id)}"${note ? ` data-note="${esc(note)}"` : ""} style="margin:2px 0 0;">${pinned ? "ביטול הצמדה" : "הצמדה למעלה"}</button>`;
  }
  // ONE RAIL. The single owner of "how much may sit between a member and the
  // first thing another member wrote".
  //
  // THE PROBLEM IT ENDS. Six blocks used to stack above the feed: the pinned
  // strip, the onboarding step, the club header, today's programming, the
  // announcements section and then the feed's own header, compose button and
  // filter chips. Every one of them was added for a good reason, carried a
  // ticket, and had a comment arguing why it belonged exactly there - and
  // every one of those arguments was correct. The defect was never in any
  // single block. It was that NOTHING OWNED THE TOTAL: each addition was
  // judged against the blocks already present, never against a budget, so the
  // screen could only grow. This function is that budget.
  //
  // Cards are offered in priority order and the first RAIL_ABOVE_FEED of them
  // that actually have content render above the feed. The rest are not
  // dropped - they are interleaved into the feed a few posts down, where they
  // are still reachable but are no longer competing for the opening screen.
  // A card that renders "" is absent, not empty: the existing
  // renders-nothing-when-empty style is what makes the budget affordable.
  const RAIL_ABOVE_FEED = 2;
  const RAIL_INTERLEAVE_AFTER = 3;
  function railInterleave(cards, rail) {
    if (!rail.length) return cards.join("");
    const out = cards.slice();
    out.splice(Math.min(RAIL_INTERLEAVE_AFTER, out.length), 0, ...rail);
    return out.join("");
  }

  // ---- One card per club-WOD session ---------------------------------------
  //
  // A POST_WORKOUT that is one member's own result for a club WOD whose
  // SESSION CARD IS ALSO IN THIS FEED is folded into that card
  // (clubWodSessionRollupHtml, src/community/club.js) and is not drawn again
  // as a card of its own. Fifteen people doing Fran on a Tuesday morning
  // produced fifteen near-identical cards, and the one card that actually
  // said what the club was doing was buried under them.
  //
  // THE MATCH IS EXACT, NOT FUZZY, and it is made of two things the rows
  // already carry:
  //   * the session card's metadata.club_wod_id, which club_wod_session_
  //     publish() stamps, and
  //   * the result post's comparison_key, which app.js writes as
  //     `wod:<wodId>:<scoreType>:<rx|scaled>` (app.js:4218).
  // The wodId in the second is the club_wod_id in the first, so a prefix
  // match on `wod:<id>:` identifies the workout, and occurred_on against
  // session_date identifies the DAY - without it, a member repeating the
  // same WOD three weeks later would have that result swallowed by an
  // unrelated session card.
  //
  // FOLDED ONLY WHEN THE SESSION CARD IS PRESENT. The map is built from the
  // feed's own POST_CLUB_WOD rows, not from state.club.wodBoards, precisely
  // so a result can never be hidden with nothing on screen carrying it:
  // scroll past the session card, or load a page that has no session card on
  // it, and the individual posts render exactly as they did before. A post
  // the viewer wrote themselves is folded on the same terms as anyone
  // else's - their own row is in the roll-up, with their figure and their
  // place on it, which is more than the standalone card said.
  function feedGroupedPostIds(items) {
    const grouped = {};
    if (!Array.isArray(items) || !items.length) return grouped;
    const sessions = [];
    for (const row of items) {
      if (!row || row.post_type !== "POST_CLUB_WOD") continue;
      const m = row.metadata || {};
      const wodId = m.club_wod_id;
      const date = String(m.session_date || row.occurred_on || "").slice(0, 10);
      if (wodId && date) sessions.push({ prefix: "wod:" + wodId + ":", date });
    }
    if (!sessions.length) return grouped;
    for (const row of items) {
      if (!row || row.post_type !== "POST_WORKOUT" || !row.id) continue;
      const key = String(row.comparison_key || (row.metadata && row.metadata.comparison_key) || "");
      if (!key) continue;
      const on = String(row.occurred_on || (row.metadata && row.metadata.workout_date) || "").slice(0, 10);
      if (!on) continue;
      if (sessions.some((sn) => sn.date === on && key.indexOf(sn.prefix) === 0)) grouped[row.id] = true;
    }
    return grouped;
  }

  // ---- "פוסטים חדשים" ------------------------------------------------------
  //
  // A post arriving over Realtime while a member is reading must NOT push
  // what they are reading down the screen - which is what happened before,
  // because every path that learned about new content called loadFeed() and
  // rebuilt the list under them. It is counted instead, and the member
  // decides when to take it, through the pill at the top of the list.
  //
  // COUNTED, NOT COLLECTED: the row on the wire is the raw workout_posts
  // INSERT, which has been through no ranking, no diversity pass and none of
  // feed_page's visibility filtering - so it is not something this client may
  // render, and it is never pushed into state.feed.items. All this keeps is
  // that SOMETHING landed, and taking the pill re-reads the feed properly.
  // A post the viewer wrote themselves is skipped: their own publish already
  // refreshes the feed, and a pill offering a member their own post back is
  // noise.
  // A ceiling on the count, not on the behaviour. Past it the pill would be
  // saying the same thing ("a lot arrived, take a refresh") with a bigger
  // number, and the list of ids would keep growing for a member who has left
  // the tab open all afternoon - it is only ever a de-dupe key set, never
  // content, so there is nothing to lose by stopping.
  const FEED_INCOMING_MAX = 99;
  function noteIncomingPost(postId, authorId) {
    if (!postId) return;
    if (state.user && authorId && authorId === state.user.id) return;
    if (state.feed.incoming.length >= FEED_INCOMING_MAX) return;
    if (state.feed.incoming.indexOf(postId) >= 0) return;
    // Already on screen (a feed reload raced the event): nothing is new.
    if (findFeedPost(postId)) return;
    state.feed.incoming.push(postId);
    scheduleRerender();
  }
  function clearIncomingPosts() { state.feed.incoming = []; }
  // The pill itself. Takes the member to the top of the list as well as
  // reloading it, because "show me what is new" that leaves you eleven cards
  // down has not shown you anything.
  function takeIncomingPosts() {
    clearIncomingPosts();
    state.feed.pagesLoaded = 0;
    loadFeed().then(function () {
      rerender();
      const list = document.getElementById("communityFeedTop");
      if (list && list.scrollIntoView) { try { list.scrollIntoView({ block: "start" }); } catch (e) { list.scrollIntoView(); } }
    });
    rerender();
  }
  function renderNewPostsPill() {
    const n = state.feed.incoming.length;
    if (!n) return "";
    return `<div class="new-posts-pill-wrap"><button class="chip-btn primary new-posts-pill" data-community-action="feed-take-new" aria-live="polite">↑ ${esc(n === 1 ? "פוסט חדש" : n + " פוסטים חדשים")}</button></div>`;
  }

  // ---- Pull to refresh -----------------------------------------------------
  //
  // TOUCH ONLY, and gated on the browser actually having a coarse pointer -
  // a laptop trackpad's overscroll is not a refresh gesture and wiring one
  // there would fire on an ordinary flick back to the top of the list.
  //
  // Registered ONCE, on document, rather than per render: afterRenderCommunity
  // runs after every rerender and the feed's own cards are replaced each time,
  // so a per-render listener would either stack up or need tearing down. The
  // handlers read state at event time and do nothing at all unless the feed
  // tab is the one on screen and the page is already scrolled to the top.
  const PULL_REFRESH_TRIGGER_PX = 72;   // how far past the top counts as a pull
  const PULL_REFRESH_MAX_PX = 96;       // where the indicator stops following
  let pullStartY = null;
  let pullDistance = 0;
  function pullRefreshArmed() {
    if (!state.user || state.ui.tab !== "feed") return false;
    // ON SCREEN, not merely "the remembered sub-tab". state.ui.tab is the
    // COMMUNITY sub-tab and app.js owns the top-level one, so a member who
    // last looked at the feed and is now on the training log still reads as
    // tab === "feed" - and a pull there would silently reload a feed they
    // cannot see. The indicator element is only ever emitted inside the feed
    // tab's own markup, so its presence in the document is the test.
    if (!pullRefreshIndicator()) return false;
    if (state.feed.loading) return false;
    if (typeof window.matchMedia !== "function") return false;
    try { if (!window.matchMedia("(pointer: coarse)").matches) return false; } catch (e) { return false; }
    const top = window.scrollY || (document.documentElement && document.documentElement.scrollTop) || 0;
    return top <= 0;
  }
  function pullRefreshIndicator() {
    return document.getElementById("communityPullRefresh");
  }
  function onPullStart(e) {
    pullDistance = 0;
    pullStartY = pullRefreshArmed() && e.touches && e.touches.length === 1 ? e.touches[0].clientY : null;
  }
  function onPullMove(e) {
    if (pullStartY == null || !e.touches || !e.touches.length) return;
    const dy = e.touches[0].clientY - pullStartY;
    if (dy <= 0) { pullDistance = 0; const el0 = pullRefreshIndicator(); if (el0) el0.style.height = "0px"; return; }
    pullDistance = Math.min(dy, PULL_REFRESH_MAX_PX);
    const el = pullRefreshIndicator();
    // The indicator is moved by touching its own style, never by a rerender:
    // rebuilding the feed on every touchmove frame is the one thing a pull
    // gesture must not do.
    if (el) {
      el.style.height = pullDistance + "px";
      el.setAttribute("data-ready", pullDistance >= PULL_REFRESH_TRIGGER_PX ? "1" : "0");
    }
  }
  function onPullEnd() {
    const dist = pullDistance;
    const el = pullRefreshIndicator();
    if (el) { el.style.height = "0px"; el.setAttribute("data-ready", "0"); }
    pullStartY = null;
    pullDistance = 0;
    if (dist < PULL_REFRESH_TRIGGER_PX) return;
    // Re-asked at RELEASE rather than trusted from touchstart, because a tab
    // change or a reload can land mid-gesture. Not pullRefreshArmed(), which
    // also asks "is the page at scrollTop 0" - true when the pull began and
    // not necessarily now.
    if (!state.user || state.ui.tab !== "feed" || !pullRefreshIndicator() || state.feed.loading) return;
    // The same reload the retry button and the new-posts pill run, so there
    // is one refresh path and it is the one that has always been tested.
    clearIncomingPosts();
    state.feed.pagesLoaded = 0;
    track(A.FEED_VIEWED, { scope: state.feed.scope, source: "pull_refresh" });
    loadFeed().then(rerender);
    rerender();
  }
  let pullRefreshBound = false;
  function bindPullToRefresh() {
    if (pullRefreshBound || typeof document.addEventListener !== "function") return;
    pullRefreshBound = true;
    document.addEventListener("touchstart", onPullStart, { passive: true });
    document.addEventListener("touchmove", onPullMove, { passive: true });
    document.addEventListener("touchend", onPullEnd, { passive: true });
    document.addEventListener("touchcancel", onPullEnd, { passive: true });
  }

  // p_surfacedAnnouncementId: the announcement that is ALREADY on screen as
  // the "הערת האימון להיום" card, if any.
  function renderPinnedStrip(surfacedAnnouncementId) {
    const canPin = hasPerm(PERM.CONTENT_PIN);
    // ONE RAIL. A pinned announcement that is also rendering as its own card
    // put two boxes with the same 📌 on the same screen, saying the same
    // thing, from two different features - a member cannot tell those apart,
    // and whichever one they learn to read they stop reading the other.
    //
    // EXCLUDED ONLY WHILE IT IS ACTUALLY SHOWN, which is the whole subtlety.
    // A first draft dropped every announcement pin and broke something real:
    // an EXPIRED announcement stops rendering as a card, but its pin row
    // survives until someone explicitly unpins it (COMM-155), and the strip
    // is then the ONLY place staff can see that a stale pin is still there.
    // Filtering by target_type would have hidden exactly the pins that most
    // need attention. So the test that caught it was right, and this filters
    // on identity - is THIS announcement on screen right now - not on kind.
    const pins = state.admin.pins.filter((p) => !(p.target_type === "announcement" && surfacedAnnouncementId && p.target_id === surfacedAnnouncementId));
    if (!pins.length && !state.admin.pinError) return "";
    const chips = pins.slice(0, 3).map((p) => `<div class="chip-btn" style="cursor:default;gap:6px;align-items:center;">
      📌 <span>${bidiText(p.note || pinTargetLabel(p.target_type))}</span>
      ${canPin ? `<button class="link-btn" data-community-action="unpin" data-type="${esc(p.target_type)}" data-id="${esc(p.target_id)}" aria-label="ביטול הצמדה" style="margin:0;padding:0 4px;">✕</button>` : ""}
    </div>`).join("");
    return `<div class="chart-card" id="communityPinnedStrip" style="margin-bottom:12px;">
      <div style="font-weight:800;font-size:13px;margin-bottom:8px;">מוצמד</div>
      <div class="chip-row" style="margin:0;">${chips}</div>
      ${state.admin.pinError ? `<div class="footer-note" role="alert" style="color:var(--red-text);margin-top:6px;">${esc(state.admin.pinError)}</div>` : ""}
    </div>`;
  }
