/* Laden-Modus — the configurator on the shop tablet in Coffee & Bricks.
 *
 * Only active when the page was opened by laden.html (?laden=1&k=<key>). Online customers never get
 * here and see nothing of it. What changes in shop mode:
 *   - the photo sent from the guest's phone is loaded automatically (?foto=…);
 *   - the order card shows the gram list and says "An der Kasse bezahlen" instead of the cart;
 *   - ordering asks for an e-mail address, builds and uploads the instruction PDF as usual, and places an
 *     order "Zahlung im Laden" (bk-laden.php); a big screen then shows the order number, the amount and
 *     the gram list; after payment at the counter the guest gets PDF + gram list by e-mail;
 *   - after 5 minutes without a touch, the tablet goes back to the start screen (privacy).
 */
(function () {
    "use strict";
    var params = new URLSearchParams(location.search);
    if (params.get("laden") !== "1") return;

    var KEY = params.get("k") || "";
    var CODE = params.get("c") || "";
    var FOTO = params.get("foto") || "";
    var TEST = params.get("test") === "1";
    var START = "laden.html?k=" + encodeURIComponent(KEY) + (TEST ? "&test=1" : "");
    var IDLE_MS = 5 * 60 * 1000;
    var busy = false;

    document.documentElement.classList.add("bk-laden");

    // Same-origin upload endpoints, so the PDF lands on the server this page runs on (also on the clone).
    try {
        _bkUploaderConfig = { enabled: true, initUrl: "/wp-json/bk-mosaic/v1/init-upload", uploadUrl: "/wp-json/bk-mosaic/v1/upload-pdf" };
    } catch (e) { /* index.js not loaded */ }

    function el(tag, cls, html) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (html != null) n.innerHTML = html;
        return n;
    }
    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (ch) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
        });
    }
    function backToStart() { location.href = START; }

    /* ---------------------------------------------------------- photo from the phone */
    function loadPhoto() {
        if (!FOTO) return;
        fetch(FOTO, { cache: "no-store" })
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); })
            .then(function (blob) {
                var input = document.getElementById("input-image-selector-hidden");
                if (!input) return;
                var dt = new DataTransfer();
                dt.items.add(new File([blob], "foto.jpg", { type: blob.type || "image/jpeg" }));
                input.files = dt.files;
                input.dispatchEvent(new Event("change", { bubbles: true }));
            })
            .catch(function () {
                alert("Das Foto ist nicht mehr da (nach 30 Minuten wird es gelöscht). Bitte am Start neu scannen.");
                backToStart();
            });
    }

    /* ---------------------------------------------------------- order card in shop mode */
    var PAY_LABEL = "An der Kasse bezahlen";
    function fixOrderButton() {
        var b = document.getElementById("order-mosaic-button");
        if (!b || busy) return;
        if (b.textContent.indexOf(PAY_LABEL) === -1 && !b.classList.contains("bk-adding")) b.textContent = PAY_LABEL;
    }
    function adaptOrderCard() {
        // Only write when different: this runs from a body MutationObserver, and an unconditional write
        // would trigger it again forever (froze the tablet in the first clone test).
        var desc = document.querySelector(".mosaic-product-desc");
        var DESC = "Du nimmst dir die Steine aus unserer Mosaikwand und bekommst die Bauanleitung per E-Mail.";
        if (desc && desc.textContent !== DESC) desc.textContent = DESC;
        var gl = document.getElementById("mosaic-gram-list");
        if (gl && !gl.open) { gl.open = true; gl.dispatchEvent(new Event("toggle")); }
        var b = document.getElementById("order-mosaic-button");
        if (b && !b.dataset.bkLaden) {
            b.dataset.bkLaden = "1";
            // Capture listener: runs before the app's own click handler (which would add to the cart) and stops it.
            b.addEventListener("click", function (e) {
                e.preventDefault();
                e.stopImmediatePropagation();
                openForm();
            }, true);
            new MutationObserver(fixOrderButton).observe(b, { childList: true, characterData: true, subtree: true });
            fixOrderButton();
        }
    }

    /* ---------------------------------------------------------- gram list stays current */
    // The new editor only computes step 4 (the instruction's source) when the PDF is built. In shop mode
    // the gram list must be visible while designing, so step 4 is recomputed shortly after every change
    // in step 3 (runStep3 marks step 4 stale), once the editor is idle again.
    var gramTimer = null;
    function editorIdle() {
        var ov = document.getElementById("loading-overlay");
        return stepProcessed[3] && (!ov || ov.classList.contains("hidden"));
    }
    function refreshGrams() {
        clearTimeout(gramTimer);
        gramTimer = setTimeout(function () {
            if (busy || stepProcessed[4]) return;
            if (!editorIdle()) { refreshGrams(); return; }
            runStep4(function () { setTimeout(bkRenderGramList, 0); });
        }, 700);
    }
    if (typeof window.runStep3 === "function") {
        var origRunStep3 = window.runStep3;
        window.runStep3 = function () {
            var r = origRunStep3.apply(this, arguments);
            refreshGrams();
            return r;
        };
    }

    /* ---------------------------------------------------------- e-mail form */
    function openForm() {
        if (busy) return;
        var info = typeof getMosaicVariationInfo === "function" ? getMosaicVariationInfo() : null;
        if (!info || !info.vid) { alert("Diese Größe kann im Laden nicht bestellt werden."); return; }
        var ov = el("div", "bk-laden-ov");
        ov.innerHTML =
            '<form class="bk-laden-card" novalidate>' +
            "<h2>Fast geschafft!</h2>" +
            "<p>Nach dem Bezahlen an der Kasse schicken wir dir die <strong>Bauanleitung</strong> und deine <strong>Steine-Liste</strong> per E-Mail.</p>" +
            '<label>Vorname (optional)<input name="name" autocomplete="off" maxlength="60"></label>' +
            '<label>E-Mail-Adresse<input name="email" type="email" inputmode="email" autocomplete="off" required></label>' +
            '<p class="bk-laden-small">Wir nutzen deine Adresse nur für diese Bestellung. <a href="/datenschutz/" target="_blank" rel="noopener">Datenschutz</a></p>' +
            '<p class="bk-laden-err" hidden></p>' +
            '<div class="bk-laden-actions"><button type="button" class="bk-laden-cancel">Abbrechen</button>' +
            '<button type="submit" class="bk-laden-go">Bestellen &ndash; ' + esc(info.price) + " &euro; an der Kasse</button></div>" +
            '<div class="bk-laden-progress" hidden></div>' +
            "</form>";
        document.body.appendChild(ov);
        var form = ov.querySelector("form");
        form.email.focus();
        ov.querySelector(".bk-laden-cancel").addEventListener("click", function () { if (!busy) ov.remove(); });
        form.addEventListener("submit", function (e) {
            e.preventDefault();
            var email = form.email.value.trim();
            var err = ov.querySelector(".bk-laden-err");
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                err.hidden = false;
                err.textContent = "Bitte eine gültige E-Mail-Adresse eingeben.";
                return;
            }
            err.hidden = true;
            placeOrder(ov, form, email, form.name.value.trim(), info);
        });
    }

    function progress(ov, text) {
        var p = ov.querySelector(".bk-laden-progress");
        p.hidden = false;
        p.textContent = text;
    }

    function placeOrder(ov, form, email, name, info) {
        busy = true;
        form.querySelectorAll("input,button").forEach(function (n) { n.disabled = true; });
        var onProgress = function (e) {
            var d = e.detail || {};
            if (d.src === "order" && !d.done) progress(ov, "Bauanleitung wird erstellt … " + d.pct + " %");
        };
        document.addEventListener("bk-pdf-progress", onProgress);
        progress(ov, "Bauanleitung wird erstellt …");
        var token = null;
        generateInstructionsAsBlob()
            .then(function (blob) {
                progress(ov, "Bauanleitung wird gespeichert …");
                return uploadMosaicPdfToServer(blob, null);
            })
            .then(function (t) {
                token = t;
                var list = window.bkGramList ? window.bkGramList() : null;
                progress(ov, "Bestellung wird angelegt …");
                return fetch("/wp-json/bk-laden/v1/order", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        key: KEY, c: CODE, test: TEST ? 1 : 0, vid: info.vid, pdf_token: token,
                        email: email, name: name, grams: list ? list.rows : []
                    })
                }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
                  .then(function (res) {
                      if (!res.ok) throw new Error((res.d && res.d.message) || "Bestellung fehlgeschlagen");
                      document.removeEventListener("bk-pdf-progress", onProgress);
                      ov.remove();
                      showDone(res.d, email, list);
                  });
            })
            .catch(function (err) {
                document.removeEventListener("bk-pdf-progress", onProgress);
                busy = false;
                form.querySelectorAll("input,button").forEach(function (n) { n.disabled = false; });
                var e = ov.querySelector(".bk-laden-err");
                e.hidden = false;
                e.textContent = (err && err.message) || "Das hat nicht geklappt. Bitte nochmal versuchen oder an der Theke fragen.";
                ov.querySelector(".bk-laden-progress").hidden = true;
            });
    }

    /* ---------------------------------------------------------- done screen */
    function showDone(d, email, list) {
        var rows = "";
        if (list) {
            list.rows.forEach(function (r) {
                rows += '<tr><td><span class="bk-laden-dot" style="background:' + esc(r.hex) + '"></span>' + esc(r.name) +
                        "</td><td>" + r.count.toLocaleString("de-DE") + "</td><td><strong>" + r.grams.toLocaleString("de-DE") + " g</strong></td></tr>";
            });
        }
        var ov = el("div", "bk-laden-ov bk-laden-done");
        ov.innerHTML =
            '<div class="bk-laden-card bk-laden-wide">' +
            '<p class="bk-laden-kicker">Deine Bestellung</p>' +
            '<p class="bk-laden-num">Nr. ' + esc(d.number) + "</p>" +
            '<p class="bk-laden-pay">Bitte an der Kasse bezahlen: <strong>' + esc(d.total) + "</strong></p>" +
            "<p>Danach kommen <strong>Bauanleitung</strong> und <strong>Steine-Liste</strong> per E-Mail an <strong>" + esc(email) + "</strong>.</p>" +
            (rows ? '<div class="bk-laden-list"><table><thead><tr><th>Farbe</th><th>Steine</th><th>Gewicht</th></tr></thead><tbody>' + rows +
                    "</tbody></table></div><p class=\"bk-laden-small\">Mit 5 % Reserve gerechnet — lieber ein paar Steine mehr.</p>" : "") +
            '<button type="button" class="bk-laden-go bk-laden-next">Fertig – nächster Gast</button>' +
            "</div>";
        document.body.appendChild(ov);
        ov.querySelector(".bk-laden-next").addEventListener("click", backToStart);
        setTimeout(backToStart, IDLE_MS);
    }

    /* ---------------------------------------------------------- idle reset, back button */
    var idleTimer = null;
    function bumpIdle() {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(function () { if (!busy) backToStart(); }, IDLE_MS);
    }
    ["pointerdown", "keydown", "touchstart"].forEach(function (ev) { document.addEventListener(ev, bumpIdle, { passive: true }); });
    bumpIdle();
    document.addEventListener("click", function (e) {
        // The editor's back arrow would leave the editor; on the tablet it means "start over".
        if (e.target.closest && e.target.closest(".bk-cr-back")) {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (!busy && confirm("Zurück zum Start? Dein Entwurf geht dabei verloren.")) backToStart();
        }
    }, true);

    /* ---------------------------------------------------------- start */
    function whenReady(fn) {
        if (document.readyState === "complete") setTimeout(fn, 400);
        else window.addEventListener("load", function () { setTimeout(fn, 400); });
    }
    whenReady(function () {
        loadPhoto();
        adaptOrderCard();
        // The order card is moved into the editor once it mounts; adapt it again then.
        new MutationObserver(adaptOrderCard).observe(document.body, { childList: true, subtree: true });
    });
})();
