/**
 * BRICKONAS Creator — panel contents.
 *
 * Fills the shell from bk-creator-ui.js. The rule throughout: RELOCATE existing
 * controls rather than rebuild them, so index.js keeps owning the behaviour.
 * The genuinely new pieces are the size picker (centimetres and price instead of
 * abstract stud counts) and the colour grid.
 *
 * Performance: the full pipeline is never run on a keystroke. Cheap changes redo
 * only the crop preview (index.js already debounces that); the expensive
 * quantisation runs on an explicit "Mosaik berechnen", and auto-runs only below
 * a resolution cap. Measured 2026-09-03: colour matching is 22 ms at 288x288 and
 * runs in a Web Worker, but greedy-with-dithering is 11.7 s — which is why
 * nothing recomputes behind the customer's back at high resolutions.
 */
(function () {
    "use strict";
    if (!/[?&]ui=new\b/.test(window.location.search)) return;

    var RECALC_DEBOUNCE_MS = 500;  // one compute after the customer stops fiddling

    function boot() {
        var C = window.BkCreator;
        if (!C) return;
        C.buildShell();

        var P = C.panels(), attic = C.attic(), view = C.view(), bar = C.stagebar(),
            el = C.el, move = C.move, q = C.q;

        /* ------------------------------------------------------ stage bar */
        bar.innerHTML =
            '<span>Zoom</span>' +
            '<input type="range" id="bk-cr-zoom-range" min="40" max="300" step="5" value="100">' +
            '<span id="bk-cr-zoom-val">100 %</span>' +
            '<button type="button" id="bk-cr-zoom-reset">Zurücksetzen</button>' +
            '<span class="bk-cr-spacer"></span>' +
            '<span class="bk-cr-busy" id="bk-cr-busy">Mosaik wird berechnet</span>' +
            '<button type="button" id="bk-cr-recalc">Neu berechnen</button>';

        function applyZoom() {
            var v = +document.getElementById("bk-cr-zoom-range").value;
            document.getElementById("bk-cr-zoom-val").textContent = v + " %";
            [].forEach.call(view.querySelectorAll(".mosaic-canvas-area"), function (n) {
                n.style.transform = "scale(" + (v / 100) + ")";
                n.style.transformOrigin = "center center";
            });
        }
        bar.addEventListener("input", applyZoom);
        bar.querySelector("#bk-cr-zoom-reset").addEventListener("click", function () {
            document.getElementById("bk-cr-zoom-range").value = 100;
            applyZoom();
        });

        /* ---------------------------------------------------------- stage */
        // Move the canvas AREA, never the bare canvas: Cropper.js wraps
        // #step-1-canvas-upscaled in its own DOM and lifting the canvas out of
        // that wrapper breaks cropping.
        // Find the canvas area by walking UP from the canvas itself. Guessing a
        // container id does not work: step 3's area sits under #visual-step-2,
        // not under #step-3-color-tab-content like step 4's does. Walking up also
        // survives the area being moved onto the stage.
        var CANVAS_OF = { "step-1": "step-1-canvas-upscaled",
                          "step-3": "step-3-canvas-upscaled",
                          "step-4": "step-4-canvas-upscaled" };
        function areaOf(step) {
            var c = document.getElementById(CANVAS_OF[step]);
            return c ? c.closest(".mosaic-canvas-area") : null;
        }
        // Each area holds TWO canvases: a small working one (one pixel per stud)
        // and the upscaled one that is actually displayed. Judge the upscaled one
        // — the working canvas is only 96 px wide and looks "empty" by size.
        function hasContent(step) {
            var c = document.getElementById(CANVAS_OF[step]);
            return !!(c && c.width > 300);
        }
        /**
         * Step 3 is THE canvas of this editor: it renders the mosaic as studs and
         * carries the paint/hover handlers. Everything except cropping should look
         * at it, so a colour, adjustment or size change is visible immediately.
         * Fall back to step 4, then to the raw crop preview while nothing is
         * computed yet.
         */
        function bestArea() {
            if (hasContent("step-3")) return areaOf("step-3");
            if (hasContent("step-4")) return areaOf("step-4");
            return areaOf("step-1");
        }
        // "Your preview is out of date" lives ON the picture, not in a corner.
        // One overlay, shown while a run is in flight, so a two-second wait never
        // reads as a frozen editor.
        var overlay = el("div", "bk-cr-stale");
        overlay.hidden = true;
        overlay.innerHTML =
            '<div class="bk-cr-stale-card">' +
              '<span class="bk-cr-spinner" aria-hidden="true"></span>' +
              "<b>Mosaik wird berechnet</b>" +
              '<p id="bk-cr-busy-sub">Einen Moment — die Noppen werden neu gesetzt.</p>' +
            "</div>";
        view.appendChild(overlay);
        function showBusy(on) {
            overlay.hidden = !on;
            view.classList.toggle("is-stale", !!on);
            if (on) {
                var sub = document.getElementById("bk-cr-busy-sub");
                if (sub) {
                    sub.textContent = document.getElementById("width-slider").value + " × " +
                        document.getElementById("height-slider").value + " Noppen werden gesetzt.";
                }
            }
        }

        var shownArea = null, currentTab = "size";
        function lift(area) {
            if (!area || area === shownArea) return;
            if (shownArea) attic.appendChild(shownArea);
            view.insertBefore(area, overlay);
            area.style.display = "";
            shownArea = area;
            applyZoom();
        }
        /**
         * Cropper.js measures its container when it is built. Moving that
         * container onto the stage leaves it with a stale (1 px wide) layout and
         * an invisible crop frame — which is exactly why cropping felt broken.
         * Give the area a real width for the crop view and rebuild the cropper.
         */
        // initializeCropper() destroys and recreates the cropper, which resets the
        // frame to the default. Carry the customer's frame across the rebuild,
        // otherwise coming back to this tab silently throws their crop away.
        var savedCrop = null;
        function fixCropper() {
            var cv = document.getElementById("step-1-canvas-upscaled");
            var area = cv && cv.closest(".mosaic-canvas-area");
            if (!area) return;
            if (cv.cropper) { try { savedCrop = cv.cropper.getData(true); } catch (e) { /* keep going */ } }
            area.style.width = Math.max(280, Math.min(view.clientWidth - 48, 620)) + "px";
            if (typeof window.initializeCropper !== "function") return;
            try { window.initializeCropper(); } catch (e) { return; }
            if (!savedCrop) return;
            var restore = function () {
                try { if (cv.cropper) cv.cropper.setData(savedCrop); } catch (e) { /* frame stays default */ }
            };
            cv.addEventListener("ready", restore, { once: true });
            setTimeout(restore, 220);   // belt and braces: 'ready' may already have fired
        }
        function unfixCropper() {
            var cv = document.getElementById("step-1-canvas-upscaled");
            var area = cv && cv.closest(".mosaic-canvas-area");
            if (area) area.style.width = "";
        }

        window.bkCrShowStage = function (tab) {
            var wasCrop = currentTab === "crop";
            currentTab = tab;
            if (tab === "crop") {
                lift(areaOf("step-1"));
                setTimeout(fixCropper, 60);
            } else {
                if (wasCrop) unfixCropper();
                lift(bestArea());
                // Deliberately NO recompute here: the crop is applied only by the
                // "Zuschnitt übernehmen" button. Recomputing on tab change applied
                // crops the customer never confirmed.
            }
        };
        setInterval(function () {
            if (currentTab !== "crop") lift(bestArea());
            if (typeof ensureStylePicker === "function") ensureStylePicker();
        }, 900);

        /* ------------------------------------------- full recalculation */
        var busy = document.getElementById("bk-cr-busy");
        function nextButton() {
            return document.getElementById("create-mosaic-btn");
        }
        var recalcTimer = null;
        function recalc() {
            var b = nextButton();
            if (!b) return;
            busy.classList.add("on");
            showBusy(true);
            b.click();
            // The pipeline is async and yields paint frames; watch for a result.
            var tries = 0;
            var poll = setInterval(function () {
                tries++;
                var done = !document.querySelector(".show-spinner");
                if (done || tries > 240) { clearInterval(poll); busy.classList.remove("on"); showBusy(false); }
            }, 500);
        }
        document.getElementById("bk-cr-recalc").addEventListener("click", recalc);

        /** Small mosaics may recompute on their own; big ones wait for a click. */
        /** Every change recomputes; the debounce turns a dragged slider into one run. */
        function maybeAutoRecalc() {
            clearTimeout(recalcTimer);
            recalcTimer = setTimeout(recalc, RECALC_DEBOUNCE_MS);
        }

        /**
         * Park the order card in the panel footer as soon as the app builds it,
         * and keep its figures honest.
         *
         * The app fills the card from `updateMosaicProductMeta()`, which only runs
         * off a slider event -- and none fires on load, so straight out of the box
         * the card still showed its hard-coded HTML defaults (48x48, 2.304 Teile,
         * 69,99 EUR). That was invisible while the card only appeared after
         * "Fertig"; now that it sits next to "Bestellen" from the start, a stale
         * price would be the worst bug this panel could have.
         */
        function refreshOrderCard() {
            if (typeof window.updateMosaicProductMeta === "function") {
                try { window.updateMosaicProductMeta(); } catch (e) { /* app not ready yet */ }
            }
        }
        function parkOrderCard() {
            var card = document.getElementById("mosaic-product-card"), foot = C.foot();
            if (!card || !foot) return false;
            if (card.parentElement !== foot) foot.appendChild(card);
            refreshOrderCard();
            return true;
        }

        window.bkCrFinish = function () {
            if (!parkOrderCard()) { recalc(); return; }
            // On a phone the order card is a sheet of its own -- keeping it
            // permanently below the controls ate 221 px of a 614 px sheet.
            if (C.isPhone()) { C.order(true); return; }
            var btn = document.getElementById("order-mosaic-button");
            if (btn) { btn.classList.add("bk-cr-pulse"); setTimeout(function () { btn.classList.remove("bk-cr-pulse"); }, 1400); }
        };

        /* ----------------------------------------------------- GRÖSSE tab */
        C.heading(P.size, "Größe", "Format wählen — die Preise gelten für das fertige Mosaik.");

        var SHAPES = [
            { id: "square", label: "Quadrat", icon: C.ICON.square, test: function (w, h) { return w === h; } },
            { id: "land",   label: "Quer",    icon: C.ICON.land,   test: function (w, h) { return w > h; } },
            { id: "port",   label: "Hoch",    icon: C.ICON.port,   test: function (w, h) { return h > w; } }
        ];
        var shapeRow = el("div", "bk-cr-shapes"), sizeList = el("div", "bk-cr-sizes"), activeShape = "square";
        SHAPES.forEach(function (s) {
            var b = el("button", "bk-cr-shape", C.svg(s.icon) + "<span>" + s.label + "</span>");
            b.type = "button";
            b.setAttribute("aria-pressed", s.id === activeShape ? "true" : "false");
            b.addEventListener("click", function () {
                activeShape = s.id;
                [].forEach.call(shapeRow.children, function (c) { c.setAttribute("aria-pressed", c === b ? "true" : "false"); });
                renderSizes();
            });
            shapeRow.appendChild(b);
        });
        P.size.append(shapeRow, sizeList);

        /** 192 instead of "192,0" -- the decimal is noise and costs a line break. */
        function cm(studs) {
            var v = studs * 0.8;
            return (v % 1 ? v.toFixed(1) : String(v)).replace(".", ",");
        }

        function variations() {
            var V = window.MOSAIC_VARIATIONS || {};
            return Object.keys(V).map(function (k) {
                var m = /^(\d+)er_(\d+)x(\d+)$/.exec(k);
                if (!m) return null;
                return { key: k, plate: +m[1], w: +m[2], h: +m[3], price: V[k].price };
            }).filter(Boolean);
        }
        function currentKey() {
            return document.getElementById("width-step-select").value + "er_" +
                   document.getElementById("width-slider").value + "x" +
                   document.getElementById("height-slider").value;
        }
        function renderSizes() {
            var shape = SHAPES.find(function (s) { return s.id === activeShape; });
            var list = variations().filter(function (v) { return shape.test(v.w, v.h); })
                                   .sort(function (a, b) { return (a.w * a.h) - (b.w * b.h); });
            var cur = currentKey();
            sizeList.innerHTML = "";
            list.forEach(function (v) {
                // Proportional preview: the tile mirrors the real aspect ratio.
                var long = Math.max(v.w, v.h), pw = Math.round(38 * v.w / long), ph = Math.round(38 * v.h / long);
                var card = el("button", "bk-cr-size-card");
                card.type = "button";
                card.setAttribute("aria-pressed", v.key === cur ? "true" : "false");
                card.innerHTML =
                    '<span class="bk-cr-prop"><i style="width:' + pw + 'px;height:' + ph + 'px"></i></span>' +
                    '<span class="bk-cr-size-txt">' +
                        '<span class="bk-cr-size-top">' +
                            '<span class="bk-cr-size-cm">' + cm(v.w) + " &times; " + cm(v.h) + ' cm</span>' +
                            '<span class="bk-cr-size-price">' + v.price + " &euro;</span>" +
                        "</span>" +
                        '<span class="bk-cr-size-sub">' + (v.w / v.plate) + " &times; " + (v.h / v.plate) +
                        " Platten &middot; " + v.w + "&times;" + v.h + " Noppen</span></span>";
                card.addEventListener("click", function () { pickSize(v); });
                sizeList.appendChild(card);
            });
        }
        function pickSize(v) {
            ["width-step-select", "height-step-select"].forEach(function (id) {
                var s = document.getElementById(id);
                if (s && s.value !== String(v.plate)) { s.value = String(v.plate); s.dispatchEvent(new Event("change", { bubbles: true })); }
            });
            [["width-slider", v.w], ["height-slider", v.h]].forEach(function (p2) {
                var s = document.getElementById(p2[0]);
                if (!s) return;
                s.value = String(p2[1]);
                s.dispatchEvent(new Event("input", { bubbles: true }));
                s.dispatchEvent(new Event("change", { bubbles: true }));
            });
            renderSizes(); updateHead(); maybeAutoRecalc();
        }

        /* -------------------------------------------------- ZUSCHNITT tab */
        C.heading(P.crop, "Zuschnitt", "Der Rahmen zeigt, was gebaut wird — alles außerhalb fällt weg.");
        P.crop.appendChild(el("p", "bk-cr-note",
            "Der Rahmen ist auf dein gewähltes Format festgelegt. Zieh ihn an eine andere Stelle " +
            "oder an den Ecken größer und kleiner."));

        function cropper() {
            var c = document.getElementById("step-1-canvas-upscaled");
            return c ? c.cropper : null;
        }
        var cropBtns = el("div", "bk-cr-cropbtns");
        [
            ["Ganzes Bild", '<rect x="3" y="4" width="18" height="16" rx="2"/>', function (cr) {
                var d = cr.getCanvasData();
                cr.setCropBoxData({ left: d.left, top: d.top, width: d.width, height: d.height });
            }],
            ["Mittig setzen", '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M3 3h2M19 3h2M3 21h2M19 21h2"/>', function (cr) { cr.reset(); }],
            ["90° drehen", '<path d="M4 12a8 8 0 1 1 3 6"/><path d="M4 12V7m0 5h5"/>', function (cr) { cr.rotate(90); }],
            ["Anderes Bild", '<path d="M4 16l5-5 4 4 3-3 4 4"/><rect x="3" y="4" width="18" height="16" rx="2"/>', null]
        ].forEach(function (t) {
            var b = el("button", "bk-cr-cropbtn", C.svg(t[1]) + "<span>" + t[0] + "</span>");
            b.type = "button";
            b.addEventListener("click", function () {
                if (t[2]) { var cr = cropper(); if (cr) { t[2](cr); } }
                else { var pick = document.getElementById("image-input-new"); if (pick) { var real = pick.querySelector("button,input,label") || pick; real.click(); } }
            });
            cropBtns.appendChild(b);
        });
        P.crop.appendChild(cropBtns);

        var applyCrop = el("button", "bk-cr-primary", "Zuschnitt übernehmen");
        applyCrop.type = "button";
        applyCrop.addEventListener("click", function () {
            var cv = document.getElementById("step-1-canvas-upscaled");
            if (cv && cv.cropper) { try { savedCrop = cv.cropper.getData(true); } catch (e) { /* ignore */ } }
            recalc();
            C.select("size");
        });
        P.crop.appendChild(applyCrop);
        P.crop.appendChild(el("p", "bk-cr-hint",
            "Solange du hier bist, siehst du das Originalfoto. Nach dem Übernehmen zeigt der Editor wieder das Mosaik."));

        /* ----------------------------------------------------- FARBEN tab */
        C.heading(P.color, "Steine", "Welche Klemmbaustein-Farben verwendet werden dürfen.");
        var paletteBox = el("div"), paletteCount = el("p", "bk-cr-swcount", "");
        P.color.append(paletteBox, paletteCount);
        var presetBtn = document.getElementById("select-starting-custom-stud-map-button");
        if (presetBtn) {
            var wrap = el("div"); wrap.style.marginBottom = "14px";
            wrap.appendChild(presetBtn);
            var opts = document.getElementById("select-starting-custom-stud-map-options");
            if (opts) wrap.appendChild(opts);
            P.color.insertBefore(wrap, paletteBox);
        }
        function paletteRows() {
            var body = document.getElementById("custom-stud-table-body");
            return body ? [].slice.call(body.children) : [];
        }
        function renderPalette() {
            var rows = paletteRows();
            paletteBox.innerHTML = "";
            var grid = el("div", "bk-cr-swatches");
            rows.forEach(function (row) {
                var chip = row.querySelector("button div[style*='background']");
                if (!chip) return;
                var name = (row.querySelector("[data-original-title]") || {}).getAttribute
                    ? row.querySelector("[data-original-title]").getAttribute("data-original-title") : "";
                var b = el("button", "bk-cr-sw");
                b.type = "button";
                b.style.background = chip.style.backgroundColor;
                b.title = (name || "Farbe") + " — anklicken, um sie zu entfernen";
                b.setAttribute("aria-pressed", "true");
                b.addEventListener("click", function () {
                    var x = row.querySelector('button[type="submit"], button.btn-danger, td:last-child button');
                    if (x) { x.click(); setTimeout(function () { renderPalette(); maybeAutoRecalc(); }, 120); }
                });
                grid.appendChild(b);
            });
            paletteBox.appendChild(grid);
            paletteCount.textContent = rows.length + " Farben aktiv · Klick entfernt eine Farbe";
        }
        renderPalette();

        /* --------------------------------------------------- ANPASSEN tab */
        /* ------------------------------------------------------- STIL tab
         * The live site has five style presets with a real preview on each
         * tile -- Original, Vintage, Pop, Warm, S/W -- and the Creator did not
         * offer them at all. They live here now and lead the panel, because a
         * preset is what a customer actually wants ("mach es wärmer"); the five
         * sliders that used to be their own "Anpassen" tab follow underneath as
         * the fine control for the same question. */
        C.heading(P.style, "Stil", "Eine Vorlage wählen — darunter lässt sich alles fein nachregeln.");
        P.style.appendChild(el("p", "bk-cr-glabel", "Stil-Vorlagen"));
        var stylePicker = q("#bk-style-picker");
        if (stylePicker) P.style.appendChild(stylePicker);
        else P.style.appendChild(el("p", "bk-cr-hint", "Stil-Vorlagen stehen bereit, sobald das Mosaik berechnet ist."));

        P.style.appendChild(el("p", "bk-cr-glabel", "Feinjustierung"));
        [["brightness", "Helligkeit"], ["contrast", "Kontrast"], ["saturation", "Sättigung"],
         ["hue", "Farbton"], ["value", "Hellwert"]].forEach(function (f) {
            var slider = document.getElementById(f[0] + "-slider");
            if (!slider) return;
            var field = el("div", "bk-cr-field");
            var lab = el("div", "bk-cr-flabel", "<span>" + f[1] + "</span>");
            var val = document.getElementById(f[0] + "-text");
            if (val) { val.className = "bk-cr-fval"; lab.appendChild(val); }
            var row = el("div", "bk-cr-row");
            var dec = document.getElementById(f[0] + "-decrement"), inc = document.getElementById(f[0] + "-increment");
            if (dec) dec.className = "bk-cr-step";
            if (inc) inc.className = "bk-cr-step";
            row.append(dec || el("span"), slider, inc || el("span"));
            field.append(lab, row);
            P.style.appendChild(field);
            slider.addEventListener("change", maybeAutoRecalc);
        });
        var resetRow = el("div", "bk-cr-row");
        resetRow.style.gridTemplateColumns = "1fr 1fr 1fr";
        [["reset-brightness-button", "Helligkeit"], ["reset-contrast-button", "Kontrast"],
         ["reset-hsv-button", "Farbe"]].forEach(function (r) {
            var b = document.getElementById(r[0]);
            if (!b) return;
            b.className = "bk-cr-undo"; b.textContent = "↺ " + r[1];
            resetRow.appendChild(b);
        });
        if (resetRow.children.length) {
            P.style.appendChild(el("p", "bk-cr-hint", "Zurücksetzen:"));
            P.style.appendChild(resetRow);
        }

        /**
         * The picker builds itself off the app's own "we reached step 2" event:
         * that call snapshots the untouched palette (which is what the Original
         * tile restores), builds the tiles and renders their previews. The
         * Creator has no wizard steps, so it announces step 2 once the first
         * mosaic exists. The same handler HIDES the picker for every other step
         * and the app still fires that event from its own code, so visibility is
         * re-asserted rather than set once.
         */
        var styleAnnounced = false;
        function ensureStylePicker() {
            if (!stylePicker) return;
            if (!styleAnnounced && hasContent("step-3")) {
                styleAnnounced = true;
                document.dispatchEvent(new CustomEvent("bk-visual-step-change", { detail: { step: 2 } }));
            }
            if (styleAnnounced && stylePicker.hidden) stylePicker.hidden = false;
        }

        /* --------------------------------------------------------- KI tab */
        C.heading(P.ai, "KI-Werkzeuge", "Aufbereiten, freistellen — oder frei beschreiben.");
        move(q("#bk-ai-tools") || q(".bk-ai-tools"), P.ai);
        restructureAi();

        /**
         * The AI panel arrived as a card inside a card, with its own violet and
         * amber palette and the free-text field folded away behind a dashed
         * orange box -- the one part of the editor that looked like it came from
         * somewhere else. Same nodes, same ids, same handlers; only the order
         * and the grouping change, and the styling is taken over by the panel.
         */
        function restructureAi() {
            var tools = document.getElementById("bk-ai-tools");
            if (!tools) return;

            // The promise that the photo never leaves the browser is worth
            // keeping -- as the panel's own note, not as a card headline.
            var head = tools.querySelector(".bk-ai-head");
            if (head) {
                // The app's wording runs to three lines here; the promise that
                // matters is the second half of it, and every line spent above
                // the conversation is a line the conversation does not get.
                var note = el("p", "bk-cr-note",
                    "Alles passiert in deinem Browser — dein Bild wird nicht hochgeladen.");
                tools.insertBefore(note, tools.firstChild);
                head.remove();
            }

            // "Zurücksetzen" belongs to the group it resets, not to a row of its
            // own -- that row alone cost 48 px and pushed the text field below
            // the fold on a 800 px screen.
            var actions = tools.querySelector(".bk-ai-actions");
            var reset = tools.querySelector(".bk-ai-reset");
            if (actions) {
                var row = el("div", "bk-cr-grow");
                row.appendChild(el("p", "bk-cr-glabel", "Mit einem Klick"));
                if (reset) row.appendChild(reset);
                tools.insertBefore(row, actions);
            }

            // Open the free-text field and drop its toggle: a collapsed control
            // that nobody opens is a control that does not exist.
            var chat = document.getElementById("bk-ai-chat");
            var toggle = document.getElementById("bk-ai-chat-toggle");
            if (chat) {
                chat.hidden = false;
                tools.insertBefore(el("p", "bk-cr-glabel", "Eigener Wunsch"), chat);
                tools.appendChild(chat);
            }
            if (toggle) toggle.remove();
        }

        /* ------------------------------------------------------ MALEN tab */
        C.heading(P.paint, "Malen", "Einzelne Noppen übermalen, radieren oder eine Farbe aufnehmen.");
        var tools = el("div", "bk-cr-tools");
        [["paintbrush-tool-dropdown-option", "Stift", C.ICON.pen],
         ["eraser-tool-dropdown-option", "Radierer", C.ICON.swap],
         ["dropdown-tool-dropdown-option", "Pipette", C.ICON.pick]].forEach(function (t) {
            var src = document.getElementById(t[0]);
            if (!src) return;
            var b = el("button", "bk-cr-tool", C.svg(t[2]) + "<span>" + t[1] + "</span>");
            b.type = "button";
            b.setAttribute("aria-pressed", t[0] === "paintbrush-tool-dropdown-option" ? "true" : "false");
            b.addEventListener("click", function () {
                src.click();
                [].forEach.call(tools.children, function (c) { c.setAttribute("aria-pressed", c === b ? "true" : "false"); });
            });
            tools.appendChild(b);
        });
        if (tools.children.length) P.paint.appendChild(tools);
        move(document.getElementById("paintbrush-controls"), P.paint);
        P.paint.appendChild(el("p", "bk-cr-hint",
            "Wähle eine Farbe und klicke im Mosaik auf eine Noppe. Das Ergebnis bleibt beim Neuberechnen erhalten."));

        /* ------------------------------------------------------- header */
        function updateHead() {
            var ch = C.chips();
            var w = +document.getElementById("width-slider").value,
                h = +document.getElementById("height-slider").value;
            ch.size.querySelector("b").innerHTML =
                (w * 0.8).toFixed(1).replace(".", ",") + " &times; " + (h * 0.8).toFixed(1).replace(".", ",") + " cm";
            ch.studs.querySelector("b").textContent = w + " × " + h;
            var v = (window.MOSAIC_VARIATIONS || {})[currentKey()];
            ch.price.querySelector("b").innerHTML = v ? v.price + " &euro;" : "—";
            parkOrderCard();
        }
        ["width-slider", "height-slider", "width-step-select", "height-step-select"].forEach(function (id) {
            var n = document.getElementById(id);
            if (!n) return;
            n.addEventListener("input", updateHead);
            n.addEventListener("change", function () { updateHead(); renderSizes(); });
        });

        // The old resolution card duplicates the new size cards — park it.
        [].forEach.call(document.querySelectorAll(".mosaic-controls-panel"), function (n) { attic.appendChild(n); });

        renderSizes(); updateHead(); C.select("size");

        // The app builds the order card only after the first mosaic is computed,
        // so polling once is not enough -- watch until it appears, then stop.
        if (!parkOrderCard() && window.MutationObserver) {
            var mo = new MutationObserver(function () { if (parkOrderCard()) mo.disconnect(); });
            mo.observe(document.body, { childList: true, subtree: true });
        }

        // Without this the editor would open on the raw photo and every control
        // would look broken: the mosaic canvas simply would not exist yet.
        setTimeout(function () { if (!hasContent("step-3")) recalc(); }, 400);
    }

    /**
     * "The customer has a picture" — tested WITHOUT touching layout. offsetParent
     * was the obvious check but it is null whenever the document is not being
     * laid out, which is exactly the case inside an iframe on a page the browser
     * is not painting; the editor then never mounted on the shop page. Resolved
     * style plus the canvas size work regardless.
     */
    /** display:none on an ANCESTOR leaves the element's own computed display
     *  untouched, so the whole chain has to be walked. */
    function hiddenByAnyAncestor(el) {
        for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
            var st = getComputedStyle(n);
            if (st.display === "none" || st.visibility === "hidden") return true;
        }
        return false;
    }
    function hasImage() {
        var c = document.getElementById("step-1-canvas-upscaled");
        if (!c || c.width <= 300) return false;   // still the untouched default canvas
        var ex = document.getElementById("mosaic-examples");
        return !ex || hiddenByAnyAncestor(ex);    // upload card gone = a picture is in
    }
    function waitForImage() {
        if (hasImage()) { boot(); return; }
        setTimeout(waitForImage, 200);
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", waitForImage);
    else waitForImage();
})();
