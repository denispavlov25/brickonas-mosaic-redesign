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

    var root, attic, panels = {}, view, stagebar, chips = {};

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
        var body = el("div", "bk-cr-panels");
        side.appendChild(body);

        TABS.forEach(function (t, i) {
            var b = el("button", "bk-cr-tab", svg(t.icon) + "<span>" + t.label + "</span>");
            b.type = "button";
            b.setAttribute("role", "tab");
            b.setAttribute("aria-selected", i === 0 ? "true" : "false");
            b.style.setProperty("--tab-accent", t.accent);
            b.style.setProperty("--tab-soft", t.soft);
            b.addEventListener("click", function () { select(t.id); });
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

        main.append(rail, side, stage);
        root.append(head, main);
        document.body.appendChild(root);
        document.body.classList.add("bk-creator");
    }

    function select(id) {
        var tabs = root.querySelectorAll(".bk-cr-tab");
        TABS.forEach(function (t, i) {
            tabs[i].setAttribute("aria-selected", t.id === id ? "true" : "false");
            panels[t.id].hidden = t.id !== id;
        });
        if (typeof window.bkCrShowStage === "function") window.bkCrShowStage(id);
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
        chips:  function () { return chips; }
    };
})();
