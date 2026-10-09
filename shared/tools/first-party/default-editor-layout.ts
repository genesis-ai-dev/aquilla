/**
 * First-party editor extension — part 2/5: the chrome (chapter row with the
 * milestone navigator, column header with the lane switcher) and the
 * virtualized row list (windowed rendering with measured heights and scroll
 * anchoring, like the built-in's LegendList).
 */
export const EDITOR_LAYOUT = String.raw`
  // ── Chrome ────────────────────────────────────────────────────────────────
  function frame() {
    doc.body.textContent = "";
    var row = el("div", { class: "chapter-row", id: "chapter-row", "data-testid": "editor-chapter-row" }, [
      el("div", { class: "fill", "aria-hidden": "true" }),
      el("div", { class: "slot", id: "nav-slot" }),
      el("div", { class: "chrome-pad", id: "chrome-pad" }),
    ]);
    doc.body.appendChild(row);
    doc.body.appendChild(el("div", { id: "banner-slot" }));
    doc.body.appendChild(el("div", { class: "col-head", id: "col-head" }));
    var scroller = el("div", { id: "scroller", role: "list", "aria-label": "Cells" }, [el("div", { id: "rows" })]);
    doc.body.appendChild(scroller);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    $("rows").appendChild(el("div", { class: "empty-state" }, [icon("loader-circle", "spin"), t("common.loading")]));
    renderChromePad();
  }
  function renderChromePad() {
    var pad = $("chrome-pad");
    // The host's overlay includes its own 8px end inset, which this row's
    // padding already provides.
    if (pad) pad.style.minWidth = S.chromeW ? Math.max(0, S.chromeW - 8) + "px" : "0px";
  }
  aquilla.on("editor.chrome", function (e) { S.chromeW = e.trailingWidth || 0; renderChromePad(); });

  function renderBanner() {
    var slot = $("banner-slot");
    if (!slot) return;
    slot.textContent = "";
    if (S.readOnly || (S.cfg && !S.cfg.canEdit)) {
      slot.appendChild(el("div", { class: "readonly-banner", role: "status" }, [icon("lock", "s35"), t("extensions.editor.readOnly")]));
    }
  }

  function renderHeader() {
    var head = $("col-head");
    if (!head || !S.cfg) return;
    head.textContent = "";
    var marks = el("div", { class: "marks", "data-testid": "table-gutter-marks" }, [
      el("span", { class: "m5", role: "img", "aria-label": t("editor.gutter.select") }, [icon("square-check", "s3")]),
      el("div", { class: "mrest" }, [
        el("span", { class: "m5", role: "img", "aria-label": t("editor.gutter.notices") }, [icon("flag", "s3")]),
        el("span", { class: "m1", role: "img", "aria-label": t(S.sections.length && S.sections.every(function (x) { return /chapter|preface/.test(x.kind); }) ? "editor.gutter.verseNumber" : "editor.gutter.cellNumber") }, [icon("hash", "s3")]),
      ]),
    ]);
    head.appendChild(marks);
    head.appendChild(el("div", { class: "ch-src" }, [el("span", { text: t("editor.column.source") }), el("span", { class: "chip", text: S.cfg.sourceLabel })]));
    var lanes = S.cfg.lanes || [];
    var active = lanes.filter(function (l) { return l.tag === S.cfg.activeLane; })[0];
    var laneBtn = el("button", { class: "chip", type: "button", "data-testid": "lane-switcher", "aria-label": t("editor.lane.activeAria"), "aria-haspopup": "listbox",
      onclick: function () { openLanePicker(laneBtn); } }, [active ? active.label : S.cfg.targetLabel, icon("chevron-down", "s3")]);

    head.appendChild(el("div", { class: "ch-tgt", "data-testid": "table-target-header" }, [
      el("span", { class: "checks", "data-testid": "table-check-marks", "aria-hidden": "true" }, [el("span", {}, [icon("type", "s35")])].concat(
        hasAudioColumn() ? [el("span", {}, [icon("audio-lines", "s35")])] : [])),
      el("span", { text: t("editor.column.target") }),
      laneBtn,
    ]));
  }
  function hasAudioColumn() { return Object.keys(S.audio).length > 0; }
  function openLanePicker(anchor) {
    var list = el("div", { class: "menu", role: "listbox", "aria-label": t("editor.lane.activeAria") });
    (S.cfg.lanes || []).forEach(function (l) {
      list.appendChild(el("button", { class: "mi", type: "button", role: "option", "aria-selected": l.tag === S.cfg.activeLane ? "true" : "false",
        onclick: function () { closePop(); aquilla.editor.setLane(S.fileId, l.tag).catch(function (err) { toast(errText(err)); }); } },
        [icon(l.tag === S.cfg.activeLane ? "check" : "languages", "s35"), l.label + (l.code ? "  ·  " + l.code : "")]));
    });
    list.appendChild(el("div", { class: "sep" }));
    list.appendChild(el("button", { class: "mi sm", type: "button", "data-testid": "edit-target-language", onclick: function () { closePop(); aquilla.editor.openSettings("target-language").catch(function () {}); } },
      [icon("languages", "s35"), t("editor.lane.changeTargetLanguageItem")]));
    if (S.cfg.canManageLanes) list.appendChild(el("button", { class: "mi sm", type: "button", "data-testid": "add-lane", onclick: function () { closePop(); aquilla.editor.openSettings("lanes").catch(function () {}); } },
      [icon("plus", "s35"), t("editor.lane.addLaneItem")]));
    popover(anchor, list, { role: "listbox", align: "start" });
  }

  // ── Milestone navigator (ChapterNavigator) ─────────────────────────────────
  var nav = { activeIdx: -1 };
  function renderNav() {
    var slot = $("nav-slot");
    if (!slot) return;
    slot.textContent = "";
    if (!S.sections.length) return;
    var i = Math.max(0, nav.activeIdx);
    var sec = S.sections[i];
    var vocab = vocabOf(sec.kind);
    var prev = el("button", { class: "btn-o sq", type: "button", "aria-label": t("editor.milestone." + vocab + ".previous"), onclick: function () { goSection(i - 1); } }, [icon("chevron-left")]);
    var next = el("button", { class: "btn-o sq", type: "button", "aria-label": t("editor.milestone." + vocab + ".next"), onclick: function () { goSection(i + 1); } }, [icon("chevron-right")]);
    prev.disabled = i <= 0; next.disabled = i >= S.sections.length - 1;
    var trig = el("button", { class: "btn-o ms-trigger", type: "button", "aria-haspopup": "listbox", "aria-label": t("editor.milestone." + vocab + ".current", { label: sec.label }),
      onclick: function () { openPicker(group); } }, [
      el("span", { class: "lbl" }, [el("b", { text: sec.label }), el("span", { text: sec.description })]),
      icon("chevron-down"),
    ]);
    var group = el("div", { class: "bgroup" }, [prev, trig, next]);
    slot.appendChild(el("nav", { "aria-label": t("editor.milestone.region") }, [group]));
    if (S.pericopes.length) {
      var pb = el("button", { class: "btn-g", type: "button", "aria-haspopup": "dialog", onclick: function () { openPericopes(pb); } }, [icon("sparkles", "s35"), t("editor.pericope.trigger")]);
      slot.appendChild(pb);
    }
  }
  function openPericopes(anchor) {
    var box = el("div", { class: "menu", style: { width: "288px", padding: "8px" } }, [el("div", { class: "k", style: { padding: "0 8px 4px", "font-size": "12px", "font-weight": "500", color: "var(--muted-foreground)" }, text: t("editor.pericope.heading") })]);
    S.pericopes.forEach(function (p) {
      box.appendChild(el("button", { class: "mi", type: "button", style: { "flex-direction": "column", "align-items": "flex-start", gap: "2px" }, onclick: function () { closePop(); scrollToCell(p.cellId, "start", true); } },
        [el("span", { style: { "font-size": "14px", "font-weight": "500", "font-variant-numeric": "tabular-nums" }, text: p.label }), el("span", { style: { "font-size": "12px", color: "var(--muted-foreground)" }, text: p.detail })]));
    });
    popover(anchor, box, { align: "start" });
  }
  function loadPericopes() {
    return aquilla.cells.pericopes(S.fileId).then(function (list) { S.pericopes = list || []; renderNav(); }, function () {});
  }
  aquilla.on("pericopes.changed", function (e) { if (!e.fileId || e.fileId === S.fileId) loadPericopes(); });
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
        var item = el("button", { class: "item", type: "button", role: "option", "aria-selected": x.i === nav.activeIdx ? "true" : "false", "data-hl": k === hl ? "" : null,
          onclick: function () { closePop(); goSection(x.i); } }, [
          el("span", { class: "t" }, [el("b", { text: s.label }), el("span", { text: s.description })]),
          el("span", { class: "prog" }, [
            el("div", { class: "tr", title: t("editor.milestone.percentTranslated", { percent: pct(s.translated, s.total) }) }, [icon("languages", "s3"), pct(s.translated, s.total) + "%"]),
            el("div", { class: "va", title: t("editor.milestone.percentValidated", { percent: pct(s.validated, s.total) }) }, [icon("check-check", "s3"), pct(s.validated, s.total) + "%"]),
          ]),
          x.i === nav.activeIdx ? icon("check", "s4") : el("span", { style: { width: "16px" } }),
        ]);
        list.appendChild(item);
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
    renderNav();
    scrollToCell(sec.firstCellId, "start", false);
  }
  function updateActiveSection() {
    if (!S.sections.length) return;
    var top = firstVisibleId();
    if (!top) return;
    var idx = has(S.sectionIdx, top) ? S.sectionIdx[top] : nav.activeIdx;
    if (idx !== nav.activeIdx) { nav.activeIdx = idx; renderNav(); }
  }
  function indexSections() {
    S.sectionIdx = Object.create(null);
    S.sections.forEach(function (s, i) { s.cellIds.forEach(function (id) { S.sectionIdx[id] = i; }); });
  }

  // ── Virtualized list ─────────────────────────────────────────────────────
  // Rows render only inside the viewport ± OVERSCAN; heights are measured as
  // rows mount and estimated (by text length) before that. When a row above
  // the viewport changes height, scrollTop is corrected so nothing jumps.
  var V = { heights: Object.create(null), offsets: [], total: 0, dirty: true, start: 0, end: -1, nodes: Object.create(null), mounted: Object.create(null), raf: 0 };
  var OVERSCAN = 900;
  function estimate(id) {
    var c = S.byId[id];
    if (!c) return 120;
    var len = Math.max((c.source || "").length, (c.target || "").length);
    var w = Math.max(240, (($("scroller") || doc.body).clientWidth - 140) / (innerWidth >= 768 ? 2 : 1));
    var lines = Math.max(1, Math.ceil((len * 7.4) / w));
    return 16 + 20 + Math.max(40, 12 + lines * 22.4) + (c.paragraphStart ? 12 : 0);
  }
  function heightOf(id) { return has(V.heights, id) ? V.heights[id] : estimate(id); }
  function layout() {
    if (!V.dirty) return;
    var acc = 0;
    V.offsets = new Array(S.ids.length);
    for (var i = 0; i < S.ids.length; i++) { V.offsets[i] = acc; acc += heightOf(S.ids[i]); }
    V.total = acc;
    V.dirty = false;
  }
  function indexAt(y) {
    var lo = 0, hi = S.ids.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (V.offsets[mid] <= y) lo = mid; else hi = mid - 1; }
    return lo;
  }
  function firstVisibleId() {
    var sc = $("scroller");
    if (!sc || !S.ids.length) return null;
    layout();
    return S.ids[indexAt(sc.scrollTop + 1)];
  }
  var ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(function (entries) {
    var sc = $("scroller"), shift = 0, anchorTop = sc ? sc.scrollTop : 0;
    layout();
    entries.forEach(function (en) {
      var id = en.target.getAttribute("data-cell-id");
      if (!id || !en.target.isConnected) return;
      var h = en.target.offsetHeight;
      if (!h || V.heights[id] === h) return;
      var before = heightOf(id);
      V.heights[id] = h;
      if (sc && V.offsets[S.index[id]] < anchorTop - 1) shift += h - before;
      V.dirty = true;
    });
    if (V.dirty) {
      layout();
      $("rows").style.height = V.total + "px";
      positionMounted();
      if (shift && sc) sc.scrollTop = anchorTop + shift;
    }
  }) : null;
  function onScroll() {
    if (V.raf) return;
    V.raf = requestAnimationFrame(function () { V.raf = 0; renderWindow(); updateActiveSection(); maybeView(); });
  }
  function positionMounted() {
    Object.keys(V.mounted).forEach(function (id) {
      var n = V.mounted[id];
      n.style.transform = "translateY(" + V.offsets[S.index[id]] + "px)";
    });
  }
  function renderWindow() {
    var sc = $("scroller"), rows = $("rows");
    if (!sc || !rows || !S.ids.length) return;
    layout();
    rows.style.height = V.total + "px";
    var top = sc.scrollTop - OVERSCAN, bottom = sc.scrollTop + sc.clientHeight + OVERSCAN;
    var start = indexAt(Math.max(0, top)), end = indexAt(bottom);
    var keep = Object.create(null);
    for (var i = start; i <= end; i++) {
      var id = S.ids[i];
      keep[id] = 1;
      var n = V.mounted[id];
      if (!n) {
        n = V.nodes[id] || (V.nodes[id] = buildCell(id));
        n.style.position = "absolute"; n.style.left = "0"; n.style.right = "0"; n.style.top = "0";
        rows.appendChild(n);
        V.mounted[id] = n;
        if (ro) ro.observe(n);
        paintCell(id);
      }
      n.style.transform = "translateY(" + V.offsets[i] + "px)";
    }
    Object.keys(V.mounted).forEach(function (id) {
      if (keep[id] || id === S.activeId) return;
      var n = V.mounted[id];
      if (ro) ro.unobserve(n);
      n.remove();
      delete V.mounted[id];
    });
    // Keep a bounded cache of built rows (big books stay light).
    var built = Object.keys(V.nodes);
    if (built.length > 600) built.forEach(function (id) { if (!V.mounted[id] && built.length-- > 400) delete V.nodes[id]; });
    V.start = start; V.end = end;
    requestTerms();
  }
  function rebuildList() {
    S.index = Object.create(null);
    S.ids.forEach(function (id, i) { S.index[id] = i; });
    V.dirty = true;
    Object.keys(V.mounted).forEach(function (id) { if (!has(S.byId, id)) { V.mounted[id].remove(); delete V.mounted[id]; delete V.nodes[id]; } });
    var rows = $("rows");
    if (rows && !S.ids.length) {
      rows.textContent = "";
      rows.style.height = "";
      if (!S.loading) rows.appendChild(el("div", { class: "empty-state", text: t("extensions.editor.noCells") }));
      return;
    }
    if (rows && rows.querySelector(".empty-state")) rows.textContent = "";
    renderWindow();
  }
  function scrollToCell(id, block, flash) {
    var sc = $("scroller");
    if (!sc || !has(S.index, id)) return false;
    var go = function () {
      layout();
      var y = V.offsets[S.index[id]], h = heightOf(id);
      var target = block === "center" ? y - (sc.clientHeight - h) / 2 : block === "nearest"
        ? (y < sc.scrollTop ? y : y + h > sc.scrollTop + sc.clientHeight ? y + h - sc.clientHeight : sc.scrollTop) : y;
      sc.scrollTop = Math.max(0, target);
      renderWindow();
    };
    go();
    // Heights settle as rows mount: correct once more after measurement.
    requestAnimationFrame(function () { go(); if (flash) flashRow(id); updateActiveSection(); });
    return true;
  }
  function flashRow(id) {
    var n = V.mounted[id];
    var row = n && n.querySelector(".row");
    if (!row) return;
    row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash");
  }
  function visibleIds() { return S.ids.slice(Math.max(0, V.start), V.end + 1); }
`
