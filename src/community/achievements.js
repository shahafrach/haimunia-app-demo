"use strict";
// ---- Community: achievements ---------------------------------------------
//
// The community side of an achievement: the metadata table, the client-side
// claim, the unlock celebration, the "my achievements" list, and the two
// distinct share paths (the unlock sheet, and app.js's own share button via
// window.shareAchievementToCommunity) that are never both taken in one
// action.
//
// Detection and the engine itself are app.js's; this consumes what it
// publishes on the product event bus.
//
// Moved out of cloud.js unchanged — every line byte-identical to what it was
// there. Classic <script>, no IIFE, loaded before cloud.js; see
// src/community/events.js's header for why each of those matters.

  // The offline medals in the training log (app.js ACHIEVEMENTS) are not
  // member_achievements rows, so they have no ach_share. Sharing one is a short
  // text post, one per chosen circle, through post_create(p_club_id, body) -
  // the same queued write every other circle post uses. The sheet that picks
  // the circles is in circles-ui.js.
  async function publishAchievement(achievementId, title, rule) {
    if (!state.user || !state.profile) return setMessage("התחברו כדי לשתף מדליה");
    if (!state.circles.list.length) return setMessage("אפשר לשתף מדליה אחרי שמצטרפים למעגל");
    const name = String(title || "מדליה חדשה").slice(0, 120);
    const body = cleanPostBody("🏅 " + name + (rule ? " - " + String(rule).slice(0, 200) : ""));
    openMedalShareSheet(body);
  }

  // Hebrew display copy for the celebration, keyed by definition code. The
  // canonical seed is docs/community/achievement-seed.md; keep this in step.
  const COMMUNITY_ACHIEVEMENT_META = {
    first_workout: { title: "האימון הראשון", explanation: "רשמת אימון ראשון ביומן.", icon: "🔥" },
    sessions_10: { title: "10 אימונים", explanation: "10 ימי אימון מתועדים.", icon: "🔥" },
    sessions_25: { title: "25 אימונים", explanation: "25 ימי אימון מתועדים.", icon: "🔥" },
    sessions_50: { title: "50 אימונים", explanation: "50 ימי אימון מתועדים.", icon: "🥉" },
    sessions_100: { title: "100 אימונים", explanation: "100 ימי אימון מתועדים.", icon: "🥈" },
    sessions_250: { title: "250 אימונים", explanation: "250 ימי אימון מתועדים.", icon: "🥇" },
    consistency_weeks_4: { title: "חודש ברצף", explanation: "רשמת אימון בכל שבוע, ארבעה שבועות ברצף.", icon: "📅" },
    consistency_weeks_12: { title: "רבעון ברצף", explanation: "רשמת אימון בכל שבוע, שנים עשר שבועות ברצף.", icon: "📅" },
    consistency_weeks_26: { title: "חצי שנה ברצף", explanation: "רשמת אימון בכל שבוע, עשרים ושישה שבועות ברצף.", icon: "📆" },
    consistency_weeks_52: { title: "שנה ברצף", explanation: "רשמת אימון בכל שבוע, חמישים ושניים שבועות ברצף.", icon: "🏆" },
    first_pr: { title: "השיא הראשון", explanation: "שיא אישי ראשון.", icon: "⭐" },
    pr_10: { title: "10 שיאים", explanation: "10 שיאים אישיים.", icon: "⭐" },
    pr_25: { title: "25 שיאים", explanation: "25 שיאים אישיים.", icon: "🌟" },
    pr_50: { title: "50 שיאים", explanation: "50 שיאים אישיים.", icon: "🌟" },
    pr_100: { title: "100 שיאים", explanation: "100 שיאים אישיים.", icon: "💫" },
    first_rx: { title: "Rx ראשון", explanation: "רשמת אימון ראשון כ-Rx.", icon: "🏋️" },
    well_rounded: { title: "אתלט שלם", explanation: "שיא לפחות בכל אחת מחמש קבוצות התרגילים.", icon: "🧩" },
    anniversary_year_1: { title: "שנה עם BOX-LOG", explanation: "שנה מתאריך ההצטרפות.", icon: "🎉" },
    anniversary_year_2: { title: "שנתיים עם BOX-LOG", explanation: "שנתיים מתאריך ההצטרפות.", icon: "🎉" },
    anniversary_year_3: { title: "שלוש שנים עם BOX-LOG", explanation: "שלוש שנים מתאריך ההצטרפות.", icon: "🎉" },
    anniversary_year_5: { title: "חמש שנים עם BOX-LOG", explanation: "חמש שנים מתאריך ההצטרפות.", icon: "🎖️" },
    first_cheer: { title: "עידוד ראשון", explanation: "שלחת עידוד ראשון לחבר/ה.", icon: "👏" },
    supportive_10: { title: "10 עידודים", explanation: "10 עידודים לחברים.", icon: "🤝" },
  };
  // Three tiers, in this order, so a gap between the seed and this map
  // degrades instead of leaking a raw code string at a member:
  //   1. the hand-written entry above (has an explanation, which the
  //      definition row has no client-facing equivalent of on every surface)
  //   2. the DEFINITION'S OWN name/icon, which loadMyAchievements() and
  //      ach_claim already fetch - `row` is the member_achievements row the
  //      caller already has in hand, so this costs no round trip
  //   3. the bare code, which is what an achievement the client has no copy
  //      for would print
  // Tier 2 is the one this fix adds. Every call site passes its row where it
  // has one; the signature stays code-first so a call with only a code keeps
  // working exactly as before.
  function achMeta(code, row) {
    const known = COMMUNITY_ACHIEVEMENT_META[code];
    if (known) return known;
    const def = row && (row.achievement_definitions || (row.code ? row : null));
    const name = def && def.name;
    const icon = def && def.icon;
    if (name) return { title: name, explanation: (def && def.description) || "", icon: icon || "🏅" };
    return { title: code || "מדליה חדשה", explanation: "", icon: icon || "🏅" };
  }
  function achCodeOf(row) { return row && (row.code || (row.achievement_definitions && row.achievement_definitions.code)) || ""; }

  async function loadMyAchievements() {
    if (!state.user) return;
    const { data, error } = await client.from("member_achievements")
      .select("id,visibility,shared_at,unlocked_at,achievement_id,achievement_definitions(code,name,icon)")
      .eq("user_id", state.user.id)
      .order("unlocked_at", { ascending: false });
    state.achievements.mine = error ? [] : (data || []);
  }

  // Called from app.js (window.claimCommunityAchievements) with the codes it
  // just saw cross their threshold on this device. Returns the rows ach_claim
  // actually wrote, and fans each out as an ACHIEVEMENT_UNLOCKED product
  // event so the celebration and the notifications consumer both see it.
  async function claimCommunityAchievements(codes) {
    if (!state.user || !state.profile) return [];
    const list = Array.from(new Set((codes || []).map((c) => String(c)).filter(Boolean))).slice(0, 50);
    if (!list.length) return [];
    // Live bug hunt, round 10 (2026-09-11): a genuine network failure
    // (offline) makes client.rpc() itself REJECT rather than resolve with
    // {error} - confirmed live as an uncaught "Failed to fetch" page error.
    // Returning null (instead of letting the caller see either an
    // exception or the same [] shape a real server error already used) is
    // what lets syncCommunityMilestones() (app.js) tell "did not happen,
    // retry later" apart from "happened, nothing new to claim".
    let data, error;
    try { ({ data, error } = await client.rpc("ach_claim", { p_codes: list })); }
    catch (e) { return null; }
    if (error) return null;
    const written = Array.isArray(data) ? data : (data ? [data] : []);
    if (written.length && Array.isArray(state.achievements.mine)) {
      for (const r of written) {
        if (!state.achievements.mine.some((x) => x.id === r.member_achievement_id)) {
          state.achievements.mine.unshift({ id: r.member_achievement_id, visibility: r.visibility, shared_at: null, unlocked_at: new Date().toISOString(), achievement_definitions: { code: r.code } });
        }
      }
    }
    for (const r of written) {
      if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.ACHIEVEMENT_UNLOCKED) {
        try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.ACHIEVEMENT_UNLOCKED, { code: r.code, member_achievement_id: r.member_achievement_id, visibility: r.visibility }); } catch (e) {}
      }
    }
    if (written.length) rerender();
    return written;
  }
  window.claimCommunityAchievements = claimCommunityAchievements;

  // Two entry points, one sheet. ACHIEVEMENT_UNLOCKED arrives on its own -
  // the member did not ask for it - so it goes through the share-prompt
  // coordinator (src/community/share-prompt.js): the member's "stop offering"
  // switch, the club's achievements module, and the one-prompt-at-a-time rule
  // that stops this from painting on top of the PR prompt for the same save.
  // (The decoration's OWN visibility is checked where it belongs, on the
  // sheet's share control below - "only_me" offers no share at all.) shareEarnedAchievement() below is a TAP on a decoration the member
  // went and found in "ההישגים שלי", so it opens the sheet directly: a switch
  // that says "do not offer" must not disable a control the member pressed.
  function onAchievementUnlocked(payload) {
    if (!payload || !payload.code) return;
    offerSharePrompt("achievement", function () { return openAchievementUnlockSheet(payload); });
  }
  function openAchievementUnlockSheet(payload) {
    const code = payload && payload.code;
    if (!code) return false;
    // ach_claim_row carries only {code, member_achievement_id, visibility} -
    // no name and no icon - so achMeta's definition fallback needs a row from
    // somewhere. state.achievements.mine is already loaded and already
    // carries achievement_definitions(code,name,icon), so this is a local
    // lookup and not a round trip. It misses only for a first-ever unlock of
    // a code the member has never held, which is exactly when tier 3 (the
    // bare code) would have been the answer before this fix anyway.
    const known = Array.isArray(state.achievements.mine)
      ? state.achievements.mine.find((r) => achCodeOf(r) === code && r.achievement_definitions && r.achievement_definitions.name)
      : null;
    const meta = achMeta(code, known);
    state.achievements.unlock = {
      code,
      memberAchievementId: (payload && payload.member_achievement_id) || null,
      visibility: (payload && payload.visibility) || "club",
      title: meta.title,
      explanation: meta.explanation,
      icon: meta.icon,
      sharing: false,
      error: "",
      showNote: false,
      note: "",
      // Ticked: every circle. A medal has no share setting of its own; the
      // member sees the list and un-ticks what they do not want.
      picked: state.circles.list.map((c) => c.id),
    };
    rerender();
    return true;
  }
  function dismissAchievementUnlock() { state.achievements.unlock = null; rerender(); sharePromptClosed(); }
  async function shareAchievementUnlock() {
    const a = state.achievements.unlock;
    if (!a || a.sharing) return;
    if (!a.memberAchievementId || a.visibility === "only_me") { a.error = "לא ניתן לשתף. נסו שוב."; return rerender(); }
    a.sharing = true;
    a.error = "";
    rerender();
    if (!a.picked || !a.picked.length) { a.sharing = false; a.error = "בחרו לפחות מעגל אחד"; return rerender(); }
    // One ach_share per circle (a post belongs to exactly one), each through
    // communityRpc(): ach_share is in OUTBOX_ACTIONS, so a share tapped offline
    // is persisted with its own idempotency key and sent on reconnect.
    const res = await shareAchievementToCircles(a.memberAchievementId, a.picked.slice(), cleanPostBody(a.note));
    const queued = res.queued > 0 && !res.sent;
    if (res.failed && !res.sent && !res.queued) { a.sharing = false; a.error = failText("לא ניתן לשתף. נסו שוב.", res.error); return rerender(); }
    if (Array.isArray(state.achievements.mine)) {
      const row = state.achievements.mine.find((r) => r.id === a.memberAchievementId);
      if (row) row.shared_at = new Date().toISOString();
    }
    // COMM-170. Sharing an achievement is a WCAM-qualifying action in its
    // own right, which is why it is tracked here and not left to the
    // POST_CREATED bridge below: the bus event records that a post exists,
    // this records that a member chose to share a decoration.
    track(A.ACHIEVEMENT_SHARED, { member_achievement_id: a.memberAchievementId, code: a.code || null, source: "unlock_sheet" });
    state.achievements.unlock = null;
    const sharedText = queued ? "המדליה תישלח למעגלים כשהחיבור יחזור" : res.failed ? "המדליה שותפה, אבל לא בכל המעגלים" : "המדליה שותפה למעגלים";
    setMessage(sharedText);
    if (typeof window.showToast === "function") {
      window.showToast(sharedText);
      // A toast paints on the next render of the screen that is up (the Log tab's, not this layer's).
      if (typeof window.render === "function") window.render();
    }
    rerender();
    sharePromptClosed();
  }
  function shareEarnedAchievement(memberAchievementId, code) {
    const row = (state.achievements.mine || []).find((r) => r.id === memberAchievementId);
    // Straight to the sheet, past the coordinator: see onAchievementUnlocked's
    // own comment for why a tap is not an offer.
    openAchievementUnlockSheet({ code: code || achCodeOf(row), member_achievement_id: memberAchievementId, visibility: row ? row.visibility : "club" });
  }

  function renderAchievementUnlockCelebration() {
    const a = state.achievements.unlock;
    if (!a) return "";
    const canShare = !!a.memberAchievementId && a.visibility !== "only_me";
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="achUnlockTitle" data-cloud-dialog="achUnlock" style="align-items:center;padding:0 16px;">
      <div class="modal-sheet" id="achUnlock" style="border-radius:22px;max-height:90vh;overflow:auto;">
        <div style="padding:22px 20px calc(env(safe-area-inset-bottom,0px) + 18px);text-align:center;">
          <div style="font-size:44px;line-height:1;margin-bottom:8px;" aria-hidden="true">${esc(a.icon)}</div>
          <h2 id="achUnlockTitle" style="margin-top:0;color:var(--color-text);font-weight:800;font-size:18px;margin-bottom:4px;">מדליה חדשה נפתחה</h2>
          <div style="color:var(--color-accent);font-weight:800;font-size:15px;">${esc(a.title)}</div>
          ${a.explanation ? `<div style="color:var(--color-text-muted);font-size:12.5px;margin-top:6px;">${esc(a.explanation)}</div>` : ""}
          ${a.showNote ? `<label class="field" style="margin-top:10px;text-align:right;"><span class="field-label">הערה</span><textarea class="text-input" data-ach-note maxlength="${POST_BODY_MAX}" rows="3">${esc(a.note || "")}</textarea></label>` : ""}
          ${canShare ? `<div style="text-align:right;margin-top:10px;">${circlePickListHtml(a.picked || [], "data-ach-circle")}</div>` : ""}
          ${a.error ? `<div class="field-error" role="alert" style="margin-top:8px;">${esc(a.error)}</div>` : ""}
          <div class="chip-row" style="margin-top:14px;justify-content:center;">
            ${canShare ? `<button class="chip-btn primary" data-community-action="ach-share"${a.sharing ? " disabled" : ""}>${a.sharing ? "משתף…" : "שיתוף"}</button>` : ""}
            ${canShare && !a.showNote ? `<button class="chip-btn" data-community-action="ach-add-note">הוספת הערה</button>` : ""}
            <button class="chip-btn" data-community-action="ach-not-now">לא עכשיו</button>
          </div>
        </div>
      </div>
    </div>`;
  }
  function renderMyAchievements() {
    if (!state.user || !state.profile) return "";
    const list = Array.isArray(state.achievements.mine) ? state.achievements.mine : [];
    const rowsHtml = list.map((r) => {
      const code = achCodeOf(r);
      // The row is already in hand and already carries the definition's own
      // name and icon (loadMyAchievements selects them), so a code this map
      // has never heard of renders the seeded Hebrew label rather than the
      // raw code.
      const meta = achMeta(code, r);
      // One share control: into the circles, named and with the SHARE_ICONS
      // stroke icon. There is no card for a medal, so no share out of the app.
      const share = r.shared_at
        ? `<span style="color:var(--color-text-muted);font-size:12px;">שותף למעגל</span>`
        : r.visibility === "only_me"
          ? ""
          : `<button class="chip-btn" data-community-action="ach-share-later" data-id="${esc(r.id)}" data-code="${esc(code)}">${SHARE_ICONS.club} שיתוף למעגל</button>`;
      // data-achievement-id: the anchor a `target.achievement` notification
      // tap (navigateToNotifTarget) scrolls to and briefly highlights - the
      // same scrollIntoView pattern the `target.post` branch already uses
      // off data-post-id. r.id is member_achievements.id, the exact value
      // notif_on_achievement's own deep link carries (`?ma=<member_
      // achievements.id>`), so the notification's target and this row's
      // anchor always agree.
      return `<div class="log-row" data-achievement-id="${esc(r.id)}" style="flex-wrap:wrap;gap:6px;"><span style="min-width:0;">${esc(meta.icon)} ${esc(meta.title)}</span><span class="chip-row" style="margin:0;justify-content:flex-end;flex:1 1 auto;">${share}</span></div>`;
    }).join("");
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--color-accent)", "ההישגים שלי")}${list.length ? `<div class="log-list">${rowsHtml}</div>` : `<div class="empty">אין עדיין הישגים</div>`}</div>`;
  }
