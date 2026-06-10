const VERSION_NUMBER = "v2022.12.11";

let perfLoggingDatabase;

function incrementTransaction(count) {
    return (count || 0) + 1;
}

// Debounce utility function for performance optimization
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Debounce delay in milliseconds
const DEBOUNCE_DELAY = 150;

const LOW_DPI = 48;
const HIGH_DPI = 96;

const interactionSelectors = [
    "input-image-selector",
    "input-image-selector-hidden",
    "mix-in-stud-map-button",
    "width-slider",
    "height-slider",
    "hue-slider",
    "saturation-slider",
    "value-slider",
    "reset-hsv-button",
    "reset-brightness-button",
    "reset-contrast-button",
    "download-instructions-button",
    "add-custom-stud-button",
    "export-stud-map-button",
    "import-stud-map-file-input",
    "bricklink-piece-button",
    "clear-overrides-button",
    "clear-custom-studs-button",
    "infinite-piece-count-check",
    "high-quality-instructions-check",
    "input-depth-image-selector",
    "num-depth-levels-slider",
    "download-depth-instructions-button",
    "high-quality-depth-instructions-check",
    "export-depth-to-bricklink-button",
].map((id) => document.getElementById(id)).filter(Boolean);

const customStudTableBody = document.getElementById("custom-stud-table-body");

var _isRunningStepProcessing = false;
let _loadingSpinnerTimeout = null;

const BK_LOADER_DEFAULT_TITLE = "Dein Mosaik wird berechnet…";
const BK_LOADER_DEFAULT_SUB = "Bei hoher Auflösung kann das einen Moment dauern.";

// Update the text shown inside the loading overlay card.
function setLoadingMessage(title, sub) {
    const titleEl = document.getElementById("loading-overlay-title");
    const subEl = document.getElementById("loading-overlay-sub");
    if (titleEl) titleEl.innerHTML = title != null ? title : BK_LOADER_DEFAULT_TITLE;
    if (subEl) subEl.innerHTML = sub != null ? sub : BK_LOADER_DEFAULT_SUB;
}

// Build loader options based on the current resolution. For large mosaics the
// quantization/dithering blocks the main thread for a noticeable time, so we
// show the loader IMMEDIATELY (and paint it before computing). For small
// resolutions the work finishes in a few ms, so we keep the loader hidden via
// a short delay and never flash it.
function bkLoaderOptsForResolution() {
    const area = targetResolution[0] * targetResolution[1];
    const heavy = area >= 96 * 96; // ~9k+ studs (e.g. 96x96, 144x144, 288x288)
    return {
        immediate: heavy,
        title: BK_LOADER_DEFAULT_TITLE,
        sub: heavy
            ? "Bei dieser Auflösung dauert das ein paar Sekunden – bitte kurz warten."
            : BK_LOADER_DEFAULT_SUB,
    };
}

// Let the browser paint the loading overlay before running heavy synchronous
// work. A double rAF guarantees the "show-spinner" style change is committed
// and painted before the blocking compute starts, so the user always sees the
// loader during the freeze (instead of a frozen page with nothing happening).
function bkPaintThenRun(fn) {
    requestAnimationFrame(function () {
        requestAnimationFrame(fn);
    });
}

function disableInteraction(opts) {
    opts = opts || {};
    interactionSelectors.forEach((button) => { if (button) button.disabled = true; });
    [...document.getElementsByTagName("input")].forEach((button) => (button.disabled = true));
    [...document.getElementsByClassName("btn")].forEach((button) => (button.disabled = true));
    [...document.getElementsByClassName("nav-link")].forEach((link) => (link.className = link.className + " disabled"));
    document.getElementById("universal-loading-progress").hidden = false;
    document.getElementById("universal-loading-progress-complement").hidden = true;
    const overlay = document.getElementById("loading-overlay");
    setLoadingMessage(opts.title, opts.sub);
    overlay.classList.remove("hidden");
    if (_loadingSpinnerTimeout) { clearTimeout(_loadingSpinnerTimeout); _loadingSpinnerTimeout = null; }
    if (opts.immediate) {
        // Heavy op: show the loader INSTANTLY at full opacity (bk-instant kills the
        // fade-in transition) so it is fully painted before the main-thread freeze.
        // A reflow commits the style, then the double-rAF in bkPaintThenRun gives the
        // browser one clean paint of the opaque loader before the compute blocks.
        overlay.classList.add("bk-instant");
        void overlay.offsetWidth;
        overlay.classList.add("show-spinner");
    } else {
        // Light op: only reveal the loader if it ends up taking longer than a
        // few hundred ms, so quick slider tweaks never flash it.
        overlay.classList.remove("bk-instant");
        overlay.classList.remove("show-spinner");
        _loadingSpinnerTimeout = setTimeout(function () {
            if (!overlay.classList.contains("hidden")) {
                overlay.classList.add("show-spinner");
            }
        }, 350);
    }
    if (inputImageCropper != null) {
        inputImageCropper.disable();
    }
}

function enableInteraction() {
    interactionSelectors.forEach((button) => { if (button) button.disabled = false; });
    [...document.getElementsByTagName("input")].forEach((button) => {
        button.disabled = button.className.includes("always-disabled");
    });
    [...document.getElementsByClassName("btn")].forEach((button) => (button.disabled = false));
    [...document.getElementsByClassName("nav-link")].forEach(
        (link) => (link.className = link.className.replace(/ disabled/g, ""))
    );
    document.getElementById("universal-loading-progress").hidden = true;
    document.getElementById("universal-loading-progress-complement").hidden = false;
    const overlay = document.getElementById("loading-overlay");
    overlay.classList.add("hidden");
    overlay.classList.remove("show-spinner");
    overlay.classList.remove("bk-instant");
    if (_loadingSpinnerTimeout) {
        clearTimeout(_loadingSpinnerTimeout);
        _loadingSpinnerTimeout = null;
    }
    if (inputImageCropper != null) {
        inputImageCropper.enable();
    }
}

if (window.location.href.includes("forceUnsupportedDimensions")) {
    ["height-slider", "width-slider"].forEach((id) => {
        document.getElementById(id).step = 1;
        document.getElementById(id).type = "number";
    });
}

const CNN_INPUT_IMAGE_WIDTH = 256;
const CNN_INPUT_IMAGE_HEIGHT = 256;

let inputImage = null;

const inputCanvas = document.getElementById("input-canvas");
const inputCanvasContext = inputCanvas.getContext("2d");
const inputDepthCanvas = document.getElementById("input-depth-canvas");
const inputDepthCanvasContext = inputDepthCanvas.getContext("2d");

const webWorkerInputCanvas = document.getElementById("web-worker-input-canvas");
const webWorkerInputCanvasContext = webWorkerInputCanvas.getContext("2d");
const webWorkerOutputCanvas = document.getElementById("web-worker-output-canvas");
const webWorkerOutputCanvasContext = webWorkerOutputCanvas.getContext("2d");

const step1CanvasUpscaled = document.getElementById("step-1-canvas-upscaled");
const step1CanvasUpscaledContext = step1CanvasUpscaled.getContext("2d");
const step1DepthCanvasUpscaled = document.getElementById("step-1-depth-canvas-upscaled");
const step1DepthCanvasUpscaledContext = step1DepthCanvasUpscaled.getContext("2d");

const step2Canvas = document.getElementById("step-2-canvas");
const step2CanvasContext = step2Canvas.getContext("2d");
const step2CanvasUpscaled = document.getElementById("step-2-canvas-upscaled");
const step2CanvasUpscaledContext = step2CanvasUpscaled.getContext("2d");
const step2DepthCanvas = document.getElementById("step-2-depth-canvas");
const step2DepthCanvasContext = step2DepthCanvas.getContext("2d");
const step2DepthCanvasUpscaled = document.getElementById("step-2-depth-canvas-upscaled");
const step2DepthCanvasUpscaledContext = step2DepthCanvasUpscaled.getContext("2d");

const step3Canvas = document.getElementById("step-3-canvas");
const step3CanvasContext = step3Canvas.getContext("2d");
const step3CanvasUpscaled = document.getElementById("step-3-canvas-upscaled");
const step3CanvasUpscaledContext = step3CanvasUpscaled.getContext("2d");
const step3DepthCanvas = document.getElementById("step-3-depth-canvas");
const step3DepthCanvasContext = step3DepthCanvas.getContext("2d");
const step3DepthCanvasUpscaled = document.getElementById("step-3-depth-canvas-upscaled");
const step3DepthCanvasUpscaledContext = step3DepthCanvasUpscaled.getContext("2d");

const step4Canvas = document.getElementById("step-4-canvas");
const step4CanvasContext = step4Canvas.getContext("2d");
const step4CanvasUpscaled = document.getElementById("step-4-canvas-upscaled");
const step4CanvasUpscaledContext = step4CanvasUpscaled.getContext("2d");
const step4Canvas3dUpscaled = document.getElementById("step-4-canvas-3d-upscaled");

const bricklinkCacheCanvas = document.getElementById("bricklink-cache-canvas");

let targetResolution = [
    Number(document.getElementById("width-slider").value),
    Number(document.getElementById("height-slider").value),
];
const PIXEL_WIDTH_CM = 0.8;
const INCHES_IN_CM = 0.393701;
const BASE_SCALING_FACTOR = 40;
const MAX_CANVAS_DIMENSION = 4096; // Safe for all browsers including mobile

function getScalingFactor(width, height) {
    const maxDimension = Math.max(width, height);
    const maxAllowedFactor = Math.floor(MAX_CANVAS_DIMENSION / maxDimension);
    return Math.max(1, Math.min(BASE_SCALING_FACTOR, maxAllowedFactor));
}

// PERF: the on-screen step-3 editing canvas is shown at ~480 CSS px, yet at high
// resolution SCALING_FACTOR produced a 4032×4032 (16 MP) backing store. Drawing
// that with drawStudImageOnCanvas was a ~150 ms main-thread block on every style
// change, and a 16 MP canvas layer is brutal for the compositor to repaint on
// scroll/hover — exactly the "freeze after the loader" and "lag on scroll" the
// customer reported. The studs are sub-pixel at that zoom anyway, so the extra
// resolution is invisible.
//
// We therefore display the editing canvas at a capped resolution
// (DISPLAY_SCALING_FACTOR, ≤ MAX_DISPLAY_CANVAS_DIMENSION px). The full-resolution
// SCALING_FACTOR is still used for step 4 / the instruction PDF source
// (step4CanvasUpscaled feeds PIXI), so export quality is unchanged. Low
// resolutions (≤40 studs) are untouched because they were never the problem.
const MAX_DISPLAY_CANVAS_DIMENSION = 2000;

function getDisplayScalingFactor(width, height) {
    const maxDimension = Math.max(width, height);
    const maxAllowedFactor = Math.floor(MAX_DISPLAY_CANVAS_DIMENSION / maxDimension);
    const full = getScalingFactor(width, height);
    return Math.max(1, Math.min(full, maxAllowedFactor));
}

let SCALING_FACTOR = getScalingFactor(targetResolution[0], targetResolution[1]);
let DISPLAY_SCALING_FACTOR = getDisplayScalingFactor(targetResolution[0], targetResolution[1]);

// Plate dimensions in studs - updated dynamically based on step selectors
let PLATE_WIDTH = 48;  // width step (plate width in studs)
let PLATE_HEIGHT = 48; // height step (plate height in studs)

function updatePlateDimensions() {
    PLATE_WIDTH = parseInt(document.getElementById("width-step-select").value);
    PLATE_HEIGHT = parseInt(document.getElementById("height-step-select").value);
}

document.getElementById("width-text").title = `${(targetResolution[0] * PIXEL_WIDTH_CM).toFixed(1)} cm`;
document.getElementById("height-text").title = `${(targetResolution[1] * PIXEL_WIDTH_CM).toFixed(1)} cm`;

let inputImageCropper;

function initializeCropper() {
    if (inputImageCropper != null) {
        inputImageCropper.destroy();
    }
    inputImageCropper = new Cropper(step1CanvasUpscaled, {
        aspectRatio: targetResolution[0] / targetResolution[1],
        viewMode: 1,
        minContainerWidth: 1,
        minContainerHeight: 1,
        zoomable: false,
        cropend() {
            overridePixelArray = new Array(targetResolution[0] * targetResolution[1] * 4).fill(null);
            overrideDepthPixelArray = new Array(targetResolution[0] * targetResolution[1] * 4).fill(null);
        },
    });
}

step1CanvasUpscaled.addEventListener("cropend", runStep1);

window.addEventListener("resize", () => {
    [step4Canvas].forEach((canvas) => {
        canvas.height = (window.getComputedStyle(canvas).width * targetResolution[1]) / targetResolution[0];
    });
});

let depthEnabled = false;

function enableDepth() {
    [...document.getElementsByClassName("3d-selector-tabs")].forEach((tabsList) => (tabsList.hidden = false));

    document.getElementById("download-instructions-button").innerHTML = t('generateInstructions');

    onDepthMapCountChange();

    create3dPreview();
    depthEnabled = true;

    perfLoggingDatabase && perfLoggingDatabase.ref("enable-depth-count/total").transaction(incrementTransaction);
    const loggingTimestamp = Math.floor((Date.now() - (Date.now() % 8.64e7)) / 1000); // 8.64e+7 = ms in day
    perfLoggingDatabase && perfLoggingDatabase.ref("enable-depth-count/per-day/" + loggingTimestamp).transaction(incrementTransaction);
}
if (window.location.href.includes("enable3d")) {
    enableDepth();
}

Object.keys(PLATE_DIMENSIONS_TO_PART_ID).forEach((plate) => {
    ["depth-plates-container", "pixel-dimensions-container"].forEach((container) => {
        const input = document.createElement("input");
        input.type = "checkbox";
        input.name = plate;
        input.checked = !DEFAULT_DISABLED_DEPTH_PLATES.includes(plate);
        input.disabled = plate === "1 X 1";
        input.className = plate === "1 X 1" ? "always-disabled" : "checkbox-clickable";
        const label = document.createElement("label");
        label.className = plate === "1 X 1" ? "" : "checkbox-clickable";
        const plateSpan = document.createElement("span");
        plateSpan.innerHTML = " " + plate;
        label.appendChild(input);
        label.appendChild(plateSpan);
        const checkbox = document.createElement("div");
        checkbox.style = "margin-top: 2px; margin-left: 4px";
        checkbox.appendChild(label);
        document.getElementById(container).appendChild(checkbox);
        if (container === "pixel-dimensions-container") {
            checkbox.addEventListener("change", () => {
                disableInteraction();
                runStep3();
            });
            const classes = [];
            if (PLATE_DIMENSIONS_TO_PART_ID[plate]) {
                // for now, this is always true
                classes.push("variable-plate-checkbox");
            }
            if (TILE_DIMENSIONS_TO_PART_ID[plate]) {
                classes.push("variable-tile-checkbox");
            }
            if (BRICK_DIMENSIONS_TO_PART_ID[plate]) {
                classes.push("variable-brick-checkbox");
            }
            checkbox.className = classes.join(" ");
            input.className = [input.className, ...classes].join(" ");
        }
    });
});

function updateStudCountText() {
    const requiredStuds = targetResolution[0] * targetResolution[1];
    document.getElementById("required-studs").innerHTML = requiredStuds;
    if (document.getElementById("infinite-piece-count-check").checked) {
        document.getElementById("available-studs").innerHTML = "∞";
        document.getElementById("missing-studs").innerHTML = "0";
        document.getElementById("nonzero-missing-pieces-warning").hidden = true;
    } else {
        let availableStuds = 0;
        Array.from(customStudTableBody.children).forEach((stud) => {
            availableStuds += parseInt(stud.children[1].children[0].children[0].value);
        });
        const missingStuds = Math.max(requiredStuds - availableStuds, 0);
        document.getElementById("available-studs").innerHTML = availableStuds;
        document.getElementById("missing-studs").innerHTML = missingStuds;
        document.getElementById("nonzero-missing-pieces-warning").hidden = missingStuds === 0;
    }
}

const quantizationAlgorithmsInfo = {
    twoPhase: {
        name: "2 Phase",
    },
    floydSteinberg: {
        name: "Floyd-Steinberg Dithering",
    },
    jarvisJudiceNinkeDithering: {
        name: "Jarvis-Judice-Ninke Dithering",
    },
    atkinsonDithering: {
        name: "Atkinson Dithering",
    },
    sierraDithering: {
        name: "Sierra Dithering",
    },
    greedy: {
        name: "Greedy",
    },
    greedyWithDithering: {
        name: "Greedy Gaussian Dithering",
    },
};

const quantizationAlgorithmToTraditionalDitheringKernel = {
    floydSteinberg: FLOYD_STEINBERG_DITHERING_KERNEL,
    jarvisJudiceNinkeDithering: JARVIS_JUDICE_NINKE_DITHERING_KERNEL,
    atkinsonDithering: ATKINSON_DITHERING_KERNEL,
    sierraDithering: SIERRA_DITHERING_KERNEL,
};

const defaultQuantizationAlgorithmKey = "twoPhase";
let quantizationAlgorithm = defaultQuantizationAlgorithmKey;

let selectedPixelPartNumber = PIXEL_TYPE_OPTIONS[0].number;
document.getElementById("bricklink-piece-button").innerHTML = PIXEL_TYPE_OPTIONS[0].name;

// TODO: Make this a function
let overridePixelArray = new Array(targetResolution[0] * targetResolution[1] * 4).fill(null);
let overrideDepthPixelArray = new Array(targetResolution[0] * targetResolution[1] * 4).fill(null);

function handleResolutionChange() {
    SCALING_FACTOR = getScalingFactor(targetResolution[0], targetResolution[1]);
    DISPLAY_SCALING_FACTOR = getDisplayScalingFactor(targetResolution[0], targetResolution[1]);
    overridePixelArray = new Array(targetResolution[0] * targetResolution[1] * 4).fill(null);
    overrideDepthPixelArray = new Array(targetResolution[0] * targetResolution[1] * 4).fill(null);
    document.getElementById("width-text").title = `${(targetResolution[0] * PIXEL_WIDTH_CM).toFixed(1)} cm`;
    document.getElementById("height-text").title = `${(targetResolution[1] * PIXEL_WIDTH_CM).toFixed(1)} cm`;
    $('[data-toggle="tooltip"]').tooltip("dispose");
    $('[data-toggle="tooltip"]').tooltip();
    updatePlateDimensions();
    initializeCropper();
    if (typeof updateMosaicProductMeta === 'function') updateMosaicProductMeta();
    runStep1();
}

// Debounced version for slider dragging
const debouncedHandleResolutionChange = debounce(() => {
    handleResolutionChange();
}, DEBOUNCE_DELAY);

// Update text display without processing (for real-time feedback)
function updateResolutionTextOnly() {
    document.getElementById("width-text").innerHTML = document.getElementById("width-slider").value;
    document.getElementById("height-text").innerHTML = document.getElementById("height-slider").value;
    document.getElementById("width-text").title = `${(document.getElementById("width-slider").value * PIXEL_WIDTH_CM).toFixed(1)} cm`;
    document.getElementById("height-text").title = `${(document.getElementById("height-slider").value * PIXEL_WIDTH_CM).toFixed(1)} cm`;
}

document.getElementById("width-slider").addEventListener(
    "change",
    () => {
        document.getElementById("width-text").innerHTML = document.getElementById("width-slider").value;
        targetResolution[0] = document.getElementById("width-slider").value;
        handleResolutionChange();
    },
    false
);

document.getElementById("width-slider").addEventListener(
    "input",
    () => {
        updateResolutionTextOnly();
        targetResolution[0] = document.getElementById("width-slider").value;
        targetResolution[1] = document.getElementById("height-slider").value;
        debouncedHandleResolutionChange();
    },
    false
);

document.getElementById("height-slider").addEventListener(
    "change",
    () => {
        document.getElementById("height-text").innerHTML = document.getElementById("height-slider").value;
        targetResolution[1] = document.getElementById("height-slider").value;
        handleResolutionChange();
    },
    false
);

document.getElementById("height-slider").addEventListener(
    "input",
    () => {
        updateResolutionTextOnly();
        targetResolution[0] = document.getElementById("width-slider").value;
        targetResolution[1] = document.getElementById("height-slider").value;
        debouncedHandleResolutionChange();
    },
    false
);

// Per-plate-size max stud count (32-plates capped at 64, all others full range)
function getMaxStudsForStep(step) {
    if (step === 32) return 64;
    return 288;
}

// Minimum stud count per plate size
function getMinStudsForStep(step) {
    return step;
}

// Resolution step selectors
document.getElementById("width-step-select").addEventListener("change", () => {
    const newStep = parseInt(document.getElementById("width-step-select").value);
    const widthSlider = document.getElementById("width-slider");
    const newMin = getMinStudsForStep(newStep);
    const newMax = getMaxStudsForStep(newStep);
    widthSlider.step = newStep;
    widthSlider.min = newMin;
    widthSlider.max = newMax;
    // Snap current value to nearest valid step
    const currentValue = parseInt(widthSlider.value);
    const snappedValue = Math.round(currentValue / newStep) * newStep;
    const clampedValue = Math.max(newMin, Math.min(newMax, snappedValue));
    widthSlider.value = clampedValue;
    document.getElementById("width-text").innerHTML = clampedValue;
    targetResolution[0] = clampedValue;
    handleResolutionChange();
});

document.getElementById("height-step-select").addEventListener("change", () => {
    const newStep = parseInt(document.getElementById("height-step-select").value);
    const heightSlider = document.getElementById("height-slider");
    const newMin = getMinStudsForStep(newStep);
    const newMax = getMaxStudsForStep(newStep);
    heightSlider.step = newStep;
    heightSlider.min = newMin;
    heightSlider.max = newMax;
    // Snap current value to nearest valid step
    const currentValue = parseInt(heightSlider.value);
    const snappedValue = Math.round(currentValue / newStep) * newStep;
    const clampedValue = Math.max(newMin, Math.min(newMax, snappedValue));
    heightSlider.value = clampedValue;
    document.getElementById("height-text").innerHTML = clampedValue;
    targetResolution[1] = clampedValue;
    handleResolutionChange();
});

document.getElementById("clear-overrides-button").addEventListener("click", () => {
    overridePixelArray = new Array(targetResolution[0] * targetResolution[1] * 4).fill(null);
    // Overrides only affect step 3, so run step 3 directly (step 2 canvas is still valid)
    if (stepProcessed[2]) {
        runStep3();
    } else {
        runStep2();
    }
});
document.getElementById("clear-depth-overrides-button").addEventListener("click", () => {
    overrideDepthPixelArray = new Array(targetResolution[0] * targetResolution[1] * 4).fill(null);
    if (stepProcessed[2]) {
        runStep3();
    } else {
        runStep2();
    }
});

let DEFAULT_STUD_MAP = "all_tile_colors";
let DEFAULT_COLOR = "#42c0fb";
let DEFAULT_COLOR_NAME = "Medium Azure";

try {
    const match = window.location.href.match("[?&]" + "availableColors" + "=([^&]+)");
    const availableColorsString = match ? match[1] : null;
    let availableColors;
    if (match == null) {
        availableColors = [];
    } else {
        availableColors = availableColorsString
            .split(",")
            .map((color) => color.toLowerCase())
            .filter((color) => color.match("^#(?:[0-9a-fA-F]{3}){1,2}$"));
    }

    if (availableColors.length > 0) {
        DEFAULT_COLOR = availableColors[0];
        DEFAULT_COLOR_NAME = availableColors[0];
        ALL_VALID_BRICKLINK_COLORS = availableColors
            .map((color) => {
                return {
                    name: color,
                    hex: color,
                };
            })
            .concat(ALL_VALID_BRICKLINK_COLORS);
        ALL_BRICKLINK_SOLID_COLORS = ALL_VALID_BRICKLINK_COLORS;
        const studMap = {};
        availableColors.forEach((color) => {
            studMap[color] = 99999;
        });
        STUD_MAPS = {
            url_colors: {
                name: "Colors from URL",
                officialName: "Colors from URL",
                sortedStuds: availableColors,
                studMap: studMap,
            },
            all_solid_colors: STUD_MAPS["all_solid_colors"],
        };
        DEFAULT_STUD_MAP = "url_colors";
    }
} catch (_e) {
    enableInteraction();
}

