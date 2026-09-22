"use strict";
// ---- Community: reactions and comments (COMM-120..125) --------------------
//
// One reaction per member per post, two levels of replies and no more,
// @mentions with their picker and their storage markers, edit and delete of
// one's own comment, and coach comment priority.
//
// Moved out of cloud.js unchanged — every line byte-identical to what it was
// there. Classic <script>, no IIFE, loaded before cloud.js; see
// src/community/events.js's header for why each of those matters.
//
// The mention MARKERS are a storage format, not display text.
// extractMentions() writes them, mentionMarkersToHtml() renders them, and
// commentBodyForEditing()/reEncodeCommentMentions() turn them back into
// something a member can edit and then back again. All four have to agree;
// they are together here for that reason.
//
// WHAT STAYED BEHIND, deliberately: blocking and following —
// loadBlockedIds, isBlockedUser, blockFilteredList, loadFollowingIds,
// followButtonHtml and their siblings sit in the middle of this code in
// cloud.js and every surface in the layer reads them. They are member
// relationships, and they move with the directory.

  const COMMENT_BODY_MAX = 1000;
  const MENTION_MAX = 10;
  const REACTOR_AVATARS_SHOWN = 5;
  // @[Display Name](uuid). Stored verbatim in the comment body and resolved to
  // a profile link on render. Keyed by member id, so a later display-name
  // change keeps the link pointing at the right member (COMM-123).
  const MENTION_MARKER_RE = /@\[([^\]\n]{1,200})\]\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g;

  function commentKey(postId, parentId) { return parentId ? String(postId) + ":" + String(parentId) : String(postId); }
  function selfDisplayName() {
    return (state.profile && (state.profile.display_name || (state.profile.handle ? "@" + state.profile.handle : ""))) || "אני";
  }
  function extractMentions(body) {
    const re = new RegExp(MENTION_MARKER_RE.source, "g");
    const seen = {};
    const out = [];
    let m;
    while ((m = re.exec(body))) {
      if (seen[m[2]]) continue;
      seen[m[2]] = true;
      out.push({ user_id: m[2], name: m[1] });
      if (out.length >= MENTION_MAX) break;
    }
    return out;
  }
  function mentionMarkersToHtml(body) {
    return esc(String(body == null ? "" : body)).replace(new RegExp(MENTION_MARKER_RE.source, "g"),
      function (full, name, id) {
        return '<button type="button" class="link-btn mention-chip" data-community-action="view-profile" data-id="' + id + '" style="padding:0;font-weight:700;color:var(--blue);">@' + name + "</button>";
      });
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
      .select("user_id,profiles(handle,display_name,avatar_url)")
      .eq("post_id", postId).eq("kind", "cheer").order("created_at", { ascending: true }).limit(200);
    if (error) { delete state.engagement.reactions[postId]; return; }
    const rows = data || [];
    state.engagement.reactions[postId] = {
      loaded: true,
      mine: !!(state.user && rows.some((r) => r.user_id === state.user.id)),
      list: rows.map((r) => ({ id: r.user_id, name: r.profiles ? (r.profiles.display_name || "@" + r.profiles.handle) : "", avatar_url: r.profiles ? r.profiles.avatar_url : null })),
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

  // Live bug hunt (2026-09-11): renderComments() used to read
  // state.engagement.comments[pid] with no load-if-missing check of its own
  // - only toggleComments()'s OPEN transition ever triggered a fetch.
  // block() clears state.engagement.comments = {} wholesale (so a newly
  // blocked member's comments/replies drop out of the current view - COMM-
  // 125), which reactions self-heal from (ensureReactionsLoaded() is called
  // unconditionally every render, from reactionStripHtml()) but comments did
  // not - confirmed live, blocking someone mid-conversation blanked the
  // WHOLE open thread (not just their own comment) to nothing until the
  // member manually closed and reopened it. Same shape as
  // ensureReactionsLoaded(), called from renderComments() below.
  function ensureCommentsLoaded(postId) {
    if (!postId || state.engagement.comments[postId]) return;
    loadCommentsFor(postId);
  }
  async function loadCommentsFor(postId) {
    // The embed names its foreign key explicitly. post_comments has TWO
    // references to profiles - author_id and the deleted_by column added by
    // 202608280021 - so a bare `profiles(...)` is ambiguous and PostgREST
    // refuses the whole request with PGRST201 (HTTP 300) rather than
    // picking one. Comments have therefore never loaded since that
    // migration shipped: every thread came back as the empty `error ? []`
    // branch below. Invisible to the Node suite, which does not model
    // PostgREST embedding at all. The result key stays `profiles`, which is
    // what the comment renderers read.
    const { data, error } = await client.from("post_comments")
      .select("id,body,created_at,edited_at,deleted_at,status,author_id,parent_comment_id,profiles!post_comments_author_id_fkey(handle,display_name,avatar_url)")
      .eq("post_id", postId).order("created_at", { ascending: true }).limit(400);
    const rows = error ? [] : (data || []);
    state.engagement.comments[postId] = rows;
    await loadMemberRoles(rows.map((c) => c.author_id));
    // ONE FRAME, not one rebuild per post whose comments came back - the same
    // change loadReactionsFor() above already carries, and now for the same
    // reason. This used to be a direct rerender() and could afford to be:
    // comments only ever loaded for the ONE thread a member had opened. The
    // two-comment preview under every card means a page of twenty posts can
    // resolve twenty of these at once, and twenty full rebuilds of the feed
    // in one scroll is exactly what scripts/browser-check/
    // feed-rerender-storm.mjs exists to catch - it caught this.
    scheduleRerender();
  }
  // COMM-124 / COMM-160. The coach badge on every surface a member is shown
  // (comment, feed post author, profile header, people search, member
  // directory) is driven by the server role set, never a client guess:
  // invite_redemptions.role for each user id, looked up once and cached.
  // Batched so a feed page or a comment thread is a single query.
  //
  // POST-PHASE-3 FIX. This used to be a direct
  // client.from("invite_redemptions").select(...).in("user_id", need) read.
  // invite_redemptions has carried exactly one SELECT policy since Phase 0
  // (202608270003), own-row only, never widened - so that read could only
  // ever return the CALLER's own row; every other id in `need` came back
  // silently absent under real RLS, and the coach badge this function backs
  // has been unable to identify anyone but the viewer themselves since it
  // was built. Invisible to this repo's own tests, because mockSupabase.mjs's
  // plain `.from()` reads carry no RLS simulation. Now calls
  // member_roles(uuid[]), a definer function added specifically for this
  // (202609010011) that returns only {user_id, role} for the requested ids -
  // never the whole table, never redeemed_at or code.
  function memberRole(userId) { return (userId && state.members.roles[userId]) || null; }
  function isCoachRole(role) { return role === "coach" || role === "head_coach"; }
  async function loadMemberRoles(ids) {
    const need = [];
    for (const id of ids || []) if (id && !(id in state.members.roles)) need.push(id);
    if (!need.length) return;
    for (const id of need) state.members.roles[id] = null;
    const { data, error } = await client.rpc("member_roles", { p_ids: need });
    // Launch-readiness audit, CQ-003. A dropped error used to leave every id
    // in `need` pre-seeded at null ("no role") with no way to ever retry -
    // the `!(id in state.members.roles)` guard above treats "present and
    // null" the same as "checked and confirmed no role". One transient
    // failure permanently stripped the coach badge from a whole batch of
    // members for the rest of the session. Deleting the pre-seed on error
    // instead makes the next call see these ids as unchecked again, matching
    // how resolveAvatarUrl() deliberately leaves a failed lookup uncached.
    if (error) { for (const id of need) delete state.members.roles[id]; return; }
    for (const r of (data || [])) state.members.roles[r.user_id] = r.role || null;
  }
  function toggleComments(postId) {
    if (state.engagement.openComments[postId]) { delete state.engagement.openComments[postId]; rerender(); return; }
    state.engagement.openComments[postId] = true;
    // COMM-170. Opening the thread is what "opened a post" means on this
    // feed - there is no separate post detail view in V1. The early return
    // above is what keeps a close from counting as a second open.
    const opened = findFeedPost(postId);
    track(A.POST_OPENED, { post_id: postId, post_type: (opened && opened.post_type) || null, source: "feed" });
    if (!state.members.blocksLoaded) loadBlockedIds().then(rerender);
    if (!state.engagement.comments[postId]) loadCommentsFor(postId); else rerender();
  }
  function commentErrorMessage(error) {
    const msg = (error && error.message) || "";
    if (msg === "rate_limited") return "יותר מדי תגובות, נסו שוב בעוד כמה דקות";
    // Same handoff as SERVER_ERROR_TEXT.posting_restricted, in the one line
    // this inline field-error has room for: the reason and the end date live
    // on one surface now, so every channel that mentions the restriction
    // names it rather than each carrying its own partial account.
    if (msg === "posting_restricted") return "החשבון שלכם מוגבל כרגע משליחת תגובות. הסיבה ומועד הסיום מופיעים בטאב \"חשבון\"";
    if (/depth is capped|already has replies/.test(msg)) return "אי אפשר להשיב לתשובה. אפשר להגיב על התגובה המקורית";
    if (/another post/.test(msg)) return "התגובה שאליה ניסיתם להשיב שייכת לפוסט אחר";
    if (/no longer available|not found/.test(msg)) return "התגובה שאליה ניסיתם להשיב כבר אינה זמינה";
    return "שליחת התגובה נכשלה";
  }
  // COMM-123. Resolve @[Name](id) markers before the write: a member whose
  // allow_mentions is off, or on either side of a block edge, is stripped
  // back to plain "@Name" text and never enters the mention signal.
  async function resolveCommentMentions(body) {
    let stored = body;
    const allowed = [];
    for (const mn of extractMentions(body)) {
      let ok = false;
      try { ok = await canViewProfileField(mn.user_id, "allow_mentions"); } catch (e) { ok = false; }
      if (ok && !isBlockedUser(mn.user_id)) allowed.push(mn);
      else stored = stored.split("@[" + mn.name + "](" + mn.user_id + ")").join("@" + mn.name);
    }
    return { stored: stored, mentions: allowed };
  }
  async function addComment(postId, form, parentCommentId) {
    if (!state.user) return;
    const key = commentKey(postId, parentCommentId || null);
    const raw = String((form.elements && form.elements.body && form.elements.body.value) || "");
    const body = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim().slice(0, COMMENT_BODY_MAX);
    if (!body) return;
    // The draft is held in state until the server confirms the write, so a
    // failed send never drops what the member typed (COMM-121).
    state.engagement.commentDrafts[key] = raw;
    delete state.engagement.commentErrors[key];
    state.engagement.commentSending = key;
    state.engagement.mentionPicker = null;
    rerender();

    const resolved = await resolveCommentMentions(body);
    // Bug fix: this was calling the 3-arg overload (no p_mentions), which
    // PostgREST resolves to the OLDER add_post_comment that never writes
    // comment_mentions - resolveCommentMentions() already did all the
    // allow_mentions/block filtering above and the result went nowhere but
    // a client-side analytics emit, so a mention has never once produced a
    // notification. Passing p_mentions routes this to the real 4-arg
    // overload (202608280021_comment_mentions_and_self_delete.sql), which
    // writes comment_mentions and is what the notif_on_mention trigger
    // actually hangs off.
    const { data, error, queued } = await communityRpc("add_post_comment", { p_post_id: postId, p_body: resolved.stored, p_parent_comment_id: parentCommentId || null, p_mentions: resolved.mentions.map((m) => m.user_id) });
    state.engagement.commentSending = null;
    if (queued) {
      // Offline: the comment is safely persisted and will be sent on
      // reconnect. Clear the draft so it is not double-submitted, and tell
      // the member what happened rather than showing a failure.
      delete state.engagement.commentDrafts[key];
      delete state.engagement.commentErrors[key];
      if (typeof form.reset === "function") form.reset();
      await refreshOutboxState();
      setMessage("אין חיבור — התגובה תישלח כשהחיבור יחזור");
      rerender();
      return;
    }
    if (error) {
      state.engagement.commentErrors[key] = commentErrorMessage(error);
      rerender();
      return;
    }
    delete state.engagement.commentDrafts[key];
    delete state.engagement.commentErrors[key];
    if (parentCommentId) { state.engagement.openReplies[parentCommentId] = true; state.engagement.replyTo[postId] = null; }
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.COMMENT_CREATED) {
      try {
        window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.COMMENT_CREATED, {
          post_id: postId, comment_id: data || null, parent_comment_id: parentCommentId || null,
          author_id: state.user.id, mentions: resolved.mentions,
        });
      } catch (e) {}
    }
    if (typeof form.reset === "function") form.reset();
    await loadCommentsFor(postId);
    await loadFeed();
  }
  function retryComment(postId, parentId) {
    const key = commentKey(postId, parentId || null);
    const draft = state.engagement.commentDrafts[key];
    if (draft == null) return;
    addComment(postId, { elements: { body: { value: draft } }, reset: function () {} }, parentId || null);
  }
  async function deleteComment(commentId, postId) {
    if (!state.user) return;
    const list = state.engagement.comments[postId] || [];
    const target = list.find((c) => c.id === commentId);
    // post_comments_delete_self is author-only. A moderator removal is a
    // status change through mod_review (COMM-153), not a client delete, so it
    // is not offered here.
    if (target && target.author_id !== state.user.id) return;
    const snapshot = list.slice();
    // Bug fix: this used to be a raw hard DELETE, which (parent_comment_id
    // is `on delete set null`) silently reparented any reply to the deleted
    // comment up to top-level, and never showed the "התגובה נמחקה"
    // placeholder renderCommentBubble already has a real branch for.
    // comment_delete() (202608280021) is the soft-delete this was always
    // meant to route through - it stamps status='removed' and leaves the
    // row (and its replies' parent link) in place. Mark the comment removed
    // in place here too, rather than filtering it out of the array, so a
    // reply keeps its visual parent immediately instead of only after the
    // reload below.
    if (target) { target.status = "removed"; target.deleted_at = new Date().toISOString(); }
    rerender();
    const { error } = await client.rpc("comment_delete", { p_comment_id: commentId });
    if (error) {
      state.engagement.comments[postId] = snapshot;
      setMessage("מחיקת התגובה נכשלה");
      rerender();
      return;
    }
    await loadCommentsFor(postId);
    await loadFeed();
  }
  // A MEMBER EDITING A COMMENT MUST NOT BE SHOWN A STRANGER'S UUID.
  //
  // Live bug hunt, fresh round 3 (2026-09-15). A comment is STORED with
  // mention markers - @[רון כהן](22222222-...-222222222222) - and rendered
  // with them stripped, so it reads as "@רון כהן". The edit box was seeded
  // from the raw stored body, so the moment a member tapped "עריכה" on a
  // comment that mentioned anyone, they were looking at bracket-and-paren
  // syntax with somebody's account id in the middle of their own sentence.
  // Editing near those characters silently mangles the marker, too, because
  // nothing repairs it.
  //
  // So the box shows the friendly form and the markers are rebuilt on save.
  // resolveCommentMentions() cannot do that rebuilding itself - it only ever
  // DOWNGRADES a marker to plain text when a mention is not permitted - so
  // the name->id pairs are carried alongside the draft.
  //
  // Longest name first when re-encoding: with both "רון" and "רון כהן"
  // mentioned, replacing the shorter one first would eat the prefix of the
  // longer and produce a broken marker.
  function commentMentionMap(body) {
    const map = [];
    MENTION_MARKER_RE.lastIndex = 0;
    let m;
    while ((m = MENTION_MARKER_RE.exec(String(body || "")))) map.push({ name: m[1], id: m[2] });
    map.sort((a, b) => b.name.length - a.name.length);
    return map;
  }
  function commentBodyForEditing(body) {
    let out = String(body || "");
    for (const { name, id } of commentMentionMap(out)) out = out.split(`@[${name}](${id})`).join(`@${name}`);
    return out;
  }
  function reEncodeCommentMentions(body, map) {
    let out = String(body || "");
    for (const { name, id } of (map || [])) out = out.split(`@${name}`).join(`@[${name}](${id})`);
    return out;
  }
  function startCommentEdit(commentId, postId) {
    const list = state.engagement.comments[postId] || [];
    const c = list.find((x) => x.id === commentId);
    if (!c || c.author_id !== (state.user && state.user.id)) return;
    const raw = String(c.body || "");
    state.engagement.commentEdit = {
      commentId: commentId, postId: postId,
      body: commentBodyForEditing(raw), mentionMap: commentMentionMap(raw),
      saving: false, error: "",
    };
    state.engagement.mentionPicker = null;
    rerender();
  }
  function cancelCommentEdit() { state.engagement.commentEdit = null; rerender(); }
  async function saveCommentEdit() {
    const e = state.engagement.commentEdit;
    if (!e || e.saving) return;
    const body = String(e.body || "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim().slice(0, COMMENT_BODY_MAX);
    if (!body) { e.error = "אי אפשר לשמור תגובה ריקה"; rerender(); return; }
    // Back into stored form before anything else looks at it. A mention the
    // member left alone re-encodes exactly; one whose name they edited no
    // longer matches and becomes ordinary text, which is the honest outcome.
    const resolved = await resolveCommentMentions(reEncodeCommentMentions(body, e.mentionMap));
    e.saving = true; e.error = ""; rerender();
    const list = state.engagement.comments[e.postId] || [];
    const target = list.find((x) => x.id === e.commentId);
    const prev = target ? { body: target.body, edited_at: target.edited_at } : null;
    if (target) { target.body = resolved.stored; target.edited_at = new Date().toISOString(); }
    rerender();
    const { error } = await client.rpc("comment_edit", { p_comment_id: e.commentId, p_body: resolved.stored });
    if (error) {
      if (target && prev) { target.body = prev.body; target.edited_at = prev.edited_at; }
      e.saving = false;
      e.error = error.message === "rate_limited" ? "יותר מדי עריכות, נסו שוב בעוד כמה דקות"
        : error.message === "posting_restricted" ? "החשבון שלכם מוגבל כרגע מעריכת תגובות. הסיבה ומועד הסיום מופיעים בטאב \"חשבון\""
        : "לא ניתן היה לשמור את העריכה";
      rerender();
      return;
    }
    state.engagement.commentEdit = null;
    await loadCommentsFor(e.postId);
  }
  // COMM-151. Opens the reason sheet for a comment. The write goes through
  // the same report() RPC as a post, with p_target_type 'comment'.
  function reportComment(commentId) { openReportSheet("comment", commentId); }

  function onCommentInput(input) {
    const key = input.dataset.commentKey;
    state.engagement.commentDrafts[key] = input.value;
    const caret = input.selectionStart == null ? input.value.length : input.selectionStart;
    // The "@" picker is switchable from the admin panel (2026-09-15). With
    // mentions off, an @ is just a character: no picker, no lookup request,
    // and nothing offering a member a feature their club has turned off.
    // Already-stored markers in older comments still RENDER as names - hiding
    // those would rewrite history rather than switch a feature off.
    const m = isModuleEnabled("mentions") ? /(?:^|\s)@([^\s@]{0,30})$/.exec(input.value.slice(0, caret)) : null;
    if (m) {
      const q = m[1];
      const active = state.engagement.mentionPicker && state.engagement.mentionPicker.key === key;
      if (active && state.engagement.mentionPicker.query === q) return;
      state.engagement.mentionPicker = { key: key, query: q, results: active ? state.engagement.mentionPicker.results : [], loading: true, index: 0 };
      searchMentionPeople(key, q);
      rerender();
      restoreCommentFocus(key, caret);
    } else if (state.engagement.mentionPicker && state.engagement.mentionPicker.key === key) {
      state.engagement.mentionPicker = null;
      rerender();
      restoreCommentFocus(key, caret);
    }
  }
  // The same ordering token communitySearch() and directorySearch() already
  // use. Live bug hunt, fresh round 9 (2026-09-16): this fired a lookup on
  // every keystroke with no debounce and no token, and its only guard asked
  // "is this still the same comment box" - never "is this response still for
  // the text that is in it".
  //
  // So a fast typist correcting "@d" to "@z" could see the picker fill with
  // the match for "@d", which had simply resolved second. Pressing Enter then
  // inserted @[Daniel Levi](u-daniel) into a comment written while looking at
  // "@z" - mentioning and NOTIFYING the wrong member, and attributing that
  // mention publicly to someone who never typed it.
  let mentionSearchToken = 0;
  async function searchMentionPeople(key, query) {
    const token = ++mentionSearchToken;
    const q = String(query || "").trim().replace(/[%_,()]/g, "");
    let results = [];
    if (q.length >= 1 && state.user) {
      const { data } = await client.from("profiles")
        .select("id,handle,display_name,avatar_url,allow_mentions")
        .or("handle.ilike.%" + q + "%,display_name.ilike.%" + q + "%")
        .neq("id", state.user.id).limit(6);
      results = (data || []).filter((p) => !isBlockedUser(p.id));
    }
    // A response that is no longer the newest must not write anything back.
    if (token !== mentionSearchToken) return;
    if (state.engagement.mentionPicker && state.engagement.mentionPicker.key === key) {
      state.engagement.mentionPicker.results = results;
      state.engagement.mentionPicker.loading = false;
      rerender();
      restoreCommentFocus(key, null);
    }
  }
  function mentionPick(key, id, name) {
    const cur = state.engagement.commentDrafts[key] || "";
    const replaced = cur.replace(/(^|\s)@([^\s@]*)$/, function (full, pre) { return pre + "@[" + name + "](" + id + ") "; });
    state.engagement.commentDrafts[key] = replaced === cur ? cur + "@[" + name + "](" + id + ") " : replaced;
    // The mentions module's one event. At the PICK, not at the send: the
    // published comment already carries mention_count through the bus bridge
    // (BUS_COUNT_KEYS), so what that prop cannot answer - and what decides
    // whether the "@" picker earns its place - is how often members reach for
    // it at all, including in drafts they then abandon or edit the mention
    // back out of.
    //
    // `source` is the only prop, and the only one there will ever be. The
    // picked member's id and display name are both sitting right here in the
    // arguments and neither goes anywhere near the row: "who tags whom" is a
    // social graph, analytics_events is readable under
    // community.analytics.view, and a mention is already delivered to the
    // person it names through notifications - it does not also need to be
    // published to whoever runs a usage query.
    //
    // Not a WCAM event: the comment that carries the mention is, through
    // comment_created, and an abandoned draft must make nobody active.
    // commentKey() is "<postId>" for a top-level box and "<postId>:<parentId>"
    // for a reply box, and a post id is a uuid, so the colon is the whole test.
    track(A.MENTION_INSERTED, { source: String(key || "").indexOf(":") >= 0 ? "reply" : "comment" });
    state.engagement.mentionPicker = null;
    rerender();
    restoreCommentFocus(key, state.engagement.commentDrafts[key].length);
  }
  function restoreCommentFocus(key, caret) {
    setTimeout(function () {
      const el = document.querySelector('[data-comment-input][data-comment-key="' + key + '"]');
      if (!el) return;
      el.focus();
      if (caret != null) { try { el.setSelectionRange(caret, caret); } catch (e) {} }
    }, 0);
  }

  // COMM-120. The reactor avatar strip and total. Rendered inside the
  // engagement slot so the card markup itself is untouched; shown whenever a
  // post has reactions or its thread is open.
  function reactionStripHtml(post) {
    const pid = post && post.id;
    if (!pid) return "";
    const base = reactionState(pid);
    if (base.count > 0 || state.engagement.openComments[pid]) ensureReactionsLoaded(pid);
    const rs = reactionState(pid);
    const reactors = (rs.list || []).filter((r) => !isBlockedUser(r.id));
    const total = Number(rs.count || 0);
    if (!total && !reactors.length) return "";
    const avatars = reactors.slice(0, REACTOR_AVATARS_SHOWN)
      .map((r) => `<span style="display:inline-flex;margin-inline-start:-6px;">${avatarHtml(r.name || "?", 22, r.avatar_url)}</span>`).join("");
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
          <button class="link-btn" data-community-action="view-profile" data-id="${esc(r.id)}" style="padding:0;display:flex;gap:10px;align-items:center;color:inherit;text-align:right;">
            ${avatarHtml(r.name || "חבר/ה", 32, r.avatar_url)}
            <span style="font-weight:700;">${esc(r.name || "חבר/ה")}</span>
          </button>
        </div>`).join("")}</div>${hidden ? `<div class="footer-note" style="margin-top:8px;">${esc("ועוד " + hidden + " שאי אפשר להציג כאן")}</div>` : ""}`
      : `<div class="empty">אין עדיין תגובות עידוד</div>`;
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="reactorsTitle" data-cloud-dialog="reactors" style="align-items:flex-end;padding:0;">
      <div class="modal-sheet" style="border-radius:20px 20px 0 0;max-height:70vh;overflow:auto;width:100%;">
        <div style="padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 16px);">
          <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:12px;">
            <h2 id="reactorsTitle" style="margin-top:0;font-weight:800;font-size:16px;margin-bottom:0;">מי הגיב</h2>
            <button class="chip-btn" data-community-action="reactors-close" aria-label="סגירה">✕</button>
          </div>
          ${body}
        </div>
      </div>
    </div>`;
  }
  // COMM-124. Text carries the meaning, not colour alone.
  function coachBadgeHtml(role) {
    const label = role === "head_coach" ? "מאמן/ת ראשי/ת" : role === "coach" ? "מאמן/ת" : "";
    if (!label) return "";
    return `<span class="coach-badge badge-tag">${label}</span>`;
  }
  function commentPlaceholder(text, reply) {
    return `<div class="comment-row" style="${reply ? "margin-inline-start:26px;" : ""}"><div style="flex:1;min-width:0;color:var(--steel);font-size:12px;font-style:italic;padding:4px 0;">${esc(text)}</div></div>`;
  }
  function renderCommentBubble(post, c, opts) {
    opts = opts || {};
    const meId = state.user && state.user.id;
    const removed = !!c.deleted_at || (!!c.status && c.status !== "active");
    if (isBlockedUser(c.author_id)) return commentPlaceholder("תגובה מוסתרת", opts.reply);
    if (removed) return commentPlaceholder("התגובה נמחקה", opts.reply);
    const role = memberRole(c.author_id);
    const isCoach = isCoachRole(role);
    const name = c.profiles ? (c.profiles.display_name || "@" + c.profiles.handle) : "חבר/ה";
    const own = c.author_id === meId;
    const editing = state.engagement.commentEdit && state.engagement.commentEdit.commentId === c.id;
    const wrapStyle = (opts.reply ? "margin-inline-start:26px;" : "")
      + (isCoach ? "border-inline-start:3px solid var(--brass);padding-inline-start:8px;background:color-mix(in srgb, var(--brass) 6%, transparent);border-radius:8px;" : "");
    let bodyHtml;
    if (editing) {
      const e = state.engagement.commentEdit;
      bodyHtml = `<div class="comment-edit" style="margin-top:4px;">
        <textarea class="text-input" data-comment-edit-input maxlength="${COMMENT_BODY_MAX}" rows="2" aria-label="עריכת תגובה">${esc(e.body || "")}</textarea>
        ${e.error ? `<div class="field-error" role="alert" style="margin-top:4px;">${esc(e.error)}</div>` : ""}
        <div class="chip-row" style="margin-top:6px;"><button class="chip-btn" data-community-action="comment-edit-cancel">ביטול</button><button class="chip-btn primary" data-community-action="comment-edit-save"${e.saving ? " disabled" : ""}>${e.saving ? "שומר…" : "שמירה"}</button></div>
      </div>`;
    } else {
      bodyHtml = `<div style="font-size:12.5px;line-height:1.55;"><b>${esc(name)}</b> ${isCoach ? coachBadgeHtml(role) + " " : ""}${bidiHtml(mentionMarkersToHtml(c.body))}</div>`;
    }
    const edited = c.edited_at ? ` <span style="color:var(--steel);font-size:10.5px;" title="${esc(relativeTime(c.edited_at))}">(נערך)</span>` : "";
    const actions = [];
    if (!opts.reply) actions.push(`<button class="link-btn" data-community-action="comment-reply" data-post="${esc(post.id)}" data-id="${esc(c.id)}">תגובה</button>`);
    if (own && !editing) {
      actions.push(`<button class="link-btn" data-community-action="comment-edit" data-post="${esc(post.id)}" data-id="${esc(c.id)}">עריכה</button>`);
      actions.push(`<button class="link-btn" data-community-action="delete-comment" data-id="${esc(c.id)}" data-post="${esc(post.id)}" aria-label="מחיקת תגובה">מחיקה</button>`);
    }
    if (!own) actions.push(`<button class="link-btn" data-community-action="report-comment" data-id="${esc(c.id)}">דיווח</button>`);
    return `<div class="comment-row${isCoach ? " comment-coach" : ""}" style="${wrapStyle}">${avatarHtml(name, 24, c.profiles && c.profiles.avatar_url)}<div style="flex:1;min-width:0;">
      ${bodyHtml}
      <div class="flex gap-10" style="margin-top:2px;align-items:center;flex-wrap:wrap;"><span style="color:var(--steel);font-size:11px;">${esc(relativeTime(c.created_at))}</span>${edited}${actions.join("")}</div>
    </div></div>`;
  }
  function mentionPickerHtml(key) {
    const p = state.engagement.mentionPicker;
    if (!p || p.key !== key) return "";
    const items = p.results || [];
    const inner = p.loading
      ? `<div style="padding:8px 10px;color:var(--steel);font-size:12px;">מחפש חברים…</div>`
      : (items.length
        ? items.map((m, i) => `<button type="button" class="mention-option" role="option" data-community-action="mention-pick" data-key="${esc(key)}" data-id="${esc(m.id)}" data-name="${esc(m.display_name || m.handle)}" aria-selected="${i === (p.index || 0) ? "true" : "false"}" style="display:block;width:100%;text-align:right;padding:8px 10px;background:${i === (p.index || 0) ? "var(--surface2)" : "none"};border:0;color:var(--chalk);font-size:12.5px;cursor:pointer;">${nameHtml(m.display_name, m.handle)} <span style="color:var(--steel);"><bdi>@${esc(m.handle)}</bdi></span></button>`).join("")
        : `<div style="padding:8px 10px;color:var(--steel);font-size:12px;">אין התאמות</div>`);
    return `<div class="mention-picker" role="listbox" style="position:absolute;z-index:40;top:100%;inset-inline-start:0;margin-top:4px;min-width:220px;background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.25);max-height:180px;overflow-y:auto;">${inner}</div>`;
  }
  function commentComposerHtml(postId, parentId) {
    const key = commentKey(postId, parentId || null);
    const draft = state.engagement.commentDrafts[key] || "";
    const err = state.engagement.commentErrors[key];
    const sending = state.engagement.commentSending === key;
    const reply = !!parentId;
    return `${err ? `<div class="field-error" role="alert" style="margin:6px 0 4px;">${esc(err)} <button class="link-btn" data-community-action="comment-retry" data-post="${esc(postId)}"${reply ? ` data-parent="${esc(parentId)}"` : ""}>ניסיון חוזר</button></div>` : ""}
      <form data-comment-post-id="${esc(postId)}"${reply ? ` data-comment-parent-id="${esc(parentId)}"` : ""} class="flex gap-6" style="margin-top:8px;position:relative;flex-wrap:wrap;">
        <input class="text-input" name="body" data-comment-input data-comment-key="${esc(key)}" autocomplete="off" maxlength="${COMMENT_BODY_MAX}" placeholder="${reply ? "השבה לתגובה" : "הוספת תגובה"}" aria-label="${reply ? "השבה לתגובה" : "הוספת תגובה"}" value="${esc(draft)}"/>
        <button class="chip-btn primary" type="submit"${sending ? " disabled" : ""}>${sending ? "שולח…" : reply ? "השבה" : "שליחה"}</button>
        ${mentionPickerHtml(key)}
      </form>`;
  }
  // COMMENTS ARE NO LONGER BEHIND A TAP. The two latest sit under every card
  // with their time and a reply link, and the "הוספת תגובה…" box is always
  // there - the closed state used to be a bare reaction strip and a 💬 count,
  // so the club's conversation was invisible from the feed and the only way
  // to find out whether a post had one was to open it.
  const COMMENT_PREVIEW_COUNT = 2;

  // The preview's own loader gate, and it is deliberately the SAME shape
  // reactionStripHtml() has used since COMM-120: fetch for a card that says
  // it has something, never for one that says it has nothing. comment_count
  // comes down with the feed row, so a page of twenty posts asks only for the
  // threads that actually exist, and a post with no comments costs no query
  // at all - the common case on this feed. ensureCommentsLoaded() is itself
  // idempotent (it returns early once the map has an entry), so this runs on
  // every render and fetches once.
  function ensureCommentPreviewLoaded(post) {
    const pid = post && post.id;
    if (!pid) return;
    if (Number(post.comment_count || 0) <= 0) return;
    ensureCommentsLoaded(pid);
  }

  // The two latest top-level comments, newest LAST so the card reads in the
  // same order an open thread does. Replies are not previewed: a reply lives
  // under its parent and a preview that hoisted one would show an answer with
  // no question. The reply link opens the same two-level composer the open
  // thread uses - there is no second reply path here.
  function commentPreviewHtml(post) {
    const pid = post.id;
    const all = state.engagement.comments[pid] || [];
    const visible = all.filter((c) => !c.parent_comment_id
      && !isBlockedUser(c.author_id)
      && !c.deleted_at
      && (!c.status || c.status === "active"));
    const sorted = visible.slice().sort((a, b) => (a.created_at > b.created_at ? 1 : a.created_at < b.created_at ? -1 : 0));
    const latest = sorted.slice(-COMMENT_PREVIEW_COUNT);
    const hiddenCount = Number(post.comment_count || 0) - latest.length;
    const more = hiddenCount > 0
      ? `<button class="link-btn comment-more" data-community-action="toggle-comments" data-id="${esc(pid)}">${esc(hiddenCount === 1 ? "עוד תגובה אחת" : "עוד " + hiddenCount + " תגובות")}</button>`
      : "";
    // The reply box a preview'd comment's "תגובה" link opens renders here,
    // indented under the previewed list, so replying never forces the whole
    // thread open first.
    const replyOpen = state.engagement.replyTo[pid];
    const replyBox = replyOpen && latest.some((c) => c.id === replyOpen)
      ? `<div style="margin-inline-start:26px;">${commentComposerHtml(pid, replyOpen)}</div>`
      : "";
    return `${more}${latest.length ? `<div class="log-list comment-preview" style="margin-top:6px;">${latest.map((c) => renderCommentBubble(post, c, { reply: false })).join("")}</div>` : ""}${replyBox}`;
  }

  function renderComments(post) {
    const pid = post && post.id;
    if (!pid) return "";
    const strip = reactionStripHtml(post);
    if (!state.engagement.openComments[pid]) {
      // The module gate is the composer's, not the strip's: a club with
      // comments turned off still has reactions, and postActionsHtml()
      // already drops the 💬 button in that state.
      if (!isModuleEnabled("comments")) return strip;
      ensureCommentPreviewLoaded(post);
      // data-comment-thread distinguishes the two states for anything that
      // has to tell them apart. It matters now in a way it never did before:
      // the top-level comment FORM used to exist only while the thread was
      // open, so `[data-comment-post-id]` was itself the "is it open" test -
      // and the box is on every card now, so that test would always say yes.
      return `${strip}<div class="comment-preview-wrap" data-comment-thread="preview">${commentPreviewHtml(post)}${commentComposerHtml(pid, null)}</div>`;
    }
    ensureCommentsLoaded(pid);

    const all = state.engagement.comments[pid] || [];
    const byId = {};
    for (const c of all) byId[c.id] = c;
    const tops = [];
    const repliesByParent = {};
    for (const c of all) {
      if (!c.parent_comment_id) { tops.push(c); continue; }
      (repliesByParent[c.parent_comment_id] = repliesByParent[c.parent_comment_id] || []).push(c);
    }
    const sortByTime = (a, b) => (a.created_at > b.created_at ? 1 : a.created_at < b.created_at ? -1 : 0);

    const nodeFor = (c) => {
      const kids = (repliesByParent[c.id] || []).slice().sort(sortByTime);
      const repliesOpen = !!state.engagement.openReplies[c.id];
      const hidden = isBlockedUser(c.author_id) || !!c.deleted_at || (!!c.status && c.status !== "active");
      let html = renderCommentBubble(post, c, { reply: false });
      if (kids.length) {
        html += `<div class="flex gap-10" style="margin:2px 0 2px 26px;"><button class="link-btn" data-community-action="toggle-replies" data-id="${esc(c.id)}">${repliesOpen ? "הסתרת תשובות" : `${kids.length} תשובות`}</button></div>`;
        if (repliesOpen) html += kids.map((k) => renderCommentBubble(post, k, { reply: true })).join("");
      }
      if (!hidden && state.engagement.replyTo[pid] === c.id) {
        html += `<div style="margin-inline-start:26px;">${commentComposerHtml(pid, c.id)}</div>`;
      }
      return html;
    };

    // COMM-121 / COMM-122. A reply whose parent is not in the returned set
    // means the parent was removed (RLS hides it). The reply still carries
    // parent_comment_id, so render a placeholder parent to hang it under.
    const orphanHtml = Object.keys(repliesByParent).filter((k) => !byId[k]).map((k) => {
      const kids = repliesByParent[k].slice().sort(sortByTime);
      return commentPlaceholder("התגובה נמחקה", false) + kids.map((x) => renderCommentBubble(post, x, { reply: true })).join("");
    }).join("");

    const listHtml = (tops.slice().sort(sortByTime).map(nodeFor).join("") + orphanHtml)
      || `<div class="empty" style="padding:6px 0;">התחילו את השיחה</div>`;

    return `${strip}<div data-comment-thread="open" style="margin-top:10px;"><div class="log-list">${listHtml}</div>${commentComposerHtml(pid, null)}</div>`;
  }
