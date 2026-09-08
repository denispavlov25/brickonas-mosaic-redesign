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

    var TABS = [
        { id: "size",   label: "Größe",     icon: ICON.size,   accent: "#2E7D32", soft: "#EAF4EA" },
        { id: "crop",   label: "Zuschnitt", icon: ICON.crop,   accent: "#2E7D32", soft: "#EAF4EA" },
        { id: "color",  label: "Farben",    icon: ICON.color,  accent: "#B03A2E", soft: "#FBEDEB" },
        { id: "adjust", label: "Anpassen",  icon: ICON.adjust, accent: "#B03A2E", soft: "#FBEDEB" },
        { id: "ai",     label: "KI",        icon: ICON.ai,     accent: "#5B4B8A", soft: "#F0ECF7" },
        { id: "paint",  label: "Malen",     icon: ICON.paint,  accent: "#B07A05", soft: "#FDF6E6" }
    ];

    var root, attic, panels = {}, view, stagebar, foot, grip, sheetBtn, chips = {};
    var PANEL_MIN = 320, PANEL_MAX = 680, PANEL_KEY = "bkCrPanelW";

    function buildShell() {
        attic = el("div", "bk-cr-attic");
        document.body.appendChild(attic);
        root = el("div", "bk-cr-root");

        /* header: identity left, facts + action right */
        var head = el("div", "bk-cr-head");
        var back = el("button", "bk-cr-back", "&larr;");
        back.type = "button";
        back.title = "Zurück zur klassischen Ansicht";
        back.addEventListener("click", function () {
            var u = new URL(window.location.href);
            u.searchParams.delete("ui");
            window.location.href = u.toString();
        });
        var mark = el("div", "bk-cr-wordmark", "Mosaik-Editor<small>BRICKONAS BrickPic</small>");
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
        var body = el("div", "bk-cr-panels");
        // The order card lives in a footer that does NOT scroll: price and
        // "Bestellen" stay in view while the size list above is scrolled.
        foot = el("div", "bk-cr-foot");
        side.append(sheetBtn, body, foot);

        TABS.forEach(function (t, i) {
            var b = el("button", "bk-cr-tab", svg(t.icon) + "<span>" + t.label + "</span>");
            b.type = "button";
            b.setAttribute("role", "tab");
            b.setAttribute("aria-selected", i === 0 ? "true" : "false");
            b.style.setProperty("--tab-accent", t.accent);
            b.style.setProperty("--tab-soft", t.soft);
            b.addEventListener("click", function () { select(t.id, true); });
            rail.appendChild(b);

            var p = el("section", "bk-cr-panel");
            p.dataset.tab = t.id;
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
        restorePanelWidth();
    }

    /* ------------------------------------------------ resizable side column
       A single fixed width is always wrong for somebody: roomy on a 27" screen,
       tight on a 13" laptop, and how much room the picture needs depends on what
       the customer is doing. So the divider is draggable and the choice sticks. */
    function setPanelWidth(px, remember) {
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
        // Never restore a width that would leave no picture on a smaller screen.
        if (v && window.innerWidth > 940) setPanelWidth(Math.min(+v, window.innerWidth * 0.55), false);
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
        if (sheetBtn) sheetBtn.querySelector(".bk-cr-grabtitle").textContent = "Bestellen";
        document.body.classList.toggle("bk-cr-order", open !== false);
        if (open !== false) document.body.classList.remove("bk-cr-sheet");
    }

    function closeSheets() {
        document.body.classList.remove("bk-cr-sheet", "bk-cr-order");
        if (sheetBtn) sheetBtn.setAttribute("aria-expanded", "false");
    }

    function select(id, fromUser) {
        var tabs = root.querySelectorAll(".bk-cr-tab");
        TABS.forEach(function (t, i) {
            tabs[i].setAttribute("aria-selected", t.id === id ? "true" : "false");
            panels[t.id].hidden = t.id !== id;
        });
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
        order:  orderSheet,
        isPhone: function () { return window.matchMedia("(max-width: 940px)").matches; },
        chips:  function () { return chips; }
    };
})();
