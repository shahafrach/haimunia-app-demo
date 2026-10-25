"use strict";
// ---- Community: outward sharing ------------------------------------------
//
// This app to the world outside it: the canvas share-card painter, the
// bidi-isolation rules that keep a mixed Hebrew/Latin caption from reordering
// itself, and the Web Share / copy / download fallbacks behind them. Also the
// window.communityOutwardShare handle app.js's own Progress and Calendar
// share controls reuse, so there is one card and one set of guarantees
// rather than two.
//
// Moved out of cloud.js unchanged. Every line is byte-identical to what it
// was there; nothing renamed, reordered or rewritten.
//
// Classic <script>, no IIFE, loaded before cloud.js — see
// src/community/events.js's header for why all three matter.
//
// The OUTWARD_CARD_NEVER list is the privacy contract, not a style choice.
// Read its own comments before adding a field to the card.

  // ---- The two share glyphs, one definition each ---------------------------
  //
  // Real phone screenshots at 390px: the "ההישגים שלי" list gave every
  // decoration TWO share controls - a chip reading "שיתוף" and, beside it, a
  // bare "↗" - with nothing on screen saying the two went to different
  // audiences. The arrow was also an EMOJI, so it rendered as whatever glyph
  // the phone's emoji font supplied (colour on iOS, a different weight on
  // Android) beside a stroke-drawn app.
  //
  // Both controls are kept and both are now labelled, because they genuinely
  // do different things: one publishes to the club feed, one opens the
  // outward share sheet. The label is what explains them; the icon only
  // distinguishes them at a glance.
  //
  // Declared HERE, in the module that owns outward sharing, and read by
  // src/community/achievements.js's own rows AND by cloud.js's
  // renderShareControl() (the inline "share this session to the club" control
  // on the Add tab, the Calendar day detail and the WOD progress card), which
  // carried its own 📤 and 📷 emoji for the same jobs. One definition per
  // glyph, so the achievements row and the log's share control cannot drift
  // into two different pictures of the same action - CLAUDE.md, "sibling
  // drift". Stroke icons on currentColor, cut to the same 24-box / 2-wide /
  // round-cap conventions as ICONS in app.js, so they take their button's own
  // colour in both themes and need no theme block of their own.
  const SHARE_ICONS = {
    // A megaphone: sharing INTO the club feed, where other members read it.
    club: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 6.5a8 8 0 0 1 0 11"/></svg>',
    // An arrow leaving a box: sharing OUT of the app entirely.
    outward: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3v11"/><path d="M8.5 6.5 12 3l3.5 3.5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
  };

  // ==========================================================================
  // OUTWARD SHARING - this app to the world outside it
  // ==========================================================================
  // The five-persona UX audit's most socially-engaged persona ranked this
  // above wearable sync and called the product "a closed silo with its one
  // internal door locked": zero navigator.share, zero WhatsApp/Instagram, no
  // image export. Everything a member could show anybody lived behind a login
  // the recipient does not have. This block is the outward door.
  //
  // Four rules shape all of it.
  //
  // 1. NOTHING LEAVES THE DEVICE WITHOUT A TAP. The sheet is opened by an
  //    explicit control; the image is rendered locally on a canvas; and
  //    navigator.share() is only ever reached from the share button's own
  //    click. Nothing is auto-shared, nothing is pre-uploaded, and the card
  //    image is NEVER sent to Supabase - it is a Blob that lives in this tab
  //    until the sheet closes and is revoked on the way out.
  //
  //    THAT PART IS UNCHANGED, and it is the part that matters. What DID
  //    change: this block used to say an outward share leaves no server-side
  //    trace at all and that this was why there was no analytics call here.
  //    The premise was right about the CARD and wrong as a rule about the
  //    ACTION - it left outward_share as one of eleven club_features keys a
  //    club could switch on, switch off, and never learn anything about,
  //    which is not privacy, it is an unanswerable question. One row now
  //    records that a share of a given KIND ended in a given RESULT, and
  //    nothing else: no image, no caption, no title, no date, no subject id,
  //    and specifically not the share TARGET, which navigator.share() does
  //    not report back and which this app must not try to infer. Rules 2, 3
  //    and 4 are untouched, and OUTWARD_CARD_NEVER is still the contract for
  //    everything that reaches the canvas.
  //
  // 2. THE CARD CARRIES THE MEMBER'S OWN DATA AND NOTHING ELSE. The spec is
  //    BUILT from a named allow-list per subject kind (OUTWARD_CARD_FIELDS)
  //    rather than filtered after the fact, so a field nobody thought about
  //    cannot reach the canvas just by being present on the source row.
  //    OUTWARD_CARD_NEVER is the written-down reverse of that - the things
  //    that are out unconditionally because they are about the CLUB or about
  //    OTHER PEOPLE, and an image that has left this app has no RLS behind it
  //    any more.
  //
  //    Deliberately NOT gated on show_prs / show_workout_results: those
  //    toggles govern what other club members may read off this profile
  //    (can_view_profile_field), they are not a statement about what the
  //    owner may do with their own record, and both default FALSE
  //    (202608280003) - gating on them would ship a feature that is dead on
  //    arrival for every member who never opened the privacy panel. The one
  //    toggle that IS consulted is visible_to_club, because that one is
  //    specifically about showing this member's identity, and it only sets
  //    the DEFAULT of a per-share name switch the member can flip either way
  //    before sharing.
  //
  // 3. NO URL. V1 has no public web view of a post, so a link on the card or
  //    in the share text would be a link to a login wall - or, worse, an
  //    invitation to build one later and quietly turn every past share into a
  //    public page. navigator.share() is called without `url` on purpose.
  //
  // 4. MIXED SCRIPT IS THE COMMON CASE, NOT THE EDGE CASE. A real card reads
  //    "21-15-9 Thrusters" beside Hebrew - the exact hazard bidiText() exists
  //    for. Canvas has no <bdi>, so bidiIsolate() below wraps every run that
  //    is not certainly Hebrew in U+2068 FSI ... U+2069 PDI, the Unicode
  //    control-character equivalent of the same isolation, and the context's
  //    base direction is set to "rtl" explicitly (a canvas that is not in the
  //    document otherwise resolves its direction to ltr and paints a Hebrew
  //    line in the wrong order).

  // Geometry and palette. 1080x1350 is the 4:5 portrait both Instagram feed
  // and a WhatsApp status accept without recropping.
  const OUTWARD_CARD = Object.freeze({
    WIDTH: 1080,
    HEIGHT: 1350,
    PAD: 84,
    MIME: "image/png",
    FILE_NAME: "box-log.png",
    WORDMARK: brandWordmark(),
    // The dark theme's own tokens (index.html, :root[data-theme="dark"]),
    // written out rather than read through getComputedStyle: the card is the
    // brand's ground and must not flip to the light palette just because the
    // member happens to be running the app in light mode today.
    INK: "#152342",
    SURFACE: "#1F3057",
    BORDER: "#425481",
    CHALK: "#F2ECE1",
    STEEL: "#A8B3C9",
    ENERGY: "#E85D3D",
    BRASS: "#E8B98A",
    SANS: "Rubik, sans-serif",
    MONO: "'JetBrains Mono', Rubik, monospace",
  });
  const OUTWARD_TEXT_MAX = 280;
  const OUTWARD_CAPTION_MAX = 140;

  // Rule 2, the allow-list. Nothing outside these lists is ever read off a
  // subject, so adding a column to private_records or to post.metadata cannot
  // widen what an outward card discloses.
  const OUTWARD_CARD_FIELDS = Object.freeze({
    pr: Object.freeze(["title", "newResult", "previousResult", "improvement", "dateText"]),
    achievement: Object.freeze(["title", "explanation", "dateText"]),
    workout: Object.freeze(["title", "result", "scoreType", "effortLabel", "dateText"]),
  });
  // Rule 2, written in reverse so the reason survives. Every name here is a
  // field that exists somewhere on a feed row, a profile or a recap and is
  // deliberately absent from the lists above. The list is the fixture the
  // outward-share test builds its adversarial subject from - if a future
  // ticket adds one of these to a card, that test fails first.
  const OUTWARD_CARD_NEVER = Object.freeze([
    // About the club, not the member.
    "clubName", "club_id", "clubId", "club",
    // About other members.
    "handle", "authorHandle", "classmates", "attendees", "otherMembers",
    "memberCount", "followers", "following",
    // A position is a statement about everybody else's results.
    "leaderboardRank", "rank", "position", "percentile",
    // Server-enforced-private by default, and never the subject of a share.
    "attendance", "upcomingBooking", "bookings",
    // Engagement is other people's behaviour, and a count on an exported
    // image is a number nobody can verify and nobody asked to publish.
    "reactionCount", "commentCount",
    // Rule 3.
    "url", "postUrl", "link",
    // In-club audience, meaningless outside it and misleading on an image.
    "visibility",
  ]);

  // The bumper-plate medal idiom, matching assets/medal-*.png exactly (the
  // colours are sampled from those files, the weights are the labels printed
  // on them). Drawn procedurally rather than by loading the PNG: the card is
  // 1080px wide and the assets are 320px, this keeps it crisp, it needs no
  // decode step in the middle of an already-async render, and it cannot fail
  // offline.
  const OUTWARD_PLATES = Object.freeze({
    bronze: Object.freeze({ color: "#727272", weight: "5 KG" }),
    silver: Object.freeze({ color: "#00903C", weight: "10 KG" }),
    gold: Object.freeze({ color: "#002E84", weight: "20 KG" }),
  });
  // Which plate an achievement earns. Explicit rather than derived from the
  // emoji in COMMUNITY_ACHIEVEMENT_META: that map is display copy and its
  // icons change, and a silently re-tiered medal is a worse bug than a
  // missing one. Anything not listed is bronze, which is the truthful
  // default - every code here is a real unlock.
  const OUTWARD_ACHIEVEMENT_TIER = Object.freeze({
    sessions_50: "silver", sessions_100: "gold", sessions_250: "gold",
    pr_25: "silver", pr_50: "gold", pr_100: "gold",
    consistency_weeks_12: "silver", consistency_weeks_26: "gold", consistency_weeks_52: "gold",
    attendance_25_classes: "silver", attendance_100_classes: "gold", attendance_weekly_streak: "silver",
    anniversary_year_2: "silver", anniversary_year_3: "gold", anniversary_year_5: "gold",
    well_rounded: "silver", supportive_10: "silver",
    challenge_finisher: "silver", challenge_winner: "gold",
  });
  function outwardPlateTier(code) {
    return Object.prototype.hasOwnProperty.call(OUTWARD_ACHIEVEMENT_TIER, code) ? OUTWARD_ACHIEVEMENT_TIER[code] : "bronze";
  }

  // The headline over each kind of card, and the one-word chip beside it.
  const OUTWARD_KIND_COPY = Object.freeze({
    pr: Object.freeze({ headline: "שיא אישי חדש", chip: "PR" }),
    achievement: Object.freeze({ headline: "מדליה חדשה", chip: "הישג" }),
    workout: Object.freeze({ headline: "אימון הושלם", chip: "אימון" }),
  });

  // Canvas has no <bdi>. FSI ... PDI is the same thing in control characters:
  // the run takes its base direction from its own first strong character and
  // cannot reorder against the paragraph around it. Applied to every value
  // that is not certainly Hebrew - movement names, results, weights, dates,
  // rep schemes - and it survives into the plain-text share too, where
  // WhatsApp and every other modern target honour it.
  function bidiIsolate(value) {
    const s = String(value == null ? "" : value);
    return s ? "⁨" + s + "⁩" : "";
  }
  const OUTWARD_HEBREW_RE = /[֐-׿יִ-ﭏ]/;
  // FSI's first-strong rule is right for an ATOMIC value - "180 ק\"ג",
  // "8:42", "Rx" - where the whole run is one thing and its own first strong
  // character is the honest answer.
  //
  // It is wrong for PROSE that merely STARTS with a Latin word. A caption
  // reading
  //
  //     Rx 43/30 ק״ג. נשבר לי הראש בסיבוב האחרון.
  //
  // resolves to an LTR base off that leading "Rx", which puts the whole
  // Hebrew remainder in one reversed run and leaves the ק״ג at the far end of
  // the line from the 43/30 it belongs to - the exact second symptom two
  // personas reported (see bidiText's own header). A sentence containing any
  // Hebrew is a Hebrew sentence in a Hebrew-first app, so it gets U+2067 RLI:
  // an explicit RTL base inside an isolate, which keeps the weight next to
  // its unit and still renders the Latin run itself left-to-right. A run with
  // no Hebrew in it at all falls back to FSI and behaves exactly as before.
  //
  // Only the card does this. bidiText() keeps <bdi>'s first-strong rule, both
  // because that is the whole point of <bdi> and because a card is a fixed,
  // known-width composition where the base direction is a design decision
  // rather than a guess.
  //
  // OPEN, AND KNOWN TO DIVERGE — the mirror of this note lives on bidiText()
  // in src/shared/safe-helpers.js; change both sites or neither.
  //
  // The paragraph above is not just a note about the card, it is a live
  // DISAGREEMENT between the two surfaces about one shape: an LTR-first
  // sentence with a long Hebrew tail, `Rx 43/30 ק״ג. נשבר לי הראש`. This
  // function gives it an RTL base and keeps the unit beside its number. The
  // DOM path resolves first-strong, so the same sentence there resolves LTR
  // off the leading `Rx` and paints the ק״ג about eight characters away from
  // the 43/30 — the second symptom bidiText()'s own header documents, still
  // present on the DOM surfaces and NOT fixed by the run-level isolation
  // added alongside this note.
  //
  // Whether the app should adopt this function's rule everywhere is a product
  // decision, not a bug: doing so would flip
  // `21-15-9 Thrusters + Pull-ups. Rx 43/30 ק״ג.` to an RTL base and break
  // the assertion in scripts/browser-check/bidi-rtl-geometry.mjs that its rep
  // scheme paints at the start of the line. Left for the owner on purpose.
  function bidiIsolateProse(value) {
    const s = String(value == null ? "" : value);
    if (!s) return "";
    return (OUTWARD_HEBREW_RE.test(s) ? "⁧" : "⁨") + s + "⁩";
  }
  // Strip the isolates back out. Used only for assertions and for the
  // clipboard fallback's own length maths, never for anything that paints.
  function stripBidiIsolates(value) { return String(value == null ? "" : value).replace(/[⁦-⁩]/g, ""); }

  function outwardDateText(value) {
    const s = String(value == null ? "" : value).trim();
    if (!s) return "";
    return s.slice(0, 10);
  }
  function outwardClean(value, max) {
    return String(value == null ? "" : value)
      .replace(/\r\n?/g, "\n")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
      .replace(/\s*\n\s*/g, " ")
      .trim()
      .slice(0, max || 120);
  }

  // ---- Subject -> spec ---------------------------------------------------
  // A "subject" is whatever the caller has in hand (a PR record off the event
  // bus, a member_achievements row, a feed post). buildOutwardShareSpec() is
  // the ONLY way a subject becomes something paintable, and it reads exactly
  // the fields OUTWARD_CARD_FIELDS names for that kind. Pure: no state, no
  // DOM, no canvas - which is what makes rule 2 testable.
  function buildOutwardShareSpec(subject, opts) {
    const o = opts || {};
    const kind = subject && OUTWARD_CARD_FIELDS[subject.kind] ? subject.kind : null;
    if (!kind) return null;
    const allowed = OUTWARD_CARD_FIELDS[kind];
    const read = (field, max) => (allowed.indexOf(field) >= 0 ? outwardClean(subject[field], max) : "");
    const title = read("title", 80);
    if (!title) return null;
    const rows = [];
    const push = (label, field) => { const v = read(field, 60); if (v) rows.push({ label, value: v }); };
    if (kind === "pr") {
      push("תוצאה חדשה", "newResult");
      push("תוצאה קודמת", "previousResult");
      push("שיפור", "improvement");
    } else if (kind === "workout") {
      push("תוצאה", "result");
      push("סוג ניקוד", "scoreType");
      push("רמה", "effortLabel");
    }
    const copy = OUTWARD_KIND_COPY[kind];
    return {
      kind,
      headline: copy.headline,
      chip: copy.chip,
      title,
      // The single big number the card is built around, when there is one.
      hero: rows.length ? rows[0].value : "",
      rows,
      explanation: kind === "achievement" ? read("explanation", 90) : "",
      dateText: allowed.indexOf("dateText") >= 0 ? outwardDateText(subject.dateText) : "",
      plate: kind === "achievement" ? outwardPlateTier(String(subject.code || "")) : null,
      // Never read off the subject: the name comes from the signed-in
      // member's own profile through openOutwardShare(), and only when the
      // name switch is on. A subject cannot smuggle a display name onto a
      // card by carrying one.
      name: o.name ? outwardClean(o.name, 40) : "",
      caption: outwardClean(o.caption, OUTWARD_CAPTION_MAX),
      wordmark: OUTWARD_CARD.WORDMARK,
    };
  }

  // The three adapters. Each one names the fields it lifts, so the mapping
  // from a wire row to a card is readable in one place per source.
  function outwardSubjectFromPrRecord(record) {
    if (!record) return null;
    return {
      kind: "pr",
      title: record.movement || record.movement_name || "",
      newResult: record.new_result || record.new_value || "",
      previousResult: record.previous_result || record.previous_value || "",
      improvement: record.improvement || "",
      dateText: record.achieved_on || record.occurred_on || "",
    };
  }
  function outwardSubjectFromAchievement(meta, code, earnedOn) {
    if (!meta || !meta.title) return null;
    return { kind: "achievement", code: code || "", title: meta.title, explanation: meta.explanation || "", dateText: earnedOn || "" };
  }
  // A feed post the member owns. POST_PR / POST_WORKOUT / POST_ACHIEVEMENT
  // only: the other nine types are either about the club (announcement,
  // system, new member), about somebody else's content, or a link card whose
  // whole point is a destination the recipient cannot reach.
  function outwardSubjectFromPost(post) {
    if (!post || !postIsOwn(post)) return null;
    const m = post.metadata || {};
    if (post.post_type === "POST_PR") {
      return outwardSubjectFromPrRecord({
        movement: m.movement || m.movement_name || post.title,
        new_result: m.new_result || m.new_value,
        previous_result: m.previous_result || m.previous_value,
        improvement: m.improvement,
        achieved_on: m.achieved_on || post.occurred_on,
      });
    }
    if (post.post_type === "POST_ACHIEVEMENT") {
      return { kind: "achievement", code: m.code || "", title: m.title || post.title || "", explanation: m.explanation || "", dateText: m.earned_on || post.occurred_on || "" };
    }
    if (post.post_type === "POST_WORKOUT") {
      const effort = m.effort || (post.rx === true ? "rx" : post.rx === false ? "scaled" : m.level ? "level" : "");
      return {
        kind: "workout",
        title: m.workout_name || post.title || "",
        result: m.result_text || post.result_text || "",
        scoreType: m.score_type || post.score_type || "",
        effortLabel: effort === "rx" ? "Rx" : effort === "scaled" ? "מותאם" : effort === "level" ? ("רמה " + (m.level || "")).trim() : "",
        dateText: m.workout_date || post.occurred_on || "",
      };
    }
    return null;
  }
  // Which own posts get the outward control at all.
  const OUTWARD_SHAREABLE_POST_TYPES = Object.freeze(["POST_PR", "POST_ACHIEVEMENT", "POST_WORKOUT"]);

  // ---- The share text ----------------------------------------------------
  // Short on purpose. The image is what gets looked at; this is the line that
  // sits above it in WhatsApp and the whole payload in the clipboard
  // fallback. No URL (rule 3), no club name, no other member (rule 2).
  function outwardShareText(spec) {
    if (!spec) return "";
    const lines = [];
    lines.push(spec.headline + (spec.title ? " · " + bidiIsolateProse(spec.title) : ""));
    if (spec.hero) lines.push(bidiIsolate(spec.hero));
    if (spec.caption) lines.push(bidiIsolateProse(spec.caption));
    lines.push("— " + spec.wordmark);
    return balanceBidiIsolates(lines.join("\n").slice(0, OUTWARD_TEXT_MAX));
  }
  // A hard slice can cut between an opening isolate and its PDI, and an
  // unterminated FSI/RLI does not stop at the end of the string - it swallows
  // whatever the receiving app pastes after it. So the cap is applied first
  // and the isolates are then closed off, which is a visible truncation
  // rather than a control character leaking into somebody's WhatsApp message.
  function balanceBidiIsolates(text) {
    const opens = (text.match(/[⁦⁧⁨]/g) || []).length;
    const closes = (text.match(/⁩/g) || []).length;
    return opens > closes ? text + "⁩".repeat(opens - closes) : text;
  }

  // ---- Painting ----------------------------------------------------------
  // paintOutwardShareCard() takes a 2D context and never creates one, for the
  // same reason src/image.js splits its sizing maths from its browser
  // backend: the layout is then exercisable against a recording context with
  // no canvas implementation in the room.
  function outwardRoundRect(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }
  // Greedy wrap on spaces. Hebrew and Latin both break on spaces here, and a
  // card line is short enough that a smarter algorithm would only change
  // where the ragged edge falls.
  function wrapOutwardText(ctx, text, maxWidth, maxLines) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const lines = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? current + " " + word : word;
      if (current && ctx.measureText(candidate).width > maxWidth) {
        lines.push(current);
        current = word;
        if (maxLines && lines.length >= maxLines) { current = ""; break; }
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
    return maxLines ? lines.slice(0, maxLines) : lines;
  }
  // The bumper plate: a filled disc, the outer white ring, four spokes, the
  // hub, and the printed weight - the same five elements assets/medal-*.png
  // is made of.
  function paintOutwardPlate(ctx, cx, cy, radius, tier) {
    const plate = OUTWARD_PLATES[tier] || OUTWARD_PLATES.bronze;
    ctx.save();
    ctx.fillStyle = plate.color;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#FFFFFF";
    ctx.lineCap = "round";
    ctx.lineWidth = radius * 0.045;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.84, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = radius * 0.055;
    for (let i = 0; i < 4; i++) {
      const angle = Math.PI / 4 + (i * Math.PI) / 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * radius * 0.32, cy + Math.sin(angle) * radius * 0.32);
      ctx.lineTo(cx + Math.cos(angle) * radius * 0.70, cy + Math.sin(angle) * radius * 0.70);
      ctx.stroke();
    }
    ctx.lineWidth = radius * 0.05;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.40, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.16, 0, Math.PI * 2);
    ctx.fill();
    // The printed weight. LTR by construction ("20 KG"), so it is isolated
    // and drawn centre-aligned rather than inheriting the card's rtl base.
    ctx.direction = "ltr";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `800 ${Math.round(radius * 0.20)}px ${OUTWARD_CARD.SANS}`;
    ctx.fillText(bidiIsolate(plate.weight), cx, cy - radius * 0.58);
    ctx.restore();
  }
  // The body of the card, laid out from `top` downwards, returning the y it
  // finished at. Called TWICE per card: once with draw=false to find out how
  // tall this particular subject is, and once with draw=true at the offset
  // that centres it between the header and the footer rule. A single pass
  // cannot do that - the height depends on how many rows the subject has, on
  // whether there is a plate, and on how many lines the title and the caption
  // wrap to, which is only knowable after measureText. The dry pass runs the
  // identical arithmetic and simply skips the paint calls, so the two passes
  // can never disagree about where anything goes.
  function outwardCardBody(ctx, spec, W, top, draw) {
    const PAD = OUTWARD_CARD.PAD;
    let y = top;
    const line = (text, x) => { if (draw) ctx.fillText(text, x, y); };

    // The plate, when this is an achievement. It is the subject of the card,
    // so it sits above the words rather than beside them.
    if (spec.plate) {
      const radius = 190;
      if (draw) {
        paintOutwardPlate(ctx, W / 2, y + radius, radius, spec.plate);
        ctx.direction = "rtl";
        ctx.textBaseline = "alphabetic";
      }
      y += radius * 2 + 72;
    }

    ctx.textAlign = "right";
    ctx.fillStyle = OUTWARD_CARD.STEEL;
    ctx.font = `600 34px ${OUTWARD_CARD.SANS}`;
    line(spec.headline, W - PAD);
    y += 74;

    ctx.fillStyle = OUTWARD_CARD.CHALK;
    ctx.font = `800 66px ${OUTWARD_CARD.SANS}`;
    // Wrap the RAW text and isolate each resulting LINE, never the other way
    // round: wrapping an already-isolated string splits the FSI/RLI from its
    // PDI across two lines, leaving line one with an opening control it never
    // closes and line two with a stray close. Per-line isolation is also what
    // bidiText() does in the DOM, and for the same reason - a two-line title
    // can legitimately want two different base directions.
    for (const l of wrapOutwardText(ctx, spec.title, W - PAD * 2, 2)) {
      line(bidiIsolateProse(l), W - PAD);
      y += 82;
    }

    if (spec.explanation) {
      ctx.fillStyle = OUTWARD_CARD.STEEL;
      ctx.font = `400 32px ${OUTWARD_CARD.SANS}`;
      y += 8;
      for (const l of wrapOutwardText(ctx, spec.explanation, W - PAD * 2, 2)) {
        line(bidiIsolateProse(l), W - PAD);
        y += 44;
      }
    }

    // The hero figure, when the card has one. Mono and energy, the same
    // pairing .mono + var(--energy) has everywhere in the app.
    if (spec.hero) {
      y += 44;
      ctx.fillStyle = OUTWARD_CARD.ENERGY;
      ctx.font = `700 112px ${OUTWARD_CARD.MONO}`;
      y += 92;
      line(bidiIsolate(spec.hero), W - PAD);
      y += 62;
    }

    // The remaining rows, in a surface panel. Label on the RTL start edge,
    // value isolated on the other.
    const detailRows = spec.rows.slice(spec.hero ? 1 : 0);
    if (detailRows.length) {
      y += 24;
      const rowH = 68;
      const panelH = detailRows.length * rowH + 28;
      if (draw) {
        ctx.fillStyle = OUTWARD_CARD.SURFACE;
        outwardRoundRect(ctx, PAD, y, W - PAD * 2, panelH, 26);
        ctx.fill();
        ctx.strokeStyle = OUTWARD_CARD.BORDER;
        ctx.lineWidth = 2;
        ctx.stroke();
        let rowY = y + 60;
        for (const row of detailRows) {
          ctx.textAlign = "right";
          ctx.fillStyle = OUTWARD_CARD.STEEL;
          ctx.font = `600 30px ${OUTWARD_CARD.SANS}`;
          ctx.fillText(row.label, W - PAD - 28, rowY);
          ctx.textAlign = "left";
          ctx.fillStyle = OUTWARD_CARD.BRASS;
          ctx.font = `700 34px ${OUTWARD_CARD.MONO}`;
          ctx.fillText(bidiIsolate(row.value), PAD + 28, rowY);
          rowY += rowH;
        }
      }
      y += panelH;
    }

    if (spec.caption) {
      y += 72;
      ctx.textAlign = "right";
      ctx.fillStyle = OUTWARD_CARD.CHALK;
      ctx.font = `400 34px ${OUTWARD_CARD.SANS}`;
      for (const l of wrapOutwardText(ctx, spec.caption, W - PAD * 2, 3)) {
        line(bidiIsolateProse(l), W - PAD);
        y += 50;
      }
    }
    return y;
  }

  function paintOutwardShareCard(ctx, spec, dims) {
    const W = (dims && dims.width) || OUTWARD_CARD.WIDTH;
    const H = (dims && dims.height) || OUTWARD_CARD.HEIGHT;
    const PAD = OUTWARD_CARD.PAD;
    // Rule 4: the whole card is an RTL paragraph. Every LTR run inside it is
    // isolated at the value level, never by flipping this back to ltr.
    ctx.direction = "rtl";
    ctx.textBaseline = "alphabetic";

    ctx.fillStyle = OUTWARD_CARD.INK;
    ctx.fillRect(0, 0, W, H);
    // The energy rule along the top edge - the app's own accent, the one
    // thing that makes the card recognisable at thumbnail size.
    ctx.fillStyle = OUTWARD_CARD.ENERGY;
    ctx.fillRect(0, 0, W, 14);

    // Header: wordmark on the right (the RTL start edge), kind chip on the left.
    ctx.textAlign = "right";
    ctx.fillStyle = OUTWARD_CARD.BRASS;
    ctx.font = `800 40px ${OUTWARD_CARD.SANS}`;
    ctx.fillText(spec.wordmark, W - PAD, 112);

    ctx.font = `800 30px ${OUTWARD_CARD.SANS}`;
    const chipText = bidiIsolate(spec.chip);
    const chipW = ctx.measureText(chipText).width + 52;
    ctx.fillStyle = OUTWARD_CARD.ENERGY;
    outwardRoundRect(ctx, PAD, 74, chipW, 52, 26);
    ctx.fill();
    ctx.fillStyle = "#1A0D08";
    ctx.textAlign = "center";
    ctx.fillText(chipText, PAD + chipW / 2, 111);

    // Centre the body in the space between the header and the footer rule.
    // A short PR card and a long achievement card then both sit balanced,
    // instead of every card hugging the top edge with a third of the frame
    // left empty underneath.
    const bandTop = 200;
    const bandBottom = H - 200;
    const bodyTop = 214;
    const bodyHeight = outwardCardBody(ctx, spec, W, bodyTop, false) - bodyTop;
    const slack = (bandBottom - bandTop) - bodyHeight;
    outwardCardBody(ctx, spec, W, bandTop + Math.max(0, slack / 2), true);

    // Footer: name (only when the switch is on) and date, on one baseline.
    ctx.fillStyle = OUTWARD_CARD.ENERGY;
    ctx.fillRect(PAD, H - 158, W - PAD * 2, 3);
    ctx.textAlign = "right";
    ctx.fillStyle = OUTWARD_CARD.STEEL;
    ctx.font = `600 30px ${OUTWARD_CARD.SANS}`;
    if (spec.name) ctx.fillText(bidiIsolate(spec.name), W - PAD, H - 96);
    if (spec.dateText) {
      ctx.textAlign = "left";
      ctx.font = `500 28px ${OUTWARD_CARD.MONO}`;
      ctx.fillText(bidiIsolate(spec.dateText), PAD, H - 96);
    }
    return spec;
  }

  // ---- Canvas backend ----------------------------------------------------
  // Same split as src/image.js: the pure layout above, the browser-only bits
  // here. A context that cannot be had is a failed render with a message, not
  // a throw - the sheet stays usable and the text share still works.
  function outwardCreateCanvas(width, height) {
    if (typeof OffscreenCanvas === "function") {
      try { return new OffscreenCanvas(width, height); } catch (e) { /* fall through */ }
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  async function outwardCanvasToBlob(canvas) {
    if (typeof canvas.convertToBlob === "function") return await canvas.convertToBlob({ type: OUTWARD_CARD.MIME });
    return await new Promise((resolve, reject) => {
      if (typeof canvas.toBlob !== "function") return reject(new Error("no_canvas"));
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no_canvas"))), OUTWARD_CARD.MIME);
    });
  }
  // The webfonts are loaded by index.html's own @font-face rules (font-src
  // 'self', self-hosted under assets/fonts). A canvas draws with whatever is
  // ALREADY loaded, so a cold card would otherwise paint in the fallback
  // sans. document.fonts.load() only warms what the page already declares -
  // it fetches nothing new and needs no CSP change - and a browser without
  // the API just paints a beat later in the fallback face.
  async function outwardEnsureFonts() {
    if (!document.fonts || typeof document.fonts.load !== "function") return;
    const faces = [`800 66px Rubik`, `600 34px Rubik`, `400 32px Rubik`, `700 104px "JetBrains Mono"`, `500 28px "JetBrains Mono"`];
    try {
      await Promise.all(faces.map((f) => document.fonts.load(f, "אב0123")));
    } catch (e) { /* paint in the fallback face rather than not at all */ }
  }
  async function renderOutwardShareBlob(spec) {
    await outwardEnsureFonts();
    const canvas = outwardCreateCanvas(OUTWARD_CARD.WIDTH, OUTWARD_CARD.HEIGHT);
    const ctx = canvas.getContext ? canvas.getContext("2d") : null;
    if (!ctx) throw new Error("no_canvas");
    paintOutwardShareCard(ctx, spec, { width: OUTWARD_CARD.WIDTH, height: OUTWARD_CARD.HEIGHT });
    const blob = await outwardCanvasToBlob(canvas);
    if (!blob) throw new Error("no_canvas");
    return blob;
  }

  // ---- The Web Share API, feature-detected -------------------------------
  // Three tiers, best first. Every one of them is reached from a click, and
  // the File is prepared when the SHEET opens rather than when the button is
  // pressed - iOS in particular drops the transient user activation
  // navigator.share() requires if an await sits between the tap and the call.
  const OUTWARD_SHARE_RESULTS = Object.freeze({
    SHARED_IMAGE: "shared_image",
    SHARED_TEXT: "shared_text",
    COPIED: "copied",
    CANCELLED: "cancelled",
    FAILED: "failed",
  });
  function outwardShareFile(blob) {
    if (!blob || typeof File !== "function") return null;
    try { return new File([blob], OUTWARD_CARD.FILE_NAME, { type: OUTWARD_CARD.MIME }); } catch (e) { return null; }
  }
  // canShare({files}) is the only honest test: Chrome on desktop Linux has
  // navigator.share and refuses files, Firefox has neither, and a browser
  // that has share() but not canShare() predates file sharing entirely.
  function outwardCanShareFile(file) {
    if (!file) return false;
    if (typeof navigator === "undefined") return false;
    if (typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
    try { return !!navigator.canShare({ files: [file] }); } catch (e) { return false; }
  }
  function outwardCanShareText() {
    return typeof navigator !== "undefined" && typeof navigator.share === "function";
  }
  function outwardCanCopy() {
    return typeof navigator !== "undefined" && !!navigator.clipboard && typeof navigator.clipboard.writeText === "function";
  }
  async function performOutwardShare(spec, file) {
    const text = outwardShareText(spec);
    // No `url`. See rule 3.
    if (outwardCanShareFile(file)) {
      try {
        await navigator.share({ files: [file], text, title: spec.wordmark });
        return OUTWARD_SHARE_RESULTS.SHARED_IMAGE;
      } catch (err) {
        if (err && err.name === "AbortError") return OUTWARD_SHARE_RESULTS.CANCELLED;
        // A target that accepted canShare and then threw (an Android share
        // sheet with no app able to take a PNG) still deserves the text.
      }
    }
    if (outwardCanShareText()) {
      try {
        await navigator.share({ text, title: spec.wordmark });
        return OUTWARD_SHARE_RESULTS.SHARED_TEXT;
      } catch (err) {
        if (err && err.name === "AbortError") return OUTWARD_SHARE_RESULTS.CANCELLED;
      }
    }
    if (outwardCanCopy()) {
      try {
        await navigator.clipboard.writeText(text);
        return OUTWARD_SHARE_RESULTS.COPIED;
      } catch (err) { /* fall through to the honest failure below */ }
    }
    return OUTWARD_SHARE_RESULTS.FAILED;
  }
  // What the member is told afterwards. Flat lookup, what-happened plus
  // what-to-do, and nothing says "try again" where a retry cannot succeed -
  // the same shape as serverErrorText(). FAILED is the one case where the
  // device genuinely cannot share OR copy, so it points at the download,
  // which is the only remaining way out.
  const OUTWARD_SHARE_RESULT_TEXT = Object.freeze({
    shared_image: "התמונה נשלחה לאפליקציה שבחרתם.",
    shared_text: "הטקסט נשלח. המכשיר הזה לא תומך בשיתוף תמונה, אפשר להוריד אותה ולצרף ידנית.",
    copied: "הטקסט הועתק. הדפדפן הזה לא תומך בשיתוף ישיר - אפשר להדביק, ולהוריד את התמונה בנפרד.",
    cancelled: "השיתוף בוטל. שום דבר לא יצא מהמכשיר.",
    failed: "הדפדפן הזה לא תומך בשיתוף ולא בהעתקה. אפשר להוריד את התמונה ולשתף אותה ידנית.",
  });
  function outwardShareResultText(result) {
    return OUTWARD_SHARE_RESULT_TEXT[result] || OUTWARD_SHARE_RESULT_TEXT.failed;
  }

  // ---- The sheet ---------------------------------------------------------
  function outwardRevokePreview() {
    const s = state.posts.outwardShare;
    if (s && s.previewUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      try { URL.revokeObjectURL(s.previewUrl); } catch (e) {}
    }
  }
  function closeOutwardShare() {
    outwardRevokePreview();
    state.posts.outwardShare = null;
    rerender();
  }
  // Rule 2: the default of the name switch is the member's own
  // visible_to_club, and the switch itself is always there. A member who has
  // hidden their profile from the club does not get their name pre-loaded
  // onto an image that is about to leave the app.
  function outwardDefaultShowName() {
    return !!(state.profile && state.profile.visible_to_club !== false && (state.profile.display_name || "").trim());
  }
  function openOutwardShare(subject, opts) {
    if (!subject) return;
    const o = opts || {};
    outwardRevokePreview();
    const showName = outwardDefaultShowName();
    state.posts.outwardShare = {
      subject,
      caption: outwardClean(o.caption, OUTWARD_CAPTION_MAX),
      showName,
      spec: null,
      status: "rendering",
      previewUrl: null,
      blob: null,
      sharing: false,
      result: "",
    };
    state.posts.openMenu = null;
    rerender();
    refreshOutwardShareCard();
  }
  // Rebuilds the spec and repaints. Called on open and whenever the name
  // switch flips - the card is the payload, so it always shows exactly what
  // would be sent.
  async function refreshOutwardShareCard() {
    const s = state.posts.outwardShare;
    if (!s) return;
    const spec = buildOutwardShareSpec(s.subject, {
      name: s.showName ? (state.profile && state.profile.display_name) || "" : "",
      caption: s.caption,
    });
    if (!spec) { s.status = "failed"; return rerender(); }
    s.spec = spec;
    s.status = "rendering";
    rerender();
    let blob = null;
    try {
      blob = await renderOutwardShareBlob(spec);
    } catch (err) {
      if (state.posts.outwardShare !== s) return;
      s.status = "failed";
      s.blob = null;
      return rerender();
    }
    if (state.posts.outwardShare !== s) return; // closed mid-render
    outwardRevokePreview();
    s.blob = blob;
    s.previewUrl = (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") ? URL.createObjectURL(blob) : null;
    s.status = "ready";
    rerender();
  }
  function setOutwardShareName(on) {
    const s = state.posts.outwardShare;
    if (!s || s.showName === !!on) return;
    s.showName = !!on;
    refreshOutwardShareCard();
  }
  async function outwardShareNow() {
    const s = state.posts.outwardShare;
    if (!s || !s.spec || s.sharing) return;
    s.sharing = true;
    s.result = "";
    rerender();
    const result = await performOutwardShare(s.spec, outwardShareFile(s.blob));
    if (state.posts.outwardShare !== s) return;
    s.sharing = false;
    s.result = result;
    // The outward_share module's one event. Both props are closed enums that
    // already exist in this file - OUTWARD_CARD_FIELDS' three subject kinds
    // and OUTWARD_SHARE_RESULTS' five outcomes - which is what makes the row
    // impossible to widen by accident from here.
    //
    // `cancelled` is recorded, not dropped. "Members open the sheet and back
    // out" and "members never open it" are different findings and only one of
    // them is about the feature; a share sheet that is opened and abandoned
    // at scale is the single most useful thing this event can say.
    //
    // Not a WCAM event: this is a share to somewhere that is not this club,
    // the same line the module map already draws between workout_shared and
    // outward_share.
    track(A.OUTWARD_SHARE_COMPLETED, { kind: (s.spec && s.spec.kind) || null, result: result });
    setMessage(outwardShareResultText(result));
    if (typeof window.showToast === "function") window.showToast(outwardShareResultText(result));
    rerender();
  }
  async function outwardCopyText() {
    const s = state.posts.outwardShare;
    if (!s || !s.spec) return;
    let ok = false;
    if (outwardCanCopy()) {
      try { await navigator.clipboard.writeText(outwardShareText(s.spec)); ok = true; } catch (e) { ok = false; }
    }
    if (state.posts.outwardShare !== s) return;
    s.result = ok ? OUTWARD_SHARE_RESULTS.COPIED : OUTWARD_SHARE_RESULTS.FAILED;
    // The sheet's second exit. Same name and same two props as the share
    // button above: a member who copied the text shared outwardly just as
    // much as one whose device had a share sheet to offer.
    track(A.OUTWARD_SHARE_COMPLETED, { kind: (s.spec && s.spec.kind) || null, result: s.result });
    const text = ok ? "הטקסט הועתק." : OUTWARD_SHARE_RESULT_TEXT.failed;
    setMessage(text);
    if (typeof window.showToast === "function") window.showToast(text);
    rerender();
  }
  // The last resort, and the one path that works on any browser with a
  // canvas: save the PNG and attach it by hand. An <a download> rather than
  // a navigation - the object URL is same-origin and img-src already allows
  // blob:, and nothing here opens a window.
  function outwardDownloadImage() {
    const s = state.posts.outwardShare;
    if (!s || !s.previewUrl) return;
    const a = document.createElement("a");
    a.href = s.previewUrl;
    a.download = OUTWARD_CARD.FILE_NAME;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setMessage("התמונה נשמרה במכשיר.");
  }

  // The disclosure line. Written out rather than implied, because "what is
  // on this image" is the only question a member has at the moment of the
  // tap, and the answer is short.
  const OUTWARD_PRIVACY_NOTE = "על התמונה מופיעים רק הנתונים שלכם. שמות של חברי מועדון אחרים, שם המועדון, מיקום בטבלאות ונוכחות - לא מופיעים, וקישור אין.";

  function renderOutwardShareSheet() {
    const s = state.posts.outwardShare;
    if (!s) return "";
    const spec = s.spec;
    const canShare = outwardCanShareText();
    const ready = s.status === "ready";
    const preview = s.status === "rendering"
      ? `<div class="empty" aria-busy="true" style="height:220px;display:flex;align-items:center;justify-content:center;">מכין את התמונה…</div>`
      : s.status === "failed"
        ? `<div class="empty" data-outward-preview="failed">לא ניתן היה להכין את התמונה במכשיר הזה. אפשר עדיין לשתף או להעתיק את הטקסט.<div class="chip-row" style="justify-content:center;"><button class="chip-btn" data-community-action="outward-retry">ניסיון חוזר</button></div></div>`
        : s.previewUrl
          ? `<img data-outward-preview="ready" src="${esc(s.previewUrl)}" alt="${esc(outwardPreviewAltText(spec))}" style="width:100%;max-width:320px;display:block;margin:0 auto;border-radius:16px;border:1px solid var(--border);"/>`
          : `<div class="empty" data-outward-preview="ready">התמונה מוכנה.</div>`;
    const nameRow = `<label class="log-row" style="justify-content:space-between;gap:12px;cursor:pointer;margin-top:10px;">
      <span style="font-size:13px;">הצגת השם שלי על התמונה</span>
      <input type="checkbox" data-outward-name${s.showName ? " checked" : ""} aria-label="הצגת השם שלי על התמונה"/>
    </label>`;
    const textPreview = spec ? `<div class="field-label" style="margin:12px 0 4px;">הטקסט שילווה את התמונה</div>
      <div style="background:var(--surface2);border-radius:12px;padding:10px 12px;font-size:13px;white-space:pre-wrap;">${bidiText(stripBidiIsolates(outwardShareText(spec)))}</div>` : "";
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="outwardShareTitle" data-cloud-dialog="outwardShare" style="align-items:center;padding:0 16px;">
      <div class="modal-sheet" id="outwardShare" style="border-radius:22px;max-height:90vh;overflow:auto;">
        <div style="padding:22px 20px calc(env(safe-area-inset-bottom,0px) + 18px);">
          <h2 id="outwardShareTitle" style="margin-top:0;color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:10px;">שיתוף מחוץ לאפליקציה</h2>
          ${preview}
          ${nameRow}
          ${textPreview}
          <div class="footer-note" style="margin-top:10px;">${esc(OUTWARD_PRIVACY_NOTE)}</div>
          ${s.result ? `<div class="footer-note" role="status" data-outward-result="${esc(s.result)}" style="color:var(--steel);">${esc(outwardShareResultText(s.result))}</div>` : ""}
          <div class="chip-row" style="margin-top:14px;flex-wrap:wrap;">
            <button class="chip-btn primary" data-community-action="outward-go"${s.sharing || !spec ? " disabled" : ""}>${s.sharing ? "משתף…" : canShare ? "שיתוף" : "העתקת הטקסט"}</button>
            ${canShare ? `<button class="chip-btn" data-community-action="outward-copy"${spec ? "" : " disabled"}>העתקת הטקסט</button>` : ""}
            <button class="chip-btn" data-community-action="outward-download"${ready && s.previewUrl ? "" : " disabled"}>הורדת התמונה</button>
            <button class="chip-btn" data-community-action="outward-close">סגירה</button>
          </div>
        </div>
      </div>
    </div>`;
  }
  // The preview <img> is a real image of real content, so it gets a real
  // alt - the same facts the card paints, in the same order. A decorative
  // alt="" would hide the entire subject of this dialog from a screen reader.
  function outwardPreviewAltText(spec) {
    if (!spec) return "תצוגה מקדימה של תמונת השיתוף";
    const bits = [spec.headline, spec.title];
    if (spec.hero) bits.push(spec.hero);
    for (const row of spec.rows.slice(spec.hero ? 1 : 0)) bits.push(row.label + " " + row.value);
    if (spec.dateText) bits.push(spec.dateText);
    return "תצוגה מקדימה של תמונת השיתוף: " + bits.filter(Boolean).join(", ");
  }

  // ---- Entry points ------------------------------------------------------
  function outwardShareCurrentPr() {
    const p = state.posts.prPrompt;
    if (!p) return;
    openOutwardShare(outwardSubjectFromPrRecord(p.record), { caption: p.note });
  }
  function outwardShareCurrentAchievement() {
    const a = state.achievements.unlock;
    if (!a) return;
    openOutwardShare(outwardSubjectFromAchievement({ title: a.title, explanation: a.explanation }, a.code, ""), { caption: a.note });
  }
  function outwardShareEarnedAchievement(memberAchievementId, code) {
    const row = (state.achievements.mine || []).find((r) => r.id === memberAchievementId);
    const achCode = code || achCodeOf(row);
    const meta = achMeta(achCode, row);
    openOutwardShare(outwardSubjectFromAchievement(meta, achCode, row ? outwardDateText(row.unlocked_at) : ""));
  }
  function outwardSharePost(postId) {
    const post = findFeedPost(postId);
    const subject = outwardSubjectFromPost(post);
    if (!subject) { state.posts.openMenu = null; setMessage("לא ניתן לשתף את הפוסט הזה מחוץ לאפליקציה"); return rerender(); }
    openOutwardShare(subject, { caption: post.body });
  }

  // Exposed so app.js's own Progress/Calendar share controls can reuse the
  // same card and the same guarantees rather than growing a second one.
  window.communityOutwardShare = {
    CARD: OUTWARD_CARD,
    FIELDS: OUTWARD_CARD_FIELDS,
    NEVER: OUTWARD_CARD_NEVER,
    RESULTS: OUTWARD_SHARE_RESULTS,
    buildSpec: buildOutwardShareSpec,
    paint: paintOutwardShareCard,
    text: outwardShareText,
    open: openOutwardShare,
    subjectFromPost: outwardSubjectFromPost,
    subjectFromPrRecord: outwardSubjectFromPrRecord,
  };
