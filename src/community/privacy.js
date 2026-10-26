"use strict";
// ---- Community: blocks -----------------------------------------------------
//
// What stayed of the old directory module when search, follows and the member
// directory were dropped: the block list (a block hides a member's posts and
// reactions from the viewer, and the other way round). The per-field privacy
// switches are gone with the columns they set: a profile is a display name
// and an emoji, what a member shares is per circle (set_share_defaults), and
// nothing here reads show_workout_results or any other dropped column.
//
// Classic <script>, no IIFE, loaded before cloud.js; it reads state, client,
// rerender, setMessage and failText from the shared scope, from inside
// function bodies only.

  async function loadBlockedIds() {
    if (!state.user) { state.members.blockedIds = []; state.members.blocksLoaded = true; state.members.blockedByMe = []; state.members.blockedByMeNames = {}; state.members.blockedByMeLoaded = true; return; }
    const ids = {};
    const a = await client.from("blocks").select("blocked_id").eq("blocker_id", state.user.id);
    for (const r of (a.data || [])) ids[r.blocked_id] = true;
    const b = await client.from("blocks").select("blocker_id").eq("blocked_id", state.user.id);
    for (const r of (b.data || [])) ids[r.blocker_id] = true;
    state.members.blockedIds = Object.keys(ids);
    state.members.blocksLoaded = true;
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

  async function block(userId) {
    if (!state.user) return;
    const { error } = await client.from("blocks").upsert({ blocker_id: state.user.id, blocked_id: userId });
    if (error) { setMessage(failText("לא ניתן היה לחסום. נסו שוב", error)); return; }
    await loadBlockedIds();
    state.engagement.reactions = {};
    setMessage("המשתמש נחסם");
    rerender();
  }

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
