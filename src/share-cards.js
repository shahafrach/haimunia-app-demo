// @ts-check
"use strict";
// ---- Share cards: PR card and week card -----------------------------------
//
// Pure: data in, canvas out. No network, no Supabase, no storage, no reads of
// any member's data other than what the caller hands in. The Sharing pipeline
// session decides what to pass (and passes only what the member's privacy
// setting allows); this module additionally refuses to draw what it was not
// asked to, so a stray field on `data` can never reach the image:
//
//   * every field is read by name from an allow-list (see build*Layout);
//   * an absolute weight is read only when data.showWeight === true;
//   * the week card has no weight field at all, and no ranking: members keep
//     the order the caller gave them and no position number is ever drawn.
//
// The older gym-era painter in src/community/outward.js draws one fixed card
// from hardcoded colours. It is left alone (this session may not edit it, and
// the strip session removes it); this module shares its conventions - 1080x1350,
// canvas direction "rtl", FSI/LRI isolates instead of <bdi> - but reads its
// colours from the app's CSS tokens at render time.
//
// Classic <script>, wrapped in an IIFE so none of its names join the shared
// global scope. Exposes window.boxlogShareCards.

(function () {
  // ---- Constants: the one place to change look and feel -------------------
  const CARD = Object.freeze({ WIDTH: 1080, HEIGHT: 1350, PAD: 84, MIME: "image/png" });

  // Heebo for everything (tokens.css --font-body). Its digits are all one
  // width, so numbers need no second family.
  const FONT_SANS = "Heebo, system-ui, sans-serif";
  const FONT_MONO = FONT_SANS;

  // Design tokens read at render time, so a card is drawn in the member's own
  // palette and theme. Keys are the names the painters use; values are the
  // token (tokens.css). With no document (tests, workers) or a token that does
  // not resolve, the fallback is a CSS system color keyword: never a literal.
  const TOKENS = Object.freeze({
    bg: ["--color-bg", "Canvas"],
    surface: ["--color-surface", "Canvas"],
    border: ["--color-border-strong", "GrayText"],
    text: ["--color-text", "CanvasText"],
    muted: ["--color-text-muted", "GrayText"],
    accent: ["--color-accent", "CanvasText"],
    accentFill: ["--color-accent-fill", "Highlight"],
    onAccent: ["--color-on-accent", "HighlightText"],
    pr: ["--color-pr", "CanvasText"],
    progress: ["--color-progress", "Highlight"],
    success: ["--color-success", "Highlight"],
  });
  const MARK_TEXT = "BOX-LOG";
  const FILE_NAME = "box-log.png";

  const NAME_MAX = 18;
  const CIRCLE_NAME_MAX = 28;
  const ROWS_PER_COLUMN = 10;
  const PERCENT_MAX = 999;

  // ---- Pure text helpers --------------------------------------------------
  const FSI = "⁨", LRI = "⁦", RLI = "⁧", PDI = "⁩";
  const HEBREW_RE = /[֐-׿יִ-ﭏ]/;

  /** @param {unknown} v @param {number} max */
  function clean(v, max) {
    return String(v == null ? "" : v)
      .replace(/[\u0000-\u001F\u007F⁦-⁩‎‏‪-‮]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  }
  /** Truncate by code point so an emoji or surrogate pair is never split. @param {unknown} v @param {number} max */
  function truncate(v, max) {
    const chars = Array.from(clean(v, 400));
    return chars.length <= max ? chars.join("") : chars.slice(0, Math.max(1, max - 1)).join("").trimEnd() + "…";
  }
  /** An atomic value (name, result) takes its direction from its own first strong character. @param {string} s */
  function isolate(s) { return s ? FSI + s + PDI : ""; }
  /** A number with its unit: always left to right, so "72.5 kg" never reorders inside Hebrew. @param {string} s */
  function ltr(s) { return s ? LRI + s + PDI : ""; }
  /** Prose containing Hebrew gets an explicit RTL base. @param {string} s */
  function prose(s) { return s ? (HEBREW_RE.test(s) ? RLI : FSI) + s + PDI : ""; }

  /** 72.5 -> "72.5", 80 -> "80", 1234.56 -> "1,234.6". null for non-finite. @param {unknown} n @param {number} [decimals] */
  function formatNumber(n, decimals) {
    const x = typeof n === "number" ? n : Number(n);
    if (n === null || n === "" || !Number.isFinite(x)) return null;
    const d = decimals == null ? 1 : decimals;
    const fixed = Math.abs(x).toFixed(d).replace(/\.?0+$/, "");
    const [int, frac] = fixed.split(".");
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (x < 0 && Number(fixed) !== 0 ? "-" : "") + grouped + (frac ? "." + frac : "");
  }
  /** Signed improvement: "+7.5%". Zero and negative are not an improvement -> null. @param {unknown} p */
  function formatImprovement(p) {
    const x = typeof p === "number" ? p : Number(p);
    if (p === null || p === "" || !Number.isFinite(x) || x <= 0) return null;
    return "+" + formatNumber(Math.min(x, PERCENT_MAX), 1) + "%";
  }
  /** Percent of own target, whole number: "85%". null when unknown. @param {unknown} p */
  function formatPercent(p) {
    const x = typeof p === "number" ? p : Number(p);
    if (p === null || p === "" || p === undefined || !Number.isFinite(x) || x < 0) return null;
    return Math.min(Math.round(x), PERCENT_MAX) + "%";
  }
  /** "2026-10-26" -> "26.10.2026". Anything else -> "". @param {unknown} v */
  function formatDate(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v == null ? "" : v));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : "";
  }
  /** Hebrew plural for "N weeks met". @param {number} n */
  function weeksMetText(n) {
    if (n === 1) return "שבוע אחד ביעד";
    return n + " שבועות ביעד";
  }

  // ---- Layout: PR card ----------------------------------------------------
  /**
   * @typedef {Object} PrData
   * @property {string} memberName
   * @property {string} [memberEmoji]
   * @property {string} [lift]               lift name, for a lift PR
   * @property {number} [percent]            improvement over the previous best, in percent
   * @property {number} [weight]             new best; drawn ONLY when showWeight === true
   * @property {number} [previousWeight]     only used to derive percent when it is missing
   * @property {string} [unit]               default "kg"
   * @property {boolean} [showWeight]
   * @property {string} [date]               YYYY-MM-DD
   * @property {{name: string, result: string, rx?: boolean}} [benchmark]
   */
  /** @param {PrData} data */
  function buildPrLayout(data) {
    const d = data || /** @type {PrData} */ ({});
    const member = { name: truncate(d.memberName, NAME_MAX), emoji: truncate(d.memberEmoji, 2) };
    const dateText = formatDate(d.date);
    const base = { member, dateText };

    if (d.benchmark && typeof d.benchmark === "object") {
      const b = d.benchmark;
      return Object.assign(base, {
        kind: "benchmark",
        chip: "בנצ'מרק",
        title: truncate(b.name, 28),
        hero: truncate(b.result, 14),
        heroLabel: "תוצאה",
        badge: b.rx === false ? "מותאם" : "Rx",
        weightText: null,
      });
    }

    let percent = typeof d.percent === "number" ? d.percent : null;
    if (percent === null && Number(d.previousWeight) > 0 && Number(d.weight) > 0) {
      // Deriving a percent from two weights is not showing a weight.
      percent = (Number(d.weight) / Number(d.previousWeight) - 1) * 100;
    }
    const improvement = formatImprovement(percent);
    let weightText = null;
    if (d.showWeight === true) {
      const w = formatNumber(d.weight, 1);
      if (w) weightText = w + " " + (clean(d.unit, 6) || "kg");
    }
    return Object.assign(base, {
      kind: "lift",
      chip: "שיא אישי",
      title: truncate(d.lift, 28),
      hero: improvement || "שיא חדש",
      heroLabel: improvement ? "שיפור לעומת השיא הקודם" : "",
      badge: "",
      weightText,
    });
  }

  // ---- Layout: week card --------------------------------------------------
  /**
   * @typedef {Object} WeekMember
   * @property {string} name
   * @property {string} [emoji]
   * @property {number} [percent]       percent of the member's OWN weekly target
   * @property {boolean} [paused]
   * @property {number} [weeksMet]
   *
   * @typedef {Object} WeekData
   * @property {string} circleName
   * @property {string} [circleEmoji]
   * @property {"couple"|"friends"} [type]
   * @property {{label?: string, members: WeekMember[]}[]} weeks   one for friends, up to two for a couple
   */
  /** @param {WeekData} data */
  function buildWeekLayout(data) {
    const d = data || /** @type {WeekData} */ ({});
    const couple = d.type === "couple";
    const src = Array.isArray(d.weeks) ? d.weeks.slice(0, couple ? 2 : 1) : [];
    /** @type {{title: string, rows: any[]}[]} */
    let columns = src.map((w) => ({
      title: truncate(w && w.label, 24),
      rows: (Array.isArray(w && w.members) ? w.members : []).slice(0, 20).map(buildMemberRow),
    }));
    // A big friends circle would make rows unreadably thin: split into two
    // columns, in the caller's order (never sorted - that would be a ranking).
    if (!couple && columns.length === 1 && columns[0].rows.length > ROWS_PER_COLUMN) {
      const all = columns[0].rows;
      columns = [
        { title: columns[0].title, rows: all.slice(0, ROWS_PER_COLUMN) },
        { title: "", rows: all.slice(ROWS_PER_COLUMN) },
      ];
    }
    return {
      kind: "week",
      chip: "השבוע",
      circle: { name: truncate(d.circleName, CIRCLE_NAME_MAX), emoji: truncate(d.circleEmoji, 2) },
      columns,
    };
  }
  /** @param {WeekMember} m */
  function buildMemberRow(m) {
    const x = m || /** @type {WeekMember} */ ({});
    const paused = x.paused === true;
    const percentText = paused ? null : formatPercent(x.percent);
    const pct = paused || percentText === null ? 0 : Math.min(Number(x.percent), 100) / 100;
    const met = Number.isFinite(Number(x.weeksMet)) ? Math.max(0, Math.floor(Number(x.weeksMet))) : 0;
    return {
      name: truncate(x.name, NAME_MAX),
      emoji: truncate(x.emoji, 2),
      paused,
      percentText,
      fraction: pct,
      done: !paused && percentText !== null && Number(x.percent) >= 100,
      metText: met > 0 ? weeksMetText(met) : "",
    };
  }

  // ---- Canvas plumbing ----------------------------------------------------
  /**
   * Colours from the document's tokens, read now. A custom property reads back
   * unresolved (light-dark(...), color-mix(...)), so each is resolved the way
   * the page resolves it: through a probe element's computed color.
   */
  function readColors() {
    /** @type {Record<string, string>} */
    const out = {};
    let probe = null;
    try {
      if (typeof document !== "undefined" && document.body && typeof getComputedStyle === "function") {
        probe = document.createElement("span");
        probe.style.cssText = "position:absolute;visibility:hidden;width:0;height:0";
        document.body.appendChild(probe);
      }
    } catch (e) { probe = null; }
    for (const key of Object.keys(TOKENS)) {
      const [name, fallback] = TOKENS[/** @type {keyof typeof TOKENS} */ (key)];
      let v = "";
      if (probe) {
        try { probe.style.color = ""; probe.style.color = `var(${name})`; v = getComputedStyle(probe).color; } catch (e) { v = ""; }
      }
      out[key] = v || fallback;
    }
    if (probe) probe.remove();
    return out;
  }
  function newCanvas() {
    const canvas = document.createElement("canvas");
    canvas.width = CARD.WIDTH;
    canvas.height = CARD.HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no_canvas");
    ctx.direction = "rtl";
    ctx.textBaseline = "alphabetic";
    return { canvas, ctx };
  }
  /** Shrink-then-truncate a string to a pixel width. @param {CanvasRenderingContext2D} ctx @param {string} text @param {number} maxW */
  function fitText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    const chars = Array.from(text);
    while (chars.length > 1 && ctx.measureText(chars.join("") + "…").width > maxW) chars.pop();
    return chars.join("").trimEnd() + "…";
  }
  /** Largest font size (<= start) at which `text` fits `maxW`. @param {CanvasRenderingContext2D} ctx @param {string} text @param {number} start @param {number} maxW @param {(px:number)=>string} font */
  function fitSize(ctx, text, start, maxW, font) {
    let px = start;
    ctx.font = font(px);
    while (px > 40 && ctx.measureText(text).width > maxW) { px -= 6; ctx.font = font(px); }
    return px;
  }
  /** @param {CanvasRenderingContext2D} ctx */
  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
  /** Small BOX-LOG mark: a rounded box outline and the wordmark, right-aligned at x. @param {CanvasRenderingContext2D} ctx @param {Record<string,string>} c */
  function drawMark(ctx, c, x, baseline, size) {
    ctx.textAlign = "right";
    ctx.fillStyle = c.accent;
    ctx.font = `800 ${size}px ${FONT_SANS}`;
    ctx.fillText(MARK_TEXT, x, baseline);
    const w = ctx.measureText(MARK_TEXT).width;
    const s = size * 0.82;
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = Math.max(3, size / 10);
    roundRect(ctx, x - w - 16 - s, baseline - s + 2, s, s, s * 0.22);
    ctx.stroke();
  }
  /** Ground, accent rule, mark, kind chip. @param {CanvasRenderingContext2D} ctx @param {Record<string,string>} c @param {string} chip */
  function drawFrame(ctx, c, chip) {
    const { WIDTH: W, HEIGHT: H, PAD } = CARD;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = c.accentFill;
    ctx.fillRect(0, 0, W, 14);
    drawMark(ctx, c, W - PAD, 112, 38);
    ctx.font = `800 30px ${FONT_SANS}`;
    const chipText = isolate(chip);
    const chipW = ctx.measureText(chipText).width + 52;
    ctx.fillStyle = c.accentFill;
    roundRect(ctx, PAD, 74, chipW, 52, 26);
    ctx.fill();
    ctx.fillStyle = c.onAccent;
    ctx.textAlign = "center";
    ctx.fillText(chipText, PAD + chipW / 2, 111);
  }
  /** @param {CanvasRenderingContext2D} ctx @param {Record<string,string>} c */
  function drawFooter(ctx, c, left) {
    const { WIDTH: W, HEIGHT: H, PAD } = CARD;
    ctx.fillStyle = c.accentFill;
    ctx.fillRect(PAD, H - 140, W - PAD * 2, 3);
    if (left) {
      ctx.textAlign = "left";
      ctx.fillStyle = c.muted;
      ctx.font = `500 28px ${FONT_MONO}`;
      ctx.fillText(ltr(left), PAD, H - 80);
    }
  }

  // ---- renderPrCard -------------------------------------------------------
  /** @param {PrData} data @returns {HTMLCanvasElement} */
  function renderPrCard(data) {
    const L = buildPrLayout(data);
    const c = readColors();
    const { canvas, ctx } = newCanvas();
    const { WIDTH: W, PAD } = CARD;
    const cx = W / 2, maxW = W - PAD * 2;
    drawFrame(ctx, c, L.kind === "lift" || L.kind === "benchmark" ? "★ " + L.chip : L.chip);

    ctx.textAlign = "center";
    ctx.font = `400 150px ${FONT_SANS}`;
    ctx.fillStyle = c.text;
    if (L.member.emoji) ctx.fillText(L.member.emoji, cx, 400);

    ctx.fillStyle = c.text;
    ctx.font = `800 60px ${FONT_SANS}`;
    ctx.fillText(fitText(ctx, isolate(L.member.name), maxW), cx, 500);

    ctx.fillStyle = c.muted;
    ctx.font = `600 38px ${FONT_SANS}`;
    ctx.fillText(L.kind === "benchmark" ? "סיימ/ה בנצ'מרק" : "שבר/ה שיא אישי", cx, 566);

    ctx.fillStyle = c.text;
    ctx.font = `800 78px ${FONT_SANS}`;
    ctx.fillText(fitText(ctx, prose(L.title), maxW), cx, 690);

    // Hero: the improvement (lift) or the result (benchmark), mono, energy.
    const heroText = L.kind === "lift" && L.hero.startsWith("+") ? ltr(L.hero) : isolate(L.hero);
    const heroFont = (/** @type {number} */ px) => `800 ${px}px ${FONT_MONO}`;
    const px = fitSize(ctx, heroText, 230, maxW, heroFont);
    ctx.font = heroFont(px);
    ctx.fillStyle = c.pr;
    ctx.fillText(heroText, cx, 900);

    if (L.heroLabel) {
      ctx.fillStyle = c.muted;
      ctx.font = `600 38px ${FONT_SANS}`;
      ctx.fillText(L.heroLabel, cx, 970);
    }
    if (L.badge) {
      ctx.font = `800 40px ${FONT_SANS}`;
      const t = isolate(L.badge);
      const bw = ctx.measureText(t).width + 72;
      ctx.fillStyle = c.surface;
      roundRect(ctx, cx - bw / 2, 1000, bw, 70, 35);
      ctx.fill();
      ctx.strokeStyle = c.border;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = c.accent;
      ctx.fillText(t, cx, 1049);
    }
    if (L.weightText) {
      ctx.font = `700 52px ${FONT_MONO}`;
      const t = ltr(L.weightText);
      const bw = Math.min(maxW, ctx.measureText(t).width + 96);
      ctx.fillStyle = c.surface;
      roundRect(ctx, cx - bw / 2, 1030, bw, 100, 26);
      ctx.fill();
      ctx.strokeStyle = c.border;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = c.accent;
      ctx.fillText(t, cx, 1098);
    }
    drawFooter(ctx, c, L.dateText);
    return canvas;
  }

  // ---- renderWeekCard -----------------------------------------------------
  /** @param {WeekData} data @returns {HTMLCanvasElement} */
  function renderWeekCard(data) {
    const L = buildWeekLayout(data);
    const c = readColors();
    const { canvas, ctx } = newCanvas();
    const { WIDTH: W, HEIGHT: H, PAD } = CARD;
    drawFrame(ctx, c, L.chip);

    ctx.textAlign = "center";
    ctx.font = `400 110px ${FONT_SANS}`;
    ctx.fillStyle = c.text;
    if (L.circle.emoji) ctx.fillText(L.circle.emoji, W / 2, 310);
    ctx.font = `800 68px ${FONT_SANS}`;
    ctx.fillText(fitText(ctx, isolate(L.circle.name), W - PAD * 2), W / 2, 400);

    const top = 450, bottom = H - 170;
    const gap = 40;
    const n = Math.max(1, L.columns.length);
    const colW = (W - PAD * 2 - gap * (n - 1)) / n;
    const compact = n > 1;
    L.columns.forEach((col, i) => {
      // RTL: the first column is on the right.
      const right = W - PAD - i * (colW + gap);
      const left = right - colW;
      let y = top;
      if (col.title) {
        ctx.textAlign = "right";
        ctx.fillStyle = c.muted;
        ctx.font = `600 32px ${FONT_SANS}`;
        ctx.fillText(fitText(ctx, isolate(col.title), colW), right, y + 24);
        y += 54;
      }
      const rows = Math.max(1, col.rows.length);
      const rowH = Math.min(150, (bottom - y) / rows);
      // Few rows: centre the block in the free space instead of hugging the top.
      y += Math.max(0, ((bottom - y) - rowH * rows) / 2) * 0.6;
      const nameSize = Math.round(Math.min(compact ? 34 : 42, rowH * 0.36));
      col.rows.forEach((r, k) => {
        const ry = y + k * rowH;
        const base = ry + rowH * 0.44;
        ctx.textAlign = "right";
        ctx.fillStyle = r.paused ? c.muted : c.text;
        ctx.font = `700 ${nameSize}px ${FONT_SANS}`;
        const label = (r.emoji ? r.emoji + " " : "") + isolate(r.name);
        const pctW = compact ? 120 : 170;
        ctx.fillText(fitText(ctx, label, colW - pctW - 12), right, base);
        ctx.textAlign = "left";
        if (r.paused) {
          ctx.fillStyle = c.muted;
          ctx.font = `600 ${nameSize}px ${FONT_SANS}`;
          ctx.fillText("מושהה", left, base);
        } else if (r.percentText) {
          ctx.fillStyle = r.done ? c.success : c.progress;
          ctx.font = `800 ${Math.round(nameSize * 1.2)}px ${FONT_MONO}`;
          ctx.fillText(ltr(r.percentText), left, base);
        }
        // Bar: percent of the member's own target, capped at a full bar.
        const bh = Math.max(8, Math.round(rowH * 0.1));
        const by = ry + rowH * 0.56;
        ctx.fillStyle = c.surface;
        roundRect(ctx, left, by, colW, bh, bh / 2);
        ctx.fill();
        if (!r.paused && r.fraction > 0) {
          ctx.fillStyle = r.done ? c.success : c.progress;
          roundRect(ctx, right - colW * r.fraction, by, colW * r.fraction, bh, bh / 2);
          ctx.fill();
        }
        if (r.metText && rowH >= 70) {
          ctx.textAlign = "right";
          ctx.fillStyle = c.muted;
          ctx.font = `500 ${Math.max(20, Math.round(nameSize * 0.7))}px ${FONT_SANS}`;
          ctx.fillText(r.metText, right, by + bh + Math.max(22, nameSize * 0.8));
        }
      });
    });
    drawFooter(ctx, c, "");
    return canvas;
  }

  // ---- shareCard ----------------------------------------------------------
  /** @param {any} canvas @returns {Promise<Blob>} */
  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      if (canvas && typeof canvas.convertToBlob === "function") { canvas.convertToBlob({ type: CARD.MIME }).then(resolve, reject); return; }
      if (!canvas || typeof canvas.toBlob !== "function") { reject(new Error("no_canvas")); return; }
      canvas.toBlob((/** @type {Blob|null} */ b) => (b ? resolve(b) : reject(new Error("no_canvas"))), CARD.MIME);
    });
  }
  /** Build the File before the tap: iOS drops the user activation across an await. @param {any} canvas */
  async function canvasToFile(canvas) {
    return new File([await canvasToBlob(canvas)], FILE_NAME, { type: CARD.MIME });
  }
  /** @param {File} file */
  function downloadFile(file) {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  /**
   * Share the PNG as a file through the system share sheet (WhatsApp is the
   * target). The decision "shared as a file alone" means `text` is NOT sent
   * with the file unless opts.includeText is true, because WhatsApp and iOS
   * drop or mangle a text+file pair. Falls back to downloading the PNG.
   * Call it from a tap; for the fastest path pass a File made earlier with
   * canvasToFile().
   *
   * @param {any} canvasOrFile
   * @param {string} [text]
   * @param {{includeText?: boolean}} [opts]
   * @returns {Promise<"shared"|"cancelled"|"downloaded"|"failed">}
   */
  async function shareCard(canvasOrFile, text, opts) {
    let file;
    try {
      file = typeof File === "function" && canvasOrFile instanceof File ? canvasOrFile : await canvasToFile(canvasOrFile);
    } catch (e) { return "failed"; }
    try {
      if (typeof navigator !== "undefined" && typeof navigator.share === "function"
        && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
        /** @type {ShareData} */
        const payload = { files: [file] };
        if (opts && opts.includeText && text) payload.text = String(text);
        await navigator.share(payload);
        return "shared";
      }
    } catch (err) {
      if (err && /** @type {any} */ (err).name === "AbortError") return "cancelled";
      // Any other share failure falls through to the download.
    }
    try { downloadFile(file); return "downloaded"; } catch (e) { return "failed"; }
  }

  /** Warm the webfonts the cards use; a canvas paints only what is already loaded. */
  async function ensureFonts() {
    if (typeof document === "undefined" || !document.fonts || typeof document.fonts.load !== "function") return;
    const faces = ["800 60px Heebo", "600 38px Heebo", "400 32px Heebo", "500 28px Heebo"];
    try { await Promise.all(faces.map((f) => document.fonts.load(f, "אב0123"))); } catch (e) { /* fallback face */ }
  }

  const api = { renderPrCard, renderWeekCard, shareCard };
  if (typeof window !== "undefined") {
    /** @type {any} */ (window).boxlogShareCards = Object.assign({}, api, { canvasToFile, ensureFonts });
  }
  // Node (tests): the pure layout half, no canvas needed.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { buildPrLayout, buildWeekLayout, truncate, formatNumber, formatImprovement, formatPercent, formatDate, weeksMetText, readColors, CARD };
  }
})();
