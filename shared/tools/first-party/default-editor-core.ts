/**
 * First-party editor extension — part 1/5: shared state, DOM helpers, i18n,
 * icons, rich-text in/out (footnotes as atomic markers), floating UI.
 * Plain ES2020 in a classic script, evaluated in the sandboxed frame; parts
 * are concatenated inside ONE closure (default-editor-script.ts). The editor
 * talks to Aquilla only through `aquilla.*`.
 */
export const EDITOR_CORE = String.raw`
  var ctx = aquilla.context;
  var doc = document;
  var S = {
    fileId: ctx.file ? ctx.file.fileId : null,
    fileName: ctx.file ? ctx.file.name : "",
    cfg: null,
    ids: [], byId: Object.create(null), index: Object.create(null),
    sections: [], sectionIdx: Object.create(null),
    signals: { stale: [], upstreamStale: [], assignments: {}, repetition: {}, issues: {}, health: {}, ai: {}, backtranslating: [], remoteChanged: [] },
    sig: { stale: Object.create(null), upstream: Object.create(null), bt: Object.create(null), remote: Object.create(null) },
    peers: [], peersByCell: Object.create(null), locks: Object.create(null), comments: Object.create(null), audio: Object.create(null),
    bts: Object.create(null), terms: Object.create(null), termsAsked: Object.create(null),
    selection: Object.create(null), selCount: 0, selAnchor: null, pericopes: [], voicing: Object.create(null),
    activeId: null, focusRowId: null, expanded: Object.create(null), expTab: Object.create(null),
    drafts: Object.create(null), saved: Object.create(null), errors: Object.create(null),
    loading: true, readOnly: false, chromeW: 0, pendingReveal: ctx.file && ctx.file.revealCellId ? ctx.file.revealCellId : null,
    username: ctx.user ? ctx.user.username : "",
  };
  var IDLE_MS = 1200;          // TranslatedEditor COMMIT_IDLE_MS
  var TYPING_MS = 650;         // presence draft cadence (TE onSelectionChange)
  var SUGGEST_MS = 450;
  var later = function (fn, ms) { return setTimeout(fn, ms || 0); };
  function $(id) { return doc.getElementById(id); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function el(tag, attrs, kids) {
    var n = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "text") n.textContent = v;
      else if (k === "class") n.className = v;
      else if (k === "style" && typeof v === "object") Object.keys(v).forEach(function (s) { n.style.setProperty(s, v[s]); });
      else if (k.indexOf("on") === 0) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) { if (c !== null && c !== undefined && c !== false) n.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return n;
  }

  // ── Icons: the built-in's lucide glyphs (generated, see default-editor-icons.ts).
  var SVGNS = "http://www.w3.org/2000/svg";
  function icon(name, cls) {
    var s = doc.createElementNS(SVGNS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("class", "i " + (cls || ""));
    s.setAttribute("aria-hidden", "true");
    s.innerHTML = ICONS[name] || "";
    return s;
  }

  // ── i18n: the app's own editor strings, in the user's language.
  var STR = Object.create(null), LOCALE = "en";
  var plural = null;
  function t(key, vars) {
    var v = STR[key];
    var out;
    if (v && typeof v === "object") {
      var countVar = v.countVar || "count";
      var n = vars && typeof vars[countVar] === "number" ? vars[countVar] : 0;
      var cat = "other";
      try { if (!plural) plural = new Intl.PluralRules(LOCALE); cat = plural.select(n); } catch (e) { cat = n === 1 ? "one" : "other"; }
      out = v.forms[cat] || v.forms.other || key;
    } else out = typeof v === "string" ? v : (FALLBACK[key] || key);
    if (vars) Object.keys(vars).forEach(function (k) { out = out.split("{" + k + "}").join(String(vars[k])); });
    return out;
  }
  function loadStrings() {
    return aquilla.ui.strings(STRING_KEYS).then(function (res) {
      STR = res.strings || STR;
      LOCALE = res.locale || "en";
      doc.documentElement.lang = LOCALE;
      doc.documentElement.dir = res.dir || "ltr";
    }, function () {});
  }

  function errText(err) { return err && err.message ? err.message : String(err); }
  function isDenied(err) { return err && err.code === "permission_denied"; }
  function toast(msg) { aquilla.ui.notify(msg).catch(function () {}); }

  // ── Rich text. The host sanitizes everything it hands us and everything we
  // write; this second pass keeps the frame inert (no attributes but the
  // footnote marker, a small inline allowlist), because cell HTML is other
  // people's content. USFM footnotes (\f … \f*) live in the plain value; on
  // screen they are atomic marker chips that carry the raw text.
  var ALLOWED = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, STRIKE: 1, DEL: 1, CODE: 1, P: 1, BR: 1, SPAN: 1 };
  var FN_RE = /\\f\s+([^\s\\]+)([\s\S]*?)\\f\*/g;
  function fnText(raw) {
    var m = /\\ft\s+([\s\S]*?)(?=\\f\*|\\f[a-z]+\s|$)/.exec(raw);
    return (m ? m[1] : raw.replace(/\\f\*?|\\f[a-z]+/g, "")).trim();
  }
  function fnCaller(raw) { var m = /^\\f\s+([^\s\\]+)/.exec(raw); return m ? m[1] : "+"; }
  function fnChip(raw, n) {
    var caller = fnCaller(raw);
    var label = caller !== "+" && caller !== "-" ? caller : String(n);
    return el("span", { class: "fn", contenteditable: "false", "data-usfm-footnote": raw, title: fnText(raw), "aria-label": "Footnote " + label + ": " + fnText(raw) }, [label]);
  }
  function cleanInto(target, html) {
    var tpl = doc.createElement("template");
    tpl.innerHTML = html || "";
    (function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (c) {
        if (c.nodeType === 1) {
          if (!ALLOWED[c.tagName]) {
            if (c.tagName === "SCRIPT" || c.tagName === "STYLE" || c.tagName === "TEMPLATE") { c.remove(); return; }
            walk(c);
            while (c.firstChild) c.parentNode.insertBefore(c.firstChild, c);
            c.remove();
            return;
          }
          var fn = c.getAttribute("data-usfm-footnote");
          Array.prototype.slice.call(c.attributes).forEach(function (a) { c.removeAttribute(a.name); });
          if (fn !== null) { c.setAttribute("data-usfm-footnote", fn); return; }
          walk(c);
        } else if (c.nodeType !== 3) c.remove();
      });
    })(tpl.content);
    target.textContent = "";
    target.appendChild(tpl.content);
  }
  /** Render footnote markers found in text nodes (plain values carry raw USFM). */
  function chipFootnotes(root) {
    var n = 0;
    var walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    var texts = [];
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute("data-usfm-footnote")) {
        n++;
        var raw = node.getAttribute("data-usfm-footnote");
        node.replaceWith(fnChip(raw, n));
      } else if (node.nodeType === 3 && node.nodeValue.indexOf("\\f") >= 0) texts.push(node);
    }
    texts.forEach(function (tn) {
      var s = tn.nodeValue, frag = doc.createDocumentFragment(), last = 0, m;
      FN_RE.lastIndex = 0;
      while ((m = FN_RE.exec(s))) {
        if (m.index > last) frag.appendChild(doc.createTextNode(s.slice(last, m.index)));
        n++;
        frag.appendChild(fnChip(m[0], n));
        last = m.index + m[0].length;
      }
      if (last < s.length) frag.appendChild(doc.createTextNode(s.slice(last)));
      tn.replaceWith(frag);
    });
    return n;
  }
  function plainToHtml(text) {
    var d = doc.createElement("div");
    d.textContent = text || "";
    return d.innerHTML.replace(/\n/g, "<br>");
  }
  function showInto(target, html, plain) {
    if (html) cleanInto(target, html);
    else target.innerHTML = plainToHtml(plain);
    chipFootnotes(target);
  }
  /** Plain text of an edited cell: <br> and block ends become newlines,
   *  footnote chips become their raw USFM again (byte-for-byte). */
  function plainOf(node) {
    var out = "";
    (function walk(n) {
      Array.prototype.forEach.call(n.childNodes, function (c) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1) {
          if (c.classList && c.classList.contains("ghost")) return;
          var fn = c.getAttribute && c.getAttribute("data-usfm-footnote");
          if (fn !== null && fn !== undefined) { out += fn; return; }
          if (c.tagName === "BR") { out += "\n"; return; }
          var block = c.tagName === "P" || c.tagName === "DIV";
          if (block && out && out.charAt(out.length - 1) !== "\n") out += "\n";
          walk(c);
        }
      });
    })(node);
    return out.replace(/\u00a0/g, " ").replace(/\n+$/, "");
  }
  function htmlOf(node) {
    var clone = node.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll(".ghost, .ghost-hint"), function (g) { g.remove(); });
    Array.prototype.forEach.call(clone.querySelectorAll("[data-usfm-footnote]"), function (f) {
      var span = doc.createElement("span");
      span.setAttribute("data-usfm-footnote", f.getAttribute("data-usfm-footnote"));
      f.replaceWith(span);
    });
    var inner = clone.innerHTML.replace(/<div>/gi, "<br>").replace(/<\/div>/gi, "");
    if (!plainOf(node).trim()) return "";
    return /^<p[\s>]/i.test(inner) ? inner : "<p>" + inner + "</p>";
  }
  /** Plain-text offset of a DOM point inside root (footnotes count raw). */
  function offsetOf(root, container, offset) {
    var r = doc.createRange();
    r.selectNodeContents(root);
    try { r.setEnd(container, offset); } catch (e) { return 0; }
    var frag = r.cloneContents(), d = doc.createElement("div");
    d.appendChild(frag);
    return plainOf(d).length;
  }
  /** Wrap [start,end) plain-text ranges of a rendered node with spans. */
  function decorate(root, ranges) {
    if (!ranges.length) return;
    ranges.sort(function (a, b) { return a.start - b.start; });
    var pos = 0, i = 0;
    var nodes = [];
    var walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (var n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    nodes.forEach(function (tn) {
      var text = tn.nodeValue, start = pos, end = pos + text.length;
      pos = end;
      var cuts = ranges.filter(function (r) { return r.start < end && r.end > start; });
      if (!cuts.length) return;
      var frag = doc.createDocumentFragment(), at = 0;
      cuts.forEach(function (r) {
        var a = Math.max(0, r.start - start), b = Math.min(text.length, r.end - start);
        if (a < at) a = at;
        if (b <= a) return;
        if (a > at) frag.appendChild(doc.createTextNode(text.slice(at, a)));
        var span = el("span", r.attrs, [text.slice(a, b)]);
        frag.appendChild(span);
        at = b;
      });
      if (at < text.length) frag.appendChild(doc.createTextNode(text.slice(at)));
      tn.replaceWith(frag);
    });
    void i;
  }

  // ── Floating UI: one popover at a time, tooltips, dialogs.
  var openPop = null;
  function closePop() { if (openPop) { var p = openPop; openPop = null; if (p.onClose) p.onClose(); p.node.remove(); } }
  function place(node, anchor, side, align) {
    var r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
    doc.body.appendChild(node);
    var w = node.offsetWidth, h = node.offsetHeight, vw = innerWidth, vh = innerHeight, x, y;
    if (side === "right") { x = r.right + 6; y = align === "start" ? r.top : r.top + r.height / 2 - h / 2; if (x + w > vw - 8) x = r.left - w - 6; }
    else if (side === "top") { y = r.top - h - 6; x = align === "end" ? r.right - w : align === "center" ? r.left + r.width / 2 - w / 2 : r.left; if (y < 8) y = r.bottom + 6; }
    else { y = r.bottom + 6; x = align === "end" ? r.right - w : align === "center" ? r.left + r.width / 2 - w / 2 : r.left; if (y + h > vh - 8) y = Math.max(8, r.top - h - 6); }
    node.style.left = Math.max(8, Math.min(x, vw - w - 8)) + "px";
    node.style.top = Math.max(8, Math.min(y, vh - h - 8)) + "px";
  }
  function popover(anchor, node, opts) {
    closePop();
    opts = opts || {};
    node.classList.add("pop");
    node.setAttribute("role", opts.role || "dialog");
    place(node, anchor, opts.side || "bottom", opts.align || "start");
    openPop = { node: node, anchor: anchor, onClose: opts.onClose };
    return node;
  }
  doc.addEventListener("mousedown", function (e) {
    if (openPop && !openPop.node.contains(e.target) && !(openPop.anchor.contains && openPop.anchor.contains(e.target))) closePop();
  }, true);
  doc.addEventListener("keydown", function (e) { if (e.key === "Escape" && openPop) { closePop(); e.stopPropagation(); } }, true);

  var tipNode = null, tipTimer = null;
  function hideTip() { if (tipTimer) clearTimeout(tipTimer); tipTimer = null; if (tipNode) { tipNode.remove(); tipNode = null; } }
  function tip(target, textOrFn, side) {
    target.addEventListener("mouseenter", function () {
      hideTip();
      tipTimer = later(function () {
        var text = typeof textOrFn === "function" ? textOrFn() : textOrFn;
        if (!text || !target.isConnected) return;
        tipNode = el("div", { class: "tip", role: "tooltip" }, [text]);
        place(tipNode, target, side || "top", "center");
      }, 350);
    });
    target.addEventListener("mouseleave", hideTip);
    target.addEventListener("mousedown", hideTip);
  }
  function dialog(title, body, actions) {
    closePop();
    var scrim = el("div", { class: "scrim" });
    var box = el("div", { class: "dialog", role: "alertdialog", "aria-modal": "true", "aria-label": title }, [el("h2", { text: title })].concat(body));
    var row = el("div", { class: "row-b" });
    function close() { scrim.remove(); }
    actions.forEach(function (a) {
      row.appendChild(el("button", { class: "btn-s" + (a.primary ? " primary" : ""), type: "button", onclick: function () { close(); if (a.run) a.run(); } }, [a.label]));
    });
    box.appendChild(row);
    scrim.appendChild(box);
    scrim.addEventListener("mousedown", function (e) { if (e.target === scrim) close(); });
    scrim.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.stopPropagation(); close(); } });
    doc.body.appendChild(scrim);
    var focus = box.querySelector("textarea, input, .primary");
    if (focus) focus.focus();
    return { close: close, box: box };
  }
  function initials(name) {
    var parts = String(name || "?").replace(/[^\p{L}\p{N} ._-]/gu, "").split(/[ ._-]+/).filter(Boolean);
    return ((parts[0] || "?").charAt(0) + (parts[1] ? parts[1].charAt(0) : "")).toUpperCase();
  }
`
