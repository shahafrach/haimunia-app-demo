"use strict";
// ---- Community: reactions -------------------------------------------------
//
// One reaction per member per post (a fist bump), the strip and summary that
// show who reacted, and the "who reacted" sheet. Text comments, replies and
// @mentions were dropped (docs/circles/decisions.md); what is left of the old
// engagement module is only this.
//
// Classic <script>, no IIFE, loaded before cloud.js; it reads state, client,
// rerender, setMessage and communityRpc from the shared scope, from inside
// function bodies only.
  const REACTOR_AVATARS_SHOWN = 5;

  function selfDisplayName() {
    return (state.profile && (state.profile.display_name || (state.profile.handle ? "@" + state.profile.handle : ""))) || "אני";
  }

  function reactionState(postId) {
    if (state.engagement.reactions[postId]) return state.engagement.reactions[postId];
    const row = findFeedPost(postId);
    const count = row ? Number((row.reaction_count != null ? row.reaction_count : row.cheer_count) || 0) : 0;
    return { loaded: false, mine: false, list: [], count: count };
  }
  function ensureReactionsLoaded(postId) {
    if (!postId || state.engagement.reactions[postId]) return;
    state.engagement.reactions[postId] = { loaded: false, loading: true, mine: false, list: [], count: reactionState(postId).count };
    loadReactionsFor(postId);
  }
  async function loadReactionsFor(postId) {
    const { data, error } = await client.from("reactions")
      .select("user_id,profiles(handle,display_name)")
      .eq("post_id", postId).eq("kind", "cheer").order("created_at", { ascending: true }).limit(200);
    if (error) { delete state.engagement.reactions[postId]; return; }
    const rows = data || [];
    state.engagement.reactions[postId] = {
      loaded: true,
      mine: !!(state.user && rows.some((r) => r.user_id === state.user.id)),
      list: rows.map((r) => ({ id: r.user_id, name: r.profiles ? (r.profiles.display_name || "@" + r.profiles.handle) : "" })),
      count: rows.length,
    };
    // One frame, not one rebuild per post whose reactions came back.
    scheduleRerender();
  }
  function syncFeedReactionCount(postId, count) {
    const row = findFeedPost(postId);
    if (row) { row.reaction_count = count; row.cheer_count = count; }
  }
  // Same in-flight guard shape as pinBusy above: a fast double-tap used to
  // fire toggle_reaction twice before the first response landed, which
  // both re-toggles the optimistic UI back to its starting state AND
  // sends two real toggles to the server (net no-op there, but not on a
  // flaky connection where the two responses can land out of order).
  const reactionBusy = {};
  async function react(postId) {
    if (!state.user || reactionBusy[postId]) return;
    reactionBusy[postId] = true;
    const before = reactionState(postId);
    const wasMine = !!before.mine;
    const others = (before.list || []).filter((r) => r.id !== state.user.id);
    // Optimistic. Tap adds, tap again removes; the button and the avatar
    // strip both reflect it before the server answers (COMM-120).
    const optimistic = {
      loaded: before.loaded,
      mine: !wasMine,
      list: wasMine ? others : [{ id: state.user.id, name: selfDisplayName() }].concat(others),
      count: Math.max(0, before.count + (wasMine ? -1 : 1)),
    };
    state.engagement.reactions[postId] = optimistic;
    syncFeedReactionCount(postId, optimistic.count);
    state.engagement.reactionError = null;
    rerender();
    const { queued, error } = await communityRpc("toggle_reaction", { p_post_id: postId });
    reactionBusy[postId] = false;
    if (queued) {
      // Offline: the optimistic state above already shows the cheer, and
      // the queued op carries an idempotency key so replaying it on
      // reconnect cannot flip it back off. Keep the optimistic UI.
      await refreshOutboxState();
      rerender();
      return;
    }
    if (error) {
      state.engagement.reactions[postId] = before;
      syncFeedReactionCount(postId, before.count);
      state.engagement.reactionError = postId;
      setMessage(error.message === "rate_limited" ? "יותר מדי לחיצות, נסו שוב בעוד כמה דקות" : "לא ניתן היה להגיב כרגע");
      rerender();
      return;
    }
    if (!wasMine && window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.REACTION_CREATED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.REACTION_CREATED, { post_id: postId }); } catch (e) {}
    }
    loadReactionsFor(postId);
  }



  // COMM-120. The reactor avatar strip and total. Rendered inside the
  // engagement slot so the card markup itself is untouched; shown whenever a
  // post has reactions or its thread is open.
  function reactionStripHtml(post) {
    const pid = post && post.id;
    if (!pid) return "";
    const base = reactionState(pid);
    if (base.count > 0) ensureReactionsLoaded(pid);
    const rs = reactionState(pid);
    const reactors = (rs.list || []).filter((r) => !isBlockedUser(r.id));
    const total = Number(rs.count || 0);
    if (!total && !reactors.length) return "";
    const avatars = reactors.slice(0, REACTOR_AVATARS_SHOWN)
      .map((r) => `<span style="display:inline-flex;margin-inline-start:-6px;">${avatarHtml(r.name || "?", 22)}</span>`).join("");
    // Live bug hunt (2026-09-11): the `mine` branch already special-cased
    // total<=1; the other branch (viewed by someone who hasn't reacted)
    // didn't, and rendered "1 הגבות" for a post with exactly one reaction.
    const label = rs.mine
      ? (total <= 1 ? "הגבתם" : `הגבתם ועוד ${total - 1}`)
      : (total === 1 ? "הגבה אחת" : `${total} הגבות`);
    return `<div class="reaction-strip">${avatars ? `<span class="flex" style="padding-inline-start:6px;">${avatars}</span>` : ""}<span style="color:var(--steel);font-size:11.5px;">${esc(label)}</span></div>`;
  }

  // ---- "דנה ועוד 4", beside the pill ------------------------------------
  // The summary a social feed puts next to its reaction button: a NAME, not a
  // bare number, because the first thing a member wants from a count is
  // whether anyone they know is in it. Tapping it opens the full list.
  //
  // The name is the first reactor the viewer may see - loadReactionsFor()
  // returns them in created_at order and isBlockedUser() has already dropped
  // the block edges, so nothing is disclosed here that the avatar strip
  // directly below it was not already disclosing. The COUNT stays the
  // server's `count`, which is the count of ALL reactions and can therefore
  // be larger than the list; "ועוד N" is computed from the same total so it
  // never contradicts the pill beside it.
  function reactionSummaryHtml(post) {
    const pid = post && post.id;
    if (!pid) return "";
    const rs = reactionState(pid);
    const total = Number(rs.count || 0);
    if (!total) return "";
    const visible = (rs.list || []).filter((r) => !isBlockedUser(r.id));
    const mineFirst = rs.mine ? [{ id: state.user && state.user.id, name: "אתם" }] : [];
    const named = mineFirst.concat(visible.filter((r) => !rs.mine || !state.user || r.id !== state.user.id));
    const first = named.length ? (named[0].name || "חבר/ה") : "";
    // Nobody nameable yet (the list is still loading, or every reactor is
    // someone this viewer may not see): fall back to the plain count rather
    // than inventing a name or rendering an empty button.
    const label = !first ? (total === 1 ? "הגבה אחת" : `${total} הגבות`)
      : total > 1 ? `${first} ועוד ${total - 1}`
      : first;
    return `<button class="link-btn reaction-summary" data-community-action="reactors" data-id="${esc(pid)}" aria-haspopup="dialog" aria-label="מי הגיב, ${total}">${esc(label)}</button>`;
  }

  function openReactors(postId) {
    if (!postId) return;
    ensureReactionsLoaded(postId);
    // Always re-read: a strip loaded ten minutes ago is exactly the list this
    // sheet must not show as "who reacted" right now.
    if (state.engagement.reactions[postId]) loadReactionsFor(postId);
    state.engagement.reactorsFor = postId;
    rerender();
  }
  function closeReactors() { state.engagement.reactorsFor = null; rerender(); }

  function renderReactorsSheet() {
    const pid = state.engagement.reactorsFor;
    if (!pid) return "";
    const rs = reactionState(pid);
    const rows = (rs.list || []).filter((r) => !isBlockedUser(r.id));
    const total = Number(rs.count || 0);
    // THREE STATES, and the third is the honest one this app keeps
    // insisting on: the list can be SHORTER than the count, because a
    // reaction from a member this viewer may not see is still a reaction.
    // Said in as many words rather than quietly showing a list that does not
    // add up to the number on the pill.
    const hidden = Math.max(0, total - rows.length);
    const body = !rs.loaded && !rows.length
      ? `<div class="empty">טוען…</div>`
      : rows.length
      ? `<div class="log-list">${rows.map((r) => `<div class="log-row" data-reactor-user="${esc(r.id)}">
          <span style="display:flex;gap:10px;align-items:center;">
            ${avatarHtml(r.name || "חבר/ה", 32)}
            <span style="font-weight:700;">${esc(r.name || "חבר/ה")}</span>
          </span>
        </div>`).join("")}</div>${hidden ? `<div class="footer-note" style="margin-top:8px;">${esc("ועוד " + hidden + " שאי אפשר להציג כאן")}</div>` : ""}`
      : `<div class="empty">אין עדיין תגובות עידוד</div>`;
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="reactorsTitle" data-cloud-dialog="reactors" style="align-items:flex-end;padding:0;">
      <div class="modal-sheet" style="border-radius:20px 20px 0 0;max-height:70vh;overflow:auto;width:100%;">
        <div style="padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 16px);">
          <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:12px;">
            <h2 id="reactorsTitle" style="margin-top:0;font-weight:800;font-size:16px;margin-bottom:0;">מי הגיב</h2>
            ${sheetCloseBtnHtml("reactors-close")}
          </div>
          ${body}
        </div>
      </div>
    </div>`;
  }



