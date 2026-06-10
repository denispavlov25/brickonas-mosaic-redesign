/*
 * BRICKONAS — KI-Bildwerkzeuge (step 2)
 * ------------------------------------------------------------------
 * Client-side image helpers for the mosaic configurator's "Farben
 * verfeinern" step. Lets users improve the source photo without the
 * paintbrush: auto-optimize, background removal and background recolor.
 * Plus an intent-scoped mini-chat that ONLY understands image commands
 * and politely refuses anything off-topic (no general LLM, no network).
 *
 * EVERYTHING runs in the browser — the photo never leaves the device.
 * No external hosts, no API keys, GDPR-friendly. Easy to revert: this
 * file + the small _runStep2Body override + the panel markup are the
 * whole feature.
 *
 * Integration contract with js/index.js (all globals it relies on):
 *   - inputImageCropper        CropperJS instance (alive on step 2)
 *   - invalidateStepsFrom(n)   marks steps >= n as stale
 *   - runStepProcessing(t, cb) re-runs stale steps up to t, then cb()
 *   - currentVisualStep        which visual step is showing (1..3)
 *   - t(key)                   i18n lookup (js/i18n.js)
 *
 * It publishes window.bkAi.sourceCanvas; when non-null, _runStep2Body
 * feeds it into the mosaic instead of the live cropper output.
 */
