/**
 * Aquilla extension SDK — part 6: cell components. Each takes a cell id and
 * stays live (bindCell): SourceText, ValidateButton, CommentBadge,
 * AudioBadge, StatusBadges, CellNumber, SelectBox, HealthRibbon,
 * PresenceStack, CellNotes, FootnoteLine, VoiceCard, DraftButton /
 * DraftActions.
 */
export const SDK_CELLS = String.raw`
  // ── Decorations: key terms and rule blots ────────────────────────────────
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
    if (hostEl.hasAttribute("data-rule-id")) actions.openRule(id, hostEl.getAttribute("data-rule-id"));
    else if (hostEl.hasAttribute("data-concept-id")) openTermCard(hostEl, id, hostEl.getAttribute("data-concept-id"));
    else if (hostEl.hasAttribute("data-usfm-footnote")) popover(hostEl, el("div", { class: "menu", style: { "max-width": "280px", padding: "8px 10px", "font-size": "13px" } }, [fnText(hostEl.getAttribute("data-usfm-footnote")) || t("editor.footnotes.emptyNote")]), { side: "bottom", align: "start" });
    return true;
  }
  function openTermCard(anchor, id, conceptId) {
    var m = (S.terms[id] || []).filter(function (x) { return x.conceptId === conceptId; })[0];
    if (!m) return;
    popover(anchor, el("div", { class: "menu", style: { width: "240px", padding: "10px" } }, [
      el("div", { style: { "font-weight": "600", "margin-bottom": "4px" }, text: m.term }),
      el("div", { class: "muted", style: { "font-size": "12px", "margin-bottom": "8px" }, text: m.renderings.length ? m.renderings.join(" · ") : "—" }),
      el("button", { class: "btn-s", type: "button", onclick: function () { closePop(); actions.openTerm(conceptId); } }, [icon("book-open", "s35"), t("sdk.viewTerm")]),
    ]), { side: "bottom", align: "start" });
  }

  // ── SourceText: the source surface (context lane + decorated text) ───────
  function SourceText(id, opts) {
    opts = opts || {};
    var lane = el("div", { class: "lane", "data-testid": "source-context-line" });
    var txt = el("div", { class: "txt", dir: "auto" });
    var src = el("div", { class: "src", "data-editor-cell-surface": "source", "data-cell-type": "source", "aria-label": t("editor.source.textAria") }, opts.lane === false ? [txt] : [lane, txt]);
    txt.addEventListener("click", function (e) { onDecoClick(id, e); });
    var key = null;
    return bindCell(id, src, function () {
      var c = S.byId[id];
      if (!c) return;
      wantTerms(id);
      var st = cellState(id), cf = cfg();
      var showLabel = cf.cellLabels && c.label;
      var rep = (S.signals.repetition || {})[id];
      var audioLens = cf.lens === "audio" && opts.lens !== false;
      var k = [audioLens ? "audio:" + (st.hasAudio ? 1 : 0) + ":" + (c.voice ? c.voice.name : "") + ":" + (c.target || "").length + ":" + (st.voicing || "") + ":" + st.editable : "",
        c.source, c.sourceHtml, showLabel ? c.label : "", c.context, rep || 0, c.hidden ? 1 : 0, termKey(id, "source"), issueKey(st.issues, "source"), cf.sourceFontSize].join("\u0001");
      if (k === key) return;
      key = k;
      lane.textContent = "";
      lane.className = "lane" + (showLabel ? " start" : "");
      if (showLabel) lane.appendChild(el("span", { class: "lbl", "data-testid": "source-cell-label", dir: "auto", text: c.label }));
      if (c.context && !/^\d+:\d/.test(c.context) && c.context !== c.ref) lane.appendChild(el("span", { class: "ctx", text: c.context }));
      if (rep > 1) lane.appendChild(tip(el("span", { class: "rep", "data-testid": "source-repetition-count", text: t("editor.repetition.badge", { count: rep }) }), t("editor.repetition.tooltip", { count: rep })));
      if (c.hidden) lane.appendChild(el("span", { "data-testid": "source-cell-hidden-badge", "aria-label": t("editor.row.hiddenBadgeAria") }, [icon("eye-off", "s35")]));
      if (audioLens) { lane.textContent = ""; txt.textContent = ""; txt.appendChild(VoiceCard(id)); }
      else { showInto(txt, c.sourceHtml, c.source); decorate(txt, decorations(id, "source", st.issues)); }
      src.style.fontSize = cf.sourceFontSize + "px";
      src.style.lineHeight = "1.6";
      txt.setAttribute("dir", cf.sourceDirection === "rtl" ? "rtl" : "auto");
    });
  }

  // ── Gutter pieces ────────────────────────────────────────────────────────
  function SelectBox(id) {
    var sel = el("button", { class: "sel", type: "button", role: "checkbox", "aria-checked": "false", "aria-label": t("editor.row.selectAria") }, [el("span", { class: "dot" })]);
    sel.addEventListener("pointerdown", function (e) { onSelectPointerDown(id, e); });
    sel.addEventListener("click", function (e) { e.stopPropagation(); });
    tip(sel, function () { return S.selection[id] ? t("editor.row.selectedTooltip") : t("editor.row.selectTooltip"); }, "right");
    var was = null;
    return bindCell(id, sel, function () {
      var on = !!S.selection[id];
      if (on === was) return;
      was = on;
      sel.setAttribute("aria-checked", on ? "true" : "false");
      sel.setAttribute("aria-label", on ? t("editor.row.selectedAria") : t("editor.row.selectAria"));
      sel.textContent = "";
      sel.appendChild(on ? icon("check", "s3") : el("span", { class: "dot" }));
    });
  }
  function onSelectPointerDown(id, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    if (e.shiftKey && S.selAnchor) { selectRange(S.selAnchor, id); pushSelection(); return; }
    if (e.metaKey || e.ctrlKey) { toggleSelect(id); return; }
    var startSel = !S.selection[id];
    var anchor = id;
    if (startSel) S.selection[id] = 1; else delete S.selection[id];
    S.selAnchor = id;
    notify([id]);
    var sc = e.target.closest(".aq-list") || doc.scrollingElement, autoTimer = null, lastY = e.clientY;
    function over(y) {
      var hit = doc.elementFromPoint(e.clientX, y);
      var cell = hit && hit.closest && hit.closest("[data-cell-id]");
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
  /** Open-comments badge (hidden when the cell has none). */
  function CommentBadge(id) {
    var wrap = el("span", { class: "aq-slot" });
    var last = -1;
    return bindCell(id, wrap, function () {
      var n = S.comments[id] || 0;
      if (n === last) return;
      last = n;
      wrap.textContent = "";
      if (n > 0) wrap.appendChild(tip(el("button", { class: "gicon comments", type: "button", "aria-label": t("editor.comments.openAria", { count: n }), "data-comments": String(n),
        onclick: function (e) { e.stopPropagation(); actions.openComments(id); } }, [icon("message-circle", "s35")]), t("editor.comments.open", { count: n })));
    });
  }
  /** Play button for a cell that has audio (hidden otherwise). */
  function AudioBadge(id) {
    var wrap = el("span", { class: "aq-slot" });
    var last = null;
    return bindCell(id, wrap, function () {
      var on = !!S.audio[id];
      if (on === last) return;
      last = on;
      wrap.textContent = "";
      if (on) wrap.appendChild(tip(el("button", { class: "gicon audio", type: "button", "aria-label": t("editor.audio.play"), "data-testid": "audio-badge",
        onclick: function (e) { e.stopPropagation(); actions.playAudio(id); } }, [icon("play", "s3")]), t("editor.audio.play")));
    });
  }
  /** Stale source / upstream stale / formatting loss / comments. */
  function StatusBadges(id) {
    var stack = el("div", { class: "stack" });
    var comments = CommentBadge(id);
    var dyn = el("span", { class: "aq-slot" });
    stack.appendChild(dyn); stack.appendChild(comments);
    var key = null;
    return bindCell(id, stack, function () {
      var c = S.byId[id];
      if (!c) return;
      var hasText = !!(c.target || "").trim();
      var k = [hasText, S.sig.stale[id] ? 1 : 0, S.sig.upstream[id] ? 1 : 0, formattingLost(c)].join("|");
      if (k === key) return;
      key = k;
      dyn.textContent = "";
      if (hasText && S.sig.stale[id]) dyn.appendChild(tip(el("span", { class: "gicon stale", role: "img", "data-testid": "stale-source-indicator", "aria-label": t("editor.stale.directLabel") }, [icon("triangle-alert", "s35")]), t("editor.stale.directTooltip")));
      else if (hasText && S.sig.upstream[id]) dyn.appendChild(tip(el("span", { class: "gicon upstream", role: "img", "data-testid": "upstream-stale-source-indicator", "aria-label": t("editor.stale.upstreamLabel") }, [icon("git-branch-plus", "s35")]), t("editor.stale.upstreamTooltip")));
      if (hasText && formattingLost(c)) dyn.appendChild(tip(el("span", { class: "gicon fmt", role: "img", "data-testid": "formatting-loss-warning", "aria-label": t("editor.source.formattingLossTooltip") }, [icon("bold", "s3")]), t("editor.source.formattingLossTooltip")));
    });
  }
  /** Source has b/i/u/s/code marks and the translation has none. */
  function formattingLost(c) {
    var marked = /<(b|strong|i|em|u|s|code)[\s>]/i;
    return !!(c.sourceHtml && marked.test(c.sourceHtml) && !(c.targetHtml && marked.test(c.targetHtml)));
  }
  /** The verse/cell number pill, tinted by the worst live rule issue. */
  function CellNumber(id) {
    var num = el("span", { class: "num" });
    return bindCell(id, num, function () {
      var c = S.byId[id];
      if (!c) return;
      var st = cellState(id);
      num.textContent = numberOf(c);
      num.className = "num" + (st.major ? " major" : st.liveIssues.length ? " issue" : "");
    });
  }
  /** Health ribbon (retrieval support), desktop or mobile variant. */
  function HealthRibbon(id, opts) {
    var mobile = opts && opts.mobile;
    var r = mobile ? el("span", { class: "ribbon-m", "data-testid": "health-ribbon-mobile", "aria-hidden": "true" }, [el("i")])
      : el("span", { class: "ribbon", "data-testid": "health-ribbon", role: "img", tabindex: "0" }, [el("i")]);
    if (!mobile) tip(r, function () { var x = S.byId[id] && S.byId[id].ribbon; return x ? x.label : ""; }, "right");
    return bindCell(id, r, function () {
      var c = S.byId[id];
      if (!c || !c.ribbon) { r.hidden = true; return; }
      var st = cellState(id);
      r.hidden = false;
      r.firstChild.style.backgroundImage = c.ribbon.background;
      if (!mobile) {
        r.setAttribute("aria-label", c.ribbon.label + (st.major ? " · major automatic issue" : st.liveIssues.length ? " · automatic issue" : ""));
        r.setAttribute("data-health-stage", c.ribbon.stage);
      }
    });
  }
  /** Who else is on this cell: avatars + viewing / editing / typing. */
  function PresenceStack(id) {
    var slot = el("span", { class: "aq-slot" });
    return bindCell(id, slot, function () {
      slot.textContent = "";
      var peers = peersFor(id), lock = S.locks[id];
      if (!peers.length) return;
      var typing = peers.some(function (p) { return p.draftText; }), editingPeer = peers.some(function (p) { return p.editing; });
      var pres = el("span", { class: "presence", "data-cell-presence": "", "data-cell-presence-state": typing ? "typing" : editingPeer ? "editing" : "viewing",
        title: lock ? t("editor.row.lockedBy", { name: lock }) : null });
      peers.slice(0, 3).forEach(function (p) { pres.appendChild(el("span", { class: "avatar", style: { background: p.color }, title: p.username, text: initials(p.username) })); });
      pres.appendChild(el("span", { class: "state", text: typing ? t("editor.presence.typing") : editingPeer ? t("editor.presence.editing") : t("editor.presence.viewing") }));
      slot.appendChild(pres);
    });
  }

  // ── ValidateButton (TargetValidationControl: N of M, popover) ────────────
  function ValidateButton(id) {
    var valg = el("div", { class: "valg", "data-testid": "validation-gutter" });
    var key = null;
    return bindCell(id, valg, function () {
      var c = S.byId[id];
      if (!c) return;
      var hasContent = !!(c.target || "").trim();
      var vs = valState(c);
      var canThis = !!(cfg().canValidate && hasContent && !S.readOnly);
      var k = [hasContent, vs.state, vs.self, vs.validators.join(","), canThis, cellRef(c)].join("|");
      if (k === key) return;
      key = k;
      valg.textContent = "";
      var ref = cellRef(c);
      if (!hasContent) {
        valg.appendChild(tip(el("span", { class: "val-na", role: "img", "data-testid": "validation-unavailable", "aria-label": t("editor.validation.ariaNoContent", { ref: ref }) }, [icon("circle")]), t("editor.validation.noContentTooltip")));
        return;
      }
      var ic = vs.state === "full-self" || vs.state === "full-others" ? "check-check" : vs.state === "self" ? "check" : "circle";
      var label = vs.self ? t("editor.validation.ariaValidatedByYou", { ref: ref })
        : vs.state === "others" || vs.state === "full-others" ? (canThis ? t("editor.validation.ariaValidatedByOthers", { ref: ref }) : t("editor.validation.ariaValidatedByOthersNoAction", { ref: ref }))
        : canThis ? t("editor.validation.ariaNotValidated", { ref: ref }) : t("editor.validation.ariaNotValidatedNoAction", { ref: ref });
      var btn = el("button", { class: "val" + (canThis ? " can" : ""), type: "button", "data-showcase": "cell.validation", "data-state": vs.state,
        "aria-pressed": vs.self ? "true" : "false", "aria-label": label, "aria-disabled": canThis || vs.validators.length ? null : "true" }, [icon(ic)]);
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (canThis && !vs.self) setValidated(id, true);
        else openValidators(id, btn);
      });
      var hoverTimer = null;
      btn.addEventListener("mouseenter", function () { if (vs.validators.length) hoverTimer = later(function () { openValidators(id, btn); }, 400); });
      btn.addEventListener("mouseleave", function () { if (hoverTimer) clearTimeout(hoverTimer); });
      if (!vs.validators.length) tip(btn, canThis ? t("editor.validation.notValidatedTooltip") : t("editor.validation.unavailableTooltip"));
      valg.appendChild(btn);
    });
  }
  function openValidators(id, anchor) {
    var vs = valState(S.byId[id]);
    var list = el("ul", {}, [el("li", { class: "h", text: t("editor.validation.validatedBy") })]);
    if (!vs.validators.length) list.appendChild(el("li", { class: "muted", text: t("editor.validation.noActiveValidators") }));
    vs.validators.forEach(function (v) {
      var li = el("li", {}, [el("span", { text: v + (v === S.username ? " " + t("editor.validation.you") : "") })]);
      if (v === S.username && cfg().canValidate) {
        li.appendChild(el("button", { class: "rm", type: "button", "aria-label": t("editor.validation.removeYours"), title: t("editor.validation.removeYours"),
          onclick: function () { closePop(); setValidated(id, false); } }, [icon("trash-2", "s3")]));
      }
      list.appendChild(li);
    });
    var box = el("div", { class: "vpop" }, [list]);
    if (!cfg().canValidate && !vs.self) box.appendChild(el("div", { class: "note", "data-testid": "validation-blocked-note", text: t("editor.validation.unavailableTooltip") }));
    popover(anchor, box, { side: "right", align: "start" });
  }

  // ── Below the well: footnotes, attachments, remote change, error, saved ──
  function CellNotes(id) {
    var after = el("div", { class: "after" });
    return bindCell(id, after, function () {
      var c = S.byId[id];
      if (!c) return;
      var st = cellState(id);
      after.textContent = "";
      if (cfg().footnotes === "inline" && c.footnotes && (c.footnotes.source.length || c.footnotes.target.length)) after.appendChild(FootnoteLine(id));
      if (c.attachmentCount > 0) after.appendChild(el("div", { class: "links" }, [el("button", { type: "button", onclick: function (e) { e.stopPropagation(); actions.openAttachments(id); } },
        [icon("paperclip", "s3"), t("editor.attachments.countTooltip", { count: c.attachmentCount })])]));
      if (st.remoteChanged && st.editing) after.appendChild(el("div", { class: "remote-bar", role: "status" }, [t("sdk.remoteChanged"),
        el("button", { type: "button", onmousedown: function (e) { e.preventDefault(); discardLocal(id); } }, [t("sdk.discardReload")])]));
      if (st.error) after.appendChild(el("div", { class: "tline err", role: "alert", "aria-live": "assertive" }, [el("span", { text: st.error }),
        el("button", { type: "button", "aria-label": t("common.dismiss"), onclick: function () { delete S.errors[id]; notify([id]); } }, ["✕"])]));
      if (st.saved && !st.error) after.appendChild(el("div", { class: "saved", role: "status" }, [icon("check", "s3"), t("common.saved")]));
    });
  }

  // ── Footnotes ────────────────────────────────────────────────────────────
  function FootnoteLine(id) {
    var c = S.byId[id];
    var box = el("div", { class: "fnline", "data-testid": "footnote-inline" });
    var src = (c.footnotes && c.footnotes.source) || [], tgt = (c.footnotes && c.footnotes.target) || [];
    for (var i = 0; i < Math.max(src.length, tgt.length); i++) (function (i) {
      var s = src[i], tg = tgt[i];
      var v = el("span", { class: "v" + (tg && tg.text ? "" : " empty"), role: "button", tabindex: "0", title: t("editor.footnotes.clickToEdit"),
        text: tg && tg.text ? tg.text : (s ? t("editor.footnotes.addTranslation") : t("editor.footnotes.emptyTarget")) });
      if (editableCell(c)) v.addEventListener("click", function (e) { e.stopPropagation(); editFootnote(id, i, v); });
      box.appendChild(el("div", { class: "fni" }, [el("span", { class: "k", text: String(i + 1) }), s ? el("span", { class: "muted", style: { flex: "1", "min-width": "0" }, text: s.text }) : null, v]));
    })(i);
    return box;
  }
  function editFootnote(id, i, anchor) {
    var cur = rawFootnotes(S.byId[id].target)[i];
    var ta = el("textarea", { rows: "3", placeholder: t("editor.footnotes.editPlaceholder"), "aria-label": t("editor.footnotes.translationLabel") });
    ta.value = cur ? fnText(cur.raw) : "";
    popover(anchor, el("div", { class: "menu", style: { width: "300px", padding: "10px" } }, [el("div", { class: "k", style: { "font-size": "12px", "margin-bottom": "6px" }, text: t("editor.footnotes.editLabel") }), ta,
      el("div", { class: "actions", style: { display: "flex", gap: "6px", "margin-top": "8px", "justify-content": "flex-end" } }, [
        cur ? el("button", { class: "btn-s danger", type: "button", onclick: function () { closePop(); spliceFootnote(id, i, null); } }, [icon("trash-2", "s3"), t("common.delete")]) : null,
        el("button", { class: "btn-s primary", type: "button", onclick: function () { closePop(); spliceFootnote(id, i, ta.value); } }, [t("common.save")]),
      ])]), { side: "bottom", align: "start" });
    ta.focus();
  }
  function spliceFootnote(id, i, text) {
    var c = S.byId[id];
    var value = c.target || "", cur = rawFootnotes(value)[i], srcRaw = rawFootnotes(c.source)[i];
    var next;
    if (cur) next = text === null ? value.slice(0, cur.index) + value.slice(cur.index + cur.raw.length)
      : value.slice(0, cur.index) + makeFootnote(fnCaller(cur.raw), "", text) + value.slice(cur.index + cur.raw.length);
    else {
      if (text === null || !text.trim()) return;
      next = value + makeFootnote(srcRaw ? fnCaller(srcRaw.raw) : "+", "", text);
    }
    writeWhole(id, next);
  }
  /** The "Add footnote" dialog (USFM \f … \f* appended to the translation). */
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
        var caller = lettered.checked ? String.fromCharCode(97 + (rawFootnotes(c.target).length % 26)) : "+";
        writeWhole(id, (c.target || "") + makeFootnote(caller, c.ref ? c.ref.replace(/^\S+\s+/, "") : "", ta.value));
      } },
    ]);
  }
  actions.addFootnote = addFootnote;

  // ── VoiceCard (the Audio lens' source column) ────────────────────────────
  function VoiceCard(id) {
    var c = S.byId[id], st = cellState(id);
    var card = el("div", { "data-voice-card": "", dir: "ltr", class: "vcard" });
    var voice = c.voice ? c.voice.name : "";
    if (st.hasAudio) {
      card.appendChild(el("div", { class: "vrow" }, [
        el("button", { class: "btn-s", type: "button", "aria-label": t("editor.voice.play"), onclick: function (e) { e.stopPropagation(); actions.playAudio(id); } }, [icon("play", "s3"), t("editor.voice.play")]),
        st.editable ? el("button", { class: "rbtn", type: "button", "aria-label": t("editor.audio.record"), title: t("editor.audio.record"), onclick: function (e) { e.stopPropagation(); actions.recordAudio(id); } }, [icon("mic", "s35")]) : null,
      ]));
    } else if (st.voicing === "busy") {
      card.appendChild(el("span", { class: "k vstatus", role: "status" }, [icon("loader-circle", "s3 spin"), t("editor.voice.generatingAs", { voice: voice })]));
    } else {
      card.appendChild(el("span", { class: "k", text: t("editor.voice.noAudioYet") }));
      var row = el("div", { class: "vrow" });
      if (st.editable) row.appendChild(el("button", { class: "btn-s", type: "button", onclick: function (e) { e.stopPropagation(); actions.recordAudio(id); } }, [icon("mic", "s3"), t("editor.voice.record")]));
      var gen = el("button", { class: "btn-s", type: "button", "data-testid": "voice-card-generate", onclick: function (e) { e.stopPropagation(); generateVoice(id); } }, [icon("sparkles", "s3"), t("editor.voice.generateWith", { voice: voice })]);
      if (!(c.target || "").trim() || !st.editable) gen.disabled = true;
      tip(gen, !(c.target || "").trim() ? t("editor.voice.nothingToReadTooltip") : c.voice && !c.voice.explicit ? t("editor.voice.generateDefaultTooltip") : "");
      row.appendChild(gen);
      card.appendChild(row);
    }
    return card;
  }

  // ── AI draft buttons (TargetDraftActions) ────────────────────────────────
  var sparkDrag = null;
  doc.addEventListener("mouseup", function () {
    if (!sparkDrag) return;
    var ids = sparkDrag.ids;
    sparkDrag = null;
    if (ids.length > 1) { notify(ids); draft(ids, { confirm: false }); }
  });
  function sparkButton(id, st) {
    var conf = cfg().ai, loading = st.drafting;
    var tipText = !st.editable ? t("sdk.readOnly") : !conf.configured ? t("editor.ai.setUpToEnable") : !conf.available ? t("editor.ai.serviceUnavailable") : loading ? t("editor.ai.generating") : t("editor.ai.translateWithAi");
    var spark = el("button", { class: "rbtn" + (loading ? " pulsing" : ""), type: "button", "aria-label": tipText, "data-tooltip": tipText,
      onclick: function (e) { e.stopPropagation(); draft([id]); } }, [icon("sparkles", "s35")]);
    spark.disabled = !conf.available || !st.editable || loading;
    // Drag across Sparkles buttons → one batch.
    spark.addEventListener("mousedown", function (e) { if (e.button === 0) sparkDrag = { ids: [id] }; });
    spark.addEventListener("mouseenter", function () {
      if (sparkDrag && sparkDrag.ids.indexOf(id) < 0) { sparkDrag.ids.push(id); var row = spark.closest(".row"); if (row) row.classList.add("selected"); }
    });
    return tip(spark, tipText);
  }
  /** One "Translate with AI" button. */
  function DraftButton(id) {
    var wrap = el("span", { class: "aq-slot" });
    var key = null;
    return bindCell(id, wrap, function () {
      var st = cellState(id), conf = cfg().ai;
      var k = [st.drafting, st.editable, conf.configured, conf.available].join("|");
      if (k === key) return;
      key = k;
      wrap.textContent = "";
      wrap.appendChild(sparkButton(id, st));
    });
  }
  /** The built-in rail's AI buttons: draft, regenerate, draft paragraph. */
  function DraftActions(id) {
    var prim = el("div", { class: "prim" });
    var key = null;
    return bindCell(id, prim, function () {
      var c = S.byId[id];
      if (!c) return;
      var st = cellState(id), conf = cfg().ai, loading = st.drafting;
      // Rebuild only when what they show changes, so a button never detaches
      // under the pointer on an unrelated repaint.
      var k = [loading, st.editable, conf.configured, conf.available, c.validated, st.hasText, c.paragraph ? c.paragraph.size + "/" + c.paragraph.draftable : ""].join("|");
      if (k === key) return;
      key = k;
      prim.textContent = "";
      prim.appendChild(sparkButton(id, st));
      if (st.editable && !c.validated && st.hasText) {
        var rtip = !conf.configured ? t("editor.ai.setUpToEnable") : loading ? t("editor.ai.generating") : t("editor.ai.regenerate");
        var regen = el("button", { class: "rbtn" + (loading ? " pulsing" : ""), type: "button", "aria-label": rtip,
          onclick: function (e) { e.stopPropagation(); if (!loading) draft([id], { regenerate: true }); } }, [icon("refresh-cw", "s35")]);
        regen.disabled = !conf.available || loading;
        prim.appendChild(tip(regen, rtip));
      }
      if (c.paragraph && c.paragraph.size > 1 && c.paragraph.draftable > 0 && st.editable && conf.configured && conf.available) {
        var ptip = loading ? t("editor.ai.generating") : t("editor.ai.draftParagraph", { count: c.paragraph.size });
        var para = el("button", { class: "rbtn" + (loading ? " pulsing" : ""), type: "button", "aria-label": ptip, onclick: function (e) { e.stopPropagation(); draftParagraph(id); } }, [icon("pilcrow-right", "s35")]);
        para.disabled = loading;
        prim.appendChild(tip(para, ptip));
      }
    });
  }

`
