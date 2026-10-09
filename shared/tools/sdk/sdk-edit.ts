/**
 * Aquilla extension SDK — part 4: TargetEditor, the translation well, edited
 * the way the built-in TranslatedEditor does it: one active cell at a time
 * (the read view becomes the editing surface), autosave after 1.2s idle / on
 * blur / Enter / Tab, Shift+Enter line break, Esc back to the row, ↑/↓ at the
 * edges to the neighbour, B/I/U/S/code via shortcuts and the selection
 * bubble, atomic footnote markers, live presence drafts for collaborators,
 * focus-lock aware, ghost-text suggestions (Tab accepts).
 */
export const SDK_EDIT = String.raw`
  var IDLE_MS = 1200;          // TranslatedEditor COMMIT_IDLE_MS
  var TYPING_MS = 650;         // presence draft cadence
  var SUGGEST_MS = 450;
  var EDS = Object.create(null);   // cellId → its TargetEditor surface

  function ed(id) {
    var read = EDS[id];
    if (!read || !read.isConnected) return null;
    return { read: read, well: read.parentNode, row: read.closest("[data-grid-row]") || read };
  }

  /** The target well for one cell: rich-text read view that becomes the
   *  editor on click/Enter. opts.placeholder: text shown when empty. */
  function TargetEditor(id, opts) {
    opts = opts || {};
    var read = el("div", { class: "read", role: "textbox", "aria-multiline": "true", "data-target-read-view": "", tabindex: "0", spellcheck: "true", "data-ph-mask": "",
      "data-placeholder": opts.placeholder || null });
    var well = el("div", { class: "well", "data-editor-cell-surface": "target", "data-cell-type": "target" }, [read]);
    EDS[id] = read;
    read.addEventListener("mousedown", function (e) { onReadMouseDown(id, e); });
    read.addEventListener("click", function (e) { e.stopPropagation(); onDecoClick(id, e) || activate(id, e); });
    read.addEventListener("keydown", function (e) { onEditorKey(id, e); });
    read.addEventListener("input", function () { onInput(id); });
    read.addEventListener("focus", function () { if (EDS[id] !== read) EDS[id] = read; onEditorFocus(id); });
    read.addEventListener("blur", function () { onEditorBlur(id); });
    read.addEventListener("paste", function (e) { onPaste(id, e); });
    var readKey = null;
    read.__repaint = function () { readKey = null; };
    return bindCell(id, well, function () {
      var c = S.byId[id];
      if (!c) return;
      if (!EDS[id] || !EDS[id].isConnected) EDS[id] = read;
      var st = cellState(id), d = S.drafts[id];
      var targetPlain = st.target, editing = S.activeId === id && EDS[id] === read, lock = st.lock;
      wantTerms(id);
      well.classList.toggle("empty", !(targetPlain || "").trim() && !editing);
      var aria = t("editor.row.translationAria", { ref: cellRef(c), source: (c.source || "").slice(0, 80), state: c.validated ? "validated" : st.hasText ? "draft" : "empty" });
      read.setAttribute("aria-label", lock ? aria + " — " + t("editor.row.lockedBy", { name: lock }) : aria);
      read.setAttribute("aria-readonly", st.editable ? "false" : "true");
      read.setAttribute("data-target-locked-by", lock || "");
      if (lock) read.setAttribute("title", t("editor.row.lockedBy", { name: lock })); else read.removeAttribute("title");
      read.classList.toggle("editable", st.editable);
      read.setAttribute("dir", cfg().targetDirection === "rtl" ? "rtl" : "auto");
      if (!editing) {
        read.setAttribute("contenteditable", "false");
        var peers = peersFor(id);
        var peerDraft = peers.filter(function (p) { return p.draftText !== null && p.draftText !== undefined; })[0];
        var key = [targetPlain, d && d.dirty ? d.html : c.targetHtml, peerDraft ? peerDraft.username + ":" + peerDraft.draftText : "", termKey(id, "target"), issueKey(st.issues, "target"), st.drafting ? 1 : 0].join("\u0001");
        if (key !== readKey) {
          readKey = key;
          if (peerDraft) {
            read.textContent = "";
            read.appendChild(el("span", { class: "remote-draft", "data-remote-presence-draft": "" }, [peerDraft.draftText]));
            read.appendChild(el("span", { class: "rcaret" }, [el("i", { style: { background: peerDraft.color } }), el("b", { style: { background: peerDraft.color }, text: peerDraft.username })]));
          } else if ((targetPlain || "").trim()) {
            showInto(read, d && d.dirty ? d.html : c.targetHtml, targetPlain);
            decorate(read, decorations(id, "target", st.issues));
          } else {
            read.textContent = "";
            read.appendChild(el("span", { "aria-hidden": "true", style: { display: "block", "min-height": "1.6em" } }));
          }
        }
        read.classList.toggle("empty", !(targetPlain || "").trim() && !peerDraft);
        read.tabIndex = st.editable ? 0 : -1;
      } else readKey = null;
      read.classList.toggle("subdued", st.drafting && !!(targetPlain || "").trim());
      // AI overlay (streaming preview / phase pill) + progress
      Array.prototype.forEach.call(well.querySelectorAll(".ai-overlay, .fills"), function (n) { n.remove(); });
      if (st.drafting) {
        var ai = st.ai;
        if (!(targetPlain || "").trim()) {
          var ov = el("div", { class: "ai-overlay", "aria-live": "polite", "aria-busy": "true" });
          if (ai.preview) ov.appendChild(el("p", { dir: "auto" }, [ai.preview, el("span", { class: "ai-caret", "aria-hidden": "true" })]));
          else ov.appendChild(el("div", { class: "ai-pill" }, [ai.phase === "searching" ? t("editor.ai.lookingUpExamples") : t("editor.ai.generatingTranslation")]));
          well.appendChild(ov);
          read.classList.add("subdued");
        }
        well.appendChild(el("div", { class: "fills", role: "progressbar", "aria-label": ai.phase === "searching" ? t("editor.ai.lookingUpExamples") : t("editor.ai.generatingTranslation") }, [el("i")]));
      }
    });
  }
  /** Presence on a cell: peers there, with the focus-lock holder folded in as
   *  editing (the lock is authoritative; the roster can lag it). */
  function peersFor(id) {
    var peers = (S.peersByCell[id] || []).slice(), lock = S.locks[id];
    if (lock) {
      var holder = peers.filter(function (p) { return p.username === lock; })[0];
      if (holder) holder = Object.assign({}, holder, { editing: true });
      peers = peers.filter(function (p) { return p.username !== lock; });
      peers.unshift(holder || { username: lock, color: "#64748b", cellId: id, editing: true, draftText: null, caret: null });
    }
    return peers;
  }

  function activate(id, e, where) {
    var c = S.byId[id];
    if (!c || !editableCell(c)) return false;
    if (S.activeId && S.activeId !== id) deactivate(S.activeId);
    var r = ed(id);
    if (!r) return false;
    S.activeId = id;
    var d = S.drafts[id];
    showInto(r.read, d && d.dirty ? d.html : c.targetHtml, d && d.dirty ? d.value : c.target);
    r.read.__repaint();
    r.read.classList.remove("empty");
    r.read.setAttribute("contenteditable", "true");
    r.read.focus();
    var placed = false;
    if (e && e.clientX !== undefined && doc.caretRangeFromPoint) {
      var range = doc.caretRangeFromPoint(e.clientX, e.clientY);
      if (range && r.read.contains(range.startContainer)) { var sel = doc.getSelection(); sel.removeAllRanges(); sel.addRange(range); placed = true; }
    }
    if (!placed) caretAt(r.read, where || "end");
    // The read view may already hold focus (mousedown focused it before this
    // click activated it), so no focus event follows: claim explicitly.
    onEditorFocus(id);
    notify([id]);
    return true;
  }
  function deactivate(id) {
    var r = ed(id);
    if (S.activeId === id) S.activeId = null;
    hideBubble(); clearGhost(id);
    if (r) { r.read.setAttribute("contenteditable", "false"); r.read.__repaint(); }
    notify([id]);
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
    // Alt/Option+click plays the cell's audio from the host.
    if (e.altKey && S.audio[id] && S.activeId !== id) { e.preventDefault(); aquilla.audio.play(S.fileId, id).catch(noop); }
  }
  function onEditorFocus(id) {
    if (S.activeId !== id || S.claimed === id) return;
    S.claimed = id;
    if (!S.locks[id]) aquilla.presence.claim(S.fileId, id).catch(function (err) { if (isDenied(err)) setReadOnly(); });
    S.focusRowId = id;
    aquilla.storage.set("pos:" + S.fileId, id).catch(noop);
  }
  function onEditorBlur(id) {
    if (S.activeId !== id) return;
    // Leaving to the bubble / a popover keeps the cell active.
    later(function () {
      var r = ed(id);
      if (!r || S.activeId !== id) return;
      if (doc.hasFocus() && (r.read.contains(doc.activeElement) || (bubble && bubble.contains(doc.activeElement)))) return;
      leaveCell(id);
    }, 0);
  }
  function leaveCell(id) {
    commit(id).then(function () { aquilla.cells.settle(S.fileId, id).catch(noop); });
    aquilla.presence.typing(S.fileId, id, null).catch(noop);
    aquilla.presence.release(S.fileId, id).catch(noop);
    if (S.claimed === id) S.claimed = null;
    deactivate(id);
  }
  function onInput(id) {
    var r = ed(id);
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
    emit("cells", [id]);
  }
  function sendTyping(id) {
    var r = ed(id), d = S.drafts[id];
    if (!r || S.activeId !== id || !d) return;
    var sel = doc.getSelection();
    var a = 0, h = 0;
    if (sel && sel.rangeCount && r.read.contains(sel.anchorNode)) { a = offsetOf(r.read, sel.anchorNode, sel.anchorOffset); h = offsetOf(r.read, sel.focusNode, sel.focusOffset); }
    aquilla.presence.typing(S.fileId, id, { anchor: a, head: h, draftText: d.value || "" }).catch(noop);
  }
  /** Save a cell's pending edit through the host's commit pipeline. */
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
        notify([id]);
        return false;
      }
      c.target = value; c.targetHtml = html || null; c.aiDrafted = false;
      delete S.errors[id];
      if (!d.dirty) delete S.drafts[id];
      S.saved[id] = Date.now();
      later(function () { if (S.saved[id] && Date.now() - S.saved[id] >= 2300) { delete S.saved[id]; notify([id]); } }, 2400);
      notify([id]);
      return true;
    }, function (err) {
      d.saving = null;
      d.dirty = true;
      if (isDenied(err)) setReadOnly();
      S.errors[id] = t("extensions.editor.notSaved", { reason: errText(err) });
      notify([id]);
      return false;
    });
    return d.saving;
  }
  /** Replace a cell's whole target (value; html follows) and save it. */
  function writeWhole(id, value, html) {
    var d = S.drafts[id] || (S.drafts[id] = {});
    d.dirty = true; d.value = value; d.html = html !== undefined ? html : plainToHtml(value);
    var r = ed(id);
    if (r) r.read.__repaint();
    notify([id]);
    return commit(id);
  }
  function discardLocal(id) {
    var d = S.drafts[id];
    if (d && d.timer) clearTimeout(d.timer);
    delete S.drafts[id];
    delete S.sig.remote[id];
    var r = ed(id), c = S.byId[id];
    if (r && c && S.activeId === id) { showInto(r.read, c.targetHtml, c.target); caretAt(r.read, "end"); }
    notify([id]);
  }
  function setValidated(id, validated) {
    var c = S.byId[id];
    return commit(id).then(function (ok) {
      if (!ok) return false;
      c._pendingVal = validated;
      notify([id]);
      var call = validated ? aquilla.cells.validate : aquilla.cells.unvalidate;
      return call([{ fileId: S.fileId, cellId: id }]).then(function (res) {
        if (res && res.failed && res.failed.length) { delete c._pendingVal; S.errors[id] = res.failed[0].reason; notify([id]); return false; }
        return true;
      });
    }).catch(function (err) {
      delete c._pendingVal;
      if (isDenied(err) && S.cfg) S.cfg.canValidate = false;
      S.errors[id] = errText(err);
      notify([id]);
      return false;
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
    var r = ed(id);
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
    // Home/End/PageUp/PageDown inside a cell only ever move the caret (the
    // browser would otherwise scroll the whole list at the caret's limit).
    if ((e.key === "End" || e.key === "Home") && !mod) {
      e.preventDefault();
      var hs = doc.getSelection();
      if (hs && hs.modify) hs.modify(e.shiftKey ? "extend" : "move", e.key === "End" ? "forward" : "backward", "lineboundary");
      return;
    }
    if ((e.key === "PageDown" || e.key === "PageUp") && !mod) { e.preventDefault(); return; }
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
  /** Leave this cell and open its neighbour (Tab / arrows at the edges). */
  function move(id, delta, where) {
    var ids = navIds(), i = ids.indexOf(id), next = ids[i + delta];
    if (!next) return;
    leaveCell(id);
    scrollToCell(next, "nearest", false);
    later(function () { if (!activate(next, null, where)) focusRow(next); }, 0);
  }
  /** The next cell with no translation or not yet validated (Ctrl/Cmd+.). */
  function nextUnfinished(fromId) {
    var ids = navIds();
    var from = fromId || S.activeId || S.focusRowId || firstVisibleId();
    var start = Math.max(0, ids.indexOf(from));
    for (var k = 1; k <= ids.length; k++) {
      var id = ids[(start + k) % ids.length], c = S.byId[id];
      if (c && !isStructural(c) && (!(c.target || "").trim() || !c.validated)) return id;
    }
    return null;
  }
  function goNextUnfinished() {
    var id = nextUnfinished();
    if (!id) { toast(t("sdk.allDone")); return null; }
    if (S.activeId) leaveCell(S.activeId);
    scrollToCell(id, "center", true);
    later(function () { if (!activate(id)) focusRow(id); }, 30);
    return id;
  }

  // ── Formatting bubble ────────────────────────────────────────────────────
  var bubble = null;
  function hideBubble() { if (bubble) { bubble.remove(); bubble = null; } }
  function updateBubble() {
    var sel = doc.getSelection();
    var id = S.activeId, r = id && ed(id);
    if (!r || !sel || sel.isCollapsed || !sel.rangeCount || !r.read.contains(sel.anchorNode)) { hideBubble(); return; }
    var rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!bubble) {
      bubble = el("div", { class: "bubble", role: "toolbar", "aria-label": "Formatting", "data-testid": "formatting-bubble-menu" });
      [["bold", "bold", "Bold"], ["italic", "italic", "Italic"], ["underline", "underline", "Underline"], ["strikeThrough", "strikethrough", "Strikethrough"], ["code", "code", "Code"]].forEach(function (b) {
        bubble.appendChild(el("button", { type: "button", "aria-label": b[2], "data-cmd": b[0], onmousedown: function (e) { e.preventDefault(); format(b[0]); later(updateBubble, 0); } }, [icon(b[1], "s35")]));
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
    var r = ed(id);
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
    }, noop);
  }
  function clearGhost(id) { if (ghost && (!id || ghost.id === id)) { if (ghost.node.isConnected) ghost.node.remove(); ghost = null; } }
  function acceptGhost(id) {
    var g = ghost;
    clearGhost(id);
    caretAt(ed(id).read, "end");
    doc.execCommand("insertText", false, g.text);
    aquilla.suggestions.feedback(S.fileId, id, g.sid, true).catch(noop);
  }
  function rejectGhost(id) {
    var g = ghost;
    clearGhost(id);
    aquilla.suggestions.feedback(S.fileId, id, g.sid, false).catch(noop);
  }
  /** The best suggestion for a cell's next words (null when none). */
  function suggestNext(id, prefix) {
    var c = S.byId[id];
    return aquilla.suggestions.get(S.fileId, id, prefix !== undefined ? prefix : (c && c.target) || "").then(function (list) { return list && list[0] ? list[0] : null; }, function () { return null; });
  }

`