let selectedStudMap = STUD_MAPS[DEFAULT_STUD_MAP].studMap;
let selectedFullSetName = STUD_MAPS[DEFAULT_STUD_MAP].officialName;
let selectedSortedStuds = STUD_MAPS[DEFAULT_STUD_MAP].sortedStuds;

function populateCustomStudSelectors(studMap, shouldRunAfterPopulation) {
    customStudTableBody.innerHTML = "";
    studMap.sortedStuds.forEach((stud) => {
        const studRow = getNewCustomStudRow();
        studRow.children[0].children[0].children[0].children[0].style.backgroundColor = stud;
        studRow.children[0].children[0].setAttribute("title", translateColor(HEX_TO_COLOR_NAME[stud]) || stud);
        studRow.children[1].children[0].children[0].value = studMap.studMap[stud];
        customStudTableBody.appendChild(studRow);
    });
    if (shouldRunAfterPopulation) {
        runCustomStudMap();
    }
}

function mixInStudMap(studMap, runAfterMixIn) {
    studMap.sortedStuds.forEach((stud) => {
        let existingRow = null;
        Array.from(customStudTableBody.children).forEach((row) => {
            const rgb = row.children[0].children[0].children[0].children[0].style.backgroundColor
                .replace("rgb(", "")
                .replace(")", "")
                .split(/,\s*/)
                .map((shade) => parseInt(shade));
            const rowHex = rgbToHex(rgb[0], rgb[1], rgb[2]);
            if (rowHex == stud && existingRow == null) {
                existingRow = row;
            }
        });

        if (existingRow == null) {
            const newStudRow = getNewCustomStudRow();
            newStudRow.children[0].children[0].children[0].innerHTML = "";
            newStudRow.children[0].children[0].children[0].appendChild(getColorSquare(stud));
            newStudRow.children[0].children[0].setAttribute("title", translateColor(HEX_TO_COLOR_NAME[stud]) || stud);
            newStudRow.children[1].children[0].children[0].value = studMap.studMap[stud];
            customStudTableBody.appendChild(newStudRow);
        } else {
            existingRow.children[1].children[0].children[0].value = Math.min(
                parseInt(existingRow.children[1].children[0].children[0].value) + studMap.studMap[stud],
                99999
            );
        }
    });
    // TODO: Clean up boolean logic here
    runCustomStudMap(!runAfterMixIn);
}

populateCustomStudSelectors(STUD_MAPS[DEFAULT_STUD_MAP], false);

const mixInStudMapOptions = document.getElementById("mix-in-stud-map-options");

const bricklinkPieceOptions = document.getElementById("bricklink-piece-options");
bricklinkPieceOptions.innerHTML = "";
PIXEL_TYPE_OPTIONS.forEach((part) => {
    const option = document.createElement("a");
    option.className = "dropdown-item btn";
    option.textContent = part.name;
    option.value = part.number;
    option.addEventListener("click", () => {
        document.getElementById("bricklink-piece-button").innerHTML = part.name;
        selectedPixelPartNumber = part.number;
        const isVariable = ("" + selectedPixelPartNumber).match("^variable.*$");
        document.getElementById("pixel-dimensions-container-wrapper").hidden = !isVariable;

        if (isVariable) {
            const availableParts = [...document.getElementById("pixel-dimensions-container").children].forEach(
                (input) => {
                    const className = input.className;
                    const uniqueVariablePixelName = selectedPixelPartNumber.replace("variable_", "");
                    return (input.hidden = !className.includes(uniqueVariablePixelName));
                }
            );
        }

        onInfinitePieceCountChange();
        updateForceInfinitePieceCountText();
        runStep3();
    });
    bricklinkPieceOptions.appendChild(option);
});

function isBleedthroughEnabled() {
    return [PIXEL_TYPE_OPTIONS[0].number, PIXEL_TYPE_OPTIONS[1].number].includes(selectedPixelPartNumber);
}

let selectedTiebreakTechnique = "alternatingmod";
const TIEBREAK_TECHNIQUES = [
    {
        name: "None",
        value: "none",
    },
    {
        name: "Random",
        value: "random",
    },
    {
        name: "Mod 2",
        value: "mod2",
    },
    {
        name: "Mod 3",
        value: "mod3",
    },
    {
        name: "Mod 4",
        value: "mod4",
    },
    {
        name: "Mod 5",
        value: "mod5",
    },
    {
        name: "Noisy Mod 2",
        value: "noisymod2",
    },
    {
        name: "Noisy Mod 3",
        value: "noisymod3",
    },
    {
        name: "Noisy Mod 4",
        value: "noisymod4",
    },
    {
        name: "Noisy Mod 5",
        value: "noisymod5",
    },
    {
        name: "Cascading Mod",
        value: "cascadingmod",
    },
    {
        name: "Cascading Noisy Mod",
        value: "cascadingnoisymod",
    },
    {
        name: "Alternating Mod",
        value: "alternatingmod",
    },
    {
        name: "Alternating Noisy Mod",
        value: "alternatingnoisymod",
    },
];

let selectedInterpolationAlgorithm = "default";
const INTERPOLATION_ALGORITHMS = [
    {
        name: "Browser Default",
        value: "default",
    },
    {
        name: "Average Pooling",
        value: "avgPooling",
    },
    {
        name: "Dual Min Max Pooling",
        value: "dualMinMaxPooling",
    },
    {
        name: "Min Pooling",
        value: "minPooling",
    },
    {
        name: "Max Pooling",
        value: "maxPooling",
    },
];
INTERPOLATION_ALGORITHMS.forEach((algorithm) => {
    const option = document.createElement("a");
    option.className = "dropdown-item btn";
    option.textContent = algorithm.name;
    option.value = algorithm.value;
    option.addEventListener("click", () => {
        document.getElementById("interpolation-algorithm-button").innerHTML = algorithm.name;
        selectedInterpolationAlgorithm = algorithm.value;
        runStep2();
    });
    document.getElementById("interpolation-algorithm-options").appendChild(option);
});

