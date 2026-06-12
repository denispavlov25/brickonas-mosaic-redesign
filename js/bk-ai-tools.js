/*
 * BRICKONAS — KI-Bildwerkzeuge (step 2)
 * ------------------------------------------------------------------
 * Client-side image helpers for the mosaic configurator's "Farben
 * verfeinern" step. Lets users improve the source photo without the
 * paintbrush: auto-optimize, background removal and background recolor.
 * Plus an intent-scoped mini-chat that ONLY understands image commands
 * and politely refuses anything off-topic.
 *
 * Privacy: ALL image processing runs in the browser — the photo never
 * leaves the device. Two features reach the network, and neither sends
 * the image:
 *   - object-aware edits stream ML models (DETR/OWL-ViT/SlimSAM) from a
 *     public CDN on first use (see OBJ_SYN block below);
 *   - the chat sends only the typed TEXT to a same-origin proxy
 *     (mu-plugin bk-ai-chat-proxy.php) which calls Gemini for intent
 *     classification, then executes the result locally. The API key
 *     stays server-side; if the proxy is unreachable the chat falls back
 *     to the offline regex parser (routeLocal). See askLLM/dispatchIntent.
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
  // KEEP IN SYNC WITH bk_ai_chat_colors() in mu-plugins/bk-ai-chat-proxy.php
  // (the LLM's allowed-colour enum must match these names exactly).
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
    objectLayer: null,  // pristine base WITH baked object edits (remove/recolor a
                        // named object). null = no object edits yet. recompute()
                        // starts from this when present, so other ops stack on top.
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

  // The pristine source every recompute() builds on: the photo AFTER any baked
  // object edits if present, else the original crop. Keeping object edits in a
  // separate layer (instead of mutating baseCanvas) means Reset can still restore
  // the true original, and the slow detect→segment pass runs once, not per render.
  function workBase() { return state.objectLayer || state.baseCanvas; }

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

    // 1) White balance — Shades of Gray (p-norm, p=6), but COLOR-CAST AWARE.
    //    Gray-world / Shades-of-Gray assume the scene averages to gray. A photo of
    //    a deliberately single-hued subject (e.g. an orange tiger) violates that:
    //    the blue channel is tiny, so its gain explodes (~2.3x) and the whole image
    //    turns blue. We measure how strongly the image is tinted (castStrength) and
    //    damp BOTH the white balance and the per-channel auto-color by that amount,
    //    plus hard-clamp every channel gain so no single channel can blow out.
    var p6R = 0, p6G = 0, p6B = 0, sumR = 0, sumG = 0, sumB = 0, cnt = 0;
    for (i = 0; i < n; i += 4) {
      var rr = d[i], gg = d[i + 1], bb = d[i + 2];
      p6R += rr * rr * rr * rr * rr * rr;
      p6G += gg * gg * gg * gg * gg * gg;
      p6B += bb * bb * bb * bb * bb * bb;
      sumR += rr; sumG += gg; sumB += bb;
      cnt++;
    }
    var mR = sumR / cnt, mG = sumG / cnt, mB = sumB / cnt;
    var mGray = (mR + mG + mB) / 3 || 1;
    // castStrength = how far the most-dominant channel sits from neutral gray.
    // ~0 for a neutral photo, large (>0.35) for a strongly single-hued subject.
    var maxDev = Math.max(Math.abs(mR - mGray), Math.abs(mG - mGray), Math.abs(mB - mGray)) / mGray;
    // neutralFactor: 1 = apply full neutralization (neutral photo); floors at 0.12
    // for a strongly tinted subject so we barely touch its real colour.
    var neutralFactor = 1 - maxDev / 0.35;
    if (neutralFactor < 0.12) neutralFactor = 0.12; else if (neutralFactor > 1) neutralFactor = 1;

    var illR = Math.pow(p6R / cnt, 1 / 6);
    var illG = Math.pow(p6G / cnt, 1 / 6);
    var illB = Math.pow(p6B / cnt, 1 / 6);
    var illGray = (illR + illG + illB) / 3;
    var sR = illR > 1 ? illGray / illR : 1, sG = illG > 1 ? illGray / illG : 1, sB = illB > 1 ? illGray / illB : 1;
    // Damp by a fixed 0.7 AND by cast-awareness, then hard-clamp to a tight range
    // so a low channel (blue on an orange image) can never be more than mildly scaled.
    var wbDamp = 0.7 * neutralFactor;
    sR = 1 + (sR - 1) * wbDamp; sG = 1 + (sG - 1) * wbDamp; sB = 1 + (sB - 1) * wbDamp;
    function clampGain(s) { return s < 0.85 ? 0.85 : (s > 1.18 ? 1.18 : s); }
    sR = clampGain(sR); sG = clampGain(sG); sB = clampGain(sB);

    // 2) Per-channel histograms after WB to find clip points, plus a shared
    //    luminance histogram. Independently stretching each channel is "auto
    //    colour" and removes a cast — great for a neutral photo, disastrous for
    //    an orange subject (it pumps the sparse blue channel up to full range).
    //    So we blend each channel's clip points toward the SHARED luminance clip
    //    points by neutralFactor: tinted image -> shared stretch (pure contrast,
    //    no colour shift); neutral image -> per-channel auto-colour as before.
    var hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    var histL = new Uint32Array(256);
    for (i = 0; i < n; i += 4) {
      var r0 = clamp255(d[i] * sR) | 0;
      var g0 = clamp255(d[i + 1] * sG) | 0;
      var b0 = clamp255(d[i + 2] * sB) | 0;
      d[i] = r0; d[i + 1] = g0; d[i + 2] = b0; // keep WB result in place
      hist[0][r0]++; hist[1][g0]++; hist[2][b0]++;
      histL[(0.299 * r0 + 0.587 * g0 + 0.114 * b0) | 0]++;
    }
    var clipCount = cnt * 0.001; // tight 0.1% clip (Photoshop Auto Tone default)
    function findLow(hch) { var acc = 0; for (var v = 0; v < 256; v++) { acc += hch[v]; if (acc > clipCount) return v; } return 0; }
    function findHigh(hch) { var acc = 0; for (var v = 255; v >= 0; v--) { acc += hch[v]; if (acc > clipCount) return v; } return 255; }
    var loC = [findLow(hist[0]), findLow(hist[1]), findLow(hist[2])];
    var hiC = [findHigh(hist[0]), findHigh(hist[1]), findHigh(hist[2])];
    var loL = findLow(histL), hiL = findHigh(histL);
    var lo = [], hi = [], span = [];
    for (var s = 0; s < 3; s++) {
      lo[s] = loC[s] * neutralFactor + loL * (1 - neutralFactor);
      hi[s] = hiC[s] * neutralFactor + hiL * (1 - neutralFactor);
      span[s] = hi[s] - lo[s];
      if (span[s] < 8) span[s] = 8; // avoid blowups on flat channels
    }

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
      gch = 1 + (gch - 1) * neutralFactor; // cast-aware: don't snap a real colour to gray
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
      // workBase() = baseCanvas, or the object-edited layer if the user removed /
      // recoloured a named object (which must survive with no other ops active).
      window.bkAi.sourceCanvas = cloneCanvas(workBase());
    } else {
      var work = cloneCanvas(workBase());
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
    // Defer one frame so the loading overlay paints before the (cached-model)
    // segmentation inference blocks the main thread — see runObjectEdit note.
    requestAnimationFrame(function () {
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
    state.objectLayer = null; // drop baked object edits → back to the true original
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
    state.objectLayer = null;  // new image → drop baked object edits
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

  // Central processing overlay — reuses the engine's #loading-overlay card so an
  // AI pass (esp. the multi-second object-detection on first chat use) reads as
  // "working", not "frozen / hung". A chat message alone isn't enough feedback.
  // Callers can set a context message via setBusyMsg() before flipping busy on.
  var _busyTitle = null;
  var _busySub = null;
  function setBusyMsg(title, sub) { _busyTitle = title || null; _busySub = sub || null; }
  function aiOverlay(show) {
    var ov = document.getElementById("loading-overlay");
    if (!ov) return;
    if (show) {
      var t = document.getElementById("loading-overlay-title");
      var s = document.getElementById("loading-overlay-sub");
      if (t) t.innerHTML = _busyTitle || tr("aiBusyTitle");
      if (s) s.innerHTML = _busySub || tr("aiBusySub");
      ov.classList.remove("hidden");
      // bk-instant kills the fade so the spinner is on-screen before any
      // synchronous compute can stutter the first frame.
      ov.classList.add("bk-instant");
      void ov.offsetWidth;
      ov.classList.add("show-spinner");
    } else {
      ov.classList.add("hidden");
      ov.classList.remove("show-spinner");
      ov.classList.remove("bk-instant");
    }
  }

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
    aiOverlay(busy);
    if (!busy) { _busyTitle = null; _busySub = null; }
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

  // ---- object-aware editing (detect → segment → remove / recolor) -------
  // Lets the chat act on a NAMED object ("entferne den Laptop", "färbe den
  // Hund blau") instead of the whole image. Pipeline, all in-browser:
  //   1. detect  — find the object's bounding box. COCO DETR for the 80 common
  //      classes (fast, ~55 MB); OWL-ViT zero-shot ONLY for words COCO can't
  //      know (~+148 MB, lazy-downloaded on demand). No cross-fallback, so the
  //      big OWL download never happens for a common object.
  //   2. segment — SlimSAM turns that box into a precise pixel mask.
  //   3. edit    — recolor (masked HSV, keep brightness) or remove (boundary
  //      inpaint). The result is baked into state.objectLayer so Reset still
  //      restores the true original and other ops (optimize, bg, …) stack on top.
  // Models stream from the HuggingFace/jsDelivr CDN on first use (the ONLY
  // external hosts this feature needs); everything else stays on-device.

  // German trigger words → detector query. coco = the COCO-80 label (DETR path);
  // null coco = open-vocabulary, OWL-ViT path with the English `q` label.
  // KEEP IN SYNC WITH bk_ai_chat_objects() in mu-plugins/bk-ai-chat-proxy.php
  // (the LLM's allowed-object enum uses the FIRST key of each entry here).
  var OBJ_SYN = [
    { keys: ["laptop", "notebook", "computer"], coco: "laptop", q: "laptop" },
    { keys: ["handy", "smartphone", "telefon"], coco: "cell phone", q: "mobile phone" },
    { keys: ["hund"], coco: "dog", q: "dog" },
    { keys: ["katze"], coco: "cat", q: "cat" },
    { keys: ["auto", "wagen"], coco: "car", q: "car" },
    { keys: ["fahrrad"], coco: "bicycle", q: "bicycle" },
    { keys: ["pferd"], coco: "horse", q: "horse" },
    { keys: ["vogel"], coco: "bird", q: "bird" },
    { keys: ["tasse", "becher", "kaffee"], coco: "cup", q: "cup" },
    { keys: ["flasche"], coco: "bottle", q: "bottle" },
    { keys: ["stuhl"], coco: "chair", q: "chair" },
    { keys: ["sofa", "couch"], coco: "couch", q: "couch" },
    { keys: ["tisch"], coco: "dining table", q: "table" },
    { keys: ["buch"], coco: "book", q: "book" },
    { keys: ["uhr"], coco: "clock", q: "clock" },
    { keys: ["fernseher", "tv"], coco: "tv", q: "tv" },
    { keys: ["bett"], coco: "bed", q: "bed" },
    { keys: ["pizza"], coco: "pizza", q: "pizza" },
    { keys: ["apfel"], coco: "apple", q: "apple" },
    { keys: ["banane"], coco: "banana", q: "banana" },
    { keys: ["person", "mann", "frau", "kind", "junge", "mädchen", "mensch"], coco: "person", q: "person" },
    // open-vocabulary (not in COCO-80) → OWL-ViT
    { keys: ["gesicht"], coco: null, q: "face" },
    { keys: ["haare", "haar"], coco: null, q: "hair" },
    // face = a precise FaceLandmarker mask is tried first (human portraits),
    // with the q/OWL-ViT path as the fallback for non-face photos. "augenbrauen"
    // must precede "augen" so the longer word wins the findObject tie-break.
    { keys: ["augenbrauen", "augenbraue"], coco: null, q: "eyebrow", face: "eyebrows" },
    { keys: ["augen", "auge"], coco: null, q: "eye", face: "eyes" },
    { keys: ["hemd", "t-shirt", "shirt"], coco: null, q: "shirt" },
    { keys: ["jacke"], coco: null, q: "jacket" },
    { keys: ["pullover", "pulli"], coco: null, q: "sweater" },
    { keys: ["hose"], coco: null, q: "pants" },
    { keys: ["kleid"], coco: null, q: "dress" },
    { keys: ["mütze", "hut"], coco: null, q: "hat" },
    { keys: ["brille"], coco: null, q: "glasses" },
    { keys: ["schuhe", "schuh"], coco: null, q: "shoe" },
    { keys: ["blume"], coco: null, q: "flower" },
    { keys: ["baum"], coco: null, q: "tree" },
    { keys: ["himmel"], coco: null, q: "sky" },
    { keys: ["wand"], coco: null, q: "wall" },
    { keys: ["ball"], coco: null, q: "ball" },
    { keys: ["tier"], coco: null, q: "animal" },
    { keys: ["lippen", "mund"], coco: null, q: "lips" },
    { keys: ["nase"], coco: null, q: "nose" },
    { keys: ["haut"], coco: null, q: "skin" },
    { keys: ["möbel"], coco: null, q: "furniture" },
    { keys: ["tiger"], coco: null, q: "tiger" }
  ];

  // Find the first object noun mentioned in `text`. Longest key wins on ties so
  // "augen" isn't shadowed by "auge"; earliest position wins overall. Returns
  // { entry, key } (key is the German word, used in the chat reply) or null.
  function findObject(text) {
    var best = null;
    for (var e = 0; e < OBJ_SYN.length; e++) {
      var keys = OBJ_SYN[e].keys;
      for (var k = 0; k < keys.length; k++) {
        var idx = text.indexOf(keys[k]);
        if (idx === -1) continue;
        if (!best || idx < best.idx || (idx === best.idx && keys[k].length > best.key.length)) {
          best = { entry: OBJ_SYN[e], key: keys[k], idx: idx };
        }
      }
    }
    return best ? { entry: best.entry, key: best.key } : null;
  }

  // ML model holders — all lazy so a user who never edits an object pays nothing.
  var _tf = null, _cocoDet = null, _owlDet = null, _samModel = null, _samProc = null;
  var TF_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.2";

  function loadTransformers() {
    if (_tf) return Promise.resolve(_tf);
    // Dynamic import keeps this classic IIFE script while pulling the ESM lib.
    return import(/* webpackIgnore: true */ TF_URL).then(function (m) {
      m.env.allowLocalModels = false;
      _tf = m;
      return m;
    });
  }
  function loadCoco() {
    if (_cocoDet) return Promise.resolve(_cocoDet);
    return loadTransformers().then(function (m) {
      return m.pipeline("object-detection", "Xenova/detr-resnet-50", { dtype: "q8", device: "wasm" });
    }).then(function (p) { _cocoDet = p; return p; });
  }
  function loadOwl() {
    if (_owlDet) return Promise.resolve(_owlDet);
    return loadTransformers().then(function (m) {
      return m.pipeline("zero-shot-object-detection", "Xenova/owlvit-base-patch32", { dtype: "q8", device: "wasm" });
    }).then(function (p) { _owlDet = p; return p; });
  }
  function loadSam() {
    if (_samModel && _samProc) return Promise.resolve(true);
    return loadTransformers().then(function (m) {
      return Promise.all([
        m.SamModel.from_pretrained("Xenova/slimsam-77-uniform", { dtype: "q8", device: "wasm" }),
        m.AutoProcessor.from_pretrained("Xenova/slimsam-77-uniform")
      ]);
    }).then(function (pair) { _samModel = pair[0]; _samProc = pair[1]; return true; });
  }

  // Canvas → transformers RawImage (RGBA, full canvas resolution).
  function canvasToRawImage(canvas) {
    var ctx = canvas.getContext("2d");
    var id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return new _tf.RawImage(new Uint8ClampedArray(id.data), canvas.width, canvas.height, 4);
  }

  // Detect the object's bounding box {xmin,ymin,xmax,ymax} or null. COCO words
  // use DETR only (no OWL fallback → no surprise 148 MB download); open-vocab
  // words use OWL-ViT.
  function detectObject(image, entry) {
    if (entry.coco) {
      return loadCoco().then(function (det) {
        return det(image, { threshold: 0.5 });
      }).then(function (out) {
        var hits = out.filter(function (o) { return o.label === entry.coco; })
                      .sort(function (a, b) { return b.score - a.score; });
        return hits.length ? hits[0].box : null;
      });
    }
    return loadOwl().then(function (det) {
      return det(image, [entry.q], { threshold: 0.05, topk: 5 });
    }).then(function (out) {
      if (!out.length) return null;
      return out.sort(function (a, b) { return b.score - a.score; })[0].box;
    });
  }

  // SlimSAM: bounding box → binary mask {data:Uint8Array, w, h} (1 = object).
  // v3 SamProcessor takes an options object. This SlimSAM ONNX export accepts
  // only input_points/input_labels (it silently ignores input_boxes), so we
  // prompt it with ONE positive point at the detection-box centre — that single
  // well-placed point yields a full-object mask (~56% coverage on a centred
  // subject), which is all this mosaic-grade recolor/remove needs.
  function segmentBox(image, box) {
    return loadSam().then(function () {
      var cx = Math.round((box.xmin + box.xmax) / 2), cy = Math.round((box.ymin + box.ymax) / 2);
      return _samProc(image, {
        input_points: [[[cx, cy]]],
        input_labels: [[1]]
      });
    }).then(function (inputs) {
      return Promise.all([inputs, _samModel(Object.assign({}, inputs))]);
    }).then(function (pair) {
      var inputs = pair[0], outputs = pair[1];
      return Promise.all([
        inputs, outputs,
        _samProc.post_process_masks(outputs.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes)
      ]);
    }).then(function (triple) {
      var outputs = triple[1], masks = triple[2];
      var mt = masks[0], dims = mt.dims;
      var H = dims[dims.length - 2], W = dims[dims.length - 1];
      var nMasks = dims[dims.length - 3] || 1;
      var iou = outputs.iou_scores.data, best = 0;
      for (var k = 1; k < nMasks; k++) if (iou[k] > iou[best]) best = k;
      var plane = H * W, off = best * plane, md = mt.data;
      var out = new Uint8Array(plane);
      for (var i = 0; i < plane; i++) out[i] = md[off + i] ? 1 : 0;
      return { mask: out, w: W, h: H };
    });
  }

  // Grow a binary mask by `px` pixels (covers the soft object boundary).
  function dilateMask(mask, w, h, px) {
    var cur = mask;
    for (var it = 0; it < px; it++) {
      var nx = Uint8Array.from(cur);
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var p = y * w + x;
          if (cur[p]) continue;
          if ((x > 0 && cur[p - 1]) || (x < w - 1 && cur[p + 1]) ||
              (y > 0 && cur[p - w]) || (y < h - 1 && cur[p + w])) nx[p] = 1;
        }
      }
      cur = nx;
    }
    return cur;
  }

  // Remove: iterative boundary inpaint — repeatedly fill masked pixels from their
  // already-known neighbours until the hole is closed. Convincing for objects
  // that don't fill the whole frame.
  function inpaintMask(ctx, w, h, mask) {
    var img = ctx.getImageData(0, 0, w, h), d = img.data;
    var rem = Uint8Array.from(mask), remaining = 0, i;
    for (i = 0; i < rem.length; i++) if (rem[i]) remaining++;
    var guard = 0;
    while (remaining > 0 && guard < 2000) {
      guard++;
      var fills = [];
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var p = y * w + x;
          if (!rem[p]) continue;
          var r = 0, g = 0, b = 0, c = 0, q;
          if (x > 0 && !rem[p - 1]) { q = (p - 1) * 4; r += d[q]; g += d[q + 1]; b += d[q + 2]; c++; }
          if (x < w - 1 && !rem[p + 1]) { q = (p + 1) * 4; r += d[q]; g += d[q + 1]; b += d[q + 2]; c++; }
          if (y > 0 && !rem[p - w]) { q = (p - w) * 4; r += d[q]; g += d[q + 1]; b += d[q + 2]; c++; }
          if (y < h - 1 && !rem[p + w]) { q = (p + w) * 4; r += d[q]; g += d[q + 1]; b += d[q + 2]; c++; }
          if (c) fills.push([p, r / c, g / c, b / c]);
        }
      }
      if (!fills.length) break;
      for (var f = 0; f < fills.length; f++) {
        var fp = fills[f][0] * 4;
        d[fp] = fills[f][1]; d[fp + 1] = fills[f][2]; d[fp + 2] = fills[f][3];
        rem[fills[f][0]] = 0; remaining--;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // Recolor: masked HSV repaint — force the target hue and keep each pixel's
  // own brightness (V) so shading/texture survive. Crucially we CLAMP V into a
  // mid band: the mosaic re-quantises to a fixed BrickLink palette, so a very
  // dark (shadowed) or blown-out pixel would otherwise snap to black/white and
  // the recolour looks patchy — e.g. only the lit half of a pair of lips turns
  // blue. Clamping keeps the whole region reading as the chosen colour while
  // still preserving some light/shade. Neutral targets (white/black/grey) are
  // painted flat with no hue tint. Reuses hexToRgb/rgbToHsv/hsvToRgb.
  function recolorMask(ctx, w, h, mask, hex) {
    var to = hexToRgb(hex), thsv = rgbToHsv(to.r, to.g, to.b);
    var neutral = thsv[1] < 0.12; // white / black / grey → no chroma
    var img = ctx.getImageData(0, 0, w, h), d = img.data;
    for (var i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      var q = i * 4, rgb;
      if (neutral) {
        rgb = hsvToRgb(0, 0, thsv[2]); // flat grey/white/black, reads cleanly
      } else {
        var hsv = rgbToHsv(d[q], d[q + 1], d[q + 2]);
        var v = Math.min(0.95, Math.max(0.42, hsv[2]));
        var s = Math.min(1, Math.max(hsv[1], 0.6));
        rgb = hsvToRgb(thsv[0], s, v);
      }
      d[q] = rgb[0]; d[q + 1] = rgb[1]; d[q + 2] = rgb[2];
    }
    ctx.putImageData(img, 0, 0);
  }

  // Nearest-neighbour resample a {mask,w,h} to W×H (the working-canvas grid).
  function resampleMask(seg, W, H) {
    if (seg.w === W && seg.h === H) return seg.mask;
    var mask = new Uint8Array(W * H);
    for (var y = 0; y < H; y++) {
      var sy = Math.min(seg.h - 1, (y / H * seg.h) | 0);
      for (var x = 0; x < W; x++) {
        var sx = Math.min(seg.w - 1, (x / W * seg.w) | 0);
        mask[y * W + x] = seg.mask[sy * seg.w + sx];
      }
    }
    return mask;
  }

  // Bake a ready mask (any resolution) as a remove/recolor edit into a fresh
  // object layer, then recompute() (which re-applies the other active ops and
  // re-renders, owning the busy lock until it finishes). Shared by BOTH mask
  // sources — the COCO/OWL object detector and FaceLandmarker — so "how an edit
  // is applied" lives in exactly one place.
  function bakeRegionEdit(seg, action, colorObj, dilatePx, onDone) {
    var base = workBase();
    var W = base.width, H = base.height;
    var mask = resampleMask(seg, W, H);
    if (dilatePx) mask = dilateMask(mask, W, H, dilatePx);
    var layer = cloneCanvas(base);
    var lctx = layer.getContext("2d");
    if (action === "remove") inpaintMask(lctx, W, H, mask);
    else recolorMask(lctx, W, H, mask, colorObj.hex);
    state.objectLayer = layer;
    recompute(onDone);
  }

  // Orchestrator: detect → segment → bake the edit into state.objectLayer, then
  // recompute() (which re-applies any other active ops and re-renders the mosaic).
  // objMatch = { entry, key }; action = "remove" | "recolor"; colorObj for recolor.
  function runObjectEdit(objMatch, action, colorObj) {
    if (!ensureBase()) { addMsg(tr("aiChatNoImage"), "bot"); return; }
    var label = objMatch.key;
    setBusyMsg(tr("aiBusyThink").replace("{obj}", label), tr("aiBusyThinkSub"));
    setBusy(true);
    setStatus(tr("aiChatObjectModelLoading"));
    addMsg(tr("aiChatObjectSearching").replace("{obj}", label), "bot");

    // Defer the heavy model load + inference one frame so the loading overlay
    // actually paints first. When the model is already cached, loadTransformers()
    // resolves synchronously and the inference would otherwise run as a microtask
    // before any render — the user sees a freeze with no spinner (esp. on the
    // not-found path, which finishes without ever yielding to a paint).
    requestAnimationFrame(function () {
    var base = workBase();
    var image;
    loadTransformers()
      .then(function () {
        image = canvasToRawImage(base);
        return detectObject(image, objMatch.entry);
      })
      .then(function (box) {
        if (!box) { return null; }
        return segmentBox(image, box);
      })
      .then(function (seg) {
        if (!seg) {
          // not found → bail cleanly, no edit
          clearStatus();
          setBusy(false);
          addMsg(tr("aiChatObjectNotFound").replace("{obj}", label), "bot");
          return;
        }
        // Resample → dilate 2px → bake → re-render, all in bakeRegionEdit
        // (which owns the busy lock from here and clears it on finish).
        clearStatus();
        bakeRegionEdit(seg, action, colorObj, 2, function () {
          if (action === "remove") {
            addMsg(tr("aiChatDoneObjectRemove").replace("{obj}", label), "bot");
          } else {
            addMsg(tr("aiChatDoneObjectRecolor").replace("{obj}", label).replace("{color}", colorObj.name), "bot");
          }
        });
      })
      .catch(function () {
        clearStatus();
        setBusy(false);
        addMsg(tr("aiChatObjectUnavailable"), "bot");
      });
    });
  }

  // Find the OBJ_SYN entry for a face part, so a no-face fallback can hand off
  // to the generic OWL-ViT detector (e.g. "eye"/"nose" on an animal).
  function fallbackMatch(part, label) {
    for (var i = 0; i < OBJ_SYN.length; i++) {
      if (OBJ_SYN[i].face === part) return { entry: OBJ_SYN[i], key: label };
    }
    return { entry: { coco: null, q: part }, key: label };
  }

  // Face-part edit (eyes / nose / lips / eyebrows): builds a PRECISE mask from
  // MediaPipe FaceLandmarker — the on-device model the coarse OWL-ViT detector
  // couldn't match on small facial parts. If no human face is present (e.g. an
  // animal photo), it transparently falls back to the generic detector so the
  // request still does its best instead of silently failing.
  function runFacePartEdit(part, label, action, colorObj) {
    if (!ensureBase()) { addMsg(tr("aiChatNoImage"), "bot"); return; }
    if (!window.bkRegion) { runObjectEdit(fallbackMatch(part, label), action, colorObj); return; }
    setBusyMsg(tr("aiBusyThink").replace("{obj}", label), tr("aiBusyThinkSub"));
    setBusy(true);
    setStatus(tr("aiChatObjectModelLoading"));
    addMsg(tr("aiChatObjectSearching").replace("{obj}", label), "bot");
    // Defer a frame so the loading overlay paints before the (possibly cached)
    // model inference blocks the main thread — same reasoning as runObjectEdit.
    requestAnimationFrame(function () {
      var base = workBase();
      window.bkRegion.facePartMask(base, part).then(function (seg) {
        if (seg && seg.coverage > 0.0005) {
          clearStatus();
          bakeRegionEdit(seg, action, colorObj, 2, function () {
            if (action === "remove") addMsg(tr("aiChatDoneObjectRemove").replace("{obj}", label), "bot");
            else addMsg(tr("aiChatDoneObjectRecolor").replace("{obj}", label).replace("{color}", colorObj.name), "bot");
          });
        } else {
          // No human face found → let the generic detector try (animals etc.).
          clearStatus();
          setBusy(false);
          runObjectEdit(fallbackMatch(part, label), action, colorObj);
        }
      }).catch(function () {
        clearStatus();
        setBusy(false);
        runObjectEdit(fallbackMatch(part, label), action, colorObj);
      });
    });
  }

  // ---- mini-chat (intent-scoped, image-only) ---------------------------

  // Rolling transcript fed back to the LLM for multi-turn context (so "und jetzt
  // heller" after a recolor still makes sense). Capped; only short text, never
  // the image. User bubbles are role "user", bot bubbles role "model".
  var chatHistory = [];

  function addMsg(text, who) {
    chatHistory.push({ role: who === "user" ? "user" : "model", text: String(text) });
    if (chatHistory.length > 12) chatHistory = chatHistory.slice(-12);
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
  // ---- LLM-assisted chat (Gemini via same-origin PHP proxy) ------------
  // The proxy (mu-plugin bk-ai-chat-proxy.php) turns one free-text message into
  // a STRUCTURED image-edit intent. Only the chat TEXT leaves the browser — the
  // photo never does. If the proxy is unreachable, disabled or quota'd, we fall
  // back to routeLocal() so the chat always responds (just less cleverly).
  // Override the endpoint for cross-origin hosting via window.BK_AI_CHAT_ENDPOINT.
  var CHAT_ENDPOINT = (window.BK_AI_CHAT_ENDPOINT || "/wp-json/bk-ai/v1/chat");

  function showTyping() {
    if (!els.chatLog) return null;
    var m = document.createElement("div");
    m.className = "bk-ai-msg bot bk-ai-typing";
    m.textContent = tr("aiChatThinking");
    els.chatLog.appendChild(m);
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
    return m;
  }
  function hideTyping(node) { if (node && node.parentNode) node.parentNode.removeChild(node); }

  // POST the message + recent history (minus the just-echoed current turn) to
  // the proxy. Resolves with a validated intent or rejects so the caller falls
  // back. A short timeout keeps the chat snappy if the network stalls.
  function askLLM(message) {
    if (!window.fetch) return Promise.reject(new Error("no fetch"));
    var ctrl = ("AbortController" in window) ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 12000) : null;
    var history = chatHistory.slice(0, -1).slice(-6); // exclude current user msg
    return fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: message, history: history }),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r.ok) throw new Error("proxy " + r.status);
      return r.json();
    }).then(function (d) {
      if (!d || d.ok !== true || !d.intent || !d.intent.action) throw new Error("bad intent");
      return d.intent;
    });
  }

  // Validate model-returned palette/object names against what the executor can
  // actually act on (returns the canonical word, or null to trigger a fallback).
  function colorWord(name) {
    if (!name) return null;
    var c = detectColor(String(name).toLowerCase());
    return c ? c.name : null;
  }
  function objWord(name) {
    if (!name) return null;
    var o = findObject(String(name).toLowerCase());
    return o ? o.key : null;
  }

  // Turn a structured intent into a canonical German command and run it through
  // routeLocal (the proven executor + replies). Conversational/ambiguous intents
  // are answered directly with the model's German reply. Missing/invalid params
  // fall back to routeLocal(originalText) so the regex parser gets a chance.
  function dispatchIntent(intent, originalText) {
    switch (intent.action) {
      case "remove_background": routeLocal("hintergrund entfernen"); return;
      case "grayscale":         routeLocal("graustufen"); return;
      case "optimize":          routeLocal("optimieren"); return;
      case "brighter":          routeLocal("heller"); return;
      case "darker":            routeLocal("dunkler"); return;
      case "reset":             routeLocal("zuruecksetzen"); return;
      case "help":              addMsg(tr("aiChatGreeting"), "bot"); return;
      case "clarify":           addMsg(intent.reply_de || tr("aiChatGreeting"), "bot"); return;
      case "offtopic":          addMsg(intent.reply_de || tr("aiChatOffTopic"), "bot"); return;
      case "recolor_background": {
        var bgc = colorWord(intent.color || intent.to_color);
        if (!bgc) { routeLocal(originalText); return; }
        routeLocal("hintergrund " + bgc); return;
      }
      case "selective_recolor": {
        var f = colorWord(intent.from_color), t = colorWord(intent.to_color);
        if (!f || !t) { routeLocal(originalText); return; }
        routeLocal("aus " + f + " mach " + t); return;
      }
      case "color_intensity": {
        var ic = colorWord(intent.color);
        if (!ic) { routeLocal(originalText); return; }
        routeLocal((intent.direction === "less" ? "weniger " : "mehr ") + ic); return;
      }
      case "object_recolor": {
        var ot = objWord(intent.target), oc = colorWord(intent.color || intent.to_color);
        if (!ot || !oc) { routeLocal(originalText); return; }
        routeLocal("faerbe " + ot + " " + oc); return;
      }
      case "object_remove": {
        var rt = objWord(intent.target);
        if (!rt) { routeLocal(originalText); return; }
        routeLocal("entferne " + rt); return;
      }
      default: routeLocal(originalText); return;
    }
  }

  // A message that is ONLY a greeting or a "what can you do?" — handled locally
  // so it never spends an LLM round-trip (or free-tier quota). Must match the
  // WHOLE trimmed message: "hallo, mach den hintergrund blau" still carries a
  // real command and falls through to the LLM.
  function isGreetingOnly(text) {
    return /^(hallo|hi|hey|moin|servus|na|guten (tag|morgen|abend)|hilfe|help|was kannst du( so)?|was geht|wie funktioniert( das)?)[\s!?.,]*$/i.test(text);
  }

  // Public chat entry: echo the user, ask the LLM, dispatch — fall back to the
  // offline parser on any proxy failure so the chat always responds.
  function handleChat(raw) {
    var text = (raw || "").trim();
    if (!text) return;
    addMsg(text, "user");
    // Trivial greeting/help → answer locally, skip the network entirely.
    if (isGreetingOnly(text)) { addMsg(tr("aiChatGreeting"), "bot"); return; }
    var typing = showTyping();
    askLLM(text).then(function (intent) {
      hideTyping(typing);
      dispatchIntent(intent, text);
    })["catch"](function () {
      hideTyping(typing);
      routeLocal(text);
    });
  }

  // Offline intent parser (regex/keyword). Serves two roles: (1) the fallback
  // when the LLM proxy is unavailable, and (2) the executor that dispatchIntent
  // feeds canonical commands into. Does NOT echo the user message — the caller
  // already did (or, for canonical reinjection, must not).
  function routeLocal(raw) {
    var text = (raw || "").toLowerCase().trim();
    if (!text) return;

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

    // 2a) Object-targeted edit. If the user names a single object ("der Laptop",
    // "die Haare") and it's NOT a background command, locate that object (DETR /
    // OWL-ViT) and either remove it or recolor it. This runs BEFORE the whole-image
    // colour ops so "färbe den Hund blau" hits the object, not the background.
    var objMatch = findObject(text);
    if (objMatch && !bgWord) {
      var removeWord = /(entfern|wegmach|\bweg\b|\braus\b|l(ö|oe)sch|\bremove\b|\bdelete\b)/.test(text);
      var objColors = detectColorsOrdered(text);
      var recolorWord = /(umf(ä|ae)rb|f(ä|ae)rb|einf(ä|ae)rb|austausch|wechsel|colou?r)/.test(text);
      var recolorWanted = objColors.length >= 1 || colorVerb || recolorWord;
      if (recolorWanted) {
        if (!need()) return;
        var objColor = objColors.length ? objColors[objColors.length - 1].col : detectColor(text);
        if (!objColor) { addMsg(tr("aiChatObjectNeedColor").replace("{obj}", objMatch.key), "bot"); return; }
        // Face parts (eyes/nose/lips/eyebrows) → precise FaceLandmarker mask.
        if (objMatch.entry.face) runFacePartEdit(objMatch.entry.face, objMatch.key, "recolor", objColor);
        else runObjectEdit(objMatch, "recolor", objColor);
        return;
      }
      if (removeWord) {
        if (!need()) return;
        if (objMatch.entry.face) runFacePartEdit(objMatch.entry.face, objMatch.key, "remove", null);
        else runObjectEdit(objMatch, "remove", null);
        return;
      }
      // Object named but no clear action → ask what to do with it.
      addMsg(tr("aiChatObjectAsk").replace(/\{obj\}/g, objMatch.key), "bot");
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
