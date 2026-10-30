// Measurements for the usability pass. Everything here is read from the running
// page: computed styles, bounding boxes and pixels. Nothing is estimated by eye.

/**
 * WCAG contrast of the text of one element.
 *  - foreground: the computed text colour (any CSS colour, resolved through a canvas).
 *  - background: the first opaque background up the ancestor chain; when an
 *    ancestor on the way paints an image or gradient, the text is hidden, the box is
 *    screenshotted, and the real pixels behind the text decide: the ratio is the
 *    WORST case over the darkest and the lightest pixel in the box.
 * Returns { selector, text, fg, ratio, worst, over, size, bold, aa } or { missing: true }.
 */
export async function contrastOf(page, selector) {
  const info = await page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (e.textContent || "").trim();
    });
    if (!el) return null;
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const rgba = (css) => {
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = "#000";
      probe.fillStyle = css;
      probe.fillRect(0, 0, 1, 1);
      const d = probe.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const cs = getComputedStyle(el);
    const fg = rgba(cs.color);
    let bg = null, image = false;
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.backgroundImage && s.backgroundImage !== "none") { image = true; break; }
      const c = rgba(s.backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 0.99) break;
    }
    if (!image) {
      // Composite translucent layers over the opaque one found last, or over the page colour.
      let base = layers.length && layers[layers.length - 1][3] >= 0.99 ? layers.pop() : rgba(getComputedStyle(document.body).backgroundColor);
      if (base[3] < 0.99) base = [255, 255, 255, 1];
      for (let i = layers.length - 1; i >= 0; i--) {
        const l = layers[i];
        base = [l[0] * l[3] + base[0] * (1 - l[3]), l[1] * l[3] + base[1] * (1 - l[3]), l[2] * l[3] + base[2] * (1 - l[3]), 1];
      }
      bg = base;
    }
    el.setAttribute("data-e2e-contrast", "1");
    const r = el.getBoundingClientRect();
    return {
      text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40),
      fg, bg, image,
      rect: { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(r.width, innerWidth - Math.max(0, r.left)), height: Math.min(r.height, innerHeight - Math.max(0, r.top)) },
      size: parseFloat(cs.fontSize), bold: parseInt(cs.fontWeight, 10) >= 700,
    };
  }, selector);
  if (!info) return { selector, missing: true };

  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const lf = lum(info.fg);
  let result;
  if (!info.image) {
    const r = ratio(lf, lum(info.bg));
    result = { ratio: r, worst: r, over: "solid" };
  } else {
    // Hide the text, photograph the box, read the pixels.
    await page.evaluate(() => {
      const el = document.querySelector('[data-e2e-contrast="1"]');
      el.dataset.e2ePrev = el.getAttribute("style") || "";
      el.style.setProperty("color", "transparent", "important");
      el.style.setProperty("-webkit-text-fill-color", "transparent", "important");
      el.style.setProperty("text-shadow", "none", "important");
    });
    let png = null;
    try { png = await page.screenshot({ clip: info.rect, animations: "disabled" }); } catch (e) { png = null; }
    await page.evaluate(() => {
      const el = document.querySelector('[data-e2e-contrast="1"]');
      if (!el) return;
      el.setAttribute("style", el.dataset.e2ePrev || "");
      if (!el.getAttribute("style")) el.removeAttribute("style");
      el.removeAttribute("data-e2e-prev");
    });
    if (!png) { result = { ratio: null, worst: null, over: "image (not measurable)" }; }
    else {
      const lums = await page.evaluate(async (b64) => {
        const blob = await (await fetch("data:image/png;base64," + b64)).blob();
        const bmp = await createImageBitmap(blob);
        const c = document.createElement("canvas");
        c.width = bmp.width; c.height = bmp.height;
        const x = c.getContext("2d", { willReadFrequently: true });
        x.drawImage(bmp, 0, 0);
        const d = x.getImageData(0, 0, c.width, c.height).data;
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        let min = 2, max = -1, sum = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const l = 0.2126 * f(d[i]) + 0.7152 * f(d[i + 1]) + 0.0722 * f(d[i + 2]);
          if (l < min) min = l; if (l > max) max = l; sum += l; n++;
        }
        return { min, max, mean: sum / Math.max(1, n) };
      }, png.toString("base64"));
      const rs = [ratio(lf, lums.min), ratio(lf, lums.max)];
      result = { ratio: ratio(lf, lums.mean), worst: Math.min(...rs), over: "image or gradient" };
    }
  }
  await page.evaluate(() => document.querySelectorAll("[data-e2e-contrast]").forEach((e) => e.removeAttribute("data-e2e-contrast")));
  const large = info.size >= 24 || (info.size >= 18.66 && info.bold);
  const need = large ? 3 : 4.5;
  const worst = result.worst;
  return {
    selector, text: info.text, over: result.over,
    ratio: result.ratio == null ? null : Math.round(result.ratio * 100) / 100,
    worst: worst == null ? null : Math.round(worst * 100) / 100,
    size: info.size, need, aa: worst == null ? null : worst >= need,
  };
}

/** What a phone screen shows right now, as measured facts. */
export async function layoutFacts(page, primarySelectors = []) {
  return page.evaluate((primary) => {
    const doc = document.documentElement;
    const vh = innerHeight;
    // The fixed tab bar covers the bottom of the screen; what is under it is not "in view".
    const nav = document.getElementById("bottomNavWrap") || document.getElementById("bottomTabBar");
    const navTop = nav && getComputedStyle(nav).display !== "none" ? nav.getBoundingClientRect().top : vh;
    const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const label = (e) => ((e.getAttribute("aria-label") || e.textContent || e.getAttribute("name") || e.tagName) + "").trim().replace(/\s+/g, " ").slice(0, 30);
    const controls = [...document.querySelectorAll("button, a[href], [role='button'], select, input:not([type=hidden]), textarea")].filter(visible);
    const inView = controls.filter((e) => { const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < navTop; });
    const small = inView.filter((e) => { const r = e.getBoundingClientRect(); return Math.min(r.width, r.height) < 44; }).map((e) => { const r = e.getBoundingClientRect(); return `${label(e)} ${Math.round(r.width)}x${Math.round(r.height)}`; });
    const below = primary.map((sel) => {
      const e = [...document.querySelectorAll(sel)].find(visible);
      if (!e) return { selector: sel, found: false };
      const r = e.getBoundingClientRect();
      const fixedUi = !!e.closest("#bottomNavWrap, #bottomTabBar, #bottomBar, [data-share-bar], .modal-overlay");
      return { selector: sel, found: true, top: Math.round(r.top), bottom: Math.round(r.bottom), aboveFold: fixedUi || (r.bottom <= navTop && r.top >= 0) };
    });
    return {
      dir: getComputedStyle(doc).direction,
      sideways: doc.scrollWidth > doc.clientWidth + 1,
      scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth,
      navTop: Math.round(navTop),
      controlsInView: inView.length,
      smallTargets: small.slice(0, 8), smallCount: small.length,
      primary: below,
      text: (document.body.innerText || "").replace(/\s+/g, " ").trim(),
    };
  }, primarySelectors);
}
