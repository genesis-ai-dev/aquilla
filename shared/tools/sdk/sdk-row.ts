/**
 * Aquilla extension SDK — part 7: CellMenu (the overflow actions) and
 * CellRow, the built-in editor's row assembled from the cell components
 * (gutter, source surface, target column, action rail, details panel).
 */
export const SDK_ROW = String.raw`
  // ── CellMenu: the overflow actions (record, play, voice, footnote, …) ────
  function cellMenuItems(id) {
    var c = S.byId[id], st = cellState(id), items = [];
    if (st.editable) items.push({ key: "record", icon: "mic", label: t("editor.audio.record"), run: function () { actions.recordAudio(id); } });
    if (st.hasAudio) items.push({ key: "play", icon: "play", label: t("editor.audio.play"), run: function () { actions.playAudio(id); }, dot: "emerald" });
    if (st.editable) items.push({ key: "voice", icon: "volume-2", label: st.hasText ? t("sdk.voice") : t("editor.voice.nothingToReadTooltip"), run: function () { generateVoice(id); }, disabled: !st.hasText });
    if (st.editable) items.push({ key: "footnote", icon: "notebook-pen", label: t("editor.footnote.add"), run: function () { addFootnote(id); } });
    items.push({ key: "attach", icon: "paperclip", label: t("editor.attachments.attach"), run: function () { actions.openAttachments(id); } });
    items.push({ key: "comments", icon: "message-circle", label: st.comments > 0 ? t("editor.comments.open", { count: st.comments }) : t("editor.cell.addComment"), run: function () { actions.openComments(id); }, dot: st.comments > 0 ? "primary" : null });
    items.push({ key: "history", icon: "history", label: t("agentWorkspace.editHistory"), run: function () { actions.openHistory(id); } });
    void c;
    return items;
  }
  function openCellMenu(id, anchor, items) {
    var box = el("div", { class: "overflow" });
    (items || cellMenuItems(id)).forEach(function (it) {
      var b = el("button", { class: "rbtn", type: "button", "aria-label": it.label, "data-tooltip": it.label, onclick: function (e) { e.stopPropagation(); closePop(); it.run(); } }, [icon(it.icon, "s35")]);
      if (it.disabled) b.disabled = true;
      if (it.dot) b.appendChild(el("span", { class: "dot " + it.dot, "aria-hidden": "true" }));
      box.appendChild(tip(b, it.label));
    });
    popover(anchor, box, { side: "bottom", align: "end", role: "menu" });
  }

  // ── CellRow: the built-in editor's row ───────────────────────────────────
  /** opts: select / badges / number (gutter parts, default on), menu(id, items)
   *  to change the overflow items, details(id) → node for the expansion
   *  panel (omit for no chevron), actions(id) → node for the rail (default
   *  DraftActions), target(id) → node for the well (default TargetEditor). */
  function CellRow(id, opts) {
    opts = opts || {};
    var c = S.byId[id] || { cellId: id };
    var wrap = el("div", { class: "cell", role: "listitem", "data-cell-id": id, "data-ref": c.ref || "" });
    if (c.paragraphStart && S.index[id] > 0) {
      wrap.setAttribute("data-paragraph-start", "true");
      var pb = el("div", { class: "pbar", "data-testid": "paragraph-boundary-indicator" }, [el("div", {}, [icon("pilcrow", "s3")])]);
      tip(pb.firstChild, t("editor.row.newParagraph"));
      wrap.appendChild(pb);
    }
    var row = el("div", { class: "row", "data-grid-row": "", tabindex: "0", "aria-label": t("editor.row.cellAria", { ref: cellRef(c) }) });
    row.appendChild(HealthRibbon(id, { mobile: true }));
    wrap.appendChild(row);
    row.appendChild(el("div", { class: "gutter" }, [
      el("div", { class: "g-sel" }, [el("div", { class: "g-sp" }), opts.select === false ? null : SelectBox(id)]),
      el("div", { class: "g-bn" }, [
        el("div", { class: "g-badges", "data-testid": "gutter-status-badges" }, [el("div", { class: "g-sp" }), opts.badges === false ? el("div", { class: "stack" }) : StatusBadges(id)]),
        el("div", { class: "g-num" }, [el("div", { class: "g-sp", "data-testid": "gutter-strip-spacer" }), el("div", { class: "line" }, [opts.number === false ? null : CellNumber(id)])]),
      ]),
    ]));
    row.appendChild(SourceText(id));
    var head = el("div", { class: "lane", "data-testid": "target-header-lane" }, [el("span", { class: "aq-slot lblslot" }), PresenceStack(id)]);
    bindCell(id, head.firstChild, function () {
      var cc = S.byId[id], slot = head.firstChild;
      var want = cfg().cellLabels && cc && cc.label ? cc.label : "";
      if (slot.textContent === want) return;
      slot.textContent = "";
      if (want) slot.appendChild(el("span", { style: { "max-width": "60%" }, class: "lbl", text: want }));
    });
    var tcol = el("div", { class: "tcol", "data-editor-cell-surface": "target-column", dir: "ltr" }, [
      HealthRibbon(id), head, el("div", { class: "tbody" }, [ValidateButton(id), opts.target ? opts.target(id) : TargetEditor(id)]), CellNotes(id),
    ]);
    row.appendChild(tcol);
    bindCell(id, tcol, function () { tcol.style.fontSize = cfg().targetFontSize + "px"; tcol.style.lineHeight = "1.6"; });

    // Action rail: primary actions, overflow, details chevron.
    var more = el("button", { class: "rbtn", type: "button", "data-slot": "cell-action-rail-overflow", "aria-label": t("editor.rail.moreActions"),
      onclick: function (e) { e.stopPropagation(); var items = cellMenuItems(id); openCellMenu(id, more, opts.menu ? opts.menu(id, items) : items); } }, [icon("ellipsis", "s35")]);
    tip(more, t("editor.rail.moreActions"));
    var chev = el("button", { class: "rbtn", type: "button", "aria-expanded": "false", onclick: function (e) { e.stopPropagation(); toggleDetails(id); } }, [icon("chevron-down", "s35")]);
    tip(chev, function () { return S.expanded[id] ? t("editor.cell.closeDetails") : t("sdk.openDetails"); });
    var rail = el("div", { class: "rail", "data-slot": "cell-action-rail" }, [opts.actions ? opts.actions(id) : DraftActions(id), more, opts.details ? el("div", { class: "chev" }, [chev]) : null]);
    row.appendChild(el("div", { class: "railw" }, [rail]));
    var exp = el("div", { class: "exp", hidden: true });
    wrap.appendChild(exp);
    bindCell(id, rail, function () {
      var st = cellState(id);
      var od = more.querySelector(".dot"); if (od) od.remove();
      if (st.comments > 0) more.appendChild(el("span", { class: "dot primary", "aria-hidden": "true" }));
      else if (st.hasAudio) more.appendChild(el("span", { class: "dot emerald", "aria-hidden": "true" }));
      var cd = chev.querySelector(".dot"); if (cd) cd.remove();
      var dot = st.major ? "red" : st.liveIssues.length || (st.bt && st.bt.stale) ? "amber" : null;
      if (dot) chev.appendChild(el("span", { class: "dot " + dot, "aria-hidden": "true" }));
      if (chev.parentNode) chev.parentNode.classList.toggle("open", st.expanded);
      chev.setAttribute("aria-expanded", st.expanded ? "true" : "false");
      chev.setAttribute("aria-label", st.expanded ? t("editor.cell.closeDetails") : t("sdk.openDetails"));
      // Row state classes
      row.classList.toggle("selected", st.selected);
      row.classList.toggle("has-comments", st.comments > 0);
      row.classList.toggle("drafting", st.drafting);
      row.classList.toggle("expanded", st.expanded);
      row.classList.toggle("hidden-cell", !!(st.cell && st.cell.hidden));
      row.setAttribute("data-ai-translating", st.drafting ? "true" : "false");
      // Details panel
      if (st.expanded && opts.details) { exp.textContent = ""; exp.appendChild(opts.details(id)); exp.hidden = false; }
      else if (!exp.hidden) { exp.hidden = true; exp.textContent = ""; }
    });

    function railOn(on) { rail.classList.toggle("on", on); rail.setAttribute("data-revealed", on ? "true" : "false"); }
    rail.setAttribute("data-revealed", "false");
    row.addEventListener("mouseenter", function () { railOn(true); });
    row.addEventListener("mouseleave", function () { if (!row.contains(doc.activeElement)) railOn(false); });
    row.addEventListener("focusin", function () { railOn(true); if (S.focusRowId !== id) { S.focusRowId = id; aquilla.presence.view(S.fileId, id).catch(noop); } });
    row.addEventListener("focusout", function (e) { if (!row.contains(e.relatedTarget)) railOn(false); });
    row.addEventListener("click", function (e) { if (e.metaKey || e.ctrlKey) { e.preventDefault(); toggleSelect(id); } });
    row.addEventListener("keydown", function (e) { onRowKey(id, row, e); });
    return wrap;
  }
  function toggleDetails(id, open) {
    var next = open === undefined ? !S.expanded[id] : !!open;
    if (next) S.expanded[id] = 1; else delete S.expanded[id];
    notify([id]);
    if (next && !S.bts[id] && cfg().backtranslation.configured) loadBts();
  }
  function onRowKey(id, row, e) {
    if (e.target !== row) return;
    var k = e.key;
    if (k === "ArrowDown" || k === "j" || k === "ArrowUp" || k === "k") {
      e.preventDefault();
      var ids = navIds(), i = ids.indexOf(id), next = ids[i + (k === "ArrowDown" || k === "j" ? 1 : -1)];
      if (next) { scrollToCell(next, "nearest", false); later(function () { focusRow(next); }, 0); }
    } else if (k === "Enter") { e.preventDefault(); activate(id); }
    else if (k === "Escape" && S.selCount) { e.preventDefault(); clearSelection(); }
  }
`
