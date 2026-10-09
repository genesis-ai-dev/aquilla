/**
 * First-party editor extension — part 5/5: AI drafting (single, regenerate,
 * paragraph, drag-across batch), multi-select (feeds the host's selection
 * bar), the cell-details expansion (health, back-translation, footnotes,
 * issues), live data (cells, signals, presence, comments, audio, config) and
 * boot.
 */
export const EDITOR_FEATURES = String.raw`
  // ── AI drafting (TargetDraftActions) ─────────────────────────────────────
  var skipReplaceConfirm = false;
  function requestDraft(id) {
    var c = S.byId[id];
    if (!S.cfg.ai.configured) { draft([id], false); return; }   // host opens AI setup
    if ((c.target || "").trim()) {
      if (!c.validated && skipReplaceConfirm) { draft([id], false); return; }
      var dont = el("input", { type: "checkbox" });
      dialog(c.validated ? FALLBACK["replace-validated-title"] : FALLBACK["replace-title"], [
        el("p", { text: c.validated ? FALLBACK["replace-validated-desc"] : FALLBACK["replace-desc"] }),
        c.validated ? null : el("label", { class: "chk" }, [dont, t("workspace.generateOverwrite.dontAskAgain")]),
      ].filter(Boolean), [
        { label: t("common.cancel") },
        { label: FALLBACK["replace"], primary: true, run: function () {
          if (dont.checked) { skipReplaceConfirm = true; aquilla.storage.set("skipReplaceConfirm", true).catch(function () {}); }
          draft([id], false);
        } },
      ]);
      return;
    }
    draft([id], false);
  }
  function draft(ids, regenerate) {
    ids.forEach(function (id) { delete S.errors[id]; });
    return aquilla.ai.draft(S.fileId, ids, { regenerate: regenerate }).catch(function (err) {
      if (err && err.code === "ai_not_configured") return;
      ids.forEach(function (id) { S.errors[id] = errText(err); if (V.mounted[id]) paintCell(id); });
    });
  }
  function confirmParagraph(id) {
    var p = S.byId[id].paragraph;
    dialog(t("editor.paragraph.confirmTitle"), [
      el("p", { text: p.draftable >= p.size ? t("editor.paragraph.confirmAll", { total: p.size }) : t("editor.paragraph.confirmPartial", { draftable: p.draftable, total: p.size }) }),
    ], [
      { label: t("common.cancel") },
      { label: t("editor.paragraph.confirmAction"), primary: true, run: function () {
        aquilla.ai.draftParagraph(S.fileId, id).catch(function (err) { S.errors[id] = errText(err); paintCell(id); });
      } },
    ]);
  }
  // Drag across Sparkles buttons → one batch (EditorTable onCompleteBatch).
  var sparkDrag = null;
  function onSparkDragStart(id, e) { if (e.button === 0) sparkDrag = { ids: [id] }; }
  function onSparkDragEnter(id) { if (sparkDrag && sparkDrag.ids.indexOf(id) < 0) { sparkDrag.ids.push(id); var r = R(id); if (r) r.row.classList.add("selected"); } }
  doc.addEventListener("mouseup", function () {
    if (!sparkDrag) return;
    var ids = sparkDrag.ids;
    sparkDrag = null;
    if (ids.length > 1) { ids.forEach(function (x) { if (V.mounted[x]) paintCell(x); }); draft(ids, false); }
  });

  // ── Multi-select (row select box; drives the host's selection bar) ───────
  function pushSelection() {
    S.selCount = Object.keys(S.selection).length;
    aquilla.selection.set(S.fileId, Object.keys(S.selection)).catch(function () {});
  }
  function toggleSelect(id) {
    if (S.selection[id]) delete S.selection[id]; else S.selection[id] = 1;
    S.selAnchor = id;
    paintCell(id);
    pushSelection();
  }
  function clearSelection() {
    var was = Object.keys(S.selection);
    S.selection = Object.create(null);
    was.forEach(function (x) { if (V.mounted[x]) paintCell(x); });
    pushSelection();
  }
  function selectRange(a, b) {
    var ids = navIds(), i = ids.indexOf(a), j = ids.indexOf(b);
    if (i < 0 || j < 0) return;
    var lo = Math.min(i, j), hi = Math.max(i, j), touched = Object.keys(S.selection);
    S.selection = Object.create(null);
    for (var k = lo; k <= hi; k++) S.selection[ids[k]] = 1;
    touched.concat(ids.slice(lo, hi + 1)).forEach(function (x) { if (V.mounted[x]) paintCell(x); });
  }
  function onSelectPointerDown(id, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    if (e.shiftKey && S.selAnchor) { selectRange(S.selAnchor, id); pushSelection(); return; }
    if (e.metaKey || e.ctrlKey) { toggleSelect(id); return; }
    var startSel = !S.selection[id];
    var anchor = id;
    if (startSel) { S.selection[id] = 1; } else delete S.selection[id];
    S.selAnchor = id;
    paintCell(id);
    var sc = $("scroller"), autoTimer = null, lastY = e.clientY;
    function over(y) {
      var hit = doc.elementFromPoint(e.clientX, y);
      var cell = hit && hit.closest && hit.closest(".cell");
      var other = cell && cell.getAttribute("data-cell-id");
      if (other && other !== anchor && startSel) selectRange(anchor, other);
    }
    function onMove(ev) {
      lastY = ev.clientY;
      over(ev.clientY);
      var r = sc.getBoundingClientRect();
      if (!autoTimer && (ev.clientY < r.top + 40 || ev.clientY > r.bottom - 40)) {
        autoTimer = setInterval(function () {
          var rr = sc.getBoundingClientRect();
          sc.scrollTop += lastY < rr.top + 40 ? -18 : lastY > rr.bottom - 40 ? 18 : 0;
          over(lastY);
        }, 30);
      }
    }
    function onUp() {
      if (autoTimer) clearInterval(autoTimer);
      doc.removeEventListener("pointermove", onMove);
      doc.removeEventListener("pointerup", onUp);
      pushSelection();
    }
    doc.addEventListener("pointermove", onMove);
    doc.addEventListener("pointerup", onUp);
  }

  // ── Cell details (CellExpansion) ─────────────────────────────────────────
  function toggleExpand(id) {
    if (S.expanded[id]) delete S.expanded[id]; else S.expanded[id] = 1;
    var r = R(id);
    if (!S.expanded[id] && r) { r.exp.hidden = true; r.exp.textContent = ""; }
    paintCell(id);
    if (S.expanded[id] && !S.bts[id] && S.cfg.backtranslation.configured) loadBts();
  }
  function paintExpansion(id) {
    var c = S.byId[id], r = R(id);
    var issues = (S.signals.issues || {})[id] || [];
    var bt = S.bts[id];
    var tabs = [
      { key: "health", icon: "activity", label: t("editor.expansion.retrievalSupport") },
      { key: "bt", icon: "file-text", label: t("editor.bt.label"), dot: bt && bt.stale ? "amber" : null },
    ];
    if (S.cfg.footnotes === "off" && c.footnotes && (c.footnotes.source.length || c.footnotes.target.length)) tabs.push({ key: "fn", icon: "notebook-pen", label: t("editor.footnotes.label") });
    var live = issues.filter(function (i) { return !i.waived; });
    tabs.push({ key: "issues", icon: "triangle-alert", label: t("editor.expansion.issues"), dot: live.some(function (i) { return i.severity === "error"; }) ? "red" : live.length ? "amber" : null, disabled: !issues.length });
    var cur = S.expTab[id] && tabs.some(function (x) { return x.key === S.expTab[id] && !x.disabled; }) ? S.expTab[id] : (live.length ? "issues" : bt && bt.stale ? "bt" : "health");
    S.expTab[id] = cur;
    var bar = el("div", { class: "tabs", role: "tablist" });
    tabs.forEach(function (tb, k) {
      var b = el("button", { class: "tab", type: "button", role: "tab", "aria-selected": tb.key === cur ? "true" : "false", tabindex: tb.key === cur ? "0" : "-1",
        onclick: function () { S.expTab[id] = tb.key; paintExpansion(id); } }, [icon(tb.icon, "s3"), tb.label, tb.dot ? el("span", { class: "dot " + tb.dot }) : null]);
      if (tb.disabled) b.disabled = true;
      b.addEventListener("keydown", function (e) {
        var en = tabs.filter(function (x) { return !x.disabled; });
        var at = en.map(function (x) { return x.key; }).indexOf(cur);
        var to = e.key === "ArrowRight" ? en[(at + 1) % en.length] : e.key === "ArrowLeft" ? en[(at - 1 + en.length) % en.length] : e.key === "Home" ? en[0] : e.key === "End" ? en[en.length - 1] : null;
        if (to) { e.preventDefault(); S.expTab[id] = to.key; paintExpansion(id); var nb = R(id).exp.querySelector('[aria-selected="true"]'); if (nb) nb.focus(); }
        if (e.key === "Escape") { e.preventDefault(); toggleExpand(id); R(id).row.focus(); }
      });
      void k;
      bar.appendChild(b);
    });
    var panel = el("div", { class: "panel", role: "tabpanel" });
    if (cur === "health") {
      var rb = c.ribbon;
      panel.appendChild(el("p", { style: { "font-weight": "500" }, text: rb ? rb.label : t("editor.expansion.retrievalSupport") }));
      if (c.validated) panel.appendChild(el("p", { class: "k", text: live.length ? t("editor.assurance.validatedWithInfractions") : t("editor.assurance.validatedClean") }));
      else if (rb && rb.score !== null) panel.appendChild(el("p", { class: "k", text: rb.score < 50 ? t("editor.assurance.lowerSupport") : t("editor.assurance.betterSupport") }));
    } else if (cur === "bt") {
      panel.appendChild(btPanel(id));
    } else if (cur === "fn") {
      panel.appendChild(footnoteLine(id));
    } else if (cur === "issues") {
      if (!issues.length) panel.appendChild(el("p", { class: "k", text: t("editor.issues.none") }));
      issues.forEach(function (i) {
        panel.appendChild(el("div", { class: "issue " + (i.severity === "error" ? "major" : "minor") + (i.waived ? " waived" : "") }, [
          icon("triangle-alert", "s35"),
          el("div", { class: "b" }, [el("b", { text: i.ruleName }), el("span", { class: "k", text: i.message + (i.waived ? " · " + t("editor.issues.waived") : "") })]),
          el("button", { class: "btn-s", type: "button", onclick: function () { aquilla.rules.open(S.fileId, id, i.ruleId).catch(function () {}); } }, [FALLBACK["open-rule"]]),
        ]));
      });
    }
    r.exp.textContent = "";
    r.exp.appendChild(el("div", { class: "exp-in", "data-testid": "cell-expansion" }, [bar, panel]));
    r.exp.hidden = false;
  }
  function btPanel(id) {
    var c = S.byId[id], bt = S.bts[id];
    var busy = (S.signals.backtranslating || []).indexOf(id) >= 0;
    var box = el("div", {});
    if (!(c.target || "").trim()) { box.appendChild(el("p", { class: "k", text: t("editor.bt.translateFirst") })); return box; }
    if (bt && bt.error) box.appendChild(el("p", { style: { color: "var(--destructive)" }, text: t("editor.bt.failed") + ": " + bt.error }));
    if (bt && bt.text) {
      box.appendChild(el("p", { class: "k", text: (bt.polished ? t("editor.bt.originAi") : t("editor.bt.originCorrected")) + (bt.stale ? "" : " · " + t("editor.bt.freshLabel")) }));
      if (bt.stale) box.appendChild(el("p", { style: { color: "var(--aq-amber-600)" }, text: t("editor.bt.staleWarning") }));
      var ta = el("textarea", { "aria-label": t("editor.bt.editTooltip") });
      ta.value = bt.text;
      box.appendChild(ta);
      box.appendChild(el("div", { class: "actions" }, [
        el("button", { class: "btn-s", type: "button", onclick: function () { aquilla.backtranslation.save(S.fileId, id, ta.value).then(function () { toast(t("common.saved")); }, function (err) { toast(errText(err)); }); } }, [icon("pencil", "s3"), t("common.save")]),
        S.cfg.backtranslation.configured ? el("button", { class: "btn-s", type: "button", disabled: busy || null, "aria-label": t("editor.bt.regenerateAria"),
          onclick: function () { runBt(id); } }, [icon(busy ? "loader-circle" : "refresh-cw", busy ? "s3 spin" : "s3"), busy ? t("editor.bt.readingItBack") : t("editor.bt.regenerateTooltip")]) : null,
      ]));
    } else if (S.cfg.backtranslation.configured) {
      box.appendChild(el("p", { class: "k", text: t("editor.bt.emptyPitch") }));
      box.appendChild(el("div", { class: "actions" }, [el("button", { class: "btn-s primary", type: "button", disabled: busy || null, onclick: function () { runBt(id); } },
        [icon(busy ? "loader-circle" : "sparkles", busy ? "s3 spin" : "s3"), busy ? t("editor.bt.readingItBack") : t("editor.bt.readItBack")])]));
    } else box.appendChild(el("p", { class: "k", text: t("editor.bt.needsAiHint") }));
    return box;
  }
  function runBt(id) {
    aquilla.backtranslation.run(S.fileId, id).catch(function (err) { toast(errText(err)); });
  }

  // ── Live data ────────────────────────────────────────────────────────────
  function setReadOnly() {
    if (S.readOnly) return;
    S.readOnly = true;
    renderBanner();
    Object.keys(V.mounted).forEach(paintCell);
  }
  function applyCells(list) {
    (list || []).forEach(function (f) {
      var c = S.byId[f.cellId];
      if (!c) return;
      var editing = S.activeId === f.cellId && S.drafts[f.cellId] && S.drafts[f.cellId].dirty;
      if (editing && (f.target !== c.target)) S.sig.remote[f.cellId] = 1;
      var pending = c._pendingVal;
      Object.keys(f).forEach(function (k) { c[k] = f[k]; });
      if (pending !== undefined && ((c.validators || []).indexOf(S.username) >= 0) !== pending) c._pendingVal = pending;
      if (S.activeId !== f.cellId || !editing) { var r = R(f.cellId); if (r) { r.readKey = null; r.srcKey = null; } }
      if (V.mounted[f.cellId]) paintCell(f.cellId);
    });
  }
  aquilla.on("cells.changed", function (e) {
    if (!S.fileId || e.fileId !== S.fileId) return;
    var ids = (e.cellIds || []).filter(function (id) { return S.byId[id]; });
    if (!ids.length) return;
    ids.forEach(function (id) { delete S.termsAsked[id]; });
    aquilla.cells.get(S.fileId, ids.slice(0, 500)).then(function (cells) { applyCells(cells); requestTerms(); }, function () {});
  });
  aquilla.on("cells.structure", function (e) { if (e.fileId === S.fileId) reloadAll(); });
  aquilla.on("cells.loaded", function (e) { if (e.fileId === S.fileId) loadSections(); });
  aquilla.on("presence.changed", function (e) {
    if (e.fileId && e.fileId !== S.fileId) return;
    var next = Object.create(null);
    Object.keys(e.holders || {}).forEach(function (id) { next[id] = e.holders[id].username; });
    var touched = Object.keys(next).concat(Object.keys(S.locks));
    S.locks = next;
    touched.forEach(function (id) { if (V.mounted[id]) paintCell(id); });
  });
  aquilla.on("presence.peers", function (e) { if (!e.fileId || e.fileId === S.fileId) applyPeers(e.peers || []); });
  function applyPeers(peers) {
    var touched = Object.keys(S.peersByCell);
    S.peers = peers;
    S.peersByCell = Object.create(null);
    peers.forEach(function (p) { if (p.cellId && p.username !== S.username) (S.peersByCell[p.cellId] = S.peersByCell[p.cellId] || []).push(p); });
    touched.concat(Object.keys(S.peersByCell)).forEach(function (id) { var r = R(id); if (r) r.readKey = null; if (V.mounted[id]) paintCell(id); });
  }
  aquilla.on("comments.changed", function () { loadComments(); });
  aquilla.on("signals.changed", function (e) { if (!e.fileId || e.fileId === S.fileId) loadSignals(); });
  aquilla.on("backtranslation.changed", function () { loadBts(); });
  aquilla.on("selection.changed", function (e) {
    var next = Object.create(null);
    (e.cellIds || []).forEach(function (id) { next[id] = 1; });
    var touched = Object.keys(S.selection).concat(Object.keys(next));
    S.selection = next;
    S.selCount = Object.keys(next).length;
    touched.forEach(function (id) { if (V.mounted[id]) paintCell(id); });
  });
  aquilla.on("config.changed", function () {
    var lane = S.cfg && S.cfg.activeLane;
    aquilla.editor.config(S.fileId).then(function (cfg) {
      S.cfg = cfg;
      renderHeader(); renderBanner();
      if (lane !== cfg.activeLane) reloadAll(true);
      else { Object.keys(V.mounted).forEach(function (id) { var r = R(id); if (r) { r.srcKey = null; r.readKey = null; } paintCell(id); }); }
    }, function () {});
  });
  aquilla.on("editor.reveal", function (e) { if (e.cellId) reveal(e.cellId, e.focus !== false); });

  function loadSignals() {
    return aquilla.cells.signals(S.fileId).then(function (sig) {
      S.signals = sig;
      S.sig.stale = Object.create(null); (sig.stale || []).forEach(function (id) { S.sig.stale[id] = 1; });
      S.sig.upstream = Object.create(null); (sig.upstreamStale || []).forEach(function (id) { S.sig.upstream[id] = 1; });
      var prev = S.sig.remote; S.sig.remote = Object.create(null); (sig.remoteChanged || []).forEach(function (id) { S.sig.remote[id] = 1; });
      void prev;
      Object.keys(V.mounted).forEach(function (id) { var r = R(id); if (r) { r.srcKey = null; r.readKey = null; } paintCell(id); });
    }, function () {});
  }
  function loadComments() {
    return aquilla.comments.counts(S.fileId).then(function (counts) {
      var touched = Object.keys(counts || {}).concat(Object.keys(S.comments));
      S.comments = counts || {};
      touched.forEach(function (id) { if (V.mounted[id]) paintCell(id); });
    }, function () {});
  }
  function refreshAudio() {
    return aquilla.audio.list(S.fileId).then(function (audio) {
      var had = hasAudioColumn();
      S.audio = audio || {};
      if (had !== hasAudioColumn()) renderHeader();
      Object.keys(V.mounted).forEach(paintCell);
    }, function () {});
  }
  function loadBts() {
    return aquilla.backtranslation.list(S.fileId).then(function (bts) {
      S.bts = bts || {};
      Object.keys(S.expanded).concat(Object.keys(V.mounted)).forEach(function (id) { if (V.mounted[id]) paintCell(id); });
    }, function () {});
  }
  function loadSections() {
    return aquilla.cells.sections(S.fileId).then(function (secs) {
      S.sections = secs || [];
      indexSections();
      updateActiveSection();
      renderNav();
    }, function () {});
  }
  function reveal(id, focus) {
    if (!has(S.index, id)) { S.pendingReveal = id; return false; }
    S.pendingReveal = null;
    scrollToCell(id, "center", true);
    if (focus) later(function () { if (!activate(id)) { var r = R(id); if (r) r.row.focus(); } }, 40);
    return true;
  }
  // The rows on screen, for the host (translate-as-read, parallel Bibles).
  var lastVisible = "", visTimer = null;
  function maybeView() {
    if (visTimer) return;
    visTimer = later(function () {
      visTimer = null;
      var sc = $("scroller");
      if (!sc || !S.ids.length) return;
      layout();
      var a = indexAt(sc.scrollTop), b = indexAt(sc.scrollTop + sc.clientHeight);
      var ids = S.ids.slice(a, Math.min(b + 1, a + 500));
      var key = ids.join(",");
      if (key === lastVisible) return;
      lastVisible = key;
      aquilla.editor.visible(S.fileId, ids).catch(function () {});
    }, 200);
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function addCells(cells) {
    cells.forEach(function (c) {
      if (S.byId[c.cellId]) return;
      S.byId[c.cellId] = c;
      S.ids.push(c.cellId);
    });
  }
  function loadPages(cursor, first, pending) {
    return (pending || aquilla.cells.page(S.fileId, { cursor: cursor, limit: first ? 60 : 2000 })).then(function (page) {
      addCells(page.cells || []);
      rebuildList();
      if (first) $("rows").setAttribute("data-ready", "true");
      if (S.pendingReveal) reveal(S.pendingReveal, true);
      if (page.nextCursor) return loadPages(page.nextCursor, false);
      return null;
    });
  }
  /** Re-read the whole list. Rows that still exist keep their DOM (and an
   *  open editor keeps its caret); new rows are built, gone rows dropped.
   *  A lane switch passes fresh=true: every row's content changes. */
  function reloadAll(fresh) {
    var acc = [];
    function page(cursor) {
      return aquilla.cells.page(S.fileId, { cursor: cursor, limit: 2000 }).then(function (p) {
        acc = acc.concat(p.cells || []);
        return p.nextCursor ? page(p.nextCursor) : null;
      });
    }
    return page(null).then(function () {
      if (fresh) {
        if (S.activeId) deactivate(S.activeId);
        S.terms = Object.create(null); S.termsAsked = Object.create(null);
        Object.keys(V.mounted).forEach(function (id) { V.mounted[id].remove(); });
        V.mounted = Object.create(null); V.nodes = Object.create(null); V.heights = Object.create(null);
      }
      var next = Object.create(null);
      S.ids = acc.map(function (c) {
        var old = S.byId[c.cellId];
        if (old && !fresh) { Object.keys(c).forEach(function (k) { old[k] = c[k]; }); next[c.cellId] = old; }
        else next[c.cellId] = c;
        return c.cellId;
      });
      S.byId = next;
      rebuildList();
      Object.keys(V.mounted).forEach(function (id) { var r = R(id); if (r) { r.srcKey = null; if (S.activeId !== id) r.readKey = null; } paintCell(id); });
      loadSections(); loadSignals();
    });
  }

  async function boot() {
    frame();
    try {
      var stringsP = loadStrings();
      if (!S.fileId) {
        var files = await aquilla.files.list();
        var f0 = (files || []).filter(function (f) { return f.cellCount > 0; })[0];
        S.fileId = f0 ? f0.fileId : null;
        S.fileName = f0 ? f0.name : "";
      }
      if (!S.fileId) { $("rows").textContent = ""; $("rows").appendChild(el("div", { class: "empty-state", text: t("extensions.editor.noFile") })); return; }
      // Everything the first paint needs, in parallel: one round of bridge
      // calls (the first page waits on the workspace's own store load).
      var firstPageP = aquilla.cells.page(S.fileId, { limit: 60 });
      var cfgP = aquilla.editor.config(S.fileId).catch(function () { return null; });
      var savedP = S.pendingReveal ? Promise.resolve(null) : aquilla.storage.get("pos:" + S.fileId).catch(function () { return null; });
      var skipP = aquilla.storage.get("skipReplaceConfirm").catch(function () { return null; });
      await stringsP;
      S.cfg = (await cfgP) || { canEdit: true, canValidate: true, lanes: [], activeLane: "", sourceLabel: "", targetLabel: "", validationRequirement: 1, ai: { configured: false, available: false },
        backtranslation: { configured: false }, footnotes: "inline", sourceFontSize: 14, targetFontSize: 14, lineNumbers: true, cellLabels: false, lens: "text", lenses: [] };
      skipReplaceConfirm = (await skipP) === true;
      renderHeader(); renderBanner();
      await loadPages(null, true, firstPageP);
      S.loading = false;
      rebuildList();
      var saved = await savedP;
      if (S.pendingReveal) reveal(S.pendingReveal, true);
      else if (typeof saved === "string" && has(S.index, saved)) scrollToCell(saved, "center", false);
      loadSections(); loadSignals(); loadComments(); refreshAudio(); loadPericopes();
      aquilla.presence.list(S.fileId).then(function (h) { Object.keys(h || {}).forEach(function (id) { S.locks[id] = h[id].username; if (V.mounted[id]) paintCell(id); }); }, function () {});
      aquilla.presence.peers(S.fileId).then(applyPeers, function () {});
      if (S.cfg.backtranslation.configured) loadBts();
    } catch (err) {
      S.loading = false;
      $("rows").textContent = "";
      $("rows").appendChild(el("div", { class: "empty-state", role: "alert", text: isDenied(err) ? t("extensions.editor.denied") : t("extensions.editor.loadFailed", { reason: errText(err) }) }));
    }
  }
  // Inspection hook for tests and debugging (frame-local; the frame has an
  // opaque origin, so nothing outside it can read this).
  window.__AQ_EDITOR__ = { S: S, V: V, R: R, ro: ro, scrollToCell: scrollToCell, activate: activate };
  boot();
`
