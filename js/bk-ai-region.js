/*
 * BRICKONAS — on-device region tools (step 2 precise editing)
 * ------------------------------------------------------------------
 * Two complementary, fully in-browser features that the coarse OWL-ViT
 * object detector can't do well:
 *
 *   1. floodSelect(canvas, nx, ny, tol)  — "magic wand": the user taps a
 *      spot and we flood-fill the CONTIGUOUS patch of similarly coloured
 *      pixels around it (a dog's black nose, one flower petal, a patch of
 *      sky …). Unlike a whole-object segmenter, this isolates a small
 *      detail — tapping a nose selects the nose, not the whole dog — and
 *      a tolerance slider lets the user grow/shrink the selection. Pure
 *      pixel math: instant, deterministic, no model download.
 *
 *   2. facePartMask(canvas, part)      — precise eyes / nose / lips /
 *      eyebrows mask from MediaPipe FaceLandmarker's 468 landmarks, for
 *      the most common mosaic subject: human portraits.
 *
 * facePartMask reuses the SAME self-hosted MediaPipe vision bundle + wasm
 * already shipped for the selfie segmenter (js/vendor/mediapipe/), so
 * there are zero external hosts and the photo never leaves the browser.
 * The only new bytes are the face model under assets/ml/, lazy-loaded the
 * first time a face-part edit runs (nothing downloads otherwise).
 *
 * Public API: window.bkRegion.{ floodSelect, facePartMask, preload }.
 */
