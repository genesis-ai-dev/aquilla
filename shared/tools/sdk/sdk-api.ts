/**
 * Aquilla extension SDK — part 9: the public surface, `window.aq`. Hooks
 * return live handles ({ value / get, subscribe(fn) → unsubscribe }); every
 * component returns a DOM node that keeps itself current. AQ_SDK_EXPORTS
 * (sdk.ts) lists this surface for the capability-twin test.
 */
export const SDK_API = String.raw`
  function handle(kind, getter, filter) {
    return {
      get value() { return getter(); },
      get: getter,
      subscribe: function (fn) {
        var offs = (Array.isArray(kind) ? kind : [kind]).map(function (k) {
          return listen(k, function (arg) { if (!filter || filter(arg)) fn(getter(), arg); });
        });
        return function () { offs.forEach(function (off) { off(); }); };
      },
    };
  }
  function fileValue() {
    return { fileId: S.fileId, name: S.fileName, config: cfg(), sections: S.sections, pericopes: S.pericopes, loading: S.loading, ready: S.ready,
      failed: S.failed, readOnly: S.readOnly || !cfg().canEdit, cellCount: S.ids.length, user: S.username };
  }
  /** The bound file: { fileId, name, config, sections, loading, … }, live. */
  function useFile(fileId) {
    var h = handle(["file"], fileValue);
    h.ready = boot(fileId).then(fileValue);
    return h;
  }
  /** The file's cells (paged in; first page fast), live. */
  function useCells(fileId) {
    var h = handle(["cells"], function () { return S.ids.map(function (id) { return S.byId[id]; }); });
    Object.defineProperty(h, "ids", { get: function () { return S.ids.slice(); } });
    Object.defineProperty(h, "loading", { get: function () { return S.loading; } });
    h.cell = function (id) { return S.byId[id] || null; };
    h.state = cellState;
    h.ready = boot(fileId).then(function () {
      if (!S.loading) return h.value;
      return new Promise(function (resolve) { var off = listen("file", function () { if (!S.loading) { off(); resolve(h.value); } }); });
    });
    return h;
  }
  /** One cell's full state (cell, validation, issues, AI, comments, audio,
   *  lock, peers, selected, editing, …), live. */
  function useCell(id) {
    return handle(["cells"], function () { return S.byId[id] ? cellState(id) : null; }, function (arg) { return !Array.isArray(arg) || arg.indexOf(id) >= 0; });
  }
  function useSelection() {
    var h = handle(["selection"], function () { return Object.keys(S.selection); });
    h.has = function (id) { return !!S.selection[id]; };
    h.toggle = toggleSelect;
    h.set = setSelection;
    h.clear = clearSelection;
    return h;
  }
  function usePresence() {
    var h = handle(["presence"], function () { return { locks: Object.assign({}, S.locks), peers: S.peers.slice() }; });
    h.peers = peersFor;
    h.lockedBy = function (id) { return S.locks[id] || null; };
    return h;
  }
  /** Render into the page (replacing it). A layout holding a CellList fills
   *  the frame (the list scrolls); anything else scrolls as a page. */
  function mount(node, opts) {
    opts = opts || {};
    var root = opts.target || doc.body;
    root.textContent = "";
    doc.body.classList.add("aq");
    var fill = opts.fill !== undefined ? opts.fill : !!(node.querySelector && (node.matches(".aq-list") || node.querySelector(".aq-list")));
    doc.body.classList.toggle("aq-fill", fill);
    append(root, node);
    return node;
  }
  /** A column layout for editor-like views: children stacked, the CellList
   *  taking the remaining height. */
  function Layout(children) { return el("div", { class: "aq-layout" }, children); }
  doc.documentElement.classList.add("aq-sdk");
  if (doc.body) doc.body.classList.add("aq");
  else doc.addEventListener("DOMContentLoaded", function () { doc.body.classList.add("aq"); });

  var aq = {
    version: SDK_VERSION,
    h: el, icon: icon, t: t, strings: loadStrings,
    mount: mount, Layout: Layout,
    useFile: useFile, useCells: useCells, useCell: useCell, useSelection: useSelection, usePresence: usePresence,
    actions: actions,
    CellList: CellList, CellRow: CellRow, SourceText: SourceText, TargetEditor: TargetEditor, ValidateButton: ValidateButton,
    CommentBadge: CommentBadge, AudioBadge: AudioBadge, StatusBadges: StatusBadges, CellNumber: CellNumber, SelectBox: SelectBox,
    HealthRibbon: HealthRibbon, PresenceStack: PresenceStack, CellNotes: CellNotes, FootnoteLine: FootnoteLine, VoiceCard: VoiceCard,
    DraftButton: DraftButton, DraftActions: DraftActions, CellMenu: openCellMenu, cellMenuItems: cellMenuItems,
    AudioValidateButton: AudioValidateButton, ExamplePanel: ExamplePanel, ContextualDraftCard: ContextualDraftCard, SourceMenuButton: SourceMenuButton,
    ChapterPicker: ChapterPicker, Toolbar: Toolbar, ColumnHeader: ColumnHeader, ReadOnlyBanner: ReadOnlyBanner,
    ui: ui,
    cell: {
      state: function (id) { return S.byId[id] ? cellState(id) : null; },
      refresh: function (id) { notify(id ? [id] : null); },
      ref: function (id) { return S.byId[id] ? cellRef(S.byId[id]) : ""; },
      number: function (id) { return S.byId[id] ? numberOf(S.byId[id]) : ""; },
      plain: function (html) { var d = doc.createElement("div"); showInto(d, html, ""); return plainOf(d); },
      words: function (text) { var s = String(text || "").replace(/\\f\s[\s\S]*?\\f\*/g, " ").trim(); return s ? s.split(/\s+/u).filter(function (w) { return /[\p{L}\p{N}]/u.test(w); }).length : 0; },
      isStructural: function (id) { return !!S.byId[id] && isStructural(S.byId[id]); },
      toggleDetails: toggleDetails,
      scrollTo: scrollToCell,
      focusRow: focusRow,
    },
    // Low-level escape hatch: the same state the components read (read-only by convention).
    debug: { state: S },
  };
  window.aq = aq;
`