// Color distance stuff
//
// PERF: the d3 difference metrics (esp. CIEDE2000) internally convert each input
// to CIELAB. The hot path (alignPixelsToStudMap / dithering on step 3) calls the
// distance fn millions of times, but only ~20 palette colors and a bounded set of
// input colors ever appear. We memoize the per-color RGB→LAB conversion so each
// distinct color is converted once instead of on every comparison.
//
// SAFETY: every caller passes integer RGB channels in [0,255]:
//   - canvas pixels (Uint8ClampedArray) are integers,
//   - palette colors come from hexToRgb(...) (integers),
//   - dithering error-diffused pixels are run through clamp255() which Math.round()s.
// So the (r<<16)|(g<<8)|b cache key is exact and the output is byte-identical to the
// previous d3.color(rgbToHex(...)) path (verified A/B: 0 mismatched channels).
function d3ColorDistanceWrapper(d3DistanceFunction) {
    const labCache = new Map();
    function toLab(p) {
        const key = (p[0] << 16) | (p[1] << 8) | p[2];
        let c = labCache.get(key);
        if (c === undefined) {
            // Bound memory across very large images (key space is 16.7M max).
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

const colorDistanceFunctionsInfo = {
    euclideanRGB: {
        name: "Euclidean RGB",
        func: RGBPixelDistanceSquared,
    },
    euclideanLAB: {
        name: "Euclidean LAB",
        func: d3ColorDistanceWrapper(d3.differenceEuclideanLab),
    },
    // HCL and HSL don't always work
    // euclideanHCL: {
    //     name: "Euclidean HCL",
    //     func: d3ColorDistanceWrapper(d3.differenceEuclideanHCL)
    // },
    // euclideanHSL: {
    //     name: "Euclidean HSL",
    //     func: d3ColorDistanceWrapper(d3.differenceEuclideanHSL)
    // },
    // CMC sometimes looks odd (symmetry issues?)
    // cmc: {
    //     name: "CMC",
    //     func: d3ColorDistanceWrapper(d3.differenceCmc)
    // },
    cie94: {
        name: "CIE94",
        func: d3ColorDistanceWrapper(d3.differenceCie94),
    },
    ciede2000: {
        name: "CIEDE2000",
        func: d3ColorDistanceWrapper(d3.differenceCiede2000),
    },
    din99o: {
        name: "DIN99o",
        func: d3ColorDistanceWrapper(d3.differenceDin99o),
    },
};

const defaultDistanceFunctionKey = "ciede2000";
let colorDistanceFunction = colorDistanceFunctionsInfo[defaultDistanceFunctionKey].func;

function onInfinitePieceCountChange() {
    const isUsingInfinite =
        document.getElementById("infinite-piece-count-check").checked ||
        Object.keys(quantizationAlgorithmToTraditionalDitheringKernel).includes(quantizationAlgorithm) ||
        ("" + selectedPixelPartNumber).match("^variable.*$");
    [...document.getElementsByClassName("piece-count-input")].forEach(
        (numberInput) => (numberInput.hidden = isUsingInfinite)
    );
    [...document.getElementsByClassName("piece-count-infinity-placeholder")].forEach(
        (placeholder) => (placeholder.hidden = !isUsingInfinite)
    );
    updateStudCountText();
}
document.getElementById("infinite-piece-count-check").addEventListener("change", () => {
    onInfinitePieceCountChange();
    runStep4();
});

function updateForceInfinitePieceCountText() {
    const isInfinitePieceCountForced =
        Object.keys(quantizationAlgorithmToTraditionalDitheringKernel).includes(quantizationAlgorithm) ||
        ("" + selectedPixelPartNumber).match("^variable.*$");
    document.getElementById("infinite-piece-count-check-container").hidden = isInfinitePieceCountForced;
    document.getElementById("forced-infinite-piece-count-warning").hidden = !isInfinitePieceCountForced;
}

const DIVIDER = "DIVIDER";
const STUD_MAP_KEYS = Object.keys(STUD_MAPS);
const NUM_SET_STUD_MAPS = 12;
const NUM_PARTIAL_SET_STUD_MAPS = 7;
STUD_MAP_KEYS.splice(NUM_SET_STUD_MAPS, 0, DIVIDER);
STUD_MAP_KEYS.splice(NUM_SET_STUD_MAPS + NUM_PARTIAL_SET_STUD_MAPS + 1, 0, DIVIDER);

STUD_MAP_KEYS.filter((key) => key !== "rgb").forEach((studMap) => {
    if (studMap === DIVIDER) {
        const divider = document.createElement("div");
        divider.className = "dropdown-divider";
        mixInStudMapOptions.appendChild(divider);
    } else {
        const option = document.createElement("a");
        option.className = "dropdown-item btn";
        option.textContent = STUD_MAPS[studMap].name;
        option.value = studMap;
        option.addEventListener("click", () => {
            mixInStudMap(STUD_MAPS[studMap], true);
        });
        mixInStudMapOptions.appendChild(option);
    }
});

STUD_MAP_KEYS.filter((key) => key !== "rgb").forEach((studMap) => {
    if (studMap === DIVIDER) {
        const divider = document.createElement("div");
        divider.className = "dropdown-divider";
        document.getElementById("select-starting-custom-stud-map-options").appendChild(divider);
    } else {
        const option = document.createElement("a");
        option.className = "dropdown-item btn";
        option.textContent = STUD_MAPS[studMap].name;
        option.value = studMap;
        option.addEventListener("click", () => {
            customStudTableBody.innerHTML = "";
            mixInStudMap(STUD_MAPS[studMap], false);
            document.getElementById("select-starting-custom-stud-map-button").innerHTML = STUD_MAPS[studMap].name;
            const desc = STUD_MAPS[studMap].descriptionKey ? t(STUD_MAPS[studMap].descriptionKey) : (STUD_MAPS[studMap].descriptionHTML ?? "");
            document.getElementById("input-stud-map-description").innerHTML = desc;
        });
        document.getElementById("select-starting-custom-stud-map-options").appendChild(option);
    }
});

document.getElementById("select-starting-custom-stud-map-button").innerHTML = STUD_MAPS[DEFAULT_STUD_MAP].name;
const defaultDesc = STUD_MAPS[DEFAULT_STUD_MAP].descriptionKey ? t(STUD_MAPS[DEFAULT_STUD_MAP].descriptionKey) : (STUD_MAPS[DEFAULT_STUD_MAP].descriptionHTML ?? "");
document.getElementById("input-stud-map-description").innerHTML = defaultDesc;

constMixInDivider = document.createElement("div");
constMixInDivider.className = "dropdown-divider";
mixInStudMapOptions.appendChild(constMixInDivider);

const importOption = document.createElement("a");
importOption.className = "dropdown-item btn";
importOption.textContent = t('importFromFile');
importOption.value = null;
importOption.addEventListener("click", () => {
    document.getElementById("import-stud-map-file-input").click();
});
mixInStudMapOptions.appendChild(importOption);

document.getElementById("import-stud-map-file-input").addEventListener(
    "change",
    (e) => {
        const reader = new FileReader();
        reader.onload = function (event) {
            mixInStudMap(JSON.parse(reader.result, true));
            document.getElementById("import-stud-map-file-input").value = null;
        };
        reader.readAsText(e.target.files[0]);
    },
    false
);

document.getElementById("clear-custom-studs-button").addEventListener("click", () => {
    customStudTableBody.innerHTML = "";
    runCustomStudMap();
});

function runCustomStudMap(skipStep1) {
    const customStudMap = {};
    const customSortedStuds = [];
    Array.from(customStudTableBody.children).forEach((stud) => {
        const rgb = stud.children[0].children[0].children[0].children[0].style.backgroundColor
            .replace("rgb(", "")
            .replace(")", "")
            .split(/,\s*/)
            .map((shade) => parseInt(shade));
        const studHex = rgbToHex(rgb[0], rgb[1], rgb[2]);
        customSortedStuds.push(studHex);
        const numStuds = parseInt(stud.children[1].children[0].children[0].value);
        customStudMap[studHex] = (customStudMap[studHex] || 0) + numStuds;
    });
    if (customSortedStuds.length > 0) {
        selectedStudMap = customStudMap;
        selectedFullSetName = "Custom";
        selectedSortedStuds = customSortedStuds;
    }
    if (!skipStep1) {
        // When on visual step 2, stud map changes only affect steps 3+ (color quantization).
        // Step 2 (image crop/filter) is unaffected — no need to invalidate or re-run it.
        // Only call full runStep1() when NOT on VS2 (e.g., during initial setup).
        if (typeof currentVisualStep !== 'undefined' && currentVisualStep === 2) {
            updateStudCountText();
            invalidateStepsFrom(3);
        } else {
            runStep1();
        }
    }
    // If on visual step 2 (painting canvas visible), re-run step 3 with new stud map
    if (typeof currentVisualStep !== 'undefined' && currentVisualStep === 2 && stepProcessed[2]) {
        runStep3();
    }
}

function getColorSquare(hex) {
    const result = document.createElement("div");
    result.style.backgroundColor = hex;
    result.style.width = "1em";
    result.style.height = "1em";
    return result;
}

function getColorSelectorDropdown(tooltipPosition) {
    if (!tooltipPosition) {
        tooltipPosition = "left";
    }
    const container = document.createElement("div");
    const id = "color-selector" + uuidv4();

    const button = document.createElement("button");
    button.className = "btn btn-outline-secondary";
    button.type = "button";
    button.setAttribute("data-toggle", "dropdown");
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-expanded", "false");
    button.id = id;
    button.appendChild(getColorSquare(DEFAULT_COLOR));
    button.value = DEFAULT_COLOR;

    const dropdown = document.createElement("div");
    dropdown.setAttribute("aria-labelledby", id);
    dropdown.className = "dropdown-menu pre-scrollable";

    ALL_VALID_BRICKLINK_COLORS.forEach((color) => {
        const option = document.createElement("a");
        option.style.display = "flex";
        option.className = "dropdown-item btn";
        const text = document.createElement("span");
        text.innerHTML = "&nbsp;" + translateColor(color.name);
        const colorSquare = getColorSquare(color.hex);
        colorSquare.style.marginTop = "3px";
        option.appendChild(colorSquare);
        option.appendChild(text);
        option.addEventListener("click", () => {
            button.innerHTML = "";
            button.appendChild(getColorSquare(color.hex));
            container.setAttribute("title", translateColor(color.name));
            $('[data-toggle="tooltip"]').tooltip("dispose");
            $('[data-toggle="tooltip"]').tooltip();
            runCustomStudMap();
        });
        dropdown.appendChild(option);
    });

    container.setAttribute("data-toggle", "tooltip");
    container.setAttribute("data-placement", tooltipPosition);
    container.setAttribute("title", translateColor(DEFAULT_COLOR_NAME));
    setTimeout(() => $('[data-toggle="tooltip"]').tooltip(), 10);
    container.appendChild(button);
    container.appendChild(dropdown);
    return container;
}

const paintbrushDropdown = getColorSelectorDropdown("top");
paintbrushDropdown.children[0].id = "paintbrush-color-dropdown";
paintbrushDropdown.children[0].className = "btn paintbrush-controls-button";
paintbrushDropdown.style = "height: 100%;";
document.getElementById("paintbrush-controls").appendChild(paintbrushDropdown);

function getNewCustomStudRow() {
    const studRow = document.createElement("tr");

    const removeButton = document.createElement("button");
    removeButton.className = "btn btn-danger";
    removeButton.style = "padding: 2px; margin-left: 4px;";
    removeButton.innerHTML = "X";
    removeButton.addEventListener("click", () => {
        customStudTableBody.removeChild(studRow);
        runCustomStudMap();
    });

    const colorCell = document.createElement("td");
    const colorInput = getColorSelectorDropdown();
    colorCell.appendChild(colorInput);
    studRow.appendChild(colorCell);

    const numberCell = document.createElement("td");
    const numberCellChild = document.createElement("div");
    const numberInput = document.createElement("input");
    numberInput.style = "max-width: 80px";
    numberInput.type = "number";
    numberInput.value = 10;
    numberInput.className = "form-control form-control-sm piece-count-input";
    numberInput.addEventListener("change", (v) => {
        numberInput.value = Math.round(Math.min(Math.max(parseFloat(numberInput.value) || 0, 0), 99999));
        runCustomStudMap();
    });
    numberInput.hidden =
        document.getElementById("infinite-piece-count-check").checked ||
        Object.keys(quantizationAlgorithmToTraditionalDitheringKernel).includes(quantizationAlgorithm) ||
        ("" + selectedPixelPartNumber).match("^variable.*$");
    infinityPlaceholder = document.createElement("div");
    infinityPlaceholder.hidden = !numberInput.hidden;
    infinityPlaceholder.className = "piece-count-infinity-placeholder";
    infinityPlaceholder.innerHTML = "∞";
    numberCellChild.style = "display: flex; flex-direction: horizontal;";
    numberCellChild.appendChild(numberInput);
    numberCellChild.appendChild(infinityPlaceholder);

    numberCellChild.appendChild(removeButton);
    numberCell.appendChild(numberCellChild);
    studRow.appendChild(numberCell);
    return studRow;
}

document.getElementById("add-custom-stud-button").addEventListener("click", () => {
    const studRow = getNewCustomStudRow();

    customStudTableBody.appendChild(studRow);
    runCustomStudMap();
});

const onHueChange = (useDebounce = true) => {
    document.getElementById("hue-text").innerHTML = document.getElementById("hue-slider").value + "<span>&#176;</span>";
    if (useDebounce) {
        debouncedRunStep2();
    } else {
        runStep2();
    }
};
document.getElementById("hue-slider").addEventListener("change", () => onHueChange(false), false);
document.getElementById("hue-slider").addEventListener("input", () => onHueChange(true), false);
document.getElementById("hue-increment").addEventListener(
    "click",
    () => {
        if (Number(document.getElementById("hue-slider").value) < Number(document.getElementById("hue-slider").max)) {
            document.getElementById("hue-slider").value = Number(document.getElementById("hue-slider").value) + 1;
            onHueChange();
        }
    },
    false
);
document.getElementById("hue-decrement").addEventListener(
    "click",
    () => {
        if (Number(document.getElementById("hue-slider").value) > Number(document.getElementById("hue-slider").min)) {
            document.getElementById("hue-slider").value = Number(document.getElementById("hue-slider").value) - 1;
            onHueChange();
        }
    },
    false
);

const onSaturationChange = (useDebounce = true) => {
    document.getElementById("saturation-text").innerHTML = document.getElementById("saturation-slider").value + "%";
    if (useDebounce) {
        debouncedRunStep2();
    } else {
        runStep2();
    }
};
document.getElementById("saturation-slider").addEventListener("change", () => onSaturationChange(false), false);
document.getElementById("saturation-slider").addEventListener("input", () => onSaturationChange(true), false);
document.getElementById("saturation-increment").addEventListener(
    "click",
    () => {
        if (
            Number(document.getElementById("saturation-slider").value) <
            Number(document.getElementById("saturation-slider").max)
        ) {
            document.getElementById("saturation-slider").value =
                Number(document.getElementById("saturation-slider").value) + 1;
            onSaturationChange();
        }
    },
    false
);
document.getElementById("saturation-decrement").addEventListener(
    "click",
    () => {
        if (
            Number(document.getElementById("saturation-slider").value) >
            Number(document.getElementById("saturation-slider").min)
        ) {
            document.getElementById("saturation-slider").value =
                Number(document.getElementById("saturation-slider").value) - 1;
            onSaturationChange();
        }
    },
    false
);

const onValueChange = (useDebounce = true) => {
    document.getElementById("value-text").innerHTML = document.getElementById("value-slider").value + "%";
    if (useDebounce) {
        debouncedRunStep2();
    } else {
        runStep2();
    }
};
document.getElementById("value-slider").addEventListener("change", () => onValueChange(false), false);
document.getElementById("value-slider").addEventListener("input", () => onValueChange(true), false);
document.getElementById("value-increment").addEventListener(
    "click",
    () => {
        if (
            Number(document.getElementById("value-slider").value) < Number(document.getElementById("value-slider").max)
        ) {
            document.getElementById("value-slider").value = Number(document.getElementById("value-slider").value) + 1;
            onValueChange();
        }
    },
    false
);
document.getElementById("value-decrement").addEventListener(
    "click",
    () => {
        if (
            Number(document.getElementById("value-slider").value) > Number(document.getElementById("value-slider").min)
        ) {
            document.getElementById("value-slider").value = Number(document.getElementById("value-slider").value) - 1;
            onValueChange();
        }
    },
    false
);

const onBrightnessChange = (useDebounce = true) => {
    document.getElementById("brightness-text").innerHTML =
        (document.getElementById("brightness-slider").value > 0 ? "+" : "") +
        document.getElementById("brightness-slider").value;
    if (useDebounce) {
        debouncedRunStep2();
    } else {
        runStep2();
    }
};
document.getElementById("brightness-slider").addEventListener("change", () => onBrightnessChange(false), false);
document.getElementById("brightness-slider").addEventListener("input", () => onBrightnessChange(true), false);
document.getElementById("brightness-increment").addEventListener(
    "click",
    () => {
        if (
            Number(document.getElementById("brightness-slider").value) <
            Number(document.getElementById("brightness-slider").max)
        ) {
            document.getElementById("brightness-slider").value =
                Number(document.getElementById("brightness-slider").value) + 1;
            onBrightnessChange();
        }
    },
    false
);
document.getElementById("brightness-decrement").addEventListener(
    "click",
    () => {
        if (
            Number(document.getElementById("brightness-slider").value) >
            Number(document.getElementById("brightness-slider").min)
        ) {
            document.getElementById("brightness-slider").value =
                Number(document.getElementById("brightness-slider").value) - 1;
            onBrightnessChange();
        }
    },
    false
);

const onContrastChange = (useDebounce = true) => {
    document.getElementById("contrast-text").innerHTML =
        (document.getElementById("contrast-slider").value > 0 ? "+" : "") +
        document.getElementById("contrast-slider").value;
    if (useDebounce) {
        debouncedRunStep2();
    } else {
        runStep2();
    }
};
document.getElementById("contrast-slider").addEventListener("change", () => onContrastChange(false), false);
document.getElementById("contrast-slider").addEventListener("input", () => onContrastChange(true), false);
document.getElementById("contrast-increment").addEventListener(
    "click",
    () => {
        if (
            Number(document.getElementById("contrast-slider").value) <
            Number(document.getElementById("contrast-slider").max)
        ) {
            document.getElementById("contrast-slider").value =
                Number(document.getElementById("contrast-slider").value) + 1;
            onContrastChange();
        }
    },
    false
);
document.getElementById("contrast-decrement").addEventListener(
    "click",
    () => {
        if (
            Number(document.getElementById("contrast-slider").value) >
            Number(document.getElementById("contrast-slider").min)
        ) {
            document.getElementById("contrast-slider").value =
                Number(document.getElementById("contrast-slider").value) - 1;
            onContrastChange();
        }
    },
    false
);

function onDepthMapCountChange() {
    const numLevels = Number(document.getElementById("num-depth-levels-slider").value);
    overrideDepthPixelArray = new Array(targetResolution[0] * targetResolution[1] * 4).fill(null);
    document.getElementById("num-depth-levels-text").innerHTML = numLevels;
    const inputs = [];
    const inputsContainer = document.getElementById("depth-threshold-sliders-containers");
    inputsContainer.innerHTML = "";
    for (let i = 0; i < numLevels - 1; i++) {
        const input = document.createElement("input");
        input.type = "range";
        input.min = 0;
        input.max = 255;
        input.value = Math.floor(255 * ((i + 1) / numLevels));
        input.style = "width: 100%";
        input.addEventListener("change", () => {
            for (let j = 0; j < i; j++) {
                inputs[j].value = Math.min(inputs[j].value, input.value);
            }
            for (let j = i + 1; j < numLevels - 1; j++) {
                inputs[j].value = Math.max(inputs[j].value, input.value);
            }
            runStep1();
        });
        inputs.push(input);
        inputsContainer.appendChild(input);
    }

    [...document.getElementsByClassName("threshold-plural-s")].forEach((s) => (s.hidden = numLevels < 3));

    runStep1();
}

document.getElementById("num-depth-levels-slider").addEventListener("change", onDepthMapCountChange, false);

document.getElementById("reset-hsv-button").addEventListener(
    "click",
    () => {
        document.getElementById("hue-slider").value = 0;
        document.getElementById("saturation-slider").value = 0;
        document.getElementById("value-slider").value = 0;
        document.getElementById("hue-text").innerHTML =
            document.getElementById("hue-slider").value + "<span>&#176;</span>";
        document.getElementById("saturation-text").innerHTML = document.getElementById("saturation-slider").value + "%";
        document.getElementById("value-text").innerHTML = document.getElementById("value-slider").value + "%";
        runStep2();
    },
    false
);

document.getElementById("reset-brightness-button").addEventListener(
    "click",
    () => {
        document.getElementById("brightness-slider").value = 0;
        document.getElementById("brightness-text").innerHTML = document.getElementById("brightness-slider").value;
        runStep2();
    },
    false
);

document.getElementById("reset-contrast-button").addEventListener(
    "click",
    () => {
        document.getElementById("contrast-slider").value = 0;
        document.getElementById("contrast-text").innerHTML = document.getElementById("contrast-slider").value;
        runStep2();
    },
    false
);

function runStep1() {
    disableInteraction();
    updateStudCountText();
    invalidateStepsFrom(2);

    window.URL.revokeObjectURL(document.getElementById("export-stud-map-button").href);
    document.getElementById("export-stud-map-button").setAttribute(
        "href",
        window.URL.createObjectURL(
            new Blob(
                [
                    JSON.stringify({
                        studMap: selectedStudMap,
                        sortedStuds: Object.keys(selectedStudMap),
                    }),
                ],
                {
                    type: "text/plain",
                }
            )
        )
    );

    step1DepthCanvasUpscaled.width = step1CanvasUpscaled.width;
    step1DepthCanvasUpscaled.height = step1CanvasUpscaled.height;
    step1DepthCanvasUpscaledContext.drawImage(
        inputDepthCanvas,
        0,
        0,
        step1CanvasUpscaled.width,
        step1CanvasUpscaled.height
    );
    setTimeout(() => {
        stepProcessed[1] = true;
        enableInteraction();
    }, 1);
}

function runStep1Only() {
    runStep1();
}

// Debounced version of runStep2 for slider interactions
const debouncedRunStep2 = debounce(() => {
    runStep2();
}, DEBOUNCE_DELAY);

function runStep2() {
    const opts = bkLoaderOptsForResolution();
    disableInteraction(opts);
    invalidateStepsFrom(3);
    // Yield a paint frame before the heavy crop/pool/filter pass so the loader
    // overlay is visible during the freeze. Light resolutions stay snappy.
    if (opts.immediate) {
        bkPaintThenRun(_runStep2Body);
    } else {
        setTimeout(_runStep2Body, 0);
    }
}

function _runStep2Body() {
    let inputPixelArray;
    if (selectedInterpolationAlgorithm === "default") {
        const croppedCanvas = inputImageCropper.getCroppedCanvas({
            width: targetResolution[0],
            height: targetResolution[1],
            maxWidth: 4096,
            maxHeight: 4096,
            imageSmoothingEnabled: false,
        });
        if (!croppedCanvas) {
            console.error("Cropper returned no canvas — re-initializing");
            enableInteraction();
            showVisualStep(1);
            return;
        }
        inputPixelArray = getPixelArrayFromCanvas(croppedCanvas);
    } else {
        // We're using adaptive pooling
        const croppedCanvas = inputImageCropper.getCroppedCanvas({
            maxWidth: 4096,
            maxHeight: 4096,
            imageSmoothingEnabled: false,
        });
        if (!croppedCanvas) {
            console.error("Cropper returned no canvas — re-initializing");
            enableInteraction();
            showVisualStep(1);
            return;
        }
        rawCroppedData = getPixelArrayFromCanvas(croppedCanvas);
        let subArrayPoolingFunction;
        if (selectedInterpolationAlgorithm === "maxPooling") {
            subArrayPoolingFunction = maxPoolingKernel;
        } else if (selectedInterpolationAlgorithm === "minPooling") {
            subArrayPoolingFunction = minPoolingKernel;
        } else if (selectedInterpolationAlgorithm === "avgPooling") {
            subArrayPoolingFunction = avgPoolingKernel;
        } else {
            //  selectedInterpolationAlgorithm === "dualMinMaxPooling"
            subArrayPoolingFunction = dualMinMaxPoolingKernel;
        }
        inputPixelArray = resizeImagePixelsWithAdaptivePooling(
            rawCroppedData,
            croppedCanvas.width,
            targetResolution[0],
            targetResolution[1],
            subArrayPoolingFunction
        );
    }
    let filteredPixelArray = applyHSVAdjustment(
        inputPixelArray,
        document.getElementById("hue-slider").value,
        document.getElementById("saturation-slider").value / 100,
        document.getElementById("value-slider").value / 100
    );
    filteredPixelArray = applyBrightnessAdjustment(
        filteredPixelArray,
        Number(document.getElementById("brightness-slider").value)
    );
    filteredPixelArray = applyContrastAdjustment(
        filteredPixelArray,
        Number(document.getElementById("contrast-slider").value)
    );
    step2Canvas.width = targetResolution[0];
    step2Canvas.height = targetResolution[1];
    drawPixelsOnCanvas(filteredPixelArray, step2Canvas);

    step2DepthCanvas.width = targetResolution[0];
    step2DepthCanvas.height = targetResolution[1];

    // Map the crop to the depth image
    const cropperData = inputImageCropper.getData();
    const rawCroppedDepthImage = step1DepthCanvasUpscaledContext.getImageData(
        cropperData.x,
        cropperData.y,
        cropperData.width,
        cropperData.height
    );
    const cropperBufferCanvas = document.getElementById("step-2-depth-canvas-cropper-buffer");
    const cropperBufferCanvasContext = cropperBufferCanvas.getContext("2d");
    cropperBufferCanvas.width = targetResolution[0];
    cropperBufferCanvas.height = targetResolution[1];
    cropperBufferCanvasContext.drawImage(
        step1DepthCanvasUpscaled,
        cropperData.x,
        cropperData.y,
        cropperData.width,
        cropperData.height,
        0,
        0,
        targetResolution[0],
        targetResolution[1]
    );
    const inputDepthPixelArray = getPixelArrayFromCanvas(cropperBufferCanvas);

    const discreteDepthPixels = getDiscreteDepthPixels(
        inputDepthPixelArray,
        [...document.getElementById("depth-threshold-sliders-containers").children].map((slider) =>
            Number(slider.value)
        )
    );
    drawPixelsOnCanvas(discreteDepthPixels, step2DepthCanvas);

    setTimeout(() => {
        stepProcessed[2] = true;
        // DISPLAY_SCALING_FACTOR (not SCALING_FACTOR): these step-2 upscaled canvases
        // are display-only previews (never read back as an export/PDF source), so a
        // capped backing store keeps the draw cheap and the layer light to composite.
        step2CanvasUpscaled.width = targetResolution[0] * DISPLAY_SCALING_FACTOR;
        step2CanvasUpscaled.height = targetResolution[1] * DISPLAY_SCALING_FACTOR;
        step2CanvasUpscaledContext.imageSmoothingEnabled = false;
        step2CanvasUpscaledContext.drawImage(
            step2Canvas,
            0,
            0,
            targetResolution[0] * DISPLAY_SCALING_FACTOR,
            targetResolution[1] * DISPLAY_SCALING_FACTOR
        );
        step2DepthCanvasUpscaled.width = targetResolution[0] * DISPLAY_SCALING_FACTOR;
        step2DepthCanvasUpscaled.height = targetResolution[1] * DISPLAY_SCALING_FACTOR;
        drawStudImageOnCanvas(
            scaleUpDiscreteDepthPixelsForDisplay(
                discreteDepthPixels,
                document.getElementById("num-depth-levels-slider").value
            ),
            targetResolution[0],
            DISPLAY_SCALING_FACTOR,
            step2DepthCanvasUpscaled,
            selectedPixelPartNumber
        );
        // Auto-chain: if on visual step 2 (painting canvas visible), also run step 3
        // Skip auto-chain when runStepProcessing is managing the flow (it runs step 3 itself)
        if (!_isRunningStepProcessing && typeof currentVisualStep !== 'undefined' && currentVisualStep === 2) {
            runStep3();
        } else {
            enableInteraction();
        }
    }, 1);
}

function runStep2Only() {
    runStep2();
}

function getVariablePixelAvailablePartDimensions() {
    const availableParts = [...document.getElementById("pixel-dimensions-container").children]
        .map((div) => div.children[0])
        .map((label) => label.children[0])
        .filter((input) => input.checked)
        .filter((input) => {
            const className = input.className;
            const uniqueVariablePixelName = selectedPixelPartNumber.replace("variable_", "");
            return className.includes(uniqueVariablePixelName);
        })
        .map((input) => input.name)
        .map((part) => part.split(PLATE_DIMENSIONS_DEPTH_SEPERATOR).map((dimension) => Number(dimension)));
    const flippedParts = [];
    availableParts.forEach((part) => {
        if (part[0] !== part[1]) {
            flippedParts.push([part[1], part[0]]);
        }
    });
    flippedParts.forEach((part) => availableParts.push(part));
    return availableParts;
}

// only non null if pixel piece is variable
let step3VariablePixelPieceDimensions = null;

function runStep3() {
    const opts = bkLoaderOptsForResolution();
    disableInteraction(opts);
    invalidateStepsFrom(4);
    // Yield a paint frame before the heavy quantization/dithering so the loader
    // overlay is visible during the freeze. Light resolutions stay snappy.
    if (opts.immediate) {
        bkPaintThenRun(_runStep3Body);
    } else {
        setTimeout(_runStep3Body, 0);
    }
}

// ---------------------------------------------------------------------------
// Off-main-thread color quantization (Web Worker).
//
// alignPixelsToStudMap() at high resolution is the single biggest main-thread
// freeze on step 2/3 — it stalled the loader animation and made hovering the
// style icons stutter. We push it into js/mosaic-align-worker.js so the main
// thread stays responsive (loader spins, hover lifts animate) while it runs.
//
// The worker uses the identical d3 bundles + identical alignment code, so its
// palette mapping is byte-identical to the synchronous path (the paid product's
// brick counts / price never change). If the worker can't be created or errors,
// we transparently fall back to the synchronous compute.
// ---------------------------------------------------------------------------
let _bkAlignWorker = null;
let _bkAlignWorkerBroken = false;
let _bkAlignSeq = 0; // monotonically increasing request id
let _bkAlignLatestId = 0; // only this id's result is applied (drop stale)
const _bkAlignPending = {}; // id -> { cb, pixels, studMap, distanceKey }

function bkGetAlignWorker() {
    if (_bkAlignWorkerBroken) return null;
    if (_bkAlignWorker) return _bkAlignWorker;
    if (typeof Worker === "undefined") {
        _bkAlignWorkerBroken = true;
        return null;
    }
    try {
        _bkAlignWorker = new Worker("js/mosaic-align-worker.js?v=55");
    } catch (e) {
        _bkAlignWorkerBroken = true;
        return null;
    }
    _bkAlignWorker.onmessage = function (e) {
        const data = e.data || {};
        const id = data.id;
        const pending = _bkAlignPending[id];
        delete _bkAlignPending[id];
        if (!pending) return;

        if (data.error) {
            // Worker couldn't compute this job — fall back synchronously, but
            // only for the latest request (stale ones are irrelevant now).
            if (id === _bkAlignLatestId) {
                const aligned = alignPixelsToStudMap(pending.pixels, pending.studMap, colorDistanceFunction);
                pending.cb(aligned);
            }
            return;
        }

        if (id !== _bkAlignLatestId) return; // a newer request superseded this one
        const typed = new Uint8ClampedArray(data.buffer);
        // Array.from -> plain Array, matching the original return type exactly.
        pending.cb(Array.from(typed));
    };
    _bkAlignWorker.onerror = function () {
        // Mark broken so future calls go straight to the synchronous path.
        _bkAlignWorkerBroken = true;
        // Recover the latest in-flight job synchronously so the UI doesn't hang.
        const latest = _bkAlignPending[_bkAlignLatestId];
        const ids = Object.keys(_bkAlignPending);
        ids.forEach((k) => delete _bkAlignPending[k]);
        try { _bkAlignWorker.terminate(); } catch (e) {}
        _bkAlignWorker = null;
        if (latest) {
            const aligned = alignPixelsToStudMap(latest.pixels, latest.studMap, colorDistanceFunction);
            latest.cb(aligned);
        }
    };
    return _bkAlignWorker;
}

// Returns true if the job was handed to the worker (cb will be called async with
// a plain Array), false if no worker is available (caller must compute inline).
function bkTryAlignInWorker(pixels, studMap, distanceKey, cb) {
    const worker = bkGetAlignWorker();
    if (!worker) return false;
    const id = ++_bkAlignSeq;
    _bkAlignLatestId = id;
    // Copy so we can transfer the buffer without detaching the canvas-owned data.
    const copy = new Uint8ClampedArray(pixels);
    _bkAlignPending[id] = { cb: cb, pixels: pixels, studMap: studMap, distanceKey: distanceKey };
    try {
        worker.postMessage({ id: id, buffer: copy.buffer, studMap: studMap, distanceKey: distanceKey }, [copy.buffer]);
    } catch (e) {
        delete _bkAlignPending[id];
        _bkAlignWorkerBroken = true;
        return false;
    }
    return true;
}

function _runStep3Body() {
    const fiteredPixelArray = getPixelArrayFromCanvas(step2Canvas);

    const studMapForAlign = isBleedthroughEnabled() ? getDarkenedStudMap(selectedStudMap) : selectedStudMap;

    // TODO: Apply overrides separately
    if (quantizationAlgorithm === "twoPhase") {
        // Heavy nearest-color quantization → run it in a Web Worker so the main
        // thread stays free (smooth loader + style-icon hover). Byte-identical
        // result; falls back to synchronous if the worker is unavailable.
        const handed = bkTryAlignInWorker(
            fiteredPixelArray,
            studMapForAlign,
            defaultDistanceFunctionKey,
            function (alignedPixelArray) {
                _finishStep3(alignedPixelArray);
            }
        );
        if (handed) {
            return; // _finishStep3 runs when the worker posts its result back
        }
        // No worker available: compute inline.
        _finishStep3(alignPixelsToStudMap(fiteredPixelArray, studMapForAlign, colorDistanceFunction));
        return;
    }

    let alignedPixelArray;
    if (quantizationAlgorithm === "greedy" || quantizationAlgorithm === "greedyWithDithering") {
        alignedPixelArray = correctPixelsForAvailableStudsWithGreedyDynamicDithering(
            studMapForAlign,
            fiteredPixelArray,
            targetResolution[0],
            colorDistanceFunction,
            quantizationAlgorithm !== "greedyWithDithering", // skipDithering
            true // assumeInfinitePixelCounts
        );
    } else {
        // assume we're dealing with a traditional error dithering algorithm
        const ditheringKernel = quantizationAlgorithmToTraditionalDitheringKernel[quantizationAlgorithm];
        alignedPixelArray = alignPixelsWithTraditionalDithering(
            studMapForAlign,
            fiteredPixelArray,
            targetResolution[0],
            colorDistanceFunction,
            ditheringKernel
        );
    }

    _finishStep3(alignedPixelArray);
}

// Everything after the heavy quantization step. Split out so it can be called
// either synchronously (greedy/dithering) or from the Web Worker callback.
function _finishStep3(alignedPixelArray) {
    step3PixelArrayForEraser = alignedPixelArray;
    alignedPixelArray = getArrayWithOverridesApplied(
        alignedPixelArray,
        isBleedthroughEnabled() ? getDarkenedImage(overridePixelArray) : overridePixelArray
    );

    step3DepthCanvas.width = targetResolution[0];
    step3DepthCanvas.height = targetResolution[1];
    const inputDepthPixelArray = getPixelArrayFromCanvas(step2DepthCanvas);

    const adjustedDepthPixelArray = getArrayWithOverridesApplied(inputDepthPixelArray, overrideDepthPixelArray);

    drawPixelsOnCanvas(adjustedDepthPixelArray, step3DepthCanvas);

    if (("" + selectedPixelPartNumber).match("^variable.*$")) {
        const alignedPixelMatrix = convertPixelArrayToMatrix(alignedPixelArray, targetResolution[0]);
        step3VariablePixelPieceDimensions = new Array();
        for (let i = 0; i < targetResolution[1]; i++) {
            step3VariablePixelPieceDimensions.push([]);
            step3VariablePixelPieceDimensions[i] = [];
            for (let j = 0; j < targetResolution[0]; j++) {
                step3VariablePixelPieceDimensions[i].push(null);
            }
        }
        const uniqueColors = Object.keys(getUsedPixelsStudMap(alignedPixelArray));
        const availableParts = getVariablePixelAvailablePartDimensions();
        for (
            let depthLevel = 0;
            depthLevel < Number(document.getElementById("num-depth-levels-slider").value);
            depthLevel++
        ) {
            uniqueColors.forEach((colorHex) => {
                const colorRGB = hexToRgb(colorHex);
                const setPixelMatrix = getSetPixelMatrixFromInputMatrix(alignedPixelMatrix, (p, i, j) => {
                    return !(
                        (!depthEnabled || depthLevel === adjustedDepthPixelArray[4 * (i * targetResolution[0] + j)]) &&
                        p[0] === colorRGB[0] &&
                        p[1] === colorRGB[1] &&
                        p[2] === colorRGB[2]
                    );
                });
                const requiredPartMatrix = getRequiredPartMatrixFromSetPixelMatrix(
                    setPixelMatrix,
                    availableParts,
                    PLATE_WIDTH
                );
                requiredPartMatrix.forEach((row, i) => {
                    row.forEach((entry, j) => {
                        step3VariablePixelPieceDimensions[i][j] = step3VariablePixelPieceDimensions[i][j] || entry;
                    });
                });
            });
        }
    } else {
        step3VariablePixelPieceDimensions = null;
    }

    step3Canvas.width = targetResolution[0];
    step3Canvas.height = targetResolution[1];
    drawPixelsOnCanvas(alignedPixelArray, step3Canvas);

    step3CanvasPixelsForHover = isBleedthroughEnabled()
        ? revertDarkenedImage(
              alignedPixelArray,
              getDarkenedStudsToStuds(ALL_BRICKLINK_SOLID_COLORS.map((color) => color.hex))
          )
        : alignedPixelArray;
    step3DepthCanvasPixelsForHover = adjustedDepthPixelArray;

    setTimeout(() => {
        stepProcessed[3] = true;
        // Keep the loader up THROUGH the heavy upscale render below, then hide it.
        // Previously enableInteraction() ran first, so the overlay vanished and the
        // page then froze again during drawStudImageOnCanvas (the upscale at high
        // resolution) with nothing on screen — the "hang after the loader disappears"
        // the customer reported. Hiding only after the draws keeps the freeze covered.
        try {
            // DISPLAY_SCALING_FACTOR (not SCALING_FACTOR): the step-3 editing canvas
            // is only shown at a few hundred CSS px, so a capped backing store keeps
            // the draw cheap and the layer light to composite on scroll/hover. The
            // full-resolution render happens later on step 4 (export/PDF source).
            step3CanvasUpscaledContext.imageSmoothingEnabled = false;
            drawStudImageOnCanvas(
                isBleedthroughEnabled()
                    ? revertDarkenedImage(
                          alignedPixelArray,
                          getDarkenedStudsToStuds(ALL_BRICKLINK_SOLID_COLORS.map((color) => color.hex))
                      )
                    : alignedPixelArray,
                targetResolution[0],
                DISPLAY_SCALING_FACTOR,
                step3CanvasUpscaled,
                selectedPixelPartNumber,
                step3VariablePixelPieceDimensions
            );
            step3DepthCanvasUpscaled.width = targetResolution[0] * DISPLAY_SCALING_FACTOR;
            step3DepthCanvasUpscaled.height = targetResolution[1] * DISPLAY_SCALING_FACTOR;
            drawStudImageOnCanvas(
                scaleUpDiscreteDepthPixelsForDisplay(
                    adjustedDepthPixelArray,
                    document.getElementById("num-depth-levels-slider").value
                ),
                targetResolution[0],
                DISPLAY_SCALING_FACTOR,
                step3DepthCanvasUpscaled,
                selectedPixelPartNumber
            );
        } catch (err) {
            console.error("runStep3 async error:", err);
        }
        // Hide the loader only after the new canvas has actually been PAINTED, not
        // just drawn. drawStudImageOnCanvas fills the backing store synchronously,
        // but the browser still has to composite that new layer to screen; doing
        // that the same frame the overlay is removed produced a final visible hitch
        // ("lag right after the loader disappears"). bkPaintThenRun's double-rAF
        // lets one real paint land first, so the reveal is clean.
        bkPaintThenRun(enableInteraction);
    }, 1);
}

function runStep3Only() {
    runStep3();
}

let isStep3ViewExpanded = false;

function onDepthOverrideDecrease(row, col) {
    onDepthOverrideChange(row, col, false);
}

function onDepthOverrideIncrease(row, col) {
    onDepthOverrideChange(row, col, true);
}

function onDepthOverrideChange(row, col, isIncrease) {
    if (!document.getElementById("step-3-depth-1-collapse").className.includes("show")) {
        return; // only override if the refine depth section is expanded
    }
    const pixelIndex = 4 * (row * targetResolution[0] + col);
    const step2DepthImagePixels = getPixelArrayFromCanvas(step2DepthCanvas);
    const currentVal =
        overrideDepthPixelArray[pixelIndex] != null
            ? overrideDepthPixelArray[pixelIndex]
            : step2DepthImagePixels[pixelIndex];

    let newVal = currentVal;
    if (isIncrease) {
        newVal = Math.min(newVal + 1, Number(document.getElementById("num-depth-levels-slider").value - 1));
    } else {
        newVal = Math.max(newVal - 1, 0);
    }

    const pixelDisplayVal = newVal;
    if (newVal === step2DepthImagePixels[pixelIndex]) {
        newVal = null;
    }
    for (var i = 0; i < 3; i++) {
        overrideDepthPixelArray[pixelIndex + i] = newVal;
    }

    if (isStep3ViewExpanded) {
        // do stuff directly on the canvas for perf
        const upscaledPixelDisplayVal = Math.round(
            Math.min(
                (255 * (pixelDisplayVal + 1)) / Number(document.getElementById("num-depth-levels-slider").value),
                255
            )
        );
        const radius = DISPLAY_SCALING_FACTOR / 2;
        const i = pixelIndex / 4;
        const ctx = step3DepthCanvasUpscaledContext;
        const width = targetResolution[0];
        ctx.beginPath();
        ctx.arc(((i % width) * 2 + 1) * radius, (Math.floor(i / width) * 2 + 1) * radius, radius, 0, 2 * Math.PI);
        ctx.fillStyle = rgbToHex(upscaledPixelDisplayVal, upscaledPixelDisplayVal, upscaledPixelDisplayVal);
        ctx.fill();
    } else {
        runStep3();
    }
}

function onCherryPickColor(row, col) {
    const pixelIndex = 4 * (row * targetResolution[0] + col);
    const isOverridden =
        overridePixelArray[pixelIndex] !== null &&
        overridePixelArray[pixelIndex + 1] !== null &&
        overridePixelArray[pixelIndex + 2] !== null;

    const step3PixelArray = isBleedthroughEnabled()
        ? revertDarkenedImage(
              getPixelArrayFromCanvas(step3Canvas),
              getDarkenedStudsToStuds(ALL_BRICKLINK_SOLID_COLORS.map((color) => color.hex))
          )
        : getPixelArrayFromCanvas(step3Canvas);

    const colorHex = isOverridden
        ? rgbToHex(
              overridePixelArray[pixelIndex],
              overridePixelArray[pixelIndex + 1],
              overridePixelArray[pixelIndex + 2]
          )
        : rgbToHex(step3PixelArray[pixelIndex], step3PixelArray[pixelIndex + 1], step3PixelArray[pixelIndex + 2]);
    document.getElementById("paintbrush-controls").children[0].children[0].children[0].style.backgroundColor = colorHex;
    const hexName = ALL_BRICKLINK_SOLID_COLORS.find((color) => color.hex === colorHex).name;
    document.getElementById("paintbrush-controls").children[0].setAttribute("title", hexName);
    $('[data-toggle="tooltip"]').tooltip("dispose");
    $('[data-toggle="tooltip"]').tooltip();
}

let activePaintbrushHex = null; // null iff we don't want to paint
let wasPaintbrushUsed = false; // only propogate changes on mouse leave if this is true
let step3CanvasHoveredPixel = null;
let step3CanvasPixelsForHover = null; // only used for perf

function onStep3PaintingMouseLift() {
    activePaintbrushHex = null;
    // propogate changes
    if (!isStep3ViewExpanded && wasPaintbrushUsed) {
        disableInteraction();
        runStep3();
        wasPaintbrushUsed = false;
    }
}

step3CanvasUpscaled.addEventListener(
    "mousedown",
    function (event) {
        wasPaintbrushUsed = true;
        const rawRow =
            event.clientY -
            step3CanvasUpscaled.getBoundingClientRect().y -
            step3CanvasUpscaled.offsetHeight / targetResolution[1] / 2;
        const rawCol =
            event.clientX -
            step3CanvasUpscaled.getBoundingClientRect().x -
            step3CanvasUpscaled.offsetWidth / targetResolution[0] / 2;
        const row = Math.round((rawRow * targetResolution[1]) / step3CanvasUpscaled.offsetHeight);
        const col = Math.round((rawCol * targetResolution[0]) / step3CanvasUpscaled.offsetWidth);
        const rgb = document
            .getElementById("paintbrush-controls")
            .children[0].children[0].children[0].style.backgroundColor.replace("rgb(", "")
            .replace(")", "")
            .split(/,\s*/)
            .map((shade) => parseInt(shade));
        activePaintbrushHex = rgbToHex(rgb[0], rgb[1], rgb[2]);
        onMouseMoveOverStep3Canvas(event); // so we paint on a single click
    },
    false
);

let selectedPaintbrushTool = "paintbrush-tool-dropdown-option";
Array.from(document.getElementById("paintbrush-tool-selection-dropdown-options").children).forEach((item) => {
    const value = item.id;
    item.addEventListener("click", () => {
        selectedPaintbrushTool = value;
        document.getElementById("paintbrush-color-dropdown").disabled = value !== "paintbrush-tool-dropdown-option";
        document.getElementById("paintbrush-tool-selection-dropdown").innerHTML = item.children[0].innerHTML;
    });
});

let step3PixelArrayForEraser = null;

function onMouseMoveOverStep3Canvas(event) {
    if (!document.getElementById("universal-loading-progress").hidden) {
        return; // ignore this - interaction is disabled because we're loading/working
    }
    const rawRow =
        event.clientY -
        step3CanvasUpscaled.getBoundingClientRect().y -
        step3CanvasUpscaled.offsetHeight / targetResolution[1] / 2;
    const rawCol =
        event.clientX -
        step3CanvasUpscaled.getBoundingClientRect().x -
        step3CanvasUpscaled.offsetWidth / targetResolution[0] / 2;
    const row = Math.round((rawRow * targetResolution[1]) / step3CanvasUpscaled.offsetHeight);
    const col = Math.round((rawCol * targetResolution[0]) / step3CanvasUpscaled.offsetWidth);

    const pixelIndex = 4 * (row * targetResolution[0] + col);
    const i = pixelIndex / 4;
    const ctx = step3CanvasUpscaledContext;
    const width = targetResolution[0];
    const radius = DISPLAY_SCALING_FACTOR / 2;

    if (activePaintbrushHex != null) {
        // mouse is clicked down, so we're handling the click

        if (selectedPaintbrushTool === "paintbrush-tool-dropdown-option") {
            const colorRGB = hexToRgb(activePaintbrushHex);
            // we want to paint - update the override pixel array
            // do stuff directly on the canvas for perf
            ctx.beginPath();
            ctx.arc(((i % width) * 2 + 1) * radius, (Math.floor(i / width) * 2 + 1) * radius, radius, 0, 2 * Math.PI);
            ctx.fillStyle = activePaintbrushHex;
            ctx.fill();

            // update the override pixel array in place
            overridePixelArray[pixelIndex] = colorRGB[0];
            overridePixelArray[pixelIndex + 1] = colorRGB[1];
            overridePixelArray[pixelIndex + 2] = colorRGB[2];
        } else if (selectedPaintbrushTool === "eraser-tool-dropdown-option") {
            // null out the override
            if (
                overridePixelArray[pixelIndex] != null &&
                overridePixelArray[pixelIndex + 1] != null &&
                overridePixelArray[pixelIndex + 2] != null
            ) {
                // do stuff directly on the canvas for perf
                ctx.beginPath();
                ctx.arc(
                    ((i % width) * 2 + 1) * radius,
                    (Math.floor(i / width) * 2 + 1) * radius,
                    radius,
                    0,
                    2 * Math.PI
                );
                ctx.fillStyle = rgbToHex(
                    step3PixelArrayForEraser[pixelIndex],
                    step3PixelArrayForEraser[pixelIndex + 1],
                    step3PixelArrayForEraser[pixelIndex + 2]
                );
                ctx.fill();

                // update the override pixel array in place
                overridePixelArray[pixelIndex] = null;
                overridePixelArray[pixelIndex + 1] = null;
                overridePixelArray[pixelIndex + 2] = null;
            }
        } else {
            // dropper tool
            onCherryPickColor(row, col);
        }
    } else if (pixelIndex + 2 < step3CanvasPixelsForHover.length) {
        // we're not painting - highlight the pixel instead
        const hoveredPixelRGB = [
            step3CanvasPixelsForHover[pixelIndex],
            step3CanvasPixelsForHover[pixelIndex + 1],
            step3CanvasPixelsForHover[pixelIndex + 2],
        ];
        const hoveredPixelHex = rgbToHex(hoveredPixelRGB[0], hoveredPixelRGB[1], hoveredPixelRGB[2]);
        ctx.beginPath();
        ctx.arc(((i % width) * 2 + 1) * radius, (Math.floor(i / width) * 2 + 1) * radius, radius / 2, 0, 2 * Math.PI);
        ctx.fillStyle = inverseHex(hoveredPixelHex);
        ctx.fill();
    }

    if (step3CanvasHoveredPixel != null && (step3CanvasHoveredPixel[0] !== row || step3CanvasHoveredPixel[1] !== col)) {
        // Clear out old highlight
        const i = step3CanvasHoveredPixel[0] * width + step3CanvasHoveredPixel[1];
        const pixelIndex = i * 4;

        ctx.beginPath();
        ctx.arc(((i % width) * 2 + 1) * radius, (Math.floor(i / width) * 2 + 1) * radius, radius / 2, 0, 2 * Math.PI);

        let originalPixelRGB = [
            overridePixelArray[pixelIndex] || step3CanvasPixelsForHover[pixelIndex],
            overridePixelArray[pixelIndex + 1] || step3CanvasPixelsForHover[pixelIndex + 1],
            overridePixelArray[pixelIndex + 2] || step3CanvasPixelsForHover[pixelIndex + 2],
        ];
        const originalPixelHex = rgbToHex(originalPixelRGB[0], originalPixelRGB[1], originalPixelRGB[2]);

        ctx.fillStyle = originalPixelHex;
        ctx.fill();
    }
    step3CanvasHoveredPixel = [row, col];
}

step3CanvasUpscaled.addEventListener("mouseup", onStep3PaintingMouseLift, false);

step3CanvasUpscaled.addEventListener(
    "mouseleave",
    () => {
        if (step3CanvasHoveredPixel != null) {
            // Clear out old highlight
            const i = step3CanvasHoveredPixel[0] * targetResolution[0] + step3CanvasHoveredPixel[1];
            const pixelIndex = i * 4;

            const radius = DISPLAY_SCALING_FACTOR / 2;
            step3CanvasUpscaledContext.beginPath();
            step3CanvasUpscaledContext.arc(
                ((i % targetResolution[0]) * 2 + 1) * radius,
                (Math.floor(i / targetResolution[0]) * 2 + 1) * radius,
                radius / 2,
                0,
                2 * Math.PI
            );

            let originalPixelRGB = [
                overridePixelArray[pixelIndex] || step3CanvasPixelsForHover[pixelIndex],
                overridePixelArray[pixelIndex + 1] || step3CanvasPixelsForHover[pixelIndex + 1],
                overridePixelArray[pixelIndex + 2] || step3CanvasPixelsForHover[pixelIndex + 2],
            ];
            const originalPixelHex = rgbToHex(originalPixelRGB[0], originalPixelRGB[1], originalPixelRGB[2]);

            step3CanvasUpscaledContext.fillStyle = originalPixelHex;
            step3CanvasUpscaledContext.fill();
        }

        step3CanvasHoveredPixel = null;
        onStep3PaintingMouseLift();
    },
    false
);

step3CanvasUpscaled.addEventListener("mousemove", onMouseMoveOverStep3Canvas, false);

let isTouchInBounds = false;
step3CanvasUpscaled.addEventListener(
    "touchstart",
    function (e) {
        isTouchInBounds = true;
        const { clientX, clientY } = e.touches[0];
        const mouseEvent = new MouseEvent("mousedown", {
            clientX,
            clientY,
        });
        step3CanvasUpscaled.dispatchEvent(mouseEvent);
    },
    false
);
step3CanvasUpscaled.addEventListener(
    "touchend",
    function (e) {
        const mouseEvent = new MouseEvent("mouseup", {});
        step3CanvasUpscaled.dispatchEvent(mouseEvent);
    },
    false
);
step3CanvasUpscaled.addEventListener(
    "touchmove",
    function (e) {
        e.preventDefault(); // prevent scrolling
        if (!isTouchInBounds) {
            return;
        }
        const { clientX, clientY } = e.touches[0];

        let mouseEventType = "mousemove";
        if (step3CanvasUpscaled !== document.elementFromPoint(clientX, clientY)) {
            isTouchInBounds = false;
            mouseEventType = "mouseleave";
        }
        const mouseEvent = new MouseEvent(mouseEventType, {
            clientX,
            clientY,
        });
        step3CanvasUpscaled.dispatchEvent(mouseEvent);
    },
    false
);

step3DepthCanvasUpscaled.addEventListener(
    "contextmenu",
    function (event) {
        event.preventDefault();
        const rawRow =
            event.clientY -
            step3DepthCanvasUpscaled.getBoundingClientRect().y -
            step3DepthCanvasUpscaled.offsetHeight / targetResolution[1] / 2;
        const rawCol =
            event.clientX -
            step3DepthCanvasUpscaled.getBoundingClientRect().x -
            step3DepthCanvasUpscaled.offsetWidth / targetResolution[0] / 2;
        const row = Math.round((rawRow * targetResolution[1]) / step3DepthCanvasUpscaled.offsetHeight);
        const col = Math.round((rawCol * targetResolution[0]) / step3DepthCanvasUpscaled.offsetWidth);
        onDepthOverrideDecrease(row, col);
    },
    false
);

step3DepthCanvasUpscaled.addEventListener(
    "click",
    function (event) {
        const rawRow =
            event.clientY -
            step3DepthCanvasUpscaled.getBoundingClientRect().y -
            step3DepthCanvasUpscaled.offsetHeight / targetResolution[1] / 2;
        const rawCol =
            event.clientX -
            step3DepthCanvasUpscaled.getBoundingClientRect().x -
            step3DepthCanvasUpscaled.offsetWidth / targetResolution[0] / 2;
        const row = Math.round((rawRow * targetResolution[1]) / step3DepthCanvasUpscaled.offsetHeight);
        const col = Math.round((rawCol * targetResolution[0]) / step3DepthCanvasUpscaled.offsetWidth);
        onDepthOverrideIncrease(row, col);
    },
    false
);

let step3DepthCanvasPixelsForHover = null; // only used for perf
step3DepthCanvasUpscaled.addEventListener("mousemove", function (event) {
    if (!document.getElementById("step-3-depth-1-collapse").className.includes("show")) {
        return; // only highlight if the refine section is expanded
    }

    const rawRow =
        event.clientY -
        step3DepthCanvasUpscaled.getBoundingClientRect().y -
        step3DepthCanvasUpscaled.offsetHeight / targetResolution[1] / 2;
    const rawCol =
        event.clientX -
        step3DepthCanvasUpscaled.getBoundingClientRect().x -
        step3DepthCanvasUpscaled.offsetWidth / targetResolution[0] / 2;
    const pixelRow = Math.round((rawRow * targetResolution[1]) / step3DepthCanvasUpscaled.offsetHeight);
    const pixelCol = Math.round((rawCol * targetResolution[0]) / step3DepthCanvasUpscaled.offsetWidth);

    if (
        step3CanvasHoveredPixel == null ||
        step3CanvasHoveredPixel[0] != pixelRow ||
        step3CanvasHoveredPixel[1] != pixelCol
    ) {
        const ctx = step3DepthCanvasUpscaled.getContext("2d");

        ctx.lineWidth = 3;
        step4CanvasUpscaledContext.lineWidth = 3;

        const radius = DISPLAY_SCALING_FACTOR / 2;
        const width = targetResolution[0];

        const i = pixelRow * width + pixelCol;

        ctx.beginPath();
        ctx.arc(((i % width) * 2 + 1) * radius, (Math.floor(i / width) * 2 + 1) * radius, radius / 2, 0, 2 * Math.PI);
        let hoveredPixelRGB = [
            step3CanvasPixelsForHover[i * 4],
            step3CanvasPixelsForHover[i * 4 + 1],
            step3CanvasPixelsForHover[i * 4 + 2],
        ];
        const hoveredPixelHex = rgbToHex(hoveredPixelRGB[0], hoveredPixelRGB[1], hoveredPixelRGB[2]);
        ctx.fillStyle = DEFAULT_COLOR;
        ctx.fill();

        if (step3CanvasHoveredPixel != null) {
            const i = step3CanvasHoveredPixel[0] * width + step3CanvasHoveredPixel[1];

            ctx.beginPath();
            ctx.arc(
                ((i % width) * 2 + 1) * radius,
                (Math.floor(i / width) * 2 + 1) * radius,
                radius / 2,
                0,
                2 * Math.PI
            );

            let originalPixelRGB = [
                step3CanvasPixelsForHover[i * 4],
                step3CanvasPixelsForHover[i * 4 + 1],
                step3CanvasPixelsForHover[i * 4 + 2],
            ];
            const depthValue = step3DepthCanvasPixelsForHover[i * 4];
            const scaledDepthValue = Math.round(
                Math.min((255 * (depthValue + 1)) / document.getElementById("num-depth-levels-slider").value, 255)
            );
            const originalPixelHex = rgbToHex(originalPixelRGB[0], originalPixelRGB[1], originalPixelRGB[2]);
            const originalDepthPixelHex = rgbToHex(scaledDepthValue, scaledDepthValue, scaledDepthValue);

            ctx.fillStyle = originalDepthPixelHex;
            ctx.fill();
        }
        step3CanvasHoveredPixel = [pixelRow, pixelCol];
    }
});

step3DepthCanvasUpscaled.addEventListener("mouseleave", function (event) {
    const ctx = step3DepthCanvasUpscaled.getContext("2d");

    if (step3CanvasHoveredPixel != null) {
        ctx.beginPath();
        ctx.rect(
            step3CanvasHoveredPixel[1] * DISPLAY_SCALING_FACTOR,
            step3CanvasHoveredPixel[0] * DISPLAY_SCALING_FACTOR,
            DISPLAY_SCALING_FACTOR,
            DISPLAY_SCALING_FACTOR
        );
        ctx.strokeStyle = "#000000";
        ctx.stroke();
        step4CanvasUpscaledContext.beginPath();
        step4CanvasUpscaledContext.rect(
            step3CanvasHoveredPixel[1] * SCALING_FACTOR,
            step3CanvasHoveredPixel[0] * SCALING_FACTOR,
            SCALING_FACTOR,
            SCALING_FACTOR
        );
        step4CanvasUpscaledContext.strokeStyle = "#000000";
        step4CanvasUpscaledContext.stroke();
    }
    step3CanvasHoveredPixel = null;
});

window.depthPreviewOptions = {};

function create3dPreview() {
    const app = new PIXI.Application({
        resizeTo: step4Canvas3dUpscaled,
        autoResize: true,
        resizeThrottle: 100,
    });

    step4Canvas3dUpscaled.innerHTML = "";
    step4Canvas3dUpscaled.appendChild(app.view);

    const img = new PIXI.Sprite.from(step4CanvasUpscaled.toDataURL("image/png", 1.0));

    img.width = Number(window.getComputedStyle(step4Canvas3dUpscaled).width.replace("px", ""));
    img.height = (img.width * targetResolution[1]) / targetResolution[0];
    app.stage.addChild(img);

    const depthMap = new PIXI.Sprite.from(step3DepthCanvasUpscaled.toDataURL("image/png", 1.0));
    app.stage.addChild(depthMap);

    const displacementFilter = new PIXI.filters.DisplacementFilter(depthMap);
    app.stage.filters = [displacementFilter];
    displacementFilter.scale.x = 0;
    displacementFilter.scale.y = 0;

    window.depthPreviewOptions = {
        app,
        img,
        depthMap,
        displacementFilter,
    };
    setTimeout(depthPreviewResize, 5);
}

document.getElementById("step-4-depth-tab").addEventListener("click", () => {
    const targetWidth = step4CanvasUpscaled.clientWidth;
    step4Canvas3dUpscaled.clientWidth = targetWidth;
    setTimeout(create3dPreview, 20);
});

function depthPreviewResize() {
    if (
        // for perf
        document.getElementById("step-4-depth-tab").className.includes("active")
    ) {
        const { app, img, depthMap } = window.depthPreviewOptions;
        const targetWidth = step4Canvas3dUpscaled.clientWidth;
        const targetHeight = (targetWidth * targetResolution[1]) / targetResolution[0];
        step4Canvas3dUpscaled.style.height = targetHeight + "px";
        app.renderer.resize(targetWidth, targetHeight);
        img.width = targetWidth;
        img.height = targetHeight;
        depthMap.width = targetWidth;
        depthMap.height = targetHeight;
    }
}

window.addEventListener("resize", depthPreviewResize);

step4Canvas3dUpscaled.addEventListener("mousemove", function (e) {
    if (
        // for perf
        document.getElementById("step-4-depth-tab").className.includes("active")
    ) {
        const { img, displacementFilter } = window.depthPreviewOptions;
        const displacementScale = Number(document.getElementById("3d-effect-intensity").value);
        const rawX = event.clientX - step4Canvas3dUpscaled.getBoundingClientRect().x;
        const rawY = event.clientY - step4Canvas3dUpscaled.getBoundingClientRect().y;
        displacementFilter.scale.x = (img.width / 2 - rawX) * displacementScale;
        displacementFilter.scale.y = (img.height / 2 - rawY) * displacementScale;
    }
});
step4Canvas3dUpscaled.addEventListener("mouseleave", function (e) {
    if (
        // for perf
        document.getElementById("step-4-depth-tab").className.includes("active")
    ) {
        const { displacementFilter } = window.depthPreviewOptions;
        displacementFilter.scale.x = 0;
        displacementFilter.scale.y = 0;
    }
});

document.getElementById("3d-effect-intensity").addEventListener("change", create3dPreview, false);

function runStep4(asyncCallback) {
    if (typeof updateMosaicProductMeta === 'function') updateMosaicProductMeta();
    disableInteraction();
    const step2PixelArray = getPixelArrayFromCanvas(step2Canvas);
    const step3PixelArray = getPixelArrayFromCanvas(step3Canvas);
    step4Canvas.width = 0;
    try {
        bricklinkCacheCanvas.width = targetResolution[0];
        bricklinkCacheCanvas.height = targetResolution[1];
        step4Canvas.width = targetResolution[0];
        step4Canvas.height = targetResolution[1];
        step4CanvasContext.clearRect(0, 0, targetResolution[0], targetResolution[1]);
        step4CanvasUpscaledContext.clearRect(
            0,
            0,
            targetResolution[0] * SCALING_FACTOR,
            targetResolution[1] * SCALING_FACTOR
        );

        // save perf by sidestepping step 4 if every available color could
        // theoretically fill the entire image on its owwn
        let shouldSideStepStep4 = true;
        Object.values(selectedStudMap).forEach((count) => {
            if (count < targetResolution[0] * targetResolution[1]) {
                shouldSideStepStep4 = false;
            }
        });

        // There are three reasons step 4 should be identical to step 3
        shouldSideStepStep4 =
            shouldSideStepStep4 ||
            document.getElementById("infinite-piece-count-check").checked ||
            Object.keys(quantizationAlgorithmToTraditionalDitheringKernel).includes(quantizationAlgorithm) ||
            ("" + selectedPixelPartNumber).match("^variable.*$");

        if (!shouldSideStepStep4) {
            const requiredStuds = targetResolution[0] * targetResolution[1];
            let availableStuds = 0;
            Array.from(customStudTableBody.children).forEach((stud) => {
                availableStuds += parseInt(stud.children[1].children[0].children[0].value);
            });
            const missingStuds = Math.max(requiredStuds - availableStuds, 0);
            if (missingStuds > 0) {
                throw "Step 4 failed"; // error will be caught and interaction will be enabled
            }
        }

        let availabilityCorrectedPixelArray;

        // if we're using a traditional error dithering algorithm, this has to be true
        if (shouldSideStepStep4) {
            availabilityCorrectedPixelArray = step3PixelArray;
        } else if (quantizationAlgorithm === "twoPhase") {
            availabilityCorrectedPixelArray = correctPixelsForAvailableStuds(
                step3PixelArray,
                isBleedthroughEnabled() ? getDarkenedStudMap(selectedStudMap) : selectedStudMap,
                step2PixelArray,
                isBleedthroughEnabled() ? getDarkenedImage(overridePixelArray) : overridePixelArray,
                selectedTiebreakTechnique,
                (document.getElementById("color-tie-grouping-factor-slider") || {value: 0.001}).value,
                targetResolution[0],
                colorDistanceFunction
            );
        } else {
            // quantizationAlgorithm === 'greedy' || quantizationAlgorithm === 'greedyWithDithering'
            availabilityCorrectedPixelArray = correctPixelsForAvailableStudsWithGreedyDynamicDithering(
                isBleedthroughEnabled() ? getDarkenedStudMap(selectedStudMap) : selectedStudMap,
                getArrayWithOverridesApplied(
                    step2PixelArray,
                    isBleedthroughEnabled() ? getDarkenedImage(overridePixelArray) : overridePixelArray
                ), // apply overrides before running GGD
                targetResolution[0],
                colorDistanceFunction,
                quantizationAlgorithm !== "greedyWithDithering", // skipDithering
                shouldSideStepStep4 // assumeInfinitePixelCounts
            );
        }

        drawPixelsOnCanvas(availabilityCorrectedPixelArray, step4Canvas);

        setTimeout(async () => {
            try {
            step4CanvasUpscaledContext.imageSmoothingEnabled = false;
            const pixelsToDraw = isBleedthroughEnabled()
                ? revertDarkenedImage(
                      availabilityCorrectedPixelArray,
                      getDarkenedStudsToStuds(ALL_BRICKLINK_SOLID_COLORS.map((color) => color.hex))
                  )
                : availabilityCorrectedPixelArray;
            drawPixelsOnCanvas(pixelsToDraw, bricklinkCacheCanvas);

            drawStudImageOnCanvas(
                pixelsToDraw,
                targetResolution[0],
                SCALING_FACTOR,
                step4CanvasUpscaled,
                selectedPixelPartNumber,
                step3VariablePixelPieceDimensions
            );

            // create stud map result table
            const usedPixelsStudMap = getUsedPixelsStudMap(pixelsToDraw);
            const usedPixelsTableBody = document.getElementById("studs-used-table-body");
            usedPixelsTableBody.innerHTML = "";
            const variablePixelsUsed = ("" + selectedPixelPartNumber).match("^variable.*$");
            document.getElementById("pieces-used-dimensions-header").hidden = !variablePixelsUsed;
            let pieceCountsForTable = {}; // map piece identifier strings to counts
            if (variablePixelsUsed) {
                const pixelMatrix = convertPixelArrayToMatrix(pixelsToDraw, targetResolution[0]);
                step3VariablePixelPieceDimensions.forEach((row, i) => {
                    row.forEach((pixelDimensions, j) => {
                        if (pixelDimensions != null) {
                            const pixelRGB = pixelMatrix[i][j];
                            const pixelHex = rgbToHex(pixelRGB[0], pixelRGB[1], pixelRGB[2]);
                            const sortedPixelDimensions =
                                pixelDimensions[0] < pixelDimensions[1]
                                    ? pixelDimensions
                                    : [pixelDimensions[1], pixelDimensions[0]];
                            studRowKey =
                                pixelHex +
                                "_" +
                                sortedPixelDimensions[0] +
                                PLATE_DIMENSIONS_DEPTH_SEPERATOR +
                                sortedPixelDimensions[1];
                            pieceCountsForTable[studRowKey] = (pieceCountsForTable[studRowKey] || 0) + 1;
                        }
                    });
                });
            } else {
                pieceCountsForTable = usedPixelsStudMap;
            }

            const usedColors = Object.keys(pieceCountsForTable);
            usedColors.sort();
            usedColors.forEach((keyString) => {
                const pieceKey = keyString.split("_");
                const color = pieceKey[0];
                const studRow = document.createElement("tr");
                studRow.style = "height: 1px;";

                const colorCell = document.createElement("td");
                const colorSquare = getColorSquare(color);
                colorCell.appendChild(colorSquare);
                const colorLabel = document.createElement("small");
                colorLabel.innerHTML = translateColor(HEX_TO_COLOR_NAME[color]) || color;
                colorCell.appendChild(colorLabel);
                studRow.appendChild(colorCell);

                if (pieceKey.length > 1) {
                    const dimensionsCell = document.createElement("td");
                    dimensionsCell.style = "height: inherit;";
                    const dimensionsCellChild = document.createElement("div");
                    dimensionsCellChild.style =
                        "height: 100%; display: flex; flex-direction:column; justify-content: center";
                    const dimensionsCellChild2 = document.createElement("div");
                    dimensionsCellChild2.style = "";
                    dimensionsCellChild2.innerHTML = pieceKey[1];

                    dimensionsCellChild.appendChild(dimensionsCellChild2);
                    dimensionsCell.appendChild(dimensionsCellChild);
                    studRow.appendChild(dimensionsCell);
                }

                const numberCell = document.createElement("td");
                numberCell.style = "height: inherit;";
                const numberCellChild = document.createElement("div");
                numberCellChild.style = "height: 100%; display: flex; flex-direction:column; justify-content: center";
                const numberCellChild2 = document.createElement("div");
                numberCellChild2.style = "";
                numberCellChild2.innerHTML = pieceCountsForTable[keyString];

                numberCellChild.appendChild(numberCellChild2);
                numberCell.appendChild(numberCellChild);
                studRow.appendChild(numberCell);

                usedPixelsTableBody.appendChild(studRow);
            });

            const missingPixelsTableBody = document.getElementById("studs-missing-table-body");
            if (missingPixelsTableBody) missingPixelsTableBody.innerHTML = "";

            let missingPixelsExist = false;
            if (!shouldSideStepStep4) {
                // create stud map missing pieces table
                const missingPixelsStudMap = studMapDifference(
                    getUsedPixelsStudMap(
                        isBleedthroughEnabled()
                            ? revertDarkenedImage(
                                  step3PixelArray,
                                  getDarkenedStudsToStuds(ALL_BRICKLINK_SOLID_COLORS.map((color) => color.hex))
                              )
                            : step3PixelArray
                    ),
                    selectedStudMap
                );
                const usedColors = Object.keys(missingPixelsStudMap);
                usedColors.sort();
                usedColors.forEach((color) => {
                    if (missingPixelsStudMap[color] > 0) {
                        missingPixelsExist = true;
                        const studRow = document.createElement("tr");
                        studRow.style = "height: 1px;";

                        const colorCell = document.createElement("td");
                        const colorSquare = getColorSquare(color);
                        colorCell.appendChild(colorSquare);
                        const colorLabel = document.createElement("small");
                        colorLabel.innerHTML = translateColor(HEX_TO_COLOR_NAME[color]) || color;
                        colorCell.appendChild(colorLabel);
                        studRow.appendChild(colorCell);

                        const numberCell = document.createElement("td");
                        numberCell.style = "height: inherit;";
                        const numberCellChild = document.createElement("div");
                        numberCellChild.style =
                            "height: 100%; display: flex; flex-direction:column; justify-content: center";
                        const numberCellChild2 = document.createElement("div");
                        numberCellChild2.style = "";
                        numberCellChild2.innerHTML = missingPixelsStudMap[color];

                        numberCellChild.appendChild(numberCellChild2);
                        numberCell.appendChild(numberCellChild);
                        studRow.appendChild(numberCell);

                        if (missingPixelsTableBody) missingPixelsTableBody.appendChild(studRow);
                    }
                });
            }
            document.getElementById("studs-missing-container").hidden = !missingPixelsExist;

            if (document.getElementById("step-4-depth-tab").className.includes("active")) {
                setTimeout(create3dPreview, 50); // TODO: find better way to check that input is finished
            }
            if (asyncCallback) {
                await asyncCallback();
            }
            stepProcessed[4] = true;
            enableInteraction();
            } catch (err) {
                console.error("runStep4 async error:", err);
                stepProcessed[4] = true;
                enableInteraction();
            }
        }, 1);
    } catch (_e) {
        console.error("runStep4 sync error:", _e);
        stepProcessed[4] = true;
        enableInteraction();
    }
}

function runStep4Only() {
    runStep4();
}

function addWaterMark(pdf, isHighQuality) {
    // Watermark removed
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function setDPI(canvas, dpi) {
    // Set up CSS size.
    canvas.style.width = canvas.style.width || canvas.width + "px";
    canvas.style.height = canvas.style.height || canvas.height + "px";

    // Get size information.
    var scaleFactor = dpi / 96;
    var width = parseFloat(canvas.style.width);
    var height = parseFloat(canvas.style.height);

    // Backup the canvas contents.
    var oldScale = canvas.width / width;
    var backupScale = scaleFactor / oldScale;
    var backup = canvas.cloneNode(false);
    backup.getContext("2d").drawImage(canvas, 0, 0);

    // Resize the canvas.
    var ctx = canvas.getContext("2d");
    canvas.width = Math.ceil(width * scaleFactor);
    canvas.height = Math.ceil(height * scaleFactor);

    // Redraw the canvas image and scale future draws.
    ctx.setTransform(backupScale, 0, 0, backupScale, 0, 0);
    ctx.drawImage(backup, 0, 0);
    ctx.setTransform(scaleFactor, 0, 0, scaleFactor, 0, 0);
}

// Plate-OVERVIEW raster tuning. Overviews are dense full-plate pictures (48×48 =
// 2304 studs) used only for orientation — at PRINT_SCALING they render to ~2600px
// and JPEG to ~2 MB each (36 of them = ~72 MB at 288×288). We downscale the
// finished canvas to a sane pixel cap before encoding: identical layout, a
// fraction of the bytes. Detail pages stay full-res vectors (crisp numbers).
const BK_OVERVIEW_MAX_PX = 1500;
const BK_OVERVIEW_JPEG_Q = 0.85;

// Downscale a canvas in place so its longest side is <= maxDim (no-op if already
// smaller). Uses high-quality smoothing so the shrunk picture stays clean.
function bkCapCanvasToMaxDim(canvas, maxDim) {
    const longest = Math.max(canvas.width, canvas.height);
    if (!maxDim || longest <= maxDim) return canvas;
    const scale = maxDim / longest;
    const tmp = document.createElement("canvas");
    tmp.width = Math.max(1, Math.round(canvas.width * scale));
    tmp.height = Math.max(1, Math.round(canvas.height * scale));
    const tctx = tmp.getContext("2d");
    tctx.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in tctx) tctx.imageSmoothingQuality = "high";
    tctx.drawImage(canvas, 0, 0, tmp.width, tmp.height);
    canvas.width = tmp.width;
    canvas.height = tmp.height;
    canvas.getContext("2d").drawImage(tmp, 0, 0);
    tmp.width = 0; tmp.height = 0;
    return canvas;
}

// === BRICKONAS PDF UPLOAD INTEGRATION ===
// Cross-origin parent: we cannot read window.parent.BK_MOSAIC_UPLOADER directly.
// Instead, the parent page injects the config via a postMessage on iframe load,
// or we fetch the config directly from the WordPress REST endpoint.
let _bkUploaderConfig = null;

async function getMosaicUploaderConfig() {
    if (_bkUploaderConfig !== null) return _bkUploaderConfig === false ? null : _bkUploaderConfig;
    try {
        // Hard-coded brickonas.info — the configurator is only embedded on this domain.
        const res = await fetch('https://brickonas.info/wp-json/bk-mosaic/v1/status', {
            method: 'GET',
            credentials: 'omit',
            cache: 'no-store',
        });
        if (!res.ok) {
            _bkUploaderConfig = false;
            return null;
        }
        const data = await res.json();
        if (data && data.enabled) {
            _bkUploaderConfig = {
                enabled: true,
                initUrl: 'https://brickonas.info/wp-json/bk-mosaic/v1/init-upload',
                uploadUrl: 'https://brickonas.info/wp-json/bk-mosaic/v1/upload-pdf',
            };
            return _bkUploaderConfig;
        }
    } catch (err) {
        console.warn('[BRICKONAS] Could not fetch uploader status:', err);
    }
    _bkUploaderConfig = false;
    return null;
}

// Generate PDF as Blob (same logic as download flow but returns blob instead of saving).
async function generateInstructionsAsBlob() {
    const instructionsCanvasContainer = document.getElementById("instructions-canvas-container");
    instructionsCanvasContainer.innerHTML = "";
    updatePlateDimensions();

    // step4Canvas is not auto-populated until runStep4 is called.
    // Wrap the full generation in runStep4 to ensure all pixel data is ready.
    return new Promise((resolve, reject) => {
        runStep4(async () => {
            try {
                const blob = await _generateBlobFromStep4();
                resolve(blob);
            } catch (err) {
                reject(err);
            }
        });
    });
}

async function _generateBlobFromStep4() {
    const instructionsCanvasContainer = document.getElementById("instructions-canvas-container");

    // Always upload in high quality — this is the printable copy delivered with the kit.
    const isHighQuality = true;
    const step4PixelArray = getPixelArrayFromCanvas(step4Canvas);
    const resultImage = isBleedthroughEnabled()
        ? revertDarkenedImage(step4PixelArray, getDarkenedStudsToStuds(ALL_BRICKLINK_SOLID_COLORS.map((c) => c.hex)))
        : step4PixelArray;

    const titlePageCanvas = document.createElement("canvas");
    instructionsCanvasContainer.appendChild(titlePageCanvas);
    const studMap = getUsedPixelsStudMap(resultImage);
    const filteredAvailableStudHexList = selectedSortedStuds
        .filter((h) => (studMap[h] || 0) > 0)
        .filter((item, pos, self) => self.indexOf(item) === pos);

    // Use a higher scaling factor for the title page so it's sharp even for large mosaics.
    // The global SCALING_FACTOR is capped to keep on-screen canvases ≤4096px (mobile).
    // For PDF-only the canvas can be larger; we use min 25, max 40.
    const TITLE_SCALING = Math.max(25, Math.min(40, BASE_SCALING_FACTOR));
    generateInstructionTitlePage(resultImage, targetResolution[0], PLATE_WIDTH, PLATE_HEIGHT,
        filteredAvailableStudHexList, TITLE_SCALING, step4CanvasUpscaled, titlePageCanvas,
        selectedPixelPartNumber, PIXEL_WIDTH_CM);
    setDPI(titlePageCanvas, isHighQuality ? HIGH_DPI : LOW_DPI);

    // Adaptive JPEG quality based on mosaic size:
    // - Small mosaics (≤96): use 0.96 — file is small anyway, prioritize quality
    // - Medium (≤192): 0.92 — balanced
    // - Large (≥192): 0.88 — needed to stay under 120 MB upload limit
    // The title page (overview) gets higher quality since that's what you see at-a-glance.
    const totalNoppen = targetResolution[0] * targetResolution[1];
    const JPEG_QUALITY_PAGES = totalNoppen <= 96 * 96 ? 0.96
                             : totalNoppen <= 192 * 192 ? 0.92
                             : 0.88;
    const JPEG_QUALITY_TITLE = totalNoppen <= 96 * 96 ? 0.97
                             : totalNoppen <= 192 * 192 ? 0.95
                             : 0.93; // title gets a quality bonus — it's the showpiece
    // Enforce a minimum page size so large mosaics don't get tiny pages.
    // A4 is 210x297mm, A3 is 297x420mm. We use 1000x1000mm (1m square) so
    // print quality stays high for any mosaic size — instructions are clearly
    // readable when printed.
    const MIN_PAGE_W = 1000;
    const MIN_PAGE_H = 1000;
    // Always at least 1m × 1m — never use the canvas size if it's smaller.
    const pageW = Math.max(titlePageCanvas.width, MIN_PAGE_W);
    const pageH = Math.max(titlePageCanvas.height, MIN_PAGE_H);
    const imgData = titlePageCanvas.toDataURL("image/jpeg", JPEG_QUALITY_TITLE);
    // HYBRID rendering (see loop below): dense plate-OVERVIEW pages are raster
    // JPEGs, sparse DETAIL pages are vectors. Because no page now carries a huge
    // vector stream, compression is safe to enable — jsPDF 1.5.3's flate only
    // corrupted the ~2300-stud overview streams, which are no longer vector.
    // Compression keeps big mosaics (288×288 → 361 pages) small AND viewer-
    // friendly (Preview chokes on hundreds of thousands of uncompressed circles).
    let pdf = new jsPDF({
        orientation: pageW < pageH ? "p" : "l",
        unit: "mm",
        format: [pageW, pageH],
        compress: true,
    });
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = pdf.internal.pageSize.getHeight();
    const totalPlates = resultImage.length / (4 * PLATE_WIDTH * PLATE_WIDTH);
    // Center the title image on the page if image is smaller than page
    const titleImgRatio = titlePageCanvas.width / titlePageCanvas.height;
    let titleW = pdfWidth;
    let titleH = pdfWidth / titleImgRatio;
    if (titleH > pdfHeight) {
        titleH = pdfHeight;
        titleW = pdfHeight * titleImgRatio;
    }
    const titleX = (pdfWidth - titleW) / 2;
    const titleY = (pdfHeight - titleH) / 2;
    pdf.addImage(imgData, "JPEG", titleX, titleY, titleW, titleH);
    titlePageCanvas.remove();

    // For instruction pages, force max scaling factor regardless of mosaic size.
    // Each plate page is only 16x16 studs, so canvas is 16*40=640px max — safe on mobile.
    // This ensures plate pages are sharp even for large mosaics where global SCALING_FACTOR drops.
    const PRINT_SCALING = 40;
    // Detail-block size: split each plate into BLOCK_SIZE × BLOCK_SIZE sub-pages
    // so each readable build step matches one 16×16 stud area (≈ one mini-baseplate).
    // Only applied when the plate is a multiple of BLOCK_SIZE; otherwise we keep
    // a single plate page (small plates like 16×16 are already readable).
    const BLOCK_SIZE = 16;
    // Render the (geometry-only) plate/detail pages as VECTORS instead of large
    // JPEGs. This is the key upload-speed optimisation: a 144×144 mosaic dropped
    // from ~73 MB of embedded JPEGs to a small vector PDF, while the on-page
    // layout is byte-for-byte the same (the shim reuses generateInstructionPage
    // and reproduces the raster "fit image centred on page" placement). The title
    // page stays raster because it embeds the real preview photo + logo bitmap.
    const useVector = typeof window.bkDrawInstructionPageVector === "function";
    for (var i = 0; i < totalPlates; i++) {
        await sleep(10);
        pdf.addPage();
        const subPixelArray = getSubPixelArray(resultImage, i, targetResolution[0], PLATE_WIDTH);
        const row = Math.floor((i * PLATE_WIDTH) / targetResolution[0]);
        const col = i % (targetResolution[0] / PLATE_WIDTH);
        const variablePixelPieceDimensionsForPage = step3VariablePixelPieceDimensions == null
            ? null
            : getSubPixelMatrix(step3VariablePixelPieceDimensions, col * PLATE_WIDTH, row * PLATE_WIDTH, PLATE_WIDTH, PLATE_WIDTH);

        // Plate overview page (full PLATE_WIDTH × PLATE_WIDTH) — keeps customer
        // orientation. VECTOR: packs PLATE_WIDTH² studs (2304 at 48×48) as crisp
        // vector circles+numbers (no pixelation at any zoom). This is only viable
        // because jsPDF 2.x's deflate compresses the dense stream correctly (jsPDF
        // 1.5.3's flate corrupted it → "Bad block header" → blank page, which is why
        // overviews used to be raster JPEGs). See index.html jsPDF version note.
        if (useVector) {
            bkDrawInstructionPageVector(pdf, subPixelArray, PLATE_WIDTH, filteredAvailableStudHexList, PRINT_SCALING,
                i + 1, selectedPixelPartNumber, variablePixelPieceDimensionsForPage,
                pdfWidth, pdfHeight, null, PRINT_SCALING);
        } else {
            await drawPdfInstructionPage(pdf, subPixelArray, PLATE_WIDTH, filteredAvailableStudHexList, PRINT_SCALING,
                i + 1, selectedPixelPartNumber, variablePixelPieceDimensionsForPage,
                pdfWidth, pdfHeight, isHighQuality, JPEG_QUALITY_PAGES, null, null,
                BK_OVERVIEW_MAX_PX, BK_OVERVIEW_JPEG_Q);
        }

        // Detail sub-pages: split the plate into BLOCK_SIZE × BLOCK_SIZE blocks.
        const blocksPerSide = PLATE_WIDTH / BLOCK_SIZE;
        if (blocksPerSide > 1 && Number.isInteger(blocksPerSide)) {
            let blockIdx = 0;
            for (let br = 0; br < blocksPerSide; br++) {
                for (let bc = 0; bc < blocksPerSide; bc++) {
                    blockIdx++;
                    await sleep(10);
                    pdf.addPage();
                    const blockArray = getSubBlockFromPlate(subPixelArray, PLATE_WIDTH, bc, br, BLOCK_SIZE);
                    const blockVariableDims = variablePixelPieceDimensionsForPage == null
                        ? null
                        : getSubPixelMatrix(variablePixelPieceDimensionsForPage, bc * BLOCK_SIZE, br * BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE);
                    const blockLabel = `${i + 1}.${blockIdx}`;
                    const overviewContext = {
                        fullPlateArray: subPixelArray,
                        plateWidth: PLATE_WIDTH,
                        blockCol: bc,
                        blockRow: br,
                        blockSize: BLOCK_SIZE,
                    };
                    // Scale up so the detail canvas matches the plate canvas size
                    // (otherwise jsPDF stretches the smaller canvas across the same
                    // page and the studs end up looking 3× too big).
                    const detailScaling = PRINT_SCALING * (PLATE_WIDTH / BLOCK_SIZE);
                    // But keep the legend at the plate scale so it doesn't grow 3×.
                    if (useVector) {
                        bkDrawInstructionPageVector(pdf, blockArray, BLOCK_SIZE, filteredAvailableStudHexList, detailScaling,
                            blockLabel, selectedPixelPartNumber, blockVariableDims,
                            pdfWidth, pdfHeight, overviewContext, PRINT_SCALING);
                    } else {
                        await drawPdfInstructionPage(pdf, blockArray, BLOCK_SIZE, filteredAvailableStudHexList, detailScaling,
                            blockLabel, selectedPixelPartNumber, blockVariableDims,
                            pdfWidth, pdfHeight, isHighQuality, JPEG_QUALITY_PAGES, overviewContext, PRINT_SCALING);
                    }
                }
            }
        }
    }
    addWaterMark(pdf, isHighQuality);
    return pdf.output("blob");
}

// Render one instruction page (plate overview or detail block) into the PDF.
async function drawPdfInstructionPage(pdf, pixelArray, plateWidth, availableStudHexList, scaling,
                                       label, pixelType, variableDims,
                                       pdfWidth, pdfHeight, isHighQuality, jpegQuality, overviewContext, legendScalingOverride,
                                       rasterMaxDim, rasterJpegQuality) {
    const canvas = document.createElement("canvas");
    generateInstructionPage(pixelArray, plateWidth, availableStudHexList, scaling,
        canvas, label, pixelType, variableDims, overviewContext, legendScalingOverride);
    setDPI(canvas, isHighQuality ? HIGH_DPI : LOW_DPI);
    if (rasterMaxDim) bkCapCanvasToMaxDim(canvas, rasterMaxDim);
    const imgData = canvas.toDataURL("image/jpeg", rasterJpegQuality || jpegQuality);
    const ratio = canvas.width / canvas.height;
    let drawW = pdfWidth;
    let drawH = pdfWidth / ratio;
    if (drawH > pdfHeight) {
        drawH = pdfHeight;
        drawW = pdfHeight * ratio;
    }
    const drawX = (pdfWidth - drawW) / 2;
    const drawY = (pdfHeight - drawH) / 2;
    pdf.addImage(imgData, "JPEG", drawX, drawY, drawW, drawH);
    canvas.width = 0;
    canvas.height = 0;
}

// Upload PDF blob to WordPress, returns token on success, or null on failure.
async function uploadMosaicPdfToServer(blob, statusEl) {
    const cfg = await getMosaicUploaderConfig();
    if (!cfg || !cfg.enabled) return null;
    try {
        if (statusEl) {
            statusEl.className = 'mosaic-order-status';
            statusEl.innerHTML = 'Anleitung wird vorbereitet...';
        }
        const initRes = await fetch(cfg.initUrl, { method: 'POST' });
        if (!initRes.ok) throw new Error('init failed: ' + initRes.status);
        const initData = await initRes.json();
        const token = initData.token;
        if (!token) throw new Error('no token returned');

        const fd = new FormData();
        fd.append('token', token);
        fd.append('file', blob, 'mosaik-anleitung.pdf');
        const upRes = await fetch(cfg.uploadUrl, { method: 'POST', body: fd });
        if (!upRes.ok) {
            const text = await upRes.text();
            throw new Error('upload failed ' + upRes.status + ': ' + text.substring(0, 200));
        }
        const upData = await upRes.json();
        if (!upData.success) throw new Error('upload not successful');
        console.log('[BRICKONAS] PDF uploaded, token:', token, 'size:', upData.size);
        return token;
    } catch (err) {
        console.error('[BRICKONAS] PDF upload error:', err);
        return null;
    }
}

async function generateInstructions() {
    const instructionsCanvasContainer = document.getElementById("instructions-canvas-container");
    instructionsCanvasContainer.innerHTML = "";
    disableInteraction();
    runStep4(async () => {
        try {
            // Update plate dimensions based on current step selector values
            updatePlateDimensions();
            
            const isHighQuality = document.getElementById("high-quality-instructions-check").checked;
            // Use the SAME fixed print scalings as the order-upload path
            // (_generateBlobFromStep4). The global SCALING_FACTOR is capped small
            // for large mosaics (to keep on-screen canvases ≤4096px), which made the
            // admin-download title/overview canvases tiny → portrait page, clipped
            // plate-grid, and low-res overviews. These constants decouple the PDF
            // pages from the on-screen scale so the download matches the order PDF.
            const PRINT_SCALING = 40;
            const TITLE_SCALING = Math.max(25, Math.min(40, BASE_SCALING_FACTOR));
            const ADMIN_MIN_PAGE = 1000;
            const step4PixelArray = getPixelArrayFromCanvas(step4Canvas);
            const resultImage = isBleedthroughEnabled()
                ? revertDarkenedImage(
                      step4PixelArray,
                      getDarkenedStudsToStuds(ALL_BRICKLINK_SOLID_COLORS.map((color) => color.hex))
                  )
                : step4PixelArray;

            const titlePageCanvas = document.createElement("canvas");
            instructionsCanvasContainer.appendChild(titlePageCanvas);
            const studMap = getUsedPixelsStudMap(resultImage);
            const filteredAvailableStudHexList = selectedSortedStuds
                .filter((pixelHex) => (studMap[pixelHex] || 0) > 0)
                .filter(function (item, pos, self) {
                    return self.indexOf(item) === pos; // remove duplicates
                });
            generateInstructionTitlePage(
                resultImage,
                targetResolution[0],
                PLATE_WIDTH,
                PLATE_HEIGHT,
                filteredAvailableStudHexList,
                TITLE_SCALING,
                step4CanvasUpscaled,
                titlePageCanvas,
                selectedPixelPartNumber,
                PIXEL_WIDTH_CM
            );
            setDPI(titlePageCanvas, isHighQuality ? HIGH_DPI : LOW_DPI);

        // JPEG instead of PNG: cuts PDF size ~20× for instruction pages.
        // Quality tuned to match the customer-order path (_generateBlobFromStep4).
        const totalNoppen = targetResolution[0] * targetResolution[1];
        const JPEG_QUALITY_PAGES = totalNoppen <= 96 * 96 ? 0.96
                                 : totalNoppen <= 192 * 192 ? 0.92
                                 : 0.88;
        const JPEG_QUALITY_TITLE = totalNoppen <= 96 * 96 ? 0.97
                                 : totalNoppen <= 192 * 192 ? 0.95
                                 : 0.93;
        const imgData = titlePageCanvas.toDataURL("image/jpeg", JPEG_QUALITY_TITLE);

        // Same vector optimisation as the order-upload path: render geometry-only
        // plate/detail pages as vectors so the downloaded PDF is tiny and fast.
        const useVector = typeof window.bkDrawInstructionPageVector === "function";
        // Enforce a minimum page size (1m square) so large mosaics never get a tiny
        // page — mirrors the order-upload path. The page format is derived from the
        // title canvas but never smaller than ADMIN_MIN_PAGE in either dimension.
        const pageW = Math.max(titlePageCanvas.width, ADMIN_MIN_PAGE);
        const pageH = Math.max(titlePageCanvas.height, ADMIN_MIN_PAGE);
        // compress ON — safe with the hybrid renderer (only sparse detail pages are
        // vector; dense overviews are raster JPEG). See note in _generateBlobFromStep4.
        let pdf = new jsPDF({
            orientation: pageW < pageH ? "p" : "l",
            unit: "mm",
            format: [pageW, pageH],
            compress: true,
        });

        const pdfWidth = pdf.internal.pageSize.getWidth();
        const pdfHeight = pdf.internal.pageSize.getHeight();

        const totalPlates = resultImage.length / (4 * PLATE_WIDTH * PLATE_WIDTH);

        document.getElementById("pdf-progress-bar").style.width = `${100 / (totalPlates + 1)}%`;

        document.getElementById("pdf-progress-bar").style.width = "0%";
        document.getElementById("pdf-progress-container").hidden = false;
        document.getElementById("download-instructions-button").hidden = true;

        // Fit-center the title image on the page (matches the order-upload path and
        // the vector pages' placement so every page lines up identically).
        const titleRatio = titlePageCanvas.width / titlePageCanvas.height;
        let titleW = pdfWidth;
        let titleH = pdfWidth / titleRatio;
        if (titleH > pdfHeight) { titleH = pdfHeight; titleW = pdfHeight * titleRatio; }
        pdf.addImage(imgData, "JPEG", (pdfWidth - titleW) / 2, (pdfHeight - titleH) / 2, titleW, titleH);

        // Remove title page canvas from DOM to free memory
        titlePageCanvas.remove();

        // Render one page (plate overview or 16x16 detail) into the current pdf.
        // overviewContext (optional): { fullPlateArray, plateWidth, blockCol, blockRow, blockSize }
        // triggers a small thumbnail with the current block highlighted.
        // ALL geometry pages → vector (both dense plate-overviews AND 16×16 detail
        // blocks). Crisp at any zoom, no pixelation. Safe now that jsPDF 2.x's deflate
        // compresses the dense ~2300-stud overview stream correctly (jsPDF 1.5.3's
        // flate corrupted it → blank pages, which forced overviews to raster JPEG).
        const renderPageToPdf = (pixelArrayForPage, plateWidthForPage, label, variableDims, overviewContext, scalingOverride, legendScalingOverride) => {
            if (useVector) {
                bkDrawInstructionPageVector(
                    pdf,
                    pixelArrayForPage,
                    plateWidthForPage,
                    filteredAvailableStudHexList,
                    scalingOverride || PRINT_SCALING,
                    label,
                    selectedPixelPartNumber,
                    variableDims,
                    pdfWidth,
                    pdfHeight,
                    overviewContext,
                    legendScalingOverride
                );
                return;
            }
            const instructionPageCanvas = document.createElement("canvas");
            generateInstructionPage(
                pixelArrayForPage,
                plateWidthForPage,
                filteredAvailableStudHexList,
                scalingOverride || PRINT_SCALING,
                instructionPageCanvas,
                label,
                selectedPixelPartNumber,
                variableDims,
                overviewContext,
                legendScalingOverride
            );
            setDPI(instructionPageCanvas, isHighQuality ? HIGH_DPI : LOW_DPI);
            // This raster branch only runs for plate-overview pages (no
            // overviewContext) — downscale them so the JPEG is small.
            if (!overviewContext) bkCapCanvasToMaxDim(instructionPageCanvas, BK_OVERVIEW_MAX_PX);
            const pageImgData = instructionPageCanvas.toDataURL("image/jpeg",
                !overviewContext ? BK_OVERVIEW_JPEG_Q : JPEG_QUALITY_PAGES);
            // Fit-center on the page exactly like the vector pages (bkDraw…Vector)
            // and the order-upload path, so overview + detail pages align.
            const pgRatio = instructionPageCanvas.width / instructionPageCanvas.height;
            let pgW = pdfWidth;
            let pgH = pdfWidth / pgRatio;
            if (pgH > pdfHeight) { pgH = pdfHeight; pgW = pdfHeight * pgRatio; }
            pdf.addImage(
                pageImgData,
                "JPEG",
                (pdfWidth - pgW) / 2,
                (pdfHeight - pgH) / 2,
                pgW,
                pgH
            );
            instructionPageCanvas.width = 0;
            instructionPageCanvas.height = 0;
        };

        // Detail-block size: split each plate into BLOCK_SIZE × BLOCK_SIZE sub-pages
        // so each readable build step matches one 16×16 stud area. Only when the
        // plate is a clean multiple of BLOCK_SIZE (small plates stay single-page).
        const BLOCK_SIZE = 16;

        // Build a flat list of pages so the multi-part splitter (every N pages)
        // works the same way as before, regardless of how many sub-pages we add.
        const pageJobs = [];
        for (var i = 0; i < totalPlates; i++) {
            const subPixelArray = getSubPixelArray(resultImage, i, targetResolution[0], PLATE_WIDTH);
            const row = Math.floor((i * PLATE_WIDTH) / targetResolution[0]);
            const col = i % (targetResolution[0] / PLATE_WIDTH);
            const variablePixelPieceDimensionsForPage =
                step3VariablePixelPieceDimensions == null
                    ? null
                    : getSubPixelMatrix(
                          step3VariablePixelPieceDimensions,
                          col * PLATE_WIDTH,
                          row * PLATE_WIDTH,
                          PLATE_WIDTH,
                          PLATE_WIDTH
                      );
            // Plate overview
            pageJobs.push({
                pixels: subPixelArray,
                width: PLATE_WIDTH,
                label: i + 1,
                variableDims: variablePixelPieceDimensionsForPage,
                legendScalingOverride: PRINT_SCALING,
            });
            // Detail sub-pages (only if plate cleanly divides into 16×16 blocks)
            const blocksPerSide = PLATE_WIDTH / BLOCK_SIZE;
            if (blocksPerSide > 1 && Number.isInteger(blocksPerSide)) {
                let blockIdx = 0;
                for (let br = 0; br < blocksPerSide; br++) {
                    for (let bc = 0; bc < blocksPerSide; bc++) {
                        blockIdx++;
                        const blockArray = getSubBlockFromPlate(subPixelArray, PLATE_WIDTH, bc, br, BLOCK_SIZE);
                        const blockVariableDims = variablePixelPieceDimensionsForPage == null
                            ? null
                            : getSubPixelMatrix(variablePixelPieceDimensionsForPage, bc * BLOCK_SIZE, br * BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE);
                        pageJobs.push({
                            pixels: blockArray,
                            width: BLOCK_SIZE,
                            label: `${i + 1}.${blockIdx}`,
                            variableDims: blockVariableDims,
                            // Match plate canvas size: detail block × 3 ≈ plate × 1 (at 48/16)
                            scalingOverride: PRINT_SCALING * (PLATE_WIDTH / BLOCK_SIZE),
                            // Keep the legend at the plate scale (smaller) instead of growing 3×.
                            legendScalingOverride: PRINT_SCALING,
                            overviewContext: {
                                fullPlateArray: subPixelArray,
                                plateWidth: PLATE_WIDTH,
                                blockCol: bc,
                                blockRow: br,
                                blockSize: BLOCK_SIZE,
                            },
                        });
                    }
                }
            }
        }

        let numParts = 1;
        for (var p = 0; p < pageJobs.length; p++) {
            await sleep(10);

            // Vector pages are tiny, so we never need to split into multiple files
            // (splitting only existed to cap per-file JPEG memory). Keep the legacy
            // split for the raster fallback path.
            if (!useVector && (p + 1) % (isHighQuality ? 20 : 50) === 0) {
                addWaterMark(pdf, isHighQuality);
                pdf.save(`${t('pdfFilename')}-${t('pdfInstructions')}-${t('pdfPart')}-${numParts}.pdf`);
                numParts++;
                pdf = new jsPDF({
                    orientation: pageW < pageH ? "p" : "l",
                    unit: "mm",
                    format: [pageW, pageH],
                    compress: true,
                });
            } else {
                pdf.addPage();
            }

            document.getElementById("pdf-progress-bar").style.width = `${((p + 2) * 100) / (pageJobs.length + 1)}%`;

            const job = pageJobs[p];
            renderPageToPdf(job.pixels, job.width, job.label, job.variableDims, job.overviewContext, job.scalingOverride, job.legendScalingOverride);
        }

        addWaterMark(pdf, isHighQuality);
        pdf.save(numParts > 1 ? `${t('pdfFilename')}-${t('pdfInstructions')}-${t('pdfPart')}-${numParts}.pdf` : `${t('pdfFilename')}-${t('pdfInstructions')}.pdf`);
        document.getElementById("pdf-progress-container").hidden = true;
        document.getElementById("download-instructions-button").hidden = false;
        enableInteraction();

        if (perfLoggingDatabase) {
            perfLoggingDatabase.ref("instructions-generated-count/total").transaction(incrementTransaction);
            const loggingTimestamp = Math.floor((Date.now() - (Date.now() % 8.64e7)) / 1000);
            perfLoggingDatabase.ref("instructions-generated-count/per-day/" + loggingTimestamp).transaction(incrementTransaction);
        }
        } catch (error) {
            console.error("Error generating PDF instructions:", error);
            document.getElementById("pdf-progress-container").hidden = true;
            document.getElementById("download-instructions-button").hidden = false;
            enableInteraction();
            alert("Die Anleitung konnte nicht erstellt werden. Bei sehr hohen Auflösungen hilft es, eine kleinere Auflösung zu wählen oder es noch einmal zu versuchen.");
        }
    });
}

function getUsedPlateMatrices(depthPixelArray) {
    const availableParts = [...document.getElementById("depth-plates-container").children]
        .map((div) => div.children[0])
        .map((label) => label.children[0])
        .filter((input) => input.checked)
        .map((input) => input.name)
        .map((part) => part.split(PLATE_DIMENSIONS_DEPTH_SEPERATOR).map((dimension) => Number(dimension)));
    const flippedParts = [];
    availableParts.forEach((part) => {
        if (part[0] !== part[1]) {
            flippedParts.push([part[1], part[0]]);
        }
    });
    flippedParts.forEach((part) => availableParts.push(part));
    const usedPlatesMatrices = [];
    for (
        let row = 0; // for each row of plates
        row < Math.ceil(targetResolution[1] / PLATE_WIDTH); // round up
        row++
    ) {
        for (
            let col = 0; // for each column of plates
            col < Math.ceil(targetResolution[0] / PLATE_WIDTH); // round up
            col++
        ) {
            const horizontalOffset = col * PLATE_WIDTH;
            const verticalOffset = row * PLATE_WIDTH;
            const depthSubPixelMatrix = getDepthSubPixelMatrix(
                depthPixelArray,
                targetResolution[0],
                horizontalOffset,
                verticalOffset,
                Math.min(PLATE_WIDTH, targetResolution[0] - horizontalOffset),
                Math.min(PLATE_WIDTH, targetResolution[1] - verticalOffset)
            );
            const perDepthLevelMatrices = [];
            for (
                let depthLevel = 0; // for each depth level
                depthLevel < Number(document.getElementById("num-depth-levels-slider").value) - 1;
                depthLevel++
            ) {
                const setPixelMatrix = getSetPixelMatrixFromInputMatrix(
                    depthSubPixelMatrix,
                    (depthPixel, _i, _j) => depthPixel <= depthLevel
                );
                perDepthLevelMatrices.push(getRequiredPartMatrixFromSetPixelMatrix(setPixelMatrix, availableParts));
            }
            usedPlatesMatrices.push(perDepthLevelMatrices);
        }
    }
    return usedPlatesMatrices;
}

async function generateDepthInstructions() {
    const instructionsCanvasContainer = document.getElementById("depth-instructions-canvas-container");
    instructionsCanvasContainer.innerHTML = "";
    disableInteraction();

    runStep4(async () => {
        try {
            // Update plate dimensions based on current step selector values
            updatePlateDimensions();
        
        const isHighQuality = document.getElementById("high-quality-depth-instructions-check").checked;
        const depthPixelArray = getPixelArrayFromCanvas(step3DepthCanvas);

        const usedPlatesMatrices = getUsedPlateMatrices(depthPixelArray);

        document.getElementById("depth-pdf-progress-bar").style.width = `${0}%`;

        document.getElementById("depth-pdf-progress-bar").style.width = "0%";
        document.getElementById("depth-pdf-progress-container").hidden = false;
        document.getElementById("download-depth-instructions-button").hidden = true;

        const titlePageCanvas = document.createElement("canvas");
        instructionsCanvasContainer.innerHTML = "";
        instructionsCanvasContainer.appendChild(titlePageCanvas);
        generateDepthInstructionTitlePage(
            usedPlatesMatrices,
            targetResolution,
            SCALING_FACTOR,
            titlePageCanvas,
            step3DepthCanvasUpscaled,
            PLATE_WIDTH
        );
        setDPI(titlePageCanvas, isHighQuality ? HIGH_DPI : LOW_DPI);

        const imgData = titlePageCanvas.toDataURL("image/png", 1.0);

        let pdf = new jsPDF({
            orientation: titlePageCanvas.width < titlePageCanvas.height ? "p" : "l",
            unit: "mm",
            format: [titlePageCanvas.width, titlePageCanvas.height],
        });

        pdf.addImage(imgData, "PNG", 0, 0, pdf.internal.pageSize.getWidth(), pdf.internal.pageSize.getHeight());
        
        // Remove title page canvas from DOM to free memory
        titlePageCanvas.remove();

        let numParts = 1;
        for (let i = 0; i < usedPlatesMatrices.length; i++) {
            // Yield to browser to prevent UI freeze and allow garbage collection
            await sleep(10);

            if ((i + 1) % (isHighQuality ? 20 : 50) === 0) {
                if (pdf != null) {
                    addWaterMark(pdf, isHighQuality);
                    pdf.save(`${t('pdfFilename')}-${t('pdfInstructions')}-${t('pdfPart')}-${numParts}.pdf`);

                    numParts++;
                }
                pdf = new jsPDF({
                    orientation: titlePageCanvas.width < titlePageCanvas.height ? "p" : "l",
                    unit: "mm",
                    format: [titlePageCanvas.width, titlePageCanvas.height],
                });
            } else {
                pdf.addPage();
            }

            const instructionPageCanvas = document.createElement("canvas");
            // Don't append to DOM - just use it for rendering

            perDepthLevelMatrices = usedPlatesMatrices[i];
            generateDepthInstructionPage(perDepthLevelMatrices, SCALING_FACTOR, instructionPageCanvas, i + 1);
            setDPI(instructionPageCanvas, isHighQuality ? HIGH_DPI : LOW_DPI);

            // Use correct MIME type for image conversion
            const pageImgData = instructionPageCanvas.toDataURL("image/png", 1.0);

            pdf.addImage(pageImgData, "PNG", 0, 0, pdf.internal.pageSize.getWidth(), pdf.internal.pageSize.getHeight());

            // Clear canvas to free memory
            instructionPageCanvas.width = 0;
            instructionPageCanvas.height = 0;

            document.getElementById("depth-pdf-progress-bar").style.width = `${
                ((i + 1) * 100) / (usedPlatesMatrices.length + 1)
            }%`;
        }

        addWaterMark(pdf, isHighQuality);
        pdf.save(numParts > 1 ? `${t('pdfFilename')}-${t('pdfInstructions')}-${t('pdfPart')}-${numParts}.pdf` : `${t('pdfFilename')}-${t('pdfInstructions')}.pdf`);
        document.getElementById("depth-pdf-progress-container").hidden = true;
        document.getElementById("download-depth-instructions-button").hidden = false;
        enableInteraction();

        if (perfLoggingDatabase) {
            perfLoggingDatabase.ref("depth-instructions-generated-count/total").transaction(incrementTransaction);
            const loggingTimestamp = Math.floor((Date.now() - (Date.now() % 8.64e7)) / 1000);
            perfLoggingDatabase.ref("depth-instructions-generated-count/per-day/" + loggingTimestamp).transaction(incrementTransaction);
        }
        } catch (error) {
            console.error("Error generating depth PDF instructions:", error);
            document.getElementById("depth-pdf-progress-container").hidden = true;
            document.getElementById("download-depth-instructions-button").hidden = false;
            enableInteraction();
            alert("Die Anleitung konnte nicht erstellt werden. Bei sehr hohen Auflösungen hilft es, eine kleinere Auflösung zu wählen oder es noch einmal zu versuchen.");
        }
    });
}


document.getElementById("download-instructions-button").addEventListener("click", async () => {
    await generateInstructions();
});

// Admin-only PDF download: revealed when URL contains ?admin=<token>.
// Lets Denis grab the build-instructions PDF without going through checkout
// (e.g. for live demos at events). Token is intentionally a shared secret —
// not a real auth system; the PDF itself is non-sensitive.
(function initAdminDownload() {
    var ADMIN_TOKEN = "jonas-michel-denis";
    try {
        var token = new URLSearchParams(window.location.search).get("admin");
        if (token !== ADMIN_TOKEN) return;

        // --- PDF download panel ---
        var panel = document.getElementById("mosaic-admin-download");
        var btn = document.getElementById("admin-download-pdf-button");
        if (!panel || !btn) return;
        panel.hidden = false;
        btn.addEventListener("click", async function () {
            var orig = btn.textContent;
            btn.disabled = true;
            btn.textContent = "Anleitung wird erstellt…";
            try {
                await generateInstructions();
            } catch (err) {
                console.error("Admin PDF download failed:", err);
                alert("PDF-Erstellung fehlgeschlagen. Konsole für Details öffnen.");
            } finally {
                btn.disabled = false;
                btn.textContent = orig;
            }
        });

        // --- 16er plate option (admin-only) ---
        // Add 16 as a selectable step in both width and height selectors.
        // 16-stud plates use 16-stud increments; slider goes 16 → 288.
        ["width-step-select", "height-step-select"].forEach(function (id) {
            var sel = document.getElementById(id);
            if (!sel) return;
            var opt = document.createElement("option");
            opt.value = "16";
            opt.textContent = "16";
            sel.insertBefore(opt, sel.firstChild); // insert before 32
        });

    } catch (e) {
        console.warn("Admin download init failed:", e);
    }
})();

document.getElementById("download-depth-instructions-button").addEventListener("click", async () => {
    await generateDepthInstructions();
});

document.getElementById("export-depth-to-bricklink-button").addEventListener("click", () => {
    disableInteraction();
    const depthPixelArray = getPixelArrayFromCanvas(step3DepthCanvas);
    const usedPlatesMatrices = getUsedPlateMatrices(depthPixelArray);
    const depthPartsMap = getUsedDepthPartsMap(usedPlatesMatrices.flat());

    navigator.clipboard.writeText(getDepthWantedListXML(depthPartsMap)).then(
        function () {
            enableInteraction();
        },
        function (err) {
            console.error("Async: Could not copy text: ", err);
        }
    );
});

function triggerDepthMapGeneration() {
    alert("Depth map auto-generation is not available. Please upload your own depth map image.");
    return;
    disableInteraction();
    const worker = new Worker("js/depth-map-web-worker.js");

    const loadingMessageComponent = document.getElementById("web-worker-loading-message");
    loadingMessageComponent.hidden = false;

    webWorkerInputCanvas.width = CNN_INPUT_IMAGE_WIDTH;
    webWorkerInputCanvas.height = CNN_INPUT_IMAGE_HEIGHT;
    webWorkerInputCanvasContext.drawImage(
        inputImage,
        0,
        0,
        inputImage.width,
        inputImage.height,
        0,
        0,
        CNN_INPUT_IMAGE_WIDTH,
        CNN_INPUT_IMAGE_HEIGHT
    );
    setTimeout(() => {
        const inputPixelArray = getPixelArrayFromCanvas(webWorkerInputCanvas);
        worker.postMessage({
            inputPixelArray,
        });

        worker.addEventListener("message", (e) => {
            const { result, loadingMessage } = e.data;
            if (result != null) {
                webWorkerOutputCanvas.width = CNN_INPUT_IMAGE_WIDTH;
                webWorkerOutputCanvas.height = CNN_INPUT_IMAGE_HEIGHT;
                drawPixelsOnCanvas(result, webWorkerOutputCanvas);
                setTimeout(() => {
                    inputDepthCanvas.width = SERIALIZE_EDGE_LENGTH;
                    inputDepthCanvas.height = SERIALIZE_EDGE_LENGTH;
                    inputDepthCanvasContext.drawImage(
                        webWorkerOutputCanvas,
                        0,
                        0,
                        CNN_INPUT_IMAGE_WIDTH,
                        CNN_INPUT_IMAGE_HEIGHT,
                        0,
                        0,
                        SERIALIZE_EDGE_LENGTH,
                        SERIALIZE_EDGE_LENGTH
                    );
                    setTimeout(() => {
                        loadingMessageComponent.hidden = true;
                        enableInteraction();
                        overrideDepthPixelArray = new Array(targetResolution[0] * targetResolution[1] * 4).fill(null);
                        runStep1();
                    }, 50); // TODO: find better way to check that input is finished
                }, 50); // TODO: find better way to check that input is finished
            } else if (loadingMessage != null) {
                loadingMessageComponent.innerHTML = loadingMessage;
            } else {
                console.log("Message from web worker: ", e.data);
            }
        });
    }, 50); // TODO: find better way to check that input is finished
}

var generateDepthBtn = document.getElementById("generate-depth-image");
if (generateDepthBtn) generateDepthBtn.addEventListener("click", triggerDepthMapGeneration);

const SERIALIZE_EDGE_LENGTH = 512;

function handleInputImage(e, dontClearDepth, dontLog) {
    const reader = new FileReader();
    reader.onload = function (event) {
        inputImage = new Image();
        inputImage.onload = function () {
            inputCanvas.width = SERIALIZE_EDGE_LENGTH;
            inputCanvas.height = SERIALIZE_EDGE_LENGTH;
            inputCanvasContext.drawImage(
                inputImage,
                0,
                0,
                inputImage.width,
                inputImage.height,
                0,
                0,
                SERIALIZE_EDGE_LENGTH,
                SERIALIZE_EDGE_LENGTH
            );

            // remove transparency
            const inputImagePixels = getPixelArrayFromCanvas(inputCanvas);
            for (var i = 3; i < inputImagePixels.length; i += 4) {
                inputImagePixels[i] = 255;
            }
            drawPixelsOnCanvas(inputImagePixels, inputCanvas);

            if (!dontClearDepth) {
                inputDepthCanvas.width = SERIALIZE_EDGE_LENGTH;
                inputDepthCanvas.height = SERIALIZE_EDGE_LENGTH;
                inputDepthCanvasContext.fillStyle = "black";
                inputDepthCanvasContext.fillRect(0, 0, inputDepthCanvas.width, inputDepthCanvas.height);
            }

            // Draw upscaled canvas and initialize cropper now that
            // inputCanvas is guaranteed to have image data
            step1CanvasUpscaled.width = SERIALIZE_EDGE_LENGTH;
            step1CanvasUpscaled.height = Math.floor((SERIALIZE_EDGE_LENGTH * inputImage.height) / inputImage.width);
            step1CanvasUpscaledContext.drawImage(
                inputCanvas,
                0,
                0,
                SERIALIZE_EDGE_LENGTH,
                SERIALIZE_EDGE_LENGTH,
                0,
                0,
                step1CanvasUpscaled.width,
                step1CanvasUpscaled.height
            );

            overridePixelArray = new Array(targetResolution[0] * targetResolution[1] * 4).fill(null);
            overrideDepthPixelArray = new Array(targetResolution[0] * targetResolution[1] * 4).fill(null);
            initializeCropper();
            runStep1();
        };
        inputImage.src = event.target.result;
        // Show visual step 1 and stepper
        document.getElementById("visual-step-1").hidden = false;
        document.getElementById("visual-step-1").classList.add("active");
        document.getElementById("step-navigation").hidden = false;
        document.getElementById("input-image-selector").innerHTML = t('reselectInputImage');
        document.getElementById("image-input-new").appendChild(document.getElementById("image-input"));
        document.getElementById("image-input-card").hidden = true;
        // Also set old steps-row for backward compat
        var stepsRow = document.getElementById("steps-row");
        if (stepsRow) stepsRow.hidden = false;
        var exContainer = document.getElementById("run-example-input-container");
        if (exContainer) exContainer.hidden = true;

        if (!dontLog) {
            perfLoggingDatabase && perfLoggingDatabase.ref("input-image-count/total").transaction(incrementTransaction);
            const loggingTimestamp = Math.floor((Date.now() - (Date.now() % 8.64e7)) / 1000); // 8.64e+7 = ms in day
            perfLoggingDatabase && perfLoggingDatabase.ref("input-image-count/per-day/" + loggingTimestamp).transaction(incrementTransaction);
        }
    };
    reader.readAsDataURL(e.target.files[0]);
}

function handleInputDepthMapImage(e) {
    const reader = new FileReader();
    overrideDepthPixelArray = new Array(targetResolution[0] * targetResolution[1] * 4).fill(null);
    reader.onload = function (event) {
        inputImage = new Image();
        inputImage.onload = function () {
            inputDepthCanvas.width = SERIALIZE_EDGE_LENGTH;
            inputDepthCanvas.height = SERIALIZE_EDGE_LENGTH;
            inputDepthCanvasContext.drawImage(
                inputImage,
                0,
                0,
                inputImage.width,
                inputImage.height,
                0,
                0,
                SERIALIZE_EDGE_LENGTH,
                SERIALIZE_EDGE_LENGTH
            );
            runStep1();
        };
        inputImage.src = event.target.result;
    };
    reader.readAsDataURL(e.target.files[0]);
}


const imageURLMatch =
    window.location.href.match(
        /image=(https?((:\/\/)|(%3A%2F%2F)))?([-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)?)/gi
    ) ?? [];
const imageURL =
    imageURLMatch.length > 0 ? imageURLMatch[0].replace(/image=(https?((:\/\/)|(%3A%2F%2F)))?/gi, "") : null;

if (imageURL != null) {
    setTimeout(() => {
        fetch("https://" + decodeURIComponent(imageURL))
            .then((response) => response.blob())
            .then((colorImage) => {
                try {
                    // use an object url to get around possible bad browser caching race conditions
                    const colorImageURL = URL.createObjectURL(colorImage);
                    const e = {
                        target: {
                            files: [colorImage],
                        },
                    };
                    handleInputImage(e, true, true);
                } catch (e) {
                    enableInteraction();
                }
            })
            .catch((err) => {
                enableInteraction();
            });
    }, 50); // TODO: find better way to check that input is finished
}

const imageSelectorHidden = document.getElementById("input-image-selector-hidden");
imageSelectorHidden.addEventListener("change", (e) => handleInputImage(e), false);
document.getElementById("input-image-selector").addEventListener("click", () => {
    imageSelectorHidden.click();
});

// === Example image picker ===
// Loads a bundled example image and feeds it through the same handleInputImage
// path as a user file upload, so all downstream logic (cropping, resolution
// selection, mosaic generation) works identically.
(function setupExampleImagePicker() {
    var grid = document.getElementById("mosaic-examples-grid");
    if (!grid) return;

    // Hide individual cards whose image fails to load.
    grid.querySelectorAll(".mosaic-example-card img").forEach(function (img) {
        img.addEventListener("error", function () {
            var card = img.closest(".mosaic-example-card");
            if (card) card.style.display = "none";
        });
    });

    function loadExample(card) {
        if (card.classList.contains("is-loading")) return;
        var key = card.getAttribute("data-example");
        if (!key) return;
        var url = "assets/examples/" + key + ".jpg";
        card.classList.add("is-loading");

        fetch(url)
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.blob();
            })
            .then(function (blob) {
                var file = new File([blob], key + ".jpg", { type: blob.type || "image/jpeg" });
                var dt = new DataTransfer();
                dt.items.add(file);
                imageSelectorHidden.files = dt.files;
                // Enable selector buttons that may still be disabled (mirrors
                // the flow that runs after the algo finishes initializing).
                imageSelectorHidden.disabled = false;
                var btn = document.getElementById("input-image-selector");
                if (btn) btn.disabled = false;
                imageSelectorHidden.dispatchEvent(new Event("change", { bubbles: true }));
            })
            .catch(function (err) {
                console.error("[BRICKONAS] Example image load failed:", err);
                card.classList.remove("is-loading");
            });
    }

    grid.addEventListener("click", function (e) {
        var card = e.target.closest(".mosaic-example-card");
        if (card) loadExample(card);
    });
})();

// === Designservice button (step 2) ===
// When clicked, ask the parent WordPress page to redirect the top-level window
// to /kontakt/ with ref=mosaik-designservice. Falls back to a direct redirect
// if the iframe is somehow loaded standalone.
(function setupDesignserviceButton() {
    var btn = document.getElementById("bk-designservice-btn");
    if (!btn) return;
    btn.addEventListener("click", function () {
        var target = "/kontakt/?ref=mosaik-designservice";
        if (window.self !== window.top) {
            window.parent.postMessage({
                type: "mosaic-contact-redirect",
                ref: "mosaik-designservice",
                subject: "Mosaik Designservice"
            }, "*");
        } else {
            window.location.href = target;
        }
    });
})();

const depthImageSelectorHidden = document.getElementById("input-depth-image-selector-hidden");
depthImageSelectorHidden.addEventListener("change", handleInputDepthMapImage, false);
document.getElementById("input-depth-image-selector").addEventListener("click", () => {
    depthImageSelectorHidden.click();
});

window.addEventListener("appinstalled", () => {
    perfLoggingDatabase && perfLoggingDatabase.ref("pwa-install-count/total").transaction(incrementTransaction);
    const loggingTimestamp = Math.floor((Date.now() - (Date.now() % 8.64e7)) / 1000); // 8.64e+7 = ms in day
    perfLoggingDatabase && perfLoggingDatabase.ref("pwa-install-count/per-day/" + loggingTimestamp).transaction(incrementTransaction);
});

// Step Navigation System — 2-step visual flow, 4-step internal pipeline
// Visual Step 1 = Configure (internal step 1)
// Visual Step 2 = Farben verfeinern (HIDDEN — internal steps 2+3 still run)
// Visual Step 3 = Result (internal step 4)
let currentVisualStep = 1;
const stepProcessed = { 1: false, 2: false, 3: false, 4: false };

function showVisualStep(vstep) {
    // Hide all visual steps
    document.querySelectorAll('.visual-step').forEach(el => {
        el.classList.remove('active');
        el.hidden = true;
    });

    // Show target
    const target = document.getElementById('visual-step-' + vstep);
    if (target) {
        target.hidden = false;
        target.classList.add('active');
    }

    // Update stepper circles
    document.querySelectorAll('.mosaic-stepper-step').forEach(btn => {
        btn.classList.remove('active', 'completed');
    });
    var btn1 = document.getElementById('vstep-btn-1');
    var btn2 = document.getElementById('vstep-btn-2');
    var btn3 = document.getElementById('vstep-btn-3');

    if (vstep === 1) {
        if (btn1) btn1.classList.add('active');
    } else if (vstep === 2) {
        if (btn1) btn1.classList.add('completed');
        if (btn2) btn2.classList.add('active');
    } else if (vstep === 3) {
        if (btn1) btn1.classList.add('completed');
        if (btn2) btn2.classList.add('completed');
        if (btn3) btn3.classList.add('active');
    }

    currentVisualStep = vstep;
    document.dispatchEvent(new CustomEvent('bk-visual-step-change', { detail: { step: vstep } }));

    // When returning to step 1, Cropper.js must be fully reinitialized.
    // The hidden attribute (display:none) makes Cropper lose all internal
    // dimensions — resize() alone cannot recover from that.
    // We must also redraw the canvas from inputCanvas because destroy()
    // can clear canvas pixel data.
    if (vstep === 1 && inputImage && inputImageCropper) {
        // Redraw the upscaled canvas from the preserved inputCanvas source
        step1CanvasUpscaled.width = SERIALIZE_EDGE_LENGTH;
        step1CanvasUpscaled.height = Math.floor(
            (SERIALIZE_EDGE_LENGTH * inputImage.height) / inputImage.width
        );
        step1CanvasUpscaledContext.drawImage(
            inputCanvas,
            0, 0, SERIALIZE_EDGE_LENGTH, SERIALIZE_EDGE_LENGTH,
            0, 0, step1CanvasUpscaled.width, step1CanvasUpscaled.height
        );
        initializeCropper();
        invalidateStepsFrom(2);
        stepProcessed[1] = true;
    }

    // Scroll to top
    window.scrollTo(0, 0);
    // Tell parent iframe about height change
    window.parent.postMessage({ type: 'mosaic-resize', height: document.body.scrollHeight }, '*');
}

function runStepProcessing(targetStep, callback) {
    _isRunningStepProcessing = true;
    function runStepsSequentially(stepsToRun, index) {
        if (index >= stepsToRun.length) {
            _isRunningStepProcessing = false;
            if (callback) callback();
            return;
        }

        var step = stepsToRun[index];
        if (!stepProcessed[step]) {
            var stepFunctions = {
                1: runStep1Only,
                2: runStep2Only,
                3: runStep3Only,
                4: runStep4Only
            };
            stepFunctions[step]();
            var waited = 0;
            var checkComplete = setInterval(function() {
                waited += 50;
                if (stepProcessed[step]) {
                    clearInterval(checkComplete);
                    runStepsSequentially(stepsToRun, index + 1);
                } else if (waited > 60000) {
                    clearInterval(checkComplete);
                    _isRunningStepProcessing = false;
                    console.error('Step ' + step + ' timed out');
                    enableInteraction();
                }
            }, 50);
        } else {
            runStepsSequentially(stepsToRun, index + 1);
        }
    }

    var stepsToRun = [];
    for (var i = 1; i <= targetStep; i++) {
        if (!stepProcessed[i]) {
            stepsToRun.push(i);
        }
    }

    if (stepsToRun.length > 0) {
        runStepsSequentially(stepsToRun, 0);
    } else {
        if (callback) callback();
    }
}

function invalidateStepsFrom(stepNumber) {
    for (var i = stepNumber; i <= 4; i++) {
        stepProcessed[i] = false;
    }
}

// Step 1 → Step 2: "Weiter: Farben" — runs internal steps 1-3, shows color editing
var createMosaicBtn = document.getElementById('create-mosaic-btn');
if (createMosaicBtn) {
    createMosaicBtn.addEventListener('click', function() {
        invalidateStepsFrom(1);
        runStepProcessing(3, function() {
            showVisualStep(2);
        });
    });
}

// Step 2 → Result: "Weiter: Ergebnis" — runs internal step 4, shows result
var goToResultBtn = document.getElementById('go-to-result-btn');
if (goToResultBtn) {
    goToResultBtn.addEventListener('click', function() {
        runStepProcessing(4, function() {
            showVisualStep(3);
        });
    });
}

// Step 2 → Step 1: "Zurück: Anpassen"
var backToStep1Btn = document.getElementById('back-to-step1-btn');
if (backToStep1Btn) {
    backToStep1Btn.addEventListener('click', function() {
        showVisualStep(1);
    });
}

// Result → Step 2: "Zurück: Farben"
var backToRefineBtn = document.getElementById('back-to-refine-btn');
if (backToRefineBtn) {
    backToRefineBtn.addEventListener('click', function() {
        showVisualStep(2);
    });
}

// Collect mosaic summary data (image + colors) for email notification
function collectMosaicOrderData() {
    // Get the mosaic preview image from the upscaled canvas
    var canvas = document.getElementById('step-4-canvas-upscaled');
    var image = '';
    if (canvas) {
        try { image = canvas.toDataURL('image/png', 0.85); } catch(ex) {}
    }
    // Collect used colors with names and counts
    var colors = [];
    var usedMap = getUsedPixelsStudMap(getPixelArrayFromCanvas(step4Canvas));
    var hexKeys = Object.keys(usedMap);
    hexKeys.sort();
    hexKeys.forEach(function(hex) {
        var name = translateColor(HEX_TO_COLOR_NAME[hex]);
        if (!name) { name = HEX_TO_COLOR_NAME[hex]; }
        if (!name) { name = hex; }
        colors.push({ name: name, hex: hex, count: usedMap[hex] });
    });
    var total = targetResolution[0] * targetResolution[1];
    var price = getMosaicPrice();
    return {
        resolution: targetResolution[0] + ' x ' + targetResolution[1] + ' Noppen',
        plates: PLATE_WIDTH + ' x ' + PLATE_HEIGHT + ' Platten',
        totalPieces: total,
        price: price + ' \u20AC',
        colors: colors,
        image: image
    };
}

// Order mosaic button — adds WooCommerce variation to cart
var orderMosaicBtn = document.getElementById('order-mosaic-button');

// Shopping-cart SVG used inside the order button (kept in sync with index.html).
var BK_CART_SVG = '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/></svg>';

// Single source of truth for the order button appearance. The "added" state is
// PERSISTENT — it stays until the customer changes the configuration (which
// calls updateMosaicProductMeta → 'idle'), so they always know the mosaic is
// already in the cart and don't accidentally order twice.
function setOrderButtonState(state) {
    var btn = document.getElementById('order-mosaic-button');
    if (!btn) return;
    btn.classList.remove('bk-adding', 'bk-added');
    if (state === 'adding') {
        btn.disabled = true;
        btn.classList.add('bk-adding');
        btn.innerHTML = BK_CART_SVG + ' Wird hinzugefügt';
    } else if (state === 'added') {
        btn.disabled = true;
        btn.classList.add('bk-added');
        btn.innerHTML = 'Im Warenkorb';
    } else {
        // idle
        btn.disabled = false;
        btn.innerHTML = BK_CART_SVG + ' Bestellen';
    }
}

// WooCommerce variable product (parent) and lookup of all 40 variations.
// Each entry: <plateType>_<W>x<H>: { vid, price }
var MOSAIC_PARENT_PRODUCT_ID = 866; // BRICKONAS Mosaik nach Maß (variable)
var MOSAIC_VARIATIONS = {
    '32er_32x32':   { vid: 867, price: '39,00' },
    '32er_32x64':   { vid: 868, price: '59,00' },
    '32er_64x32':   { vid: 869, price: '59,00' },
    '32er_64x64':   { vid: 870, price: '109,00' },
    '48er_48x48':   { vid: 871, price: '69,00' },
    '48er_48x96':   { vid: 872, price: '109,00' },
    '48er_48x144':  { vid: 873, price: '154,00' },
    '48er_48x192':  { vid: 874, price: '199,00' },
    '48er_48x240':  { vid: 875, price: '288,00' },
    '48er_48x288':  { vid: 876, price: '346,00' },
    '48er_96x48':   { vid: 877, price: '109,00' },
    '48er_96x96':   { vid: 878, price: '199,00' },
    '48er_96x144':  { vid: 879, price: '289,00' },
    '48er_96x192':  { vid: 880, price: '379,00' },
    '48er_96x240':  { vid: 881, price: '576,00' },
    '48er_96x288':  { vid: 882, price: '691,00' },
    '48er_144x48':  { vid: 883, price: '154,00' },
    '48er_144x96':  { vid: 884, price: '289,00' },
    '48er_144x144': { vid: 885, price: '518,00' },
    '48er_144x192': { vid: 886, price: '691,00' },
    '48er_144x240': { vid: 887, price: '864,00' },
    '48er_144x288': { vid: 888, price: '1037,00' },
    '48er_192x48':  { vid: 889, price: '199,00' },
    '48er_192x96':  { vid: 890, price: '379,00' },
    '48er_192x144': { vid: 891, price: '691,00' },
    '48er_192x192': { vid: 892, price: '922,00' },
    '48er_192x240': { vid: 893, price: '1152,00' },
    '48er_192x288': { vid: 894, price: '1382,00' },
    '48er_240x48':  { vid: 895, price: '288,00' },
    '48er_240x96':  { vid: 896, price: '576,00' },
    '48er_240x144': { vid: 897, price: '864,00' },
    '48er_240x192': { vid: 898, price: '1152,00' },
    '48er_240x240': { vid: 899, price: '1440,00' },
    '48er_240x288': { vid: 900, price: '1728,00' },
    '48er_288x48':  { vid: 901, price: '346,00' },
    '48er_288x96':  { vid: 902, price: '691,00' },
    '48er_288x144': { vid: 903, price: '1037,00' },
    '48er_288x192': { vid: 904, price: '1382,00' },
    '48er_288x240': { vid: 905, price: '1728,00' },
    '48er_288x288': { vid: 906, price: '2074,00' }
};

function getMosaicVariationKey() {
    var w = Number(targetResolution[0]);
    var h = Number(targetResolution[1]);
    var plate = PLATE_WIDTH === 32 ? '32er' : '48er';
    return plate + '_' + w + 'x' + h;
}

function getMosaicVariationInfo() {
    return MOSAIC_VARIATIONS[getMosaicVariationKey()] || null;
}

function getMosaicProductId() {
    // Returns the parent variable product ID (used for the WC add-to-cart endpoint).
    // The specific variation is identified separately via variation_id + attributes.
    return MOSAIC_PARENT_PRODUCT_ID;
}

// Frame add-on (only available for 48x48 / 48er Platten)
var FRAME_PRODUCT_ID = 908; // BRICKONAS Mosaik-Rahmen 48x48 (simple, sale 29 €)
var FRAME_VARIATION_KEY = '48er_48x48';

function isFrameEligible() {
    return getMosaicVariationKey() === FRAME_VARIATION_KEY;
}

function isFrameSelected() {
    var cb = document.getElementById('mosaic-frame-checkbox');
    return !!(cb && !cb.disabled && cb.checked);
}

function updateFrameAddonVisibility() {
    var addon = document.getElementById('mosaic-frame-addon');
    var cb = document.getElementById('mosaic-frame-checkbox');
    if (!addon) return;
    if (isFrameEligible()) {
        addon.hidden = false;
    } else {
        addon.hidden = true;
        if (cb) cb.checked = false; // reset when leaving 48x48
    }
}

// Wire the checkbox to update the live price total in the order card
(function attachFrameCheckboxHandler(){
    var cb = document.getElementById('mosaic-frame-checkbox');
    if (!cb) return;
    cb.addEventListener('change', function(){
        if (typeof updateMosaicProductMeta === 'function') updateMosaicProductMeta();
    });
})();
if (orderMosaicBtn) {
    orderMosaicBtn.addEventListener('click', async function() {
        console.log('[BRICKONAS] Bestellen button clicked');
        var statusEl = document.getElementById('mosaic-order-status');
        var btn = this;

        try {
            setOrderButtonState('adding');

            // If uploader is enabled, generate PDF + upload (with progress status)
            var mosaicToken = null;
            var uploaderCfg = await getMosaicUploaderConfig();
            console.log('[BRICKONAS] Uploader config:', uploaderCfg);
            if (uploaderCfg && uploaderCfg.enabled) {
                try {
                    if (statusEl) {
                        statusEl.className = 'mosaic-order-status bk-sending';
                        statusEl.innerHTML = '⏳ <strong>Deine Bauanleitung wird vorbereitet&hellip;</strong><br>Das kann bei gro&szlig;en Mosaiks bis zu einer Minute dauern. Bitte schlie&szlig;e die Seite nicht.';
                    }
                    console.log('[BRICKONAS] Generating PDF blob (high quality)...');
                    var blob = await generateInstructionsAsBlob();
                    console.log('[BRICKONAS] PDF blob generated, size:', blob.size, 'bytes (' + (blob.size / 1024 / 1024).toFixed(1) + ' MB)');
                    if (statusEl) {
                        statusEl.innerHTML = '⏳ <strong>Anleitung wird hochgeladen&hellip;</strong><br>(' + (blob.size / 1024 / 1024).toFixed(1) + ' MB) &ndash; bitte einen Moment Geduld.';
                    }
                    mosaicToken = await uploadMosaicPdfToServer(blob, null);
                    if (mosaicToken) {
                        console.log('[BRICKONAS] PDF uploaded successfully, token:', mosaicToken);
                        if (statusEl) {
                            statusEl.innerHTML = '⏳ <strong>Wird zum Warenkorb hinzugef&uuml;gt&hellip;</strong>';
                        }
                    } else {
                        // A failed instruction-PDF upload is NON-FATAL: the order still
                        // goes through (we regenerate the build instructions server-side
                        // and contact the customer). We must NOT paint a bk-error here —
                        // the mosaic-cart-result success handler refuses to overwrite a
                        // bk-error status, so the customer would see a scary "konnte nicht
                        // hochgeladen werden" message even though their mosaic WAS added to
                        // the cart. Keep the neutral progress state and just log it.
                        console.warn('[BRICKONAS] PDF upload failed, proceeding to cart without token');
                        if (statusEl) {
                            statusEl.className = 'mosaic-order-status bk-sending';
                            statusEl.innerHTML = '⏳ <strong>Wird zum Warenkorb hinzugef&uuml;gt&hellip;</strong>';
                        }
                    }
                } catch (genErr) {
                    // Non-fatal — the order still works without the instruction PDF.
                    console.error('[BRICKONAS] PDF generation/upload failed:', genErr);
                }
            }

            // Tell parent WordPress page to add product (variation) to cart
            var variationInfo = getMosaicVariationInfo();
            var plateAttr = PLATE_WIDTH === 32 ? '32er' : '48er';
            var resAttr = Number(targetResolution[0]) + 'x' + Number(targetResolution[1]);
            var addFrame = isFrameEligible() && isFrameSelected();
            console.log('[BRICKONAS] Sending add-to-cart message to parent. parent:', getMosaicProductId(), 'variation:', variationInfo, 'attrs:', plateAttr, resAttr, 'frame:', addFrame, 'token:', mosaicToken);
            if (window.self !== window.top) {
                window.parent.postMessage({
                    type: 'mosaic-add-to-cart',
                    productId: getMosaicProductId(),
                    variationId: variationInfo ? variationInfo.vid : null,
                    attributes: {
                        plattentyp: plateAttr,
                        aufloesung: resAttr
                    },
                    addFrame: addFrame,
                    frameProductId: addFrame ? FRAME_PRODUCT_ID : null,
                    mosaicToken: mosaicToken
                }, '*');
            } else {
                // Standalone fallback: add variation to cart directly
                console.log('[BRICKONAS] Standalone mode: adding to cart via fetch');
                var formData = new FormData();
                formData.append('product_id', getMosaicProductId());
                if (variationInfo) {
                    formData.append('variation_id', variationInfo.vid);
                    formData.append('attribute_pa_plattentyp', plateAttr);
                    formData.append('attribute_pa_aufloesung', resAttr);
                }
                formData.append('quantity', 1);
                fetch('https://brickonas.info/?wc-ajax=add_to_cart', {
                    method: 'POST',
                    body: formData
                })
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    console.log('[BRICKONAS] Cart response:', data);
                    if (!data.error) {
                        setOrderButtonState('added');
                        if (statusEl) {
                            statusEl.className = 'mosaic-order-status bk-sent';
                            statusEl.innerHTML = '\u2713 <strong>Dein Mosaik liegt im Warenkorb.</strong><br>Du kannst jetzt weiter einkaufen oder zur Kasse gehen.';
                        }
                    } else {
                        setOrderButtonState('idle');
                    }
                })
                .catch(function(err) {
                    console.error('[BRICKONAS] Cart error:', err);
                    setOrderButtonState('idle');
                });
            }

            // Safety: if no response after a long time (large PDFs can take up to
            // a minute), re-enable the button so the customer isn't stuck. Never
            // clobber a finished "added" state.
            setTimeout(function() {
                var b = document.getElementById('order-mosaic-button');
                if (b && b.classList.contains('bk-adding')) {
                    console.log('[BRICKONAS] Timeout: re-enabling button');
                    setOrderButtonState('idle');
                    if (statusEl && !statusEl.classList.contains('bk-error')) {
                        statusEl.className = 'mosaic-order-status bk-error';
                        statusEl.innerHTML = '\u26A0 Das dauert l&auml;nger als erwartet. Bitte versuche es erneut oder lade die Seite neu.';
                    }
                }
            }, 120000);

        } catch(err) {
            console.error('[BRICKONAS] Bestellen error:', err);
            setOrderButtonState('idle');
            if (statusEl) {
                statusEl.className = 'mosaic-order-status bk-error';
                statusEl.innerHTML = '\u26A0 Fehler: ' + err.message;
                setTimeout(function() { statusEl.className = 'mosaic-order-status'; }, 8000);
            }
        }
    });
    // Listen for response from parent
    window.addEventListener('message', function(e) {
        if (e.data) {
            if (e.data.type === 'mosaic-cart-result') {
                console.log('[BRICKONAS] Cart result:', e.data.success);
                var btn = document.getElementById('order-mosaic-button');
                if (!btn) return;
                var statusElCart = document.getElementById('mosaic-order-status');
                if (e.data.success) {
                    // PERSISTENT confirmation — button stays "Im Warenkorb ✓" and
                    // a clear green message stays until the customer changes the
                    // configuration, so they know the mosaic is in the cart.
                    setOrderButtonState('added');
                    if (statusElCart && !statusElCart.classList.contains('bk-error')) {
                        statusElCart.className = 'mosaic-order-status bk-sent';
                        statusElCart.innerHTML = '✓ <strong>Dein Mosaik liegt im Warenkorb.</strong><br>Du kannst jetzt weiter einkaufen oder zur Kasse gehen.';
                    }
                } else {
                    setOrderButtonState('idle');
                    if (statusElCart && !statusElCart.classList.contains('bk-error')) {
                        statusElCart.className = 'mosaic-order-status bk-error';
                        statusElCart.innerHTML = '⚠ Das Hinzuf&uuml;gen zum Warenkorb hat nicht geklappt. Bitte versuche es erneut.';
                    }
                }
            }
            if (e.data.type === 'mosaic-email-result') {
                console.log('[BRICKONAS] Email result:', e.data.success);
                // Silent — no status text shown to customer
            }
        }
    });
}

