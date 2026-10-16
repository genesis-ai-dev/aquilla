/**
 * Vetted starter: "Key-Term Heat Map" — a term × chapter consistency grid over
 * one file, with bulk harmonize. Hand-reviewed so the demo works without a
 * model call; same single-file contract the builder produces.
 */
export const HEATMAP_SOURCE = String.raw`<!doctype html>
<html>
<head>
<style>
  body { padding: 16px; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .muted { color: var(--muted-foreground, #666); font-size: 12px; }
  .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 12px 0; }
  select, input, button { font: inherit; padding: 4px 8px; border: 1px solid var(--border, #ddd); border-radius: 6px; background: var(--card, #fff); color: var(--card-foreground, #111); }
  button { cursor: pointer; }
  button.primary { background: var(--primary, #222); color: var(--primary-foreground, #fff); border-color: transparent; }
  button:disabled { opacity: .5; cursor: default; }
  table { border-collapse: collapse; margin-top: 8px; }
  th, td { border: 1px solid var(--border, #ddd); padding: 4px 8px; font-size: 12px; text-align: center; }
  th.term, td.term { text-align: left; cursor: pointer; white-space: nowrap; }
  tr.selected td.term { font-weight: 600; outline: 2px solid var(--ring, #888); }
  td.c-full { background: #16a34a33; } td.c-part { background: #f59e0b44; } td.c-none { background: #dc262644; } td.c-na { color: var(--muted-foreground, #999); }
  .panel { margin-top: 16px; padding: 12px; border: 1px solid var(--border, #ddd); border-radius: 8px; background: var(--card, #fff); }
  .row { display: grid; grid-template-columns: 90px 1fr 1fr; gap: 8px; padding: 4px 0; border-top: 1px solid var(--border, #eee); font-size: 12px; }
  .row:first-child { border-top: 0; }
  del { color: var(--destructive, #b91c1c); } ins { text-decoration: none; background: #16a34a33; }
  .error { color: var(--destructive, #b91c1c); }
</style>
</head>
<body>
<h1>Key-Term Heat Map</h1>
<div class="muted">How consistently each key term is rendered, chapter by chapter. Pick a term to harmonize its renderings.</div>
<div id="app"><p class="muted">Loading…</p></div>
<script>
(async () => {
  "use strict";
  var app = document.getElementById("app");
  var state = { files: [], fileId: null, cells: [], terms: [], adhoc: [], selected: null, busy: false, error: null };

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else if (k.indexOf("on") === 0) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function escapeRe(s) { return s.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&"); }
  function wordRe(word) { return new RegExp("(?<![\\p{L}\\p{N}])" + escapeRe(word) + "(?![\\p{L}\\p{N}])", "giu"); }
  function has(text, word) { return !!word && wordRe(word).test(text || ""); }

  function allTerms() {
    var fromBase = state.terms.map(function (t) {
      var approved = t.renderings.filter(function (r) { return r.status === "approved" || r.status === "preferred"; });
      var preferred = (approved[0] || t.renderings[0] || { rendering: "" }).rendering;
      var variants = t.renderings.map(function (r) { return r.rendering; }).filter(function (r) { return r && r !== preferred; });
      return { key: "t:" + t.id, term: t.term, preferred: preferred, variants: variants };
    });
    return fromBase.concat(state.adhoc.map(function (a, i) { return { key: "a:" + i, term: a.term, preferred: a.preferred, variants: a.variants }; }));
  }
  function chapters() {
    var seen = [];
    state.cells.forEach(function (c) { var ch = c.chapter || "—"; if (seen.indexOf(ch) < 0) seen.push(ch); });
    return seen;
  }
  function stats(term, chapter) {
    var n = 0, k = 0;
    state.cells.forEach(function (c) {
      if ((c.chapter || "—") !== chapter || !has(c.source, term.term)) return;
      n++;
      if (term.preferred && has(c.target, term.preferred)) k++;
    });
    return { n: n, k: k };
  }
  function proposals(term) {
    var out = [];
    if (!term || !term.preferred) return out;
    state.cells.forEach(function (c) {
      if (!has(c.source, term.term) || !c.target) return;
      var next = c.target;
      term.variants.forEach(function (v) { if (v) next = next.replace(wordRe(v), term.preferred); });
      if (next !== c.target) out.push({ cell: c, next: next });
    });
    return out;
  }

  async function loadFile(fileId) {
    state.fileId = fileId;
    state.cells = fileId ? await aquilla.cells.list(fileId) : [];
    await aquilla.storage.set("fileId", fileId);
  }

  async function load() {
    try {
      state.files = await aquilla.files.list();
      try { state.terms = await aquilla.terms.list(); } catch (e) { state.terms = []; }
      state.adhoc = (await aquilla.storage.get("adhoc")) || [];
      var saved = await aquilla.storage.get("fileId");
      var first = state.files.filter(function (f) { return f.cellCount > 0; })[0] || state.files[0];
      var pick = state.files.some(function (f) { return f.fileId === saved; }) ? saved : (first ? first.fileId : null);
      await loadFile(pick);
      state.error = null;
    } catch (e) {
      state.error = e && e.message ? e.message : String(e);
    }
    render();
  }

  async function harmonize(term) {
    var list = proposals(term);
    if (list.length === 0) return;
    state.busy = true; render();
    try {
      var res = await aquilla.cells.commit(list.map(function (p) { return { fileId: state.fileId, cellId: p.cell.cellId, value: p.next }; }));
      await aquilla.ui.notify("Harmonized " + res.committed.length + " cell(s) to “" + term.preferred + "”" + (res.failed.length ? " (" + res.failed.length + " failed)" : ""));
      state.cells = await aquilla.cells.list(state.fileId);
      state.error = null;
    } catch (e) {
      state.error = e && e.code === "permission_denied" ? "Editing translations was not allowed." : (e && e.message ? e.message : String(e));
    }
    state.busy = false; render();
  }

  function addTermForm() {
    var term = el("input", { placeholder: "Source term", "aria-label": "Source term" });
    var pref = el("input", { placeholder: "Preferred rendering", "aria-label": "Preferred rendering" });
    var vars = el("input", { placeholder: "Variants (comma-separated)", "aria-label": "Variants" });
    var add = el("button", { text: "Track term", onclick: async function () {
      var t = term.value.trim(), p = pref.value.trim();
      if (!t || !p) return;
      state.adhoc.push({ term: t, preferred: p, variants: vars.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean) });
      await aquilla.storage.set("adhoc", state.adhoc);
      state.selected = "a:" + (state.adhoc.length - 1);
      render();
    } });
    return el("div", { class: "bar" }, [term, pref, vars, add]);
  }

  function render() {
    app.textContent = "";
    if (state.error) app.appendChild(el("p", { class: "error", role: "alert", text: state.error }));
    if (state.files.length === 0) {
      app.appendChild(el("p", { class: "muted", text: "This project has no files yet. Import a file to see its key-term heat map." }));
      return;
    }
    var select = el("select", { "aria-label": "File", onchange: async function (e) { await loadFile(e.target.value); render(); } },
      state.files.map(function (f) { var o = el("option", { value: f.fileId, text: f.name + " (" + f.cellCount + ")" }); if (f.fileId === state.fileId) o.selected = true; return o; }));
    app.appendChild(el("div", { class: "bar" }, [el("label", { text: "File" }), select]));
    app.appendChild(addTermForm());

    var terms = allTerms();
    var chs = chapters();
    if (state.cells.length === 0) { app.appendChild(el("p", { class: "muted", text: "This file has no cells." })); return; }
    if (terms.length === 0) { app.appendChild(el("p", { class: "muted", text: "No key terms yet. Add terms to the termbase, or track one above." })); return; }

    var head = el("tr", {}, [el("th", { class: "term", text: "Term → preferred" })].concat(chs.map(function (c) { return el("th", { text: c }); })));
    var rows = terms.map(function (t) {
      var tr = el("tr", { class: state.selected === t.key ? "selected" : "", "data-term": t.term }, [
        el("td", { class: "term", tabindex: "0", role: "button", "aria-label": "Select term " + t.term, text: t.term + " → " + (t.preferred || "?"), onclick: function () { state.selected = t.key; render(); } }),
      ].concat(chs.map(function (c) {
        var s = stats(t, c);
        var cls = s.n === 0 ? "c-na" : s.k === s.n ? "c-full" : s.k === 0 ? "c-none" : "c-part";
        return el("td", { class: cls, title: s.k + " of " + s.n + " use the preferred rendering", text: s.n === 0 ? "·" : s.k + "/" + s.n });
      })));
      return tr;
    });
    app.appendChild(el("table", { "aria-label": "Key-term heat map" }, [el("thead", {}, [head]), el("tbody", {}, rows)]));

    var sel = terms.filter(function (t) { return t.key === state.selected; })[0];
    if (!sel) return;
    var list = proposals(sel);
    var panel = el("section", { class: "panel", "aria-label": "Harmonize " + sel.term }, [
      el("strong", { text: "Harmonize “" + sel.term + "” → “" + sel.preferred + "”" }),
      el("div", { class: "muted", text: sel.variants.length ? "Replaces: " + sel.variants.join(", ") : "No variants to replace." }),
    ]);
    list.slice(0, 50).forEach(function (p) {
      panel.appendChild(el("div", { class: "row" }, [el("span", { text: p.cell.ref || p.cell.cellId.slice(0, 8) }), el("del", { text: p.cell.target }), el("ins", { text: p.next })]));
    });
    var btn = el("button", { class: "primary", onclick: function () { harmonize(sel); }, text: state.busy ? "Harmonizing…" : "Harmonize " + list.length + " cell(s)" });
    btn.disabled = state.busy || list.length === 0;
    panel.appendChild(el("div", { class: "bar" }, [btn]));
    app.appendChild(panel);
  }

  aquilla.on("cells.changed", async function (e) {
    if (e.fileId !== state.fileId || state.busy) return;
    try { state.cells = await aquilla.cells.list(state.fileId); render(); } catch (err) { /* keep the last view */ }
  });

  await load();
})();
</script>
</body>
</html>`

export const HEATMAP_MANIFEST = {
  name: "Key-Term Heat Map",
  description: "A term × chapter consistency grid over one file, with one-click bulk harmonize.",
  scopes: ["read:cells", "read:terms", "write:target"],
  mounts: ["page", "panel"],
  apiRev: 1,
} as const
