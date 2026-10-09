/**
 * First-party editor extension — part 3/5: one row, structured exactly like
 * the built-in EditorRow (gutter: select / badges / number; source surface
 * with its context lane; target column with health ribbon, header lane,
 * validation control and the target well; the floating action rail; the
 * expansion panel). buildCell() makes the DOM once, paintCell() refreshes the
 * parts that depend on live data.
 */
export const EDITOR_ROWS = String.raw`
  function cellRef(c) { return c.ref || (c.label) || t("editor.row.rowFallbackRef", { index: (S.index[c.cellId] || 0) + 1 }); }
  function isStructural(c) { return c.type === "heading" || c.type === "paratext"; }
  function editableCell(c) { return !!(S.cfg && S.cfg.canEdit && !S.readOnly && !S.locks[c.cellId]); }

  function buildCell(id) {
    var c = S.byId[id];
    var wrap = el("div", { class: "cell", role: "listitem", "data-cell-id": id, "data-ref": c.ref || "" });
    if (c.paragraphStart && S.index[id] > 0) {
      wrap.setAttribute("data-paragraph-start", "true");
      var pb = el("div", { class: "pbar", "data-testid": "paragraph-boundary-indicator" }, [el("div", {}, [icon("pilcrow", "s3")])]);
      tip(pb.firstChild, t("editor.row.newParagraph"));
      wrap.appendChild(pb);
    }
    var row = el("div", { class: "row", "data-grid-row": "", tabindex: "0", "aria-label": t("editor.row.cellAria", { ref: cellRef(c) }) });
    wrap.appendChild(row);

    // Gutter: select · badges · number
    var sel = el("button", { class: "sel", type: "button", role: "checkbox", "aria-checked": "false", "aria-label": t("editor.row.selectAria") }, [el("span", { class: "dot" })]);
    sel.addEventListener("pointerdown", function (e) { onSelectPointerDown(id, e); });
    sel.addEventListener("click", function (e) { e.stopPropagation(); });
    tip(sel, function () { return S.selection[id] ? t("editor.row.selectedTooltip") : t("editor.row.selectTooltip"); }, "right");
    var badges = el("div", { class: "stack" });
    var num = el("span", { class: "num" });
    row.appendChild(el("div", { class: "gutter" }, [
      el("div", { class: "g-sel" }, [el("div", { class: "g-sp" }), sel]),
      el("div", { class: "g-bn" }, [
        el("div", { class: "g-badges", "data-testid": "gutter-status-badges" }, [el("div", { class: "g-sp" }), badges]),
        el("div", { class: "g-num" }, [el("div", { class: "g-sp", "data-testid": "gutter-strip-spacer" }), el("div", { class: "line" }, [num])]),
      ]),
    ]));

    // Source
    var ctxLine = el("div", { class: "lane", "data-testid": "source-context-line" });
    var srcText = el("div", { class: "txt", dir: "auto" });
    var src = el("div", { class: "src", "data-editor-cell-surface": "source", "data-cell-type": "source", "aria-label": t("editor.source.textAria") }, [ctxLine, srcText]);
    row.appendChild(src);
    srcText.addEventListener("click", function (e) { onDecoClick(id, e); });

    // Target column
    var ribbon = el("span", { class: "ribbon", "data-testid": "health-ribbon", role: "img", tabindex: "0" }, [el("i")]);
    var head = el("div", { class: "lane", "data-testid": "target-header-lane" });
    var valg = el("div", { class: "valg", "data-testid": "validation-gutter" });
    var read = el("div", { class: "read", role: "textbox", "aria-multiline": "true", "data-target-read-view": "", tabindex: "0", spellcheck: "true", "data-ph-mask": "" });
    var well = el("div", { class: "well", "data-editor-cell-surface": "target", "data-cell-type": "target" }, [read]);
    var tbody = el("div", { class: "tbody" }, [valg, well]);
    var after = el("div", { class: "after" });
    var tcol = el("div", { class: "tcol", "data-editor-cell-surface": "target-column", dir: "ltr" }, [ribbon, head, tbody, after]);
    row.appendChild(tcol);
    tip(ribbon, function () { var r = S.byId[id] && S.byId[id].ribbon; return r ? r.label : ""; }, "right");
    read.addEventListener("mousedown", function (e) { onReadMouseDown(id, e); });
    read.addEventListener("click", function (e) { e.stopPropagation(); onDecoClick(id, e) || activate(id, e); });
    read.addEventListener("keydown", function (e) { onEditorKey(id, e); });
    read.addEventListener("input", function () { onInput(id); });
    read.addEventListener("focus", function () { onEditorFocus(id); });
    read.addEventListener("blur", function () { onEditorBlur(id); });
    read.addEventListener("paste", function (e) { onPaste(id, e); });

    // Action rail
    var prim = el("div", { class: "prim" });
    var more = el("button", { class: "rbtn", type: "button", "data-slot": "cell-action-rail-overflow", "aria-label": t("editor.rail.moreActions"),
      onclick: function (e) { e.stopPropagation(); openOverflow(id, more); } }, [icon("ellipsis", "s35")]);
    tip(more, t("editor.rail.moreActions"));
    var chev = el("button", { class: "rbtn", type: "button", "aria-expanded": "false", onclick: function (e) { e.stopPropagation(); toggleExpand(id); } }, [icon("chevron-down", "s35")]);
    tip(chev, function () { return S.expanded[id] ? t("editor.cell.closeDetails") : FALLBACK["open-details"]; });
    var rail = el("div", { class: "rail", "data-slot": "cell-action-rail" }, [prim, more, el("div", { class: "chev" }, [chev])]);
    row.appendChild(el("div", { class: "railw" }, [rail]));

    var exp = el("div", { class: "exp", hidden: true });
    wrap.appendChild(exp);

    row.addEventListener("mouseenter", function () { rail.classList.add("on"); });
    row.addEventListener("mouseleave", function () { if (!row.contains(doc.activeElement)) rail.classList.remove("on"); });
    row.addEventListener("focusin", function () { rail.classList.add("on"); onRowFocus(id); });
    row.addEventListener("focusout", function (e) { if (!row.contains(e.relatedTarget)) rail.classList.remove("on"); });
    row.addEventListener("click", function (e) { if (e.metaKey || e.ctrlKey) { e.preventDefault(); toggleSelect(id); } });
    row.addEventListener("keydown", function (e) { onRowKey(id, e); });

    wrap._r = { row: row, sel: sel, badges: badges, num: num, ctx: ctxLine, srcText: srcText, src: src, ribbon: ribbon, head: head, valg: valg, read: read, well: well,
                after: after, prim: prim, more: more, chev: chev, rail: rail, exp: exp, tcol: tcol, srcKey: null, readKey: null };
    return wrap;
  }

  function R(id) { var n = V.nodes[id]; return n && n._r; }

  /** Repaint one row from S (cheap; called on any change to that cell). */
  function paintCell(id) {
    var c = S.byId[id], r = R(id);
    if (!c || !r) return;
    var issues = (S.signals.issues || {})[id] || [];
    var live = issues.filter(function (i) { return !i.waived; });
    var major = live.some(function (i) { return i.severity === "error"; });
    var ai = (S.signals.ai || {})[id];
    var drafting = !!(ai && ai.phase);
    var comments = S.comments[id] || 0;
    var lock = S.locks[id];
    var d = S.drafts[id];
    var targetPlain = d && d.dirty ? d.value : c.target;

    // Row state classes
    r.row.classList.toggle("selected", !!S.selection[id]);
    r.row.classList.toggle("has-comments", comments > 0);
    r.row.classList.toggle("drafting", drafting);
    r.row.classList.toggle("expanded", !!S.expanded[id]);
    r.row.classList.toggle("hidden-cell", !!c.hidden);
    r.row.setAttribute("data-ai-translating", drafting ? "true" : "false");
    r.sel.setAttribute("aria-checked", S.selection[id] ? "true" : "false");
    r.sel.setAttribute("aria-label", S.selection[id] ? t("editor.row.selectedAria") : t("editor.row.selectAria"));
    r.sel.innerHTML = "";
    r.sel.appendChild(S.selection[id] ? icon("check", "s3") : el("span", { class: "dot" }));

    // Badges: stale / upstream stale / formatting loss / open comments
    r.badges.textContent = "";
    var hasText = !!(c.target || "").trim();
    if (hasText && S.sig.stale[id]) {
      var st = el("span", { class: "gicon stale", role: "img", "data-testid": "stale-source-indicator", "aria-label": t("editor.stale.directLabel") }, [icon("triangle-alert", "s35")]);
      tip(st, t("editor.stale.directTooltip")); r.badges.appendChild(st);
    } else if (hasText && S.sig.upstream[id]) {
      var up = el("span", { class: "gicon upstream", role: "img", "data-testid": "upstream-stale-source-indicator", "aria-label": t("editor.stale.upstreamLabel") }, [icon("git-branch-plus", "s35")]);
      tip(up, t("editor.stale.upstreamTooltip")); r.badges.appendChild(up);
    }
    if (hasText && formattingLost(c)) {
      var fl = el("span", { class: "gicon fmt", role: "img", "data-testid": "formatting-loss-warning", "aria-label": t("editor.source.formattingLossTooltip") }, [icon("bold", "s3")]);
      tip(fl, t("editor.source.formattingLossTooltip")); r.badges.appendChild(fl);
    }
    if (comments > 0) {
      var cb = el("button", { class: "gicon comments", type: "button", "aria-label": t("editor.comments.openAria", { count: comments }), "data-comments": String(comments),
        onclick: function (e) { e.stopPropagation(); openComments(id); } }, [icon("message-circle", "s35")]);
      tip(cb, t("editor.comments.open", { count: comments })); r.badges.appendChild(cb);
    }

    // Number pill, tinted by worst live issue
    r.num.textContent = c.numberLabel || "";
    r.num.className = "num" + (major ? " major" : live.length ? " issue" : "");

    // Source context lane + text (rebuilt only when inputs change)
    var showLabel = S.cfg && S.cfg.cellLabels && c.label;
    var rep = (S.signals.repetition || {})[id];
    var srcKey = [c.source, c.sourceHtml, showLabel ? c.label : "", c.context, rep || 0, c.hidden ? 1 : 0, termKey(id, "source"), issueKey(issues, "source"), S.cfg ? S.cfg.sourceFontSize : 14].join("\u0001");
    if (srcKey !== r.srcKey) {
      r.srcKey = srcKey;
      r.ctx.textContent = "";
      r.ctx.className = "lane" + (showLabel ? " start" : "");
      if (showLabel) r.ctx.appendChild(el("span", { class: "lbl", "data-testid": "source-cell-label", dir: "auto", text: c.label }));
      if (c.context && !/^\d+:\d/.test(c.context) && c.context !== c.ref) r.ctx.appendChild(el("span", { class: "ctx", text: c.context }));
      if (rep > 1) { var rb = el("span", { class: "rep", "data-testid": "source-repetition-count", text: t("editor.repetition.badge", { count: rep }) }); tip(rb, t("editor.repetition.tooltip", { count: rep })); r.ctx.appendChild(rb); }
      if (c.hidden) r.ctx.appendChild(el("span", { "data-testid": "source-cell-hidden-badge", "aria-label": t("editor.row.hiddenBadgeAria") }, [icon("eye-off", "s35")]));
      showInto(r.srcText, c.sourceHtml, c.source);
      decorate(r.srcText, decorations(id, "source", issues));
      r.src.style.fontSize = (S.cfg ? S.cfg.sourceFontSize : 14) + "px";
      r.src.style.lineHeight = "1.6";
      r.srcText.setAttribute("dir", S.cfg && S.cfg.sourceDirection === "rtl" ? "rtl" : "auto");
    }

    // Health ribbon
    if (c.ribbon) {
      r.ribbon.hidden = false;
      r.ribbon.firstChild.style.backgroundImage = c.ribbon.background;
      r.ribbon.setAttribute("aria-label", c.ribbon.label + (major ? " · major automatic issue" : live.length ? " · automatic issue" : ""));
      r.ribbon.setAttribute("data-health-stage", c.ribbon.stage);
    } else r.ribbon.hidden = true;

    // Target header lane: label + collaborators
    r.head.textContent = "";
    if (showLabel) r.head.appendChild(el("span", { style: { "max-width": "60%" }, class: "lbl", text: c.label }));
    var peers = (S.peersByCell[id] || []);
    if (peers.length) {
      var pres = el("span", { class: "presence", "data-cell-presence": "", "data-cell-presence-state": peers.some(function (p) { return p.draftText; }) ? "typing" : peers.some(function (p) { return p.editing; }) ? "editing" : "viewing" });
      peers.slice(0, 3).forEach(function (p) {
        var a = el("span", { class: "avatar", style: { background: p.color }, title: p.username, text: initials(p.username) });
        pres.appendChild(a);
      });
      var stateText = peers.some(function (p) { return p.draftText; }) ? t("editor.presence.typing") : peers.some(function (p) { return p.editing; }) ? t("editor.presence.editing") : t("editor.presence.viewing");
      pres.appendChild(el("span", { class: "state", text: stateText }));
      r.head.appendChild(pres);
    }
    if (lock && !peers.some(function (p) { return p.username === lock; })) {
      r.head.appendChild(el("span", { "data-cell-lock-holder": "", style: { "margin-inline-start": "auto", "font-size": "10px" }, text: t("editor.presence.heldBy", { name: lock }) }));
    }

    paintValidation(id);

    // Target well
    var editing = S.activeId === id;
    var editable = editableCell(c);
    r.well.classList.toggle("empty", !(targetPlain || "").trim() && !editing);
    r.tcol.style.fontSize = (S.cfg ? S.cfg.targetFontSize : 14) + "px";
    r.tcol.style.lineHeight = "1.6";
    var aria = t("editor.row.translationAria", { ref: cellRef(c), source: (c.source || "").slice(0, 80), state: c.validated ? "validated" : hasText ? "draft" : "empty" });
    r.read.setAttribute("aria-label", lock ? aria + " — " + t("editor.row.lockedBy", { name: lock }) : aria);
    r.read.setAttribute("aria-readonly", editable ? "false" : "true");
    r.read.setAttribute("data-target-locked-by", lock || "");
    if (lock) r.read.setAttribute("title", t("editor.row.lockedBy", { name: lock })); else r.read.removeAttribute("title");
    r.read.classList.toggle("editable", editable);
    r.read.setAttribute("dir", S.cfg && S.cfg.targetDirection === "rtl" ? "rtl" : "auto");
    if (!editing) {
      r.read.setAttribute("contenteditable", "false");
      var peerDraft = peers.filter(function (p) { return p.draftText !== null && p.draftText !== undefined; })[0];
      var readKey = [targetPlain, d && d.dirty ? d.html : c.targetHtml, peerDraft ? peerDraft.username + ":" + peerDraft.draftText : "", termKey(id, "target"), issueKey(issues, "target"), drafting ? 1 : 0].join("\u0001");
      if (readKey !== r.readKey) {
        r.readKey = readKey;
        if (peerDraft) {
          r.read.textContent = "";
          var span = el("span", { class: "remote-draft", "data-remote-presence-draft": "" }, [peerDraft.draftText]);
          r.read.appendChild(span);
          var caret = el("span", { class: "rcaret" }, [el("i", { style: { background: peerDraft.color } }), el("b", { style: { background: peerDraft.color }, text: peerDraft.username })]);
          r.read.appendChild(caret);
        } else if ((targetPlain || "").trim()) {
          showInto(r.read, d && d.dirty ? d.html : c.targetHtml, targetPlain);
          decorate(r.read, decorations(id, "target", issues));
        } else {
          r.read.textContent = "";
          r.read.appendChild(el("span", { "aria-hidden": "true", style: { display: "block", "min-height": "1.6em" } }));
        }
      }
      r.read.classList.toggle("empty", !(targetPlain || "").trim() && !peerDraft);
      r.read.tabIndex = editable ? 0 : -1;
    }
    r.read.classList.toggle("subdued", drafting && !(targetPlain || "").trim() ? false : drafting);

    // AI overlay (streaming preview / phase pill) + progress
    Array.prototype.forEach.call(r.well.querySelectorAll(".ai-overlay, .fills"), function (n) { n.remove(); });
    if (drafting) {
      var showOverlay = !(targetPlain || "").trim();
      if (showOverlay) {
        var ov = el("div", { class: "ai-overlay", "aria-live": "polite", "aria-busy": "true" });
        if (ai.preview) ov.appendChild(el("p", { dir: "auto" }, [ai.preview, el("span", { class: "ai-caret", "aria-hidden": "true" })]));
        else ov.appendChild(el("div", { class: "ai-pill" }, [ai.phase === "searching" ? t("editor.ai.lookingUpExamples") : t("editor.ai.generatingTranslation")]));
        r.well.appendChild(ov);
        r.read.classList.add("subdued");
      }
      r.well.appendChild(el("div", { class: "fills", role: "progressbar", "aria-label": ai.phase === "searching" ? t("editor.ai.lookingUpExamples") : t("editor.ai.generatingTranslation") }, [el("i")]));
    }

    // Below the well: inline footnotes, attachments, remote change, errors, saved
    r.after.textContent = "";
    if (S.cfg && S.cfg.footnotes === "inline" && c.footnotes && (c.footnotes.source.length || c.footnotes.target.length)) r.after.appendChild(footnoteLine(id));
    if (c.attachmentCount > 0) {
      r.after.appendChild(el("div", { class: "links" }, [el("button", { type: "button", onclick: function (e) { e.stopPropagation(); aquilla.attachments.open(S.fileId, id).catch(function () {}); } },
        [icon("paperclip", "s3"), t("editor.attachments.countTooltip", { count: c.attachmentCount })])]));
    }
    if (S.sig.remote[id] && editing) {
      r.after.appendChild(el("div", { class: "remote-bar", role: "status" }, [FALLBACK["remote-changed"],
        el("button", { type: "button", onmousedown: function (e) { e.preventDefault(); discardLocal(id); } }, [FALLBACK["discard-reload"]])]));
    }
    var err = S.errors[id] || (ai && ai.error);
    if (err) {
      r.after.appendChild(el("div", { class: "tline err", role: "alert", "aria-live": "assertive" }, [el("span", { text: err }),
        el("button", { type: "button", "aria-label": t("common.dismiss"), onclick: function () { delete S.errors[id]; paintCell(id); } }, ["✕"])]));
    }
    if (S.saved[id] && !err) r.after.appendChild(el("div", { class: "saved", role: "status" }, [icon("check", "s3"), t("common.saved")]));

    paintRail(id);
    if (S.expanded[id]) paintExpansion(id);
  }

  /** Source has b/i/u/s/code marks and the translation has none. */
  function formattingLost(c) {
    var marked = /<(b|strong|i|em|u|s|code)[\s>]/i;
    return !!(c.sourceHtml && marked.test(c.sourceHtml) && !(c.targetHtml && marked.test(c.targetHtml)));
  }

  // ── Decorations: key terms (from terms.matches) and rule blots ───────────
  function termKey(id, side) { var m = S.terms[id]; return m ? m.filter(function (x) { return x.side === side; }).length : -1; }
  function issueKey(issues, side) { return issues.map(function (i) { return i.ruleId + (i.waived ? "w" : "") + i.spans.filter(function (s) { return s.side === side; }).map(function (s) { return s.start + "-" + s.end; }).join(","); }).join(";"); }
  function decorations(id, side, issues) {
    var out = [];
    (issues || []).forEach(function (i) {
      i.spans.forEach(function (s) {
        if (s.side !== side) return;
        out.push({ start: s.start, end: s.end, attrs: { class: "blot " + (i.waived ? "waived" : i.severity === "error" ? "major" : "minor"), "data-rule-id": i.ruleId, title: i.message } });
      });
    });
    (S.terms[id] || []).forEach(function (m) {
      if (m.side !== side) return;
      if (out.some(function (o) { return o.start < m.end && m.start < o.end; })) return;
      if (side === "target" && m.forbidden) out.push({ start: m.start, end: m.end, attrs: { class: "blot term-forbidden", "data-concept-id": m.conceptId, title: m.term } });
      else out.push({ start: m.start, end: m.end, attrs: { class: "term term-chip-host", "data-concept-id": m.conceptId, "data-source-term": m.term, tabindex: "0", title: m.term + (m.renderings.length ? " → " + m.renderings.join(", ") : "") } });
    });
    return out;
  }
  function onDecoClick(id, e) {
    var hostEl = e.target.closest && e.target.closest("[data-concept-id], [data-rule-id], [data-usfm-footnote]");
    if (!hostEl || S.activeId === id) return false;
    e.preventDefault(); e.stopPropagation();
    if (hostEl.hasAttribute("data-rule-id")) aquilla.rules.open(S.fileId, id, hostEl.getAttribute("data-rule-id")).catch(function () {});
    else if (hostEl.hasAttribute("data-concept-id")) openTermCard(hostEl, id, hostEl.getAttribute("data-concept-id"));
    else if (hostEl.hasAttribute("data-usfm-footnote")) openFootnoteCard(hostEl, id, hostEl);
    return true;
  }
  function openTermCard(anchor, id, conceptId) {
    var m = (S.terms[id] || []).filter(function (x) { return x.conceptId === conceptId; })[0];
    if (!m) return;
    var card = el("div", { class: "menu", style: { width: "240px", padding: "10px" } }, [
      el("div", { style: { "font-weight": "600", "margin-bottom": "4px" }, text: m.term }),
      el("div", { class: "muted", style: { "font-size": "12px", "margin-bottom": "8px" }, text: m.renderings.length ? m.renderings.join(" · ") : "—" }),
      el("button", { class: "btn-s", type: "button", onclick: function () { closePop(); aquilla.terms.open(conceptId).catch(function () {}); } }, [icon("book-open", "s35"), FALLBACK["view-term"]]),
    ]);
    popover(anchor, card, { side: "bottom", align: "start" });
  }

  // ── Requests for visible rows' key terms (batched) ───────────────────────
  var termTimer = null;
  function requestTerms() {
    if (termTimer || !S.cfg) return;
    termTimer = later(function () {
      termTimer = null;
      var want = visibleIds().filter(function (id) { return !S.termsAsked[id]; }).slice(0, 400);
      if (!want.length) return;
      want.forEach(function (id) { S.termsAsked[id] = 1; });
      aquilla.terms.matches(S.fileId, want).then(function (res) {
        want.forEach(function (id) { S.terms[id] = (res && res[id]) || []; if (V.mounted[id]) paintCell(id); });
      }, function () {});
    }, 80);
  }

  // ── Validation control (TargetValidationControl) ─────────────────────────
  function valState(c) {
    var v = c.validators || [];
    var need = (S.cfg && S.cfg.validationRequirement) || 1;
    var self = v.indexOf(S.username) >= 0;
    if (c._pendingVal !== undefined) {
      if (c._pendingVal) { if (!self) v = v.concat([S.username]); self = true; }
      else { v = v.filter(function (x) { return x !== S.username; }); self = false; }
    }
    if (!v.length) return { state: "none", self: false, validators: v };
    if (v.length >= need) return { state: self ? "full-self" : "full-others", self: self, validators: v };
    return { state: self ? "self" : "others", self: self, validators: v };
  }
  function paintValidation(id) {
    var c = S.byId[id], r = R(id);
    r.valg.textContent = "";
    var hasContent = !!(c.target || "").trim();
    if (!hasContent) {
      var na = el("span", { class: "val-na", role: "img", "data-testid": "validation-unavailable", "aria-label": t("editor.validation.ariaNoContent", { ref: cellRef(c) }) }, [icon("circle")]);
      tip(na, t("editor.validation.noContentTooltip"));
      r.valg.appendChild(na);
      return;
    }
    var vs = valState(c);
    var canThis = !!(S.cfg && S.cfg.canValidate && hasContent && !S.readOnly);
    var ic = vs.state === "full-self" || vs.state === "full-others" ? "check-check" : vs.state === "self" ? "check" : "circle";
    var ref = cellRef(c);
    var label = !hasContent ? t("editor.validation.ariaNoContent", { ref: ref })
      : vs.self ? t("editor.validation.ariaValidatedByYou", { ref: ref })
      : vs.state === "others" || vs.state === "full-others" ? (canThis ? t("editor.validation.ariaValidatedByOthers", { ref: ref }) : t("editor.validation.ariaValidatedByOthersNoAction", { ref: ref }))
      : canThis ? t("editor.validation.ariaNotValidated", { ref: ref }) : t("editor.validation.ariaNotValidatedNoAction", { ref: ref });
    var btn = el("button", { class: "val" + (canThis ? " can" : ""), type: "button", "data-showcase": "cell.validation", "data-state": hasContent ? vs.state : "none",
      "aria-pressed": vs.self ? "true" : "false", "aria-label": label, "aria-disabled": hasContent && (canThis || vs.validators.length) ? null : "true" }, [icon(ic)]);
    if (!hasContent) btn.setAttribute("data-testid", "validation-unavailable");
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!hasContent) return;
      if (canThis && !vs.self) setValidated(id, true);
      else openValidators(id, btn);
    });
    var hoverTimer = null;
    btn.addEventListener("mouseenter", function () { if (vs.validators.length) hoverTimer = later(function () { openValidators(id, btn); }, 400); });
    btn.addEventListener("mouseleave", function () { if (hoverTimer) clearTimeout(hoverTimer); });
    if (!vs.validators.length) tip(btn, !hasContent ? t("editor.validation.noContentTooltip") : canThis ? t("editor.validation.notValidatedTooltip") : t("editor.validation.unavailableTooltip"));
    r.valg.appendChild(btn);
  }
  function openValidators(id, anchor) {
    var c = S.byId[id];
    var vs = valState(c);
    var list = el("ul", {}, [el("li", { class: "h", text: t("editor.validation.validatedBy") })]);
    if (!vs.validators.length) list.appendChild(el("li", { class: "muted", text: t("editor.validation.noActiveValidators") }));
    vs.validators.forEach(function (v) {
      var li = el("li", {}, [el("span", { text: v + (v === S.username ? " " + t("editor.validation.you") : "") })]);
      if (v === S.username && S.cfg && S.cfg.canValidate) {
        li.appendChild(el("button", { class: "rm", type: "button", "aria-label": t("editor.validation.removeYours"), title: t("editor.validation.removeYours"),
          onclick: function () { closePop(); setValidated(id, false); } }, [icon("trash-2", "s3")]));
      }
      list.appendChild(li);
    });
    var box = el("div", { class: "vpop" }, [list]);
    if (!(S.cfg && S.cfg.canValidate) && !vs.self) box.appendChild(el("div", { class: "note", "data-testid": "validation-blocked-note", text: t("editor.validation.unavailableTooltip") }));
    popover(anchor, box, { side: "right", align: "start" });
  }

  // ── Action rail ──────────────────────────────────────────────────────────
  function paintRail(id) {
    var c = S.byId[id], r = R(id);
    r.prim.textContent = "";
    var ai = (S.signals.ai || {})[id];
    var loading = !!(ai && ai.phase);
    var editable = editableCell(c);
    var conf = S.cfg ? S.cfg.ai : { configured: false, available: false };
    var tipText = !editable ? FALLBACK["read-only"] : !conf.configured ? t("editor.ai.setUpToEnable") : !conf.available ? t("editor.ai.serviceUnavailable") : loading ? t("editor.ai.generating") : t("editor.ai.translateWithAi");
    var spark = el("button", { class: "rbtn" + (loading ? " pulsing" : ""), type: "button", "aria-label": tipText, "data-tooltip": tipText,
      onclick: function (e) { e.stopPropagation(); requestDraft(id); } }, [icon("sparkles", "s35")]);
    spark.disabled = !conf.available || !editable || loading;
    spark.addEventListener("mousedown", function (e) { onSparkDragStart(id, e); });
    spark.addEventListener("mouseenter", function () { onSparkDragEnter(id); });
    tip(spark, tipText);
    r.prim.appendChild(spark);
    if (editable && !c.validated && (c.target || "").trim()) {
      var rtip = !conf.configured ? t("editor.ai.setUpToEnable") : loading ? t("editor.ai.generating") : t("editor.ai.regenerate");
      var regen = el("button", { class: "rbtn" + (loading ? " pulsing" : ""), type: "button", "aria-label": rtip,
        onclick: function (e) { e.stopPropagation(); if (!loading) draft([id], true); } }, [icon("refresh-cw", "s35")]);
      regen.disabled = !conf.available || loading;
      tip(regen, rtip);
      r.prim.appendChild(regen);
    }
    if (c.paragraph && c.paragraph.size > 1 && c.paragraph.draftable > 0 && editable && conf.configured && conf.available) {
      var ptip = loading ? t("editor.ai.generating") : t("editor.ai.draftParagraph", { count: c.paragraph.size });
      var para = el("button", { class: "rbtn" + (loading ? " pulsing" : ""), type: "button", "aria-label": ptip, onclick: function (e) { e.stopPropagation(); confirmParagraph(id); } }, [icon("pilcrow-right", "s35")]);
      para.disabled = loading;
      tip(para, ptip);
      r.prim.appendChild(para);
    }
    // Attention dots
    var comments = S.comments[id] || 0;
    var oldDot = r.more.querySelector(".dot"); if (oldDot) oldDot.remove();
    if (comments > 0) r.more.appendChild(el("span", { class: "dot primary", "aria-hidden": "true" }));
    else if (S.audio[id]) r.more.appendChild(el("span", { class: "dot emerald", "aria-hidden": "true" }));
    var issues = ((S.signals.issues || {})[id] || []).filter(function (i) { return !i.waived; });
    var bt = S.bts[id];
    var cd = r.chev.querySelector(".dot"); if (cd) cd.remove();
    var dot = issues.some(function (i) { return i.severity === "error"; }) ? "red" : issues.length || (bt && bt.stale) ? "amber" : null;
    if (dot) r.chev.appendChild(el("span", { class: "dot " + dot, "aria-hidden": "true" }));
    r.chev.parentNode.classList.toggle("open", !!S.expanded[id]);
    r.chev.setAttribute("aria-expanded", S.expanded[id] ? "true" : "false");
    r.chev.setAttribute("aria-label", S.expanded[id] ? t("editor.cell.closeDetails") : FALLBACK["open-details"]);
  }
  function openOverflow(id, anchor) {
    var c = S.byId[id];
    var editable = editableCell(c);
    var box = el("div", { class: "overflow" });
    function add(name, label, run, opts) {
      opts = opts || {};
      var b = el("button", { class: "rbtn", type: "button", "aria-label": label, "data-tooltip": label, onclick: function (e) { e.stopPropagation(); closePop(); run(); } }, [icon(name, "s35")]);
      if (opts.disabled) b.disabled = true;
      if (opts.dot) b.appendChild(el("span", { class: "dot " + opts.dot, "aria-hidden": "true" }));
      tip(b, label);
      box.appendChild(b);
    }
    if (editable) add("mic", t("editor.audio.record"), function () { aquilla.audio.record(S.fileId, id).catch(function (err) { toast(errText(err)); }); });
    if (S.audio[id]) add("play", t("editor.audio.play"), function () { aquilla.audio.play(S.fileId, id).catch(function (err) { toast(errText(err)); }); }, { dot: "emerald" });
    if (editable) add("volume-2", (c.target || "").trim() ? FALLBACK["voice"] : t("editor.voice.nothingToReadTooltip"), function () { generateVoice(id); }, { disabled: !(c.target || "").trim() });
    if (editable) add("notebook-pen", t("editor.footnote.add"), function () { addFootnote(id); });
    add("paperclip", t("editor.attachments.attach"), function () { aquilla.attachments.open(S.fileId, id).catch(function () {}); });
    var n = S.comments[id] || 0;
    add("message-circle", n > 0 ? t("editor.comments.open", { count: n }) : t("editor.cell.addComment"), function () { openComments(id); }, { dot: n > 0 ? "primary" : null });
    add("history", t("agentWorkspace.editHistory"), function () { aquilla.history.open(S.fileId, id).catch(function (err) { toast(errText(err)); }); });
    popover(anchor, box, { side: "bottom", align: "end", role: "menu" });
  }
  function openComments(id) { aquilla.comments.open(S.fileId, id).catch(function (err) { toast(errText(err)); }); }
  function generateVoice(id) {
    toast(t("editor.tts.generatingAudio"));
    aquilla.audio.generate(S.fileId, id).then(function (ok) {
      if (ok) { refreshAudio(); return aquilla.audio.play(S.fileId, id); }
    }).catch(function (err) { toast(errText(err)); });
  }
`
