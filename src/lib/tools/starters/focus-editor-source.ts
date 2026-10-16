/**
 * Vetted starter: "Focus Editor" — a custom editor (the `editor` mount) that
 * replaces the standard editor with one verse at a time: source on top, a big
 * target box, keyboard next/prev, save and validate. Live-updates when someone
 * else edits the verse (and never clobbers unsaved typing).
 */
export const FOCUS_EDITOR_SOURCE = String.raw`<!doctype html>
<html>
<head>
<style>
  body { padding: 0; height: 100vh; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 20px; border-bottom: 1px solid var(--border, #ddd); }
  header .file { font-weight: 600; }
  header .pos { color: var(--muted-foreground, #666); font-size: 12px; }
  .dots { display: flex; flex-wrap: wrap; gap: 3px; padding: 8px 20px; }
  .dot { width: 10px; height: 10px; border-radius: 3px; background: var(--muted, #eee); border: 1px solid var(--border, #ddd); cursor: pointer; padding: 0; }
  .dot.filled { background: #94a3b8; } .dot.valid { background: #16a34a; } .dot.current { outline: 2px solid var(--ring, #333); outline-offset: 1px; }
  main { flex: 1; overflow: auto; padding: 16px 20px; max-width: 900px; width: 100%; margin: 0 auto; box-sizing: border-box; }
  .ref { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
  .source { font-size: 20px; line-height: 1.6; padding: 14px 16px; background: var(--muted, #f4f4f5); border-radius: 10px; }
  textarea { margin-top: 14px; width: 100%; min-height: 160px; font: inherit; font-size: 20px; line-height: 1.6; padding: 14px 16px; border-radius: 10px; border: 1px solid var(--border, #ddd); background: var(--card, #fff); color: var(--card-foreground, #111); resize: vertical; box-sizing: border-box; }
  textarea:focus { outline: 2px solid var(--ring, #888); }
  .bar { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
  button { font: inherit; font-size: 14px; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border, #ddd); background: var(--card, #fff); color: var(--card-foreground, #111); cursor: pointer; }
  button.primary { background: var(--primary, #222); color: var(--primary-foreground, #fff); border-color: transparent; }
  button.ok { background: #16a34a; color: #fff; border-color: transparent; }
  button:disabled { opacity: .5; cursor: default; }
  .status { font-size: 13px; color: var(--muted-foreground, #666); }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #16a34a22; color: #15803d; }
  .warn { color: #b45309; }
  .error { color: var(--destructive, #b91c1c); }
  kbd { font-size: 11px; border: 1px solid var(--border, #ccc); border-radius: 4px; padding: 0 4px; }
</style>
</head>
<body>
<header><span class="file" id="file">Focus Editor</span><span class="pos" id="pos"></span><span class="status" id="status" role="status"></span></header>
<div class="dots" id="dots" role="navigation" aria-label="Verses"></div>
<main id="main"><p class="status">Loading…</p></main>
<script>
(async () => {
  "use strict";
  var ctx = aquilla.context;
  var fileId = ctx.file ? ctx.file.fileId : null;
  var cells = [];
  var index = 0;
  var dirty = false;
  var remoteChanged = false;
  var busy = false;
  var main = document.getElementById("main");

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else if (k.indexOf("on") === 0) n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function setStatus(text, cls) { var s = document.getElementById("status"); s.textContent = text || ""; s.className = "status " + (cls || ""); }
  function current() { return cells[index] || null; }
  function box() { return document.getElementById("target"); }

  async function load() {
    if (!fileId) {
      var files = await aquilla.files.list();
      var first = files.filter(function (f) { return f.cellCount > 0; })[0];
      fileId = first ? first.fileId : null;
      document.getElementById("file").textContent = first ? first.name : "Focus Editor";
    } else {
      document.getElementById("file").textContent = ctx.file.name;
    }
    cells = fileId ? (await aquilla.cells.list(fileId)).filter(function (c) { return (c.source || "").trim().length > 0; }) : [];
    var saved = await aquilla.storage.get("pos:" + fileId);
    var at = cells.findIndex(function (c) { return c.cellId === saved; });
    index = at >= 0 ? at : 0;
  }

  async function save() {
    var c = current();
    if (!c || !dirty) return true;
    var value = box().value;
    busy = true; setStatus("Saving…");
    try {
      var res = await aquilla.cells.commit([{ fileId: fileId, cellId: c.cellId, value: value }]);
      if (res.failed.length) { setStatus("Could not save: " + res.failed[0].reason, "error"); return false; }
      c.target = value; c.validated = false; dirty = false; remoteChanged = false;
      setStatus("Saved");
      return true;
    } catch (e) {
      setStatus(e && e.code === "permission_denied" ? "Editing was not allowed." : (e && e.message) || String(e), "error");
      return false;
    } finally { busy = false; renderDots(); }
  }

  async function validate() {
    var c = current();
    if (!c) return;
    if (!(await save())) return;
    if (!c.target.trim()) { setStatus("Write a translation before validating.", "warn"); return; }
    busy = true; setStatus("Validating…");
    try {
      var res = await aquilla.cells.validate([{ fileId: fileId, cellId: c.cellId }]);
      if (res.validated.length) { c.validated = true; setStatus("Validated"); }
      else setStatus("Could not validate: " + (res.failed[0] ? res.failed[0].reason : "unknown"), "error");
    } catch (e) {
      setStatus(e && e.code === "permission_denied" ? "Validating was not allowed." : (e && e.message) || String(e), "error");
    } finally { busy = false; render(); }
  }

  async function go(delta, saveFirst) {
    if (saveFirst && !(await save())) return;
    var next = Math.max(0, Math.min(cells.length - 1, index + delta));
    if (next === index && delta !== 0) return;
    if (dirty && !saveFirst) { if (!(await save())) return; }
    index = next; dirty = false; remoteChanged = false;
    if (current()) await aquilla.storage.set("pos:" + fileId, current().cellId);
    render();
  }

  function renderDots() {
    var dots = document.getElementById("dots");
    dots.textContent = "";
    cells.forEach(function (c, i) {
      var cls = "dot" + (c.validated ? " valid" : c.target ? " filled" : "") + (i === index ? " current" : "");
      dots.appendChild(el("button", { class: cls, title: c.ref || String(i + 1), "aria-label": "Go to " + (c.ref || i + 1), onclick: function () { go(i - index, false); } }));
    });
    document.getElementById("pos").textContent = cells.length ? (index + 1) + " / " + cells.length : "";
  }

  function render() {
    renderDots();
    main.textContent = "";
    var c = current();
    if (!c) { main.appendChild(el("p", { class: "status", text: fileId ? "This file has no verses." : "This project has no files yet." })); return; }
    main.appendChild(el("div", { class: "ref" }, [c.ref || ("Verse " + (index + 1)), " ", c.validated ? el("span", { class: "badge", text: "Validated" }) : null]));
    main.appendChild(el("div", { class: "source", "aria-label": "Source" , text: c.source }));
    var ta = el("textarea", { id: "target", "aria-label": "Translation", placeholder: "Type the translation…", oninput: function () { dirty = true; setStatus("Unsaved changes"); } });
    ta.value = c.target || "";
    main.appendChild(ta);
    if (remoteChanged) main.appendChild(el("p", { class: "status warn", text: "Someone else changed this verse while you were typing. Saving keeps your text." }));
    main.appendChild(el("div", { class: "bar" }, [
      el("button", { text: "◀ Previous", onclick: function () { go(-1, false); } }),
      el("button", { class: "primary", text: "Save & next", onclick: function () { go(1, true); } }),
      el("button", { class: "ok", text: c.validated ? "Validated ✓" : "Validate", onclick: validate }),
      el("button", { text: "Next ▶", onclick: function () { go(1, false); } }),
      el("span", { class: "status" }, [el("kbd", { text: "Ctrl/⌘+Enter" }), " save & next · ", el("kbd", { text: "Alt+↑/↓" }), " move · ", el("kbd", { text: "Ctrl/⌘+Shift+Enter" }), " validate"]),
    ]));
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  document.addEventListener("keydown", function (e) {
    if (busy) return;
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.key === "Enter") { e.preventDefault(); validate(); }
    else if (mod && e.key === "Enter") { e.preventDefault(); go(1, true); }
    else if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); go(1, false); }
    else if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); go(-1, false); }
  });

  aquilla.on("cells.changed", async function (e) {
    if (e.fileId !== fileId || busy) return;
    var c = current();
    var fresh = (await aquilla.cells.list(fileId)).filter(function (x) { return (x.source || "").trim().length > 0; });
    var mine = c ? fresh.find(function (x) { return x.cellId === c.cellId; }) : null;
    cells = fresh;
    if (c) { var at = cells.findIndex(function (x) { return x.cellId === c.cellId; }); index = at >= 0 ? at : Math.min(index, cells.length - 1); }
    if (dirty && mine && c && mine.target !== c.target) { remoteChanged = true; var keep = box().value; render(); box().value = keep; return; }
    if (!dirty) render(); else renderDots();
  });

  try { await load(); render(); }
  catch (e) { main.textContent = ""; main.appendChild(el("p", { class: "error", role: "alert", text: (e && e.message) || String(e) })); }
})();
</script>
</body>
</html>`

export const FOCUS_EDITOR_MANIFEST = {
  name: "Focus Editor",
  description: "A distraction-free custom editor: one verse at a time, source on top, keyboard next/prev, save and validate.",
  scopes: ["read:cells", "write:target", "write:validation"],
  mounts: ["editor", "page"],
  apiRev: 1,
} as const
