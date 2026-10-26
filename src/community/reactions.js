"use strict";
// ---- Community: reactions -------------------------------------------------
//
// Exactly three kinds, stored as `fist_bump`, `fire` and `clap`, and a member
// may hold all three on a post (docs/circles/decisions.md, Sharing). No text
// comments, no mentions. The fist bump was stored as `cheer` until
// 202610250005; nothing in the client reads that kind any more.
//
// Where the numbers come from: circle_feed returns, per post, the count of each
// kind (reaction_counts) and the kinds the caller holds (my_reactions), so a
// feed page needs no second query. state.engagement.reactions[postId] holds
// { counts, mine, list, loaded }. The toggle itself (reactToPost) is in
// circles.js beside the other circle writes; this file is the "who reacted"
// sheet and the state shape.
//
// Classic <script>, no IIFE, loaded before cloud.js; it reads state, client,
// rerender and friends from the shared scope, from inside function bodies only.

  // Who reacted to one post, loaded when the sheet opens. The kind filter is
  // the three kinds and nothing else.
  async function loadReactionsFor(postId) {
    const { data, error } = await client.from("reactions")
      .select("user_id,kind,profiles(display_name,emoji)")
      .eq("post_id", postId).in("kind", CirclesCore.REACTION_KINDS).order("created_at", { ascending: true }).limit(200);
    if (error) return;
    const prev = reactionStateFor(postId);
    state.engagement.reactions[postId] = Object.assign({}, prev, {
      loaded: true,
      list: (data || []).map((r) => ({ id: r.user_id, kind: r.kind, name: (r.profiles && r.profiles.display_name) || "", emoji: (r.profiles && r.profiles.emoji) || "🙂" })),
    });
    rerender();
  }

  function openReactors(postId) {
    if (!postId) return;
    state.engagement.reactorsFor = postId;
    rerender();
    // Always re-read: a list loaded ten minutes ago is exactly what this sheet
    // must not show as "who reacted" right now.
    loadReactionsFor(postId);
  }
  function closeReactors() { state.engagement.reactorsFor = null; rerender(); }

  function renderReactorsSheet() {
    const pid = state.engagement.reactorsFor;
    if (!pid) return "";
    const rs = reactionStateFor(pid);
    // A blocked member's reaction is not shown to the one who blocked them (or
    // the other way round).
    const rows = (rs.list || []).filter((r) => !isBlockedUser(r.id));
    const body = !rs.loaded
      ? `<div class="empty">טוען…</div>`
      : rows.length
      ? `<div class="log-list">${rows.map((r) => {
          const meta = CirclesCore.REACTION_META[r.kind] || { emoji: "", label: "" };
          return `<div class="log-row" data-reactor-user="${esc(r.id)}">
            <span style="display:flex;gap:10px;align-items:center;"><span aria-hidden="true">${esc(r.emoji)}</span><span style="font-weight:700;">${bidiText(r.name || "חבר/ה")}</span></span>
            <span aria-label="${esc(meta.label)}">${meta.emoji}</span>
          </div>`;
        }).join("")}</div>`
      : `<div class="empty">אין עדיין תגובות</div>`;
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