// Send mosaic order details to parent WP page for email (silent — no status text shown)
function sendMosaicOrderEmail(statusEl) {
    var data = collectMosaicOrderData();
    if (window.self !== window.top) {
        // In iframe: tell parent to send the email
        window.parent.postMessage({
            type: 'mosaic-order-email',
            orderData: data
        }, '*');
    } else {
        // Standalone: post directly to WP endpoint
        fetch('https://brickonas.info/wp-json/brickonas/v1/mosaic-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            if (statusEl) {
                statusEl.className = 'mosaic-order-status';
                if (d.success) {
                    statusEl.classList.add('bk-sent');
                    statusEl.innerHTML = '\u2713 ' + t('orderEmailSent');
                } else {
                    statusEl.classList.add('bk-error');
                    statusEl.innerHTML = '\u26A0 ' + t('orderEmailError');
                }
                setTimeout(function() { statusEl.className = 'mosaic-order-status'; }, 5000);
            }
        })
        .catch(function() {
            if (statusEl) {
                statusEl.className = 'mosaic-order-status bk-error';
                statusEl.innerHTML = '\u26A0 ' + t('orderEmailError');
                setTimeout(function() { statusEl.className = 'mosaic-order-status'; }, 5000);
            }
        });
    }
}

// Prices are baked into MOSAIC_VARIATIONS above (synced with WooCommerce variations).
function getMosaicPrice() {
    var v = getMosaicVariationInfo();
    return v ? v.price : '69,00';
}

