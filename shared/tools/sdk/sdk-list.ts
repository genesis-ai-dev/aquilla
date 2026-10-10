/**
 * Aquilla extension SDK — part 3: CellList (the built-in's virtualized list:
 * windowed rows between spacers, measured heights, scroll anchoring, the
 * open editor always kept mounted) and the editor chrome: Toolbar (the
 * chapter row, padded for the host's own buttons), ChapterPicker (milestone
 * navigator + pericopes), ColumnHeader (source/target labels, lane switcher)
 * and ReadOnlyBanner.
 */
export const SDK_LIST = String.raw`
  // ── CellList ─────────────────────────────────────────────────────────────
  var LISTS = [];
  var OVERSCAN = 900;
  function CellList(opts) {
    opts = opts || {};
    if (!booted) boot();
    var rowOf = opts.row || function (id) { return CellRow(id); };
    var L = { ids: [], index: Object.create(null), heights: Object.create(null), offsets: [], total: 0, dirty: true, start: 0, end: -1,
              nodes: Object.create(null), mounted: Object.create(null), raf: 0, filter: opts.filter || null };
    var rows = el("div", { class: "aq-rows", id: LISTS.length ? null : "rows" });
    var scroller = el("div", { class: "aq-list", id: LISTS.length ? null : "scroller", role: "list", "aria-label": opts.label || "Cells" }, [rows]);
    L.scroller = scroller; L.rows = rows;
    rows.appendChild(el("div", { class: "empty-state" }, [icon("loader-circle", "spin"), t("common.loading")]));
    LISTS.push(L);

    function estimate(id) {
      var c = S.byId[id];
      if (!c) return 120;
      if (opts.estimate) return opts.estimate(c);
      var len = Math.max((c.source || "").length, (c.target || "").length);
      var w = Math.max(240, ((scroller.clientWidth || innerWidth) - 140) / (innerWidth >= 768 ? 2 : 1));
      var lines = Math.max(1, Math.ceil((len * 7.4) / w));
      return 16 + 20 + Math.max(40, 12 + lines * 22.4) + (c.paragraphStart ? 12 : 0);
    }
    function heightOf(id) { return has(L.heights, id) ? L.heights[id] : estimate(id); }
    function layout() {
      if (!L.dirty) return;
      var acc = 0;
      L.offsets = new Array(L.ids.length);
      for (var i = 0; i < L.ids.length; i++) { L.offsets[i] = acc; acc += heightOf(L.ids[i]); }
      L.total = acc;
      L.dirty = false;
    }
    function indexAt(y) {
      var lo = 0, hi = L.ids.length - 1;
      while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (L.offsets[mid] <= y) lo = mid; else hi = mid - 1; }
      return lo;
    }
    function firstVisibleId() {
      if (!L.ids.length) return null;
      layout();
      return L.ids[indexAt(scroller.scrollTop + 1)];
    }
    var ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(function (entries) {
      var shift = 0, anchorTop = scroller.scrollTop;
      layout();
      entries.forEach(function (en) {
        var id = en.target.getAttribute("data-cell-id");
        if (!id || !en.target.isConnected) return;
        // Rows sit on whole pixels, like the built-in list (which positions
        // each row at a rounded offset): round a fractional height.
        var exact = en.borderBoxSize && en.borderBoxSize[0] ? en.borderBoxSize[0].blockSize : en.target.offsetHeight;
        var pad = Math.round(exact) - exact;
        en.target.style.marginBottom = Math.abs(pad) > 0.01 ? pad + "px" : "";
        var h = Math.round(exact);
        if (!h || L.heights[id] === h) return;
        var before = heightOf(id);
        L.heights[id] = h;
        if (L.offsets[L.index[id]] < anchorTop - 1) shift += h - before;
        L.dirty = true;
      });
      if (L.dirty) {
        layout();
        renderSpacers();
        if (shift) scroller.scrollTop = anchorTop + shift;
      }
    }) : null;
    L.ro = ro;
    scroller.addEventListener("scroll", function () {
      if (L.raf) return;
      L.raf = requestAnimationFrame(function () { L.raf = 0; renderWindow(); updateActiveSection(); maybeView(); });
    }, { passive: true });
    function spacers() {
      var top = rows.querySelector(":scope > .sp-top"), bottom = rows.querySelector(":scope > .sp-bottom");
      if (!top) { top = el("div", { class: "sp-top", "aria-hidden": "true" }); rows.insertBefore(top, rows.firstChild); }
      if (!bottom) { bottom = el("div", { class: "sp-bottom", "aria-hidden": "true" }); rows.appendChild(bottom); }
      return { top: top, bottom: bottom };
    }
    function renderSpacers() {
      if (!L.ids.length || L.end < L.start) return;
      layout();
      var sp = spacers();
      sp.top.style.height = L.offsets[L.start] + "px";
      sp.bottom.style.height = Math.max(0, L.total - (L.offsets[L.end] + heightOf(L.ids[L.end]))) + "px";
    }
    // Rows sit in normal flow between two spacers (classic windowing): the
    // browser's own caret reveal, find and focus behave as in a plain list.
    // The open editor's row is always inside the window.
    function renderWindow() {
      if (!L.ids.length) return;
      layout();
      var top = scroller.scrollTop - OVERSCAN, bottom = scroller.scrollTop + scroller.clientHeight + OVERSCAN;
      var start = indexAt(Math.max(0, top)), end = indexAt(bottom);
      if (S.activeId && has(L.index, S.activeId)) {
        var ai = L.index[S.activeId];
        if (ai < start - 300 || ai > end + 300) leaveCell(S.activeId);
        else { start = Math.min(start, ai); end = Math.max(end, ai); }
      }
      var sp = spacers();
      var keep = Object.create(null), prev = sp.top;
      for (var i = start; i <= end; i++) {
        var id = L.ids[i];
        keep[id] = 1;
        var n = L.mounted[id];
        var fresh = !n;
        if (fresh) { n = L.nodes[id] || (L.nodes[id] = buildRow(id)); L.mounted[id] = n; }
        var want = prev.nextSibling;
        // Never move the row holding focus (moving a focused node blurs it).
        if (n !== want) {
          if (n.contains(doc.activeElement) && n.isConnected && want && want !== sp.bottom) rows.insertBefore(want, n.nextSibling);
          else rows.insertBefore(n, want);
        }
        if (fresh) { if (ro) ro.observe(n); refreshCell(id); }
        prev = n;
      }
      Object.keys(L.mounted).forEach(function (id) {
        if (keep[id]) return;
        var n = L.mounted[id];
        if (ro) ro.unobserve(n);
        n.remove();
        delete L.mounted[id];
      });
      // A bounded cache of built rows (big books stay light).
      var built = Object.keys(L.nodes);
      if (built.length > 600) built.forEach(function (id) { if (!L.mounted[id] && built.length-- > 400) { forgetCell(id, L.nodes[id]); delete L.nodes[id]; } });
      L.start = start; L.end = end;
      renderSpacers();
      maybeView();
    }
    function buildRow(id) {
      var n = rowOf(id);
      if (!n.getAttribute("data-cell-id")) n.setAttribute("data-cell-id", id);
      n.__aqKeep = true;
      return n;
    }
    function rebuild(mode) {
      if (mode === "fresh") {
        Object.keys(L.mounted).forEach(function (id) { L.mounted[id].remove(); });
        Object.keys(L.nodes).forEach(function (id) { forgetCell(id, L.nodes[id]); });
        L.mounted = Object.create(null); L.nodes = Object.create(null); L.heights = Object.create(null);
      }
      L.ids = L.filter ? S.ids.filter(function (id) { return L.filter(S.byId[id]); }) : S.ids.slice();
      L.index = Object.create(null);
      L.ids.forEach(function (id, i) { L.index[id] = i; });
      L.dirty = true;
      Object.keys(L.mounted).forEach(function (id) {
        if (!has(L.index, id)) { L.mounted[id].remove(); forgetCell(id, L.mounted[id]); delete L.mounted[id]; delete L.nodes[id]; }
      });
      if (!L.ids.length) {
        rows.textContent = "";
        if (S.failed) rows.appendChild(el("div", { class: "empty-state", role: "alert", text: S.failed }));
        else if (!S.loading) rows.appendChild(el("div", { class: "empty-state", text: S.fileId ? (opts.empty || t("extensions.editor.noCells")) : t("extensions.editor.noFile") }));
        else rows.appendChild(el("div", { class: "empty-state" }, [icon("loader-circle", "spin"), t("common.loading")]));
        return;
      }
      if (rows.querySelector(".empty-state")) rows.textContent = "";
      renderWindow();
      if (!S.loading) rows.setAttribute("data-ready", "true");
      else if (L.ids.length) rows.setAttribute("data-ready", "true");
    }
    listen("cells", function (arg) {
      if (!Array.isArray(arg)) { rebuild(arg); return; }
      // A filtered list re-filters only when a changed cell moves in or out.
      if (L.filter && arg.some(function (id) { return S.byId[id] && !!L.filter(S.byId[id]) !== has(L.index, id); })) rebuild();
    });
    listen("file", function () { if (!L.ids.length) rebuild(); });
    function scrollToCell(id, block, flash) {
      if (!has(L.index, id)) return false;
      var go = function () {
        layout();
        var y = L.offsets[L.index[id]], h = heightOf(id);
        var target = block === "center" ? y - (scroller.clientHeight - h) / 2 : block === "nearest"
          ? (y < scroller.scrollTop ? y : y + h > scroller.scrollTop + scroller.clientHeight ? y + h - scroller.clientHeight : scroller.scrollTop) : y;
        scroller.scrollTop = Math.max(0, target);
        renderWindow();
      };
      go();
      // Heights settle as rows mount: correct once more after measurement.
      requestAnimationFrame(function () { go(); if (flash) flashRow(id); updateActiveSection(); });
      return true;
    }
    var lastVisible = "", visTimer = null;
    function maybeView() {
      if (visTimer || opts.reportVisible === false) return;
      visTimer = later(function () {
        visTimer = null;
        if (!L.ids.length || !S.fileId) return;
        layout();
        var a = indexAt(scroller.scrollTop), b = indexAt(scroller.scrollTop + scroller.clientHeight);
        var ids = L.ids.slice(a, Math.min(b + 1, a + 500));
        var key = ids.join(",");
        if (key === lastVisible) return;
        lastVisible = key;
        aquilla.editor.visible(S.fileId, ids).catch(noop);
      }, 200);
    }
    L.scrollToCell = scrollToCell;
    L.firstVisibleId = firstVisibleId;
    L.visibleIds = function () { return L.ids.slice(Math.max(0, L.start), L.end + 1); };
    L.has = function (id) { return has(L.index, id); };
    L.layout = layout;
    scroller.scrollToCell = scrollToCell;
    scroller.firstVisibleId = firstVisibleId;
    scroller.visibleIds = L.visibleIds;
    scroller.refresh = function () { rebuild(); };
    later(function () { if (S.ids.length || !S.loading || S.failed) rebuild(); }, 0);
    return scroller;
  }
  function listFor(id) { return LISTS.filter(function (L) { return L.scroller.isConnected && L.has(id); })[0] || null; }
  /** Scroll a cell into view (in whichever list or view shows it). */
  function scrollToCell(id, block, flash) {
    var L = listFor(id);
    if (L) return L.scrollToCell(id, block, flash);
    var n = doc.querySelector('[data-cell-id="' + String(id).replace(/"/g, "") + '"]');
    if (!n) return false;
    n.scrollIntoView({ block: block === "center" ? "center" : block === "nearest" ? "nearest" : "start" });
    if (flash) flashRow(id);
    return true;
  }
  function firstVisibleId() {
    var L = LISTS.filter(function (x) { return x.scroller.isConnected; })[0];
    return L ? L.firstVisibleId() : S.ids[0] || null;
  }
  function flashRow(id) {
    var n = doc.querySelector('[data-cell-id="' + String(id).replace(/"/g, "") + '"]');
    var row = n && (n.querySelector(".row") || n);
    if (!row) return;
    row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash");
  }
  function reveal(id, focus) {
    if (!has(S.index, id)) { S.pendingReveal = id; return false; }
    S.pendingReveal = null;
    scrollToCell(id, "center", true);
    if (focus) later(function () { if (!activate(id)) focusRow(id); }, 40);
    return true;
  }
  function focusRow(id) {
    var n = doc.querySelector('[data-cell-id="' + String(id).replace(/"/g, "") + '"] [data-grid-row]');
    if (n) n.focus();
    return !!n;
  }

  // ── Chrome ───────────────────────────────────────────────────────────────
  var chromeW = 0;
  aquilla.on("editor.chrome", function (e) { chromeW = e.trailingWidth || 0; Array.prototype.forEach.call(doc.querySelectorAll(".chrome-pad"), padChrome); });
  function padChrome(pad) {
    // The host's overlay includes its own 8px end inset, which the row's
    // padding already provides.
    pad.style.minWidth = chromeW ? Math.max(0, chromeW - 8) + "px" : "0px";
  }
  /** The chapter row: your controls at the start, room for the host's own
   *  buttons (drawn over the frame on editor mounts) at the end. */
  function Toolbar(opts) {
    opts = opts || {};
    var pad = el("div", { class: "chrome-pad" });
    padChrome(pad);
    return el("div", { class: "chapter-row", "data-testid": "editor-chapter-row" }, [
      el("div", { class: "fill", "aria-hidden": "true" }),
      el("div", { class: "slot" }, opts.start || opts.children || []),
      opts.end ? el("div", { class: "tb-end" }, opts.end) : null,
      pad,
    ]);
  }
  function ReadOnlyBanner() {
    var slot = el("div", { class: "aq-banner" });
    return bindCell("*", slot, function () {
      slot.textContent = "";
      if (S.readOnly || (S.cfg && !S.cfg.canEdit)) slot.appendChild(el("div", { class: "readonly-banner", role: "status" }, [icon("lock", "s35"), t("extensions.editor.readOnly")]));
    });
  }
  function ColumnHeader() {
    var head = el("div", { class: "col-head" });
    var lastKey = null;
    return bindCell("*", head, function () {
      if (!S.cfg) return;
      var c = S.cfg, audioCol = S.audioVal && S.audioVal.column !== "off" ? true : ctx.mount !== "editor" && Object.keys(S.audio).length > 0;
      var chapters = S.sections.length && S.sections.every(function (x) { return /chapter|preface/.test(x.kind); });
      var key = [c.sourceLabel, c.targetLabel, c.activeLane, (c.lanes || []).map(function (l) { return l.tag + l.label; }).join(","), audioCol, chapters, c.canManageLanes].join("|");
      if (key === lastKey) return;
      lastKey = key;
      head.textContent = "";
      head.appendChild(el("div", { class: "marks", "data-testid": "table-gutter-marks" }, [
        el("span", { class: "m5", role: "img", "aria-label": t("editor.gutter.select") }, [icon("square-check", "s3")]),
        el("div", { class: "mrest" }, [
          el("span", { class: "m5", role: "img", "aria-label": t("editor.gutter.notices") }, [icon("flag", "s3")]),
          el("span", { class: "m1", role: "img", "aria-label": t(chapters ? "editor.gutter.verseNumber" : "editor.gutter.cellNumber") }, [icon("hash", "s3")]),
        ]),
      ]));
      head.appendChild(el("div", { class: "ch-src" }, [el("span", { text: t("editor.column.source") }), el("span", { class: "chip", text: c.sourceLabel })]));
      var active = (c.lanes || []).filter(function (l) { return l.tag === c.activeLane; })[0];
      var laneBtn = el("button", { class: "chip", type: "button", "data-testid": "lane-switcher", "aria-label": t("editor.lane.activeAria"), "aria-haspopup": "listbox",
        onclick: function () { openLanePicker(laneBtn); } }, [active ? active.label : c.targetLabel, icon("chevron-down", "s3")]);
      head.appendChild(el("div", { class: "ch-tgt", "data-testid": "table-target-header" }, [
        el("span", { class: "checks", "data-testid": "table-check-marks", "aria-hidden": "true" }, [el("span", {}, [icon("type", "s35")])].concat(
          audioCol ? [el("span", {}, [icon("audio-lines", "s35")])] : [])),
        el("span", { text: t("editor.column.target") }),
        laneBtn,
      ]));
    });
  }
  function openLanePicker(anchor) {
    var c = S.cfg;
    var list = el("div", { class: "menu", role: "listbox", "aria-label": t("editor.lane.activeAria") });
    (c.lanes || []).forEach(function (l) {
      list.appendChild(el("button", { class: "mi", type: "button", role: "option", "aria-selected": l.tag === c.activeLane ? "true" : "false",
        onclick: function () { closePop(); aquilla.editor.setLane(S.fileId, l.tag).catch(function (err) { toast(errText(err)); }); } },
        [icon(l.tag === c.activeLane ? "check" : "languages", "s35"), l.label + (l.code ? "  ·  " + l.code : "")]));
    });
    list.appendChild(el("div", { class: "sep" }));
    list.appendChild(el("button", { class: "mi sm", type: "button", "data-testid": "edit-target-language", onclick: function () { closePop(); aquilla.editor.openSettings("target-language").catch(noop); } },
      [icon("languages", "s35"), t("editor.lane.changeTargetLanguageItem")]));
    if (c.canManageLanes) list.appendChild(el("button", { class: "mi sm", type: "button", "data-testid": "add-lane", onclick: function () { closePop(); aquilla.editor.openSettings("lanes").catch(noop); } },
      [icon("plus", "s35"), t("editor.lane.addLaneItem")]));
    popover(anchor, list, { role: "listbox", align: "start" });
  }

  // ── ChapterPicker (the built-in's milestone navigator) ───────────────────
  var nav = { activeIdx: -1 };
  function ChapterPicker(opts) {
    opts = opts || {};
    var slot = el("div", { class: "aq-nav" });
    return bindCell("*", slot, function () {
      slot.textContent = "";
      if (!S.sections.length) return;
      var i = Math.max(0, nav.activeIdx);
      var sec = S.sections[i];
      var vocab = vocabOf(sec.kind);
      var prev = el("button", { class: "btn-o sq", type: "button", "aria-label": t("editor.milestone." + vocab + ".previous"), onclick: function () { goSection(i - 1); } }, [icon("chevron-left")]);
      var next = el("button", { class: "btn-o sq", type: "button", "aria-label": t("editor.milestone." + vocab + ".next"), onclick: function () { goSection(i + 1); } }, [icon("chevron-right")]);
      prev.disabled = i <= 0; next.disabled = i >= S.sections.length - 1;
      var group;
      var trig = el("button", { class: "btn-o ms-trigger", type: "button", "aria-haspopup": "listbox", "aria-label": t("editor.milestone." + vocab + ".current", { label: sec.label }),
        onclick: function () { openPicker(group); } }, [
        el("span", { class: "lbl" }, [el("b", { text: sec.label }), el("span", { text: sec.description })]),
        icon("chevron-down"),
      ]);
      group = el("div", { class: "bgroup" }, [prev, trig, next]);
      slot.appendChild(el("div", { class: "navw" }, [el("nav", { "aria-label": t("editor.milestone.region") }, [group])]));
      if (opts.pericopes !== false && S.pericopes.length) {
        var pb = el("button", { class: "btn-g", type: "button", "aria-haspopup": "dialog", onclick: function () { openPericopes(pb); } }, [icon("sparkles", "s35"), t("editor.pericope.trigger")]);
        slot.appendChild(pb);
      }
    });
  }
  function openPericopes(anchor) {
    var box = el("div", { class: "menu", style: { width: "288px", padding: "8px" } }, [el("div", { class: "k", style: { padding: "0 8px 4px", "font-size": "12px", "font-weight": "500", color: "var(--muted-foreground)" }, text: t("editor.pericope.heading") })]);
    S.pericopes.forEach(function (p) {
      box.appendChild(el("button", { class: "mi", type: "button", style: { "flex-direction": "column", "align-items": "flex-start", gap: "2px" }, onclick: function () { closePop(); scrollToCell(p.cellId, "start", true); } },
        [el("span", { style: { "font-size": "14px", "font-weight": "500", "font-variant-numeric": "tabular-nums" }, text: p.label }), el("span", { style: { "font-size": "12px", color: "var(--muted-foreground)" }, text: p.detail })]));
    });
    popover(anchor, box, { align: "start" });
  }
  function vocabOf(kind) {
    return { chapter: "chapter", "chapter-range": "chapter", preface: "chapter", slide: "slide", story: "story", section: "section", "time-range": "timeRange", part: "part", group: "group" }[kind] || "milestone";
  }
  function pct(part, total) { if (!total) return 0; var p = Math.floor((part / total) * 100); return part < total && p === 100 ? 99 : p; }
  function openPicker(anchor) {
    var vocab = vocabOf(S.sections[0] && S.sections[0].kind);
    var input = el("input", { type: "text", placeholder: t("editor.milestone." + vocab + ".findPlaceholder"), "aria-label": t("editor.milestone." + vocab + ".find") });
    var list = el("div", { class: "list", role: "listbox" });
    var box = el("div", { class: "picker" }, [el("div", { class: "search" }, [icon("search", "s4 muted"), input]), list]);
    var hl = -1, shown = [];
    function draw() {
      var q = input.value.trim().toLowerCase();
      list.textContent = "";
      shown = S.sections.map(function (s, i) { return { s: s, i: i }; }).filter(function (x) {
        return !q || (x.s.label + " " + x.s.shortLabel + " " + x.s.description).toLowerCase().indexOf(q) >= 0;
      });
      if (!shown.length) { list.appendChild(el("div", { class: "empty", text: t("editor.milestone." + vocab + ".empty") })); return; }
      shown.forEach(function (x, k) {
        var s = x.s;
        list.appendChild(el("button", { class: "item", type: "button", role: "option", "aria-selected": x.i === nav.activeIdx ? "true" : "false", "data-hl": k === hl ? "" : null,
          onclick: function () { closePop(); goSection(x.i); } }, [
          el("span", { class: "t" }, [el("b", { text: s.label }), el("span", { text: s.description })]),
          el("span", { class: "prog" }, [
            el("div", { class: "tr", title: t("editor.milestone.percentTranslated", { percent: pct(s.translated, s.total) }) }, [icon("languages", "s3"), pct(s.translated, s.total) + "%"]),
            el("div", { class: "va", title: t("editor.milestone.percentValidated", { percent: pct(s.validated, s.total) }) }, [icon("check-check", "s3"), pct(s.validated, s.total) + "%"]),
          ]),
          x.i === nav.activeIdx ? icon("check", "s4") : el("span", { style: { width: "16px" } }),
        ]));
      });
    }
    input.addEventListener("input", function () { hl = 0; draw(); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); hl = Math.min(shown.length - 1, hl + 1); draw(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); hl = Math.max(0, hl - 1); draw(); }
      else if (e.key === "Enter" && shown[Math.max(0, hl)]) { e.preventDefault(); closePop(); goSection(shown[Math.max(0, hl)].i); }
    });
    draw();
    popover(anchor, box, { role: "dialog", align: innerWidth >= 1024 ? "center" : "start" });
    input.focus();
    var active = list.querySelector('[aria-selected="true"]');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: "center" });
  }
  function goSection(i) {
    var sec = S.sections[i];
    if (!sec) return;
    nav.activeIdx = i;
    notifyFile();
    scrollToCell(sec.firstCellId, "start", false);
  }
  function updateActiveSection() {
    if (!S.sections.length) return;
    var top = firstVisibleId();
    if (!top) return;
    var idx = has(S.sectionIdx, top) ? S.sectionIdx[top] : nav.activeIdx;
    if (idx !== nav.activeIdx) { nav.activeIdx = idx; notifyFile(); }
  }
  listen("file", function () { if (nav.activeIdx < 0 && S.sections.length) updateActiveSection(); });
`
