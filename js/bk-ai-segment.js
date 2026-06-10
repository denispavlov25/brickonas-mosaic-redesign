/*
 * BRICKONAS — ML person segmentation (step 2 background removal)
 * ------------------------------------------------------------------
 * Real on-device AI for "Hintergrund entfernen". Wraps MediaPipe Tasks
 * Vision ImageSegmenter (Selfie Segmenter) — all assets are SELF-HOSTED
 * under js/vendor/mediapipe/ + assets/ml/, so there are zero external
 * hosts and the photo never leaves the browser (GDPR-friendly, no API).
 *
 * Lazy by design: nothing here runs — and not a single byte of the ~9 MB
 * wasm or the model is fetched — until bk-ai-tools.js actually calls
 * segmentPerson() the first time the user removes a background. The rest
 * of the configurator (upload, crop, mosaic) is completely unaffected.
 * Everything is cached by the browser after the first use.
 *
 * Engine note: the Selfie Segmenter is tuned for PEOPLE/portraits — the
 * dominant mosaic subject (family/kids gifts). For non-person photos the
 * mask comes back empty/degenerate; segmentPerson() reports that via
 * `coverage`, and bk-ai-tools.js falls back to the old flood-fill + an
 * honest hint. Public API: window.bkSeg.{ segmentPerson, preload }.
 */
(function () {
  "use strict";

  // Self-hosted asset locations, resolved to ABSOLUTE URLs from this script's own
  // location so they work whether the configurator is served from /mosaik-ai/ or a
  // GitHub Pages subpath — and regardless of whether dynamic import() resolves
  // relative to the document or the script. This file lives in <root>/js/, the model
  // in <root>/assets/ml/, and the wasm in <root>/js/vendor/mediapipe/wasm/.
  var SELF = (document.currentScript && document.currentScript.src) || (location.origin + "/js/");
  function asset(rel) { return new URL(rel, SELF).href; }
  var BUNDLE = asset("vendor/mediapipe/vision_bundle.mjs");
  var WASM_DIR = asset("vendor/mediapipe/wasm");
  var MODEL = asset("../assets/ml/selfie_segmenter.tflite");

  var segmenterPromise = null; // memoized loader → model downloads at most once

  // Load (and cache) the ImageSegmenter. Tries the GPU (WebGL) delegate first
  // and transparently falls back to CPU if the browser/driver can't provide it.
  function loadSegmenter() {
    if (segmenterPromise) return segmenterPromise;
    segmenterPromise = (function () {
      return import(BUNDLE).then(function (mod) {
        var FilesetResolver = mod.FilesetResolver;
        var ImageSegmenter = mod.ImageSegmenter;
        return FilesetResolver.forVisionTasks(WASM_DIR).then(function (fileset) {
          function create(delegate) {
            return ImageSegmenter.createFromOptions(fileset, {
              baseOptions: { modelAssetPath: MODEL, delegate: delegate },
              runningMode: "IMAGE",
              outputCategoryMask: false,
              outputConfidenceMasks: true
            });
          }
          return create("GPU").catch(function () { return create("CPU"); });
        });
      });
    })();
    // If loading fails, allow a later retry instead of caching the rejection.
    segmenterPromise.catch(function () { segmenterPromise = null; });
    return segmenterPromise;
  }

  // Segment the foreground (person) out of `canvas`.
  // Resolves with { mask: Uint8Array(w*h; 1 = keep/foreground, 0 = background),
  // w, h, coverage } where coverage is the foreground fraction (0..1). Rejects
  // if the model can't load. The mask is aligned to the input canvas size.
  function segmentPerson(canvas) {
    return loadSegmenter().then(function (seg) {
      var res = seg.segment(canvas);
      var cm = res.confidenceMasks && res.confidenceMasks[0];
      if (!cm) {
        if (res.close) res.close();
        throw new Error("no confidence mask");
      }
      var w = cm.width, h = cm.height;
      var f = cm.getAsFloat32Array();
      var mask = new Uint8Array(w * h);
      var fg = 0;
      for (var i = 0; i < f.length; i++) {
        var v = f[i] >= 0.5 ? 1 : 0;
        mask[i] = v;
        fg += v;
      }
      if (cm.close) cm.close();
      if (res.close) res.close();
      return { mask: mask, w: w, h: h, coverage: f.length ? fg / f.length : 0 };
    });
  }

  window.bkSeg = { segmentPerson: segmentPerson, preload: loadSegmenter };
})();