// Update product card meta and button text when resolution changes
function updateMosaicProductMeta() {
    var sizeEl = document.getElementById('mosaic-product-size');
    var piecesEl = document.getElementById('mosaic-product-pieces');
    if (sizeEl) {
        sizeEl.innerHTML = targetResolution[0] + ' &times; ' + targetResolution[1] + ' Noppen';
    }
    if (piecesEl) {
        var total = targetResolution[0] * targetResolution[1];
        piecesEl.innerHTML = total.toLocaleString('de-DE') + ' Teile';
    }
    // Update price based on resolution (+ frame surcharge if checkbox set)
    var priceEl = document.getElementById('mosaic-product-price');
    if (priceEl) {
        var basePrice = parseFloat(getMosaicPrice().replace('.', '').replace(',', '.')) || 0;
        var totalPrice = basePrice;
        if (typeof isFrameEligible === 'function' && isFrameEligible() && typeof isFrameSelected === 'function' && isFrameSelected()) {
            totalPrice = basePrice + 29;
        }
        var formatted = totalPrice.toFixed(2).replace('.', ',');
        priceEl.innerHTML = formatted + ' &euro;';
        priceEl.style.display = '';
    }
    // Reset the order button to its idle state whenever the configuration
    // changes (resolution/frame). This clears a previous "Im Warenkorb ✓"
    // confirmation so the customer can deliberately order the new variant.
    var btn = document.getElementById('order-mosaic-button');
    if (btn) {
        if (typeof setOrderButtonState === 'function' && (btn.classList.contains('bk-added') || btn.classList.contains('bk-adding'))) {
            setOrderButtonState('idle');
            var prevStatus = document.getElementById('mosaic-order-status');
            if (prevStatus && prevStatus.classList.contains('bk-sent')) {
                prevStatus.className = 'mosaic-order-status';
                prevStatus.innerHTML = '';
            }
        } else {
            var svgIcon = btn.querySelector('svg');
            var svgHtml = svgIcon ? svgIcon.outerHTML : '';
            btn.innerHTML = svgHtml + '\n                        Bestellen';
        }
    }
    // Frame add-on is only available for 48x48 / 48er
    if (typeof updateFrameAddonVisibility === 'function') updateFrameAddonVisibility();
}