(function () {
  "use strict";

  // Working resolution for the in-browser image ops. The mosaic itself is
  // very low-res (tens of studs), so a capped source keeps every op fast
  // while still giving clean edges for background removal.
  var WORK_MAX = 800;

  // Background colour palette offered after removal (name + hex). German
  // names are what the mini-chat matches against.
  var COLORS = [
    { name: "weiß", hex: "#ffffff" },
    { name: "schwarz", hex: "#1a1a1a" },
    { name: "grau", hex: "#9aa0a6" },
    { name: "blau", hex: "#2e5fe8" },
    { name: "hellblau", hex: "#5db4f0" },
    { name: "rot", hex: "#e23b3b" },
    { name: "grün", hex: "#3ba55c" },
    { name: "gelb", hex: "#f4c20d" },
    { name: "orange", hex: "#f08a24" },
    { name: "rosa", hex: "#f48fb1" },
    { name: "lila", hex: "#8e44ad" },
    { name: "türkis", hex: "#1abc9c" },
    { name: "braun", hex: "#8d5a3b" }
  ];
  // Aliases → canonical palette name.
  var COLOR_ALIASES = {
    "weiss": "weiß", "white": "weiß",
    "black": "schwarz", "anthrazit": "schwarz",
    "gray": "grau", "grey": "grau", "silber": "grau",
    "blue": "blau", "dunkelblau": "blau",
    "lightblue": "hellblau", "himmelblau": "hellblau",
    "red": "rot",
    "gruen": "grün", "green": "grün",
    "yellow": "gelb",
    "pink": "rosa", "magenta": "rosa",
    "violett": "lila", "purple": "lila", "violet": "lila",
    "tuerkis": "türkis", "teal": "türkis", "cyan": "türkis",
    "brown": "braun"
  };

  // Feature state. baseCanvas = pristine crop; the working source is
  // recomputed from it on every change so toggles are composable/reversible.
  var state = {
    baseCanvas: null,
    optimized: false,
    grayscale: false,
    brightness: 0, // accumulated delta from chat "heller"/"dunkler"
    recolors: [],  // selective hue swaps, e.g. [{fromHex,toHex,fromName,toName}]
    boosts: [],    // hue intensity tweaks, e.g. [{hex,name,amount}] ("mehr rot")
    bgRemoved: false,
    bgColor: "#ffffff",
    busy: false,        // an op (mosaic re-render) is in flight — block re-entry
    bgMask: null,       // cached ML foreground mask {data:Uint8Array, w, h} or null
    bgMaskTried: false  // we already attempted ML segmentation for this image
  };

  // window.bkAi is the bridge read by _runStep2Body in index.js.
  window.bkAi = window.bkAi || { sourceCanvas: null };

  var els = {}; // cached DOM nodes (populated in init)

  // ---- i18n helper (falls back to the key if js/i18n.js missing) --------
  function tr(key) {
    return (typeof t === "function" ? t(key) : key) || key;
  }

  // ---- tiny canvas utilities -------------------------------------------
  function cloneCanvas(src) {
    var c = document.createElement("canvas");
    c.width = src.width;
    c.height = src.height;
    c.getContext("2d").drawImage(src, 0, 0);
    return c;
  }

  function clamp255(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  // Capture the pristine working base. Returns false if no usable source yet.
  //
  // IMPORTANT: the live CropperJS instance collapses to a 0x0 crop box as soon
  // as step 1 is hidden (its container is display:none on step 2), so reading
  // inputImageCropper.getCroppedCanvas() here returns an empty canvas. Instead
  // we rely on window.bkAi.baseCrop — a ~WORK_MAX snapshot that _runStep2Body()
  // captures while the cropper is still laid out during the step 1->2 handoff.
  // The direct cropper read stays only as a best-effort fallback (e.g. if the
  // user somehow triggers an op while step 1 is still visible).
  function ensureBase() {
    if (state.baseCanvas) return true;
    var snap = (window.bkAi && window.bkAi.baseCrop) ? window.bkAi.baseCrop : null;
    if (snap && snap.width) {
      state.baseCanvas = cloneCanvas(snap);
      return true;
    }
    if (typeof inputImageCropper === "undefined" || !inputImageCropper ||
        typeof inputImageCropper.getCroppedCanvas !== "function") {
      return false;
    }
    var crop;
    try {
      crop = inputImageCropper.getCroppedCanvas({
        maxWidth: WORK_MAX,
        maxHeight: WORK_MAX,
        imageSmoothingEnabled: true
      });
    } catch (e) {
      crop = null;
    }
    if (!crop || !crop.width) return false;
    state.baseCanvas = cloneCanvas(crop);
    return true;
  }

  // ---- image operations (all pure canvas) ------------------------------

  // Auto-optimize: a compact "auto tone" pipeline tuned for the MOSAIC (a few
  // dozen studs snapped to a small brick palette, so only LARGE tonal/chroma
  // moves survive quantization). Four stages, one LUT-driven pass:
  //   1. White balance — "Shades of Gray" (Minkowski p-norm, p=6). The robust
  //      generalization of gray-world: gray-world (p=1) is dragged around by big
  //      flat colour regions, the 6-norm leans on the brighter pixels that better
  //      reveal the illuminant (Finlayson & Trezzi found p=6 optimal).
  //   2. Per-channel auto-levels (Photoshop "Auto Tone"): independent R/G/B
  //      stretch with a tight 0.1% clip — preserves more contrast on a tiny image.
  //   3. Midtone neutralization (Photoshop "Auto Color" trick): per-channel gamma
  //      that pulls each channel's midtone toward a common neutral gray, removing
  //      colour casts the WB step missed. Then a gentle S-curve for punch.
  //   4. Vibrance instead of flat saturation: boosts LOW-saturation pixels more
  //      and protects skin tones (orange/red band) so faces don't blow out — the
  //      old global 1.45 saturation over-cooked reds and skin.
  // The old 3x3 unsharp pass stays dropped (invisible after downscaling).
  function autoEnhance(canvas) {
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;
    var n = d.length;
    var i;

    // 1) White balance — Shades of Gray (p-norm, p=6).
    var p6R = 0, p6G = 0, p6B = 0, cnt = 0;
    for (i = 0; i < n; i += 4) {
      var rr = d[i], gg = d[i + 1], bb = d[i + 2];
      p6R += rr * rr * rr * rr * rr * rr;
      p6G += gg * gg * gg * gg * gg * gg;
      p6B += bb * bb * bb * bb * bb * bb;
      cnt++;
    }
    var illR = Math.pow(p6R / cnt, 1 / 6);
    var illG = Math.pow(p6G / cnt, 1 / 6);
    var illB = Math.pow(p6B / cnt, 1 / 6);
    var illGray = (illR + illG + illB) / 3;
    var sR = illR > 1 ? illGray / illR : 1, sG = illG > 1 ? illGray / illG : 1, sB = illB > 1 ? illGray / illB : 1;
    // Damp the correction so it never over-tints.
    sR = 1 + (sR - 1) * 0.7; sG = 1 + (sG - 1) * 0.7; sB = 1 + (sB - 1) * 0.7;

    // 2) Per-channel histograms after WB to find clip points.
    var hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (i = 0; i < n; i += 4) {
      var r0 = clamp255(d[i] * sR) | 0;
      var g0 = clamp255(d[i + 1] * sG) | 0;
      var b0 = clamp255(d[i + 2] * sB) | 0;
      d[i] = r0; d[i + 1] = g0; d[i + 2] = b0; // keep WB result in place
      hist[0][r0]++; hist[1][g0]++; hist[2][b0]++;
    }
    var clipCount = cnt * 0.001; // tight 0.1% clip (Photoshop Auto Tone default)
    function findLow(hch) { var acc = 0; for (var v = 0; v < 256; v++) { acc += hch[v]; if (acc > clipCount) return v; } return 0; }
    function findHigh(hch) { var acc = 0; for (var v = 255; v >= 0; v--) { acc += hch[v]; if (acc > clipCount) return v; } return 255; }
    var lo = [findLow(hist[0]), findLow(hist[1]), findLow(hist[2])];
    var hi = [findHigh(hist[0]), findHigh(hist[1]), findHigh(hist[2])];
    var span = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    for (var s = 0; s < 3; s++) if (span[s] < 8) span[s] = 8; // avoid blowups on flat channels

    // Stretched midtone (0..1) per channel, from the histogram, for gamma snap.
    function stretchedMean(hch, loc, sp) {
      var acc = 0, c = 0;
      for (var v = 0; v < 256; v++) {
        var cv = hch[v]; if (!cv) continue;
        var st = ((v - loc) * 255) / sp; if (st < 0) st = 0; else if (st > 255) st = 255;
        acc += st * cv; c += cv;
      }
      return c ? (acc / c) / 255 : 0.5;
    }
    var mean = [
      stretchedMean(hist[0], lo[0], span[0]),
      stretchedMean(hist[1], lo[1], span[1]),
      stretchedMean(hist[2], lo[2], span[2])
    ];
    var target = (mean[0] + mean[1] + mean[2]) / 3; // common neutral gray point

    // 3) Per-channel LUTs: levels stretch → gamma midtone snap → S-curve contrast.
    var contrast = 1.18;
    var lut = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)];
    for (var ch = 0; ch < 3; ch++) {
      var gch = (mean[ch] > 0.01 && mean[ch] < 0.99 && target > 0.01)
        ? Math.log(target) / Math.log(mean[ch]) : 1;
      if (gch < 0.7) gch = 0.7; else if (gch > 1.4) gch = 1.4; // keep the snap gentle
      for (var x = 0; x < 256; x++) {
        var st01 = ((x - lo[ch]) * 255) / span[ch] / 255;          // auto-levels
        if (st01 < 0) st01 = 0; else if (st01 > 1) st01 = 1;
        var gm = Math.pow(st01, gch);                               // midtone neutralize
        var curved = (gm - 0.5) * contrast + 0.5;                  // S-curve contrast
        lut[ch][x] = clamp255(curved * 255);
      }
    }

    // 4) Apply LUTs + vibrance (skin-protected) in one pass.
    for (i = 0; i < n; i += 4) {
      var r = lut[0][d[i]], g = lut[1][d[i + 1]], b = lut[2][d[i + 2]];
      var max = r > g ? (r > b ? r : b) : (g > b ? g : b);
      var min = r < g ? (r < b ? r : b) : (g < b ? g : b);
      var sat = max > 0 ? (max - min) / max : 0;
      var amt = 0.55 * (1 - sat); // vibrance: less-saturated pixels boosted more
      // Skin protection: reddish-orange pixels (r>g>b, moderate spread) get damped
      // so faces/skin don't turn radioactive orange.
      if (r > g && g >= b && (r - b) > 10 && (r - b) < 120) amt *= 0.45;
      var f = 1 + amt;
      var lum = 0.299 * r + 0.587 * g + 0.114 * b;
      d[i] = clamp255(lum + (r - lum) * f);
      d[i + 1] = clamp255(lum + (g - lum) * f);
      d[i + 2] = clamp255(lum + (b - lum) * f);
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function desaturate(canvas) {
    var ctx = canvas.getContext("2d");
    var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      var lum = clamp255(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      d[i] = d[i + 1] = d[i + 2] = lum;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function applyBrightness(canvas, delta) {
    if (!delta) return canvas;
    var ctx = canvas.getContext("2d");
    var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      d[i] = clamp255(d[i] + delta);
      d[i + 1] = clamp255(d[i + 1] + delta);
      d[i + 2] = clamp255(d[i + 2] + delta);
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function hexToRgb(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 255, g: 255, b: 255 };
  }

  // Background removal: corner-seeded flood fill from the image border.
  // Pixels reachable from an edge whose colour is within tolerance of a
  // corner seed are considered background and replaced by fillHex. Interior
  // regions that happen to match the bg colour are kept (not edge-connected).
  function removeBackground(canvas, fillHex) {
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;

    // Seed colours: average a small patch at each corner.
    function patchAvg(cx, cy) {
      var r = 0, g = 0, b = 0, c = 0, rad = 4;
      for (var y = cy - rad; y <= cy + rad; y++) {
        if (y < 0 || y >= h) continue;
        for (var x = cx - rad; x <= cx + rad; x++) {
          if (x < 0 || x >= w) continue;
          var p = (y * w + x) * 4;
          r += d[p]; g += d[p + 1]; b += d[p + 2]; c++;
        }
      }
      return c ? { r: r / c, g: g / c, b: b / c } : { r: d[0], g: d[1], b: d[2] };
    }
    var seeds = [
      patchAvg(4, 4), patchAvg(w - 5, 4),
      patchAvg(4, h - 5), patchAvg(w - 5, h - 5),
      patchAvg((w / 2) | 0, 3), patchAvg((w / 2) | 0, h - 4)
    ];

    // Adaptive tolerance: looser when corners disagree (busy background).
    var spread = 0;
    for (var a = 0; a < seeds.length; a++) {
      for (var b2 = a + 1; b2 < seeds.length; b2++) {
        var dd = Math.abs(seeds[a].r - seeds[b2].r) + Math.abs(seeds[a].g - seeds[b2].g) + Math.abs(seeds[a].b - seeds[b2].b);
        if (dd > spread) spread = dd;
      }
    }
    var tol = 42 + Math.min(spread * 0.35, 45); // ~42..87
    var tolSq = tol * tol;

    function matches(p) {
      var r = d[p], g = d[p + 1], b = d[p + 2];
      for (var k = 0; k < seeds.length; k++) {
        var dr = r - seeds[k].r, dg = g - seeds[k].g, db = b - seeds[k].b;
        if (dr * dr + dg * dg + db * db <= tolSq) return true;
      }
      return false;
    }

    var visited = new Uint8Array(w * h);
    var stack = [];
    // Seed the flood from every border pixel that matches.
    var xb, yb, pi;
    for (xb = 0; xb < w; xb++) {
      pi = xb; if (matches(pi * 4)) { stack.push(pi); visited[pi] = 1; }
      pi = (h - 1) * w + xb; if (matches(pi * 4)) { stack.push(pi); visited[pi] = 1; }
    }
    for (yb = 0; yb < h; yb++) {
      pi = yb * w; if (matches(pi * 4)) { stack.push(pi); visited[pi] = 1; }
      pi = yb * w + (w - 1); if (matches(pi * 4)) { stack.push(pi); visited[pi] = 1; }
    }
    // Flood fill (4-connected).
    while (stack.length) {
      var idx = stack.pop();
      var px = idx % w, py = (idx - px) / w;
      var neigh = [
        px > 0 ? idx - 1 : -1,
        px < w - 1 ? idx + 1 : -1,
        py > 0 ? idx - w : -1,
        py < h - 1 ? idx + w : -1
      ];
      for (var ni = 0; ni < 4; ni++) {
        var nb = neigh[ni];
        if (nb < 0 || visited[nb]) continue;
        if (matches(nb * 4)) { visited[nb] = 1; stack.push(nb); }
      }
    }

    // Paint background pixels with the fill colour.
    var fill = hexToRgb(fillHex || "#ffffff");
    for (var q = 0; q < visited.length; q++) {
      if (visited[q]) {
        var pp = q * 4;
        d[pp] = fill.r; d[pp + 1] = fill.g; d[pp + 2] = fill.b; d[pp + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  // ML background removal: paint every pixel the segmentation model marked as
  // background (mask 0) with fillHex, keeping the foreground (mask 1) untouched.
  // The mask is sampled by ratio so it works even if its resolution differs from
  // the working canvas. Used when window.bkSeg produced a usable person mask;
  // otherwise recompute() falls back to the flood-fill removeBackground above.
  function removeBackgroundMask(canvas, fillHex, maskObj) {
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;
    var fill = hexToRgb(fillHex || "#ffffff");
    var mw = maskObj.w, mh = maskObj.h, m = maskObj.data;
    for (var y = 0; y < h; y++) {
      var my = mh === h ? y : (y * mh / h) | 0;
      var rowM = my * mw;
      var rowD = y * w * 4;
      for (var x = 0; x < w; x++) {
        var mx = mw === w ? x : (x * mw / w) | 0;
        if (m[rowM + mx] === 0) { // background → paint over
          var p = rowD + x * 4;
          d[p] = fill.r; d[p + 1] = fill.g; d[p + 2] = fill.b; d[p + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  // ---- selective colour replacement (HSV) ------------------------------
  // "aus Orange mach Blau": find pixels in the source whose hue belongs to the
  // FROM colour family and rotate them onto the TO colour, keeping each pixel's
  // own brightness so shading/relief survives. Works great for the mosaic since
  // the result is a broad, palette-friendly hue shift, not a pixel-perfect mask.

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), dd = max - min;
    var hh = 0;
    if (dd !== 0) {
      if (max === r) hh = ((g - b) / dd) % 6;
      else if (max === g) hh = (b - r) / dd + 2;
      else hh = (r - g) / dd + 4;
      hh *= 60; if (hh < 0) hh += 360;
    }
    return [hh, max === 0 ? 0 : dd / max, max];
  }

  function hsvToRgb(hh, ss, vv) {
    var c = vv * ss, x = c * (1 - Math.abs(((hh / 60) % 2) - 1)), m = vv - c;
    var r = 0, g = 0, b = 0;
    if (hh < 60) { r = c; g = x; }
    else if (hh < 120) { r = x; g = c; }
    else if (hh < 180) { g = c; b = x; }
    else if (hh < 240) { g = x; b = c; }
    else if (hh < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return [clamp255((r + m) * 255), clamp255((g + m) * 255), clamp255((b + m) * 255)];
  }

  // Does an HSV pixel belong to the FROM colour family?
  function hsvMatchesFrom(hsv, fhsv, fromChroma) {
    if (fromChroma) {
      if (hsv[1] < 0.16) return false; // too gray to be a chromatic colour
      var dh = Math.abs(hsv[0] - fhsv[0]); if (dh > 180) dh = 360 - dh;
      return dh <= 26; // hue window in degrees
    }
    // achromatic FROM (weiß/schwarz/grau): match by low saturation + value band
    return hsv[1] < 0.18 && Math.abs(hsv[2] - fhsv[2]) < 0.28;
  }

  // Fraction of pixels matching a colour family — used to warn when the user
  // asks to swap a colour that isn't really in the picture.
  function hueMatchFraction(canvas, fromHex) {
    var ctx = canvas.getContext("2d");
    var d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    var fr = hexToRgb(fromHex), fhsv = rgbToHsv(fr.r, fr.g, fr.b);
    var fromChroma = fhsv[1] > 0.18;
    var hit = 0, tot = 0;
    for (var i = 0; i < d.length; i += 4) {
      tot++;
      if (hsvMatchesFrom(rgbToHsv(d[i], d[i + 1], d[i + 2]), fhsv, fromChroma)) hit++;
    }
    return tot ? hit / tot : 0;
  }

  function recolorSelective(canvas, fromHex, toHex) {
    var ctx = canvas.getContext("2d");
    var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var d = img.data;
    var fr = hexToRgb(fromHex), to = hexToRgb(toHex);
    var fhsv = rgbToHsv(fr.r, fr.g, fr.b), thsv = rgbToHsv(to.r, to.g, to.b);
    var fromChroma = fhsv[1] > 0.18, toChroma = thsv[1] > 0.18;
    for (var i = 0; i < d.length; i += 4) {
      var hsv = rgbToHsv(d[i], d[i + 1], d[i + 2]);
      if (!hsvMatchesFrom(hsv, fhsv, fromChroma)) continue;
      var nh, ns, nv;
      if (toChroma) {
        nh = thsv[0];
        ns = Math.min(1, Math.max(hsv[1], 0.35) * 0.5 + thsv[1] * 0.6);
        nv = hsv[2]; // keep original brightness → preserves shading
      } else {
        nh = 0; ns = 0;
        nv = clamp255((hsv[2] * 0.35 + thsv[2] * 0.65) * 255) / 255;
      }
      var rgb = hsvToRgb(nh, ns, nv);
      d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2];
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  // "Mehr/weniger <Farbe>": intensify (amount>0) or mute (amount<0) a colour
  // family. Pixels near the target hue get a saturation push and a gentle pull
  // toward the exact hue, weighted by how close they already are — so "mehr rot"
  // visibly strengthens the reds without repainting unrelated colours.
  function boostColor(canvas, hex, amount) {
    var fr = hexToRgb(hex), fhsv = rgbToHsv(fr.r, fr.g, fr.b);
    if (fhsv[1] <= 0.18) return canvas; // achromatic target → nothing meaningful
    var ctx = canvas.getContext("2d");
    var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var d = img.data;
    var HUE_WIN = 45; // degrees of influence around the target hue
    for (var i = 0; i < d.length; i += 4) {
      var hsv = rgbToHsv(d[i], d[i + 1], d[i + 2]);
      if (hsv[1] < 0.12) continue; // skip near-gray pixels
      var dh = Math.abs(hsv[0] - fhsv[0]); if (dh > 180) dh = 360 - dh;
      if (dh > HUE_WIN) continue;
      var wgt = 1 - dh / HUE_WIN; // closer hue → stronger effect
      var ns = clamp01(hsv[1] + amount * 0.8 * wgt);
      var nh = hsv[0] + (fhsv[0] - hsv[0]) * 0.25 * wgt;
      if (nh < 0) nh += 360; else if (nh >= 360) nh -= 360;
      var rgb = hsvToRgb(nh, ns, hsv[2]);
      d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2];
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  // ---- pipeline / re-render --------------------------------------------

  function anyActive() {
    return state.optimized || state.grayscale || state.bgRemoved ||
           state.brightness !== 0 || state.recolors.length > 0 ||
           state.boosts.length > 0;
  }

  // Rebuild the working source from the pristine base, then re-run the mosaic.
  function recompute(done) {
    if (!ensureBase()) { if (done) done(false); return; }
    if (!anyActive()) {
      // Feed the pristine captured base, NOT null. On step 2 the live CropperJS
      // box has collapsed to 0x0 (step 1 is hidden), so letting _runStep2Body fall
      // back to inputImageCropper.getCroppedCanvas() would re-render a broken crop
      // — that's the "reset/toggle-off only partly restores the original" bug.
      // Rendering from baseCanvas guarantees a true, complete revert.
      window.bkAi.sourceCanvas = cloneCanvas(state.baseCanvas);
    } else {
      var work = cloneCanvas(state.baseCanvas);
      if (state.optimized) autoEnhance(work);
      if (state.grayscale) desaturate(work);
      if (state.brightness) applyBrightness(work, state.brightness);
      for (var ri = 0; ri < state.recolors.length; ri++) {
        recolorSelective(work, state.recolors[ri].fromHex, state.recolors[ri].toHex);
      }
      for (var bi = 0; bi < state.boosts.length; bi++) {
        boostColor(work, state.boosts[bi].hex, state.boosts[bi].amount);
      }
      if (state.bgRemoved) {
        // Prefer the real ML person mask; fall back to the colour flood-fill
        // when no usable mask exists (non-person photo or model unavailable).
        if (state.bgMask) removeBackgroundMask(work, state.bgColor, state.bgMask);
        else removeBackground(work, state.bgColor);
      }
      window.bkAi.sourceCanvas = work;
    }
    rerunMosaic(done);
  }

  // Ensure the ML foreground mask for the current image is computed (once),
  // then invoke cb(hasMask). The first call lazy-downloads the segmentation
  // model (~9 MB wasm + 0.25 MB model, then browser-cached), so we surface a
  // loading note and hold the busy lock until it resolves. If segmentation is
  // unavailable or finds no clear subject, hasMask is false and the caller
  // proceeds with the flood-fill fallback.
  function ensureMask(cb) {
    if (state.bgMaskTried) { cb(!!state.bgMask); return; }
    if (!window.bkSeg || !ensureBase()) { state.bgMaskTried = true; cb(false); return; }
    setBusy(true);
    setStatus(tr("aiSegLoading"));
    window.bkSeg.segmentPerson(state.baseCanvas).then(function (r) {
      // Reject empty/degenerate masks (no subject, or the whole frame) — those
      // are worse than the flood-fill. A real cut-out covers a sane mid-range.
      if (r && r.coverage > 0.03 && r.coverage < 0.97) {
        state.bgMask = { data: r.mask, w: r.w, h: r.h };
      } else {
        state.bgMask = null;
      }
      state.bgMaskTried = true;
      clearStatus();
      setBusy(false);
      cb(!!state.bgMask);
    }).catch(function () {
      state.bgMask = null;
      state.bgMaskTried = true;
      clearStatus();
      setBusy(false);
      cb(false);
    });
  }

  // Force the global pipeline + our own UI back to an interactive state. Used
  // by the watchdog when runStepProcessing's callback never fires (a thrown
  // error mid-pipeline would otherwise leave the loading overlay up forever and
  // every control disabled — the "frozen, can't click, busy cursor" symptom).
  function forceRecover() {
    try { if (typeof _isRunningStepProcessing !== "undefined") _isRunningStepProcessing = false; } catch (e) {}
    try { if (typeof enableInteraction === "function") enableInteraction(); } catch (e2) {}
    try {
      var ov = document.getElementById("loading-overlay");
      if (ov) { ov.classList.add("hidden"); ov.classList.remove("show-spinner"); ov.style.pointerEvents = "none"; }
    } catch (e3) {}
  }

  function rerunMosaic(done) {
    if (typeof invalidateStepsFrom !== "function" || typeof runStepProcessing !== "function") {
      if (done) done(false);
      return;
    }
    setBusy(true);
    var settled = false;
    function finish(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      setBusy(false);
      syncButtons();
      if (done) done(ok);
    }
    // Safety net: if the pipeline never calls back (an exception inside a step,
    // e.g. a collapsed cropper read), recover the UI instead of hanging.
    var watchdog = setTimeout(function () {
      forceRecover();
      finish(false);
    }, 8000);
    // Defer one frame so the disabled/busy UI paints before the heavy pass.
    requestAnimationFrame(function () {
      try {
        invalidateStepsFrom(2);
        runStepProcessing(3, function () { finish(true); });
      } catch (err) {
        forceRecover();
        finish(false);
      }
    });
  }

  function fullReset(done) {
    state.optimized = false;
    state.grayscale = false;
    state.brightness = 0;
    state.recolors = [];
    state.boosts = [];
    state.bgRemoved = false;
    state.bgColor = "#ffffff";
    // Keep state.bgMask: the photo is unchanged, so a re-toggle of "remove
    // background" can reuse the already-computed ML mask without re-downloading.
    hideSwatches();
    clearStatus();
    syncButtons();
    // Route through recompute(): with every flag cleared anyActive() is false, so
    // it feeds the pristine baseCanvas (not null) and re-renders the true original.
    // This is what makes Reset a COMPLETE revert regardless of how many button +
    // chat ops were stacked — the previous null path re-derived from the collapsed
    // cropper and left the image subtly wrong ("some things reset, some don't").
    recompute(done);
  }

  // Called when the user re-enters step 1 / re-crops: drop the cached base
  // and all edits so the next pass uses the fresh crop.
  function resetForNewImage() {
    state.baseCanvas = null;
    state.optimized = false;
    state.grayscale = false;
    state.brightness = 0;
    state.recolors = [];
    state.boosts = [];
    state.bgRemoved = false;
    state.bgColor = "#ffffff";
    state.bgMask = null;       // new image → previous ML mask is invalid
    state.bgMaskTried = false;
    window.bkAi.sourceCanvas = null;
    hideSwatches();
    clearStatus();
    syncButtons();
  }

  // ---- UI plumbing ------------------------------------------------------

  function setBusy(busy) {
    state.busy = busy;
    [els.optimize, els.bg, els.reset, els.send, els.input].forEach(function (el) {
      if (el) el.disabled = busy;
    });
    // The swatches aren't .btn elements, so the global lock never touches them.
    // Disable them here too, otherwise a swatch click can start a second
    // mosaic re-render on top of an in-flight one and corrupt the pipeline.
    if (els.swatchRow) {
      var sw = els.swatchRow.querySelectorAll(".bk-ai-swatch");
      for (var i = 0; i < sw.length; i++) sw[i].disabled = busy;
    }
  }

  function syncButtons() {
    if (els.optimize) els.optimize.classList.toggle("is-active", state.optimized);
    if (els.bg) els.bg.classList.toggle("is-active", state.bgRemoved);
    if (els.swatches) els.swatches.hidden = !state.bgRemoved;
    if (els.swatchRow) {
      var sw = els.swatchRow.querySelectorAll(".bk-ai-swatch");
      for (var i = 0; i < sw.length; i++) {
        sw[i].classList.toggle("is-active", sw[i].getAttribute("data-hex").toLowerCase() === state.bgColor.toLowerCase());
      }
    }
  }

  function showSwatches() { if (els.swatches) els.swatches.hidden = false; }
  function hideSwatches() { if (els.swatches) els.swatches.hidden = true; }

  // Small inline status line under the action buttons — used for the one-time
  // "loading the AI model" note so a multi-second first download never feels
  // like a freeze.
  function setStatus(text) {
    if (!els.status) return;
    els.status.textContent = text;
    els.status.classList.add("is-visible");
  }
  function clearStatus() {
    if (!els.status) return;
    els.status.textContent = "";
    els.status.classList.remove("is-visible");
  }

  function buildSwatches() {
    if (!els.swatchRow) return;
    els.swatchRow.innerHTML = "";
    COLORS.forEach(function (col) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "bk-ai-swatch";
      b.style.background = col.hex;
      b.setAttribute("data-hex", col.hex);
      b.setAttribute("data-name", col.name);
      b.title = col.name;
      b.setAttribute("aria-label", "Hintergrund " + col.name);
      b.addEventListener("click", function () {
        if (state.busy) return;
        state.bgRemoved = true;
        state.bgColor = col.hex;
        showSwatches();
        recompute();
      });
      els.swatchRow.appendChild(b);
    });
  }

  // ---- mini-chat (intent-scoped, image-only) ---------------------------

  function addMsg(text, who) {
    if (!els.chatLog) return;
    var m = document.createElement("div");
    m.className = "bk-ai-msg " + (who === "user" ? "user" : "bot");
    m.textContent = text;
    els.chatLog.appendChild(m);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }

  function detectColor(text) {
    // Direct palette name match.
    for (var i = 0; i < COLORS.length; i++) {
      if (text.indexOf(COLORS[i].name) !== -1) return COLORS[i];
    }
    // Alias match.
    for (var alias in COLOR_ALIASES) {
      if (COLOR_ALIASES.hasOwnProperty(alias) && text.indexOf(alias) !== -1) {
        var canon = COLOR_ALIASES[alias];
        for (var j = 0; j < COLORS.length; j++) if (COLORS[j].name === canon) return COLORS[j];
      }
    }
    return null;
  }

  // All distinct palette colours mentioned, in order of first appearance.
  // Longest tokens are matched first and blanked out so substrings (e.g. the
  // "blau" inside "hellblau") can't produce phantom extra colours.
  function detectColorsOrdered(text) {
    var tokens = [];
    for (var i = 0; i < COLORS.length; i++) tokens.push({ token: COLORS[i].name, canon: COLORS[i].name });
    for (var a in COLOR_ALIASES) if (COLOR_ALIASES.hasOwnProperty(a)) tokens.push({ token: a, canon: COLOR_ALIASES[a] });
    tokens.sort(function (x, y) { return y.token.length - x.token.length; });
    var work = text, hits = [];
    for (var k = 0; k < tokens.length; k++) {
      var idx = work.indexOf(tokens[k].token);
      if (idx === -1) continue;
      hits.push({ canon: tokens[k].canon, idx: idx });
      work = work.split(tokens[k].token).join(new Array(tokens[k].token.length + 1).join(" "));
    }
    hits.sort(function (p, q) { return p.idx - q.idx; });
    var seen = {}, out = [];
    for (var m = 0; m < hits.length; m++) {
      if (seen[hits[m].canon]) continue;
      seen[hits[m].canon] = 1;
      for (var j2 = 0; j2 < COLORS.length; j2++) {
        if (COLORS[j2].name === hits[m].canon) { out.push({ col: COLORS[j2], idx: hits[m].idx }); break; }
      }
    }
    out.sort(function (p, q) { return p.idx - q.idx; });
    return out;
  }

  // Maps a free-text message to one image intent, executes it, and replies.
  // Anything it can't map to an image command is refused (off-topic).
  function handleChat(raw) {
    var text = (raw || "").toLowerCase().trim();
    if (!text) return;
    addMsg(raw.trim(), "user");

    var hasImg = ensureBase();
    function need() {
      if (!hasImg) { addMsg(tr("aiChatNoImage"), "bot"); return false; }
      return true;
    }

    // 1) Reset / undo.
    if (/(zur(ü|ue)cksetz|\bzur(ü|ue)ck\b|r(ü|ue)ckg(ä|ae)ngig|\boriginal\b|\breset\b|von vorne|alles (weg|zur(ü|ue)ck)|mach.*r(ü|ue)ckg)/.test(text)) {
      if (!need()) return;
      fullReset();
      addMsg(tr("aiChatDoneReset"), "bot");
      return;
    }

    // 2) Grayscale / black & white. Checked BEFORE recolor so phrases like
    // "in Schwarz-Weiß" aren't mistaken for a "make it white" background recolor
    // (the word "weiß" would otherwise match the white swatch). Explicit recolor
    // phrasing such as "Hintergrund grau" still falls through to branch 3.
    if (/(schwarz.?wei(ß|ss)|graustufen|grayscale|grau mach|entf(ä|ae)rb|\bs\/?w\b)/.test(text)) {
      if (!need()) return;
      state.grayscale = true;
      recompute();
      addMsg(tr("aiChatDoneGray"), "bot");
      return;
    }

    var color = detectColor(text);
    var bgWord = /(hintergrund|background|\bbg\b)/.test(text);
    var colorVerb = /(mach|mache|f(ä|ae)rb|einf(ä|ae)rb|color|colou?r)/.test(text);

    // 2a) Object-targeted request guard. The tool works on the WHOLE image by
    // colour — it can't locate a single object ("der Laptop", "die Haare"). If
    // the user names an object together with a recolor verb/colour (and it's NOT
    // a background command), explain the limitation honestly instead of silently
    // recolouring the background — which is what used to happen and confused users.
    var objectWord = /(laptop|notebook|computer|gesicht|haar|auge|hund|katze|tier|hemd|shirt|jacke|pullover|hose|kleid|m(ü|ue)tze|\bhut\b|auto|tasse|becher|kaffee|tisch|stuhl|\bwand\b|himmel|blume|baum|schuh|brille|handy|\bball\b|person|\bmann\b|\bfrau\b|\bkind\b|junge|m(ä|ae)dchen|haut|lippen|mund|\bnase\b|m(ö|oe)bel)/.test(text);
    if (objectWord && !bgWord &&
        (color || colorVerb || /(umf(ä|ae)rb|austausch|wechsel|(ä|ae)nder)/.test(text))) {
      addMsg(tr("aiChatObjectUnsupported"), "bot");
      return;
    }

    // 2b) Selective colour replacement, e.g. "aus Orange mach Blau" or
    // "statt orange blau". Triggered by two distinct palette colours WITHOUT a
    // background word (a bg word means it's a background command, branch 3/4).
    var twoColors = detectColorsOrdered(text);
    if (!bgWord && twoColors.length >= 2) {
      if (!need()) return;
      var fromC = null, toC = null;
      // "statt/anstatt/anstelle X": the colour right after the keyword is the
      // OLD one to replace; the other is the target.
      var sIdx = text.search(/anstelle|anstatt|statt/);
      if (sIdx !== -1) {
        for (var ci = 0; ci < twoColors.length; ci++) {
          if (twoColors[ci].idx > sIdx) { fromC = twoColors[ci].col; break; }
        }
        for (var cj = 0; cj < twoColors.length; cj++) {
          if (twoColors[cj].col !== fromC) { toC = twoColors[cj].col; break; }
        }
      }
      if (!fromC || !toC) { fromC = twoColors[0].col; toC = twoColors[1].col; }
      if (fromC === toC) { addMsg(tr("aiChatOffTopic"), "bot"); return; }
      if (hueMatchFraction(state.baseCanvas, fromC.hex) < 0.003) {
        addMsg(tr("aiChatRecolorNoMatch").replace("{from}", fromC.name), "bot");
        return;
      }
      state.recolors.push({ fromHex: fromC.hex, toHex: toC.hex, fromName: fromC.name, toName: toC.name });
      recompute();
      addMsg(tr("aiChatDoneRecolor").replace("{from}", fromC.name).replace("{to}", toC.name), "bot");
      return;
    }

    // 2c) Colour intensity, e.g. "ich will mehr rot", "weniger blau",
    // "kräftigeres grün". One colour, no background word, no second colour.
    var moreWord = /(mehr|kr(ä|ae)ftiger|kr(ä|ae)ftige|intensiver|intensive|s(ä|ae)ttiger|ges(ä|ae)ttigt|knalliger)/.test(text);
    var lessWord = /(weniger|blasser|blasse|ents(ä|ae)ttig|matter|dezenter|schw(ä|ae)cher)/.test(text);
    if (color && !bgWord && twoColors.length < 2 && (moreWord || lessWord)) {
      if (!need()) return;
      var amt = lessWord ? -0.5 : 0.5;
      state.boosts.push({ hex: color.hex, name: color.name, amount: amt });
      recompute();
      addMsg(tr(lessWord ? "aiChatDoneLess" : "aiChatDoneMore").replace("{color}", color.name), "bot");
      return;
    }

    // 3) Background recolor (colour + a bg word or a colour verb).
    if (color && (bgWord || colorVerb)) {
      if (!need()) return;
      state.bgRemoved = true;
      state.bgColor = color.hex;
      showSwatches();
      ensureMask(function (hasMask) {
        recompute();
        addMsg(tr("aiChatDoneBgColor").replace("{color}", color.name), "bot");
        if (!hasMask) addMsg(tr("aiChatBgNoPerson"), "bot");
      });
      return;
    }

    // 4) Background removal.
    if (/(freistell|ausschneid)/.test(text) ||
        (bgWord && /(entfern|\bweg\b|raus|frei|los\b|l(ö|oe)sch)/.test(text)) ||
        /remove background|cut.?out/.test(text)) {
      if (!need()) return;
      state.bgRemoved = true;
      if (!state.bgColor) state.bgColor = "#ffffff";
      showSwatches();
      ensureMask(function (hasMask) {
        recompute();
        addMsg(hasMask ? tr("aiChatDoneBg") : tr("aiChatBgNoPerson"), "bot");
      });
      return;
    }

    // 5) Optimize / enhance.
    if (/(optimier|verbesser|sch(ä|ae)rfer|\bscharf|kontrast|klarer|qualit(ä|ae)t|besser mach|aufpolier|versch(ö|oe)ner|enhance|verbessere)/.test(text)) {
      if (!need()) return;
      state.optimized = true;
      recompute();
      addMsg(tr("aiChatDoneOptimize"), "bot");
      return;
    }

    // 6) Brightness.
    if (/(heller|aufhellen|mehr licht|brighter)/.test(text)) {
      if (!need()) return;
      state.brightness = Math.min(state.brightness + 22, 88);
      recompute();
      addMsg(tr("aiChatDoneBrighter"), "bot");
      return;
    }
    if (/(dunkler|abdunkeln|weniger licht|darker)/.test(text)) {
      if (!need()) return;
      state.brightness = Math.max(state.brightness - 22, -88);
      recompute();
      addMsg(tr("aiChatDoneDarker"), "bot");
      return;
    }

    // 7) Help / greeting → show what the assistant can do.
    if (/(hilfe|\bhelp\b|was kannst du|was geht|wie funktion|hallo|\bhi\b|\bhey\b|moin)/.test(text)) {
      addMsg(tr("aiChatGreeting"), "bot");
      return;
    }

    // 8) Anything else is off-topic → refuse (scoped to images only).
    addMsg(tr("aiChatOffTopic"), "bot");
  }

  // ---- init -------------------------------------------------------------

  function init() {
    els.panel = document.getElementById("bk-ai-tools");
    if (!els.panel) return;
    els.optimize = document.getElementById("bk-ai-optimize");
    els.bg = document.getElementById("bk-ai-bg");
    els.reset = document.getElementById("bk-ai-reset");
    els.swatches = document.getElementById("bk-ai-swatches");
    els.swatchRow = document.getElementById("bk-ai-swatch-row");
    // Inline status line (created once) for the "AI model loading…" note.
    els.status = document.getElementById("bk-ai-status");
    if (!els.status && els.panel) {
      els.status = document.createElement("div");
      els.status.id = "bk-ai-status";
      els.status.className = "bk-ai-status";
      els.status.setAttribute("aria-live", "polite");
      var actions = els.panel.querySelector(".bk-ai-actions");
      if (actions && actions.parentNode) actions.parentNode.insertBefore(els.status, actions.nextSibling);
      else els.panel.appendChild(els.status);
    }
    els.chatLog = document.getElementById("bk-ai-chat-log");
    els.chatForm = document.getElementById("bk-ai-chat-form");
    els.input = document.getElementById("bk-ai-chat-input");
    els.send = document.getElementById("bk-ai-chat-send");

    buildSwatches();

    if (els.optimize) els.optimize.addEventListener("click", function () {
      if (state.busy) return;
      if (!ensureBase()) return;
      state.optimized = !state.optimized;
      recompute();
    });
    if (els.bg) els.bg.addEventListener("click", function () {
      if (state.busy) return;
      if (!ensureBase()) return;
      state.bgRemoved = !state.bgRemoved;
      if (state.bgRemoved) {
        if (!state.bgColor) state.bgColor = "#ffffff";
        showSwatches();
        ensureMask(function () { recompute(); }); // ML mask first, then render
      } else {
        hideSwatches();
        recompute();
      }
    });
    if (els.reset) els.reset.addEventListener("click", function () {
      if (state.busy) return;
      fullReset();
    });

    if (els.chatForm) els.chatForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (state.busy) return;
      var v = els.input ? els.input.value : "";
      if (els.input) els.input.value = "";
      handleChat(v);
    });

    // Reveal the panel + seed the chat greeting when the user reaches step 2
    // (the main entry is the "Weiter: Farben" button). Reset edits whenever
    // they go back to re-crop, so a fresh crop isn't overridden by stale ops.
    var createBtn = document.getElementById("create-mosaic-btn");
    if (createBtn) createBtn.addEventListener("click", function () {
      resetForNewImage();
      els.panel.hidden = false;
      if (els.chatLog && !els.chatLog.childElementCount) addMsg(tr("aiChatGreeting"), "bot");
    });
    var backBtn = document.getElementById("back-to-step1-btn");
    if (backBtn) backBtn.addEventListener("click", function () { resetForNewImage(); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
