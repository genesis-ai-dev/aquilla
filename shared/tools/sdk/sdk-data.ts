/**
 * Aquilla extension SDK — part 2: the live data layer. One bound file at a
 * time (the editor mount's file, or the first file with cells): its cells
 * (paged in, first page small), editor config, sections, per-cell signals,
 * comments, audio, back-translations, key terms, presence and the bulk
 * selection — all kept live from the bridge's events. Components bind
 * painters to a cell id (bindCell) and are repainted when anything about
 * that cell changes; hooks (useFile, useCells, …) expose the same state.
 */
export const SDK_DATA = String.raw`
  var S = {
    fileId: ctx.file ? ctx.file.fileId : ctx.cell ? ctx.cell.fileId : null,
    fileName: ctx.file ? ctx.file.name : "",
    cfg: null, ready: false, loading: true, readOnly: false, failed: null,
    ids: [], byId: Object.create(null), index: Object.create(null),
    sections: [], sectionIdx: Object.create(null), pericopes: [],
    signals: { stale: [], upstreamStale: [], assignments: {}, repetition: {}, issues: {}, health: {}, ai: {}, backtranslating: [], remoteChanged: [] },
    sig: { stale: Object.create(null), upstream: Object.create(null), bt: Object.create(null), remote: Object.create(null) },
    peers: [], peersByCell: Object.create(null), locks: Object.create(null), comments: Object.create(null), audio: Object.create(null),
    bts: Object.create(null), terms: Object.create(null), termsAsked: Object.create(null),
    selection: Object.create(null), selCount: 0, selAnchor: null, voicing: Object.create(null),
    activeId: null, focusRowId: null, claimed: null, drafts: Object.create(null), saved: Object.create(null), errors: Object.create(null),
    expanded: Object.create(null),
    pendingReveal: ctx.file && ctx.file.revealCellId ? ctx.file.revealCellId : null,
    username: ctx.user ? ctx.user.username : "",
  };
  var DEFAULT_CFG = { canEdit: true, canValidate: true, lanes: [], activeLane: "", sourceLabel: "", targetLabel: "", validationRequirement: 1,
    ai: { configured: false, available: false }, backtranslation: { configured: false }, footnotes: "inline", sourceFontSize: 14, targetFontSize: 14,
    sourceDirection: "auto", targetDirection: "auto", lineNumbers: true, cellLabels: false, lens: "text", lenses: [], canManageLanes: false, panels: [], health: false };

  /** The manifest declares this scope (unknown: assume yes). Optional
   *  background reads stay inside the declared scopes, so the SDK never
   *  prompts for something the extension does not use. */
  function declared(scope) { var s = ctx.tool && ctx.tool.scopes; return !s || s.indexOf(scope) >= 0; }

  // ── Reactivity: painters bound to a cell id (or "*" for file-level state).
  var painters = Object.create(null);
  var listeners = { cells: [], file: [], selection: [], presence: [] };
  function bindCell(id, node, fn) {
    if (!booted) boot();
    (painters[id] || (painters[id] = [])).push({ node: node, fn: fn, dirty: false });
    try { fn(); } catch (e) { console.error(e); }
    return node;
  }
  function runPainter(p) { p.dirty = false; try { p.fn(); } catch (e) { console.error(e); } }
  /** Repaint everything bound to these cells (null = every cell). */
  function notify(ids) {
    (ids || Object.keys(painters)).forEach(function (id) {
      (painters[id] || []).forEach(function (p) { if (p.node.isConnected) runPainter(p); else p.dirty = true; });
    });
    emit("cells", ids);
  }
  /** Paint whatever was skipped while a cell's nodes were off screen. */
  function refreshCell(id) { (painters[id] || []).forEach(function (p) { if (p.dirty && p.node.isConnected) runPainter(p); }); }
  function forgetCell(id, root) { if (painters[id]) painters[id] = painters[id].filter(function (p) { return !root.contains(p.node); }); }
  // Painters of nodes that left the page for good (not kept by a list cache).
  setInterval(function () {
    Object.keys(painters).forEach(function (id) {
      painters[id] = painters[id].filter(function (p) { if (p.node.isConnected) return true; var top = p.node; while (top.parentNode) top = top.parentNode; return !!top.__aqKeep; });
      if (!painters[id].length) delete painters[id];
    });
  }, 30000);
  function emit(kind, arg) { listeners[kind].slice().forEach(function (fn) { try { fn(arg); } catch (e) { console.error(e); } }); }
  function listen(kind, fn) { listeners[kind].push(fn); return function () { listeners[kind] = listeners[kind].filter(function (x) { return x !== fn; }); }; }
  function fileChanged() { notifyFile(); }
  function notifyFile() { (painters["*"] || []).forEach(function (p) { if (p.node.isConnected) runPainter(p); else p.dirty = true; }); emit("file"); }

  // ── Derived per-cell state (what every component reads).
  function cellState(id) {
    var c = S.byId[id];
    var issues = (S.signals.issues || {})[id] || [];
    var live = issues.filter(function (i) { return !i.waived; });
    var ai = (S.signals.ai || {})[id] || null;
    var d = S.drafts[id];
    var target = d && d.dirty ? d.value : c ? c.target : "";
    return {
      cell: c, issues: issues, liveIssues: live, major: live.some(function (i) { return i.severity === "error"; }),
      ai: ai, drafting: !!(ai && ai.phase), comments: S.comments[id] || 0, hasAudio: !!S.audio[id], lock: S.locks[id] || null,
      peers: S.peersByCell[id] || [], selected: !!S.selection[id], stale: !!S.sig.stale[id], upstreamStale: !!S.sig.upstream[id],
      remoteChanged: !!S.sig.remote[id], bt: S.bts[id] || null, terms: S.terms[id] || [], target: target || "",
      hasText: !!(c && (c.target || "").trim()), editing: S.activeId === id, error: S.errors[id] || (ai && ai.error) || null,
      saved: !!S.saved[id], editable: !!(c && editableCell(c)), validation: c ? valState(c) : { state: "none", self: false, validators: [] },
      expanded: !!S.expanded[id], voicing: S.voicing[id] || null,
    };
  }
  function cfg() { return S.cfg || DEFAULT_CFG; }
  function cellRef(c) { return c.ref || c.label || t("editor.row.rowFallbackRef", { index: (S.index[c.cellId] || 0) + 1 }); }
  function isStructural(c) { return c.type === "heading" || c.type === "paratext"; }
  function editableCell(c) { return !!(cfg().canEdit && !S.readOnly && !S.locks[c.cellId]); }
  function valState(c) {
    var v = (c.validators || []).slice();
    var need = cfg().validationRequirement || 1;
    var self = v.indexOf(S.username) >= 0;
    if (c._pendingVal !== undefined) {
      if (c._pendingVal) { if (!self) v = v.concat([S.username]); self = true; }
      else { v = v.filter(function (x) { return x !== S.username; }); self = false; }
    }
    if (!v.length) return c.validated && !c.validators ? { state: "full-others", self: false, validators: [] } : { state: "none", self: false, validators: v };
    if (v.length >= need) return { state: self ? "full-self" : "full-others", self: self, validators: v };
    return { state: self ? "self" : "others", self: self, validators: v };
  }
  /** Verse number for the gutter (numberLabel on editor mounts; from ref elsewhere). */
  function numberOf(c) {
    if (c.numberLabel !== undefined) return c.numberLabel || "";
    var m = /:(\d+(?:[-–]\d+)?)$/.exec(c.ref || "");
    return m ? m[1] : String((S.index[c.cellId] || 0) + 1);
  }
  // Editable rows in document order (structural rows with no source skip).
  function navIds() { return S.ids.filter(function (x) { var c = S.byId[x]; return c && ((c.source || "").trim() || !isStructural(c)); }); }

  // ── Loading ──────────────────────────────────────────────────────────────
  function addCells(cells) {
    var added = false;
    cells.forEach(function (c) {
      if (S.byId[c.cellId]) return;
      S.byId[c.cellId] = c;
      S.index[c.cellId] = S.ids.length;
      S.ids.push(c.cellId);
      added = true;
    });
    return added;
  }
  function reindex() { S.index = Object.create(null); S.ids.forEach(function (id, i) { S.index[id] = i; }); }
  function loadPages(cursor, first, pending) {
    return (pending || aquilla.cells.page(S.fileId, { cursor: cursor, limit: first ? 60 : 2000 })).then(function (page) {
      addCells(page.cells || []);
      emit("cells", null);
      notifyFile();
      if (S.pendingReveal) reveal(S.pendingReveal, true);
      if (page.nextCursor) return loadPages(page.nextCursor, false);
      return null;
    });
  }
  /** Re-read the whole list. Cells that still exist keep their objects (and
   *  an open editor keeps its caret). A lane switch passes fresh=true. */
  function reloadAll(fresh) {
    var acc = [];
    function page(cursor) {
      return aquilla.cells.page(S.fileId, { cursor: cursor, limit: 2000 }).then(function (p) {
        acc = acc.concat(p.cells || []);
        return p.nextCursor ? page(p.nextCursor) : null;
      });
    }
    return page(null).then(function () {
      if (fresh) { if (S.activeId) deactivate(S.activeId); S.terms = Object.create(null); S.termsAsked = Object.create(null); }
      var next = Object.create(null);
      S.ids = acc.map(function (c) {
        var old = S.byId[c.cellId];
        if (old && !fresh) { Object.keys(c).forEach(function (k) { old[k] = c[k]; }); next[c.cellId] = old; }
        else next[c.cellId] = c;
        return c.cellId;
      });
      S.byId = next;
      reindex();
      emit("cells", fresh ? "fresh" : "structure");
      notify(null);
      loadSections(); loadSignals();
    });
  }
  var booted = null;
  /** Bind the SDK to a file (default: the mount's, else the first with cells). */
  function boot(fileId) {
    if (fileId && fileId !== S.fileId) { S.fileId = fileId; booted = null; S.ids = []; S.byId = Object.create(null); S.index = Object.create(null); S.ready = false; S.loading = true; }
    if (booted) return booted;
    booted = (async function () {
      var stringsP = loadStrings(SDK_STRING_KEYS);
      try {
        if (!S.fileId) {
          var files = await aquilla.files.list();
          var f0 = (files || []).filter(function (f) { return f.cellCount > 0; })[0];
          S.fileId = f0 ? f0.fileId : null;
          S.fileName = f0 ? f0.name : "";
        }
        if (!S.fileId) { S.loading = false; S.ready = true; await stringsP; notifyFile(); return; }
        aquilla.storage.get("skipReplaceConfirm").then(function (v) { skipReplaceConfirm = v === true; }, noop);
        // Everything the first paint needs, in parallel.
        var firstPageP = aquilla.cells.page(S.fileId, { limit: 60 });
        var cfgP = aquilla.editor.config(S.fileId).catch(function () { return null; });
        await stringsP;
        S.cfg = Object.assign({}, DEFAULT_CFG, (await cfgP) || {});
        if (!S.fileName) S.fileName = S.cfg.fileName || "";
        S.ready = true;
        notifyFile();
        await loadPages(null, true, firstPageP);
        S.loading = false;
        emit("cells", null);
        notifyFile();
        loadSections(); loadSignals(); loadComments(); refreshAudio(); loadPericopes();
        aquilla.presence.list(S.fileId).then(function (h) { Object.keys(h || {}).forEach(function (id) { S.locks[id] = h[id].username; }); notify(Object.keys(h || {})); emit("presence"); }, noop);
        aquilla.presence.peers(S.fileId).then(applyPeers, noop);
        if (S.cfg.backtranslation.configured) loadBts();
      } catch (err) {
        S.loading = false; S.ready = true;
        S.failed = isDenied(err) ? t("extensions.editor.denied") : t("extensions.editor.loadFailed", { reason: errText(err) });
        notifyFile();
      }
    })();
    return booted;
  }

  function applyCells(list) {
    var ids = [];
    (list || []).forEach(function (f) {
      var c = S.byId[f.cellId];
      if (!c) return;
      var editing = S.activeId === f.cellId && S.drafts[f.cellId] && S.drafts[f.cellId].dirty;
      if (editing && f.target !== c.target) S.sig.remote[f.cellId] = 1;
      var pending = c._pendingVal;
      Object.keys(f).forEach(function (k) { c[k] = f[k]; });
      if (pending !== undefined && ((c.validators || []).indexOf(S.username) >= 0) !== pending) c._pendingVal = pending;
      else delete c._pendingVal;
      ids.push(f.cellId);
    });
    notify(ids);
  }
  function setReadOnly() {
    if (S.readOnly) return;
    S.readOnly = true;
    notifyFile();
    notify(null);
  }
  function loadSignals() {
    return aquilla.cells.signals(S.fileId).then(function (sig) {
      S.signals = sig;
      S.sig.stale = Object.create(null); (sig.stale || []).forEach(function (id) { S.sig.stale[id] = 1; });
      S.sig.upstream = Object.create(null); (sig.upstreamStale || []).forEach(function (id) { S.sig.upstream[id] = 1; });
      S.sig.remote = Object.create(null); (sig.remoteChanged || []).forEach(function (id) { S.sig.remote[id] = 1; });
      notify(null);
    }, noop);
  }
  function loadComments() {
    if (!declared("read:comments")) return Promise.resolve();
    return aquilla.comments.counts(S.fileId).then(function (counts) {
      var touched = Object.keys(counts || {}).concat(Object.keys(S.comments));
      S.comments = counts || {};
      notify(touched);
    }, noop);
  }
  function refreshAudio() {
    return aquilla.audio.list(S.fileId).then(function (audio) {
      var had = Object.keys(S.audio).length > 0;
      S.audio = audio || {};
      if (had !== Object.keys(S.audio).length > 0) notifyFile();
      notify(null);
    }, noop);
  }
  function loadBts() {
    return aquilla.backtranslation.list(S.fileId).then(function (bts) { S.bts = bts || {}; notify(null); }, noop);
  }
  function loadSections() {
    return aquilla.cells.sections(S.fileId).then(function (secs) {
      S.sections = secs || [];
      S.sectionIdx = Object.create(null);
      S.sections.forEach(function (s, i) { s.cellIds.forEach(function (id) { S.sectionIdx[id] = i; }); });
      notifyFile();
    }, noop);
  }
  function loadPericopes() {
    return aquilla.cells.pericopes(S.fileId).then(function (list) { S.pericopes = list || []; notifyFile(); }, noop);
  }
  function applyPeers(peers) {
    var touched = Object.keys(S.peersByCell);
    S.peers = peers;
    S.peersByCell = Object.create(null);
    peers.forEach(function (p) { if (p.cellId && p.username !== S.username) (S.peersByCell[p.cellId] = S.peersByCell[p.cellId] || []).push(p); });
    notify(touched.concat(Object.keys(S.peersByCell)));
    emit("presence");
  }
  // Key terms for cells on screen, batched (components ask via wantTerms).
  var termTimer = null, termWant = Object.create(null);
  function wantTerms(id) {
    if (S.termsAsked[id] || !S.cfg || !declared("read:terms")) return;
    termWant[id] = 1;
    if (termTimer) return;
    termTimer = later(function () {
      termTimer = null;
      var want = Object.keys(termWant).filter(function (x) { return !S.termsAsked[x]; }).slice(0, 400);
      termWant = Object.create(null);
      if (!want.length) return;
      want.forEach(function (x) { S.termsAsked[x] = 1; });
      aquilla.terms.matches(S.fileId, want).then(function (res) {
        want.forEach(function (x) { S.terms[x] = (res && res[x]) || []; });
        notify(want);
      }, noop);
    }, 80);
  }

  // ── Live events ──────────────────────────────────────────────────────────
  aquilla.on("cells.changed", function (e) {
    if (!S.fileId || e.fileId !== S.fileId) return;
    var ids = (e.cellIds || []).filter(function (id) { return S.byId[id]; });
    if (!ids.length) return;
    ids.forEach(function (id) { delete S.termsAsked[id]; });
    aquilla.cells.get(S.fileId, ids.slice(0, 500)).then(applyCells, noop);
  });
  aquilla.on("cells.structure", function (e) { if (e.fileId === S.fileId && S.ready) reloadAll(); });
  aquilla.on("cells.loaded", function (e) { if (e.fileId === S.fileId) loadSections(); });
  aquilla.on("presence.changed", function (e) {
    if (e.fileId && e.fileId !== S.fileId) return;
    var next = Object.create(null);
    Object.keys(e.holders || {}).forEach(function (id) { next[id] = e.holders[id].username; });
    var touched = Object.keys(next).concat(Object.keys(S.locks));
    S.locks = next;
    notify(touched);
    emit("presence");
  });
  aquilla.on("presence.peers", function (e) { if (!e.fileId || e.fileId === S.fileId) applyPeers(e.peers || []); });
  aquilla.on("comments.changed", function () { loadComments(); });
  aquilla.on("signals.changed", function (e) { if (!e.fileId || e.fileId === S.fileId) loadSignals(); });
  aquilla.on("backtranslation.changed", function () { loadBts(); });
  aquilla.on("pericopes.changed", function (e) { if (!e.fileId || e.fileId === S.fileId) loadPericopes(); });
  aquilla.on("selection.changed", function (e) {
    var next = Object.create(null);
    (e.cellIds || []).forEach(function (id) { next[id] = 1; });
    var touched = Object.keys(S.selection).concat(Object.keys(next));
    S.selection = next;
    S.selCount = Object.keys(next).length;
    notify(touched);
    emit("selection");
  });
  aquilla.on("config.changed", function () {
    if (!S.fileId) return;
    var lane = S.cfg && S.cfg.activeLane;
    aquilla.editor.config(S.fileId).then(function (c) {
      S.cfg = Object.assign({}, DEFAULT_CFG, c);
      notifyFile();
      if (lane !== c.activeLane) reloadAll(true);
      else notify(null);
    }, noop);
  });
  aquilla.on("editor.reveal", function (e) { if (e.cellId) reveal(e.cellId, e.focus !== false); });

  // ── Selection (drives the host's bulk-actions bar) ───────────────────────
  function pushSelection() {
    S.selCount = Object.keys(S.selection).length;
    if (S.fileId) aquilla.selection.set(S.fileId, Object.keys(S.selection)).catch(noop);
    emit("selection");
  }
  function toggleSelect(id) {
    if (S.selection[id]) delete S.selection[id]; else S.selection[id] = 1;
    S.selAnchor = id;
    notify([id]);
    pushSelection();
  }
  function setSelection(ids) {
    var touched = Object.keys(S.selection).concat(ids);
    S.selection = Object.create(null);
    ids.forEach(function (x) { S.selection[x] = 1; });
    notify(touched);
    pushSelection();
  }
  function clearSelection() { setSelection([]); }
  function selectRange(a, b) {
    var ids = navIds(), i = ids.indexOf(a), j = ids.indexOf(b);
    if (i < 0 || j < 0) return;
    var lo = Math.min(i, j), hi = Math.max(i, j), touched = Object.keys(S.selection);
    S.selection = Object.create(null);
    for (var k = lo; k <= hi; k++) S.selection[ids[k]] = 1;
    notify(touched.concat(ids.slice(lo, hi + 1)));
  }
  doc.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && S.selCount && !S.activeId && !openPop) clearSelection();
  });
`