// Stepper circle click handlers
document.querySelectorAll('.mosaic-stepper-step').forEach(function(btn) {
    btn.addEventListener('click', function() {
        var vstep = parseInt(this.dataset.vstep);
        if (vstep === 1) {
            showVisualStep(1);
        } else if (vstep === 2 && stepProcessed[3]) {
            showVisualStep(2);
        } else if (vstep === 3 && stepProcessed[4]) {
            showVisualStep(3);
        }
    });
});

// Legacy goToStep for backward compat (internal code may call it)
function goToStep(stepNumber) {
    if (stepNumber <= 1) {
        showVisualStep(1);
    } else if (stepNumber <= 3) {
        showVisualStep(2);
    } else {
        showVisualStep(3);
    }
}

// === STYLE PICKER (step 2) ===
// Approach: each style is a curated SUBSET of the active palette. Clicking
// a tile rebuilds the configurator's stud table with that subset and
// triggers runCustomStudMap() — the same path the existing preset dropdown
// uses. No HSV / brightness / contrast filtering, no race conditions.
//
// The "Original" tile restores the user's full default palette (whatever
// it was when they entered step 2 the first time).
(function setupStylePicker() {
    // Curated colour subsets, by hex. Each list is small enough to give a
    // strong visual identity but big enough to keep the photo recognisable.
    // Hex codes match those in bricklink-colors.js. If a hex isn't in the
    // active palette (e.g. it's hidden via BK_HIDDEN_COLOR_NAMES), it is
    // silently dropped at click time.
    var BK_STYLE_PALETTES = {
        vintage: [
            // Sepia-Polaroid: nur Cremes, Browns, Bordeaux, dunkles Schwarz.
            // Sehr warme, niedriggesättigte Töne → wirkt nostalgisch, alt.
            "#dec69c", // Tan
            "#D9C594", // Medium Tan
            "#907450", // Dark Tan
            "#e3a05b", // Medium Nougat
            "#a16c42", // Medium Brown
            "#89351d", // Reddish Brown
            "#532115", // Brown
            "#330000", // Dark Brown
            "#6a0e15", // Dark Red
            "#212121", // Black
            "#feccb0", // Light Nougat — for highlights
            "#e8e8e8", // Very Light Gray — paper-white feel
        ],
        pop: [
            // Knallige Pop-Art: Komplementärfarben, hohe Sättigung,
            // Schwarz/Weiß für Kontrast. Wie Warhol-Siebdruck.
            "#ffffff", // White
            "#212121", // Black
            "#b30006", // Red
            "#ff7e14", // Orange
            "#fffc00", // Neon Yellow
            "#10cb31", // Bright Green
            "#0057a6", // Blue
            "#42c0fb", // Medium Azure
            "#a5499c", // Purple
            "#ffbbff", // Bright Pink
            "#f785b1", // Medium Dark Pink
        ],
        warm: [
            "#ffffff", // White (highlights)
            "#212121", // Black (definition)
            "#fffc00", // Neon Yellow
            "#f7d117", // Yellow
            "#ffa531", // Medium Orange
            "#ff7e14", // Orange
            "#fa5947", // Neon Orange
            "#b30006", // Red
            "#b35408", // Dark Orange
            "#89351d", // Reddish Brown
            "#532115", // Brown
            "#dec69c", // Tan
            "#feccb0", // Light Nougat
            "#ffaf7d", // Nougat
            "#e3a05b", // Medium Nougat
            "#f7ba30", // Bright Light Orange
            "#dd982e", // Dark Yellow
            "#f88379", // Coral
        ],
        mono: [
            "#ffffff", // White
            "#e8e8e8", // Very Light Gray
            "#afb5c7", // Light Bluish Gray
            "#9c9c9c", // Light Gray
            "#6b5a5a", // Dark Gray
            "#595d60", // Dark Bluish Gray
            "#212121", // Black
        ],
    };

    var BK_STYLE_PRESETS = [
        { id: "original", labelKey: "styleOriginal", labelDe: "Original" },
        { id: "vintage",  labelKey: "styleVintage",  labelDe: "Vintage"  },
        { id: "pop",      labelKey: "stylePop",      labelDe: "Pop"      },
        { id: "warm",     labelKey: "styleWarm",     labelDe: "Warm"     },
        { id: "mono",     labelKey: "styleMono",     labelDe: "S/W"      },
    ];

    var picker = document.getElementById("bk-style-picker");
    var grid = document.getElementById("bk-style-picker-grid");
    if (!picker || !grid) return;

    var selectedStyleId = "original";
    var tilesBuilt = false;
    // Snapshot of the user's original palette the first time they reach
    // step 2. The "Original" tile restores this. We snapshot once so that
    // selecting another tile and then clicking Original reverts cleanly.
    var originalPaletteSnapshot = null;

    function snapshotOriginalPaletteIfNeeded() {
        if (originalPaletteSnapshot) return;
        if (typeof selectedStudMap === "undefined" || !selectedStudMap) return;
        // Deep-clone — selectedStudMap mutates as the user edits the table.
        originalPaletteSnapshot = JSON.parse(JSON.stringify(selectedStudMap));
    }

    function getActivePaletteHexes() {
        if (typeof ALL_BRICKLINK_SOLID_COLORS !== "undefined") {
            return new Set(ALL_BRICKLINK_SOLID_COLORS.map(function(c) { return c.hex.toLowerCase(); }));
        }
        return null;
    }

    function buildStudMapFromHexList(hexList) {
        // Filter against the active palette so hidden colours (and any typos)
        // are silently dropped. Each entry counts as "infinite" so the colour
        // matcher uses it freely.
        var active = getActivePaletteHexes();
        var map = {};
        hexList.forEach(function(hex) {
            var h = hex.toLowerCase();
            if (active && !active.has(h)) return;
            map[h] = 99999;
        });
        return map;
    }

    function applyStyleStudMap(styleId) {
        var newMap;
        if (styleId === "original") {
            newMap = originalPaletteSnapshot
                ? JSON.parse(JSON.stringify(originalPaletteSnapshot))
                : selectedStudMap;
        } else {
            var hexes = BK_STYLE_PALETTES[styleId] || [];
            newMap = buildStudMapFromHexList(hexes);
        }
        if (!newMap || Object.keys(newMap).length === 0) return false;

        // Push the new palette into the configurator's custom stud table
        // (so the existing pipeline picks it up via runCustomStudMap).
        if (typeof customStudTableBody !== "undefined" && customStudTableBody) {
            customStudTableBody.innerHTML = "";
        }
        if (typeof mixInStudMap === "function") {
            // mixInStudMap expects a stud-map object with sortedStuds + studMap
            mixInStudMap({
                sortedStuds: Object.keys(newMap),
                studMap: newMap,
            }, false);
        }
        if (typeof runCustomStudMap === "function") {
            runCustomStudMap();
        }
        return true;
    }

    // Render each style tile as a mini-mosaic preview of its own palette.
    //
    // PERF / UX: this used to color-match all 5 tiles synchronously in one loop
    // right as step 2 appeared, producing a single ~300-400 ms main-thread block
    // exactly when the user reaches to hover a tile — so the lift animation
    // stuttered or never started. Two changes keep the thread responsive:
    //   1. Render ONE tile per animation frame (yield between tiles) so hover
    //      and paint can run in the gaps.
    //   2. Use the cheap Euclidean-LAB metric for these 32px decorative
    //      thumbnails instead of the full CIEDE2000 the real mosaic uses. The
    //      colour choice is visually indistinguishable at this size but several
    //      times faster, so each per-frame chunk stays small.
    // The real product mosaic is unaffected — it still uses colorDistanceFunction.
    var previewRenderToken = 0;
    function renderTilePreviews() {
        var src = document.getElementById("step-2-canvas");
        if (!src || !src.width || !src.height) {
            requestAnimationFrame(renderTilePreviews);
            return;
        }
        var GRID = Math.min(32, src.width);
        var DOT = 4;

        var tmp = document.createElement("canvas");
        tmp.width = GRID; tmp.height = GRID;
        var tmpCtx = tmp.getContext("2d");
        tmpCtx.imageSmoothingEnabled = true;
        tmpCtx.drawImage(src, 0, 0, GRID, GRID);
        var basePixels = tmpCtx.getImageData(0, 0, GRID, GRID).data;
        var distFn =
            (colorDistanceFunctionsInfo.euclideanLAB && colorDistanceFunctionsInfo.euclideanLAB.func) ||
            (typeof colorDistanceFunction !== "undefined" ? colorDistanceFunction : null);
        var canMatch = distFn && typeof alignPixelsToStudMap === "function";

        var tiles = [].slice.call(grid.querySelectorAll(".bk-style-tile"));
        var token = ++previewRenderToken; // a newer render invalidates this one
        var idx = 0;

        function renderOne() {
            if (token !== previewRenderToken) return; // superseded by a newer render
            if (idx >= tiles.length) return;
            var tile = tiles[idx++];
            var preset = BK_STYLE_PRESETS.find(function(p) { return p.id === tile.dataset.style; });
            var canvas = tile.querySelector("canvas.bk-style-tile-preview");
            if (preset && canvas) {
                var paletteMap;
                if (preset.id === "original") {
                    paletteMap = originalPaletteSnapshot || selectedStudMap;
                } else {
                    paletteMap = buildStudMapFromHexList(BK_STYLE_PALETTES[preset.id] || []);
                }
                if (paletteMap && Object.keys(paletteMap).length > 0) {
                    var pix = new Uint8ClampedArray(basePixels);
                    var aligned = canMatch ? alignPixelsToStudMap(pix, paletteMap, distFn) : pix;

                    canvas.width = GRID * DOT;
                    canvas.height = GRID * DOT;
                    var ctx = canvas.getContext("2d");
                    ctx.fillStyle = "#222";
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    var radius = DOT / 2;
                    for (var i = 0; i < GRID * GRID; i++) {
                        var r = aligned[i * 4], g = aligned[i * 4 + 1], b = aligned[i * 4 + 2];
                        ctx.fillStyle = "rgb(" + r + "," + g + "," + b + ")";
                        var x = (i % GRID) * DOT + radius;
                        var y = Math.floor(i / GRID) * DOT + radius;
                        ctx.beginPath();
                        ctx.arc(x, y, radius - 0.3, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }
            }
            // Yield to the event loop between tiles so hover/paint stay smooth.
            requestAnimationFrame(renderOne);
        }
        renderOne();
    }

    function buildTilesOnce() {
        if (tilesBuilt) return;
        BK_STYLE_PRESETS.forEach(function(preset) {
            var tile = document.createElement("button");
            tile.type = "button";
            tile.className = "bk-style-tile" + (preset.id === selectedStyleId ? " active" : "");
            tile.dataset.style = preset.id;
            var canvas = document.createElement("canvas");
            canvas.className = "bk-style-tile-preview";
            tile.appendChild(canvas);
            var label = document.createElement("span");
            label.className = "bk-style-tile-label";
            label.setAttribute("data-i18n", preset.labelKey);
            label.textContent = preset.labelDe;
            tile.appendChild(label);
            tile.addEventListener("click", function() {
                if (selectedStyleId === preset.id) return;
                if (grid.dataset.busy === "1") return;
                selectedStyleId = preset.id;
                grid.querySelectorAll(".bk-style-tile").forEach(function(t) {
                    t.classList.toggle("active", t.dataset.style === preset.id);
                });
                grid.dataset.busy = "1";
                var safety = setTimeout(function() { grid.dataset.busy = ""; }, 6000);
                var ok = applyStyleStudMap(preset.id);
                if (!ok) {
                    grid.dataset.busy = "";
                    clearTimeout(safety);
                    return;
                }
                // Poll stepProcessed[3] which flips true once the mosaic
                // has re-rendered with the new palette.
                var start = Date.now();
                var poll = setInterval(function() {
                    if (typeof stepProcessed !== "undefined" && stepProcessed[3]) {
                        clearInterval(poll);
                        clearTimeout(safety);
                        grid.dataset.busy = "";
                    } else if (Date.now() - start > 6000) {
                        clearInterval(poll);
                    }
                }, 80);
            });
            grid.appendChild(tile);
        });
        tilesBuilt = true;
    }

    document.addEventListener("bk-visual-step-change", function(e) {
        var step = e && e.detail && e.detail.step;
        if (step === 2) {
            snapshotOriginalPaletteIfNeeded();
            buildTilesOnce();
            picker.hidden = false;
            // Render the style-tile previews after one real paint so the step-2
            // transition stays smooth (same "wait for a painted frame" idiom).
            bkPaintThenRun(renderTilePreviews);
        } else {
            picker.hidden = true;
        }
    });
})();

enableInteraction(); // enable interaction once everything has loaded in
