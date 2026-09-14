/**
 * BRICKONAS Creator — single-screen editor shell (opt-in via ?ui=new).
 *
 * WHY: the classic three-step wizard hides the mosaic behind "Weiter" buttons,
 * scatters related controls across steps, and never shows the price until the
 * end. This shell keeps the mosaic on screen throughout and puts size and price
 * in the header.
 *
 * The LAYOUT is deliberately ours: a vertical tool rail on the far left, an
 * asymmetric header (identity left, facts and action right) and canvas controls
 * docked in a bar above the stage — not the horizontal tab strip and floating
 * zoom pill of the tool that inspired the idea.
 *
 * HOW: it does not reimplement any control. It MOVES the existing DOM nodes
 * into its panels, which keeps every listener in index.js alive and leaves
 * getElementById() working. Anything not shown is parked off-screen, never
 * removed, for the same reason.
 */
(function () {
    "use strict";
    if (!/[?&]ui=new\b/.test(window.location.search)) return;

    var ICON = {
        size:  '<path d="M3 8h18M3 16h18M8 3v18M16 3v18"/>',
        crop:  '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
        color: '<circle cx="12" cy="12" r="9"/><circle cx="9" cy="9.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="9.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="9.5" cy="15" r="1.2" fill="currentColor" stroke="none"/>',
        adjust:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
        style: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>',
        ai:    '<path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
        paint: '<path d="M15.5 3.5l5 5-9 9-5-5z"/><path d="M6.5 12.5L3 21l8.5-3.5"/>',
        depth: '<path d="M12 2l9 5-9 5-9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 17l9 5 9-5"/>',
        square:'<rect x="5" y="5" width="14" height="14" rx="2"/>',
        land:  '<rect x="3" y="7" width="18" height="10" rx="2"/>',
        port:  '<rect x="7" y="3" width="10" height="18" rx="2"/>',
        pen:   '<path d="M15.5 3.5l5 5L8 21H3v-5z"/>',
        fill:  '<path d="M8 3l9 9-7 7-9-9z"/><path d="M20 15c0 1.7-1.3 3-3 3"/>',
        swap:  '<path d="M4 7h13l-3-3M20 17H7l3 3"/>',
        pick:  '<path d="M18 3l3 3-9 9-3-3z"/><path d="M9 12l-6 6v3h3l6-6"/>'
    };
    function svg(d) {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + "</svg>";
    }
    function el(tag, cls, html) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (html != null) n.innerHTML = html;
        return n;
    }

    /* One accent for the whole editor: the shop's green. Giving every tab its
       own hue (a red, a violet, an amber) was invented here and belonged to no
       part of the shop -- it is why the AI panel read as a different product.
       A tab is identified by its icon and its label; colour is reserved for
       "this is active" and "this is the primary action". */
    var ACCENT = "#2E7D32", ACCENT_SOFT = "#EAF4EA";
    /* Each tab answers a different question, in the order the work happens:
       what am I building (Größe) - which part of the photo (Zuschnitt) - how
       should it look (Stil) - let the machine do it (KI) - which bricks may be
       used (Steine) - fix it by hand (Malen).

       "Anpassen" is gone as a tab of its own: five sliders are not a task, they
       are the fine control for a look, so they moved under Stil behind the
       presets. "Farben" became "Steine" because next to Stil and Farbton it no
       longer said which colours it meant. */
    var TABS = [
        { id: "size",   label: "Größe",     icon: ICON.size,   accent: ACCENT, soft: ACCENT_SOFT },
        { id: "crop",   label: "Zuschnitt", icon: ICON.crop,   accent: ACCENT, soft: ACCENT_SOFT },
        { id: "style",  label: "Stil",      icon: ICON.style,  accent: ACCENT, soft: ACCENT_SOFT },
        { id: "ai",     label: "KI",        icon: ICON.ai,     accent: ACCENT, soft: ACCENT_SOFT },
        { id: "color",  label: "Steine",    icon: ICON.color,  accent: ACCENT, soft: ACCENT_SOFT },
        { id: "paint",  label: "Malen",     icon: ICON.paint,  accent: ACCENT, soft: ACCENT_SOFT }
    ];

    var root, attic, panels = {}, view, stagebar, foot, grip, sheetBtn, fullBtn, chips = {};
    var PANEL_MIN = 320, PANEL_MAX = 680, PANEL_KEY = "bkCrPanelW";

    function buildShell() {
        attic = el("div", "bk-cr-attic");
        document.body.appendChild(attic);
        root = el("div", "bk-cr-root");

        /* header: identity left, facts + action right */
        var head = el("div", "bk-cr-head");
        // One action per side, like every editor toolbar worth copying: leaving
        // on the left, finishing on the right. Embedded in the shop the left
        // button closes the overlay -- the shop's own bar is gone, this is the
        // only header now.
        var embedded = document.documentElement.classList.contains("bk-embedded");
        var back = el("button", "bk-cr-back", "&larr;");
        back.type = "button";
        back.title = embedded ? "Konfigurator schließen" : "Zurück zur klassischen Ansicht";
        back.setAttribute("aria-label", back.title);
        back.addEventListener("click", function () {
            if (embedded) { closeOverlay(); return; }
            var u = new URL(window.location.href);
            u.searchParams.delete("ui");
            window.location.href = u.toString();
        });
        // "Mosaik" is dropped on a phone so identity, price and the action all fit
        // one row -- "BrickPic" is the product name and carries it on its own.
        var mark = el("div", "bk-cr-wordmark", "<b>Mosaik&nbsp;</b>BrickPic");
        var meta = el("div", "bk-cr-meta");
        chips.size  = el("div", "bk-cr-chip", "<u>Format</u><b>—</b>");
        chips.studs = el("div", "bk-cr-chip", "<u>Noppen</u><b>—</b>");
        chips.price = el("div", "bk-cr-chip bk-cr-chip--price", "<u>Preis</u><b>—</b>");
        meta.append(chips.size, chips.studs, chips.price);
        var finish = el("button", "bk-cr-finish", "Fertig &rarr;");
        finish.type = "button";
        finish.addEventListener("click", function () {
            if (typeof window.bkCrFinish === "function") window.bkCrFinish();
        });
        head.append(back, mark, meta, finish);

        /* body: rail | panel | stage */
        var main = el("div", "bk-cr-main");
        var rail = el("div", "bk-cr-rail");
        rail.setAttribute("role", "tablist");
        var side = el("div", "bk-cr-side");
        // Phones only: the sheet opens to nearly full height, because 42vh is
        // not enough room to pick a size or type into the AI chat.
        sheetBtn = el("button", "bk-cr-grab", '<i></i><b class="bk-cr-grabtitle"></b><span>Schließen</span>');
        sheetBtn.type = "button";
        sheetBtn.setAttribute("aria-expanded", "false");
        sheetBtn.addEventListener("click", function () { closeSheets(); });
        // Sits INSIDE the grab bar but is its own button, so the bar can keep
        // being the close action while this one only changes the height.
        fullBtn = el("button", "bk-cr-grow2", "&#9650;");
        fullBtn.type = "button";
        fullBtn.title = "Auf volle Höhe";
        fullBtn.setAttribute("aria-label", fullBtn.title);
        fullBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            toggleFull();
        });
        sheetBtn.appendChild(fullBtn);
        var body = el("div", "bk-cr-panels");
        // The order card lives in a footer that does NOT scroll: price and
        // "Bestellen" stay in view while the size list above is scrolled.
        foot = el("div", "bk-cr-foot");
        side.append(sheetBtn, body, foot);

        TABS.forEach(function (t, i) {
            var b = el("button", "bk-cr-tab", svg(t.icon) + "<span>" + t.label + "</span>");
            b.type = "button";
            b.id = "bk-cr-tab-" + t.id;
            b.setAttribute("role", "tab");
            b.setAttribute("aria-controls", "bk-cr-panel-" + t.id);
            b.setAttribute("aria-selected", i === 0 ? "true" : "false");
            // Only the active tab is in the tab order; the arrow keys move
            // between them. That is the contract role="tablist" promises, and
            // without it a screen reader announces a tablist that cannot be used.
            b.tabIndex = i === 0 ? 0 : -1;
            b.addEventListener("keydown", function (e) {
                var d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1
                      : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
                if (!d) return;
                e.preventDefault();
                var next = TABS[(i + d + TABS.length) % TABS.length];
                select(next.id, true);
                var nb = document.getElementById("bk-cr-tab-" + next.id);
                if (nb) nb.focus();
            });
            b.style.setProperty("--tab-accent", t.accent);
            b.style.setProperty("--tab-soft", t.soft);
            b.addEventListener("click", function () { select(t.id, true); });
            rail.appendChild(b);

            var p = el("section", "bk-cr-panel");
            p.dataset.tab = t.id;
            p.id = "bk-cr-panel-" + t.id;
            p.setAttribute("role", "tabpanel");
            p.setAttribute("aria-labelledby", "bk-cr-tab-" + t.id);
            p.hidden = i !== 0;
            p.style.setProperty("--tab-accent", t.accent);
            body.appendChild(p);
            panels[t.id] = p;
        });

        var stage = el("div", "bk-cr-stage");
        stagebar = el("div", "bk-cr-stagebar");
        view = el("div", "bk-cr-view");
        stage.append(stagebar, view);

        grip = el("div", "bk-cr-grip");
        grip.setAttribute("role", "separator");
        grip.setAttribute("aria-orientation", "vertical");
        grip.setAttribute("aria-label", "Breite der Bedienspalte");
        grip.tabIndex = 0;
        wireGrip();

        main.append(rail, side, grip, stage);
        root.append(head, main);
        document.body.appendChild(root);
        document.body.classList.add("bk-creator");
        if (window.__bkCrCover) window.__bkCrCover(false);
        restorePanelWidth();

        if (document.documentElement.classList.contains("bk-embedded")) {
            try { window.parent.postMessage({ bk: "mosaic-ready" }, "*"); } catch (e) { /* no parent */ }
            document.addEventListener("keydown", function (e) {
                if (e.key !== "Escape") return;
                // A sheet swallows the first Escape; the overlay closes on the next.
                if (document.body.classList.contains("bk-cr-sheet") ||
                    document.body.classList.contains("bk-cr-order")) { closeSheets(); return; }
                closeOverlay();
            });
        }
    }

    /* ------------------------------------------------ resizable side column
       A single fixed width is always wrong for somebody: roomy on a 27" screen,
       tight on a 13" laptop, and how much room the picture needs depends on what
       the customer is doing. So the divider is draggable and the choice sticks. */
    function setPanelWidth(px, remember) {
        if (!isFinite(px)) return null;
        var w = Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.round(px)));
        document.body.style.setProperty("--c-panelw", w + "px");
        if (remember) { try { localStorage.setItem(PANEL_KEY, String(w)); } catch (e) { /* private mode */ } }
        return w;
    }
    function currentPanelWidth() {
        var side = root && root.querySelector(".bk-cr-side");
        return side ? side.getBoundingClientRect().width : 360;
    }
    function restorePanelWidth() {
        var v = null;
        try { v = localStorage.getItem(PANEL_KEY); } catch (e) { /* private mode */ }
        // A garbled stored value would reach the stylesheet as "NaNpx", which
        // invalidates --c-panelw and takes the whole grid-template-columns
        // declaration down with it -- the layout collapses. Only finite numbers.
        var n = parseFloat(v);
        if (!isFinite(n)) return;
        // Never restore a width that would leave no picture on a smaller screen.
        if (window.innerWidth > 940) setPanelWidth(Math.min(n, window.innerWidth * 0.55), false);
    }
    function wireGrip() {
        var startX = 0, startW = 0, dragging = false;
        grip.addEventListener("pointerdown", function (e) {
            dragging = true; startX = e.clientX; startW = currentPanelWidth();
            grip.setPointerCapture(e.pointerId);
            document.body.classList.add("bk-cr-dragging");
            e.preventDefault();
        });
        grip.addEventListener("pointermove", function (e) {
            if (dragging) setPanelWidth(startW + (e.clientX - startX), false);
        });
        function stop(e) {
            if (!dragging) return;
            dragging = false;
            document.body.classList.remove("bk-cr-dragging");
            setPanelWidth(currentPanelWidth(), true);
            if (e && e.pointerId != null && grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
        }
        grip.addEventListener("pointerup", stop);
        grip.addEventListener("pointercancel", stop);
        // A divider only a mouse can move is not usable for everyone.
        grip.addEventListener("keydown", function (e) {
            var d = e.key === "ArrowLeft" ? -24 : e.key === "ArrowRight" ? 24 : 0;
            if (!d) return;
            e.preventDefault();
            setPanelWidth(currentPanelWidth() + d, true);
        });
        grip.addEventListener("dblclick", function () {
            document.body.style.removeProperty("--c-panelw");
            try { localStorage.removeItem(PANEL_KEY); } catch (err) { /* private mode */ }
        });
    }

    /* ------------------------------------------------------- mobile sheet
       On a phone the picture is the default state and gets the whole screen; a
       tool opens a sheet only as tall as its content needs, and the sheet is
       dismissed explicitly. A panel that is permanently open costs half the
       screen even while the customer is only looking at their mosaic. */
    function toggleSheet(force) {
        var open = typeof force === "boolean" ? force : !document.body.classList.contains("bk-cr-sheet");
        document.body.classList.toggle("bk-cr-sheet", open);
        if (open) document.body.classList.remove("bk-cr-order");
        if (sheetBtn) sheetBtn.setAttribute("aria-expanded", open ? "true" : "false");
    }

    /** "Fertig" on a phone: the order card gets the sheet to itself. */
    function orderSheet(open) {
        var on = open !== false;
        if (sheetBtn && on) sheetBtn.querySelector(".bk-cr-grabtitle").textContent = "Bestellen";
        document.body.classList.toggle("bk-cr-order", on);
        if (on) document.body.classList.remove("bk-cr-sheet");
        if (sheetBtn) sheetBtn.setAttribute("aria-expanded", on ? "true" : "false");
    }

    /** The sheet has two heights: as tall as its content, or the whole screen. */
    function toggleFull(force) {
        var on = typeof force === "boolean" ? force : !document.body.classList.contains("bk-cr-full");
        document.body.classList.toggle("bk-cr-full", on);
        if (fullBtn) {
            fullBtn.innerHTML = on ? "&#9660;" : "&#9650;";
            fullBtn.title = on ? "Bild wieder zeigen" : "Auf volle Höhe";
            fullBtn.setAttribute("aria-label", fullBtn.title);
        }
    }

    function closeSheets() {
        document.body.classList.remove("bk-cr-sheet", "bk-cr-order");
        toggleFull(false);
        if (sheetBtn) sheetBtn.setAttribute("aria-expanded", "false");
    }

    /* ------------------------------------------------ no flash of the old UI
       Picking a picture makes the app show its classic step-1 screen at once
       (sliders, controls) and the editor mounts only when the first result is
       in -- so for about a second the customer saw the old configurator.
       From the moment the upload card is hidden until the editor exists, an
       opaque cover sits on top. It is an overlay on purpose, NOT display:none on
       the classic layer: Cropper.js measures that layout while it initialises. */
    (function bootCover() {
        if (!/[?&]ui=new\b/.test(window.location.search)) return;
        var docEl = document.documentElement, safety = null;
        function cover(on) {
            docEl.classList.toggle("bk-cr-booting", on);
            clearTimeout(safety);
            // Never trap anyone behind it if the editor fails to mount.
            if (on) safety = setTimeout(function () { docEl.classList.remove("bk-cr-booting"); }, 20000);
        }
        window.__bkCrCover = cover;
        function watch() {
            var card = document.getElementById("image-input-card");
            if (!card || !window.MutationObserver) return;
            new MutationObserver(function () {
                if (card.hidden && !document.body.classList.contains("bk-creator")) cover(true);
            }).observe(card, { attributes: true, attributeFilter: ["hidden"] });
        }
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
        else watch();
    })();

    /* ------------------------------------------------ way out, from second one
       The editor shell is only built once a picture exists, so on the upload
       screen there was no close button at all -- only the shop page's fallback,
       which appears after four seconds in the far corner of the window and is
       easy to miss entirely. This one is there immediately and sits ON the card,
       where the eye already is. It disappears by itself once the editor mounts,
       because the whole classic layer is hidden then. */
    (function cardClose() {
        if (!document.documentElement.classList.contains("bk-embedded")) return;
        function attach() {
            var card = document.getElementById("image-input-card");
            if (!card) return false;
            if (!card.querySelector(".bk-cr-cardclose")) {
                var b = document.createElement("button");
                b.type = "button";
                b.className = "bk-cr-cardclose";
                b.innerHTML = "&times;";
                b.title = "Konfigurator schließen";
                b.setAttribute("aria-label", b.title);
                b.addEventListener("click", closeOverlay);
                card.appendChild(b);
            }
            // Only now: the fallback in the shop page is the safety net for a
            // frame that never got this far, so it must not be waved off early.
            try { window.parent.postMessage({ bk: "mosaic-ready" }, "*"); } catch (e) { /* no parent */ }
            return true;
        }
        if (!attach()) document.addEventListener("DOMContentLoaded", attach);
    })();

    /** Ask the shop page to close the overlay; harmless when standalone. */
    function closeOverlay() {
        try { window.parent.postMessage({ bk: "mosaic-close" }, "*"); } catch (e) { /* no parent */ }
    }

    function select(id, fromUser) {
        var tabs = root.querySelectorAll(".bk-cr-tab");
        TABS.forEach(function (t, i) {
            var on = t.id === id;
            tabs[i].setAttribute("aria-selected", on ? "true" : "false");
            tabs[i].tabIndex = on ? 0 : -1;
            panels[t.id].hidden = !on;
        });
        document.body.classList.toggle("bk-cr-paint", id === "paint");
        if (typeof window.bkCrShowStage === "function") window.bkCrShowStage(id);
        // The sheet header carries the title on a phone, so the panel's own
        // heading can step aside instead of repeating the tab underneath it.
        var meta = TABS.find(function (t) { return t.id === id; });
        if (sheetBtn && meta) sheetBtn.querySelector(".bk-cr-grabtitle").textContent = meta.label;
        // On a phone a TAP on a tool is a request to see that tool -- but the
        // select() that runs while the shell is built is not, and opening the
        // sheet there left the picture 53 px tall before anyone had asked.
        if (fromUser && window.matchMedia("(max-width: 940px)").matches) toggleSheet(true);
    }

    /** Panel heading: coloured stud, title, optional sub-line. */
    function heading(panel, title, sub) {
        panel.appendChild(el("h2", "bk-cr-ptitle", title));
        if (sub) panel.appendChild(el("p", "bk-cr-psub", sub));
    }

    window.BkCreator = {
        buildShell: buildShell, select: select, heading: heading,
        el: el, svg: svg, ICON: ICON,
        q: function (s) { return document.querySelector(s); },
        move: function (node, target) { if (node && target) target.appendChild(node); return node; },
        panels: function () { return panels; },
        attic:  function () { return attic; },
        view:   function () { return view; },
        stagebar: function () { return stagebar; },
        foot:   function () { return foot; },
        sheet:  toggleSheet,
        full:   toggleFull,
        order:  orderSheet,
        isPhone: function () { return window.matchMedia("(max-width: 940px)").matches; },
        chips:  function () { return chips; }
    };
})();
