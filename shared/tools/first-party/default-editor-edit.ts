/**
 * First-party editor extension — part 4/5: editing, as TranslatedEditor does
 * it: one active cell at a time (the read view becomes the editing surface),
 * commit after 1.2s idle / on blur / Enter / Tab, Shift+Enter line break,
 * Esc back to the row, ↑/↓ at the edges to the neighbour, B/I/U/S/code via
 * the shortcuts and the selection bubble, atomic footnote markers, live
 * presence drafts for collaborators, and ghost-text suggestions (Tab accepts).
 * Plus row-level keys (j/k, arrows, Enter) and Ctrl/Cmd+. "next unfinished".
 */
export const EDITOR_EDIT = String.raw`
  function activate(id, e, where) {
    var c = S.byId[id];
    if (!c || !editableCell(c)) return false;
    if (S.activeId && S.activeId !== id) deactivate(S.activeId);
    var r = R(id);
    if (!r) return false;
    S.activeId = id;
    var d = S.drafts[id];
    showInto(r.read, d && d.dirty ? d.html : c.targetHtml, d && d.dirty ? d.value : c.target);
    r.readKey = null;
    r.read.classList.remove("empty");
    r.read.setAttribute("contenteditable", "true");
    r.read.focus();
    var placed = false;
    if (e && e.clientX !== undefined && doc.caretRangeFromPoint) {
      var range = doc.caretRangeFromPoint(e.clientX, e.clientY);
      if (range && r.read.contains(range.startContainer)) { var sel = doc.getSelection(); sel.removeAllRanges(); sel.addRange(range); placed = true; }
    }
    if (!placed) caretAt(r.read, where || "end");
    paintCell(id);
    return true;
  }
  function deactivate(id) {
    var r = R(id);
    if (S.activeId === id) S.activeId = null;
    hideBubble(); clearGhost(id);
    if (!r) return;
    r.read.setAttribute("contenteditable", "false");
    r.readKey = null;
    paintCell(id);
  }
  function caretAt(node, where) {
    var sel = doc.getSelection ? doc.getSelection() : null;
    if (!sel) return;
    var range = doc.createRange();
    range.selectNodeContents(node);
    range.collapse(where === "start");
    sel.removeAllRanges();
    sel.addRange(range);
  }
  function caretEdge(node) {
    var sel = doc.getSelection ? doc.getSelection() : null;
    if (!sel || sel.rangeCount === 0) return { start: true, end: true, collapsed: true };
    var r = sel.getRangeAt(0);
    var before = doc.createRange(); before.selectNodeContents(node); before.setEnd(r.startContainer, r.startOffset);
    var after = doc.createRange(); after.selectNodeContents(node); after.setStart(r.endContainer, r.endOffset);
    var rect = r.getBoundingClientRect ? r.getBoundingClientRect() : null, box = node.getBoundingClientRect();
    var firstLine = !rect || !rect.height || rect.top - box.top < 26, lastLine = !rect || !rect.height || box.bottom - rect.bottom < 26;
    return { start: !before.toString().length, end: !after.toString().replace(/\s+$/, "").length, collapsed: r.collapsed, firstLine: firstLine, lastLine: lastLine };
  }

  function onReadMouseDown(id, e) {
    // Alt/Option+click a word seeks the cell's audio in the built-in; the frame
    // has no media element, so it plays the cell's audio from the host.
    if (e.altKey && S.audio[id] && S.activeId !== id) { e.preventDefault(); aquilla.audio.play(S.fileId, id).catch(function () {}); }
  }
  function onEditorFocus(id) {
    if (S.activeId !== id) return;
    if (!S.locks[id]) aquilla.presence.claim(S.fileId, id).catch(function (err) { if (isDenied(err)) setReadOnly(); });
    S.focusRowId = id;
    aquilla.storage.set("pos:" + S.fileId, id).catch(function () {});
  }
  function onEditorBlur(id) {
    if (S.activeId !== id) return;
    // Leaving to the bubble / a popover keeps the cell active.
    later(function () {
      var r = R(id);
      if (!r || S.activeId !== id) return;
      if (r.read.contains(doc.activeElement) || (bubble && bubble.contains(doc.activeElement))) return;
      leaveCell(id);
    }, 0);
  }
  function leaveCell(id) {
    commit(id).then(function () {
      aquilla.cells.settle(S.fileId, id).catch(function () {});
    });
    aquilla.presence.typing(S.fileId, id, null).catch(function () {});
    aquilla.presence.release(S.fileId, id).catch(function () {});
    deactivate(id);
  }

  function onInput(id) {
    var r = R(id);
    if (!r || S.activeId !== id) return;
    clearGhost(id);
    var d = S.drafts[id] || (S.drafts[id] = {});
    d.dirty = true;
    d.value = plainOf(r.read);
    d.html = htmlOf(r.read);
    delete S.saved[id];
    if (d.timer) clearTimeout(d.timer);
    d.timer = later(function () { d.timer = null; commit(id); }, IDLE_MS);
    if (d.typingTimer) clearTimeout(d.typingTimer);
    d.typingTimer = later(function () { d.typingTimer = null; sendTyping(id); }, TYPING_MS);
    if (d.suggestTimer) clearTimeout(d.suggestTimer);
    d.suggestTimer = later(function () { d.suggestTimer = null; suggest(id); }, SUGGEST_MS);
    updateBubble();
  }
  function sendTyping(id) {
    var r = R(id), d = S.drafts[id];
    if (!r || S.activeId !== id || !d) return;
    var sel = doc.getSelection();
    var a = 0, h = 0;
    if (sel && sel.rangeCount && r.read.contains(sel.anchorNode)) { a = offsetOf(r.read, sel.anchorNode, sel.anchorOffset); h = offsetOf(r.read, sel.focusNode, sel.focusOffset); }
    aquilla.presence.typing(S.fileId, id, { anchor: a, head: h, draftText: d.value || "" }).catch(function () {});
  }

  function commit(id) {
    var d = S.drafts[id], c = S.byId[id];
    if (!d || !d.dirty || !c) return Promise.resolve(true);
    if (d.timer) { clearTimeout(d.timer); d.timer = null; }
    if (d.saving) return d.saving.then(function () { return commit(id); });
    var value = d.value, html = d.html;
    d.dirty = false;
    d.saving = aquilla.cells.commit([{ fileId: S.fileId, cellId: id, value: value, html: html }]).then(function (res) {
      d.saving = null;
      if (res && res.failed && res.failed.length) {
        d.dirty = true;
        S.errors[id] = t("extensions.editor.notSaved", { reason: res.failed[0].reason });
        paintCell(id);
        return false;
      }
      c.target = value; c.targetHtml = html || null; c.aiDrafted = false;
      delete S.errors[id];
      if (!d.dirty) delete S.drafts[id];
      S.saved[id] = Date.now();
      later(function () { if (S.saved[id] && Date.now() - S.saved[id] >= 2300) { delete S.saved[id]; if (V.mounted[id]) paintCell(id); } }, 2400);
      if (V.mounted[id]) paintCell(id);
      return true;
    }, function (err) {
      d.saving = null;
      d.dirty = true;
      if (isDenied(err)) setReadOnly();
      S.errors[id] = t("extensions.editor.notSaved", { reason: errText(err) });
      paintCell(id);
      return false;
    });
    return d.saving;
  }
  function discardLocal(id) {
    var d = S.drafts[id];
    if (d && d.timer) clearTimeout(d.timer);
    delete S.drafts[id];
    delete S.sig.remote[id];
    var r = R(id), c = S.byId[id];
    if (r && c && S.activeId === id) { showInto(r.read, c.targetHtml, c.target); caretAt(r.read, "end"); }
    paintCell(id);
  }

  function setValidated(id, validated) {
    var c = S.byId[id];
    commit(id).then(function (ok) {
      if (!ok) return;
      c._pendingVal = validated;
      paintCell(id);
      var call = validated ? aquilla.cells.validate : aquilla.cells.unvalidate;
      return call([{ fileId: S.fileId, cellId: id }]).then(function (res) {
        if (res && res.failed && res.failed.length) { delete c._pendingVal; S.errors[id] = res.failed[0].reason; paintCell(id); }
      });
    }).catch(function (err) {
      delete c._pendingVal;
      if (isDenied(err)) { S.cfg.canValidate = false; }
      S.errors[id] = errText(err);
      paintCell(id);
    });
  }

  // ── Keys ─────────────────────────────────────────────────────────────────
  function onEditorKey(id, e) {
    if (S.activeId !== id) {
      if ((e.key === "Enter" || e.key === " ") && !e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopPropagation(); activate(id); }
      return;
    }
    e.stopPropagation();
    var mod = e.ctrlKey || e.metaKey;
    var r = R(id);
    if (e.key === "Tab" && ghost && ghost.id === id) { e.preventDefault(); acceptGhost(id); return; }
    if (e.key === "Tab") { e.preventDefault(); move(id, e.shiftKey ? -1 : 1, e.shiftKey ? "end" : "start"); return; }
    if (e.key === "Escape") {
      e.preventDefault();
      if (ghost && ghost.id === id) { rejectGhost(id); return; }
      leaveCell(id); r.row.focus(); return;
    }
    if (e.key === "Enter" && !e.shiftKey && !mod && !e.altKey) { e.preventDefault(); leaveCell(id); r.row.focus(); return; }
    if (e.key === "Enter" && e.shiftKey && !mod) { e.preventDefault(); doc.execCommand("insertLineBreak"); return; }
    if (mod && !e.shiftKey && (e.key === "b" || e.key === "i" || e.key === "u")) { e.preventDefault(); format(e.key === "b" ? "bold" : e.key === "i" ? "italic" : "underline"); return; }
    if (mod && e.shiftKey && (e.key === "x" || e.key === "X" || e.key === "s" || e.key === "S")) { e.preventDefault(); format("strikeThrough"); return; }
    if (mod && (e.key === "e" || e.key === "E")) { e.preventDefault(); format("code"); return; }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !mod && !e.shiftKey && !e.altKey) {
      var edge = caretEdge(r.read);
      if (e.key === "ArrowDown" && edge.collapsed && edge.lastLine) { e.preventDefault(); move(id, 1, "start"); return; }
      if (e.key === "ArrowUp" && edge.collapsed && edge.firstLine) { e.preventDefault(); move(id, -1, "end"); return; }
    }
    // Footnote markers are atomic: Backspace/Delete next to one asks first.
    if ((e.key === "Backspace" || e.key === "Delete") && !mod) {
      var sel = doc.getSelection();
      if (sel && sel.rangeCount && sel.isCollapsed) {
        var n = adjacentFootnote(sel, e.key === "Backspace");
        if (n) {
          e.preventDefault();
          if (n.classList.contains("confirm")) { n.remove(); onInput(id); }
          else { n.classList.add("confirm"); n.style.outline = "2px solid var(--destructive)"; toast(t("editor.footnotes.deletePrompt", { label: n.textContent })); }
          return;
        }
      }
    }
    if (e.key === "ArrowRight" && ghost && ghost.id === id && caretEdge(r.read).end) { e.preventDefault(); acceptGhost(id); }
  }
  function adjacentFootnote(sel, backwards) {
    var node = sel.anchorNode, off = sel.anchorOffset, cand = null;
    if (node.nodeType === 3) {
      if (backwards && off === 0) cand = node.previousSibling;
      if (!backwards && off === node.nodeValue.length) cand = node.nextSibling;
    } else cand = node.childNodes[backwards ? off - 1 : off];
    return cand && cand.nodeType === 1 && cand.hasAttribute("data-usfm-footnote") ? cand : null;
  }
  function format(cmd) {
    if (cmd === "code") {
      var sel = doc.getSelection();
      if (!sel || sel.isCollapsed) return;
      var range = sel.getRangeAt(0);
      var inCode = range.commonAncestorContainer.parentElement && range.commonAncestorContainer.parentElement.closest("code");
      if (inCode) { var p = inCode.parentNode; while (inCode.firstChild) p.insertBefore(inCode.firstChild, inCode); inCode.remove(); }
      else { var code = doc.createElement("code"); code.appendChild(range.extractContents()); range.insertNode(code); }
    } else doc.execCommand(cmd);
    if (S.activeId) onInput(S.activeId);
  }
  function onPaste(id, e) {
    // Paste as plain text: foreign markup never enters a cell.
    var text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
    if (!text) return;
    e.preventDefault();
    doc.execCommand("insertText", false, text);
  }

  // Editable rows in document order (structural rows with no source skip).
  function navIds() { return S.ids.filter(function (x) { var c = S.byId[x]; return c && ((c.source || "").trim() || !isStructural(c)); }); }
  function move(id, delta, where) {
    var ids = navIds(), i = ids.indexOf(id), next = ids[i + delta];
    if (!next) return;
    leaveCell(id);
    scrollToCell(next, "nearest", false);
    later(function () { if (!activate(next, null, where)) { var r = R(next); if (r) r.row.focus(); } }, 0);
  }
  function onRowFocus(id) {
    if (S.focusRowId !== id) { S.focusRowId = id; aquilla.presence.view(S.fileId, id).catch(function () {}); }
  }
  function onRowKey(id, e) {
    if (e.target !== R(id).row) return;
    var k = e.key;
    if (k === "ArrowDown" || k === "j" || k === "ArrowUp" || k === "k") {
      e.preventDefault();
      var ids = navIds(), i = ids.indexOf(id), next = ids[i + (k === "ArrowDown" || k === "j" ? 1 : -1)];
      if (next) { scrollToCell(next, "nearest", false); later(function () { var r = R(next); if (r) r.row.focus(); }, 0); }
    } else if (k === "Enter") { e.preventDefault(); activate(id); }
    else if (k === "Escape" && S.selCount) { e.preventDefault(); clearSelection(); }
  }
  /** Ctrl/Cmd+. — the next cell with no translation or not yet validated. */
  function nextUnfinished() {
    var ids = navIds();
    var from = S.activeId || S.focusRowId || firstVisibleId();
    var start = Math.max(0, ids.indexOf(from));
    for (var k = 1; k <= ids.length; k++) {
      var id = ids[(start + k) % ids.length], c = S.byId[id];
      if (c && !isStructural(c) && (!(c.target || "").trim() || !c.validated)) {
        if (S.activeId) leaveCell(S.activeId);
        scrollToCell(id, "center", true);
        later(function () { if (!activate(id)) { var r = R(id); if (r) r.row.focus(); } }, 30);
        return;
      }
    }
    toast(FALLBACK["all-done"]);
  }
  doc.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "." && !e.shiftKey && !e.altKey) { e.preventDefault(); nextUnfinished(); }
    else if (e.key === "Escape" && S.selCount && !S.activeId && !openPop) clearSelection();
  });

  // ── Formatting bubble (TE formatting-bubble-menu) ────────────────────────
  var bubble = null;
  function hideBubble() { if (bubble) { bubble.remove(); bubble = null; } }
  function updateBubble() {
    var sel = doc.getSelection();
    var id = S.activeId, r = id && R(id);
    if (!r || !sel || sel.isCollapsed || !sel.rangeCount || !r.read.contains(sel.anchorNode)) { hideBubble(); return; }
    var rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!bubble) {
      bubble = el("div", { class: "bubble", role: "toolbar", "aria-label": "Formatting", "data-testid": "formatting-bubble-menu" });
      [["bold", "bold", "Bold"], ["italic", "italic", "Italic"], ["underline", "underline", "Underline"], ["strikeThrough", "strikethrough", "Strikethrough"], ["code", "code", "Code"]].forEach(function (b) {
        var btn = el("button", { type: "button", "aria-label": b[2], "data-cmd": b[0], onmousedown: function (e) { e.preventDefault(); format(b[0]); later(updateBubble, 0); } }, [icon(b[1], "s35")]);
        bubble.appendChild(btn);
      });
      doc.body.appendChild(bubble);
    }
    Array.prototype.forEach.call(bubble.children, function (b) {
      var cmd = b.getAttribute("data-cmd");
      var on = cmd === "code" ? !!(sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest("code")) : doc.queryCommandState(cmd);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    var w = bubble.offsetWidth || 140;
    bubble.style.left = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, innerWidth - w - 8)) + "px";
    bubble.style.top = Math.max(8, rect.top - 36) + "px";
  }
  doc.addEventListener("selectionchange", function () { if (S.activeId) updateBubble(); });

  // ── Ghost text (aquilla.suggestions — any registered provider) ───────────
  var ghost = null;
  function suggest(id) {
    var r = R(id);
    if (!r || S.activeId !== id) return;
    var edge = caretEdge(r.read);
    if (!edge.collapsed || !edge.end) return;
    var prefix = plainOf(r.read);
    aquilla.suggestions.get(S.fileId, id, prefix).then(function (list) {
      if (S.activeId !== id || !list || !list.length || plainOf(r.read) !== prefix) return;
      clearGhost(id);
      var g = el("span", { class: "ghost", contenteditable: "false", "data-ghost": list[0].id, "aria-hidden": "true" }, [list[0].text, el("kbd", { class: "ghost-hint", text: "Tab" })]);
      r.read.appendChild(g);
      ghost = { id: id, sid: list[0].id, text: list[0].text, node: g };
      var sel = doc.getSelection();
      var range = doc.createRange(); range.setStartBefore(g); range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range);
    }, function () {});
  }
  function clearGhost(id) { if (ghost && (!id || ghost.id === id)) { if (ghost.node.isConnected) ghost.node.remove(); ghost = null; } }
  function acceptGhost(id) {
    var g = ghost;
    clearGhost(id);
    caretAt(R(id).read, "end");
    doc.execCommand("insertText", false, g.text);
    aquilla.suggestions.feedback(S.fileId, id, g.sid, true).catch(function () {});
  }
  function rejectGhost(id) {
    var g = ghost;
    clearGhost(id);
    aquilla.suggestions.feedback(S.fileId, id, g.sid, false).catch(function () {});
  }

  // ── Footnotes ────────────────────────────────────────────────────────────
  function footnoteLine(id) {
    var c = S.byId[id];
    var box = el("div", { class: "fnline", "data-testid": "footnote-inline" });
    var src = c.footnotes.source, tgt = c.footnotes.target;
    var n = Math.max(src.length, tgt.length);
    for (var i = 0; i < n; i++) (function (i) {
      var s = src[i], tg = tgt[i];
      var label = String(i + 1);
      var v = el("span", { class: "v" + (tg && tg.text ? "" : " empty"), role: "button", tabindex: "0", title: t("editor.footnotes.clickToEdit"),
        text: tg && tg.text ? tg.text : (s ? t("editor.footnotes.addTranslation") : t("editor.footnotes.emptyTarget")) });
      if (editableCell(c)) v.addEventListener("click", function (e) { e.stopPropagation(); editFootnote(id, i, v); });
      box.appendChild(el("div", { class: "fni" }, [el("span", { class: "k", text: label }), s ? el("span", { class: "muted", style: { "flex": "1", "min-width": "0" }, text: s.text }) : null, v]));
    })(i);
    return box;
  }
  function rawFootnotes(text) { var out = [], m; FN_RE.lastIndex = 0; while ((m = FN_RE.exec(text || ""))) out.push({ raw: m[0], index: m.index }); return out; }
  function makeFootnote(caller, ref, text) {
    var clean = String(text).replace(/\\f\*?|\\/g, "").trim();
    return "\\f " + (caller || "+") + (ref ? " \\fr " + ref : "") + " \\ft " + clean + "\\f*";
  }
  function editFootnote(id, i, anchor) {
    var c = S.byId[id];
    var fns = rawFootnotes(c.target);
    var cur = fns[i];
    var ta = el("textarea", { rows: "3", placeholder: t("editor.footnotes.editPlaceholder"), "aria-label": t("editor.footnotes.translationLabel") });
    ta.value = cur ? fnText(cur.raw) : "";
    var box = el("div", { class: "menu", style: { width: "300px", padding: "10px" } }, [el("div", { class: "k", style: { "font-size": "12px", "margin-bottom": "6px" }, text: t("editor.footnotes.editLabel") }), ta,
      el("div", { class: "actions", style: { display: "flex", gap: "6px", "margin-top": "8px", "justify-content": "flex-end" } }, [
        cur ? el("button", { class: "btn-s danger", type: "button", onclick: function () { closePop(); spliceFootnote(id, i, null); } }, [icon("trash-2", "s3"), t("common.delete")]) : null,
        el("button", { class: "btn-s primary", type: "button", onclick: function () { closePop(); spliceFootnote(id, i, ta.value); } }, [t("common.save")]),
      ])]);
    popover(anchor, box, { side: "bottom", align: "start" });
    ta.focus();
  }
  function spliceFootnote(id, i, text) {
    var c = S.byId[id];
    var value = c.target || "", fns = rawFootnotes(value), cur = fns[i];
    var srcRaw = rawFootnotes(c.source)[i];
    var next;
    if (cur) {
      next = text === null ? value.slice(0, cur.index) + value.slice(cur.index + cur.raw.length)
        : value.slice(0, cur.index) + makeFootnote(fnCaller(cur.raw), "", text) + value.slice(cur.index + cur.raw.length);
    } else {
      if (text === null || !text.trim()) return;
      next = value + makeFootnote(srcRaw ? fnCaller(srcRaw.raw) : "+", "", text);
    }
    writeWhole(id, next);
  }
  /** Replace a cell's whole target (footnote edits): plain, html follows. */
  function writeWhole(id, value) {
    var d = S.drafts[id] || (S.drafts[id] = {});
    d.dirty = true; d.value = value; d.html = plainToHtml(value);
    commit(id);
    paintCell(id);
  }
  function addFootnote(id) {
    var c = S.byId[id];
    var ta = el("textarea", { rows: "3", placeholder: t("editor.footnote.textPlaceholder"), "aria-label": t("editor.footnote.textLabel") });
    var lettered = el("input", { type: "checkbox" });
    dialog(t("editor.footnote.add"), [
      el("p", { text: t("editor.footnote.attachedTo", { ref: cellRef(c) }) }),
      el("label", { text: t("editor.footnote.textLabel") }), ta,
      el("label", { class: "chk" }, [lettered, t("editor.footnote.markerLettered")]),
    ], [
      { label: t("common.cancel") },
      { label: t("editor.footnote.add"), primary: true, run: function () {
        if (!ta.value.trim()) return;
        var existing = rawFootnotes(c.target).length;
        var caller = lettered.checked ? String.fromCharCode(97 + (existing % 26)) : "+";
        writeWhole(id, (c.target || "") + makeFootnote(caller, c.ref ? c.ref.replace(/^\S+\s+/, "") : "", ta.value));
      } },
    ]);
  }
  function openFootnoteCard(anchor, id, chip) {
    var raw = chip.getAttribute("data-usfm-footnote");
    popover(anchor, el("div", { class: "menu", style: { "max-width": "280px", padding: "8px 10px", "font-size": "13px" } }, [fnText(raw) || t("editor.footnotes.emptyNote")]), { side: "bottom", align: "start" });
  }
`
