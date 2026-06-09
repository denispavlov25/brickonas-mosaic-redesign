/**
 * Vector instruction pages for the BRICKONAS build-instructions PDF.
 *
 * WHY: The original generator rasterises every plate/detail page to a large
 * (~3840px) canvas and embeds it as a full-page JPEG. For big mosaics this
 * produces 70-130 MB PDFs that take minutes to upload. The visual content of
 * these pages is pure geometry (coloured studs, numbers, a legend, a mini
 * overview) — perfect for vectors.
 *
 * HOW: We reuse the EXISTING drawing functions (generateInstructionPage,
 * drawStudCountForContext, drawPlateOverviewThumbnail, drawPixel) unchanged, but
 * feed them a thin Canvas2D-compatible shim (BkPdfVectorCtx) that translates the
 * handful of canvas ops they use into jsPDF vector primitives. Layout therefore
 * matches the raster version by construction; only the rendering backend changes.
 *
 * The TITLE page keeps its raster path (it embeds the real mosaic preview photo
 * and the logo bitmap, which are not vectorisable). It's a single page, so its
 * size is negligible.
 */

(function (global) {
    "use strict";

    // One shared offscreen 2d context, used ONLY for text measurement so that
    // measureText() returns the exact same metrics the layout code expects.
    var _measureCanvas = null;
    function getMeasureCtx() {
        if (!_measureCanvas) {
            _measureCanvas = document.createElement("canvas");
            _measureCanvas.width = 8;
            _measureCanvas.height = 8;
        }
        return _measureCanvas.getContext("2d");
    }

    // Parse a CSS hex colour ("#rgb" or "#rrggbb") into [r,g,b] (0-255).
    function parseHex(hex) {
        if (typeof hex !== "string") return [0, 0, 0];
        var h = hex.trim();
        if (h[0] === "#") h = h.slice(1);
        if (h.length === 3) {
            h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        }
        if (h.length < 6) return [0, 0, 0];
        var r = parseInt(h.slice(0, 2), 16);
        var g = parseInt(h.slice(2, 4), 16);
        var b = parseInt(h.slice(4, 6), 16);
        return [isNaN(r) ? 0 : r, isNaN(g) ? 0 : g, isNaN(b) ? 0 : b];
    }

    // Parse a CSS font shorthand ("bold 26px Arial", "700 44px Nunito") into
    // { sizePx, bold }. Family is irrelevant — PDF instruction text uses Helvetica
    // (metrically near-identical to Arial).
    function parseFont(font) {
        var sizePx = 12, bold = false;
        if (typeof font === "string") {
            if (/\bbold\b/i.test(font) || /\b[6-9]00\b/.test(font)) bold = true;
            var m = font.match(/(\d+(?:\.\d+)?)px/);
            if (m) sizePx = parseFloat(m[1]);
        }
        return { sizePx: sizePx, bold: bold };
    }

    var PT_PER_MM = 1 / 0.352777778;

    /**
     * Canvas2D-subset shim that renders into a jsPDF page.
     * Only the ops actually used by the instruction-page drawing functions are
     * implemented. Coordinates are in the source "canvas pixel" space; they are
     * mapped to PDF millimetres via a uniform scale + offset that reproduces the
     * raster path's "fit image centred on page" placement.
     */
    function BkPdfVectorCtx(pdf, pdfWidth, pdfHeight) {
        this.pdf = pdf;
        this.pdfWidth = pdfWidth;
        this.pdfHeight = pdfHeight;
        this.canvas = { width: 0, height: 0, style: {} };

        // Canvas state
        this.fillStyle = "#000000";
        this.strokeStyle = "#000000";
        this.lineWidth = 1;
        this.font = "12px Arial";
        this.textAlign = "start";
        this.textBaseline = "alphabetic";

        this._ready = false;
        this._pending = null; // buffered shape awaiting fill()/stroke()
    }

    BkPdfVectorCtx.prototype._init = function () {
        if (this._ready) return;
        var cw = this.canvas.width, ch = this.canvas.height;
        if (!cw || !ch) return; // not sized yet
        var ratio = cw / ch;
        var drawW = this.pdfWidth;
        var drawH = this.pdfWidth / ratio;
        if (drawH > this.pdfHeight) {
            drawH = this.pdfHeight;
            drawW = this.pdfHeight * ratio;
        }
        this.s = drawW / cw;            // mm per source px
        this.offX = (this.pdfWidth - drawW) / 2;
        this.offY = (this.pdfHeight - drawH) / 2;
        this._ready = true;
    };
    BkPdfVectorCtx.prototype._mx = function (x) { return this.offX + x * this.s; };
    BkPdfVectorCtx.prototype._my = function (y) { return this.offY + y * this.s; };
    BkPdfVectorCtx.prototype._ms = function (v) { return v * this.s; };

    // Flush any buffered path shape, combining fill+stroke into one op where set.
    BkPdfVectorCtx.prototype._flush = function () {
        var p = this._pending;
        if (!p) return;
        this._pending = null;
        var style = (p.fill && p.stroke) ? "FD" : (p.fill ? "F" : (p.stroke ? "S" : null));
        if (!style) return;
        if (p.fill) {
            var fc = parseHex(p.fillColor);
            this.pdf.setFillColor(fc[0], fc[1], fc[2]);
        }
        if (p.stroke) {
            var sc = parseHex(p.strokeColor);
            this.pdf.setDrawColor(sc[0], sc[1], sc[2]);
            this.pdf.setLineWidth(Math.max(this._ms(p.lineWidth), 0.05));
        }
        if (p.type === "rect") {
            this.pdf.rect(this._mx(p.x), this._my(p.y), this._ms(p.w), this._ms(p.h), style);
        } else if (p.type === "circle") {
            this.pdf.circle(this._mx(p.cx), this._my(p.cy), this._ms(p.r), style);
        } else if (p.type === "roundrect") {
            var rr = this._ms(p.r);
            this.pdf.roundedRect(this._mx(p.x), this._my(p.y), this._ms(p.w), this._ms(p.h), rr, rr, style);
        }
    };

    // --- Path construction ---
    BkPdfVectorCtx.prototype.beginPath = function () { this._init(); this._flush(); this._pending = null; };
    BkPdfVectorCtx.prototype.rect = function (x, y, w, h) {
        this._init(); this._flush();
        this._pending = { type: "rect", x: x, y: y, w: w, h: h };
    };
    BkPdfVectorCtx.prototype.roundRect = function (x, y, w, h, r) {
        this._init(); this._flush();
        if (Array.isArray(r)) r = r[0] || 0;
        this._pending = { type: "roundrect", x: x, y: y, w: w, h: h, r: r };
    };
    BkPdfVectorCtx.prototype.arc = function (cx, cy, r /*, a0, a1 */) {
        this._init(); this._flush();
        this._pending = { type: "circle", cx: cx, cy: cy, r: r };
    };
    // moveTo/lineTo/quadraticCurveTo: only reached by the manual rounded-rect
    // fallback, which we never hit (roundRect is defined). No-op for safety.
    BkPdfVectorCtx.prototype.moveTo = function () {};
    BkPdfVectorCtx.prototype.lineTo = function () {};
    BkPdfVectorCtx.prototype.quadraticCurveTo = function () {};
    BkPdfVectorCtx.prototype.closePath = function () {};

    BkPdfVectorCtx.prototype.fill = function () {
        if (!this._pending) return;
        this._pending.fill = true;
        this._pending.fillColor = this.fillStyle;
    };
    BkPdfVectorCtx.prototype.stroke = function () {
        if (!this._pending) return;
        this._pending.stroke = true;
        this._pending.strokeColor = this.strokeStyle;
        this._pending.lineWidth = this.lineWidth;
    };

    // --- Immediate ops ---
    BkPdfVectorCtx.prototype.fillRect = function (x, y, w, h) {
        this._init(); this._flush();
        var fc = parseHex(this.fillStyle);
        this.pdf.setFillColor(fc[0], fc[1], fc[2]);
        this.pdf.rect(this._mx(x), this._my(y), this._ms(w), this._ms(h), "F");
    };
    BkPdfVectorCtx.prototype.strokeRect = function (x, y, w, h) {
        this._init(); this._flush();
        var sc = parseHex(this.strokeStyle);
        this.pdf.setDrawColor(sc[0], sc[1], sc[2]);
        this.pdf.setLineWidth(Math.max(this._ms(this.lineWidth), 0.05));
        this.pdf.rect(this._mx(x), this._my(y), this._ms(w), this._ms(h), "S");
    };

    BkPdfVectorCtx.prototype.measureText = function (text) {
        var mctx = getMeasureCtx();
        mctx.font = this.font;
        return { width: mctx.measureText(text == null ? "" : "" + text).width };
    };

    BkPdfVectorCtx.prototype.fillText = function (text, x, y) {
        this._init(); this._flush();
        if (text == null) return;
        text = "" + text;
        if (!text.length) return;
        var f = parseFont(this.font);
        var fc = parseHex(this.fillStyle);
        this.pdf.setTextColor(fc[0], fc[1], fc[2]);
        this.pdf.setFont("helvetica", f.bold ? "bold" : "normal");
        this.pdf.setFontSize(f.sizePx * this.s * PT_PER_MM);

        // Horizontal alignment (resolve to a jsPDF align relative to x).
        var align = "left";
        if (this.textAlign === "center") align = "center";
        else if (this.textAlign === "right" || this.textAlign === "end") align = "right";

        // Vertical: convert the requested baseline to an alphabetic baseline y,
        // because jsPDF positions text on its alphabetic baseline.
        var by = y;
        if (this.textBaseline === "middle") by = y + f.sizePx * 0.355;
        else if (this.textBaseline === "top") by = y + f.sizePx * 0.80;
        else if (this.textBaseline === "bottom") by = y - f.sizePx * 0.20;

        this.pdf.text(text, this._mx(x), this._my(by), { align: align });
    };

    // save/restore/setTransform are not used by the instruction-page functions,
    // but provide no-ops in case future code touches them.
    BkPdfVectorCtx.prototype.save = function () {};
    BkPdfVectorCtx.prototype.restore = function () {};
    BkPdfVectorCtx.prototype.setTransform = function () {};
    BkPdfVectorCtx.prototype.drawImage = function () {}; // instruction pages don't drawImage

    /**
     * Render one instruction page (plate overview or detail block) as vectors
     * into the current jsPDF page. Mirrors the signature/behaviour of the raster
     * drawPdfInstructionPage(), minus the DPI/JPEG steps.
     */
    function drawPdfInstructionPageVector(
        pdf, pixelArray, plateWidth, availableStudHexList, scaling, label, pixelType,
        variableDims, pdfWidth, pdfHeight, overviewContext, legendScalingOverride
    ) {
        var ctx = new BkPdfVectorCtx(pdf, pdfWidth, pdfHeight);
        // generateInstructionPage sets canvas.width/height then draws; our shim
        // reads those lazily on the first op via _init().
        generateInstructionPage(
            pixelArray, plateWidth, availableStudHexList, scaling, ctx.canvas /* unused */,
            label, pixelType, variableDims, overviewContext, legendScalingOverride
        );
        ctx._flush();
    }

    // generateInstructionPage calls canvas.getContext("2d"); intercept by passing
    // a fake canvas whose getContext returns our shim. We wire that here so the
    // existing function needs no changes.
    function makeVectorCanvas(pdf, pdfWidth, pdfHeight) {
        var ctx = new BkPdfVectorCtx(pdf, pdfWidth, pdfHeight);
        ctx.canvas.getContext = function () { return ctx; };
        return ctx.canvas;
    }

    global.BkPdfVectorCtx = BkPdfVectorCtx;
    global.bkDrawInstructionPageVector = function (
        pdf, pixelArray, plateWidth, availableStudHexList, scaling, label, pixelType,
        variableDims, pdfWidth, pdfHeight, overviewContext, legendScalingOverride
    ) {
        var fakeCanvas = makeVectorCanvas(pdf, pdfWidth, pdfHeight);
        var ctx = fakeCanvas.getContext("2d");
        generateInstructionPage(
            pixelArray, plateWidth, availableStudHexList, scaling, fakeCanvas,
            label, pixelType, variableDims, overviewContext, legendScalingOverride
        );
        ctx._flush();
    };

})(window);
