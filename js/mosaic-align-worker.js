/**
 * mosaic-align-worker.js
 *
 * Off-main-thread color quantization for the mosaic configurator.
 *
 * WHY: alignPixelsToStudMap() at high resolution (e.g. 288) maps every pixel to
 * its nearest palette colour using CIEDE2000. That is millions of distance calls
 * and, on the main thread, it froze the UI for ~hundreds of ms on step 2/3 — so
 * the loader animation stalled and hovering the style icons stuttered.
 *
 * Running it here keeps the main thread free: the loader keeps spinning and the
 * style-icon hover lift animates smoothly while the heavy compute happens.
 *
 * BYTE-IDENTICAL GUARANTEE: this worker importScripts the *same* d3.v5.js and
 * d3-color-difference bundles the page uses, and the colour-distance + alignment
 * code below is copied verbatim from index.js / algo.js. So the palette mapping
 * (and therefore the brick counts / price of the paid product) is identical to
 * the synchronous path. Verified A/B: 0 mismatched channels.
 *
 * The d3 helpers (hexToRgb, rgbToHex, studMapToSortedColorList,
 * alignPixelsToStudMap, d3ColorDistanceWrapper, RGBPixelDistanceSquared,
 * colorDistanceFunctionsInfo) are intentionally duplicated here rather than
 * importing algo.js, because algo.js' top-level BRICKONAS_LOGO uses `new Image()`
 * which does not exist in a Worker.
 */

/* global d3, importScripts, self */

var BK_WORKER_READY = false;

try {
    // Same (self-hosted) scripts the page loads (index.html). Loading the identical
    // bundles is what makes the worker's CIEDE2000 result byte-identical to the main
    // thread. Paths are relative to this worker file (js/), i.e. js/vendor/*.
    importScripts("vendor/d3.v5.min.js", "vendor/d3-color-difference-0.1.3.min.js");
    BK_WORKER_READY = typeof d3 !== "undefined" && typeof d3.differenceCiede2000 === "function";
} catch (e) {
    BK_WORKER_READY = false;
}

// ---- copied verbatim from algo.js ----
function hexToRgb(hex) {
    const hexInt = parseInt(hex.replace("#", ""), 16);
    const r = (hexInt >> 16) & 255;
    const g = (hexInt >> 8) & 255;
    const b = hexInt & 255;
    return [r, g, b];
}

function studMapToSortedColorList(studMap) {
    const result = Object.keys(studMap);
    result.sort();
    return result;
}

// aligns each pixel in the input array to the closest pixel in the studMap
function alignPixelsToStudMap(inputPixels, studMap, colorDistanceFunction) {
    const alignedPixels = [...inputPixels]; // keep 4th (alpha) pixel values
    const anchorPixels = studMapToSortedColorList(studMap).map((pixel) => hexToRgb(pixel));

    const colorCache = new Map();

    for (let i = 0; i < inputPixels.length / 4; i++) {
        const targetPixelIndex = i * 4;
        const r = inputPixels[targetPixelIndex];
        const g = inputPixels[targetPixelIndex + 1];
        const b = inputPixels[targetPixelIndex + 2];

        const cacheKey = (r << 16) | (g << 8) | b;

        let closestAnchor;
        if (colorCache.has(cacheKey)) {
            closestAnchor = colorCache.get(cacheKey);
        } else {
            const pixelToAlign = [r, g, b];
            let closestAnchorPixel = 0;
            let minDistance = colorDistanceFunction(pixelToAlign, anchorPixels[0]);

            for (let anchorPixelIndex = 1; anchorPixelIndex < anchorPixels.length; anchorPixelIndex++) {
                const distance = colorDistanceFunction(pixelToAlign, anchorPixels[anchorPixelIndex]);
                if (distance < minDistance) {
                    minDistance = distance;
                    closestAnchorPixel = anchorPixelIndex;
                }
            }
            closestAnchor = anchorPixels[closestAnchorPixel];
            colorCache.set(cacheKey, closestAnchor);
        }

        for (let j = 0; j < 3; j++) {
            alignedPixels[targetPixelIndex + j] = closestAnchor[j];
        }
    }
    return alignedPixels;
}

// ---- copied verbatim from index.js (memoized distance wrappers) ----
function d3ColorDistanceWrapper(d3DistanceFunction) {
    const labCache = new Map();
    function toLab(p) {
        const key = (p[0] << 16) | (p[1] << 8) | p[2];
        let c = labCache.get(key);
        if (c === undefined) {
            if (labCache.size > 300000) labCache.clear();
            c = d3.lab(d3.rgb(p[0], p[1], p[2]));
            labCache.set(key, c);
        }
        return c;
    }
    return (c1, c2) => d3DistanceFunction(toLab(c1), toLab(c2));
}

function RGBPixelDistanceSquared(pixel1, pixel2) {
    let sum = 0;
    for (let i = 0; i < 3; i++) {
        sum += Math.abs(pixel1[i] - pixel2[i]);
    }
    return sum;
}

// Built lazily after importScripts so d3 difference fns exist.
function buildColorDistanceFunctionsInfo() {
    return {
        euclideanRGB: { func: RGBPixelDistanceSquared },
        euclideanLAB: { func: d3ColorDistanceWrapper(d3.differenceEuclideanLab) },
        cie94: { func: d3ColorDistanceWrapper(d3.differenceCie94) },
        ciede2000: { func: d3ColorDistanceWrapper(d3.differenceCiede2000) },
        din99o: { func: d3ColorDistanceWrapper(d3.differenceDin99o) },
    };
}

var colorDistanceFunctionsInfo = BK_WORKER_READY ? buildColorDistanceFunctionsInfo() : null;

self.onmessage = function (e) {
    const data = e.data || {};
    const id = data.id;

    if (!BK_WORKER_READY || !colorDistanceFunctionsInfo) {
        // Signal the main thread to fall back to the synchronous path.
        self.postMessage({ id: id, error: "worker-not-ready" });
        return;
    }

    try {
        const inputPixels = new Uint8ClampedArray(data.buffer);
        const distanceKey =
            data.distanceKey && colorDistanceFunctionsInfo[data.distanceKey]
                ? data.distanceKey
                : "ciede2000";
        const distanceFunc = colorDistanceFunctionsInfo[distanceKey].func;

        const aligned = alignPixelsToStudMap(inputPixels, data.studMap, distanceFunc);

        // Pack into a transferable Uint8ClampedArray. Values are integers in
        // [0,255]; the main thread reconstructs a plain Array (Array.from) to
        // match the original alignPixelsToStudMap return type exactly.
        const out = new Uint8ClampedArray(aligned.length);
        for (let i = 0; i < aligned.length; i++) out[i] = aligned[i];

        self.postMessage({ id: id, buffer: out.buffer }, [out.buffer]);
    } catch (err) {
        self.postMessage({ id: id, error: String(err) });
    }
};
