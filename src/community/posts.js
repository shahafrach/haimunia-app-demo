"use strict";

  // ---- The one workout-share write in the app ---------------------------------
  //
  // A workout post is an upsert on (author, circle, source type, source record):
  // the day's summary for one circle (src/community/circles.js builds the rows,
  // src/community/circles-core.js decides what each circle may receive). The
  // unique key is workout_posts_author_club_source_key (202610250005), and
  // every row carries its club_id: a post belongs to exactly one circle.
  //
  // This is the ONLY place the on-conflict target is spelled out. It is the
  // sibling of pr_share's "is this record already a post in THIS circle" lookup
  // on the server, and the two must name the same four columns.
  const WORKOUT_POST_CONFLICT = "author_id,club_id,source_type,source_record_id";
  function upsertWorkoutSharePost(row) {
    return client.from("workout_posts").upsert(row, { onConflict: WORKOUT_POST_CONFLICT });
  }
  // The queued action name. NOT in OUTBOX_ACTIONS, and for exactly the reason
  // ANALYTICS_OUTBOX_ACTION is not: that list is what communityRpc() consults,
  // every entry in it is an RPC name, and this one is a table upsert. It gets
  // its own handler in registerOutboxHandlers() (cloud.js) instead.
  //
  // The queue mints an idempotency key per row and this handler ignores it,
  // which is safe here and only here: the write is an upsert on a unique
  // key, so replaying it converges rather than duplicating.
  const WORKOUT_SHARE_OUTBOX_ACTION = "workout_share";
  // Returns { queued, error }. A row is queued, not lost, when the device is
  // offline or the server says slow down; it is the posted day, so replaying it
  // later is the same write.
  async function writeWorkoutSharePost(row) {
    const canQueue = !!(window.HaimuniaOutbox && typeof window.dbPutCommunityOutboxRow === "function");
    const enqueueOpts = { userId: state.user && state.user.id };
    if (canQueue && typeof navigator !== "undefined" && navigator.onLine === false) {
      await window.HaimuniaOutbox.enqueue(WORKOUT_SHARE_OUTBOX_ACTION, { row: row }, enqueueOpts);
      return { queued: true, error: null };
    }
    const { error } = await upsertWorkoutSharePost(row);
    if (error && canQueue && (isOfflineError(error) || /rate_limited/.test(String(error.message || "")))) {
      await window.HaimuniaOutbox.enqueue(WORKOUT_SHARE_OUTBOX_ACTION, { row: row }, enqueueOpts);
      return { queued: true, error: null };
    }
    if (error) trackWriteFailure(WORKOUT_SHARE_OUTBOX_ACTION, error);
    return { queued: false, error: error };
  }
  // The handler the queue drains this action with. Registered from cloud.js's
  // registerOutboxHandlers() beside the analytics one; defined here so the
  // upsert has one home.
  async function workoutShareOutboxHandler(args, row) {
    if (!client || !state.user) throw new Error("session expired");
    if (row && row.userId && row.userId !== state.user.id) throw new Error("session mismatch, queued for a different member");
    const payload = Object.assign({}, args && args.row);
    // Re-stamped rather than trusted: the row was built while this member was
    // offline, flush() and the check above already refuse a row belonging to
    // anybody else, and author_id is the column the unique key - and every
    // RLS policy on this table - is keyed on.
    payload.author_id = state.user.id;
    // A row queued by an older build has no circle. It cannot be sent anywhere
    // honest, so it fails visibly instead of guessing one.
    if (!payload.club_id) throw new Error("not found: no circle on this queued post");
    const { error } = await upsertWorkoutSharePost(payload);
    if (error) throw new Error(error.message || "workout share failed");
  }

  const POST_BODY_MAX = 1000;
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

  // Posts the client holds. Nothing loads them in this build: the ranked feed
  // that filled this list is gone, and the circle screen will fill it.
  function findFeedPost(id) { return Array.isArray(state.posts.held) ? state.posts.held.find((p) => p && p.id === id) : null; }
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
  // Authorless posts render the club mark, never a broken avatar (COMM-107).
  const CLUB_MARK_HTML = `<span aria-hidden="true" class="avatar-badge" style="width:40px;height:40px;font-size:16px;background:var(--brass);">◎</span>`;

  // Members have an emoji, not a photo (decisions.md: Profile). The circle feed
  // carries it on the post; anything without one falls back to the initial.
  function memberAvatarHtml(post, name, size) {
    const emoji = post && post.author && post.author.emoji;
    if (!emoji) return avatarHtml(name, size);
    return `<span aria-hidden="true" class="avatar-badge" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.55)}px;background:var(--surface);border:1px solid var(--border);">${esc(emoji)}</span>`;
  }

  function postHeadHtml(post, opts) {
    opts = opts || {};
    const authorless = !!opts.authorless;
    const name = authorless ? (opts.clubName || "המעגל") : (postAuthorName(post) || "חבר/ה");
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
      : authorless ? CLUB_MARK_HTML : memberAvatarHtml(post, name, 40);
    const roleBadge = "";
    // THE NAME AND THE BADGE ARE SIBLINGS NOW, not a badge nested inside the
    // name. Measured on a 390px phone: the badge was inside the name's own
    // <button>, so "מאמן/ת ראשי/ת" wrapped to a second line WITH the name and
    // picked up .link-btn's underline on the way. As a sibling in a flex row
    // it is `flex:0 0 auto` - it never shrinks, never wraps - and the name
    // beside it is free to ellipse on one line (.post-author-row,
    // index.html). The title attribute is what gives back what the ellipsis
    // takes away, for a mouse; the full name is in the DOM either way, so a
    // screen reader was never reading the truncation.
    //
    // The inline style block is gone rather than trimmed: `font:inherit`
    // there was silently overriding .post-author's own font-size, and every
    // other property it set is now in the class, where the ellipsis rules it
    // has to cooperate with also live.
    const nameLink = `<div class="post-author" title="${esc(name)}">${esc(name)}</div>`;
    const nameHtml = `<div class="post-author-row">${nameLink}${roleBadge}</div>`;
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
    POST_PR: "שיא אישי",
    POST_ACHIEVEMENT: "הישג",
    POST_SYSTEM: "מהמעגל",
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
    return postBodyHtml(post) + (result || "");
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
      // 202609220005. Own workout posts only, and only while the club has
      // the module on - postCanTagPartners() is the same three conditions
      // post_tag_training_partners() enforces.
      if (postCanTagPartners(post)) items += mi("post-tag-partners", "מי התאמן/ה איתי", post.id);
      items += mi("post-edit-caption", "עריכת כיתוב", post.id);
      items += mi("post-delete", "מחיקה", post.id, true);
    } else {
      if (post.author_id) items += mi("block", "חסימת החבר/ה", post.author_id, true);
    }
    // aria-haspopup="menu", not "true": "true" is the legacy alias for
    // "menu" and says nothing about WHICH pattern opens, and this one really
    // is a menu - role="menu" with role="menuitem" children, arrow keys and
    // Escape (see the keydown handler in cloud.js). aria-controls points the
    // screen reader at the panel the button owns, and the panel is labelled
    // by the button, so it is announced as "עוד פעולות, תפריט" rather than
    // as an unnamed group of buttons.
    const menuId = `postMenu-${id}`;
    const btnId = `postMenuBtn-${id}`;
    return `<div class="post-menu-wrap">
      <button class="chip-btn" id="${btnId}" data-community-action="toggle-post-menu" data-id="${id}" aria-haspopup="menu" aria-expanded="${open ? "true" : "false"}" aria-controls="${menuId}" aria-label="עוד פעולות">⋯</button>
      ${open ? `<div class="post-menu" id="${menuId}" role="menu" aria-labelledby="${btnId}" data-post-menu="${id}">${items}</div>` : ""}
    </div>`;
  }

  // The reactions: exactly three kinds (decisions.md, Sharing), each a toggle,
  // and a member may hold all three on a post. The counts come from
  // circle_feed (reaction_counts) and the member's own from my_reactions.
  function postActionsHtml(post, opts) {
    opts = opts || {};
    const id = esc(post && post.id);
    const rs = reactionStateFor(post && post.id);
    const buttons = CirclesCore.REACTION_KINDS.map((kind) => {
      const meta = CirclesCore.REACTION_META[kind];
      const n = Number(rs.counts[kind] || 0);
      const mine = rs.mine.indexOf(kind) >= 0;
      return `<button class="chip-btn reaction-pill${mine ? " is-mine" : ""}" data-community-action="react" data-kind="${kind}" data-id="${id}" aria-pressed="${mine ? "true" : "false"}" aria-label="${esc(meta.label)}${n ? ", " + n : ""}"><span aria-hidden="true">${meta.emoji}</span>${n ? ` <span class="mono">${n}</span>` : ""}</button>`;
    }).join("");
    const total = CirclesCore.REACTION_KINDS.reduce((n, k) => n + Number(rs.counts[k] || 0), 0);
    const who = total ? `<button class="link-btn reaction-summary" data-community-action="reactors" data-id="${id}" aria-haspopup="dialog" aria-label="מי הגיב, ${total}">מי הגיב</button>` : "";
    return `<div class="chip-row post-actions" role="group" aria-label="תגובות">${buttons}${who}${opts.extra || ""}</div>`;
  }

  function postBodyHtml(post) {
    const body = post && post.body;
    if (!body) return "";
    return `<div class="post-body" style="white-space:pre-wrap;line-height:1.6;">${bidiText(String(body).slice(0, POST_BODY_MAX))}</div>`;
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
    return !cleanPostBody(e.body);
  }

  // ---- "התאמנו יחד": training partners on a workout post (202609220005) ---
  //
  // The author names who was in the room; the named members are notified and
  // any of them can take their own name off. The server is the authority on
  // every one of those three sentences - post_tag_training_partners() is
  // author-only and re-checks each target's allow_mentions,
  // post_training_partners_read decides who is ever shown a tag, and
  // post_training_partner_remove() is what the untag button calls. Nothing
  // below is a permission check; it is all about what to draw.

  // The server's own cap, restated so the sheet can stop the member at ten
  // rather than letting the RPC raise after they have ticked eleven.
  const TRAINING_PARTNERS_MAX = 10;

  // The tags a card should print. An ABSENT entry and an EMPTY one are
  // different answers and the difference is load-bearing: absent means this
  // post has not been asked about yet (a page still in flight, a post just
  // inserted optimistically) and the card prints nothing; empty means the
  // server was asked and returned no tags the viewer may see. Collapsing the
  // two would make every unloaded post claim it has no partners.
  function postTrainingPartners(post) {
    const pid = post && post.id;
    if (!pid) return null;
    const rows = state.posts.partners[pid];
    return Array.isArray(rows) ? rows : null;
  }
  // WHICH DAY THE SUGGESTIONS ARE FOR. occurred_on is the workout's own date
  // and is what the share path writes; metadata.workout_date is what the
  // card already prefers when it prints the date, so the same order is used
  // here rather than a second opinion about the same post. created_at is the
  // last resort - a post with no date at all is still taggable, it just
  // suggests from the day it was written.
  function postTrainingDay(post) {
    const m = (post && post.metadata) || {};
    const raw = m.workout_date || (post && post.occurred_on) || (post && post.created_at) || "";
    const day = String(raw).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : new Date().toISOString().slice(0, 10);
  }
  // Only the author, only a workout post, only while the club has the module
  // on - the same three conditions post_tag_training_partners() enforces, so
  // the control is never offered where the call would be refused.
  //
  // AND ONLY WHERE THE SHEET CAN ACTUALLY OPEN, which is the fourth
  // condition and the one that is about this codebase rather than about the
  // feature. renderPostCard() is called from two places: the feed, and the
  // Posts tab of a profile (directory.js). findFeedPost() only ever looks in
  // state.posts.held, so a card drawn on the profile tab cannot be resolved
  // back to its row. The three older own-post controls share that lookup and
  // degrade quietly there - postStartCaptionEdit opens with an empty body,
  // postStartVisibilityEdit with the default scope - which is a pre-existing
  // gap this branch is reporting rather than inheriting: a tagging sheet has
  // no sensible degraded form (it needs the post's DAY to suggest anybody at
  // all), so it is not offered there instead of opening onto nothing. The
  // READ half is unaffected - the partners line and the tagged member's own
  // remove button both work on the profile tab, and directory.js loads the
  // tags for it.
  function postCanTagPartners(post) {
    if (!post || post.post_type !== "POST_WORKOUT") return false;
    if (!postIsOwn(post)) return false;
    return !!findFeedPost(post.id);
  }

  // One call per feed page, not one per card. post_training_partners_for()
  // is SECURITY INVOKER, so what comes back is already filtered by the read
  // policy and by profiles' own - nothing is re-filtered at LOAD time. The
  // one filter the render applies (trainingPartnersHtml's isBlockedUser
  // call) is about a block made since this answer arrived, not about
  // doubting it.
  async function loadTrainingPartners(postIds) {
    if (!state.user || !client) return;
    const ids = (postIds || []).filter((id) => !!id);
    if (!ids.length) return;
    const { data, error } = await client.rpc("post_training_partners_for", { p_post_ids: ids });
    // A failure leaves the map untouched rather than writing [] for every id:
    // an empty answer and an unanswered question must not look the same (see
    // postTrainingPartners above), and the next page load asks again.
    if (error) return;
    const rows = Array.isArray(data) ? data : (data ? [data] : []);
    // Seed every id that was asked about with an empty list FIRST, so a post
    // that genuinely carries no tags is recorded as answered.
    for (const id of ids) state.posts.partners[id] = [];
    for (const r of rows) {
      if (!r || !r.post_id) continue;
      if (!state.posts.partners[r.post_id]) state.posts.partners[r.post_id] = [];
      state.posts.partners[r.post_id].push({
        user_id: r.user_id, display_name: r.display_name, handle: r.handle,
      });
    }
  }

  function trainingPartnerName(row) {
    const name = String((row && row.display_name) || "").trim();
    if (name) return name;
    return row && row.handle ? "@" + row.handle : "חבר/ה";
  }

  // The line under the card. Rendered in the order the server returned -
  // post_training_partners_for() orders by created_at then name then id, a
  // total order, so two names never swap between renders.
  function trainingPartnersHtml(post) {
    const loaded = postTrainingPartners(post);
    // The same second net the classmates card carries (blockFilteredList in
    // directory.js), applied for the same reason and not because the server
    // is doubted: post_training_partners_read already refuses a row across a
    // block edge, but a block made in THIS session lands in the client's own
    // blocked-id set before the next page load re-asks, and the member who
    // just blocked somebody must not keep seeing their name until then.
    const rows = (loaded || []).filter((r) => !(typeof isBlockedUser === "function" && isBlockedUser(r.user_id)));
    if (!loaded || !rows.length) return "";
    const pid = esc(post.id);
    const names = rows.map((r) => `<span style="color:var(--chalk);font-weight:700;">${esc(trainingPartnerName(r))}</span>`)
      .join(`<span aria-hidden="true">, </span>`);
    // The member's own escape hatch, on the card rather than behind the
    // author's sheet: being able to remove the tag is the whole reason being
    // tagged is acceptable, and it must not require finding a menu.
    const taggedMe = !!(state.user && rows.some((r) => r.user_id === state.user.id));
    const untag = taggedMe
      ? `<button class="link-btn" data-community-action="partner-untag-self" data-id="${pid}" style="font-size:12px;">הסרת התיוג שלי</button>`
      : "";
    return `<div class="post-partners" data-post-partners="ready" data-post-id="${pid}" style="margin-top:8px;display:flex;flex-wrap:wrap;align-items:center;gap:6px;color:var(--steel);font-size:12.5px;line-height:1.6;">
      <span aria-hidden="true">🤝</span><span style="font-weight:800;color:var(--chalk);">התאמנו יחד</span>${names}${untag}
    </div>`;
  }

  // The author's sheet. Inline under the card, the shape captionEditPanel
  // already uses, rather than a modal - it is a short list
  // of checkboxes and the post it is about is the context.
  function trainingPartnersPanel(post) {
    const p = state.posts.partnersPanel;
    const picked = p.picked || [];
    // Everyone the sheet can offer: the classmates signal for the post's day,
    // plus anyone already tagged. The second half is not decoration - a
    // member tagged yesterday who has since turned show_attendance off drops
    // out of the signal, and without this they would be untickable.
    const options = p.options || [];
    const atCap = picked.length >= TRAINING_PARTNERS_MAX;
    const rows = options.map((o) => {
      const on = picked.indexOf(o.user_id) >= 0;
      return `<label class="field flex gap-6" style="align-items:center;">
        <input type="checkbox" data-partner-pick="${esc(o.user_id)}"${on ? " checked" : ""}${!on && atCap ? " disabled" : ""}/>
        <span style="font-size:13px;">${esc(trainingPartnerName(o))}${(p.pending || []).indexOf(o.user_id) >= 0 ? ` <span style="color:var(--steel);font-size:11.5px;">(ממתין לאישור)</span>` : ""}</span>
      </label>`;
    }).join("");
    const body = p.loading
      ? `<div class="empty">טוען…</div>`
      : options.length
        ? rows
        // "On no signal, show nothing" does not apply inside a sheet the
        // member deliberately opened: here an empty list has to say why, or
        // it reads as broken. The two real causes are named, because one of
        // them is the member's own setting and they can change it.
        : `<div class="empty">אין עוד חברים במעגל הזה.</div>`;
    return `<div class="post-inline-edit" data-partners-panel="${esc(post.id)}" style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px;">
      <div class="field-label" style="margin-bottom:6px;">מי התאמן/ה איתכם?</div>
      <div style="color:var(--steel);font-size:12px;margin-bottom:8px;">התיוג ממתין לאישור של מי שסימנתם. רק אחרי האישור האימון נספר גם לשבוע שלו/שלה.</div>
      ${body}
      ${atCap ? `<div style="color:var(--steel);font-size:12px;margin-top:6px;">אפשר לתייג עד ${TRAINING_PARTNERS_MAX} חברים.</div>` : ""}
      ${p.error ? `<div class="field-error" role="alert" style="margin-top:8px;">${esc(p.error)}</div>` : ""}
      <div class="chip-row" style="margin-top:8px;">
        <button class="chip-btn" data-community-action="partners-cancel">ביטול</button>
        <button class="chip-btn primary" data-community-action="partners-save"${p.saving || p.loading ? " disabled" : ""}>${p.saving ? "שומר…" : "שמירה"}</button>
      </div>
    </div>`;
  }

  async function openTrainingPartners(postId) {
    const post = findFeedPost(postId);
    if (!post || !postCanTagPartners(post)) return;
    state.posts.openMenu = null;
    const day = postTrainingDay(post);
    state.posts.partnersPanel = {
      postId, day, options: [], picked: [], pending: [],
      loading: true, saving: false, error: "",
    };
    rerender();
    const panel = state.posts.partnersPanel;
    // The people to offer are the circle's members, not the whole app: a tag
    // can only name someone in the post's own circle. Members and the tags
    // already on this post (pending and confirmed - the author sees both) are
    // read together.
    const clubId = post.club_id || state.circles.currentId;
    const [roster, tags] = await Promise.all([
      client.from("circle_members").select("user_id,profiles(display_name,emoji)").eq("club_id", clubId),
      client.from("post_training_partners").select("tagged_user_id,confirmed_at").eq("post_id", postId),
    ]);
    if (state.posts.partnersPanel !== panel) return;
    panel.loading = false;
    if (roster.error || tags.error) {
      panel.error = "טעינת חברי המעגל נכשלה, אפשר לנסות שוב";
    } else {
      panel.options = (roster.data || [])
        .filter((r) => !state.user || r.user_id !== state.user.id)
        .map((r) => ({ user_id: r.user_id, display_name: (r.profiles && r.profiles.display_name) || "" }));
      panel.picked = (tags.data || []).map((t) => t.tagged_user_id);
      panel.pending = (tags.data || []).filter((t) => !t.confirmed_at).map((t) => t.tagged_user_id);
    }
    rerender();
  }
  function closeTrainingPartners() {
    state.posts.partnersPanel = null;
    rerender();
  }
  function toggleTrainingPartnerPick(userId) {
    const p = state.posts.partnersPanel;
    if (!p || !userId) return;
    const at = p.picked.indexOf(userId);
    if (at >= 0) p.picked.splice(at, 1);
    else if (p.picked.length < TRAINING_PARTNERS_MAX) p.picked.push(userId);
    p.error = "";
    rerender();
  }
  async function saveTrainingPartners() {
    const p = state.posts.partnersPanel;
    if (!p || p.saving || p.loading) return;
    p.saving = true;
    p.error = "";
    rerender();
    const postId = p.postId;
    const { error } = await client.rpc("post_tag_training_partners", {
      p_post_id: postId, p_members: p.picked.slice(),
    });
    if (error) {
      // Still the open sheet? A save that lands after the member closed it
      // must not resurrect the panel just to show an error on it.
      if (state.posts.partnersPanel === p) {
        p.saving = false;
        p.error = failText("שמירת התיוגים נכשלה", error);
        rerender();
      }
      return;
    }
    // The server decides what actually landed - a target who turned tagging
    // off is skipped silently, so re-reading is the only honest way to know
    // what the card should print.
    await loadTrainingPartners([postId]);
    // What LANDED, read back off the server's answer, not what was ticked: a
    // member who turned tagging off is skipped silently. A count only - who
    // trained beside whom is a social graph this table must not hold.
    track(A.TRAINING_PARTNERS_TAGGED, { count: (state.posts.partners[postId] || []).length });
    if (state.posts.partnersPanel === p) state.posts.partnersPanel = null;
    setMessage("התיוגים נשמרו");
    rerender();
  }
  // The tagged member's own removal, from the card. One argument: the server
  // defaults p_user_id to the caller, so this call cannot name anybody else
  // even if it were forged.
  async function removeOwnTrainingPartnerTag(postId) {
    if (!state.user || !postId) return;
    const { error } = await client.rpc("post_training_partner_remove", { p_post_id: postId });
    if (error) return setMessage(failText("הסרת התיוג נכשלה", error));
    await loadTrainingPartners([postId]);
    setMessage("התיוג הוסר");
    rerender();
  }

  function postCardShell(post, inner, opts) {
    opts = opts || {};
    const pid = post && post.id;
    const partnersPanelOpen = state.posts.partnersPanel && pid && state.posts.partnersPanel.postId === pid;
    // A PR a day old that nobody else has reacted to (circle_feed's
    // unreacted_pr) is lifted to the top of the circle and drawn with a quiet
    // outline and one line. No notification, no badge, nothing to dismiss.
    const lift = !!(post && post.unreacted_pr);
    return `<article class="chart-card post-card${lift ? " post-card--lift" : ""}" data-post-type="${esc((post && post.post_type) || "UNKNOWN")}"${opts.unknown ? ' data-post-unknown="1"' : ""}${lift ? ' data-unreacted-pr="1"' : ""}${pid ? ` data-post-id="${esc(pid)}"` : ""}>
      ${lift ? `<div class="post-lift-note">עוד לא קיבל/ה תגובה על השיא</div>` : ""}
      ${postHeadHtml(post, opts)}
      ${inner || ""}
      ${trainingPartnersHtml(post)}
      ${opts.engagementDisabled ? "" : postActionsHtml(post, opts)}
      ${state.posts.captionEdit && pid && state.posts.captionEdit.postId === pid ? captionEditPanel() : ""}
      ${partnersPanelOpen ? trainingPartnersPanel(post) : ""}
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
    // `detail` is this type's RESULT BLOCK and so goes last, after the photo
    // and after whatever the member wrote about it.
    return postCardShell(post, postCardBody(post, `<div class="post-result-block">${detail}</div>`));
  }

  function renderPrPostCard(post) {
    const m = post.metadata || {};
    // COMM-105 / S17. movement/movement_name resolve only for a CUSTOM lift -
    // the built-in library lives in the client, so the server records
    // movement_id (202609230009) and the name is looked up here, out of the
    // same library every other screen uses. Without this the common case, a
    // PR on a built-in lift, announced itself as the post-type label: every
    // squat PR in the feed read "שיא אישי" and nothing else.
    let movement = m.movement || m.movement_name || post.title || "";
    if (!movement && m.movement_id && typeof movementById === "function") {
      const mv = movementById(m.movement_id);
      if (mv && mv.name) movement = mv.name;
    }
    if (!movement) movement = "שיא אישי";
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





  // COMM-107: system notices read as club voice. No profile link, muted, no
  // More menu, reactions and comments disabled.
  function renderSystemPostCard(post) {
    return postCardShell(post, postBodyHtml(post), { authorless: true, clubName: "המעגל", hideMenu: true, engagementDisabled: true });
  }

  function renderUnknownPostCard(post) {
    return postCardShell(post, postCardBody(post), { unknown: true });
  }
  function renderErrorPostCard(post) {
    return `<article class="chart-card post-card" data-post-type="${esc((post && post.post_type) || "UNKNOWN")}" data-post-error="1">
      <div class="empty">לא ניתן להציג את הפוסט הזה</div>
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


  // ---- Per-post action menu (COMM-108) ----------------------------------
  // FOCUS IS PART OF THE MENU, not an extra.
  //
  // rerender() rebuilds the tab with one innerHTML write, so the button that
  // was just tapped no longer exists by the time this returns - which on a
  // keyboard left focus on <body> with a menu open and nothing to arrow
  // through, and left it on <body> again when the menu closed. Opening moves
  // focus to the first item (what role="menu" promises), closing puts it back
  // on the button that owns the menu, which is where a keyboard user expects
  // to be when a popup goes away.
  //
  // Both lookups are by id and both are guarded: rerender() is synchronous
  // here, but a caller that closes a menu from a screen where the card is no
  // longer rendered must not throw.
  function focusPostMenuFirstItem(id) {
    const menu = document.getElementById(`postMenu-${id}`);
    const first = menu && menu.querySelector(".post-menu-item");
    if (first) try { first.focus(); } catch (e) { /* not focusable in this engine */ }
  }
  function focusPostMenuButton(id) {
    const btn = document.getElementById(`postMenuBtn-${id}`);
    if (btn) try { btn.focus(); } catch (e) { /* not focusable in this engine */ }
  }
  function togglePostMenu(id) {
    const wasOpen = state.posts.openMenu === id;
    state.posts.openMenu = wasOpen ? null : id;
    rerender();
    if (wasOpen) focusPostMenuButton(id);
    else focusPostMenuFirstItem(id);
  }
  // Arrow-key movement inside an open menu, and the close that returns focus.
  // Called from cloud.js's one document keydown listener - there is no second
  // listener attached per render, which a rebuilt-on-every-render DOM would
  // otherwise accumulate.
  function postMenuKeydown(e) {
    const id = state.posts.openMenu;
    if (!id) return false;
    const menu = document.getElementById(`postMenu-${id}`);
    if (!menu) return false;
    if (e.key === "Escape") {
      state.posts.openMenu = null;
      rerender();
      focusPostMenuButton(id);
      return true;
    }
    const items = [...menu.querySelectorAll(".post-menu-item")];
    if (!items.length) return false;
    const at = items.indexOf(document.activeElement);
    let next = -1;
    if (e.key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % items.length;
    else if (e.key === "ArrowUp") next = at <= 0 ? items.length - 1 : at - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next < 0) return false;
    e.preventDefault();
    try { items[next].focus(); } catch (err) { /* not focusable in this engine */ }
    return true;
  }
  function postStartCaptionEdit(postId) {
    state.posts.openMenu = null;
    const post = findFeedPost(postId);
    state.posts.captionEdit = { postId, body: (post && post.body) || "" };
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
  // The second half of the twin deletePost() names above. The optimistic
  // hide was already here — it just ran AFTER the RPC returned, so there was
  // nothing to undo by the time the post left the screen. It now runs first
  // and the RPC is what waits.
  async function postDeleteViaMenu(postId) {
    const snapshot = Array.isArray(state.posts.held) ? state.posts.held.slice() : null;
    deferCommunityDelete({
      label: "הפוסט נמחק",
      remove: () => { if (snapshot) state.posts.held = state.posts.held.filter((p) => p && p.id !== postId); },
      restore: () => { if (snapshot) state.posts.held = snapshot; },
      commit: async () => {
        const { error } = await client.rpc("post_delete", { post_id: postId });
        if (error) { if (snapshot) state.posts.held = snapshot; rerender(); return setMessage(failText("מחיקת הפוסט נכשלה", error)); }
        rerender();
      },
    });
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
  //
  // The signed-in check it used to make by hand is now one clause of
  // sharePromptAllowed() (src/community/share-prompt.js), which also asks the
  // member's own "stop offering" switch and the club's feed module.
  // offerSharePrompt() is what keeps this from opening on top of, or under,
  // the workout prompt or an achievement celebration for the same save.
  function onPrCreated(payload) {
    const record = payload && (payload.record || payload);
    if (!record) return;
    if (record.trivial) return;
    const recordId = record.record_id || record.id;
    if (!recordId) return;
    if (prPromptDismissedSet().has(String(recordId))) return;
    if (prPromptOnCooldownFor(record.movement)) return;
    offerSharePrompt("pr", function () {
      // Re-checked at open time, not only at offer time: a parked offer can
      // be released a dialog later, and the cooldown this very prompt writes
      // is what stops the second of two PRs in one session from asking again.
      if (prPromptDismissedSet().has(String(recordId))) return false;
      if (prPromptOnCooldownFor(record.movement)) return false;
      state.posts.prPrompt = { record: Object.assign({}, record, { record_id: recordId }), note: "", showNote: false, publishing: false, error: "",
        // Ticked: the circles whose share settings take PRs. The member can
        // change that for this one record; the settings stay as they were.
        picked: state.circles.list.filter((c) => CirclesCore.effectiveDefaults(c).share_prs).map((c) => c.id) };
      rememberPrPromptShownForMovement(record.movement);
      // The card is drawn now, before any tap: navigator.share() has to run inside the tap.
      sharingPreparePrCard(state.posts.prPrompt.record);
      rerender();
      return true;
    });
  }
  function dismissPrPrompt() {
    if (state.posts.prPrompt) rememberPrDismissed(state.posts.prPrompt.record.record_id);
    state.posts.prPrompt = null;
    rerender();
    sharePromptClosed();
  }
  async function sharePrPrompt() {
    const p = state.posts.prPrompt;
    if (!p || p.publishing) return;
    if (!p.picked || !p.picked.length) { p.error = "בחרו לפחות מעגל אחד"; return rerender(); }
    p.publishing = true;
    p.error = "";
    rerender();
    // One pr_share call per circle (a post belongs to exactly one circle), each
    // through communityRpc(): pr_share is in OUTBOX_ACTIONS, so a share tapped
    // with no connection is persisted in IndexedDB with its own idempotency
    // key and sent on reconnect. The key is what makes the retry safe; the
    // server answers a repeated key with the original post id.
    // p_weight goes only to circles where the member chose to show weights.
    const res = await sharePrToCircles(p.record, p.picked.slice(), cleanPostBody(p.note));
    if (res.failed && !res.sent && !res.queued) { p.publishing = false; p.error = failText("השיתוף נכשל, אפשר לנסות שוב", res.error); return rerender(); }
    rememberPrDismissed(p.record.record_id);
    state.posts.prPrompt = null;
    setMessage(res.queued && !res.sent ? "השיא יישלח למעגלים כשהחיבור יחזור" : res.failed ? "השיא שותף, אבל לא בכל המעגלים" : "השיא שותף למעגלים");
    for (const id of p.picked) delete state.circles.feed[id];
    rerender();
    sharePromptClosed();
  }
  function togglePrCircle(clubId) {
    const p = state.posts.prPrompt;
    if (!p) return;
    const at = p.picked.indexOf(clubId);
    if (at >= 0) p.picked.splice(at, 1); else p.picked.push(clubId);
    p.error = "";
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
          <h2 id="prPromptTitle" style="margin-top:0;color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:6px;">שיא חדש! לשתף עם המעגלים?</h2>
          <div style="display:inline-block;font-size:11px;font-weight:800;color:#0c0c0c;background:var(--brass);border-radius:999px;padding:2px 8px;margin-bottom:8px;">PR</div>
          ${line("תרגיל", r.movement || r.movement_name)}
          ${line("תוצאה חדשה", r.new_result || r.new_value)}
          ${line("תוצאה קודמת", r.previous_result || r.previous_value)}
          ${line("שיפור", r.improvement)}
          ${p.showNote ? `<label class="field" style="margin-top:8px;"><span class="field-label">הערה</span><textarea class="text-input" data-pr-note maxlength="${POST_BODY_MAX}" rows="3">${esc(p.note || "")}</textarea></label>` : ""}
          ${circlePickListHtml(p.picked, "data-pr-circle", (c) => CirclesCore.effectiveDefaults(c).show_weights ? "המשקל יוצג" : "בלי משקל מוחלט: רק התרגיל והשיפור באחוזים")}
          ${p.error ? `<div class="field-error" role="alert" style="margin-top:8px;">${esc(p.error)}</div>` : ""}
          <div class="chip-row" style="margin-top:14px;">
            <button class="chip-btn primary" data-community-action="pr-share"${p.publishing ? " disabled" : ""}>${p.publishing ? "משתף…" : "שיתוף"}</button>
            ${sharingPrCardButtonHtml()}
            ${p.showNote ? "" : `<button class="chip-btn" data-community-action="pr-add-note">הוספת הערה</button>`}
            <button class="chip-btn" data-community-action="pr-not-now">לא עכשיו</button>
          </div>
        </div>
      </div>
    </div>`;
  }
