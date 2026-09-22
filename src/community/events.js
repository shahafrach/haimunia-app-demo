"use strict";
// ---- Community: events (COMM-213..217) -----------------------------------
//
// Moved out of cloud.js unchanged. Every line below is byte-identical to what
// it was there; nothing was renamed, reordered or rewritten, and the move is
// proved rather than asserted (see the PR).
//
// THIS IS A CLASSIC <script>, NOT AN ES MODULE, AND IT HAS NO IIFE. Both are
// load-bearing. Classic <script> tags share one global lexical environment,
// which is how the functions below still see state, client, esc, rerender and
// setMessage without a single call site changing — cloud.js gave up its own
// IIFE for exactly this (see its header). An IIFE here, or module scope,
// would cut them off from all of it.
//
// LOAD ORDER: before cloud.js, in index.html and in
// test/helpers/community-src.mjs alike. cloud.js builds some of its
// top-level `const`s at evaluation time out of direct references to
// functions that now live in modules, so a module loaded after it would
// leave those unresolved. Nothing here reads a cloud.js binding at
// evaluation time — only from inside function bodies, which run long after
// every script has.
//
// WHAT STAYED BEHIND, deliberately: renderEventLinkCard. It renders the
// POST_EVENT card and is one of thirteen siblings dispatched from
// POST_CARD_RENDERERS. Pulling one renderer out of the table that dispatches
// it is how the next copy of it gets written.

  // ---- Events (COMM-213..217) ----------------------------------------------
  // Generalizes the COMM-101 fallback (a plain link card pointing nowhere
  // real) into the full events module: Upcoming/Past list, a create/edit
  // form gated on community.event.manage, a detail dialog with
  // server-enforced RSVP (event_rsvp, 202608280010), type badges, a
  // client-built .ics download, and a comment thread that reuses the whole
  // engagement stack through a companion POST_EVENT post - see
  // ensureEventCompanionPost() below and "Needs from schema, events" in
  // docs/community/contracts.md for the design decision.
  const EVENT_TYPES = [
    { id: "workshop", label: "סדנה", icon: "🛠️" },
    { id: "competition", label: "תחרות", icon: "🏆" },
    { id: "social_night", label: "ערב חברתי", icon: "🎉" },
    { id: "outdoor_workout", label: "אימון בחוץ", icon: "🌳" },
    { id: "running_meetup", label: "מפגש ריצה", icon: "🏃" },
    { id: "holiday_event", label: "אירוע חג", icon: "🎊" },
    { id: "seminar", label: "הרצאה", icon: "🎓" },
    { id: "community_event", label: "אירוע קהילתי", icon: "🤝" },
    { id: "other", label: "אחר", icon: "📌" },
  ];
  function eventTypeDef(id) { return EVENT_TYPES.find((t) => t.id === id) || { id, label: id || "", icon: "📅" }; }
  function eventTypeBadge(id) { const d = eventTypeDef(id); return `${d.icon} ${d.label}`; }
  // start_at/end_at/registration_deadline are stored as UTC ISO, but must
  // display - and round-trip through a <input type="datetime-local"> -
  // in the viewer's local clock. A bare string slice of the UTC value
  // showed the wrong wall-clock time and, worse, silently shifted an
  // event's stored instant by the local UTC offset on every edit that
  // didn't touch the date fields: datetime-local's value carries no zone
  // of its own, so submitEventForm's `new Date(startAt)` reinterprets
  // whatever was prefilled as local time, and a UTC-sliced prefill is
  // local-time-shifted the moment it round-trips back through that.
  function pad2(n) { return String(n).padStart(2, "0"); }
  function eventLocalParts(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return { y: d.getFullYear(), mo: pad2(d.getMonth() + 1), da: pad2(d.getDate()), h: pad2(d.getHours()), mi: pad2(d.getMinutes()) };
  }
  function formatEventDate(iso) { const p = eventLocalParts(iso); return p ? `${p.y}-${p.mo}-${p.da}` : ""; }
  function formatEventTime(iso) { const p = eventLocalParts(iso); return p ? `${p.h}:${p.mi}` : ""; }
  function eventDateTimeLocalValue(iso) { const p = eventLocalParts(iso); return p ? `${p.y}-${p.mo}-${p.da}T${p.h}:${p.mi}` : ""; }
  function eventStatusLabel(e) { return { draft: "טיוטה", published: "פורסם", cancelled: "בוטל", past: "הסתיים" }[e && e.status] || ""; }
  // Upcoming/Past split (COMM-213): "split on status and start_at" means
  // both together, not either alone - a published event whose start_at has
  // passed reads as Past even though nothing ever flips its status, and a
  // cancelled event always reads as Past regardless of when it was to
  // start, per the ticket's "moves out of Upcoming, stays visible in Past
  // marked cancelled".
  function isUpcomingEvent(e) { return !!e && e.status === "published" && !!e.start_at && new Date(e.start_at).getTime() > Date.now(); }
  function isPastEvent(e) { return !!e && (e.status === "past" || e.status === "cancelled" || (e.status === "published" && !isUpcomingEvent(e))); }
  function eventAttendeeRows(id) { return state.events.attendees[id] || []; }
  // COMM-213/214. Read straight off the event_attendees rows RLS actually
  // handed back for the caller - event_attendees_read (202608280010)
  // already excludes another member's row when they opted out of
  // show_in_attendee_lists, so a going count computed here can undercount
  // relative to the server's own capacity trigger for a plain member. That
  // is an accepted, schema-owned trade-off (informational count vs. the
  // trigger's own authoritative, unfiltered count), not something this
  // cluster papers over.
  function eventGoingCount(id) { return eventAttendeeRows(id).filter((r) => r.response === "going").length; }
  function myEventResponse(id) {
    const row = eventAttendeeRows(id).find((r) => r.user_id === (state.user && state.user.id));
    return row ? row.response : null;
  }
  // AN EVENT THAT HAS ALREADY HAPPENED IS CLOSED, deadline or not.
  //
  // Live bug hunt, fresh round 3 (2026-09-15) - HIGH, reproduced live: a
  // published event that ended three days ago, with no registration_deadline
  // set, rendered an enabled "משתתף/ת" button, and pressing it wrote a real
  // event_attendees row saying the member was going to something that had
  // already finished.
  //
  // registration_deadline is OPTIONAL and usually unset, so keying this on it
  // alone meant most events never closed at all. The list view had it right
  // the whole time - it uses isPastEvent() to file the event under "אירועים
  // שהסתיימו" - and the detail view simply never asked the same question. Two
  // computed states of one event that disagreed, which is why the list looked
  // correct while the button underneath it was not.
  //
  // isPastEvent() covers cancelled and past-status events as well as a
  // published one whose time has gone, so this closes all three with the
  // signal the rest of the file already trusts.
  function eventRegistrationClosed(e) {
    if (!e) return false;
    if (isPastEvent(e)) return true;
    return !!(e.registration_deadline && new Date(e.registration_deadline).getTime() < Date.now());
  }
  // A going->going update on a full event stays enabled (COMM-214's
  // idempotence rule): only disable Going for someone who is not already
  // going.
  function eventIsFull(e) { return !!(e && e.capacity != null && eventGoingCount(e.id) >= e.capacity && myEventResponse(e.id) !== "going"); }

  async function loadEvents() {
    if (!state.user) { state.events.items = []; state.events.byId = {}; state.events.attendees = {}; state.events.loaded = false; return; }
    state.events.loading = true;
    rerender();
    // Launch-readiness audit, PERF-2. Same unbounded-select fix as the
    // challenges list above.
    const { data, error } = await client.from("events").select("*").order("start_at", { ascending: true }).limit(200);
    if (error) { state.events.loading = false; state.events.error = true; return rerender(); }
    state.events.items = data || [];
    state.events.byId = {};
    for (const e of state.events.items) state.events.byId[e.id] = e;
    state.events.error = false;
    const ids = state.events.items.map((e) => e.id);
    state.events.attendees = {};
    if (ids.length) {
      const { data: rows, error: aErr } = await client.from("event_attendees")
        .select("event_id,user_id,response,registered_at,profiles(display_name,handle,avatar_url)")
        .in("event_id", ids);
      if (!aErr) for (const row of (rows || [])) (state.events.attendees[row.event_id] = state.events.attendees[row.event_id] || []).push(row);
    }
    state.events.loading = false;
    state.events.loaded = true;
    rerender();
  }

  // ---- List (COMM-213) ------------------------------------------------------
  function eventCardImageHtml(e) {
    return e.image_url
      ? `<img src="${esc(e.image_url)}" alt="" style="width:56px;height:56px;border-radius:12px;object-fit:cover;"/>`
      : `<span aria-hidden="true" style="width:56px;height:56px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px;background:var(--border);">${eventTypeDef(e.event_type).icon}</span>`;
  }
  function renderEventCard(e) {
    const going = eventGoingCount(e.id);
    const mine = myEventResponse(e.id);
    const cancelled = e.status === "cancelled";
    const meta = [eventTypeBadge(e.event_type), formatEventDate(e.start_at), formatEventTime(e.start_at)];
    if (e.location) meta.push(e.location);
    meta.push(participantsLabel(going));
    if (e.status === "draft") meta.push(eventStatusLabel(e));
    if (cancelled) meta.push("בוטל");
    const mineLabel = mine === "going" ? "הולכ/ת" : mine === "interested" ? "מעוניין/ת" : mine === "not_going" ? "לא הולכ/ת" : "";
    return `<article class="chart-card" data-event-id="${esc(e.id)}" data-event-status="${esc(e.status)}" style="margin-bottom:10px;${cancelled ? "opacity:.7;" : ""}">
      <div class="flex gap-10" style="align-items:flex-start;">
        ${eventCardImageHtml(e)}
        <div style="flex:1;min-width:0;">
          <button class="link-btn" data-community-action="open-event" data-id="${esc(e.id)}" data-source="boards" style="padding:0;text-align:right;font-weight:800;font-size:15px;color:inherit;display:block;">${bidiText(e.title)}</button>
          <div style="color:var(--steel);font-size:11.5px;margin-top:2px;">${meta.map(esc).join(" · ")}</div>
        </div>
      </div>
      <div class="chip-row" style="margin-top:8px;">
        <button class="chip-btn" data-community-action="open-event" data-id="${esc(e.id)}" data-source="boards">פרטים</button>
        ${mineLabel ? `<span class="tag tag-brass">${mineLabel}</span>` : ""}
      </div>
    </article>`;
  }
  function renderEventsListSection() {
    // COMM-321. Same reasoning as renderChallengesListSection's own guard
    // just above - events_read already returns nothing for anyone, staff
    // included, once this module is off.
    if (!isModuleEnabled("events")) return "";
    const staff = hasPerm(PERM.EVENT_MANAGE);
    const upcoming = state.events.items.filter((e) => isUpcomingEvent(e) || (staff && e.status === "draft"));
    const past = state.events.items.filter(isPastEvent).slice().sort((a, b) => (a.start_at < b.start_at ? 1 : -1));
    const createBtn = staff ? `<button class="chip-btn primary" data-community-action="open-event-form" style="margin-bottom:10px;">אירוע חדש</button>` : "";
    const list = (state.events.loading && !state.events.loaded)
      ? `<div aria-busy="true">${`<div class="chart-card" style="height:64px;background:var(--border);opacity:.35;margin-bottom:10px;"></div>`.repeat(2)}</div>`
      : state.events.error
      ? `<div class="empty">לא ניתן היה לטעון את האירוע. נסו שוב.<div class="chip-row" style="justify-content:center;"><button class="chip-btn" data-community-action="events-retry">ניסיון חוזר</button></div></div>`
      : upcoming.length ? upcoming.map(renderEventCard).join("") : `<div class="empty">אין אירועים קרובים כרגע.</div>`;
    const pastHtml = past.length ? `<div style="margin-top:16px;"><h3 class="field-label" style="margin-bottom:6px;">אירועים שהסתיימו</h3>${past.map(renderEventCard).join("")}</div>` : "";
    return `<div class="ach-section">${sectionHead("var(--blue)", "אירועי המועדון")}${createBtn}${state.events.form ? renderEventForm() : ""}${list}${pastHtml}</div>`;
  }

  // ---- Create/edit form (COMM-213) ------------------------------------------
  function openEventForm(existing) {
    state.events.form = existing ? {
      mode: "edit", id: existing.id, status: existing.status, eventType: existing.event_type,
      title: existing.title, description: existing.description || "",
      imageUrl: existing.image_url || "", location: existing.location || "", mapLink: existing.map_link || "",
      startAt: eventDateTimeLocalValue(existing.start_at),
      endAt: eventDateTimeLocalValue(existing.end_at),
      capacity: existing.capacity != null ? String(existing.capacity) : "",
      registrationDeadline: eventDateTimeLocalValue(existing.registration_deadline),
      saving: false, error: "",
    } : {
      mode: "create", id: null, status: "draft", eventType: "workshop",
      title: "", description: "", imageUrl: "", location: "", mapLink: "",
      startAt: "", endAt: "", capacity: "", registrationDeadline: "",
      saving: false, error: "",
    };
    rerender();
  }
  function closeEventForm() { state.events.form = null; setFieldErrors("communityEventForm", {}); rerender(); }
  function setEventFormType(type) { if (state.events.form && EVENT_TYPES.some((t) => t.id === type)) { state.events.form.eventType = type; rerender(); } }
  async function submitEventForm(form) {
    const f = state.events.form;
    if (!f || f.saving) return;
    const fd = new FormData(form);
    const title = String(fd.get("title") || "").trim();
    const description = String(fd.get("description") || "").trim();
    const imageUrl = String(fd.get("imageUrl") || "").trim();
    const location = String(fd.get("location") || "").trim();
    const mapLink = String(fd.get("mapLink") || "").trim();
    const startAt = String(fd.get("startAt") || "");
    const endAt = String(fd.get("endAt") || "");
    const capacityRaw = String(fd.get("capacity") || "").trim();
    const deadlineRaw = String(fd.get("registrationDeadline") || "");
    const errors = {};
    if (title.length < 1 || title.length > 120) errors.title = "כותרת נדרשת, עד 120 תווים";
    if (description.length > 4000) errors.description = "עד 4000 תווים";
    if (location.length > 240) errors.location = "עד 240 תווים";
    // esc() at render time only prevents this from breaking the page - it
    // does not stop a javascript: URI from sitting in an href. Length was
    // the only real check before this.
    if (mapLink && !/^https?:\/\//i.test(mapLink)) errors.mapLink = "הקישור חייב להתחיל ב-http:// או https://";
    if (!startAt) errors.startAt = "יש לבחור תאריך ושעת התחלה";
    if (endAt && startAt && new Date(endAt).getTime() < new Date(startAt).getTime()) errors.endAt = "תאריך הסיום חייב להיות אחרי ההתחלה";
    if (capacityRaw && (!Number.isInteger(Number(capacityRaw)) || Number(capacityRaw) <= 0)) errors.capacity = "מספר שלם חיובי נדרש";
    if (Object.keys(errors).length) return setFieldErrors("communityEventForm", errors);
    setFieldErrors("communityEventForm", {});
    f.saving = true; f.error = ""; rerender();
    const payload = {
      title, description, event_type: f.eventType,
      image_url: imageUrl || null, location: location || null, map_link: mapLink || null,
      start_at: new Date(startAt).toISOString(), end_at: endAt ? new Date(endAt).toISOString() : null,
      capacity: capacityRaw ? Number(capacityRaw) : null,
      registration_deadline: deadlineRaw ? new Date(deadlineRaw).toISOString() : null,
    };
    let error;
    let publishNow = false;
    if (f.mode === "create") {
      payload.id = newFeedId();
      payload.created_by = state.user.id;
      publishNow = !!fd.get("publishNow");
      payload.status = publishNow ? "published" : "draft";
      ({ error } = await client.from("events").insert(payload));
    } else {
      ({ error } = await client.from("events").update(payload).eq("id", f.id));
    }
    f.saving = false;
    if (error) { f.error = "לא ניתן היה לשמור את האירוע. נסו שוב."; return rerender(); }
    // COMM-216. The companion post is created at the moment an event first
    // becomes published, whether that is "publish now" on create or a later
    // draft-to-published toggle (publishEventDraft, below) - never at draft
    // save, since a draft has no attendees to discuss it with yet.
    // A companion-post failure does not roll back the event itself (it's
    // already saved) - it used to just be swallowed, reporting success on
    // a permanently comment-less event. Surface it instead; the event view
    // dialog offers a direct retry (retryEventCompanionPost) once a staff
    // member notices the missing thread there.
    const companionId = publishNow ? await ensureEventCompanionPost(Object.assign({}, payload)) : null;
    state.events.form = null;
    setMessage(publishNow && !companionId ? "האירוע פורסם, אך יצירת פוסט הדיון נכשלה. ניתן לנסות שוב מתוך פרטי האירוע." : "האירוע נשמר");
    await loadEvents();
    rerender();
  }
  async function publishEventDraft(id) {
    const { error } = await client.from("events").update({ status: "published" }).eq("id", id);
    if (error) return setMessage(failText("הפעולה נכשלה", error));
    const event = state.events.byId[id];
    const companionId = event ? await ensureEventCompanionPost(Object.assign({}, event, { status: "published" })) : null;
    state.events.form = null;
    setMessage(companionId ? "האירוע פורסם" : "האירוע פורסם, אך יצירת פוסט הדיון נכשלה. ניתן לנסות שוב מתוך פרטי האירוע.");
    await loadEvents();
    if (state.events.view && state.events.view.id === id) await refreshEventView(id);
    rerender();
  }
  // Retry hook for the failure case above: findEventCompanionPost() inside
  // ensureEventCompanionPost() means calling it again is exactly a retry,
  // not a duplicate-post risk, whether the original attempt happened at
  // create/publish time or a previous retry.
  async function retryEventCompanionPost(id) {
    const v = state.events.view;
    if (!v || v.id !== id || v.companionBusy) return;
    v.companionBusy = true; v.companionError = ""; rerender();
    const event = state.events.byId[id] || v.event;
    const companionId = event ? await ensureEventCompanionPost(event) : null;
    v.companionBusy = false;
    if (!companionId) { v.companionError = "לא ניתן היה ליצור את פוסט הדיון. נסו שוב."; return rerender(); }
    v.companionPostId = companionId;
    state.engagement.openComments[companionId] = true;
    await loadCommentsFor(companionId);
    rerender();
  }
  function confirmCancelEvent(id) {
    askConfirm({ title: "ביטול אירוע", message: "כל מי שנרשם לאירוע (הולכים ומעוניינים) יקבל התראה על הביטול. הפעולה אינה ניתנת לביטול.", confirmLabel: "ביטול האירוע", destructive: true, action: "event-cancel", payload: { eventId: id } });
  }
  // The event_cancelled notification fan-out (notif_on_event_cancelled,
  // 202608290009) is a server trigger on this exact UPDATE - nothing further
  // to call from here.
  async function cancelEvent(id) {
    const { error } = await client.from("events").update({ status: "cancelled" }).eq("id", id);
    if (error) return setMessage(failText("הפעולה נכשלה", error));
    setMessage("האירוע בוטל");
    await loadEvents();
    if (state.events.view && state.events.view.id === id) await refreshEventView(id);
    rerender();
  }

  // ---- Companion post for comments (COMM-216) --------------------------------
  // post_create's shipped signature (202608280023) already merges
  // links.event_id into the new post's metadata, but it always writes
  // POST_TEXT or POST_PHOTO - it has no "make this a POST_EVENT" switch
  // (the same class of gap the challenges cluster found and documented for
  // links.challenge_id, which post_create does not even carry a key for).
  // event_id is different: the key genuinely IS merged into metadata
  // today, so closing this gap does not need a schema change. The row
  // post_create just inserted is authored by the caller
  // (posts_insert_self requires author_id = auth.uid()), and
  // posts_update_self (202608260001) already lets that same author update
  // ANY column of their own row with no restriction - so the follow-up
  // own-row RLS update below, from the post_create defaults straight to
  // the POST_EVENT shape, is a legitimate use of an existing policy, not a
  // bypass of one. contracts.md commits this cluster to zero schema
  // change for events; this is how that commitment is kept while still
  // giving the event a real POST_EVENT card instead of a plain POST_TEXT
  // one.
  //
  // Guards against a duplicate post on a cancel -> republish -> cancel
  // round trip or a double click on Publish: looks for an existing
  // POST_EVENT row carrying this event_id before creating a second one.
  // `events` itself carries no post_id column by design (see
  // "Needs from schema, events" in contracts.md), so this lookup - not a
  // stored pointer - is the source of truth for "does one already exist".
  async function findEventCompanionPost(eventId) {
    const { data, error } = await client.from("workout_posts").select("id,post_type,metadata").eq("post_type", "POST_EVENT");
    if (error) return null;
    return (data || []).find((r) => r.metadata && r.metadata.event_id === eventId) || null;
  }
  async function ensureEventCompanionPost(event) {
    if (!event || !event.id) return null;
    const existing = await findEventCompanionPost(event.id);
    if (existing) return existing.id;
    const body = (event.description ? String(event.description) : String(event.title || "")).slice(0, 1000);
    const { data: postId, error } = await client.rpc("post_create", {
      body, visibility: "club", media: [], links: { event_id: event.id },
    });
    if (error || !postId) return null;
    await client.from("workout_posts").update({
      post_type: "POST_EVENT",
      metadata: { event_id: event.id, event_title: event.title, starts_at: event.start_at },
    }).eq("id", postId);
    return postId;
  }

  // ---- Detail (COMM-213/214/215/216) -----------------------------------------
  async function openEvent(id, source) {
    if (!id) return;
    track(A.EVENT_VIEWED, { event_id: id, source: source || "events" });
    state.events.view = { id, loading: true, error: false, event: null, attendees: [], organizer: null, companionPostId: null, rsvpBusy: null, rsvpError: "", icsBusy: false, icsError: "", companionBusy: false, companionError: "" };
    rerender();
    await refreshEventView(id);
  }
  function closeEventView() { state.events.view = null; rerender(); }
  async function refreshEventView(id) {
    const v = state.events.view;
    if (!v || v.id !== id) return;
    const { data: event, error } = await client.from("events").select("*").eq("id", id).maybeSingle();
    if (!state.events.view || state.events.view.id !== id) return;
    if (error || !event) { state.events.view.loading = false; state.events.view.error = true; return rerender(); }
    state.events.view.event = event;
    state.events.byId[id] = event;
    const { data: attendees } = await client.from("event_attendees")
      .select("user_id,response,registered_at,profiles(display_name,handle,avatar_url)")
      .eq("event_id", id).order("registered_at", { ascending: true });
    state.events.view.attendees = attendees || [];
    state.events.view.organizer = null;
    if (event.created_by) {
      const { data: organizer } = await client.from("profiles").select("id,display_name,handle").eq("id", event.created_by).maybeSingle();
      state.events.view.organizer = organizer || null;
    }
    // COMM-216. Opens the companion post's thread by default - there is no
    // separate "toggle comments" affordance on an event, the thread IS the
    // event's discussion.
    const companion = await findEventCompanionPost(id);
    state.events.view.companionPostId = companion ? companion.id : null;
    if (state.events.view.companionPostId) {
      state.engagement.openComments[state.events.view.companionPostId] = true;
      await loadCommentsFor(state.events.view.companionPostId);
    }
    state.events.view.loading = false;
    rerender();
  }
  function eventRsvpErrorMessage(msg) {
    if (msg === "event_full") return "האירוע מלא";
    if (msg === "registration_closed") return "ההרשמה נסגרה";
    return "לא ניתן היה לעדכן את ההרשמה. נסו שוב.";
  }
  // COMM-214. Called both from the detail dialog's three buttons and from
  // the feed top-area quick actions (COMM-217) - event_rsvp() and the
  // server-side capacity/deadline trigger are the same for both, so this is
  // the one client path for either. A rejection (event_full,
  // registration_closed, or anything else) surfaces on the open detail
  // dialog when there is one, else as a toast, so a quick action from the
  // feed still tells the member why it failed.
  // Live bug hunt, round 10 (2026-09-11): v.rsvpBusy only ever guarded the
  // open detail dialog's own three RSVP buttons - the feed's quick-action
  // card (renderUpcomingEventCard()) had no busy/disabled guard, so a
  // throttled double-tap genuinely fired event_rsvp() twice. Unlike the
  // sibling challenge-join bug, this one produces no visible member-facing
  // symptom (event_rsvp is a real upsert - confirmed live, the resulting
  // event_attendees row is correct either way) - fixed anyway, for
  // consistency and to stop wasting a duplicate round trip on a slow
  // connection, matching every other busy-guarded action in this file.
  const eventRsvpBusy = {};
  async function rsvpEvent(eventId, response) {
    if (!state.user || !eventId || !response || eventRsvpBusy[eventId]) return;
    eventRsvpBusy[eventId] = true;
    const v = state.events.view && state.events.view.id === eventId ? state.events.view : null;
    if (v) { v.rsvpBusy = response; v.rsvpError = ""; }
    rerender();
    const { error, queued } = await communityRpc("event_rsvp", { p_event_id: eventId, p_response: response });
    delete eventRsvpBusy[eventId];
    if (v) v.rsvpBusy = null;
    if (queued) {
      await refreshOutboxState();
      setMessage("אין חיבור — ההרשמה תישלח כשהחיבור יחזור");
      rerender();
      return;
    }
    if (error) {
      const msg = eventRsvpErrorMessage(error.message);
      if (v) v.rsvpError = msg; else setMessage(msg);
      rerender();
      return;
    }
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.EVENT_REGISTERED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.EVENT_REGISTERED, { event_id: eventId, rsvp_status: response }); } catch (e) {}
    }
    setMessage(response === "going" ? "נרשמת לאירוע" : response === "interested" ? "סומנת כמעוניין/ת" : "עודכן כלא משתתף/ת");
    await loadEvents();
    if (state.events.view && state.events.view.id === eventId) await refreshEventView(eventId);
    rerender();
  }
  function renderEventActions(v) {
    const e = v.event;
    if (e.status !== "published") return "";
    const closed = eventRegistrationClosed(e);
    const full = eventIsFull(e);
    const mine = myEventResponse(e.id);
    const btn = (response, label) => {
      const disabled = closed || !!v.rsvpBusy || (response === "going" && full);
      const active = mine === response;
      return `<button class="chip-btn${active ? " selected" : ""}" data-community-action="event-rsvp" data-id="${esc(e.id)}" data-response="${response}"${disabled ? " disabled" : ""}>${v.rsvpBusy === response ? "מעדכנ/ת…" : label}</button>`;
    };
    const notes = [];
    // COMM-214: "past its registration deadline disables any RSVP change".
    // Full only disables Going (Interested and Not Going stay open), and a
    // going->going update stays enabled on a full event (eventIsFull()
    // already excludes that case).
    if (closed) notes.push("ההרשמה נסגרה");
    else if (full) notes.push("האירוע מלא");
    return `<div class="chip-row" style="margin-bottom:6px;">${btn("going", "משתתף/ת")}${btn("interested", "מעוניין/ת")}${btn("not_going", "לא משתתף/ת")}</div>
      ${notes.length ? `<div class="footer-note" style="margin-bottom:8px;">${notes.map(esc).join(" · ")}</div>` : ""}
      ${v.rsvpError ? `<div class="field-error" role="alert" style="margin-bottom:8px;">${esc(v.rsvpError)}</div>` : ""}`;
  }
  function renderEventAttendees(v) {
    const rows = v.attendees || [];
    if (!rows.length) return `<div class="empty">אין עדיין נרשמים.</div>`;
    const going = rows.filter((r) => r.response === "going").length;
    const rowHtml = (r) => {
      const prof = r.profiles || {};
      const name = prof.display_name || (prof.handle ? "@" + prof.handle : "חבר/ה");
      const label = r.response === "going" ? "הולכ/ת" : r.response === "interested" ? "מעוניין/ת" : "לא הולכ/ת";
      return `<div class="log-row"><span>${esc(name)}</span><span style="color:var(--steel);font-size:12px;">${esc(label)}</span></div>`;
    };
    // Already scoped by event_attendees_read (202608280010) to rows the
    // caller may see: their own, every row if they hold
    // community.event.manage, and everyone else's only when
    // show_in_attendee_lists (and its club-wide override) allows it - no
    // extra client-side filtering needed to honour that rule.
    return `<h3 class="field-label" style="margin:10px 0 4px;">משתתפים (${going})</h3><div class="log-list">${rows.map(rowHtml).join("")}</div>`;
  }

  // ---- Add to calendar (COMM-215) --------------------------------------------
  function icsEscape(text) {
    return String(text == null ? "" : text)
      .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  }
  function icsDateStamp(iso) {
    const d = new Date(iso);
    return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  }
  // Pure and exported on window (below) so a test can check the exact
  // iCalendar content without depending on jsdom's Blob/URL support, which
  // it does not have (the same gap composerAddPhoto already works around
  // with a try/catch around URL.createObjectURL).
  // RFC 5545 3.1: a content line over 75 octets must fold onto a
  // continuation line prefixed by a single space. Fold on whole-character
  // boundaries by UTF-8 byte weight (never a raw string slice, which would
  // cut a multi-byte sequence - every Hebrew character here - in half) so
  // this works without TextEncoder/TextDecoder, which aren't guaranteed on
  // every `window` this code runs inside (jsdom's test window included).
  function icsUtf8Len(codePoint) { return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4; }
  function icsFoldLine(line) {
    const chars = Array.from(line);
    let totalBytes = 0;
    for (const ch of chars) totalBytes += icsUtf8Len(ch.codePointAt(0));
    if (totalBytes <= 75) return line;
    const parts = [];
    let current = "";
    let currentBytes = 0;
    let limit = 75;
    for (const ch of chars) {
      const chBytes = icsUtf8Len(ch.codePointAt(0));
      if (currentBytes + chBytes > limit) {
        parts.push(current);
        current = "";
        currentBytes = 0;
        limit = 74;
      }
      current += ch;
      currentBytes += chBytes;
    }
    if (current) parts.push(current);
    return parts.join("\r\n ");
  }
  function buildEventIcs(event, appUrl) {
    const start = event.start_at;
    // COMM-215: end_at null defaults to start_at plus one hour.
    const end = event.end_at || new Date(new Date(event.start_at).getTime() + 3600000).toISOString();
    const lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Haimunia//Events//HE", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
      "UID:" + event.id + "@haimunia-events",
      "DTSTAMP:" + icsDateStamp(new Date().toISOString()),
      "DTSTART:" + icsDateStamp(start),
      "DTEND:" + icsDateStamp(end),
      "SUMMARY:" + icsEscape(event.title),
    ];
    if (event.location) lines.push("LOCATION:" + icsEscape(event.location));
    const descParts = [];
    if (event.description) descParts.push(event.description);
    if (appUrl) descParts.push(appUrl);
    if (descParts.length) lines.push("DESCRIPTION:" + icsEscape(descParts.join("\n\n")));
    lines.push("END:VEVENT", "END:VCALENDAR");
    return lines.map(icsFoldLine).join("\r\n");
  }
  function eventAppLink(eventId) {
    return String((window.location && window.location.origin) || "") + "/community/feed?event=" + eventId;
  }
  // COMM-215: no external service call, no server round trip - built
  // entirely from the event row already on state, and works offline once
  // the detail has loaded, per the ticket.
  function downloadEventIcs(eventId) {
    const v = state.events.view && state.events.view.id === eventId ? state.events.view : null;
    const event = (v && v.event) || state.events.byId[eventId];
    if (!event) return;
    if (v) { v.icsBusy = true; v.icsError = ""; }
    rerender();
    try {
      const ics = buildEventIcs(event, eventAppLink(eventId));
      const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = String(event.title || "event").replace(/[^\w\-א-ת ]+/g, "_").slice(0, 60) + ".ics";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 1000);
    } catch (err) {
      // Defensive only, per the ticket - a malformed date should not occur
      // given the table CHECKs. Also the path jsdom's missing
      // Blob/URL.createObjectURL takes under test.
      if (v) v.icsError = "לא ניתן היה ליצור קובץ יומן.";
    }
    if (v) v.icsBusy = false;
    rerender();
  }
  window.buildEventIcs = buildEventIcs;

  function renderEventViewBody(v) {
    const e = v.event;
    const staff = hasPerm(PERM.EVENT_MANAGE);
    const meta = [eventTypeBadge(e.event_type), formatEventDate(e.start_at), formatEventTime(e.start_at)];
    if (e.end_at) meta.push("עד " + formatEventTime(e.end_at));
    const statusLabel = eventStatusLabel(e);
    if (statusLabel) meta.push(statusLabel);
    const metaHtml = `<div style="color:var(--steel);font-size:12px;margin-bottom:10px;">${meta.map(esc).join(" · ")}</div>`;
    const image = e.image_url ? `<img src="${esc(e.image_url)}" alt="" style="width:100%;max-height:200px;object-fit:cover;border-radius:12px;margin-bottom:10px;"/>` : "";
    const description = e.description ? `<div style="font-size:13.5px;line-height:1.6;margin-bottom:10px;white-space:pre-wrap;">${bidiText(e.description)}</div>` : "";
    // Security hunt (2026-09-11): esc() only escapes &<>"' - it does not
    // stop a javascript:/data: URI from sitting in an href (its own comment
    // already says so). Not currently exploitable: submitEventForm() below
    // rejects a non-http(s) link before insert, and the DB itself carries a
    // matching CHECK constraint (202609050004_event_map_link_scheme.sql) -
    // but both of those are upstream of this render call, not at it. A
    // third, independent gate here (same regex submitEventForm() already
    // uses) means a future write path that bypasses the other two - a bulk
    // edit, a migration rollback, a second insert path - still can't turn
    // this into a stored javascript: link every member who views the event
    // would click.
    const mapLinkSafe = e.map_link && /^https?:\/\//i.test(e.map_link);
    const locationHtml = e.location ? `<div style="font-size:13px;color:var(--steel);margin-bottom:4px;">📍 ${bidiText(e.location)}${mapLinkSafe ? ` · <a class="link-btn" href="${esc(e.map_link)}" target="_blank" rel="noopener noreferrer">מפה</a>` : ""}</div>` : "";
    const going = eventGoingCount(e.id);
    const capacityHtml = `<div style="font-size:13px;color:var(--steel);margin-bottom:4px;">${e.capacity != null ? `${going} / ${e.capacity} משתתפים` : participantsLabel(going)}</div>`;
    const deadlineHtml = e.registration_deadline ? `<div style="font-size:12px;color:var(--steel);margin-bottom:4px;">מועד אחרון להרשמה: ${esc(formatEventDate(e.registration_deadline))} ${esc(formatEventTime(e.registration_deadline))}</div>` : "";
    const organizerName = v.organizer ? (v.organizer.display_name || (v.organizer.handle ? "@" + v.organizer.handle : "")) : "";
    const organizerHtml = organizerName ? `<div style="font-size:12px;color:var(--steel);margin-bottom:10px;">מארגנ/ת: ${esc(organizerName)}</div>` : "";
    // Real bug found by a role-coverage audit: content.pin covers events
    // (pinTargetLabel() has always listed "event"), but until now no event
    // surface offered a pin control - see isPinnedTarget()'s comment. Gated
    // separately from `staff` (EVENT_MANAGE, coach+): CONTENT_PIN starts at
    // head_coach, so a plain coach who can edit this event still won't see
    // a pin toggle, correctly.
    const pinBtn = hasPerm(PERM.CONTENT_PIN) ? `<button class="chip-btn" data-community-action="${isPinnedTarget("event", e.id) ? "unpin" : "pin"}" data-type="event" data-id="${esc(e.id)}" data-note="${esc(e.title)}">${isPinnedTarget("event", e.id) ? "ביטול הצמדה" : "הצמדה למעלה"}</button>` : "";
    const staffToolbar = (staff || pinBtn) ? `<div class="chip-row" style="margin-bottom:10px;">
        ${staff ? `<button class="chip-btn" data-community-action="event-edit" data-id="${esc(e.id)}">עריכה</button>` : ""}
        ${staff && e.status === "draft" ? `<button class="chip-btn" data-community-action="event-publish" data-id="${esc(e.id)}">פרסום</button>` : ""}
        ${staff && e.status === "published" ? `<button class="chip-btn danger" data-community-action="event-cancel-confirm" data-id="${esc(e.id)}">ביטול האירוע</button>` : ""}
        ${pinBtn}
      </div>` : "";
    const actions = renderEventActions(v);
    const icsBtn = `<div class="chip-row" style="margin:8px 0;"><button class="chip-btn" data-community-action="event-ics" data-id="${esc(e.id)}"${v.icsBusy ? " disabled" : ""}>${v.icsBusy ? "יוצר…" : "הוספה ליומן"}</button></div>${v.icsError ? `<div class="field-error" role="alert">${esc(v.icsError)}</div>` : ""}`;
    const attendeesHtml = renderEventAttendees(v);
    // COMM-216: the companion post's own thread, reusing renderComments()
    // untouched - same empty state, same loading skeleton, same retry
    // affordance every other comment thread already has. A post object
    // this thin is enough: renderComments()/reactionStripHtml() only ever
    // read post.id.
    const commentsHtml = v.companionPostId ? renderComments({ id: v.companionPostId }) : "";
    // A published event with no companion post means an earlier create/
    // publish attempt failed partway (see ensureEventCompanionPost's
    // callers) - offer staff a direct retry instead of a silently
    // comment-less event with no way back in.
    const companionRetryHtml = (staff && e.status === "published" && !v.companionPostId)
      ? `<div class="empty">לא נוצר פוסט דיון לאירוע זה.<div class="chip-row" style="justify-content:center;margin-top:6px;"><button class="chip-btn" data-community-action="event-companion-retry" data-id="${esc(e.id)}"${v.companionBusy ? " disabled" : ""}>${v.companionBusy ? "יוצר…" : "יצירת פוסט דיון"}</button></div>${v.companionError ? `<div class="field-error" role="alert">${esc(v.companionError)}</div>` : ""}</div>`
      : "";
    return `${metaHtml}${staffToolbar}${image}${description}${locationHtml}${capacityHtml}${deadlineHtml}${organizerHtml}${actions}${icsBtn}${attendeesHtml}<div style="margin-top:14px;">${commentsHtml}${companionRetryHtml}</div>`;
  }
  function renderEventViewOverlay() {
    const v = state.events.view;
    if (!v) return "";
    const bodyHtml = v.loading ? `<div class="empty">טוען את האירוע…</div>`
      : (v.error || !v.event) ? `<div class="empty">לא ניתן היה לטעון את האירוע. נסו שוב.</div>`
      : renderEventViewBody(v);
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="eventViewTitle" data-cloud-dialog="eventView" style="align-items:center;padding:20px 12px;">
      <div class="modal-sheet" style="border-radius:20px;max-height:88vh;overflow:auto;width:100%;max-width:560px;">
        <div style="padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 16px);">
          <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:12px;">
            <h2 id="eventViewTitle" style="margin-top:0;font-weight:800;font-size:17px;margin-bottom:0;">${v.event ? bidiText(v.event.title) : "אירוע"}</h2>
            ${sheetCloseBtnHtml("close-event-view")}
          </div>
          ${bodyHtml}
        </div>
      </div>
    </div>`;
  }

  // ---- Create/edit form markup (COMM-213) ------------------------------------
  function renderEventForm() {
    const f = state.events.form;
    const typePicker = `<div class="chip-row" role="group" aria-label="סוג אירוע" style="margin-bottom:10px;flex-wrap:wrap;">${EVENT_TYPES.map((t) => `<button type="button" class="chip-btn${f.eventType === t.id ? " selected" : ""}" data-community-action="event-form-type" data-type="${t.id}">${t.icon} ${esc(t.label)}</button>`).join("")}</div>`;
    return `<form id="communityEventForm" class="chart-card admin-card" style="margin-top:10px;">
      <div style="font-weight:800;margin-bottom:10px;">${f.mode === "edit" ? "עריכת אירוע" : "אירוע חדש"}<span class="admin-tag">ניהול</span></div>
      ${typePicker}
      ${field("communityEventForm", "title", "שם האירוע", `<input class="text-input" name="title" value="${esc(f.title)}" maxlength="120" required/>`)}
      ${field("communityEventForm", "description", "תיאור", `<textarea class="text-input" name="description" maxlength="4000">${esc(f.description)}</textarea>`)}
      ${field("communityEventForm", "imageUrl", "קישור לתמונה", `<input class="text-input" name="imageUrl" value="${esc(f.imageUrl)}" maxlength="500" placeholder="https://..."/>`)}
      ${field("communityEventForm", "location", "מיקום", `<input class="text-input" name="location" value="${esc(f.location)}" maxlength="240"/>`)}
      ${field("communityEventForm", "mapLink", "קישור למפה", `<input class="text-input" name="mapLink" value="${esc(f.mapLink)}" maxlength="500" placeholder="https://..."/>`)}
      <div class="flex gap-16 field">
        ${dateTimeField("communityEventForm", "startAt", "התחלה", `<input class="text-input" name="startAt" type="datetime-local" value="${esc(f.startAt)}" required/>`)}
        ${dateTimeField("communityEventForm", "endAt", "סיום", `<input class="text-input" name="endAt" type="datetime-local" value="${esc(f.endAt)}"/>`)}
      </div>
      <div class="flex gap-16 field">
        ${field("communityEventForm", "capacity", "מקומות (ריק = ללא הגבלה)", `<input class="text-input" name="capacity" type="number" min="1" value="${esc(f.capacity)}"/>`)}
        ${dateTimeField("communityEventForm", "registrationDeadline", "מועד אחרון להרשמה", `<input class="text-input" name="registrationDeadline" type="datetime-local" value="${esc(f.registrationDeadline)}"/>`)}
      </div>
      ${f.mode === "create" ? `<label class="field flex gap-6" style="align-items:center;"><input type="checkbox" name="publishNow"/><span style="font-size:12.5px;color:var(--steel);">פרסום מיידי (אחרת יישמר כטיוטה)</span></label>` : ""}
      ${f.error ? `<div class="field-error" role="alert">${esc(f.error)}</div>` : ""}
      <div class="chip-row" style="margin-top:10px;">
        <button class="chip-btn primary" type="submit"${f.saving ? " disabled" : ""}>${f.saving ? "שומר…" : "שמירה"}</button>
        <button class="chip-btn" type="button" data-community-action="event-form-cancel">ביטול</button>
      </div>
    </form>`;
  }

  // ---- Upcoming-event card in the feed top area (COMM-217) -------------------
  // The soonest published, non-cancelled event with start_at > now(), or
  // nothing at all - never an empty placeholder. state.events.items is loaded
  // alongside the feed (loadEvents() sits in the same Promise.all as
  // loadFeed()), so this needs no realtime subscription of its own: it
  // refreshes exactly when the rest of the feed top area does.
  function upcomingFeedEvent() {
    // state.events.items is sorted start_at ascending by the query itself
    // (loadEvents()'s order()), so the first match is the soonest one.
    return state.events.items.find(isUpcomingEvent) || null;
  }
  function renderUpcomingEventCard() {
    const e = upcomingFeedEvent();
    if (!e) return "";
    const going = eventGoingCount(e.id);
    const mine = myEventResponse(e.id);
    const closed = eventRegistrationClosed(e);
    const full = eventIsFull(e);
    return `<div class="chart-card" style="margin-top:10px;" data-event-id="${esc(e.id)}">
      <button class="link-btn" data-community-action="open-event" data-id="${esc(e.id)}" data-source="club_top" style="padding:0;text-align:right;display:block;width:100%;">
        <div style="font-weight:800;font-size:14px;">📅 ${bidiText(e.title)}</div>
        <div style="color:var(--steel);font-size:12px;margin-top:2px;">${esc(formatEventDate(e.start_at))} ${esc(formatEventTime(e.start_at))} · ${participantsLabel(going)}</div>
      </button>
      <div class="chip-row" style="margin-top:8px;">
        <button class="chip-btn${mine === "going" ? " selected" : ""}" data-community-action="event-rsvp" data-id="${esc(e.id)}" data-response="going"${closed || full || eventRsvpBusy[e.id] ? " disabled" : ""}>משתתף/ת</button>
        <button class="chip-btn${mine === "interested" ? " selected" : ""}" data-community-action="event-rsvp" data-id="${esc(e.id)}" data-response="interested"${closed || eventRsvpBusy[e.id] ? " disabled" : ""}>מעוניין/ת</button>
      </div>
    </div>`;
  }
