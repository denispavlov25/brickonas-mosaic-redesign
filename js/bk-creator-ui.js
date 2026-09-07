/**
 * BRICKONAS Creator — single-screen editor shell (opt-in via ?ui=new).
 *
 * WHY: the classic three-step wizard hides the mosaic behind "Weiter" buttons,
 * scatters related controls across steps, and never shows the customer what the
 * thing will cost until the end. This shell keeps the mosaic on screen the whole
 * time, puts the live size and price in the header, and groups the controls into
 * tabs — the shape of editor customers already know from comparable tools.
 *
 * HOW (important): it does NOT reimplement any control. It MOVES the existing
 * DOM nodes into the new panels. Moving a node keeps its event listeners, so
 * every handler in index.js keeps working and getElementById() still finds
 * everything. Anything not shown is parked in an off-screen "attic" rather than
 * removed, for the same reason.
 *
 * The classic UI is untouched and stays the default.
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
        custom:'<path d="M4 20V8m0 12h12"/><path d="M9 15l6-6"/><path d="M20 4l-4 1 3 3z"/>'
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

    // Tabs. `accent`/`soft` tint the whole panel so each area reads distinctly,
    // the way the reference tool does — but in BRICKONAS colours.
    var TABS = [
        { id: "size",   label: "Größe",     icon: ICON.size,   accent: "#2E7D32", soft: "#E8F2E8" },
        { id: "crop",   label: "Zuschnitt", icon: ICON.crop,   accent: "#2E7D32", soft: "#E8F2E8" },
        { id: "color",  label: "Farben",    icon: ICON.color,  accent: "#C62828", soft: "#FBEAEA" },
        { id: "adjust", label: "Anpassen",  icon: ICON.adjust, accent: "#C62828", soft: "#FBEAEA" },
        { id: "ai",     label: "KI",        icon: ICON.ai,     accent: "#6A4C93", soft: "#F0EBF7" },
        { id: "paint",  label: "Malen",     icon: ICON.paint,  accent: "#E08A00", soft: "#FDF3E0" },
        { id: "depth",  label: "Tiefe",     icon: ICON.depth,  accent: "#2E7D32", soft: "#E8F2E8" }
    ];

    var root, attic, panels = {}, stage, headSize, headPrice, headStuds;

    /** Move a node (and its listeners) into `target`. Silent if it is missing. */
    function move(node, target) {
        if (!node || !target) return null;
        target.appendChild(node);
        return node;
    }
    function q(sel) { return document.querySelector(sel); }

    /* --------------------------------------------------------------- shell */
    function buildShell() {
        attic = el("div", "bk-cr-attic");
        document.body.appendChild(attic);

        root = el("div", "bk-cr-root");

        var head = el("div", "bk-cr-head");
        var back = el("button", "bk-cr-back", "&larr; Zurück");
        back.type = "button";
        back.addEventListener("click", function () {
            var u = new URL(window.location.href);
            u.searchParams.delete("ui");
            window.location.href = u.toString();
        });
        var meta = el("div", "bk-cr-meta");
        headSize  = el("span", "bk-cr-size", "—");
        headPrice = el("span", "bk-cr-price", "");
        headStuds = el("span", "bk-cr-studs", "");
        meta.append(headSize, headPrice, headStuds);
        var finish = el("button", "bk-cr-finish", "Fertig &rarr;");
        finish.type = "button";
        finish.addEventListener("click", function () {
            var card = document.getElementById("mosaic-product-card");
            if (card) { card.scrollIntoView({ behavior: "smooth", block: "center" }); }
        });
        head.append(back, meta, finish);

        var main = el("div", "bk-cr-main");
        var side = el("div", "bk-cr-side");
        var rail = el("div", "bk-cr-tabs");
        rail.setAttribute("role", "tablist");
        var body = el("div", "bk-cr-panels");

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

        side.append(rail, body);
        stage = el("div", "bk-cr-stage");
        main.append(side, stage);
        root.append(head, main);
        document.body.appendChild(root);
        document.body.classList.add("bk-creator");
    }

    function select(id) {
        TABS.forEach(function (t, i) {
            var tab = root.querySelectorAll(".bk-cr-tab")[i];
            tab.setAttribute("aria-selected", t.id === id ? "true" : "false");
            panels[t.id].hidden = t.id !== id;
        });
        root.style.setProperty("--tab-accent", (TABS.find(function (t) { return t.id === id; }) || {}).accent);
        if (typeof window.bkCrShowStage === "function") window.bkCrShowStage(id);
    }

    /** Panel heading: title, help affordance, optional undo. */
    function heading(panel, title, help) {
        var h = el("h2", "bk-cr-ptitle");
        h.append(document.createTextNode(title));
        var i = el("span", "bk-cr-help", "?");
        i.title = help || "";
        h.appendChild(i);
        panel.appendChild(h);
        return h;
    }

    window.BkCreator = { buildShell: buildShell, select: select, heading: heading,
                         move: move, el: el, q: q, svg: svg, ICON: ICON,
                         panels: function () { return panels; },
                         attic: function () { return attic; },
                         stage: function () { return stage; },
                         head: function () { return { size: headSize, price: headPrice, studs: headStuds }; } };
})();
