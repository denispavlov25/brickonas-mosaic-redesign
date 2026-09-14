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

    /* A size card on the shop page ("Jetzt gestalten" on 76,8 x 76,8 cm) should
       land on that size. It arrives in the URL on the first open and as a
       message after that; it can only be applied once the editor exists,
       which is after the customer has chosen a picture. */
    var pendingSize = (function () {
        var q = new URLSearchParams(window.location.search);
        return q.get("bk_size") ? { size: q.get("bk_size"), plate: q.get("bk_plate") || "" } : null;
    })();
    var applyPendingSize = null;   // set by boot()
    window.addEventListener("message", function (e) {
        var d = e.data;
        if (!d || d.bk !== "mosaic-size" || !d.size) return;
        pendingSize = { size: d.size, plate: d.plate || "" };
        if (applyPendingSize) applyPendingSize();
    });

    function boot() {
        var C = window.BkCreator;
        if (!C) return;
        C.buildShell();

        var P = C.panels(), attic = C.attic(), view = C.view(), bar = C.stagebar(),
            el = C.el, move = C.move, q = C.q;

        /* ------------------------------------------------------ stage bar */
        bar.innerHTML =
            // First in the bar so it is visible without scrolling on a phone.
            '<button type="button" id="bk-cr-newimage" class="bk-cr-newimage">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M4 16l5-5 4 4 3-3 4 4"/></svg>' +
              '<span>Neues Bild</span></button>' +
            /* One zoom group that serves both widths. A mouse gets the slider
               and a labelled reset; a phone gets - 100 % + instead, where the
               percentage itself is the reset. The slider plus two text buttons
               needed ~640 px and scrolled "Zurücksetzen" and "Neu berechnen"
               out of sight on every phone. */
            '<span class="bk-cr-zgroup">' +
              '<span class="bk-cr-zlabel">Zoom</span>' +
              '<button type="button" id="bk-cr-zoom-out" class="bk-cr-zbtn" aria-label="Verkleinern">&minus;</button>' +
              '<input type="range" id="bk-cr-zoom-range" min="40" max="300" step="5" value="100" aria-label="Zoom">' +
              '<button type="button" id="bk-cr-zoom-val" class="bk-cr-zval" title="Auf 100 % zurücksetzen">100 %</button>' +
              '<button type="button" id="bk-cr-zoom-in" class="bk-cr-zbtn" aria-label="Vergrößern">+</button>' +
              '<button type="button" id="bk-cr-zoom-reset">Zurücksetzen</button>' +
            '</span>' +
            '<span class="bk-cr-spacer"></span>' +
            '<span class="bk-cr-busy" id="bk-cr-busy">Mosaik wird berechnet</span>' +
            '<button type="button" id="bk-cr-recalc" title="Neu berechnen" aria-label="Neu berechnen">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>' +
              '<span>Neu berechnen</span></button>';

        function applyZoom() {
            var v = +document.getElementById("bk-cr-zoom-range").value;
            document.getElementById("bk-cr-zoom-val").textContent = v + " %";
            [].forEach.call(view.querySelectorAll(".mosaic-canvas-area"), function (n) {
                n.style.transform = "scale(" + (v / 100) + ")";
                n.style.transformOrigin = "center center";
            });
        }
        bar.addEventListener("input", applyZoom);

        /**
         * Back to the start screen for a different picture. Owner: there was no
         * way to choose another image -- the only route ("Anderes Bild") sat in
         * the Zuschnitt tab and opened a bare file dialog, without the example
         * pictures, and did not recompute the mosaic afterwards either.
         *
         * Reloading the document is deliberate: it lands on the real upload
         * screen with upload AND examples and leaves no half-updated state
         * behind. The query string survives, so ?ui=new and ?admin=... stay.
         */
        function chooseNewImage() {
            var ok = window.confirm("Neues Bild wählen?\n\nDein aktuelles Mosaik und die Einstellungen " +
                                    "(Größe, Stil, Farben) werden dabei verworfen.");
            if (ok) window.location.reload();
        }
        bar.querySelector("#bk-cr-newimage").addEventListener("click", chooseNewImage);
        function stepZoom(delta) {
            var r = document.getElementById("bk-cr-zoom-range");
            r.value = String(Math.max(+r.min, Math.min(+r.max, +r.value + delta)));
            applyZoom();
        }
        bar.querySelector("#bk-cr-zoom-out").addEventListener("click", function () { stepZoom(-20); });
        bar.querySelector("#bk-cr-zoom-in").addEventListener("click", function () { stepZoom(20); });
        bar.querySelector("#bk-cr-zoom-val").addEventListener("click", function () {
            document.getElementById("bk-cr-zoom-range").value = 100;
            applyZoom();
        });
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

        /* ------------------------------------------- PDF progress overlay ----
         * Building the instruction PDF is the longest thing this editor does --
         * measured at ~40 s for one admin export -- and until now it showed a
         * disabled button and nothing else. Its own progress bar was written to
         * an element inside a display:none block. This one sits on the picture,
         * where the other waiting states already live. */
        var pdfOverlay = el("div", "bk-cr-stale bk-cr-stale--pdf");
        pdfOverlay.hidden = true;
        pdfOverlay.innerHTML =
            '<div class="bk-cr-stale-card">' +
              '<span class="bk-cr-spinner" aria-hidden="true"></span>' +
              "<b>Anleitung wird erstellt</b>" +
              '<p id="bk-cr-pdf-sub">Das kann bei großen Mosaiks bis zu einer Minute dauern.</p>' +
              '<div class="bk-cr-bar"><i id="bk-cr-pdf-bar"></i></div>' +
              '<p class="bk-cr-pdf-warn">Bitte die Seite nicht schließen.</p>' +
            "</div>";
        view.appendChild(pdfOverlay);
        // Looked up once: a 288x288 export fires this ~1330 times.
        var pdfBar = pdfOverlay.querySelector("#bk-cr-pdf-bar");
        var pdfSub = pdfOverlay.querySelector("#bk-cr-pdf-sub");
        document.addEventListener("bk-pdf-progress", function (e) {
            var d = e.detail || {};
            if (d.done) { pdfOverlay.hidden = true; return; }
            pdfOverlay.hidden = false;
            if (pdfBar) pdfBar.style.width = d.pct + "%";
            if (pdfSub) pdfSub.textContent = d.label ? d.label + " · " + d.pct + " %" : d.pct + " %";
        });

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
        var recalcTimer = null, recalcPoll = null;

        /**
         * Run something that makes the app recompute, with the editor's own wait
         * on the picture. The app's full-screen loader is suppressed inside the
         * editor (it flashed white), so anything that recomputes WITHOUT going
         * through here would show no indicator at all -- which is exactly what
         * the new reset buttons would otherwise have done.
         */
        function runWithBusy(fn) {
            busy.classList.add("on");
            showBusy(true);
            fn();
            watchUntilIdle();
        }
        function recalc() {
            var b = nextButton();
            if (!b) return;
            busy.classList.add("on");
            showBusy(true);
            b.click();
            watchUntilIdle();
        }
        function watchUntilIdle() {
            // The pipeline is async and yields paint frames; watch for a result.
            //
            // Single-flight on purpose. Each call used to open its OWN 500 ms
            // watcher and nothing ever closed the previous one, so three clicks
            // left three watchers running for up to 240 ticks (two minutes) each
            // -- and whichever saw an idle spinner first cleared the wait
            // indicator, even while another run was still going.
            if (recalcPoll) clearInterval(recalcPoll);
            var tries = 0;
            recalcPoll = setInterval(function () {
                tries++;
                var done = !document.querySelector(".show-spinner");
                if (done || tries > 240) {
                    clearInterval(recalcPoll);
                    recalcPoll = null;
                    busy.classList.remove("on");
                    showBusy(false);
                }
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
            mountCartButton();
            return true;
        }

        /* ------------------------------------------------ "Zum Warenkorb" ----
         * After a successful add the order button used to turn grey ("Im
         * Warenkorb") and that was the end of the road: the customer had to find
         * their own way out of the editor to the cart. The next step is now a
         * button.
         *
         * The address comes from WooCommerce itself -- the shop page exposes
         * wc_add_to_cart_params.cart_url, and this frame is same-origin -- so no
         * host or slug is written into the configurator. It navigates the TOP
         * window: the cart must not open inside the editor's frame. */
        var CART_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>';
        function cartUrl() {
            try {
                var p = window.parent;
                if (p && p.wc_add_to_cart_params && p.wc_add_to_cart_params.cart_url) return p.wc_add_to_cart_params.cart_url;
            } catch (e) { /* not same-origin */ }
            try {
                if (window.wc_add_to_cart_params && window.wc_add_to_cart_params.cart_url) return window.wc_add_to_cart_params.cart_url;
            } catch (e) { /* ignore */ }
            return "/warenkorb/";
        }
        function goToCart() {
            var url = cartUrl();
            try { window.top.location.href = url; } catch (e) { window.location.href = url; }
        }
        function isAdded() {
            var ob = document.getElementById("order-mosaic-button");
            return !!(ob && ob.classList.contains("bk-added"));
        }

        /**
         * The button sits right after the app's own order button, and CSS shows
         * one or the other off the app's `bk-added` class. No state is copied:
         * when the customer changes the design afterwards, the app resets its
         * button and this one disappears with it.
         */
        function mountCartButton() {
            var ob = document.getElementById("order-mosaic-button");
            if (!ob || ob.parentElement.querySelector(".bk-cr-gocart")) return;
            var go = el("button", "bk-cr-gocart", CART_ICON + "<span>Zum Warenkorb</span><span aria-hidden=\"true\">&rarr;</span>");
            go.type = "button";
            go.addEventListener("click", goToCart);
            ob.insertAdjacentElement("afterend", go);

            // The header's primary action follows along: "Fertig" opens the order
            // card, which is pointless once the mosaic is already in the cart.
            var fin = document.querySelector(".bk-cr-finish");
            function syncFinish() {
                if (!fin) return;
                var added = isAdded();
                fin.classList.toggle("is-cart", added);
                fin.innerHTML = added
                    ? CART_ICON + '<span class="bk-cr-fin-long">Zum&nbsp;</span>Warenkorb<span class="bk-cr-fin-long">&nbsp;&rarr;</span>'
                    : "Fertig &rarr;";
                fin.setAttribute("aria-label", added ? "Zum Warenkorb" : "Fertig");
            }
            new MutationObserver(syncFinish).observe(ob, { attributes: true, attributeFilter: ["class"] });
            syncFinish();
        }

        window.bkCrFinish = function () {
            if (isAdded()) { goToCart(); return; }
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
            return Object.keys(V).filter(function (k) {
                // Admin test sizes are registered on demand and must not show up
                // among the sizes a customer can buy.
                return !V[k].admin;
            }).map(function (k) {
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
                var card = el("button", "bk-cr-size-card");
                card.type = "button";
                card.dataset.key = v.key;
                card.setAttribute("aria-pressed", v.key === cur ? "true" : "false");
                card.innerHTML =
                    plateIcon(v) +
                    '<span class="bk-cr-size-txt">' +
                        '<span class="bk-cr-size-top">' +
                            '<span class="bk-cr-size-cm">' + cm(v.w) + " &times; " + cm(v.h) + ' cm</span>' +
                            '<span class="bk-cr-size-price">' + v.price + " &euro;</span>" +
                        "</span>" +
                        // Studs first: that is the number which actually differs
                        // between two cards of the same plate count, and it is what
                        // decides how much detail the picture keeps. The plate count
                        // stays a plain total, so the line carries only ONE "x" pair
                        // -- "2 x 1 Platten - 64x32 Noppen" put two multiplications
                        // side by side and read as one garbled number.
                        '<span class="bk-cr-size-sub">' + v.w + " &times; " + v.h + " Noppen &middot; " +
                        plateCount(v) + "</span></span>";
                card.addEventListener("click", function () { pickSize(v); });
                sizeList.appendChild(card);
            });
        }
        /* ------------------------------------------- ADMIN: 16er plates ----
         * 16-stud plates exist only for checking instruction-PDF layouts, and
         * they have no WooCommerce variation. Enumerating them as cards is out
         * of the question -- 16 to 288 in 16-stud steps is 18 values per axis,
         * i.e. 324 combinations -- so the admin gets the exact controls instead,
         * which is also what the old slider offered. */
        function buildAdminPlate16() {
            if (!window.BK_ADMIN || typeof window.bkAdminRegister16 !== "function") return;

            P.size.appendChild(el("p", "bk-cr-glabel", "Admin · 16er-Platten"));
            P.size.appendChild(el("p", "bk-cr-note",
                "Testgrößen für Anleitungs-Layouts. Es gibt dafür keine Shop-Variante — " +
                "sie sind nicht bestellbar, der Preis ist gerechnet."));

            var state = { w: 128, h: 80 };
            var out = el("p", "bk-cr-swcount", "");

            function stepper(label, key) {
                var field = el("div", "bk-cr-field");
                var lab = el("div", "bk-cr-flabel", "<span>" + label + "</span>");
                var val = el("span", "bk-cr-fval", String(state[key]));
                lab.appendChild(val);
                var row = el("div", "bk-cr-row");
                var dec = el("button", "bk-cr-step", "&minus;"), inc = el("button", "bk-cr-step", "+");
                dec.type = inc.type = "button";
                var range = document.createElement("input");
                range.type = "range"; range.min = "16"; range.max = "288"; range.step = "16";
                range.value = String(state[key]);
                function set(v) {
                    state[key] = Math.max(16, Math.min(288, Math.round(v / 16) * 16));
                    range.value = val.textContent = String(state[key]);
                    refresh();
                }
                dec.addEventListener("click", function () { set(state[key] - 16); });
                inc.addEventListener("click", function () { set(state[key] + 16); });
                range.addEventListener("input", function () { set(+range.value); });
                row.append(dec, range, inc);
                field.append(lab, row);
                P.size.appendChild(field);
            }

            function refresh() {
                var plates = (state.w / 16) * (state.h / 16);
                out.innerHTML = cm(state.w) + " &times; " + cm(state.h) + " cm &middot; " +
                    state.w + " &times; " + state.h + " Noppen &middot; " + plates + " Platten &middot; " +
                    window.bkAdminPrice16(state.w, state.h) + " &euro; (gerechnet)";
            }

            stepper("Breite", "w");
            stepper("Höhe", "h");
            P.size.appendChild(out);

            var apply = el("button", "bk-cr-finish", "16er-Größe anwenden");
            apply.type = "button";
            apply.style.width = "100%";
            apply.style.justifyContent = "center";
            apply.style.marginTop = "10px";
            apply.addEventListener("click", function () {
                window.bkAdminRegister16(state.w, state.h);
                pickSize({ plate: 16, w: state.w, h: state.h });
            });
            P.size.appendChild(apply);
            refresh();
        }

        function plateCount(v) {
            var n = (v.w / v.plate) * (v.h / v.plate);
            return n === 1 ? "1 Platte" : n + " Platten";
        }

        /**
         * The icon IS the plate layout: a rectangle in the real proportions, cut
         * into the real number of plates. The old one painted a fixed 3 px stud
         * texture that matched no actual stud count and collapsed into a bare
         * line at 6:1 (288x48) -- decoration that told the customer nothing.
         * The short side keeps a floor so a panorama stays readable; the ratio is
         * then slightly off, which is the right trade for an icon this size.
         */
        function plateIcon(v) {
            var BOX_W = 48, BOX_H = 34, MIN = 9;
            var ratio = v.w / v.h, pw, ph;
            if (ratio >= BOX_W / BOX_H) {
                pw = BOX_W; ph = Math.max(MIN, Math.round(BOX_W / ratio));
            } else {
                ph = BOX_H; pw = Math.max(MIN, Math.round(BOX_H * ratio));
            }
            var cols = v.w / v.plate, rows = v.h / v.plate;
            var cells = new Array(cols * rows + 1).join("<i></i>");
            return '<span class="bk-cr-prop"><span class="bk-cr-plate" style="width:' + pw +
                   "px;height:" + ph + "px;grid-template-columns:repeat(" + cols +
                   ",1fr);grid-template-rows:repeat(" + rows + ',1fr)">' + cells + "</span></span>";
        }

        /**
         * Only the selection changes when a card is clicked, so only the selection
         * is written. renderSizes() rebuilt all sixteen cards including their
         * plate grids (measured 2,5 ms and ~180 elements) to move one attribute.
         */
        function markSelected() {
            var cur = currentKey();
            [].forEach.call(sizeList.children, function (c) {
                c.setAttribute("aria-pressed", c.dataset.key === cur ? "true" : "false");
            });
        }

        function pickSize(v) {
            ["width-step-select", "height-step-select"].forEach(function (id) {
                var s = document.getElementById(id);
                if (s && s.value !== String(v.plate)) { s.value = String(v.plate); s.dispatchEvent(new Event("change", { bubbles: true })); }
            });
            /*
             * Set both values FIRST, then fire the events -- and fire "change"
             * only once.
             *
             * Firing input+change on each slider ran the app's
             * handleResolutionChange() FOUR times per card click, and that
             * routine rebuilds Cropper.js every time: measured 4 rebuilds and
             * 86 ms of the 88 ms a click cost. The end state is identical with
             * one run, because the "input" handler already writes BOTH
             * targetResolution entries and both labels from the sliders' current
             * values -- so width's own "change" adds nothing once the values are
             * in place.
             */
            var ws = document.getElementById("width-slider"),
                hs = document.getElementById("height-slider");
            if (ws) ws.value = String(v.w);
            if (hs) hs.value = String(v.h);
            if (ws) ws.dispatchEvent(new Event("input", { bubbles: true }));
            if (hs) {
                hs.dispatchEvent(new Event("input", { bubbles: true }));
                hs.dispatchEvent(new Event("change", { bubbles: true }));
            }
            markSelected(); updateHead();
            // Show the wait NOW, not when the debounce finally fires: the click
            // is the moment the customer starts waiting, and the ~1,2 s until
            // the recompute begins is otherwise completely silent.
            showBusy(true);
            maybeAutoRecalc();
        }

        /**
         * The same row the KI panel already has: a group label on the left and
         * "Zurücksetzen" on its right. Owner: Steine, Malen and Zuschnitt had no
         * way to undo, only KI did.
         */
        function makeResetRow(panel, label, onReset, before) {
            var row = el("div", "bk-cr-grow");
            row.appendChild(el("p", "bk-cr-glabel", label));
            var btn = el("button", "bk-cr-undo bk-cr-reset", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg><span>Zurücksetzen</span>');
            btn.type = "button";
            btn.addEventListener("click", onReset);
            row.appendChild(btn);
            if (before) panel.insertBefore(row, before); else panel.appendChild(row);
            return btn;
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
            ["90° drehen", '<path d="M4 12a8 8 0 1 1 3 6"/><path d="M4 12V7m0 5h5"/>', function (cr) { cr.rotate(90); }],
            ["Anderes Bild", '<path d="M4 16l5-5 4 4 3-3 4 4"/><rect x="3" y="4" width="18" height="16" rx="2"/>', null]
        ].forEach(function (t) {
            var b = el("button", "bk-cr-cropbtn", C.svg(t[1]) + "<span>" + t[0] + "</span>");
            b.type = "button";
            b.addEventListener("click", function () {
                if (t[2]) { var cr = cropper(); if (cr) { t[2](cr); } }
                else { chooseNewImage(); }
            });
            cropBtns.appendChild(b);
        });
        // "Mittig setzen" called cropper.reset() but did not apply it, so the
        // mosaic kept the old crop: a reset that resets nothing you can see. The
        // real one undoes frame AND rotation and applies it; it stays on this
        // tab so the customer sees the frame come back.
        makeResetRow(P.crop, "Rahmen", function () {
            var cv = document.getElementById("step-1-canvas-upscaled");
            if (!cv || !cv.cropper) return;
            cv.cropper.reset();
            try { savedCrop = cv.cropper.getData(true); } catch (e) { /* keep going */ }
            runWithBusy(function () { var nb = nextButton(); if (nb) nb.click(); });
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
        var paletteNote = el("p", "bk-cr-note");
        paletteNote.hidden = true;
        var paletteBox = el("div"), paletteCount = el("p", "bk-cr-swcount", "");
        // The instruction used to live in the small grey count line under the
        // grid ("... · Klick entfernt eine Farbe"), which is where nobody reads
        // before clicking. It is now a sentence of its own ABOVE the grid.
        var paletteHow = el("p", "bk-cr-instr",
            "<b>Tippe auf eine Farbe, um sie zu entfernen.</b> " +
            "Das Mosaik wird dann ohne diese Farbe neu berechnet.");
        P.color.append(paletteNote, paletteHow, paletteBox, paletteCount);
        var presetBtn = document.getElementById("select-starting-custom-stud-map-button");
        if (presetBtn) {
            var wrap = el("div"); wrap.style.marginBottom = "14px";
            wrap.appendChild(presetBtn);
            var opts = document.getElementById("select-starting-custom-stud-map-options");
            if (opts) wrap.appendChild(opts);
            P.color.insertBefore(wrap, paletteBox);
        }
        /**
         * The baseline "Zurücksetzen" goes back to. It is whatever the palette
         * was before the customer started removing colours -- and it moves
         * whenever something OTHER than a removal replaces the palette (a style,
         * the preset list), because resetting past a chosen style would be a
         * surprise. Removals made here are flagged, so they never move it.
         */
        var paletteBaseline = null, removingHere = false;
        function snapshotPalette() {
            var sorted = [], map = {};
            paletteRows().forEach(function (row) {
                var chip = row.querySelector("button div[style*='background']");
                var h = chip && rgbToHex(chip.style.backgroundColor);
                if (!h) return;
                var qty = row.querySelector(".piece-count-input");
                sorted.push(h);
                map[h] = qty ? (parseFloat(qty.value) || 99999) : 99999;
            });
            return { sortedStuds: sorted, studMap: map };
        }
        function paletteChanged() {
            if (!paletteBaseline) return false;
            var now = snapshotPalette().sortedStuds;
            return now.length !== paletteBaseline.sortedStuds.length ||
                   now.some(function (h, i) { return h !== paletteBaseline.sortedStuds[i]; });
        }

        function paletteRows() {
            var body = document.getElementById("custom-stud-table-body");
            return body ? [].slice.call(body.children) : [];
        }
        /** "rgb(46, 125, 50)" -> "#2e7d32", so rows can be compared with the
         *  hex lists the style presets are written in. */
        function rgbToHex(rgb) {
            var m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(rgb || "");
            if (!m) return null;
            return "#" + [1, 2, 3].map(function (i) {
                return ("0" + (+m[i]).toString(16)).slice(-2);
            }).join("");
        }

        // The full set the customer started with. Everything else is a subset of
        // it, so it is the honest denominator for "x von y".
        var basePalette = null;

        function activeStyleName() {
            var t = document.querySelector(".bk-style-tile.active .bk-style-tile-label");
            var n = t ? t.textContent.trim() : "";
            return (n && n !== "Original") ? n : "";
        }

        function renderPalette() {
            var rows = paletteRows();
            paletteBox.innerHTML = "";
            var grid = el("div", "bk-cr-swatches");
            var hexes = [];
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
                    // The observer below re-renders as soon as the row is gone.
                    if (x) { removingHere = true; x.click(); maybeAutoRecalc(); }
                });
                grid.appendChild(b);
                var h = rgbToHex(chip.style.backgroundColor);
                if (h) hexes.push(h);
            });
            paletteBox.appendChild(grid);

            if (basePalette === null && rows.length) basePalette = hexes.slice();

            paletteCount.textContent = rows.length + " Steinfarben aktiv";
            if (paletteReset) paletteReset.disabled = !paletteChanged();

            // Say WHY the number changed. Without this the count looked as if it
            // moved on its own the moment a style was picked. Deliberately
            // "tauscht", not "begrenzt": a style is NOT a subset of the current
            // list -- measured, "Warm" brings 4 colours (#ffa531, #fa5947,
            // #532115, #dd982e) that the default 35 do not contain.
            var st = activeStyleName();
            paletteNote.hidden = !st;
            if (st) {
                // No count in this sentence: after a manual removal the current
                // number is no longer "the style's own" one, and the line right
                // below already states it.
                paletteNote.textContent = "Der Stil „" + st + "“ hat die Palette gegen seine eigene "
                    + "Auswahl getauscht — auch Farben, die vorher nicht in der Liste standen. "
                    + "Über „Stil → Original“ kommen deine "
                    + (basePalette ? basePalette.length : rows.length) + " zurück.";
            }
        }
        paletteBaseline = snapshotPalette();
        var paletteReset = makeResetRow(P.color, "Steinfarben", function () {
            if (!paletteBaseline || typeof window.populateCustomStudSelectors !== "function") return;
            var base = paletteBaseline;
            runWithBusy(function () { window.populateCustomStudSelectors(base, true); });
        }, paletteHow);
        renderPalette();

        /**
         * A style REPLACES the palette (see applyStyleStudMap in index.js), and
         * the preset dropdown rewrites the same table. Re-reading it only after a
         * swatch click meant the panel kept showing the old colours: after "Warm"
         * it still offered 35 chips while the real palette held 18, and the first
         * click then made the count jump from 35 to 17. Watch the table instead.
         */
        var studBody = document.getElementById("custom-stud-table-body");
        if (studBody && window.MutationObserver) {
            new MutationObserver(function () {
                // A replacement from elsewhere (style, preset list) is the new
                // starting point; one of our own removals is not.
                if (!removingHere) paletteBaseline = snapshotPalette();
                removingHere = false;
                renderPalette();
            }).observe(studBody, { childList: true });
        }

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

        P.style.appendChild(el("p", "bk-cr-hint",
            "Eine Vorlage tauscht die Steinfarben aus, mit denen gebaut wird — nicht das Foto. "
            + "Welche gerade aktiv sind, steht unter „Steine“."));

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
            annotateStyleTiles();
            fitTileShape();
        }

        /**
         * Put the palette size on every tile. A style here is not a filter over
         * the photo, it IS the set of bricks the mosaic may use -- so the number
         * of colours is the single most useful thing a tile can say, and saying
         * it up front is what stops the count in "Steine" from looking like it
         * moved on its own.
         */
        /**
         * Let the tile take the shape of the mosaic. The preview is drawn as a
         * square with the motif letterboxed inside it; giving the tile the
         * mosaic's own ratio lets object-fit: cover crop exactly those empty
         * bars away, so a 240x48 panorama fills its tile instead of floating in
         * white. Clamped, because a raw 5:1 tile would be a hairline.
         */
        var lastShape = "";
        function fitTileShape() {
            if (!stylePicker) return;
            var w = +document.getElementById("width-slider").value,
                h = +document.getElementById("height-slider").value;
            if (!w || !h) return;
            var ar = Math.max(0.75, Math.min(1.78, w / h)).toFixed(3);
            if (ar === lastShape) return;
            lastShape = ar;
            stylePicker.style.setProperty("--bk-tile-ar", ar);
        }

        var tilesAnnotated = false;
        function annotateStyleTiles() {
            if (tilesAnnotated) return;
            var tiles = document.querySelectorAll(".bk-style-tile");
            if (!tiles.length || !basePalette) return;
            var lists = window.BK_STYLE_PALETTES || {};
            // The same filter buildStudMapFromHexList applies: a preset colour
            // counts if it is a real brick colour at all -- NOT if it happens to
            // be in the list that is active right now. Filtering against the
            // current 35 gave 14 for "Warm" where 18 are actually applied.
            var stock = null;
            if (typeof window.ALL_BRICKLINK_SOLID_COLORS !== "undefined") {
                stock = {};
                window.ALL_BRICKLINK_SOLID_COLORS.forEach(function (c) {
                    stock[String(c.hex).toLowerCase()] = true;
                });
            }
            [].forEach.call(tiles, function (tile) {
                if (tile.querySelector(".bk-cr-tilecount")) return;
                var id = tile.dataset.style, n;
                if (id === "original") {
                    n = basePalette.length;
                } else {
                    var list = lists[id];
                    if (!list) return;
                    n = stock
                        ? list.filter(function (h) { return stock[String(h).toLowerCase()]; }).length
                        : list.length;
                }
                tile.appendChild(el("span", "bk-cr-tilecount", n + " Farben"));
            });
            tilesAnnotated = true;
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
        var clearPaint = document.getElementById("clear-overrides-button");
        if (clearPaint) {
            makeResetRow(P.paint, "Werkzeug", function () {
                runWithBusy(function () { clearPaint.click(); });
            }, null);
        }
        if (tools.children.length) P.paint.appendChild(tools);
        move(document.getElementById("paintbrush-controls"), P.paint);
        P.paint.appendChild(el("p", "bk-cr-hint",
            "Wähle eine Farbe und klicke im Mosaik auf eine Noppe. Das Ergebnis bleibt beim Neuberechnen erhalten."));

        /* ------------------------------------------------------- header */
        function updateHead() {
            var ch = C.chips();
            var w = +document.getElementById("width-slider").value,
                h = +document.getElementById("height-slider").value;
            // Same formatting as the size cards: no pointless trailing ",0".
            ch.size.querySelector("b").innerHTML = cm(w) + " &times; " + cm(h) + " cm";
            ch.studs.querySelector("b").textContent = w + " × " + h;
            var v = (window.MOSAIC_VARIATIONS || {})[currentKey()];
            ch.price.querySelector("b").innerHTML = v ? v.price + " &euro;" : "—";
            parkOrderCard();

            // A 16er admin size has no variation to buy. Block the button, but
            // only ever undo a block WE set -- index.js disables the same button
            // while an order is in flight, and stamping over that would let a
            // customer fire a second add-to-cart.
            var ob = document.getElementById("order-mosaic-button");
            if (ob) {
                if (v && !v.vid) {
                    ob.disabled = true;
                    ob.dataset.bkTestBlock = "1";
                    ob.title = "Admin-Testgröße (16er-Platten) — nicht bestellbar";
                } else if (ob.dataset.bkTestBlock) {
                    delete ob.dataset.bkTestBlock;
                    ob.disabled = false;
                    ob.title = "";
                }
            }
        }
        ["width-slider", "height-slider", "width-step-select", "height-step-select"].forEach(function (id) {
            var n = document.getElementById(id);
            if (!n) return;
            n.addEventListener("input", updateHead);
            // markSelected, NOT renderSizes: the list's CONTENT depends only on
            // the shape filter and the variation table, never on the current
            // selection -- and pickSize dispatches this very "change", so the
            // full rebuild it was meant to avoid happened anyway (measured:
            // three rebuilds per card click).
            n.addEventListener("change", function () { updateHead(); markSelected(); });
        });

        // The old resolution card duplicates the new size cards — park it.
        [].forEach.call(document.querySelectorAll(".mosaic-controls-panel"), function (n) { attic.appendChild(n); });

        renderSizes(); buildAdminPlate16(); updateHead(); C.select("size");

        applyPendingSize = function () {
            if (!pendingSize) return;
            var m = /^(\d+)x(\d+)$/.exec(pendingSize.size);
            if (!m) { pendingSize = null; return; }
            var w = +m[1], h = +m[2], plate = parseInt(pendingSize.plate, 10);
            var v = variations().filter(function (x) {
                return x.w === w && x.h === h && (!plate || x.plate === plate);
            })[0];
            pendingSize = null;
            if (!v) return;
            // show the tab the card lives in, so the selection is visible
            activeShape = w === h ? "square" : (w > h ? "land" : "port");
            [].forEach.call(shapeRow.children, function (c, i) {
                c.setAttribute("aria-pressed", SHAPES[i].id === activeShape ? "true" : "false");
            });
            renderSizes();
            if (currentKey() !== v.key) pickSize(v);
        };
        applyPendingSize();

        // On a phone the editor opens with the Größe sheet up. Closed, the six
        // icons at the bottom do not read as "tap me" -- the customer arrives
        // from picking a photo and sees only a picture and a row of symbols.
        if (C.isPhone()) C.sheet(true);

        // The app builds the order card only after the first mosaic is computed,
        // so polling once is not enough -- watch until it appears, then stop.
        if (!parkOrderCard() && window.MutationObserver) {
            var mo = new MutationObserver(function () { if (parkOrderCard()) mo.disconnect(); });
            mo.observe(document.body, { childList: true, subtree: true });
            // If the card never appears, do not keep a whole-document observer
            // alive for the life of the tab.
            setTimeout(function () { mo.disconnect(); }, 120000);
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
    /**
     * Wait for the customer's picture. This used to poll every 200 ms FOREVER:
     * on a page where nobody uploads anything that is five wake-ups a second for
     * the life of the tab. The canvas getting its real size is an attribute
     * change, so it can simply be observed; the poll stays as a fallback for the
     * paths an observer cannot see and backs off to once a second.
     */
    function waitForImage(delay) {
        if (hasImage()) { boot(); return; }
        setTimeout(function () { waitForImage(Math.min((delay || 200) * 1.4, 1000)); }, delay || 200);
    }
    function watchForImage() {
        var c = document.getElementById("step-1-canvas-upscaled");
        if (!c || !window.MutationObserver) return;
        var mo = new MutationObserver(function () {
            if (hasImage()) { mo.disconnect(); boot(); }
        });
        mo.observe(c, { attributes: true, attributeFilter: ["width", "height"] });
    }
    var booted = false;
    var _boot = boot;
    boot = function () { if (booted) return; booted = true; _boot(); };

    function start() { watchForImage(); waitForImage(200); }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
})();
