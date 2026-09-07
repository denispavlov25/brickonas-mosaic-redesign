/**
 * BRICKONAS Creator — panel contents.
 *
 * Fills the shell from bk-creator-ui.js. The rule throughout: RELOCATE the
 * existing controls rather than rebuild them, so index.js keeps owning all the
 * behaviour. The one genuinely new control is the size picker, which replaces
 * two abstract stud sliders plus a "Schrittweite" dropdown with cards that show
 * what the customer actually cares about: centimetres and price.
 */
(function () {
    "use strict";
    if (!/[?&]ui=new\b/.test(window.location.search)) return;

    function boot() {
        var C = window.BkCreator;
        if (!C) return;
        C.buildShell();

        var P = C.panels(), attic = C.attic(), stage = C.stage(), el = C.el, move = C.move, q = C.q;

        /* ---------------------------------------------------------- stage */
        // The wizard owns several canvases. Keep them all alive in the attic and
        // lift the one that belongs to the current tab into view.
        // Move the canvas AREA, never the bare canvas: Cropper.js wraps
        // #step-1-canvas-upscaled in its own DOM, and lifting the canvas out of
        // that wrapper breaks cropping. The areas are stable containers.
        var STEPS = ["step-1", "step-2", "step-3", "step-4"];
        function areaOf(step) {
            var host = document.getElementById(step + "-color-tab-content");
            return host ? host.querySelector(".mosaic-canvas-area") : null;
        }
        /** The furthest-along canvas area that actually has something drawn. */
        function bestArea() {
            for (var i = STEPS.length - 1; i >= 0; i--) {
                var a = areaOf(STEPS[i]);
                if (a) { var c = a.querySelector("canvas"); if (c && c.width > 300) return a; }
            }
            return areaOf("step-1");
        }

        var zoomBar = el("div", "bk-cr-zoom");
        zoomBar.innerHTML =
            '<span aria-hidden="true">&#128269;</span>' +
            '<input type="range" id="bk-cr-zoom-range" min="40" max="300" step="5" value="100">' +
            '<span id="bk-cr-zoom-val">100 %</span>' +
            '<button type="button" id="bk-cr-zoom-reset">Zurücksetzen</button>';

        function applyZoom() {
            var v = +document.getElementById("bk-cr-zoom-range").value;
            document.getElementById("bk-cr-zoom-val").textContent = v + " %";
            [].forEach.call(stage.querySelectorAll(".mosaic-canvas-area"), function (n) {
                n.style.transform = "scale(" + (v / 100) + ")";
                n.style.transformOrigin = "center center";
            });
        }
        zoomBar.addEventListener("input", applyZoom);
        zoomBar.querySelector("#bk-cr-zoom-reset").addEventListener("click", function () {
            document.getElementById("bk-cr-zoom-range").value = 100;
            applyZoom();
        });

        var shownArea = null, currentTab = "size";
        function lift(area) {
            if (!area || area === shownArea) return;
            if (shownArea) attic.appendChild(shownArea);
            stage.appendChild(area);
            area.style.display = "";
            shownArea = area;
            if (!stage.contains(zoomBar)) stage.appendChild(zoomBar);
            applyZoom();
        }
        window.bkCrShowStage = function (tab) {
            currentTab = tab;
            lift(tab === "crop" ? areaOf("step-1") : bestArea());
        };
        // The wizard redraws into a later canvas as the customer changes things;
        // keep the stage pointed at whatever is furthest along.
        setInterval(function () {
            if (currentTab !== "crop") lift(bestArea());
        }, 900);

        /* ----------------------------------------------------- GRÖSSE tab */
        C.heading(P.size, "Größe", "Wähle Format und Größe. Der Preis gilt für das fertige Mosaik.");

        var SHAPES = [
            { id: "square", label: "Quadrat", icon: C.ICON.square, test: function (w, h) { return w === h; } },
            { id: "land",   label: "Quer",    icon: C.ICON.land,   test: function (w, h) { return w > h; } },
            { id: "port",   label: "Hoch",    icon: C.ICON.port,   test: function (w, h) { return h > w; } }
        ];
        var shapeRow = el("div", "bk-cr-shapes");
        var sizeGrid = el("div", "bk-cr-sizes");
        var activeShape = "square";

        SHAPES.forEach(function (s) {
            var b = el("button", "bk-cr-shape", C.svg(s.icon) + "<span>" + s.label + "</span>");
            b.type = "button";
            b.setAttribute("aria-pressed", s.id === activeShape ? "true" : "false");
            b.addEventListener("click", function () {
                activeShape = s.id;
                [].forEach.call(shapeRow.children, function (c) {
                    c.setAttribute("aria-pressed", c === b ? "true" : "false");
                });
                renderSizes();
            });
            shapeRow.appendChild(b);
        });
        P.size.append(shapeRow, sizeGrid);

        /** Variation keys look like "48er_96x144". Turn them into card data. */
        function variations() {
            var V = window.MOSAIC_VARIATIONS || {};
            return Object.keys(V).map(function (k) {
                var m = /^(\d+)er_(\d+)x(\d+)$/.exec(k);
                if (!m) return null;
                var plate = +m[1], w = +m[2], h = +m[3];
                return { key: k, plate: plate, w: w, h: h, price: V[k].price,
                         cm: [(w * 0.8), (h * 0.8)] };
            }).filter(Boolean);
        }

        function plateIcon(cols, rows) {
            cols = Math.min(cols, 7); rows = Math.min(rows, 5);
            var out = "";
            for (var r = 0; r < rows; r++) {
                out += "<span>";
                for (var c = 0; c < cols; c++) out += "<i></i>";
                out += "</span>";
            }
            return out;
        }

        function currentKey() {
            var pw = document.getElementById("width-step-select");
            return (pw ? pw.value : "48") + "er_" +
                   document.getElementById("width-slider").value + "x" +
                   document.getElementById("height-slider").value;
        }

        function renderSizes() {
            var shape = SHAPES.find(function (s) { return s.id === activeShape; });
            var list = variations()
                .filter(function (v) { return shape.test(v.w, v.h); })
                .sort(function (a, b) { return (a.w * a.h) - (b.w * b.h); });
            var cur = currentKey();
            sizeGrid.innerHTML = "";
            list.forEach(function (v) {
                var card = el("button", "bk-cr-size-card");
                card.type = "button";
                card.setAttribute("aria-pressed", v.key === cur ? "true" : "false");
                card.innerHTML =
                    '<div class="bk-cr-grid-ico">' + plateIcon(v.w / v.plate, v.h / v.plate) + "</div>" +
                    '<div class="bk-cr-size-cm">' + v.cm[0].toFixed(1).replace(".", ",") + " &times; " +
                        v.cm[1].toFixed(1).replace(".", ",") + " cm</div>" +
                    '<div class="bk-cr-size-sub">' + (v.w / v.plate) + " &times; " + (v.h / v.plate) +
                        " Platten &middot; " + v.plate + "er</div>" +
                    '<div class="bk-cr-size-price">' + v.price + " &euro;</div>";
                card.addEventListener("click", function () { pickSize(v); });
                sizeGrid.appendChild(card);
            });
        }

        /** Drive the (hidden) original controls so all existing handlers run. */
        function pickSize(v) {
            ["width-step-select", "height-step-select"].forEach(function (id) {
                var s = document.getElementById(id);
                if (s && s.value !== String(v.plate)) {
                    s.value = String(v.plate);
                    s.dispatchEvent(new Event("change", { bubbles: true }));
                }
            });
            [["width-slider", v.w], ["height-slider", v.h]].forEach(function (pair) {
                var s = document.getElementById(pair[0]);
                if (!s) return;
                s.value = String(pair[1]);
                s.dispatchEvent(new Event("input", { bubbles: true }));
                s.dispatchEvent(new Event("change", { bubbles: true }));
            });
            renderSizes();
            updateHead();
        }

        // The old resolution card duplicates the new size cards — park it.
        [].forEach.call(document.querySelectorAll(".mosaic-controls-panel"), function (n) {
            attic.appendChild(n);
        });

        /* -------------------------------------------------- ZUSCHNITT tab */
        C.heading(P.crop, "Zuschnitt", "Ausschnitt wählen: ziehen zum Verschieben, Mausrad zum Zoomen.");
        P.crop.appendChild(el("p", "bk-cr-hint",
            "Zieh das Bild im Vorschaufenster, um den Ausschnitt zu bestimmen. Mit dem Mausrad oder zwei Fingern zoomst du."));

        /* ----------------------------------------------------- FARBEN tab */
        C.heading(P.color, "Farben", "Welche Klemmbaustein-Farben im Mosaik vorkommen dürfen.");

        /* --------------------------------------------------- ANPASSEN tab */
        C.heading(P.adjust, "Anpassen", "Helligkeit, Kontrast und Sättigung des Motivs.");
        // These sliders already exist and are already wired; give them a proper
        // row each and move the real elements in.
        [
            ["brightness", "Helligkeit"],
            ["contrast",   "Kontrast"],
            ["saturation", "Sättigung"],
            ["hue",        "Farbton"],
            ["value",      "Hellwert"]
        ].forEach(function (f) {
            var slider = document.getElementById(f[0] + "-slider");
            if (!slider) return;
            var field = el("div", "bk-cr-field");
            var lab = el("div", "bk-cr-flabel", "<span>" + f[1] + "</span>");
            var val = document.getElementById(f[0] + "-text");
            if (val) { val.className = "bk-cr-fval"; lab.appendChild(val); }
            var row = el("div", "bk-cr-row");
            var dec = document.getElementById(f[0] + "-decrement");
            var inc = document.getElementById(f[0] + "-increment");
            if (dec) dec.className = "bk-cr-step";
            if (inc) inc.className = "bk-cr-step";
            row.append(dec || el("span"), slider, inc || el("span"));
            field.append(lab, row);
            P.adjust.appendChild(field);
        });
        // The three reset buttons all read "Reset" in the old UI; name them.
        var resetRow = el("div", "bk-cr-row");
        resetRow.style.gridTemplateColumns = "1fr 1fr 1fr";
        [["reset-brightness-button", "Helligkeit"],
         ["reset-contrast-button",   "Kontrast"],
         ["reset-hsv-button",        "Farbe"]].forEach(function (r) {
            var b = document.getElementById(r[0]);
            if (!b) return;
            b.className = "bk-cr-undo";
            b.textContent = "↺ " + r[1];
            resetRow.appendChild(b);
        });
        if (resetRow.children.length) {
            P.adjust.appendChild(el("p", "bk-cr-hint", "Zurücksetzen:"));
            P.adjust.appendChild(resetRow);
        }

        /* --------------------------------------------------------- KI tab */
        C.heading(P.ai, "KI-Werkzeuge", "Automatische Aufbereitung, Freistellen und Stile.");
        move(q("#bk-ai-tools") || q(".bk-ai-tools"), P.ai);

        /* ------------------------------------------------------ MALEN tab */
        C.heading(P.paint, "Malen", "Einzelne Noppen übermalen oder Flächen füllen.");

        /* ------------------------------------------------------ TIEFE tab */
        C.heading(P.depth, "Tiefe", "Mehrschichtige Tiefenplatten — das BRICKONAS-Extra.");

        /* ------------------------------------------------------- header */
        function updateHead() {
            var h = C.head();
            var w = +document.getElementById("width-slider").value;
            var ht = +document.getElementById("height-slider").value;
            h.size.innerHTML = (w * 0.8).toFixed(1).replace(".", ",") + " &times; " +
                               (ht * 0.8).toFixed(1).replace(".", ",") + " cm";
            var V = window.MOSAIC_VARIATIONS || {};
            var v = V[currentKey()];
            h.price.innerHTML = v ? v.price + " &euro;" : "";
            h.studs.textContent = w + " × " + ht + " Noppen";
        }
        ["width-slider", "height-slider", "width-step-select", "height-step-select"].forEach(function (id) {
            var n = document.getElementById(id);
            if (n) { n.addEventListener("input", updateHead); n.addEventListener("change", function () { updateHead(); renderSizes(); }); }
        });

        renderSizes();
        updateHead();
        C.select("size");
    }

    // Mount only once the customer actually has an image: before that the
    // classic upload screen (with its examples grid) is the right thing to show,
    // and it is what the reference tool does too.
    // The wizard reveals #step-navigation exactly when an image has been loaded
    // and processing has begun — the cleanest available "we have a picture" flag.
    function waitForImage() {
        var nav = document.getElementById("step-navigation");
        if (nav && nav.offsetParent !== null) { boot(); return; }
        setTimeout(waitForImage, 200);
    }
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", waitForImage);
    } else {
        waitForImage();
    }
})();
