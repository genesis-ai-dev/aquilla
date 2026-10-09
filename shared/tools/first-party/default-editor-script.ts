/**
 * The first-party default editor's script (see default-editor.ts). Plain
 * ES2020 in a classic <script>, talking to Aquilla ONLY through `aquilla.*`
 * (the same bridge every extension gets — no privileged calls).
 */
export const DEFAULT_EDITOR_SCRIPT = String.raw`
(function () {
  "use strict";
  var ctx = aquilla.context;
  var doc = document;
  var state = {
    fileId: ctx.file ? ctx.file.fileId : null,
    fileName: ctx.file ? ctx.file.name : "",
    cells: [],          // document order
    byId: Object.create(null),
    rows: Object.create(null),
    loading: true,
    activeId: null,
    readOnly: false,
    canValidate: true,
    locks: Object.create(null),
    comments: Object.create(null),
    audio: Object.create(null),
    pendingReveal: ctx.file && ctx.file.revealCellId ? ctx.file.revealCellId : null,
  };
  var IDLE_MS = 1200;
  var PAGE_FIRST = 150;
  var PAGE_REST = 1000;
  var later = function (fn, ms) { return setTimeout(fn, ms || 0); };

  function $(id) { return doc.getElementById(id); }
  function el(tag, attrs, kids) {
    var n = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "text") n.textContent = v;
      else if (k.indexOf("on") === 0) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return n;
  }
  function setStatus(text, isError) {
    var s = $("status");
    if (!s) return;
    s.textContent = text || "";
    s.className = "status" + (isError ? " error" : "");
  }
  function errText(err) { return err && err.message ? err.message : String(err); }
  function isDenied(err) { return err && err.code === "permission_denied"; }

  // ── Rich text: the host sanitizes everything it hands us AND everything we
  // write; this second pass keeps the frame itself inert (no attributes, a
  // small inline allowlist), because cell HTML is other people's content.
  var ALLOWED = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, STRIKE: 1, DEL: 1, CODE: 1, P: 1, BR: 1, SPAN: 1 };
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
          Array.prototype.slice.call(c.attributes).forEach(function (a) {
            if (a.name !== "data-usfm-footnote") c.removeAttribute(a.name);
          });
          walk(c);
        } else if (c.nodeType !== 3) {
          c.remove();
        }
      });
    })(tpl.content || tpl);
    target.textContent = "";
    target.appendChild(tpl.content || tpl);
  }
  function plainToHtml(text) {
    var d = doc.createElement("div");
    d.textContent = text || "";
    return d.innerHTML.replace(/\n/g, "<br>");
  }
  function showInto(target, html, plain) {
    if (html) cleanInto(target, html);
    else target.innerHTML = plainToHtml(plain);
  }
  /** Plain text of an edited cell: <br> and block ends become newlines. */
  function plainOf(node) {
    var out = "";
    (function walk(n) {
      Array.prototype.forEach.call(n.childNodes, function (c) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1) {
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
    var inner = node.innerHTML.replace(/<div>/gi, "<br>").replace(/<\/div>/gi, "");
    if (!plainOf(node).trim()) return "";
    return /^<p[\s>]/i.test(inner) ? inner : "<p>" + inner + "</p>";
  }

  // ── Layout ────────────────────────────────────────────────────────────────
  function frame() {
    doc.body.textContent = "";
    var chapters = el("select", { id: "chapters", "aria-label": "Jump to chapter", onchange: function (e) { jumpToChapter(e.target.value); } });
    doc.body.appendChild(el("header", {}, [
      el("span", { class: "file", id: "file", text: state.fileName || "Editor" }),
      el("span", { class: "progress", id: "progress" }),
      chapters,
      el("span", { class: "spacer" }),
      el("span", { class: "status", id: "status", role: "status", "aria-live": "polite" }),
    ]));
    doc.body.appendChild(el("div", { class: "banner", id: "banner", hidden: true }));
    doc.body.appendChild(el("div", { class: "cols", "aria-hidden": "true" }, [
      el("span", { text: "Ref" }), el("span", { text: "Source" }), el("span", { text: "Translation" }), el("span", { text: "" }),
    ]));
    var list = el("div", { id: "list", role: "list", "aria-label": "Cells" });
    list.appendChild(el("p", { class: "empty", text: "Loading…" }));
    doc.body.appendChild(list);
  }
  function banner(text) {
    var b = $("banner");
    if (!b) return;
    b.textContent = text || "";
    if (text) b.removeAttribute("hidden"); else b.setAttribute("hidden", "");
  }
  function refreshProgress() {
    var p = $("progress");
    if (!p) return;
    var total = 0, done = 0, valid = 0;
    state.cells.forEach(function (c) {
      if (c.type === "heading" || !(c.source || "").trim()) return;
      total++;
      if ((c.target || "").trim()) done++;
      if (c.validated) valid++;
    });
    p.textContent = done + "/" + total + " translated · " + valid + " validated" + (state.loading ? " · loading…" : "");
  }
  function refreshChapters() {
    var sel = $("chapters");
    if (!sel) return;
    var seen = Object.create(null), opts = [el("option", { value: "", text: "Chapter…" })];
    state.cells.forEach(function (c) {
      if (c.chapter && !seen[c.chapter]) { seen[c.chapter] = 1; opts.push(el("option", { value: c.chapter, text: c.chapter })); }
    });
    sel.textContent = "";
    opts.forEach(function (o) { sel.appendChild(o); });
    if (opts.length < 2) sel.setAttribute("hidden", ""); else sel.removeAttribute("hidden");
  }

  function label(c) { return c.ref || (c.type === "heading" ? "Heading" : "—"); }

  function buildRow(c) {
    var tgt = el("div", {
      class: "tgt", role: "textbox", "aria-multiline": "true", tabindex: "0",
      "aria-label": "Translation for " + label(c), "data-placeholder": "Translate…", spellcheck: "true",
    });
    tgt.setAttribute("contenteditable", state.readOnly ? "false" : "true");
    tgt.addEventListener("focus", function () { onFocus(c.cellId); });
    tgt.addEventListener("blur", function () { onBlur(c.cellId); });
    tgt.addEventListener("input", function () { onInput(c.cellId); });
    tgt.addEventListener("keydown", function (e) { onKey(c.cellId, e); });
    tgt.addEventListener("paste", function (e) {
      // Paste as plain text: foreign markup never enters a cell.
      var text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
      if (!text || !doc.execCommand) return;
      e.preventDefault();
      doc.execCommand("insertText", false, text);
    });
    var val = el("button", { class: "val", type: "button", "aria-pressed": "false", "aria-label": "Validate " + label(c), title: "Validate (Ctrl/Cmd+Shift+Enter)",
      onclick: function () { toggleValidate(c.cellId); } }, ["✓"]);
    var badges = el("div", { class: "badges" });
    var row = el("div", { class: "row" + (c.type === "heading" ? " heading" : ""), role: "listitem", "data-cell-id": c.cellId, "data-ref": c.ref || "" }, [
      el("div", { class: "gutter" }, [el("span", { class: "ref", text: label(c) }), badges]),
      el("div", { class: "src", lang: "", dir: "auto" }),
      tgt,
      el("div", { class: "actions" }, [val]),
    ]);
    var r = { row: row, src: row.children[1], tgt: tgt, val: val, badges: badges, dirty: false, timer: null, saving: null, remote: null, committed: c.target };
    state.rows[c.cellId] = r;
    paintRow(c.cellId, true);
    return row;
  }

  function paintRow(cellId, initial) {
    var c = state.byId[cellId], r = state.rows[cellId];
    if (!c || !r) return;
    if (initial) showInto(r.src, c.sourceHtml, c.source);
    if (initial || (!r.dirty && doc.activeElement !== r.tgt)) {
      showInto(r.tgt, c.targetHtml, c.target);
      r.committed = c.target;
    }
    var lock = state.locks[cellId];
    var editable = !state.readOnly && !lock;
    r.tgt.setAttribute("contenteditable", editable ? "true" : "false");
    r.val.setAttribute("aria-pressed", c.validated ? "true" : "false");
    r.val.setAttribute("aria-label", (c.validated ? "Unvalidate " : "Validate ") + label(c));
    r.val.disabled = !state.canValidate || !(c.target || "").trim();
    // Badges: comments, audio, presence lock, untouched AI draft.
    r.badges.textContent = "";
    var n = state.comments[cellId] || 0;
    r.badges.appendChild(el("button", { class: "badge" + (n ? "" : " quiet"), type: "button", "aria-label": (n ? n + " open comments on " : "Comment on ") + label(c),
      title: "Comments", "data-comments": String(n), onclick: function () { openComments(cellId); } }, [n ? "💬 " + n : "💬"]));
    if (state.audio[cellId]) {
      r.badges.appendChild(el("button", { class: "badge", type: "button", "aria-label": "Play audio for " + label(c), title: "Play audio",
        onclick: function () { aquilla.audio.play(state.fileId, cellId).catch(function (err) { setStatus(errText(err), true); }); } }, ["▶"]));
    }
    if (lock) r.badges.appendChild(el("span", { class: "badge lock", "data-lock": lock, text: "✎ " + lock + " is editing" }));
    if (c.aiDrafted) r.badges.appendChild(el("span", { class: "badge ai", title: "Untouched AI draft", text: "AI" }));
  }

  // Rows render progressively (first page paints immediately); offscreen rows
  // are skipped by the browser (content-visibility: auto).
  function appendRows(cells) {
    var list = $("list");
    if (!list) return;
    if (state.cells.length === 0) list.textContent = "";
    var frag = doc.createDocumentFragment();
    cells.forEach(function (c) {
      if (state.byId[c.cellId]) return;
      state.byId[c.cellId] = c;
      state.cells.push(c);
      frag.appendChild(buildRow(c));
    });
    list.appendChild(frag);
  }

  // ── Focus, presence, commits ─────────────────────────────────────────────
  function onFocus(cellId) {
    if (state.activeId && state.activeId !== cellId) setActiveClass(state.activeId, false);
    state.activeId = cellId;
    setActiveClass(cellId, true);
    if (!state.readOnly && !state.locks[cellId]) {
      aquilla.presence.claim(state.fileId, cellId).catch(function (err) { if (isDenied(err)) setReadOnly(); });
    }
    aquilla.storage.set("pos:" + state.fileId, cellId).catch(function () {});
  }
  function setActiveClass(cellId, on) {
    var r = state.rows[cellId];
    if (r) r.row.classList[on ? "add" : "remove"]("active");
  }
  function onBlur(cellId) {
    var r = state.rows[cellId];
    if (r && r.dirty) commit(cellId);
    if (!state.readOnly) aquilla.presence.release(state.fileId, cellId).catch(function () {});
  }
  function onInput(cellId) {
    var r = state.rows[cellId];
    if (!r) return;
    r.dirty = true;
    r.tgt.classList.add("dirty");
    setStatus("Editing…");
    if (r.timer) clearTimeout(r.timer);
    r.timer = later(function () { r.timer = null; commit(cellId); }, IDLE_MS);
  }

  function commit(cellId) {
    var r = state.rows[cellId], c = state.byId[cellId];
    if (!r || !c || !r.dirty) return Promise.resolve(true);
    if (r.timer) { clearTimeout(r.timer); r.timer = null; }
    if (r.saving) return r.saving.then(function () { return commit(cellId); });
    var value = plainOf(r.tgt);
    var html = htmlOf(r.tgt);
    r.dirty = false;
    r.tgt.classList.remove("dirty");
    r.tgt.classList.add("saving");
    setStatus("Saving…");
    r.saving = aquilla.cells.commit([{ fileId: state.fileId, cellId: cellId, value: value, html: html }]).then(function (res) {
      r.saving = null;
      r.tgt.classList.remove("saving");
      if (res && res.failed && res.failed.length) {
        r.dirty = true;
        r.tgt.classList.add("dirty");
        setStatus("Not saved: " + res.failed[0].reason, true);
        return false;
      }
      c.target = value; c.targetHtml = html || null; c.validated = false; c.aiDrafted = false;
      r.committed = value;
      if (r.remote) { r.remote.remove(); r.remote = null; }
      paintRow(cellId);
      refreshProgress();
      setStatus("Saved");
      return true;
    }, function (err) {
      r.saving = null;
      r.tgt.classList.remove("saving");
      r.dirty = true;
      r.tgt.classList.add("dirty");
      if (isDenied(err)) setReadOnly();
      setStatus("Not saved: " + errText(err), true);
      return false;
    });
    return r.saving;
  }

  function toggleValidate(cellId) {
    var c = state.byId[cellId];
    if (!c) return;
    commit(cellId).then(function (ok) {
      if (!ok || !(c.target || "").trim()) return;
      var next = !c.validated;
      var call = next ? aquilla.cells.validate : aquilla.cells.unvalidate;
      setStatus(next ? "Validating…" : "Removing validation…");
      return call([{ fileId: state.fileId, cellId: cellId }]).then(function (res) {
        if (res && res.failed && res.failed.length) { setStatus("Not validated: " + res.failed[0].reason, true); return; }
        c.validated = next;
        paintRow(cellId);
        refreshProgress();
        setStatus(next ? "Validated" : "Validation removed");
      });
    }).catch(function (err) {
      if (isDenied(err)) { state.canValidate = false; state.cells.forEach(function (x) { paintRow(x.cellId); }); }
      setStatus(errText(err), true);
    });
  }

  function editableIds() {
    return state.cells.filter(function (c) { return c.type !== "heading" || (c.source || "").trim(); }).map(function (c) { return c.cellId; });
  }
  function move(cellId, delta) {
    var ids = editableIds();
    var i = ids.indexOf(cellId);
    var next = ids[i + delta];
    if (next) focusCell(next, delta > 0 ? "start" : "end");
  }
  function caretAt(node, where) {
    var sel = doc.getSelection ? doc.getSelection() : null;
    if (!sel || !doc.createRange) return;
    var range = doc.createRange();
    range.selectNodeContents(node);
    range.collapse(where === "start");
    sel.removeAllRanges();
    sel.addRange(range);
  }
  function caretEdge(node) {
    var sel = doc.getSelection ? doc.getSelection() : null;
    if (!sel || sel.rangeCount === 0 || !doc.createRange) return { start: true, end: true };
    var r = sel.getRangeAt(0);
    var before = doc.createRange(); before.selectNodeContents(node); before.setEnd(r.startContainer, r.startOffset);
    var after = doc.createRange(); after.selectNodeContents(node); after.setStart(r.endContainer, r.endOffset);
    return { start: !before.toString().length && r.collapsed, end: !after.toString().length && r.collapsed };
  }
  function focusCell(cellId, where) {
    var r = state.rows[cellId];
    if (!r) return false;
    if (r.row.scrollIntoView) r.row.scrollIntoView({ block: "nearest" });
    r.tgt.focus();
    caretAt(r.tgt, where || "end");
    return true;
  }
  function onKey(cellId, e) {
    var mod = e.ctrlKey || e.metaKey;
    if (e.key === "Tab") { e.preventDefault(); commit(cellId); move(cellId, e.shiftKey ? -1 : 1); return; }
    if (e.key === "Enter" && mod && e.shiftKey) { e.preventDefault(); toggleValidate(cellId); return; }
    if (e.key === "Enter" && !e.shiftKey && !mod && !e.altKey) { e.preventDefault(); commit(cellId); move(cellId, 1); return; }
    if (e.key === "Enter" && e.shiftKey && !mod) {
      e.preventDefault();
      if (doc.execCommand) doc.execCommand("insertLineBreak");
      return;
    }
    if (e.key === "Escape") {
      var r = state.rows[cellId], c = state.byId[cellId];
      if (r && r.dirty && c) { if (r.timer) clearTimeout(r.timer); r.dirty = false; r.tgt.classList.remove("dirty"); showInto(r.tgt, c.targetHtml, c.target); setStatus("Change discarded"); }
      e.target.blur();
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !mod && !e.shiftKey) {
      var edge = caretEdge(e.target);
      if (e.altKey || (e.key === "ArrowDown" && edge.end) || (e.key === "ArrowUp" && edge.start)) {
        e.preventDefault();
        commit(cellId);
        move(cellId, e.key === "ArrowDown" ? 1 : -1);
      }
    }
  }

  function setReadOnly() {
    if (state.readOnly) return;
    state.readOnly = true;
    banner("Read only: editing translations is not allowed for this extension or your role.");
    state.cells.forEach(function (c) { paintRow(c.cellId); });
  }

  function openComments(cellId) {
    aquilla.comments.open(state.fileId, cellId).catch(function (err) { setStatus(errText(err), true); });
  }

  function jumpToChapter(chapter) {
    var first = state.cells.filter(function (c) { return c.chapter === chapter; })[0];
    if (first) reveal(first.cellId, false);
  }
  function reveal(cellId, focus) {
    var r = state.rows[cellId];
    if (!r) { state.pendingReveal = cellId; return false; }
    state.pendingReveal = null;
    if (r.row.scrollIntoView) r.row.scrollIntoView({ block: "center" });
    r.row.classList.remove("flash");
    void r.row.offsetWidth;
    r.row.classList.add("flash");
    if (focus) focusCell(cellId, "end");
    return true;
  }

  // ── Live updates ─────────────────────────────────────────────────────────
  function applyFresh(fresh) {
    fresh.forEach(function (f) {
      var c = state.byId[f.cellId], r = state.rows[f.cellId];
      if (!c || !r) return;
      var changed = f.target !== c.target || (f.targetHtml || null) !== (c.targetHtml || null);
      var editing = r.dirty || r.saving;
      Object.keys(f).forEach(function (k) { c[k] = f[k]; });
      if (changed && editing && f.target !== plainOf(r.tgt)) {
        // Never clobber unsaved typing: offer theirs instead.
        if (!r.remote) {
          r.remote = el("div", { class: "remote", role: "status" }, [
            "Someone else changed this verse.",
            el("button", { type: "button", onclick: function () {
              r.dirty = false; r.tgt.classList.remove("dirty"); if (r.timer) clearTimeout(r.timer);
              showInto(r.tgt, c.targetHtml, c.target); r.remote.remove(); r.remote = null;
            } }, ["Use theirs"]),
          ]);
          r.row.appendChild(r.remote);
        }
        return;
      }
      if (changed && !editing) {
        showInto(r.tgt, c.targetHtml, c.target);
        r.committed = c.target;
        r.row.classList.remove("flash"); void r.row.offsetWidth; r.row.classList.add("flash");
      }
      paintRow(f.cellId);
    });
    refreshProgress();
  }
  aquilla.on("cells.changed", function (e) {
    if (!state.fileId || e.fileId !== state.fileId) return;
    var ids = (e.cellIds || []).filter(function (id) { return state.byId[id]; });
    if (!ids.length) return;
    aquilla.cells.get(state.fileId, ids.slice(0, 500)).then(applyFresh, function (err) { setStatus(errText(err), true); });
  });
  aquilla.on("presence.changed", function (e) {
    if (e.fileId && e.fileId !== state.fileId) return;
    var next = Object.create(null);
    Object.keys(e.holders || {}).forEach(function (id) { next[id] = e.holders[id].username; });
    var touched = Object.keys(next).concat(Object.keys(state.locks));
    state.locks = next;
    touched.forEach(function (id) { paintRow(id); });
  });
  aquilla.on("comments.changed", function () { loadComments(); });
  aquilla.on("editor.reveal", function (e) { if (e.cellId) reveal(e.cellId, true); });

  function loadComments() {
    if (!state.fileId) return;
    aquilla.comments.counts(state.fileId).then(function (counts) {
      var touched = Object.keys(counts || {}).concat(Object.keys(state.comments));
      state.comments = counts || {};
      touched.forEach(function (id) { paintRow(id); });
    }, function () {});
  }
  function loadSide() {
    loadComments();
    aquilla.presence.list(state.fileId).then(function (holders) {
      Object.keys(holders || {}).forEach(function (id) { state.locks[id] = holders[id].username; paintRow(id); });
    }, function () {});
    aquilla.audio.list(state.fileId).then(function (audio) {
      state.audio = audio || {};
      Object.keys(state.audio).forEach(function (id) { paintRow(id); });
    }, function () {});
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function loadPages(cursor, first) {
    return aquilla.cells.page(state.fileId, { cursor: cursor, limit: first ? PAGE_FIRST : PAGE_REST }).then(function (page) {
      appendRows(page.cells || []);
      refreshProgress();
      if (state.pendingReveal) reveal(state.pendingReveal, true);
      if (page.nextCursor) return new Promise(function (res) { later(res, 0); }).then(function () { return loadPages(page.nextCursor, false); });
      return null;
    });
  }

  async function boot() {
    frame();
    try {
      if (!state.fileId) {
        var files = await aquilla.files.list();
        var first = (files || []).filter(function (f) { return f.cellCount > 0; })[0];
        state.fileId = first ? first.fileId : null;
        state.fileName = first ? first.name : "Editor";
        $("file").textContent = state.fileName;
      }
      if (!state.fileId) { $("list").textContent = ""; $("list").appendChild(el("p", { class: "empty", text: "No file to edit yet." })); state.loading = false; return; }
      var savedP = state.pendingReveal ? Promise.resolve(null) : aquilla.storage.get("pos:" + state.fileId).catch(function () { return null; });
      await loadPages(null, true);
      var saved = await savedP;
      state.loading = false;
      refreshProgress();
      refreshChapters();
      if (state.cells.length === 0) { $("list").appendChild(el("p", { class: "empty", text: "This file has no cells." })); return; }
      if (state.pendingReveal) reveal(state.pendingReveal, true);
      else if (typeof saved === "string" && state.rows[saved]) reveal(saved, false);
      loadSide();
    } catch (err) {
      state.loading = false;
      if (isDenied(err)) { banner("This editor was not allowed to read this file."); return; }
      setStatus("Could not load: " + errText(err), true);
    }
  }
  boot();
})();
`