(function () {
  "use strict";

  // Resolve self-hosted assets to ABSOLUTE URLs from this script's own
  // location (works under /mosaik-ai/ or a GitHub Pages subpath). Mirrors
  // bk-ai-segment.js so both modules agree on where the wasm/models live.
  var SELF = (document.currentScript && document.currentScript.src) || (location.origin + "/js/");
  function asset(rel) { return new URL(rel, SELF).href; }
  var BUNDLE = asset("vendor/mediapipe/vision_bundle.mjs");
  var WASM_DIR = asset("vendor/mediapipe/wasm");
  var FACE_MODEL = asset("../assets/ml/face_landmarker.task");

  var bundlePromise = null; // the vision bundle ESM, loaded at most once
  function loadBundle() {
    if (!bundlePromise) bundlePromise = import(BUNDLE);
    bundlePromise.catch(function () { bundlePromise = null; });
    return bundlePromise;
  }

  // ---- magic-wand flood fill (tap-to-select a detail) ------------------
  // Select the contiguous run of pixels around (nx, ny in 0..1) whose colour
  // is within `tol` (euclidean RGB distance) of the tapped colour. Returns
  // { mask: Uint8Array(w*h; 1 = selected), w, h, coverage }. Runs on a copy
  // downscaled to <=maxDim px (the mosaic re-quantises the result anyway), so
  // even a large photo selects in a few ms with no jank.
  function floodSelect(canvas, nx, ny, tol) {
    var maxDim = 480;
    var sw = canvas.width, sh = canvas.height;
    var scale = Math.min(1, maxDim / Math.max(sw, sh));
    var w = Math.max(1, Math.round(sw * scale));
    var h = Math.max(1, Math.round(sh * scale));
    var cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    var ctx = cv.getContext("2d");
    ctx.drawImage(canvas, 0, 0, w, h);
    var d = ctx.getImageData(0, 0, w, h).data;

    var sx = Math.min(w - 1, Math.max(0, Math.round(nx * w)));
    var sy = Math.min(h - 1, Math.max(0, Math.round(ny * h)));

    // Seed = average of a 3×3 neighbourhood so a single noisy pixel doesn't
    // throw the colour match off.
    var sr = 0, sg = 0, sb = 0, sc = 0, dx, dy, xx, yy, p;
    for (dy = -1; dy <= 1; dy++) {
      for (dx = -1; dx <= 1; dx++) {
        xx = sx + dx; yy = sy + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        p = (yy * w + xx) * 4; sr += d[p]; sg += d[p + 1]; sb += d[p + 2]; sc++;
      }
    }
    sr /= sc; sg /= sc; sb /= sc;

    var tol2 = tol * tol;
    var mask = new Uint8Array(w * h);
    var seed = sy * w + sx;
    var stack = [seed];
    mask[seed] = 1;
    var fg = 0;
    while (stack.length) {
      var idx = stack.pop();
      fg++;
      var x = idx % w, y = (idx / w) | 0;
      var nb;
      // 4-connectivity keeps the selection tight (no diagonal colour bleed).
      for (var n = 0; n < 4; n++) {
        if (n === 0) { if (x === 0) continue; nb = idx - 1; }
        else if (n === 1) { if (x === w - 1) continue; nb = idx + 1; }
        else if (n === 2) { if (y === 0) continue; nb = idx - w; }
        else { if (y === h - 1) continue; nb = idx + w; }
        if (mask[nb]) continue;
        var q = nb * 4;
        var er = d[q] - sr, eg = d[q + 1] - sg, eb = d[q + 2] - sb;
        if (er * er + eg * eg + eb * eb <= tol2) { mask[nb] = 1; stack.push(nb); }
      }
    }
    return { mask: mask, w: w, h: h, coverage: fg / (w * h) };
  }

  // ---- FaceLandmarker (face-part masks) --------------------------------
  var facePromise = null;
  function loadFace() {
    if (facePromise) return facePromise;
    facePromise = loadBundle().then(function (mod) {
      return mod.FilesetResolver.forVisionTasks(WASM_DIR).then(function (fileset) {
        function create(delegate) {
          return mod.FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: FACE_MODEL, delegate: delegate },
            runningMode: "IMAGE",
            numFaces: 1,
            outputFaceBlendshapes: false,
            outputFacialTransformationMatrixes: false
          });
        }
        return create("GPU").catch(function () { return create("CPU"); });
      });
    });
    facePromise.catch(function () { facePromise = null; });
    return facePromise;
  }

  // Canonical MediaPipe FaceMesh landmark indices per region. We fill the
  // CONVEX HULL of each point set — for eyes/eyebrows/nose that is the
  // region itself; for lips we fill the outer-lip ring (both lips). Combined
  // "augen"/"augenbrauen" use both sides.
  var FACE_PARTS = {
    rightEye: [33, 7, 163, 144, 145, 153, 154, 155, 133, 246, 161, 160, 159, 158, 157, 173],
    leftEye: [263, 249, 390, 373, 374, 380, 381, 382, 362, 466, 388, 387, 386, 385, 384, 398],
    rightBrow: [46, 53, 52, 65, 55, 70, 63, 105, 66, 107],
    leftBrow: [276, 283, 282, 295, 285, 300, 293, 334, 296, 336],
    lips: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185],
    nose: [168, 6, 197, 195, 5, 4, 1, 19, 94, 2, 98, 97, 326, 327, 129, 358, 49, 279, 45, 275, 220, 440]
  };
  // German part name → which index groups to union.
  var PART_GROUPS = {
    eyes: ["leftEye", "rightEye"],
    nose: ["nose"],
    lips: ["lips"],
    eyebrows: ["leftBrow", "rightBrow"]
  };

  // Andrew's monotone-chain convex hull of [{x,y}] → ordered hull points.
  function convexHull(pts) {
    if (pts.length < 3) return pts.slice();
    var p = pts.slice().sort(function (a, b) { return a.x - b.x || a.y - b.y; });
    function cross(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }
    var lo = [], i;
    for (i = 0; i < p.length; i++) {
      while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p[i]) <= 0) lo.pop();
      lo.push(p[i]);
    }
    var up = [];
    for (i = p.length - 1; i >= 0; i--) {
      while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p[i]) <= 0) up.pop();
      up.push(p[i]);
    }
    lo.pop(); up.pop();
    return lo.concat(up);
  }

  // Build a w*h binary mask by filling the convex-hull polygons of the
  // requested face-part groups. Uses a scratch canvas + 2D fill (fast,
  // exact) then reads the alpha channel back as the mask.
  function buildPartMask(landmarks, groups, w, h) {
    var cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    var ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff";
    var drew = false;
    for (var g = 0; g < groups.length; g++) {
      var ids = FACE_PARTS[groups[g]];
      if (!ids) continue;
      var pts = [];
      for (var k = 0; k < ids.length; k++) {
        var lm = landmarks[ids[k]];
        if (lm) pts.push({ x: lm.x * w, y: lm.y * h });
      }
      var hull = convexHull(pts);
      if (hull.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(hull[0].x, hull[0].y);
      for (var j = 1; j < hull.length; j++) ctx.lineTo(hull[j].x, hull[j].y);
      ctx.closePath();
      ctx.fill();
      drew = true;
    }
    if (!drew) return null;
    var data = ctx.getImageData(0, 0, w, h).data;
    var mask = new Uint8Array(w * h), fg = 0;
    for (var i = 0; i < mask.length; i++) { var v = data[i * 4 + 3] > 0 ? 1 : 0; mask[i] = v; fg += v; }
    return { mask: mask, w: w, h: h, coverage: mask.length ? fg / mask.length : 0 };
  }

  // Colour-gated grow ("smart dilation"). Extends `mask` outward, but only into
  // neighbouring pixels whose colour is within `tol` (euclidean RGB) of the
  // AVERAGE colour already inside the mask. This catches make-up overdrawn past
  // the anatomical landmarks — e.g. lipstick painted beyond the lip line — while
  // stopping dead at the skin, which is a different colour. Without it a "lips
  // blue" edit only recolours the convex-hull centre and leaves a red rim.
  // Bounded to `iterations` one-pixel rings so it can't run away into the face.
  function growMaskByColor(data, w, h, mask, tol, iterations) {
    var sr = 0, sg = 0, sb = 0, n = 0, i, q;
    for (i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      q = i * 4; sr += data[q]; sg += data[q + 1]; sb += data[q + 2]; n++;
    }
    if (!n) return mask;
    sr /= n; sg /= n; sb /= n;
    var tol2 = tol * tol;
    var cur = mask;
    for (var it = 0; it < iterations; it++) {
      var next = cur.slice();
      var changed = false;
      for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
          var idx = y * w + x;
          if (cur[idx]) continue;
          var hasN = (x > 0 && cur[idx - 1]) || (x < w - 1 && cur[idx + 1]) ||
                     (y > 0 && cur[idx - w]) || (y < h - 1 && cur[idx + w]);
          if (!hasN) continue;
          q = idx * 4;
          var er = data[q] - sr, eg = data[q + 1] - sg, eb = data[q + 2] - sb;
          if (er * er + eg * eg + eb * eb <= tol2) { next[idx] = 1; changed = true; }
        }
      }
      cur = next;
      if (!changed) break;
    }
    return cur;
  }

  // Precise mask for a named face part on a HUMAN face. Resolves the mask
  // object, or null when no face is found (caller falls back / explains).
  // `part` is one of: "eyes", "nose", "lips", "eyebrows".
  function facePartMask(canvas, part) {
    var groups = PART_GROUPS[part];
    if (!groups) return Promise.resolve(null);
    return loadFace().then(function (fl) {
      var res = fl.detect(canvas);
      var faces = res && res.faceLandmarks;
      if (!faces || !faces.length) return null;
      // Build the mask at a capped resolution. FaceLandmarker coords are
      // normalised (0..1), so the hull is resolution-independent — we can
      // rasterise small for a fast colour-grow and let the caller upsample.
      var maxDim = 512;
      var scale = Math.min(1, maxDim / Math.max(canvas.width, canvas.height));
      var w = Math.max(1, Math.round(canvas.width * scale));
      var h = Math.max(1, Math.round(canvas.height * scale));
      var seg = buildPartMask(faces[0], groups, w, h);
      if (!seg) return null;
      // Grab a matching downscaled colour buffer and grow the mask into
      // same-coloured neighbours (catches overdrawn make-up; stops at skin).
      var cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      var ctx = cv.getContext("2d");
      ctx.drawImage(canvas, 0, 0, w, h);
      var data = ctx.getImageData(0, 0, w, h).data;
      var iterations = Math.max(4, Math.round(Math.max(w, h) * 0.03));
      seg.mask = growMaskByColor(data, w, h, seg.mask, 52, iterations);
      var fg = 0;
      for (var i = 0; i < seg.mask.length; i++) fg += seg.mask[i];
      seg.coverage = seg.mask.length ? fg / seg.mask.length : 0;
      return seg;
    });
  }

  // Optional warm-up so the first real use feels instant. Never throws.
  function preload(which) {
    try {
      if (which === "face") return loadFace();
    } catch (e) {}
    return Promise.resolve();
  }

  window.bkRegion = {
    floodSelect: floodSelect,
    facePartMask: facePartMask,
    preload: preload
  };
})();
