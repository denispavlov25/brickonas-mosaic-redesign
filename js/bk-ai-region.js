/*
 * BRICKONAS — on-device region tools (step 2 precise editing)
 * ------------------------------------------------------------------
 * Two complementary, fully in-browser features that the coarse OWL-ViT
 * object detector can't do well:
 *
 *   1. segmentAtPoint(canvas, nx, ny)  — "magic touch": the user taps a
 *      spot and MediaPipe InteractiveSegmenter returns a pixel mask of
 *      whatever object sits under that point (a dog's nose, a single
 *      flower, a patch of sky …). Works on ANY photo, not just faces.
 *
 *   2. facePartMask(canvas, part)      — precise eyes / nose / lips /
 *      eyebrows mask from MediaPipe FaceLandmarker's 468 landmarks, for
 *      the most common mosaic subject: human portraits.
 *
 * Both reuse the SAME self-hosted MediaPipe vision bundle + wasm already
 * shipped for the selfie segmenter (js/vendor/mediapipe/), so there are
 * zero external hosts and the photo never leaves the browser. The only
 * new bytes are the two model files under assets/ml/, each lazy-loaded
 * the first time its feature is used (nothing downloads otherwise).
 *
 * Public API: window.bkRegion.{ segmentAtPoint, facePartMask, preload }.
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
  var TOUCH_MODEL = asset("../assets/ml/magic_touch.tflite");
  var FACE_MODEL = asset("../assets/ml/face_landmarker.task");

  var bundlePromise = null; // the vision bundle ESM, loaded at most once
  function loadBundle() {
    if (!bundlePromise) bundlePromise = import(BUNDLE);
    bundlePromise.catch(function () { bundlePromise = null; });
    return bundlePromise;
  }

  // ---- InteractiveSegmenter (tap-to-segment) ---------------------------
  var touchPromise = null;
  function loadTouch() {
    if (touchPromise) return touchPromise;
    touchPromise = loadBundle().then(function (mod) {
      return mod.FilesetResolver.forVisionTasks(WASM_DIR).then(function (fileset) {
        function create(delegate) {
          return mod.InteractiveSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: TOUCH_MODEL, delegate: delegate },
            outputCategoryMask: false,
            outputConfidenceMasks: true
          });
        }
        return create("GPU").catch(function () { return create("CPU"); });
      });
    });
    touchPromise.catch(function () { touchPromise = null; });
    return touchPromise;
  }

  // Segment the object under the normalized point (nx, ny in 0..1).
  // Resolves { mask: Uint8Array(w*h; 1 = selected), w, h, coverage }.
  function segmentAtPoint(canvas, nx, ny) {
    return loadTouch().then(function (seg) {
      var res = seg.segment(canvas, { keypoint: { x: nx, y: ny } });
      var cm = res.confidenceMasks && res.confidenceMasks[0];
      if (!cm) { if (res.close) res.close(); throw new Error("no confidence mask"); }
      var w = cm.width, h = cm.height;
      var f = cm.getAsFloat32Array();
      var mask = new Uint8Array(w * h), fg = 0;
      for (var i = 0; i < f.length; i++) { var v = f[i] >= 0.5 ? 1 : 0; mask[i] = v; fg += v; }
      if (cm.close) cm.close();
      if (res.close) res.close();
      return { mask: mask, w: w, h: h, coverage: f.length ? fg / f.length : 0 };
    });
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
  // region itself; for lips it spans both lips (exactly what a recolor
  // wants). Combined "augen"/"augenbrauen" use both sides.
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
      return buildPartMask(faces[0], groups, canvas.width, canvas.height);
    });
  }

  // Optional warm-up so the first real use feels instant. Never throws.
  function preload(which) {
    try {
      if (which === "face") return loadFace();
      if (which === "touch") return loadTouch();
    } catch (e) {}
    return Promise.resolve();
  }

  window.bkRegion = {
    segmentAtPoint: segmentAtPoint,
    facePartMask: facePartMask,
    preload: preload
  };
})();
