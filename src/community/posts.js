"use strict";
// ---- Community: posts and the composer (COMM-101..108, COMM-180) ----------
//
// How a post is made and how it is drawn: the composer with its multi-photo
// upload and alt text, the per-type card renderers, the one dispatch table
// that picks between them, the owner's edit and delete controls, photo and
// avatar upload with their signed-URL cache, and the Share This PR prompt.
//
// Moved out of cloud.js unchanged — every line byte-identical to what it was
// there. Classic <script>, no IIFE, loaded before cloud.js; see
// src/community/events.js's header for why each of those matters.
//
// POST_CARD_RENDERERS IS THE ONE DISPATCH, and it is built at this file's
// evaluation time out of direct references to the renderers. All thirteen
// live here for that reason — including renderEventLinkCard and
// renderChallengeLinkCard, which stayed behind when events and challenges
// moved out. Pulling one renderer away from the table that dispatches it is
// how the fourteenth card type gets a second dispatch.
//
// The one exception is renderClubWodPostCard, which is in
// src/community/club.js: the club WOD board owns it, and the ORDER of the
// <script> tags in index.html is what keeps that reference resolvable —
// club.js loads before this file. Read the POST_CLUB_WOD comment in the
// table below before reordering anything.

  async function uploadPostPhoto(file) {
    if (!file || !state.user) return null;
    const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    const path = `${state.user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await client.storage.from("post-photos").upload(path, file, { contentType: file.type, upsert: false });
    return error ? null : path;
  }
  // COMM-318 / 202609060003. The avatar half of the pattern below. Reads the
  // cache only - avatarHtml() runs during render and must never await.
  function avatarSignedUrl(storedUrl) {
    return storedUrl ? signedCacheGet(avatarUrlCache, storedUrl) : null;
  }
  // Launch-readiness audit, CQ-004. Both caches used to store a bare URL
  // string with no timestamp, and re-entry was short-circuited on a cache
  // hit - so an entry was never refreshed. The signature these URLs carry
  // expires after SIGNED_URL_TTL_S, and this is an installed PWA whose
  // sessions routinely outlive that: after an hour every avatar and every
  // feed photo already scrolled past rendered as a broken image, with no
  // retry and no fallback to the initials badge (that path is only taken
  // when the cache is EMPTY, not when it holds a stale URL).
  //
  // Entries are now { url, expiresAt } and a read within SIGNED_URL_SKEW_MS
  // of expiry is treated as a miss, so the next render re-signs. The skew
  // matters: an entry that expires while the member is looking at it would
  // otherwise still be served once.
  const SIGNED_URL_TTL_S = 3600;
  const SIGNED_URL_SKEW_MS = 5 * 60 * 1000;
  function signedCacheGet(cache, key) {
    const hit = cache[key];
    if (!hit) return null;
    if (typeof hit === "string") return hit; // legacy shape, pre-CQ-004
    if (hit.expiresAt - SIGNED_URL_SKEW_MS <= Date.now()) { delete cache[key]; return null; }
    return hit.url;
  }
  function signedCachePut(cache, key, url) {
    cache[key] = { url, expiresAt: Date.now() + SIGNED_URL_TTL_S * 1000 };
  }
  // Called from an <img onerror>: a signature that expired between render
  // and load (or an object that vanished) evicts its entry so the next
  // render re-signs instead of showing a permanently broken image.
  function evictSignedUrl(kind, key) {
    if (!key) return;
    const cache = kind === "avatar" ? avatarUrlCache : photoUrlCache;
    delete cache[key];
    rerender();
  }
  window.__haimuniaEvictSignedUrl = evictSignedUrl;
  // Fire-and-forget, exactly like resolvePhotoUrl. A failure (a member who
  // hid from the club, a block edge, an object that was removed) is left
  // uncached on purpose: the initials badge is a correct answer for "you may
  // not see this face", so there is nothing to report and nothing to retry
  // until the next render decides to ask again.
  async function resolveAvatarUrl(storedUrl) {
    // signedCacheGet() rather than a bare truthiness check, so an entry
    // that is present but expiring is treated as a miss and re-signed
    // (CQ-004).
    if (!storedUrl || signedCacheGet(avatarUrlCache, storedUrl) || avatarInFlight[storedUrl]) return;
    const path = avatarPathFromUrl(storedUrl);
    if (!path) return;
    avatarInFlight[storedUrl] = true;
    const { data, error } = await client.storage.from("avatar-photos").createSignedUrl(path, SIGNED_URL_TTL_S);
    delete avatarInFlight[storedUrl];
    if (!error && data && data.signedUrl) { signedCachePut(avatarUrlCache, storedUrl, data.signedUrl); scheduleRerender(); }
  }
  async function resolvePhotoUrl(path) {
    if (!path || signedCacheGet(photoUrlCache, path)) return;
    const { data, error } = await client.storage.from("post-photos").createSignedUrl(path, SIGNED_URL_TTL_S);
    if (!error && data) { signedCachePut(photoUrlCache, path, data.signedUrl); scheduleRerender(); }
  }

  // THE TWIN, named here so the next reader does not fix one of them. This
  // is the legacy card's own "הסרת שיתוף" (a direct delete on
  // workout_posts, author-scoped in the query); postDeleteViaMenu() below is
  // the typed card's "מחיקה" through the post_delete() RPC. Two rows in the
  // same table, two call sites, and until now two different promises about
  // whether a member could take it back. Both run through
  // deferCommunityDelete() (cloud.js) and both say the same thing in their
  // confirm sheet.
  async function deletePost(postId) {
    if (!state.user) return;
    const snapshot = Array.isArray(state.feed.items) ? state.feed.items.slice() : null;
    deferCommunityDelete({
      label: "השיתוף הוסר",
      remove: () => { if (snapshot) state.feed.items = state.feed.items.filter((p) => p && p.id !== postId); },
      restore: () => { if (snapshot) state.feed.items = snapshot; },
      commit: async () => {
        const { error } = await client.from("workout_posts").delete().eq("id", postId).eq("author_id", state.user.id);
        // A failed write puts the post back on screen. It was only ever
        // hidden optimistically, so the row is still there and the member
        // has to be told the removal did not happen.
        if (error) { if (snapshot) state.feed.items = snapshot; rerender(); return setMessage(failText("הסרת השיתוף נכשלה", error)); }
        await loadFeed();
      },
    });
  }
  async function publishWorkout(type, id, visibility, photoFile) {
    if (!state.user || !state.profile || typeof window.communityShareCandidateFor !== "function") return;
    // communityShareCandidateFor looks up any entry by id regardless of
    // age - unlike the old recency-limited list, sharing can now be
    // triggered from Calendar or Progress, which show results from any
    // date, not just the last few.
    const item = window.communityShareCandidateFor(type, id);
    if (!item) return setMessage("לא ניתן למצוא את התוצאה במכשיר");
    let photoPath = null;
    if (photoFile) {
      // Was uploadPostPhoto(photoFile) directly on the raw File - every
      // other upload path (composerAddPhoto, avatar, PR prompt) goes
      // through prepareImage first, which strips EXIF/GPS and compresses.
      // This was the one path that shipped a member's raw photo, metadata
      // and all, straight to storage.
      try {
        const prepared = await window.HaimuniaImage.prepareImage(photoFile);
        photoPath = await uploadPreparedPhoto(prepared);
      } catch (e) {
        photoPath = null;
      }
      if (!photoPath) return setMessage("העלאת התמונה נכשלה, אפשר לנסות שוב בלי תמונה");
    }
    const payload = { author_id: state.user.id, source_type: item.type, source_record_id: item.id, visibility: visibility === "public" ? "public" : "followers", title: item.title, result_text: item.resultText, comparison_key: item.comparisonKey, score_value: item.scoreValue, score_direction: item.scoreDirection, rx: item.rx, occurred_on: item.occurredOn };
    if (photoPath) payload.photo_path = photoPath;
    const { error } = await client.from("workout_posts").upsert(payload, { onConflict: "author_id,source_type,source_record_id" });
    if (error) return setMessage(failText("שיתוף התוצאה נכשל", error));
    // COMM-170. After the write, so a failed share is not counted as one.
    // This path predates the composer and does not emit POST_CREATED, so
    // workout_shared is the only record of it.
    track(A.WORKOUT_SHARED, { source_type: item.type, visibility: payload.visibility, has_photo: !!photoPath });
    delete state.posts.openShare[shareKey(type, id)];
    await loadFeed(); setMessage("התוצאה שותפה בלי הערות, מדדים או פרטים אישיים");
  }
  // Collapsed to one small icon by default wherever a result actually
  // lives (Calendar day view, a movement/WOD's Progress card) instead of
  // a standing list of everything shareable sitting in the Community tab
  // itself - tap to expand the same photo/visibility controls publishing
  // already had.
  function shareKey(type, id) { return `${type}:${id}`; }
  function toggleShare(type, id) {
    const key = shareKey(type, id);
    if (state.posts.openShare[key]) delete state.posts.openShare[key]; else state.posts.openShare[key] = true;
    rerender();
  }

  // The five visibility labels the schema keeps (contracts.md "Phase 0 schema
  // notes"). club / friends / only_me is the model going forward; public and
  // followers are legacy read aliases the current client still writes.
  // Post-Phase-3 Hebrew copy fix: "עוקבים" (followed), matching
  // visibilityLabel()'s own "followers" -> עוקבים mapping two lines below -
  // "חברים" was the same homonym collision LEADERBOARD_SCOPES had (this app
  // uses חברים everywhere else to mean club membership, not "who follows
  // me").
  const POST_VISIBILITY_OPTIONS = [
    { value: "club", label: "כל המועדון" },
    { value: "friends", label: "עוקבים" },
    { value: "only_me", label: "רק אני" },
  ];
  function normalizeVisibility(v) { return v === "public" ? "club" : v === "followers" ? "friends" : (v || "club"); }
  function visibilityLabel(v) {
    if (v === "followers") return "עוקבים";
    const opt = POST_VISIBILITY_OPTIONS.find((o) => o.value === normalizeVisibility(v));
    return opt ? opt.label : "כל המועדון";
  }
  const POST_BODY_MAX = 1000;
  const POST_MEDIA_MAX = 4;
  const ALT_TEXT_MAX = 200;
  // Real device feedback: the announcements archive below the feed used to
  // render every live announcement in full with no cap. Recent ones stay
  // visible; older ones move behind a <details> disclosure instead.
  const ANNOUNCEMENTS_ARCHIVE_VISIBLE = 3;
  // COMM-102 "control characters stripped, leading and trailing whitespace
  // trimmed". The server re-trims to POST_BODY_MAX, this is only the client
  // guard and the counter source.
  function cleanPostBody(raw) {
    return String(raw == null ? "" : raw)
      .replace(/\r\n?/g, "\n")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
      .trim()
      .slice(0, POST_BODY_MAX);
  }

  function postIsOwn(post) {
    return !!(post && post.author_id && state.user && post.author_id === state.user.id);
  }
  function postAuthorName(post) {
    const a = post && post.author;
    if (a && (a.display_name || a.handle)) return a.display_name || ("@" + a.handle);
    if (post && (post.display_name || post.handle)) return post.display_name || ("@" + post.handle);
    return "";
  }
  function postTimestamp(post) {
    return (post && (post.created_at || post.published_at || post.occurred_on)) || null;
  }
  function findFeedPost(id) { return Array.isArray(state.feed.items) ? state.feed.items.find((p) => p && p.id === id) : null; }
  // Authorless posts render the club mark, never a broken avatar (COMM-107).
  const CLUB_MARK_HTML = `<span aria-hidden="true" class="avatar-badge" style="width:40px;height:40px;font-size:16px;background:var(--brass);">ח</span>`;

  function postHeadHtml(post, opts) {
    opts = opts || {};
    const authorless = !!opts.authorless;
    const name = authorless ? (opts.clubName || "המועדון") : (postAuthorName(post) || "חבר/ה");
    // opts.markIcon lets one authorless post type stand out from the generic
    // "ח" club mark every other authorless type (system, new-member) still
    // shares - used by the announcement card so a club notice reads at a
    // glance instead of looking like any other club-voice row in the feed.
    const avatar = opts.markIcon
      ? `<span aria-hidden="true" class="avatar-badge post-mark-icon" style="width:40px;height:40px;font-size:17px;">${opts.markIcon}</span>`
      // Feed polish pass: 36px -> 40px, matching the reference mockup's
      // heavier avatar weight relative to the rest of the card - scoped to
      // just this one call site (the main feed card's own head), not every
      // other 36px avatar in the app (comments, directory rows, etc. keep
      // their own deliberate, smaller-context sizing).
      : authorless ? CLUB_MARK_HTML : avatarHtml(name, 40, post && post.author ? post.author.avatar_url : (post && post.avatar_url));
    const authorId = !authorless && post && post.author_id;
    // COMM-160. Same coach badge the comments carry, on the post author.
    const roleBadge = authorId ? coachBadgeHtml(memberRole(authorId)) : "";
    const nameInner = `${esc(name)}${roleBadge ? " " + roleBadge : ""}`;
    const nameHtml = authorId
      ? `<button class="post-author link-btn" data-community-action="view-profile" data-id="${esc(authorId)}" style="padding:0;font:inherit;color:inherit;font-weight:800;">${nameInner}</button>`
      : `<div class="post-author">${nameInner}</div>`;
    return `<div class="post-head">${avatar}<div class="post-head-text">${nameHtml}<div class="post-time">${esc(relativeTime(postTimestamp(post)))}${postTypeTagHtml(post, opts)}</div></div>${opts.hideMenu ? "" : postMenuHtml(post)}</div>`;
  }

  // ONE CARD, and this is the part of it a member reads first: who, when, and
  // what KIND of thing this is. Every type gets a label - a small tag on the
  // time line, not a `· word` glued to the timestamp, which is how it used to
  // read and which made "הודעת מועדון" look like part of the date.
  //
  // opts.badge still wins where a renderer already had a better word for its
  // own card than the generic type name (the announcement card's
  // "הודעת מועדון", the coach card's "מאמן/ת"), so no existing label text
  // changes - only where it is drawn and that the eleven types that never had
  // one now do too.
  const POST_TYPE_LABELS = {
    POST_TEXT: "",
    POST_PHOTO: "תמונה",
    POST_WORKOUT: "אימון",
    POST_CLUB_WOD: "אימון המועדון",
    POST_PR: "שיא אישי",
    POST_ACHIEVEMENT: "הישג",
    POST_ATTENDANCE_MILESTONE: "אבן דרך",
    POST_CHALLENGE: "אתגר",
    POST_EVENT: "אירוע",
    POST_ANNOUNCEMENT: "הודעת מועדון",
    POST_NEW_MEMBER: "חבר/ה חדש/ה",
    POST_COACH: "מאמן/ת",
    POST_SYSTEM: "מהמועדון",
  };
  function postTypeLabel(post, opts) {
    if (opts && opts.badge) return opts.badge;
    return POST_TYPE_LABELS[(post && post.post_type) || ""] || "";
  }
  function postTypeTagHtml(post, opts) {
    const label = postTypeLabel(post, opts);
    // A plain post with nothing structured in it is not a "kind" of anything,
    // so POST_TEXT deliberately maps to "" and renders no tag at all rather
    // than a tag reading "פוסט" on nine cards out of ten.
    return label ? ` <span class="post-type-tag">${esc(label)}</span>` : "";
  }

  // ONE BODY ORDER, for every type: media first when there is any, then the
  // member's own words, then whatever structured result the type adds.
  //
  // Before this, each of the fourteen renderers chose its own order - the
  // text card put the caption above the photo, the photo card put it below,
  // the workout card put the result above both and the PR card put the media
  // last - so two cards carrying the same three things read as two different
  // layouts while scrolling past them. `result` is the only thing a renderer
  // still decides, and it is always last.
  function postCardBody(post, result) {
    return postMediaHtml(post) + postBodyHtml(post) + (result || "");
  }

  function postMenuHtml(post) {
    if (!post || !post.id) return "";
    const id = esc(post.id);
    const own = postIsOwn(post);
    const open = state.posts.openMenu === post.id;
    const mi = (action, label, dataId, danger) =>
      `<button class="post-menu-item${danger ? " danger" : ""}" role="menuitem" data-community-action="${action}" data-id="${esc(dataId)}">${esc(label)}</button>`;
    let items = "";
    if (own) {
      // Five-persona UX audit, outward sharing. Own posts only, and only the
      // three types whose content is the member's OWN result - see
      // outwardSubjectFromPost() for why the other nine are out.
      if (OUTWARD_SHAREABLE_POST_TYPES.indexOf(post.post_type) >= 0) items += mi("outward-post", "שיתוף מחוץ לאפליקציה", post.id);
      items += mi("post-edit-caption", "עריכת כיתוב", post.id);
      items += mi("post-change-visibility", "שינוי נראוּת", post.id);
      items += mi("post-delete", "מחיקה", post.id, true);
    } else {
      const saved = !!(state.posts.savedIds && state.posts.savedIds[post.id]);
      items += mi("post-save", saved ? "הסרה מהשמורים" : "שמירה", post.id);
      items += mi("post-hide", "הסתרת הפוסט", post.id);
      items += mi("report", "דיווח", post.id);
      if (post.author_id) items += mi("block", "חסימת החבר/ה", post.author_id, true);
    }
    // Real bug found by a role-coverage audit: content.pin covers posts too
    // (pinTargetLabel() has always listed "post"), but until now no post
    // surface offered a pin control at all - see isPinnedTarget()'s comment.
    if (hasPerm(PERM.CONTENT_PIN)) {
      const pinned = isPinnedTarget("post", post.id);
      items += `<button class="post-menu-item" role="menuitem" data-community-action="${pinned ? "unpin" : "pin"}" data-type="post" data-id="${id}">${pinned ? "ביטול הצמדה" : "הצמדה למעלה"}</button>`;
    }
    return `<div class="post-menu-wrap">
      <button class="chip-btn" data-community-action="toggle-post-menu" data-id="${id}" aria-haspopup="true" aria-expanded="${open ? "true" : "false"}" aria-label="עוד פעולות">⋯</button>
      ${open ? `<div class="post-menu" role="menu">${items}</div>` : ""}
    </div>`;
  }

  // The reaction mark. The feed's one reaction is a cheer for a session
  // somebody logged, so it is drawn as the thing they logged it with rather
  // than as a flame emoji - the same dumbbell ICONS.dumbbell (app.js) draws
  // on every empty chart in the app, re-cut here at pill size and on
  // `currentColor` so it takes the pill's own colour in both themes instead
  // of carrying a hardcoded stroke.
  const DUMBBELL_ICON = '<svg class="reaction-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M4 9v6M20 9v6M2 10v4M22 10v4M7 12h10"/></svg>';

  function postActionsHtml(post, opts) {
    opts = opts || {};
    const id = esc(post && post.id);
    const reactions = Number((post && (post.reaction_count != null ? post.reaction_count : post.cheer_count)) || 0);
    const comments = Number((post && post.comment_count) || 0);
    const mine = !!(state.engagement.reactions[post && post.id] && state.engagement.reactions[post && post.id].mine);
    // ONE REACTION PER MEMBER, unchanged: this is still toggle_reaction on
    // the same `cheer` kind, and the pill is pressed or not pressed. What is
    // new is that it SAYS which, through aria-pressed and a filled state,
    // instead of leaving a member to compare a number against the one they
    // remember seeing.
    return `<div class="chip-row post-actions">
      <button class="chip-btn reaction-pill${mine ? " is-mine" : ""}" data-community-action="cheer" data-id="${id}" aria-pressed="${mine ? "true" : "false"}" aria-label="עידוד, ${reactions} עידודים">${DUMBBELL_ICON}<span class="reaction-count">${reactions}</span></button>
      ${typeof reactionSummaryHtml === "function" ? reactionSummaryHtml(post) : ""}
      ${isModuleEnabled("comments") ? `<button class="chip-btn" data-community-action="toggle-comments" data-id="${id}" aria-label="תגובות, ${comments}">💬 ${comments}</button>` : ""}
      ${opts.extra || ""}
    </div>`;
  }

  function postBodyHtml(post) {
    const body = post && post.body;
    if (!body) return "";
    return `<div class="post-body" style="white-space:pre-wrap;line-height:1.6;">${bidiText(String(body).slice(0, POST_BODY_MAX))}</div>`;
  }
  function postMediaHtml(post) {
    const media = (post && post.media) || [];
    if (!media.length) return "";
    const items = media.slice(0, POST_MEDIA_MAX).map((m) => {
      let url = m.url || "";
      if (!url && m.storage_path) {
        const cached = signedCacheGet(photoUrlCache, m.storage_path);
        if (cached) url = cached;
        else resolvePhotoUrl(m.storage_path);
      }
      const alt = m.decorative ? "" : esc(m.alt_text || "");
      if (!url) return `<div class="post-photo" aria-hidden="true" style="background:var(--border);min-height:120px;"></div>`;
      return `<img src="${esc(url)}" alt="${alt}" class="post-photo"/>`;
    }).join("");
    return media.length > 1 ? `<div class="post-media-grid">${items}</div>` : items;
  }

  function captionEditPanel() {
    const e = state.posts.captionEdit;
    return `<div class="post-inline-edit" style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px;">
      <label class="field"><span class="field-label">עריכת כיתוב</span>
        <textarea class="text-input" data-caption-edit maxlength="${POST_BODY_MAX}" rows="3">${esc(e.body || "")}</textarea></label>
      <div class="chip-row"><button class="chip-btn" data-community-action="caption-cancel">ביטול</button><button class="chip-btn primary" data-community-action="caption-save"${captionSaveBlocked() ? " disabled" : ""}>שמירה</button></div>
      ${e.error ? `<div class="field-error" role="alert" style="margin-top:8px;">${esc(e.error)}</div>` : ""}
    </div>`;
  }
  // Emptying a text-only post is not a save. Mirrors the composer's own
  // publish gate rather than letting the button look available and then fail
  // - see postSaveCaption() for why the server's refusal is not enough on its
  // own here.
  function captionSaveBlocked() {
    const e = state.posts.captionEdit;
    if (!e) return true;
    const post = findFeedPost(e.postId);
    const hasPhoto = !!(post && Array.isArray(post.media) && post.media.length);
    return !cleanPostBody(e.body) && !hasPhoto;
  }
  function visibilityEditPanel() {
    const e = state.posts.visibilityEdit;
    return `<div class="post-inline-edit" style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px;">
      <div class="field-label" style="margin-bottom:6px;">מי רואה את הפוסט</div>
      <div class="chip-row">${POST_VISIBILITY_OPTIONS.map((o) => `<button class="chip-btn${e.visibility === o.value ? " selected" : ""}" data-community-action="visibility-pick" data-value="${o.value}">${o.label}</button>`).join("")}</div>
      <button class="link-btn" data-community-action="visibility-cancel" style="margin-top:6px;display:inline-block;">ביטול</button>
    </div>`;
  }

  function postCardShell(post, inner, opts) {
    opts = opts || {};
    const pid = post && post.id;
    return `<article class="chart-card post-card" data-post-type="${esc((post && post.post_type) || "UNKNOWN")}"${opts.unknown ? ' data-post-unknown="1"' : ""}${pid ? ` data-post-id="${esc(pid)}"` : ""}>
      ${postHeadHtml(post, opts)}
      ${inner || ""}
      ${opts.engagementDisabled ? "" : postActionsHtml(post, opts)}
      ${state.posts.captionEdit && pid && state.posts.captionEdit.postId === pid ? captionEditPanel() : ""}
      ${state.posts.visibilityEdit && pid && state.posts.visibilityEdit.postId === pid ? visibilityEditPanel() : ""}
      ${!opts.engagementDisabled && pid && typeof renderComments === "function" ? renderComments(post) : ""}
    </article>`;
  }

  // Both of these used to be the whole difference between two "types": the
  // text card printed the caption first, the photo card printed it second.
  // postCardBody() settles it for all fourteen, so the two are now the same
  // card and differ only in the type tag their head carries.
  function renderTextPostCard(post) { return postCardShell(post, postCardBody(post)); }
  function renderPhotoPostCard(post) { return postCardShell(post, postCardBody(post)); }

  function renderWorkoutPostCard(post) {
    const m = post.metadata || {};
    const name = m.workout_name || post.title || "אימון";
    const when = m.workout_date || post.occurred_on || "";
    const result = m.result_text || post.result_text || "";
    const scoreType = m.score_type || post.score_type || "";
    const effort = m.effort || (post.rx === true ? "rx" : post.rx === false ? "scaled" : m.level ? "level" : "");
    const isPr = !!(m.is_pr || post.is_pr);
    // The PR badge is the first term a beginner meets in the feed and the one
    // they are most likely to misread as a comparison against other members.
    // Marked here, once, and the sheet says so in as many words.
    const prBadge = isPr ? ` <span class="pr-badge badge-tag">PR</span>${termMark("pr")}` : "";
    // Design spec section 3. Both halves of this line used to be printed with
    // a bare esc(): the score type as app.js's raw storage value (`amrap`),
    // the effort as a bare `Rx`. Both are now display forms with a first-
    // occurrence `?`, and both are pre-escaped HTML - hence .join() on the
    // already-built strings rather than .map(esc).
    const metaParts = [scoreTypeHtml(scoreType), effortHtml(effort, m.level)].filter(Boolean);
    const detail = `<div class="post-title">${bidiText(name)}${prBadge}</div>
      ${when ? `<div style="color:var(--steel);font-size:12px;">${esc(shortHebDate(when))}</div>` : ""}
      ${result ? `<div class="mono post-result">${esc(result)}</div>` : ""}
      ${metaParts.length ? `<div style="color:var(--steel);font-size:12px;">${metaParts.join(" · ")}</div>` : ""}`;
    const src = m.source_id || post.source_id || post.source_record_id;
    const extra = src ? `<button class="chip-btn" data-community-action="open-source" data-source-type="${esc(m.source_type || post.source_type || "workout")}" data-source-id="${esc(src)}">פתיחת האימון</button>` : "";
    // `detail` is this type's RESULT BLOCK and so goes last, after the photo
    // and after whatever the member wrote about it.
    return postCardShell(post, postCardBody(post, `<div class="post-result-block">${detail}</div>`), { extra });
  }

  function renderPrPostCard(post) {
    const m = post.metadata || {};
    const movement = m.movement || m.movement_name || post.title || "שיא אישי";
    const rows = [
      ["תוצאה חדשה", m.new_result || m.new_value],
      ["תוצאה קודמת", m.previous_result || m.previous_value],
      ["שיפור", m.improvement],
      ["תאריך", (m.achieved_on || post.occurred_on) ? String(m.achieved_on || post.occurred_on).slice(0, 10) : ""],
    ].filter((r) => r[1] != null && r[1] !== "");
    const result = `<div class="post-result-block"><div class="post-title">${bidiText(movement)} <span class="pr-badge badge-tag">PR</span></div>
      <div class="log-list" style="margin-top:6px;">${rows.map((r) => `<div class="log-row"><span>${esc(r[0])}</span><span class="mono" style="color:var(--brass);">${esc(r[1])}</span></div>`).join("")}</div></div>`;
    return postCardShell(post, postCardBody(post, result));
  }

  function renderAchievementPostCard(post) {
    const m = post.metadata || {};
    const title = m.title || post.title || "הישג";
    const icon = m.badge_icon || "🏅";
    const when = m.earned_on || post.occurred_on || "";
    const why = m.explanation || post.result_text || "";
    const result = `<div class="post-result-block"><div class="flex gap-10" style="align-items:center;">
        <span aria-hidden="true" style="font-size:26px;">${esc(icon)}</span>
        <div><div class="post-title" style="margin:0;">${bidiText(title)}</div>${when ? `<div style="color:var(--steel);font-size:12px;">${esc(shortHebDate(when))}</div>` : ""}</div>
      </div>
      ${why ? `<div style="color:var(--steel);font-size:13px;margin-top:6px;">${bidiText(why)}</div>` : ""}</div>`;
    return postCardShell(post, postCardBody(post, result));
  }

  // COMM-101: the renderer exists so the dispatch is total, but attendance
  // milestones are parked until an attendance source lands, so the feed never
  // actually produces one yet.
  function renderAttendanceMilestonePostCard(post) {
    const m = post.metadata || {};
    const label = m.milestone_label || post.title || "אבן דרך בנוכחות";
    const result = `<div class="post-result-block"><div class="post-title">🎯 ${bidiText(label)}</div>${m.count != null ? `<div class="mono post-result">${esc(m.count)}</div>` : ""}</div>`;
    return postCardShell(post, postCardBody(post, result));
  }

  // COMM-201/203/207: a real challenge card, not the COMM-101 fallback link
  // card. `renderPostCard` never has to know whether a POST_CHALLENGE row is
  // the authorless cooperative-milestone post `challenge_progress_apply`
  // writes (metadata carries milestone/club_total/target_value, no author)
  // or a member's own Share Progress post (metadata carries the type-shaped
  // snapshot buildChallengeShareMetadata() took at share time) - both read
  // through the same fields, each rendered only when present.
  function renderChallengeLinkCard(post) {
    const m = post.metadata || {};
    const rows = [];
    if (m.milestone != null) {
      rows.push(`<div class="mono post-result" style="color:var(--brass);">${esc(m.milestone)}% מהיעד הושלמו</div>`);
      if (m.club_total != null && m.target_value != null) rows.push(`<div style="color:var(--steel);font-size:12px;">${esc(m.club_total)} מתוך ${esc(m.target_value)}</div>`);
    } else if (m.my_progress != null) {
      const pct = m.target_value ? Math.min(100, Math.round((Number(m.my_progress) / Number(m.target_value)) * 100)) : null;
      rows.push(`<div class="mono post-result" style="color:var(--brass);">${esc(m.my_progress)}${m.target_value != null ? ` / ${esc(m.target_value)}` : ""}</div>`);
      if (pct != null) rows.push(`<div class="progress-track"><div style="width:${pct}%;"></div></div>`);
    }
    const result = `<div class="post-result-block"><div class="post-title">🏆 ${bidiText(m.challenge_title || post.title || "אתגר")}</div>
      ${rows.join("")}
      <div class="chip-row"><button class="chip-btn" data-community-action="open-challenge" data-id="${esc(m.challenge_id || post.source_id || "")}">פתיחת האתגר</button></div></div>`;
    return postCardShell(post, postCardBody(post, result), { authorless: !postAuthorName(post) });
  }
  // COMM-213: upgraded from the COMM-101 fallback link card to a real event
  // card, once the events cluster's own state.events.byId has the live row
  // (it is loaded in the same Promise.all as the feed, so this is the
  // common case). Falls back to the original metadata-only link card when
  // the event is not in cache yet (a cold feed load racing loadEvents()) or
  // no longer exists - a truthful degrade, never a broken render.
  function renderEventLinkCard(post) {
    const m = post.metadata || {};
    const ev = m.event_id ? state.events.byId[m.event_id] : null;
    if (ev) {
      const going = eventGoingCount(ev.id);
      const meta = [eventTypeBadge(ev.event_type), formatEventDate(ev.start_at), formatEventTime(ev.start_at)];
      if (ev.location) meta.push(ev.location);
      meta.push(participantsLabel(going));
      if (ev.status === "cancelled") meta.push("בוטל");
      const image = ev.image_url ? `<img src="${esc(ev.image_url)}" alt="" style="width:100%;max-height:160px;object-fit:cover;border-radius:10px;margin-top:6px;"/>` : "";
      // The event image is this card's MEDIA and keeps its place at the top,
      // ahead of the body, exactly as a post photo does - it is the same
      // "media first when present" rule, just media the events module owns.
      const result = `<div class="post-result-block"><div class="post-title">📅 ${bidiText(ev.title)}</div>
        <div style="color:var(--steel);font-size:12px;">${meta.map(bidiText).join(" · ")}</div>
        <div class="chip-row"><button class="chip-btn" data-community-action="open-event" data-id="${esc(ev.id)}">פתיחת האירוע</button></div></div>`;
      return postCardShell(post, image + postCardBody(post, result), { authorless: !postAuthorName(post) });
    }
    const when = m.starts_at ? String(m.starts_at).slice(0, 16).replace("T", " ") : "";
    const result = `<div class="post-result-block"><div class="post-title">📅 ${bidiText(m.event_title || post.title || "אירוע")}</div>
      ${when ? `<div style="color:var(--steel);font-size:12px;">${esc(when)}</div>` : ""}
      <div class="chip-row"><button class="chip-btn" data-community-action="open-event" data-id="${esc(m.event_id || post.source_id || "")}">פתיחת האירוע</button></div></div>`;
    return postCardShell(post, postCardBody(post, result), { authorless: !postAuthorName(post) });
  }

  // HOISTED OUT OF feedTab (2026-09-18), byte-for-byte, so the staff desktop
  // column can render the same archive the feed does instead of growing a
  // second, drifting copy of it. Same inputs, same markup, same
  // ANNOUNCEMENTS_ARCHIVE_VISIBLE cap and the same <details> disclosure past
  // it; `hasPinned` is the one thing the caller has to tell it, because "no
  // announcements" and "the only one is pinned above you" are different empty
  // states and only the caller knows which it is looking at.
  // `source` is the third argument the analytics pass added, and it is the
  // only thing the two callers disagree about: the member feed and the
  // desktop staff home render the identical archive from the identical rows.
  // Passed down onto the wrapper as a data attribute rather than held in a
  // variable, because the thing that records the view (noteAnnouncementsView,
  // cloud.js) learns the archive exists by finding it in the DOM - the same
  // "only this hook can see it is actually on screen" shape
  // noteClassmatesCardView already uses.
  function renderAnnouncementsArchive(otherAnnouncements, hasPinned, source) {
    const announcementRow = (a) => `<div class="log-row" data-announcement-id="${esc(a.id)}" style="align-items:flex-start;flex-direction:column;gap:4px;${announcementAccentStyle(a)}"><div style="font-weight:700;display:flex;align-items:center;flex-wrap:wrap;gap:6px;">${bidiText(a.title)}${announcementPriorityBadge(a)}</div><div style="color:var(--steel);font-size:13px;">${bidiText(a.body)}</div><div style="color:var(--steel);font-size:11px;">${esc(a.profiles ? (a.profiles.display_name || "@" + a.profiles.handle) : "")}</div>${pinToggleHtml("announcement", a.id, a.title)}</div>`;
    const visibleAnnouncements = otherAnnouncements.slice(0, ANNOUNCEMENTS_ARCHIVE_VISIBLE);
    const restAnnouncements = otherAnnouncements.slice(ANNOUNCEMENTS_ARCHIVE_VISIBLE);
    return otherAnnouncements.length
      ? `<div data-announcements-archive="ready" data-announcements-rows="${otherAnnouncements.length}" data-announcements-source="${esc(source || "feed")}"><div class="log-list">${visibleAnnouncements.map(announcementRow).join("")}</div>${restAnnouncements.length ? `<details style="margin-top:8px;"><summary class="link-btn" style="cursor:pointer;">עוד הודעות (${restAnnouncements.length})</summary><div class="log-list" style="margin-top:8px;">${restAnnouncements.map(announcementRow).join("")}</div></details>` : ""}</div>`
      : (hasPinned ? "" : `<div class="empty">אין הודעות חדשות</div>`);
  }
  function renderAnnouncementPostCard(post) {
    const m = post.metadata || {};
    const title = m.title || post.title || "";
    const inner = postMediaHtml(post) + `${title ? `<div class="post-title" style="color:var(--brass);">${bidiText(title)}</div>` : ""}` + postBodyHtml(post);
    // data-post-type="POST_ANNOUNCEMENT" (postCardShell, unchanged) is what
    // the card-level tint/border in index.html keys off - markIcon here only
    // replaces the head's own avatar mark, the two together are what makes a
    // club notice actually read as one at a glance instead of just another
    // .chart-card with an emoji typed into its title.
    return postCardShell(post, inner, { badge: "הודעת מועדון", authorless: !postAuthorName(post), markIcon: "📣" });
  }
  function renderCoachPostCard(post) {
    return postCardShell(post, postCardBody(post), { badge: "מאמן/ת" });
  }

  function renderNewMemberPostCard(post) {
    const m = post.metadata || {};
    const memberId = m.member_id || post.author_id || "";
    const memberName = m.member_name || postAuthorName(post) || "חבר/ה חדש/ה";
    const joined = m.joined_on || post.occurred_on || postTimestamp(post);
    const result = `<div class="post-result-block"><div class="post-title">👋 שמחים שהגעת למועדון</div>
      <div class="flex gap-10" style="align-items:center;margin-top:6px;">
        ${/* COMM-318: no avatar_url available here on purpose - post_new_member_on_join's metadata is stamped at redemption time, before the profile row usually even exists, so a photo could never be threaded through without a second live lookup for a rarely-seen card. Initials only, matching the club-logo exception. */ avatarHtml(memberName, 40)}
        <div>
          ${memberId ? `<button class="link-btn" data-community-action="view-profile" data-id="${esc(memberId)}" style="padding:0;font-weight:800;color:inherit;">${esc(memberName)}</button>` : `<div style="font-weight:800;">${esc(memberName)}</div>`}
          ${joined ? `<div style="color:var(--steel);font-size:12px;">${esc(String(joined).slice(0, 10))}</div>` : ""}
        </div>
      </div></div>`;
    const extra = `${memberId ? followButtonHtml(memberId) : ""}<button class="chip-btn" data-community-action="welcome-member" data-id="${esc(post.id)}">ברכה</button>`;
    return postCardShell(post, postCardBody(post, result), { extra, authorless: true, clubName: "המועדון", hideMenu: true });
  }

  // COMM-107: system notices read as club voice. No profile link, muted, no
  // More menu, reactions and comments disabled.
  function renderSystemPostCard(post) {
    return postCardShell(post, postBodyHtml(post), { authorless: true, clubName: "המועדון", hideMenu: true, engagementDisabled: true });
  }

  function renderUnknownPostCard(post) {
    return postCardShell(post, postCardBody(post), { unknown: true });
  }
  function renderErrorPostCard(post) {
    const authorId = post && post.author_id;
    return `<article class="chart-card post-card" data-post-type="${esc((post && post.post_type) || "UNKNOWN")}" data-post-error="1">
      <div class="empty">לא ניתן להציג את הפוסט הזה</div>
      ${authorId ? `<div class="chip-row"><button class="chip-btn" data-community-action="view-profile" data-id="${esc(authorId)}">מעבר לפרופיל</button></div>` : ""}
    </article>`;
  }
  // The loading card. Shaped like the card it stands in for - avatar, name,
  // time, a media block, two text lines and an action row - so the feed does
  // not visibly jump when the real rows land on top of it. Every block is
  // .skeleton-block, which is one token-built rule in index.html (and one
  // @media (prefers-reduced-motion) guard on its shimmer), not an inline
  // background repeated six times here.
  function renderPostCardSkeleton() {
    return `<article class="chart-card post-card" aria-hidden="true"><div class="post-head"><span class="avatar-badge skeleton-block" style="width:40px;height:40px;border-radius:50%;"></span><div class="post-head-text"><div class="skeleton-block" style="width:110px;height:12px;"></div><div class="skeleton-block" style="width:64px;height:10px;margin-top:6px;"></div></div></div><div class="skeleton-block" style="height:150px;border-radius:12px;margin-top:10px;"></div><div class="skeleton-block" style="height:11px;margin-top:12px;"></div><div class="skeleton-block" style="height:11px;width:70%;margin-top:7px;"></div><div class="skeleton-block" style="height:28px;width:150px;border-radius:999px;margin-top:14px;"></div></article>`;
  }

  const POST_CARD_RENDERERS = {
    POST_TEXT: renderTextPostCard,
    POST_PHOTO: renderPhotoPostCard,
    POST_WORKOUT: renderWorkoutPostCard,
    POST_PR: renderPrPostCard,
    POST_ACHIEVEMENT: renderAchievementPostCard,
    POST_ATTENDANCE_MILESTONE: renderAttendanceMilestonePostCard,
    // 202609080001. Registered HERE, in the one dispatch, which is what makes
    // renderPostCard branch on this type BEFORE renderWorkoutPostCard can see
    // it. That ordering is load-bearing rather than tidy: POST_CLUB_WOD rows
    // carry source_type and source_id NULL on purpose, and
    // renderWorkoutPostCard's deep link defaults a missing source_type to
    // "workout" - so a club-programming card that fell through to it would
    // render an "open the workout" button pointing at nothing. This card
    // opens the BOARD instead, off metadata.club_wod_session_id.
    POST_CLUB_WOD: renderClubWodPostCard,
    POST_CHALLENGE: renderChallengeLinkCard,
    POST_EVENT: renderEventLinkCard,
    POST_ANNOUNCEMENT: renderAnnouncementPostCard,
    POST_NEW_MEMBER: renderNewMemberPostCard,
    POST_COACH: renderCoachPostCard,
    POST_SYSTEM: renderSystemPostCard,
  };
  // COMM-101. One dispatch. Unknown type -> a minimal safe text card plus a
  // warning, never a throw. A renderer that throws -> an error card.
  function renderPostCard(post) {
    if (!post || typeof post !== "object") return renderErrorPostCard(null);
    try {
      const renderer = POST_CARD_RENDERERS[post.post_type];
      if (!renderer) {
        if (typeof console !== "undefined" && console.warn) console.warn("[posts] unknown post_type, using a plain text card:", post.post_type);
        return renderUnknownPostCard(post);
      }
      return renderer(post);
    } catch (err) {
      if (typeof console !== "undefined" && console.error) console.error("[posts] renderPostCard failed for", post && post.post_type, err);
      return renderErrorPostCard(post);
    }
  }
  window.renderPostCard = renderPostCard;

  // ---- Composer (COMM-102, COMM-103) --------------------------------------
  // `withPhoto` is the feed composer row's camera button and nothing else: it
  // opens the SAME composer, through the same state, and then reaches for the
  // photo control the composer already has. No second upload path, no second
  // file input - composerAddPhoto/prepareImage/uploadPreparedPhoto are
  // untouched, which is the whole point of routing the button here rather
  // than giving the feed row a file input of its own that would have to
  // re-do EXIF stripping, the failed-tile retry and the alt-text field.
  function openComposer(triggerEl, withPhoto) {
    state.posts.composerTrigger = triggerEl || null;
    state.posts.composer = { body: "", visibility: "club", photos: [], links: {}, error: "", publishing: false };
    state.posts.openMenu = null;
    rerender();
    setTimeout(() => {
      if (withPhoto) {
        // The picker, not the textarea: a member who tapped the camera asked
        // for a photo first. Wrapped because a browser that refuses the
        // synthetic click (no transient activation left) must still leave a
        // usable composer open rather than throw on the way out - the
        // "הוספת תמונה" control is right there either way.
        const f = document.querySelector("[data-composer-file]");
        if (f && f.click) { try { f.click(); } catch (e) { /* activation expired; the visible control still works */ } }
      }
      const t = document.querySelector("[data-composer-body]");
      if (t && t.focus) t.focus();
    }, 0);
  }
  window.openPostComposer = openComposer;
  function closeComposer() {
    const trigger = state.posts.composerTrigger;
    state.posts.composer = null;
    state.posts.composerTrigger = null;
    rerender();
    if (trigger && trigger.focus) setTimeout(() => trigger.focus(), 0);
  }
  function tryCloseComposer() {
    if (state.posts.composer && (cleanPostBody(state.posts.composer.body) || state.posts.composer.photos.length)) {
      askConfirm({ title: "לבטל את הפוסט?", message: "מה שכתבתם לא יישמר.", confirmLabel: "ביטול הפוסט", destructive: true, action: "composer-discard" });
    } else {
      closeComposer();
    }
  }
  function composerSetBody(v) {
    if (!state.posts.composer) return;
    state.posts.composer.body = v;
    const dlg = document.getElementById("postComposer");
    if (!dlg) return;
    const btn = dlg.querySelector('[data-community-action="composer-publish"]');
    if (btn) btn.disabled = !composerCanPublish();
    const c = dlg.querySelector("[data-composer-counter]");
    if (c) { const n = cleanPostBody(v).length; c.textContent = n >= 900 ? `${n}/${POST_BODY_MAX}` : ""; }
  }
  function composerSetAlt(id, v) {
    if (!state.posts.composer) return;
    const p = state.posts.composer.photos.find((x) => x.id === id);
    if (p) p.altText = v;
    const dlg = document.getElementById("postComposer");
    if (dlg) { const btn = dlg.querySelector('[data-community-action="composer-publish"]'); if (btn) btn.disabled = !composerCanPublish(); }
  }
  function composerToggleDecorative(id, checked) {
    if (!state.posts.composer) return;
    const p = state.posts.composer.photos.find((x) => x.id === id);
    if (p) { p.decorative = !!checked; if (checked) p.altText = ""; }
    rerender();
  }
  function composerSetVisibility(v) {
    if (state.posts.composer && POST_VISIBILITY_OPTIONS.some((o) => o.value === v)) state.posts.composer.visibility = v;
  }
  function composerRemovePhoto(id) {
    if (!state.posts.composer) return;
    state.posts.composer.photos = state.posts.composer.photos.filter((p) => p.id !== id);
    rerender();
  }
  function composerRetryPhoto(id) {
    if (!state.posts.composer) return;
    const p = state.posts.composer.photos.find((x) => x.id === id);
    const file = p && p._file;
    composerRemovePhoto(id);
    if (file) composerAddPhoto(file);
  }
  // COMM-103. Every photo goes through prepareImage (COMM-015) before upload.
  async function composerAddPhoto(file) {
    if (!state.posts.composer) return;
    if (state.posts.composer.photos.length >= POST_MEDIA_MAX) { state.posts.composer.error = `אפשר לצרף עד ${POST_MEDIA_MAX} תמונות`; return rerender(); }
    const id = "ph" + Date.now() + Math.random().toString(36).slice(2, 6);
    const photo = { id, status: "processing", altText: "", decorative: false, storagePath: null, previewUrl: null, error: null, width: null, height: null, _file: file };
    state.posts.composer.photos.push(photo);
    state.posts.composer.error = "";
    rerender();
    try {
      const prepared = await window.HaimuniaImage.prepareImage(file);
      try {
        if (prepared.thumbnail && prepared.thumbnail.blob && typeof URL !== "undefined" && URL.createObjectURL) photo.previewUrl = URL.createObjectURL(prepared.thumbnail.blob);
      } catch (e) { photo.previewUrl = null; }
      const path = await uploadPreparedPhoto(prepared);
      if (!path) throw new Error("upload_failed");
      photo.storagePath = path;
      photo.width = (prepared.render && prepared.render.width) || null;
      photo.height = (prepared.render && prepared.render.height) || null;
      photo.status = "ready";
      // The post_photos module's one event, and the reason it is HERE rather
      // than at the publish: post_created already carries has_media, so the
      // question this answers is the one that prop cannot - how often a member
      // starts attaching a photo at all, including the drafts that are never
      // published and the uploads that fail. Recorded on the ready branch
      // only, so a failed upload is not counted as an attached photo.
      //
      // photo_count is the number of photos on the draft once this one landed,
      // which is how "do members use the multi-photo composer or just the one"
      // gets answered without a second name. Never the storage path, never the
      // alt text a member typed.
      track(A.POST_PHOTO_ATTACHED, { source: "composer", photo_count: state.posts.composer ? state.posts.composer.photos.length : 1 });
    } catch (err) {
      photo.status = "failed";
      photo.error = err && err.code === "not_an_image" ? "הקובץ אינו תמונה" : "העלאת התמונה נכשלה";
    }
    rerender();
  }
  async function uploadPreparedPhoto(prepared) {
    if (!state.user || !prepared || !prepared.render || !prepared.render.blob) return null;
    const type = prepared.render.type || "image/webp";
    const ext = type === "image/png" ? "png" : type === "image/jpeg" ? "jpg" : "webp";
    const path = `${state.user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await client.storage.from("post-photos").upload(path, prepared.render.blob, { contentType: type, upsert: false });
    return error ? null : path;
  }
  // COMM-318. Extracts the storage path ({uid}/avatar.{ext}) from a stored,
  // cache-busted avatar_url so a re-upload can best-effort remove the old
  // object when the resolved extension changed. Best-effort only: a parse
  // miss (unfamiliar URL shape, no match) is not an error, it just skips
  // the cleanup - the new upload has already succeeded either way.
  function avatarPathFromUrl(url) {
    const m = /\/avatar-photos\/([^?]+)/.exec(String(url || ""));
    return m ? m[1] : null;
  }
  // Avatar-sized, not the composer's 1600px feed-photo default: maxEdge 320,
  // no separate thumbnail (thumbEdges:[] - the render itself is already
  // small), a 60KB target with a 300KB hard cap. Deterministic overwrite
  // path (upsert:true) rather than post-photos' unique-per-upload pattern -
  // an avatar is one-per-member by convention, nothing accumulates.
  async function uploadAvatarPhoto(file) {
    if (!state.user) return null;
    const prepared = await window.HaimuniaImage.prepareImage(file, {
      maxEdge: 320, thumbEdges: [], targetBytes: 60 * 1024, hardCapBytes: 300 * 1024,
    });
    if (!prepared || !prepared.render || !prepared.render.blob) return null;
    const type = prepared.render.type || "image/webp";
    const ext = type === "image/png" ? "png" : type === "image/jpeg" ? "jpg" : "webp";
    const prevPath = state.profile ? avatarPathFromUrl(state.profile.avatar_url) : null;
    const path = `${state.user.id}/avatar.${ext}`;
    const { error } = await client.storage.from("avatar-photos").upload(path, prepared.render.blob, { contentType: type, upsert: true });
    if (error) return null;
    // Best-effort: only reached when the extension actually changed (a
    // same-extension re-upload already overwrote the object in place via
    // upsert:true above, there is nothing stale to remove).
    if (prevPath && prevPath !== path) client.storage.from("avatar-photos").remove([prevPath]).catch(() => {});
    const { data } = client.storage.from("avatar-photos").getPublicUrl(path);
    // Still getPublicUrl(), on a bucket that has been PRIVATE since
    // 202609060003. That is deliberate and is not a leftover: this string is
    // now an IDENTIFIER for the object, not a fetchable URL. Hitting it
    // directly 400s, which is the entire point of the bucket flip; the bytes
    // are served through a short-lived signed URL that avatarHtml() resolves
    // at render time. Keeping this exact shape means every already-stored
    // row stays valid, avatarPathFromUrl() keeps parsing, and the column
    // keeps satisfying its ^https?:// CHECK (202609060006). getPublicUrl()
    // makes no network call - it only formats.
    //
    // Cache-busting belongs on the STORED url, not the bare getPublicUrl()
    // result - overwriting the same storage path means a re-upload could
    // otherwise silently fail to visibly update anywhere without it. It is
    // also what keys the signed-URL cache, so the stamp is what makes a
    // re-upload resolve to fresh bytes rather than the previous signature.
    return (data && data.publicUrl) ? `${data.publicUrl}?t=${Date.now()}` : null;
  }
  // Fires immediately on upload success or remove, matching
  // savePrivacyField's immediate-save pattern (a photo change is already a
  // committed action the moment the bytes are in Storage) rather than
  // saveProfile's bundled-into-form-submit pattern.
  // UPDATE, NOT UPSERT - and that is the whole bug this once had.
  //
  // Saving an avatar used to .upsert() this row. The row always already
  // exists here (the function returns early without state.profile), so the
  // insert half was never needed - but Postgres still evaluates the INSERT
  // policy's WITH CHECK on the proposed tuple for an INSERT ... ON CONFLICT.
  // profiles_insert_self (202608280003:214) requires `recovery_verified_at is
  // null` - it exists to stop a member re-creating a verified profile row -
  // so the policy that protects account recovery was refusing photo uploads
  // for exactly the members who had completed recovery. Reported from a real
  // device as "can't add profile pic", with only "שמירת התמונה נכשלה" to go
  // on. An update touches one column and needs only profiles_update_self.
  //
  // The error is now REPORTED rather than swallowed. The old message named
  // the failure and not its cause, which is why this took a screenshot from
  // production to find at all: serverErrorText() turns a Postgres error into
  // something a member can act on, and anything it does not recognise still
  // beats a dead end.
  async function saveAvatarUrl(url) {
    if (!state.user || !state.profile) return false;
    const prev = state.profile.avatar_url;
    state.profile.avatar_url = url || null;
    rerender();
    const { error } = await client.from("profiles").update({ avatar_url: url || null }).eq("id", state.user.id);
    if (error) {
      state.profile.avatar_url = prev;
      setMessage(serverErrorText(error) || "שמירת התמונה נכשלה");
      rerender();
      return false;
    }
    return true;
  }
  async function avatarPhotoSelected(file) {
    if (!file || !state.user) return;
    state.avatarUpload = { status: "processing", error: "" };
    rerender();
    let url;
    try {
      url = await uploadAvatarPhoto(file);
    } catch (err) {
      state.avatarUpload = { status: "idle", error: (err && err.code === "not_an_image") ? "הקובץ אינו תמונה" : "העלאת התמונה נכשלה" };
      return rerender();
    }
    if (!url) { state.avatarUpload = { status: "idle", error: "העלאת התמונה נכשלה" }; return rerender(); }
    const ok = await saveAvatarUrl(url);
    state.avatarUpload = { status: "idle", error: ok ? "" : "" };
    rerender();
  }
  async function removeAvatarPhoto() {
    if (!state.user || !state.profile || !state.profile.avatar_url || state.avatarUpload.status === "processing") return;
    const path = avatarPathFromUrl(state.profile.avatar_url);
    state.avatarUpload = { status: "processing", error: "" };
    rerender();
    const ok = await saveAvatarUrl(null);
    if (ok && path) client.storage.from("avatar-photos").remove([path]).catch(() => {});
    state.avatarUpload = { status: "idle", error: "" };
    rerender();
  }
  function composerReadyPhotos() { return state.posts.composer ? state.posts.composer.photos.filter((p) => p.status === "ready") : []; }
  function composerCanPublish() {
    const c = state.posts.composer;
    if (!c || c.publishing) return false;
    if (c.photos.some((p) => p.status === "processing" || p.status === "failed")) return false;
    if (c.photos.length > POST_MEDIA_MAX) return false;
    const ready = composerReadyPhotos();
    const hasText = cleanPostBody(c.body).length > 0;
    if (!hasText && ready.length === 0) return false;
    if (ready.some((p) => !p.decorative && !String(p.altText || "").trim())) return false;
    return true;
  }
  function composerBlockReason() {
    const c = state.posts.composer;
    if (!c) return "";
    if (c.photos.some((p) => p.status === "processing")) return "יש להמתין לסיום עיבוד התמונות";
    if (c.photos.some((p) => p.status === "failed")) return "יש להסיר או לנסות שוב תמונה שנכשלה";
    if (composerReadyPhotos().some((p) => !p.decorative && !String(p.altText || "").trim())) return "יש להוסיף תיאור לכל תמונה או לסמן אותה כדקורטיבית";
    return "צריך טקסט או לפחות תמונה אחת";
  }
  async function publishComposer() {
    const c = state.posts.composer;
    if (!c || c.publishing) return;
    if (!composerCanPublish()) { c.error = composerBlockReason(); return rerender(); }
    c.publishing = true;
    c.error = "";
    rerender();
    const body = cleanPostBody(c.body);
    const media = composerReadyPhotos().map((p, i) => ({
      storage_path: p.storagePath,
      alt_text: p.decorative ? "" : String(p.altText || "").slice(0, ALT_TEXT_MAX),
      decorative: !!p.decorative,
      position: i,
      width: p.width || null,
      height: p.height || null,
    }));
    const links = {};
    if (c.links) {
      if (c.links.workout_id) links.workout_id = c.links.workout_id;
      if (c.links.achievement_id) links.achievement_id = c.links.achievement_id;
      if (c.links.event_id) links.event_id = c.links.event_id;
    }
    const { data, error, queued } = await communityRpc("post_create", {
      body,
      visibility: c.visibility,
      media,
      links: Object.keys(links).length ? links : null,
    });
    if (queued) {
      // Offline: the post is persisted in the community outbox with its own
      // idempotency key and will go out on reconnect. Close the composer as
      // if it had published - the member's text is safe, which is the thing
      // that used to be lost here - and say plainly that it is waiting.
      c.publishing = false;
      closeComposer();
      await refreshOutboxState();
      setMessage("אין חיבור — הפוסט יפורסם כשהחיבור יחזור");
      return rerender();
    }
    if (error || !data) {
      c.publishing = false;
      // SAY WHY, when the server said why. Live bug hunt, fresh round 8
      // (2026-09-15) - HIGH.
      //
      // This ignored `error` entirely and always said "failed, you can try
      // again". For a member the club had restricted from posting, that is
      // both wrong and cruel: the restriction does not lift on retry, and the
      // app was telling them to keep trying. rate_limited and every content
      // refusal were flattened the same way.
      //
      // The comment box beside it already maps the identical server strings
      // through commentErrorMessage(), and the offline outbox banner shows
      // the right text for THIS RPC when the write is queued instead. The
      // header above SERVER_ERROR_TEXT documents this exact failure - "how a
      // moderated member found out they had been sanctioned" - as the reason
      // that table exists. This path simply never called it.
      //
      // failText() keeps the domain sentence for anything unrecognised, so an
      // unknown server error still reads as a post that failed rather than as
      // a bare English string.
      c.error = failText("פרסום הפוסט נכשל, אפשר לנסות שוב", error);
      return rerender();
    }
    // COMM-102 optimistic insert. feed_page (COMM-110) is authoritative on the
    // next refresh; the legacy community_feed view does not carry post_type,
    // so we do not reload it here.
    const optimistic = {
      id: data,
      post_type: media.length && !body ? "POST_PHOTO" : "POST_TEXT",
      author_id: state.user.id,
      author: { display_name: state.profile && state.profile.display_name, handle: state.profile && state.profile.handle, avatar_url: state.profile && state.profile.avatar_url },
      body,
      visibility: c.visibility,
      created_at: new Date().toISOString(),
      media: media.map((m) => ({ ...m, url: null })),
      reaction_count: 0,
      comment_count: 0,
    };
    if (Array.isArray(state.feed.items)) state.feed.items.unshift(optimistic);
    state.posts.composer = null;
    state.posts.composerTrigger = null;
    setMessage("הפוסט פורסם");
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.POST_CREATED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.POST_CREATED, { post_id: data, post_type: optimistic.post_type }); } catch (e) {}
    }
    rerender();
  }
  function renderPostComposer() {
    const c = state.posts.composer;
    if (!c) return "";
    const bodyLen = cleanPostBody(c.body).length;
    const canPublish = composerCanPublish();
    // Five-persona UX audit, defect 5, as re-scoped by QA. Filed as "an
    // unstyled checkbox", which it was not: index.html:1014 sets
    // `input[type="checkbox"]{ accent-color: var(--energy) }` as a BARE
    // ELEMENT selector, so every checkbox in the app is styled and none of
    // them can individually miss it.
    //
    // The real outlier was LAYOUT. The "image is decorative" row below was
    // the one checkbox label in this file on `class="flex gap-6"` WITHOUT
    // the shared `field` wrapper every other one uses, carrying bare text
    // after the input where its siblings carry a <span>. Missing `field`
    // cost it `.field + .field{margin-top:10px}` - it hand-rolled
    // margin-top:4px instead - so it sat a half-step tighter and a half-step
    // out of line against the alt-text field directly above it inside the
    // same tile. Now the same shape as all four of its siblings: the two
    // publishNow rows, teamAuto and pinToday.
    const tiles = c.photos.map((p) => `
      <div class="composer-photo-tile" data-photo-id="${esc(p.id)}" style="border:1px solid var(--border);border-radius:12px;padding:8px;margin-bottom:8px;">
        <div class="flex" style="justify-content:space-between;align-items:center;gap:8px;">
          <span style="font-size:12px;color:var(--steel);">${p.status === "processing" ? "מעבד תמונה…" : p.status === "failed" ? esc(p.error || "נכשל") : "תמונה מוכנה"}</span>
          <button class="link-btn" data-community-action="composer-remove-photo" data-id="${esc(p.id)}" aria-label="הסרת תמונה">הסרה</button>
        </div>
        ${p.previewUrl ? `<img src="${esc(p.previewUrl)}" alt="" style="max-width:100%;border-radius:8px;margin:6px 0;"/>` : ""}
        ${p.status === "failed" ? `<button class="chip-btn" data-community-action="composer-retry-photo" data-id="${esc(p.id)}">ניסיון חוזר</button>` : ""}
        <label class="field" style="margin-top:6px;"><span class="field-label">תיאור לקורא מסך</span>
          <input class="text-input" type="text" maxlength="${ALT_TEXT_MAX}" data-composer-alt="${esc(p.id)}" value="${esc(p.altText || "")}"${p.decorative ? " disabled" : ""} placeholder="תיאור קצר של התמונה"/></label>
        <label class="field flex gap-6" style="align-items:center;"><input type="checkbox" data-composer-decorative="${esc(p.id)}"${p.decorative ? " checked" : ""}/><span style="font-size:12.5px;color:var(--steel);">התמונה דקורטיבית, אין צורך בתיאור</span></label>
      </div>`).join("");
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="postComposerTitle" data-composer-overlay data-cloud-dialog="composer" style="align-items:center;padding:0 16px;">
      <div class="modal-sheet" id="postComposer" style="border-radius:22px;max-height:90vh;overflow:auto;">
        <div style="padding:22px 20px calc(env(safe-area-inset-bottom,0px) + 18px);">
          <h2 id="postComposerTitle" style="margin-top:0;color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:12px;">פוסט חדש</h2>
          <label class="field"><span class="field-label">מה תרצו לשתף?</span>
            <textarea class="text-input" data-composer-body maxlength="${POST_BODY_MAX}" rows="4" placeholder="כתבו משהו לקהילה" aria-describedby="postComposerCounter">${esc(c.body || "")}</textarea></label>
          <div id="postComposerCounter" data-composer-counter style="text-align:left;font-size:11px;color:var(--steel);min-height:14px;">${bodyLen >= 900 ? `${bodyLen}/${POST_BODY_MAX}` : ""}</div>
          <div style="margin-top:8px;">${tiles}</div>
          ${c.photos.length < POST_MEDIA_MAX
            ? (isModuleEnabled("post_photos") ? `<label class="chip-btn" style="cursor:pointer;display:inline-block;">הוספת תמונה<input type="file" accept="image/*" data-composer-file class="file-input-hidden"/></label>` : "")
            : `<div style="font-size:12px;color:var(--steel);">הגעתם למקסימום ${POST_MEDIA_MAX} תמונות</div>`}
          <label class="field" style="margin-top:12px;"><span class="field-label">מי רואה את הפוסט</span>
            <select class="text-input" data-composer-visibility>
              ${POST_VISIBILITY_OPTIONS.map((o) => `<option value="${o.value}"${c.visibility === o.value ? " selected" : ""}>${o.label}</option>`).join("")}
            </select></label>
          ${c.error ? `<div class="field-error" role="alert" style="margin-top:8px;">${esc(c.error)}</div>` : ""}
          <div class="chip-row" style="margin-top:16px;">
            <button class="chip-btn" data-community-action="composer-cancel">ביטול</button>
            <button class="chip-btn primary" data-community-action="composer-publish"${canPublish ? "" : " disabled"}>${c.publishing ? "מפרסם…" : "פרסום"}</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  // ---- Per-post action menu (COMM-108) ----------------------------------
  function togglePostMenu(id) {
    state.posts.openMenu = state.posts.openMenu === id ? null : id;
    rerender();
  }
  async function postSaveToggle(postId) {
    if (!state.user) return;
    state.posts.openMenu = null;
    state.posts.savedIds = state.posts.savedIds || {};
    const wasSaved = !!state.posts.savedIds[postId];
    if (wasSaved) {
      delete state.posts.savedIds[postId];
      rerender();
      const { error } = await client.from("saved_posts").delete().eq("user_id", state.user.id).eq("post_id", postId);
      if (error) { state.posts.savedIds[postId] = true; setMessage(failText("לא ניתן לעדכן את השמורים", error)); rerender(); }
      else setMessage("הוסר מהשמורים");
    } else {
      state.posts.savedIds[postId] = true;
      rerender();
      const { error } = await client.from("saved_posts").insert({ user_id: state.user.id, post_id: postId });
      if (error && error.code !== "23505") { delete state.posts.savedIds[postId]; setMessage("לא ניתן לשמור את הפוסט"); rerender(); }
      else setMessage("הפוסט נשמר");
    }
  }
  async function postHide(postId) {
    if (!state.user) return;
    state.posts.openMenu = null;
    if (Array.isArray(state.feed.items)) state.feed.items = state.feed.items.filter((p) => p && p.id !== postId);
    rerender();
    const { error } = await client.from("hidden_posts").insert({ user_id: state.user.id, post_id: postId });
    if (error && error.code !== "23505") setMessage("לא ניתן להסתיר את הפוסט");
    else setMessage("הפוסט הוסתר מהפיד שלך");
  }
  function postStartCaptionEdit(postId) {
    state.posts.openMenu = null;
    const post = findFeedPost(postId);
    state.posts.captionEdit = { postId, body: (post && post.body) || "" };
    state.posts.visibilityEdit = null;
    rerender();
  }
  async function postSaveCaption() {
    const e = state.posts.captionEdit;
    if (!e) return;
    const body = cleanPostBody(e.body);
    // A TEXT-ONLY POST CANNOT BE EMPTIED. Live bug hunt, fresh round 3
    // (2026-09-15): the save button stayed enabled on an emptied caption and
    // fired the RPC anyway. The server refuses it ("a post needs text or at
    // least one photo", 202609060007), so today the member only sees a failed
    // round trip - but this repo's own history includes production running
    // twenty migrations behind the code, and a guard that exists only in a
    // migration is a guard that can be absent in production. Every sibling
    // editor already checks locally: saveCommentEdit() refuses an empty
    // comment, and the composer disables Publish for empty text with no
    // photo. This is the one that did not.
    const post = findFeedPost(e.postId);
    const hasPhoto = !!(post && Array.isArray(post.media) && post.media.length);
    if (!body && !hasPhoto) {
      e.error = "אי אפשר לשמור פוסט ריק";
      rerender();
      return;
    }
    const { error } = await client.rpc("post_edit_caption", { post_id: e.postId, body });
    if (error) { setMessage(failText("עריכת הכיתוב נכשלה", error)); return; }
    if (post) post.body = body;
    state.posts.captionEdit = null;
    setMessage("הכיתוב עודכן");
    rerender();
  }
  function postStartVisibilityEdit(postId) {
    state.posts.openMenu = null;
    const post = findFeedPost(postId);
    state.posts.visibilityEdit = { postId, visibility: normalizeVisibility(post && post.visibility) };
    state.posts.captionEdit = null;
    rerender();
  }
  async function postApplyVisibility(visibility) {
    const e = state.posts.visibilityEdit;
    if (!e || !POST_VISIBILITY_OPTIONS.some((o) => o.value === visibility)) return;
    const { error } = await client.rpc("post_set_visibility", { post_id: e.postId, visibility });
    if (error) { setMessage(failText("שינוי הנראוּת נכשל", error)); return; }
    const post = findFeedPost(e.postId);
    if (post) post.visibility = visibility;
    state.posts.visibilityEdit = null;
    setMessage("הנראוּת עודכנה");
    rerender();
  }
  // The second half of the twin deletePost() names above. The optimistic
  // hide was already here — it just ran AFTER the RPC returned, so there was
  // nothing to undo by the time the post left the screen. It now runs first
  // and the RPC is what waits.
  async function postDeleteViaMenu(postId) {
    const snapshot = Array.isArray(state.feed.items) ? state.feed.items.slice() : null;
    deferCommunityDelete({
      label: "הפוסט נמחק",
      remove: () => { if (snapshot) state.feed.items = state.feed.items.filter((p) => p && p.id !== postId); },
      restore: () => { if (snapshot) state.feed.items = snapshot; },
      commit: async () => {
        const { error } = await client.rpc("post_delete", { post_id: postId });
        if (error) { if (snapshot) state.feed.items = snapshot; rerender(); return setMessage(failText("מחיקת הפוסט נכשלה", error)); }
        rerender();
      },
    });
  }
  const WELCOME_TEMPLATE_BODY = "שמחים שהגעת למועדון! 💪";
  // Live bug hunt (2026-09-11): two entry points share this write
  // (coachWelcomeMember() below, from the coach dashboard; and the direct
  // "welcome-member" tap on a new-member feed card) and NEITHER guarded
  // against a duplicate send - the dashboard's own busy flag only covered
  // one in-flight call, not "already sent, ever", and the feed-card path
  // had no guard at all. A coach could spam unlimited duplicate welcome
  // comments on the same member. The check belongs here, in the one shared
  // write path, so both callers are covered rather than fixing one and
  // leaving the other exactly as broken. welcomeBusy is keyed by postId,
  // same in-flight-guard shape as reactionBusy/followBusy elsewhere.
  // Returns true when the post ends this call in a "welcomed" state
  // (already was, or just now succeeded) so coachWelcomeMember() can update
  // its own proactive welcomed map; false on a real failure.
  const welcomeBusy = {};
  async function welcomeNewMember(postId, welcomeSource) {
    if (!state.user || welcomeBusy[postId]) return false;
    welcomeBusy[postId] = true;
    const already = await client.from("post_comments").select("id").eq("post_id", postId).eq("body", WELCOME_TEMPLATE_BODY).limit(1);
    if (already.data && already.data.length) {
      delete welcomeBusy[postId];
      return true;
    }
    const { error } = await client.rpc("add_post_comment", { p_post_id: postId, p_body: WELCOME_TEMPLATE_BODY });
    delete welcomeBusy[postId];
    // The welcome_flow module's one event. AFTER the write, like every other
    // write-backed name, so a failed welcome is never counted as one - and
    // only on the branch that actually wrote: the already-welcomed early
    // return above leaves this unreached, which is what keeps the count at
    // one welcome per new member rather than one per tap.
    //
    // It counts for WCAM. This path writes a real comment and bypasses the
    // composer, so no COMMENT_CREATED bus event is emitted for it - without
    // this line a coach whose only community act that week was welcoming
    // three newcomers was not an active member of their own club.
    //
    // `source` is the only prop. Never the welcomed member's id: who was
    // greeted is the newcomer's business, and the count of greetings is
    // what the module switch is judged on.
    if (!error) track(A.WELCOME_SENT, { source: welcomeSource || "feed_card" });
    if (!error && typeof loadCommentsFor === "function") loadCommentsFor(postId);
    return !error;
  }

  // ---- PR share prompt (COMM-105) --------------------------------------
  const PR_PROMPT_DISMISSED_KEY = "haimunia-demo:prPromptDismissed";
  function prPromptDismissedSet() {
    try { return new Set(JSON.parse(localStorage.getItem(PR_PROMPT_DISMISSED_KEY) || "[]")); } catch (e) { return new Set(); }
  }
  function rememberPrDismissed(recordId) {
    try {
      const s = prPromptDismissedSet();
      s.add(String(recordId));
      localStorage.setItem(PR_PROMPT_DISMISSED_KEY, JSON.stringify(Array.from(s).slice(-200)));
    } catch (e) {}
  }
  // Fresh-eyes audit, regular-member persona: `trivial` (see onPrCreated's
  // own comment below) only covers a movement's first few entries - once
  // past that, this fires on EVERY set that edges past the prior best,
  // which for anyone on a genuine, active upward trend (the exact member
  // this feature is supposed to serve) is nearly every session. Reported
  // as "stopped feeling special by session 4." A per-MOVEMENT cooldown
  // keeps the feature honest without touching the underlying PR detection
  // (which stays correct for the chart/badges/challenges, same reasoning
  // as trivial's own scoping) - a real once-a-week milestone still gets
  // asked about; a 1kg edge every single session does not.
  const PR_PROMPT_MOVEMENT_COOLDOWN_KEY = "haimunia-demo:prPromptMovementLastShown";
  const PR_PROMPT_MOVEMENT_COOLDOWN_DAYS = 7;
  function prPromptMovementLastShownMap() {
    try { return JSON.parse(localStorage.getItem(PR_PROMPT_MOVEMENT_COOLDOWN_KEY) || "{}"); } catch (e) { return {}; }
  }
  function prPromptOnCooldownFor(movement) {
    if (!movement) return false;
    const last = prPromptMovementLastShownMap()[movement];
    if (!last) return false;
    return (Date.now() - new Date(last).getTime()) < PR_PROMPT_MOVEMENT_COOLDOWN_DAYS * 86400000;
  }
  function rememberPrPromptShownForMovement(movement) {
    if (!movement) return;
    try {
      const m = prPromptMovementLastShownMap();
      m[movement] = new Date().toISOString();
      // Capped the same way prPromptDismissedSet() caps its own list, so a
      // member who logs many distinct movements over years never grows
      // this without bound - drops the oldest entries first.
      const keys = Object.keys(m);
      if (keys.length > 200) {
        keys.sort((a, b) => m[a].localeCompare(m[b]));
        for (const k of keys.slice(0, keys.length - 200)) delete m[k];
      }
      localStorage.setItem(PR_PROMPT_MOVEMENT_COOLDOWN_KEY, JSON.stringify(m));
    } catch (e) {}
  }
  // Consumes PR_CREATED from the event bus (COMM-012). Detection itself is the
  // achievements agent's COMM-132; this only reacts to the record it passes.
  //
  // Fresh-eyes audit: this used to open unconditionally, so a member's
  // literal first-ever logged set - nothing yet to compare against - got
  // offered a "share this PR with the club?" prompt, stacked right behind
  // the achievement-unlock celebration for the same non-event. app.js now
  // marks a record `trivial` using the identical MIN_ENTRIES_BEFORE_PR rule
  // its own full-screen celebration already applies (see saveSet()); this
  // is the one consumer of PR_CREATED that must honor it, since it is pure
  // praise/invitation-to-share. onPrCreatedForChallenges, the event's other
  // consumer, deliberately does not check this field - challenge progress
  // must stay correct regardless of how many prior sets happen to be on
  // file. The per-movement cooldown below is the same idea applied a
  // second time, for members past the trivial window (see its own comment).
  function onPrCreated(payload) {
    const record = payload && (payload.record || payload);
    if (!record) return;
    if (record.trivial) return;
    const recordId = record.record_id || record.id;
    if (!recordId) return;
    if (prPromptDismissedSet().has(String(recordId))) return;
    if (prPromptOnCooldownFor(record.movement)) return;
    if (!window.isCommunitySignedIn || !window.isCommunitySignedIn()) return;
    state.posts.prPrompt = { record: Object.assign({}, record, { record_id: recordId }), note: "", showNote: false, photo: null, publishing: false, error: "" };
    rememberPrPromptShownForMovement(record.movement);
    rerender();
  }
  function dismissPrPrompt() {
    if (state.posts.prPrompt) rememberPrDismissed(state.posts.prPrompt.record.record_id);
    state.posts.prPrompt = null;
    rerender();
  }
  async function prPromptAddPhoto(file) {
    const p = state.posts.prPrompt;
    if (!p) return;
    p.photo = { status: "processing", altText: "", decorative: false, storagePath: null, error: null, width: null, height: null, _file: file };
    rerender();
    try {
      const prepared = await window.HaimuniaImage.prepareImage(file);
      const path = await uploadPreparedPhoto(prepared);
      if (!path) throw new Error("upload_failed");
      p.photo.storagePath = path;
      p.photo.width = (prepared.render && prepared.render.width) || null;
      p.photo.height = (prepared.render && prepared.render.height) || null;
      p.photo.status = "ready";
      // The second of the two composers that can attach a photo (posts.js
      // renders both; the module toggle hides both). Same name, different
      // source - one photo is all this one holds, hence the literal 1.
      track(A.POST_PHOTO_ATTACHED, { source: "pr_prompt", photo_count: 1 });
    } catch (err) {
      p.photo.status = "failed";
      p.photo.error = err && err.code === "not_an_image" ? "הקובץ אינו תמונה" : "העלאת התמונה נכשלה";
    }
    rerender();
  }
  async function sharePrPrompt() {
    const p = state.posts.prPrompt;
    if (!p || p.publishing) return;
    if (p.photo && p.photo.status === "processing") return;
    p.publishing = true;
    p.error = "";
    rerender();
    const media = p.photo && p.photo.status === "ready" && p.photo.storagePath
      ? [{ storage_path: p.photo.storagePath, alt_text: p.photo.decorative ? "" : String(p.photo.altText || "").slice(0, ALT_TEXT_MAX), decorative: !!p.photo.decorative, position: 0, width: p.photo.width || null, height: p.photo.height || null }]
      : [];
    const { data, error } = await client.rpc("pr_share", { record_id: p.record.record_id, note: cleanPostBody(p.note), media });
    if (error || !data) { p.publishing = false; p.error = "השיתוף נכשל, אפשר לנסות שוב"; return rerender(); }
    rememberPrDismissed(p.record.record_id);
    state.posts.prPrompt = null;
    setMessage("השיא שותף לקהילה");
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.POST_CREATED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.POST_CREATED, { post_id: data, post_type: "POST_PR" }); } catch (e) {}
    }
    rerender();
  }
  function renderPrSharePrompt() {
    const p = state.posts.prPrompt;
    if (!p) return "";
    const r = p.record;
    const line = (label, val) => (val != null && val !== "") ? `<div style="font-size:12.5px;color:var(--steel);">${esc(label)}: <span class="mono" style="color:var(--brass);">${esc(val)}</span></div>` : "";
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="prPromptTitle" data-cloud-dialog="prPrompt" style="align-items:center;padding:0 16px;">
      <div class="modal-sheet" id="prPrompt" style="border-radius:22px;max-height:90vh;overflow:auto;">
        <div style="padding:22px 20px calc(env(safe-area-inset-bottom,0px) + 18px);">
          <h2 id="prPromptTitle" style="margin-top:0;color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:6px;">שיא חדש זוהה. לשתף עם המועדון?</h2>
          <div style="display:inline-block;font-size:11px;font-weight:800;color:#0c0c0c;background:var(--brass);border-radius:999px;padding:2px 8px;margin-bottom:8px;">PR</div>
          ${line("תרגיל", r.movement || r.movement_name)}
          ${line("תוצאה חדשה", r.new_result || r.new_value)}
          ${line("תוצאה קודמת", r.previous_result || r.previous_value)}
          ${line("שיפור", r.improvement)}
          ${p.photo ? `<div style="font-size:12px;color:var(--steel);margin-top:6px;">${p.photo.status === "ready" ? "תמונה צורפה" : p.photo.status === "processing" ? "מעבד תמונה…" : esc(p.photo.error || "העלאת התמונה נכשלה")}</div>` : ""}
          ${p.photo && p.photo.status === "ready" && !p.photo.decorative ? `<label class="field" style="margin-top:6px;"><span class="field-label">תיאור התמונה לקורא מסך</span><input class="text-input" data-pr-alt maxlength="${ALT_TEXT_MAX}" value="${esc(p.photo.altText || "")}"/></label>` : ""}
          ${p.showNote ? `<label class="field" style="margin-top:8px;"><span class="field-label">הערה</span><textarea class="text-input" data-pr-note maxlength="${POST_BODY_MAX}" rows="3">${esc(p.note || "")}</textarea></label>` : ""}
          ${p.error ? `<div class="field-error" role="alert" style="margin-top:8px;">${esc(p.error)}</div>` : ""}
          <div class="chip-row" style="margin-top:14px;">
            <button class="chip-btn primary" data-community-action="pr-share"${p.publishing || (p.photo && p.photo.status === "processing") ? " disabled" : ""}>${p.publishing ? "משתף…" : "שיתוף למועדון"}</button>
            ${isModuleEnabled("outward_share") ? `<button class="chip-btn" data-community-action="outward-pr">שיתוף מחוץ לאפליקציה</button>` : ""}
            ${(p.photo || !isModuleEnabled("post_photos")) ? "" : `<label class="chip-btn" style="cursor:pointer;">הוספת תמונה<input type="file" accept="image/*" data-pr-file class="file-input-hidden"/></label>`}
            ${p.showNote ? "" : `<button class="chip-btn" data-community-action="pr-add-note">הוספת הערה</button>`}
            <button class="chip-btn" data-community-action="pr-not-now">לא עכשיו</button>
          </div>
        </div>
      </div>
    </div>`;
  }
