/**
 * Aquilla extension SDK — part 8: the apiRev 4 surfaces, as components:
 * AudioValidateButton (the audio column), the Audio lens's VoiceCard with
 * waveform, trim, voice picker and cloning, the source cell menu (edit text,
 * timestamps, hide, insert, remove), ExamplePanel (translation memory),
 * ContextualDraftCard (autopilot drafts), smart-edit underlines and the
 * source selection toolbar. Each reads data the host computes with the
 * built-in editor's own helpers; host UI (term popovers, remove confirmation,
 * clone dialog, Ask AI chat) opens in the host.
 */
export const SDK_REV4 = String.raw`
  S.audioVal = { column: "off", requirement: 1, takes: {} };
  S.contextual = Object.create(null); S.examples = Object.create(null); S.smart = Object.create(null);
  S.srcActions = Object.create(null); S.voiceTakes = Object.create(null); S.voices = null; S.srcEditing = null;
  var onEditor = ctx.mount === "editor";
  function loadAudioVal() {
    if (!S.fileId || !onEditor) return Promise.resolve();
    return aquilla.audio.takes(S.fileId).then(function (v) {
      var had = S.audioVal.column;
      S.audioVal = v || S.audioVal;
      if (had !== S.audioVal.column) notifyFile();
      notify(null);
    }, noop);
  }
  function loadContextual() {
    if (!S.fileId || !onEditor) return Promise.resolve();
    return aquilla.ai.contextual(S.fileId).then(function (d) {
      var touched = Object.keys(S.contextual).concat(Object.keys(d || {}));
      S.contextual = d || {};
      notify(touched);
    }, noop);
  }
  function loadVoices() {
    if (!S.fileId || !onEditor) return Promise.resolve();
    return aquilla.audio.voices(S.fileId).then(function (v) { S.voices = v; notify(null); }, noop);
  }
  bootExtras.push(function () { loadAudioVal(); loadContextual(); loadVoices(); });
  aquilla.on("audio.changed", function () { S.voiceTakes = Object.create(null); loadAudioVal(); refreshAudio(); });
  aquilla.on("contextual.changed", function () { loadContextual(); });
  aquilla.on("examples.changed", function () { S.examples = Object.create(null); notify(null); });
  aquilla.on("smartedits.changed", function () { if (S.activeId) loadSmart(S.activeId); });
  aquilla.on("cells.changed", function (e) { (e.cellIds || []).forEach(function (id) { delete S.srcActions[id]; delete S.smart[id]; delete S.voiceTakes[id]; }); });
  aquilla.on("config.changed", function () { loadVoices(); });

  // ── Audio validation (AudioValidationControl) ────────────────────────────
  function audioState(takes) {
    var need = Math.max(1, S.audioVal.requirement || 1), worst = 3, rank = { none: 0, others: 1, self: 2, full: 3 };
    var names = ["none", "others", "self", "full"];
    takes.filter(function (tk) { return !tk.unrecorded; }).forEach(function (tk) {
      var mine = tk.validators.indexOf(S.username) >= 0;
      var st = tk.validatorCount >= need ? "full" : mine ? "self" : tk.validatorCount > 0 ? "others" : "none";
      worst = Math.min(worst, rank[st]);
    });
    return names[worst];
  }
  function AudioValidateButton(id) {
    var slot = el("div", { class: "valg audio-check", "data-testid": "audio-validation-gutter" });
    var key = null;
    return bindCell(id, slot, function () {
      var c = S.byId[id];
      if (!c) return;
      var col = S.audioVal.column;
      slot.hidden = col === "off";
      var takes = S.audioVal.takes[id] || [];
      var k = [col, JSON.stringify(takes), S.readOnly, cfg().canValidate].join("|");
      if (k === key) return;
      key = k;
      slot.textContent = "";
      if (col === "off") return;
      var ref = cellRef(c);
      if (col === "checking") { slot.appendChild(tip(el("span", { class: "val-na", role: "img", "aria-label": t("editor.audioValidation.ariaChecking", { ref: ref }) }, [el("span", { class: "skel" })]), t("editor.audioValidation.checkingTooltip"))); return; }
      var recorded = takes.filter(function (tk) { return !tk.unrecorded; });
      if (!recorded.length) {
        slot.appendChild(tip(el("span", { class: "val-na", role: "img", "data-testid": "audio-validation-unavailable", "aria-label": t("editor.audioValidation.ariaNoAudio", { ref: ref }) }, [icon("mic")]), t("editor.audioValidation.noAudioTooltip")));
        return;
      }
      var st = audioState(takes);
      var toGive = recorded.filter(function (tk) { return tk.canValidate && tk.validators.indexOf(S.username) < 0; });
      var allMine = recorded.every(function (tk) { return tk.validators.indexOf(S.username) >= 0; });
      var clickable = toGive.length > 0 && cfg().canValidate && !S.readOnly;
      var label = st === "full" ? (allMine ? t("editor.audioValidation.ariaValidated", { ref: ref }) : t("editor.audioValidation.ariaValidatedNoAction", { ref: ref }))
        : st === "self" ? t("editor.audioValidation.ariaValidated", { ref: ref })
        : st === "others" ? t("editor.audioValidation.ariaOthersValidated", { ref: ref, count: 1 })
        : clickable ? t("editor.audioValidation.ariaNotValidated", { ref: ref }) : t("editor.audioValidation.ariaNotValidatedByYou", { ref: ref });
      var btn = el("button", { class: "val audio" + (clickable ? " can" : "") + (st === "others" ? " fillcap" : ""), type: "button", "data-showcase": "cell.audioValidation", "data-testid": "audio-validation-button",
        "data-state": st, "aria-pressed": allMine ? "true" : "false", "aria-label": label }, [icon(st === "full" ? "check-check" : st === "self" ? "check" : "mic")]);
      // Several takes, some of them yours: "1/2" beside the icon, as the built-in.
      var mineDone = recorded.filter(function (tk) { return tk.validators.indexOf(S.username) >= 0; }).length;
      if (recorded.length > 1 && mineDone > 0 && mineDone < recorded.length) {
        btn.classList.add("frac");
        btn.appendChild(el("span", { class: "fr", "data-testid": "audio-validation-fraction", text: t("editor.audioValidation.takeFraction", { done: mineDone, total: recorded.length }) }));
      }
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (clickable) toGive.forEach(function (tk) { aquilla.audio.validate(S.fileId, id, tk.audioId).catch(function (err) { toast(errText(err)); }); });
        else openAudioValidators(id, btn, recorded);
      });
      if (!recorded.some(function (tk) { return tk.validators.length; })) {
        var blocked = recorded.filter(function (tk) { return tk.blockedReason; })[0];
        tip(btn, clickable ? t("editor.audioValidation.notValidatedTooltip") : blocked ? blocked.blockedReason : t("editor.audioValidation.unavailableTooltip"));
      } else btn.addEventListener("mouseenter", function () { later(function () { if (btn.matches(":hover")) openAudioValidators(id, btn, recorded); }, 400); });
      slot.appendChild(btn);
    });
  }
  function openAudioValidators(id, anchor, takes) {
    var list = el("ul", {}, [el("li", { class: "h", text: t("editor.validation.validatedBy") })]);
    takes.forEach(function (tk) {
      var label = tk.label || (tk.isGenerated ? t("editor.audioValidation.generatedTake") : tk.slot === "recording" ? t("editor.audioValidation.defaultTrack") : tk.slot);
      if (takes.length > 1) list.appendChild(el("li", { class: "muted", text: label }));
      if (!tk.validators.length) list.appendChild(el("li", { class: "muted", text: t("editor.validation.noActiveValidators") }));
      tk.validators.forEach(function (v) {
        var li = el("li", {}, [el("span", { text: v + (v === S.username ? " " + t("editor.validation.you") : "") })]);
        if (v === S.username && cfg().canValidate) li.appendChild(el("button", { class: "rm", type: "button", "aria-label": t("editor.validation.removeYours"),
          onclick: function () { closePop(); aquilla.audio.unvalidate(S.fileId, id, tk.audioId).catch(function (err) { toast(errText(err)); }); } }, [icon("trash-2", "s3")]));
        list.appendChild(li);
      });
    });
    popover(anchor, el("div", { class: "vpop" }, [list]), { side: "right", align: "start" });
  }

  // ── Audio lens: the line's take, waveform + trim, voice, cloning ─────────
  function loadVoiceTake(id) {
    if (has(S.voiceTakes, id) || !onEditor) return;
    S.voiceTakes[id] = "loading";
    aquilla.audio.take(S.fileId, id).then(function (tk) { S.voiceTakes[id] = tk || null; notify([id]); }, function () { S.voiceTakes[id] = null; });
  }
  function Waveform(id, take) {
    var dur = take.durationMs || 1, start = take.trimStartMs || 0, end = take.trimEndMs || dur;
    var bars = el("div", { class: "wf-bars" });
    (take.peaks.length ? take.peaks : new Array(64).fill(0.08)).forEach(function (p, i, arr) {
      var at = (i / arr.length) * dur;
      bars.appendChild(el("i", { class: at < start || at > end ? "out" : "", style: { height: Math.max(6, Math.round(p * 100)) + "%" } }));
    });
    var wf = el("div", { class: "wf", "data-testid": "voice-waveform", role: "img", "aria-label": t("editor.voice.play") }, [bars]);
    if (!take.trimmable || !editableCell(S.byId[id])) return wf;
    function handle(side) {
      var h = el("span", { class: "wf-h " + side, role: "slider", tabindex: "0", "aria-label": side === "s" ? "Trim start" : "Trim end",
        style: { left: ((side === "s" ? start : end) / dur * 100) + "%" } });
      h.addEventListener("pointerdown", function (e) {
        e.preventDefault(); e.stopPropagation();
        var box = wf.getBoundingClientRect();
        function at(x) { return Math.max(0, Math.min(dur, ((x - box.left) / box.width) * dur)); }
        function move(ev) {
          var ms = at(ev.clientX);
          if (side === "s") start = Math.min(ms, end - 100); else end = Math.max(ms, start + 100);
          h.style.left = ((side === "s" ? start : end) / dur * 100) + "%";
        }
        function up() {
          doc.removeEventListener("pointermove", move); doc.removeEventListener("pointerup", up);
          aquilla.audio.trim(S.fileId, id, take.audioId, Math.round(start), Math.round(end)).catch(function (err) { toast(errText(err)); });
        }
        doc.addEventListener("pointermove", move); doc.addEventListener("pointerup", up);
      });
      return h;
    }
    wf.appendChild(handle("s")); wf.appendChild(handle("e"));
    return wf;
  }
  function voicePicker(id) {
    var cur = S.voices && S.voices.current[id];
    var sel = el("select", { class: "vpick", "aria-label": t("editor.voice.generateWith", { voice: cur ? cur.name : "" }) },
      (S.voices ? S.voices.voices : []).map(function (v) { return el("option", { value: v.id, selected: cur && cur.id === v.id ? true : null, text: v.name }); }));
    sel.addEventListener("change", function () { aquilla.audio.assignVoice(S.fileId, id, sel.value).then(loadVoices, function (err) { toast(errText(err)); }); });
    sel.addEventListener("click", function (e) { e.stopPropagation(); });
    return sel;
  }
  /** The Audio lens's source column (CellVoicePanel). */
  function VoiceCard(id) {
    var c = S.byId[id], st = cellState(id);
    var card = el("div", { "data-voice-card": "", dir: "ltr", class: "vcard" });
    var voice = S.voices && S.voices.current[id] ? S.voices.current[id].name : c.voice ? c.voice.name : "";
    if (st.hasAudio) {
      loadVoiceTake(id);
      var take = S.voiceTakes[id];
      if (take && take !== "loading") {
        card.appendChild(Waveform(id, take));
        if (take.takeVoiceName) card.appendChild(el("span", { class: "k pill", text: take.takeVoiceName }));
      }
      card.appendChild(el("div", { class: "vrow" }, [
        el("button", { class: "btn-s", type: "button", "aria-label": t("editor.voice.play"), onclick: function (e) { e.stopPropagation(); actions.playAudio(id); } }, [icon("play", "s3"), t("editor.voice.play")]),
        st.editable ? el("button", { class: "rbtn", type: "button", "aria-label": t("editor.audio.record"), title: t("editor.audio.record"), onclick: function (e) { e.stopPropagation(); actions.recordAudio(id); } }, [icon("mic", "s35")]) : null,
        st.editable && S.voices ? voicePicker(id) : null,
        st.editable && S.voices && S.voices.canClone ? el("button", { class: "rbtn", type: "button", "aria-label": "Make a character from this take", title: "Make a character from this take",
          onclick: function (e) { e.stopPropagation(); aquilla.audio.clone(S.fileId, id).catch(noop); } }, [icon("copy", "s35")]) : null,
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
      if (st.editable && S.voices) row.appendChild(voicePicker(id));
      card.appendChild(row);
    }
    return card;
  }

  // ── Source cell menu (CellSourceMenu) ────────────────────────────────────
  function sourceActions(id) {
    if (!onEditor) return Promise.resolve(null);
    if (S.srcActions[id]) return Promise.resolve(S.srcActions[id]);
    return aquilla.source.actions(S.fileId, id).then(function (a) { S.srcActions[id] = a; return a; }, function () { return null; });
  }
  function SourceMenuButton(id) {
    var btn = el("button", { class: "srcmenu", type: "button", "data-testid": "cell-menu-" + id, "aria-label": t("editor.cellMenu.trigger"), title: t("editor.cellMenu.trigger"), hidden: true,
      onclick: function (e) { e.stopPropagation(); openSourceMenu(id, btn); } }, [icon("ellipsis-vertical", "s35")]);
    function check() {
      sourceActions(id).then(function (a) {
        btn.hidden = !a || !(a.edit !== undefined || a.timestamps || a.hide || a.insertAbove !== undefined || a.remove !== undefined);
      });
    }
    btn.__check = check;
    return btn;
  }
  function menuItem(testId, ic, label, reason, run) {
    var b = el("button", { class: "mi" + (reason ? " has-reason" : ""), type: "button", role: "menuitem", "data-testid": testId, onclick: function () { closePop(); if (run) run(); } },
      [icon(ic, "s35"), el("span", { class: "mil" }, [label, reason ? el("span", { class: "reason", text: reason }) : null])]);
    if (reason || !run) b.disabled = true;
    return b;
  }
  function openSourceMenu(id, anchor) {
    sourceActions(id).then(function (a) {
      if (!a) return;
      var box = el("div", { class: "menu", role: "menu", style: { "min-width": "13rem" } });
      var editing = S.srcEditing === id;
      if (a.edit !== undefined) box.appendChild(menuItem("cell-menu-edit-source", "pencil", editing ? t("editor.source.doneEditing") : t("editor.source.editText"), a.edit, function () { editing ? stopSourceEdit(id, true) : startSourceEdit(id); }));
      if (a.timestamps) box.appendChild(menuItem("cell-menu-edit-timestamps", "clock", t("editor.cellMenu.editTimestamps"), a.timestamps.canUnlock ? null : a.timestamps.reason, function () { openTimestamps(id, anchor, a.timestamps); }));
      var structural = a.insertAbove !== undefined || a.remove !== undefined;
      if ((structural || a.hide) && box.childNodes.length) box.appendChild(el("div", { class: "sep" }));
      if (a.hide) box.appendChild(menuItem("cell-menu-toggle-hidden", a.hide.hidden ? "eye" : "eye-off", a.hide.hidden ? t("editor.row.showCell") : t("editor.row.hideCell"), a.hide.reason, function () {
        aquilla.source.setHidden(S.fileId, id, !a.hide.hidden).then(function () { delete S.srcActions[id]; }, function (err) { toast(errText(err)); });
      }));
      if (structural) {
        box.appendChild(menuItem("cell-menu-insert-above", "arrow-up", t("editor.row.insertAbove"), a.insertAbove, function () { aquilla.source.insert(S.fileId, id, "above").catch(function (err) { toast(errText(err)); }); }));
        box.appendChild(menuItem("cell-menu-insert-below", "arrow-down", t("editor.row.insertBelow"), a.insertBelow, function () { aquilla.source.insert(S.fileId, id, "below").catch(function (err) { toast(errText(err)); }); }));
        box.appendChild(menuItem("cell-menu-remove", "x", t("editor.row.removeLine"), a.remove, function () { aquilla.source.remove(S.fileId, id).catch(function (err) { toast(errText(err)); }); }));
      }
      popover(anchor, box, { side: "bottom", align: "end", role: "menu" });
    });
  }
  function fmtTime(sec) { var m = Math.floor(sec / 60), s = sec - m * 60; return m + ":" + (s < 10 ? "0" : "") + s.toFixed(1); }
  function parseTime(v) {
    var m = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(v || "");
    return m ? (Number(m[1] || 0) * 60 + Number(m[2])) : NaN;
  }
  function openTimestamps(id, anchor, ts) {
    var a = el("input", { type: "text", "aria-label": t("editor.cellMenu.startLabel"), value: fmtTime(ts.startSec) });
    var b = el("input", { type: "text", "aria-label": t("editor.cellMenu.endLabel"), value: fmtTime(ts.endSec) });
    var err = el("p", { class: "k err", role: "alert" });
    var box = el("div", { class: "menu", style: { width: "240px", padding: "10px" } }, [
      el("div", { class: "k", style: { "font-size": "12px", "margin-bottom": "6px" }, text: t("editor.cellMenu.editTimestamps") }),
      el("div", { class: "tsrow" }, [a, el("span", { text: "–" }), b]), err,
      el("div", { class: "actions", style: { display: "flex", gap: "6px", "margin-top": "8px", "justify-content": "flex-end" } }, [
        el("button", { class: "btn-s", type: "button", onclick: function () { closePop(); } }, [t("common.cancel")]),
        el("button", { class: "btn-s primary", type: "button", onclick: function () {
          var s = parseTime(a.value), e = parseTime(b.value);
          if (!(s >= 0) || !(e > s)) { err.textContent = t("sdk.badSpan"); return; }
          closePop();
          aquilla.source.retime(S.fileId, id, s, e).catch(function (x) { toast(errText(x)); });
        } }, [t("common.save")]),
      ]),
    ]);
    if (ts.reason) { a.disabled = true; b.disabled = true; err.textContent = ts.reason; }
    popover(anchor, box, { side: "bottom", align: "end" });
    a.focus();
  }
  function startSourceEdit(id) {
    var src = doc.querySelector('[data-cell-id="' + id + '"] [data-editor-cell-surface=source] .txt');
    var c = S.byId[id];
    if (!src || !c) return;
    S.srcEditing = id;
    src.textContent = c.source || "";
    src.setAttribute("contenteditable", "true");
    src.classList.add("editing");
    src.focus();
    caretAt(src, "end");
    // The menu closing can take focus back: put it in the editor again.
    later(function () { if (S.srcEditing === id && doc.activeElement !== src) { src.focus(); caretAt(src, "end"); } }, 0);
    function done(save) {
      src.removeEventListener("keydown", keys); src.removeEventListener("blur", blur);
      stopSourceEdit(id, save);
    }
    function keys(e) {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); done(false); }
      else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); done(true); }
      // Inside the source, Home/End/PageUp/PageDown move the caret, never the list.
      else if ((e.key === "End" || e.key === "Home") && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        var hs = doc.getSelection();
        if (hs && hs.modify) hs.modify(e.shiftKey ? "extend" : "move", e.key === "End" ? "forward" : "backward", "lineboundary");
      } else if (e.key === "PageDown" || e.key === "PageUp") e.preventDefault();
    }
    function blur() { done(true); }
    src.addEventListener("keydown", keys);
    src.addEventListener("blur", blur);
  }
  function stopSourceEdit(id, save) {
    if (S.srcEditing !== id) return;
    S.srcEditing = null;
    var src = doc.querySelector('[data-cell-id="' + id + '"] [data-editor-cell-surface=source] .txt');
    var c = S.byId[id];
    if (src) { src.setAttribute("contenteditable", "false"); src.classList.remove("editing"); }
    var value = src ? plainOf(src) : null;
    if (save && c && value !== null && value !== (c.source || "")) {
      c.source = value; c.sourceHtml = null;
      aquilla.source.commit(S.fileId, id, value, null).catch(function (err) { toast(errText(err)); });
    }
    notify([id]);
  }

  // ── Translation-memory examples (ExamplePanel) ───────────────────────────
  function ExamplePanel(id) {
    var slot = el("div", { class: "aq-slot" });
    var key = null;
    return bindCell(id, slot, function () {
      if (!onEditor) return;
      if (!has(S.examples, id)) { S.examples[id] = []; aquilla.ai.examples(S.fileId, id).then(function (x) { S.examples[id] = x || []; notify([id]); }, noop); return; }
      var ex = S.examples[id];
      var k = JSON.stringify(ex);
      if (k === key) return;
      key = k;
      slot.textContent = "";
      if (!ex.length) return;
      var trig = el("button", { type: "button", class: "ex-trig", onclick: function (e) { e.stopPropagation(); openExamples(id, trig, ex); } }, [icon("book-open", "s3"), t("search.examples.count", { count: ex.length })]);
      slot.appendChild(el("div", { class: "ex-wrap" }, [trig]));
    });
  }
  function openExamples(id, anchor, ex) {
    var box = el("div", { class: "menu ex-pop", "aria-label": t("search.examples.popoverAriaLabel") });
    ex.forEach(function (m) {
      var head = el("div", { class: "ex-h" }, [el("span", { class: "ex-badge " + m.band, "data-testid": "example-match-badge",
        text: m.band === "exact" ? t("search.examples.exactMatch") : m.band === "example" ? t("search.examples.looseLabel") : t("search.examples.matchPercent", { percent: m.percent }) })]);
      if (m.canInsert && editableCell(S.byId[id])) head.appendChild(el("button", { type: "button", class: "ex-ins", "data-testid": "example-insert", "aria-label": t("search.examples.insertAriaLabel"),
        onclick: function () { closePop(); writeWhole(id, m.target); } }, [icon("corner-down-left", "s3"), t("search.examples.insert")]));
      var srcLine = el("div", { class: "muted" });
      if (m.diff) m.diff.forEach(function (d) { srcLine.appendChild(el(d.kind === "added" ? "ins" : d.kind === "removed" ? "del" : "span", { text: d.text })); });
      else srcLine.textContent = m.source;
      box.appendChild(el("div", { class: "ex-row", "data-testid": "example-row", "data-match-band": m.band }, [head,
        el("div", { class: "k", text: t("editor.column.source") }), srcLine,
        el("div", { class: "k", text: t("editor.column.target") }), el("div", { class: "ex-t", text: m.target }),
        m.fileName ? el("div", { class: "k", "data-testid": "example-origin", text: m.isTranslationMemory ? t("search.examples.originTranslationMemory", { fileName: m.fileName }) : t("search.examples.originFile", { fileName: m.fileName }) }) : null]));
    });
    popover(anchor, box, { side: "bottom", align: "start" });
  }

  // ── Autopilot draft card (ContextualDraftCard) ───────────────────────────
  function ContextualDraftCard(id) {
    var slot = el("div", { class: "aq-slot" });
    var key = null;
    return bindCell(id, slot, function () {
      var d = S.contextual[id], st = cellState(id);
      var show = d && !st.hasText && !st.drafting && !st.editing;
      var k = show ? d.draftId + d.text + st.editable : "";
      if (k === key) return;
      key = k;
      slot.textContent = "";
      if (!show) return;
      var card = el("div", { class: "ctx-card", "data-testid": "contextual-draft-card", "data-cell-id": id, onclick: function (e) { e.stopPropagation(); } }, [
        el("p", { "data-testid": "contextual-draft-text", dir: "auto", text: d.text }),
        el("div", { class: "ctx-row" }, [
          tip(el("span", { class: "k" }, [icon("sparkles", "s3"), t("autopilot.draft.suggested")]), d.spanLabel ? t("autopilot.draft.draftedFrom", { spanLabel: d.spanLabel }) : t("autopilot.draft.draftedForYou")),
          st.editable ? el("div", { class: "ctx-acts" }, [
            tip(el("button", { class: "rbtn", type: "button", "aria-label": t("autopilot.draft.useTranslation"), onclick: function () { review(id, d, true); } }, [icon("check", "s35")]), t("autopilot.draft.useTranslation")),
            tip(el("button", { class: "rbtn", type: "button", "aria-label": t("autopilot.draft.dismissSuggestion"), onclick: function () { review(id, d, false); } }, [icon("x", "s35")]), t("autopilot.draft.dismissSuggestion")),
          ]) : null,
        ]),
      ]);
      slot.appendChild(card);
    });
  }
  function review(id, d, accept) {
    aquilla.ai.reviewContextual(S.fileId, id, d.draftId, accept).then(function () {
      if (accept) { S.byId[id].target = d.text; }
      delete S.contextual[id];
      notify([id]);
    }, function (err) { toast(accept ? errText(err) : t("autopilot.draft.dismissFailed")); });
  }

  // ── Smart edits (underlines in the open cell, accept / dismiss) ──────────
  function loadSmart(id) {
    if (!onEditor) return;
    aquilla.ai.smartEdits(S.fileId, id).then(function (list) { S.smart[id] = list || []; markSmart(id); }, noop);
  }
  function markSmart(id) {
    var r = ed(id), list = S.smart[id] || [];
    if (!r) return;
    Array.prototype.forEach.call(r.read.querySelectorAll(".smart-edit"), function (n) { n.replaceWith(doc.createTextNode(n.textContent)); });
    if (!list.length || S.activeId === id) return;
    decorate(r.read, list.map(function (s) { return { start: s.start, end: s.end, attrs: { class: "smart-edit" + (s.flagOnly ? " flag" : ""), "data-smart-edit": s.id, title: s.reason || (s.old + " → " + s.new) } }; }));
  }
  doc.addEventListener("click", function (e) {
    var n = e.target.closest && e.target.closest("[data-smart-edit]");
    if (!n) return;
    e.preventDefault(); e.stopPropagation();
    var cell = n.closest("[data-cell-id]"), id = cell && cell.getAttribute("data-cell-id");
    var s = id && (S.smart[id] || []).filter(function (x) { return x.id === n.getAttribute("data-smart-edit"); })[0];
    if (!s) return;
    var box = el("div", { class: "menu", style: { width: "260px", padding: "10px" } }, [
      el("div", { class: "smart-diff" }, [el("del", { text: s.old }), " → ", el("ins", { text: s.new })]),
      s.reason ? el("p", { class: "k", text: s.reason }) : null,
      el("div", { class: "actions", style: { display: "flex", gap: "6px", "margin-top": "8px", "justify-content": "flex-end" } }, [
        el("button", { class: "btn-s", type: "button", onclick: function () { closePop(); feedback(id, s, "dismiss"); } }, [t("common.dismiss")]),
        s.flagOnly ? null : el("button", { class: "btn-s primary", type: "button", onclick: function () {
          closePop();
          var c = S.byId[id], v = c.target || "";
          if (v.slice(s.start, s.end) === s.old) writeWhole(id, v.slice(0, s.start) + s.new + v.slice(s.end));
          feedback(id, s, "accept");
        } }, [t("sdk.apply")]),
      ]),
    ]);
    popover(n, box, { side: "bottom", align: "start" });
  }, true);
  function feedback(id, s, action) {
    S.smart[id] = (S.smart[id] || []).filter(function (x) { return x.id !== s.id; });
    markSmart(id);
    aquilla.ai.smartEditFeedback(S.fileId, id, s.id, action).catch(noop);
  }

  // ── Source selection toolbar (SourceSelectionToolbar) ────────────────────
  var selBar = null, selBarDown = false;
  function hideSelBar() { if (selBar) { selBar.remove(); selBar = null; } }
  function onSourceMouseUp(id, src, e) {
    if (S.srcEditing === id || !onEditor) return;
    later(function () {
      var sel = doc.getSelection();
      var text = sel && sel.rangeCount ? sel.toString().trim() : "";
      if (!text || !src.contains(sel.anchorNode) || text.length > 500) { if (!selBarDown) hideSelBar(); return; }
      var rect = sel.getRangeAt(0).getBoundingClientRect();
      var r = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      var termP = declared("read:terms") ? aquilla.terms.selection(S.fileId, id, text).catch(function () { return null; }) : Promise.resolve(null);
      termP.then(function (info) {
        hideSelBar();
        selBar = el("div", { class: "selbar", dir: "ltr", "data-testid": "source-selection-toolbar" });
        selBar.addEventListener("mousedown", function (ev) { ev.preventDefault(); selBarDown = true; });
        selBar.addEventListener("mouseup", function (ev) { ev.stopPropagation(); selBarDown = false; });
        function btn(ic, label, run) { selBar.appendChild(el("button", { type: "button", class: "btn-xs", onclick: function (ev) { ev.stopPropagation(); run(); hideSelBar(); } }, [icon(ic, "s3"), label])); }
        if (info && info.match) btn("book-open", t("workspace.sourceSelection.viewTerm"), function () { aquilla.terms.view(S.fileId, id, text, r).catch(noop); });
        btn("sparkles", t("workspace.sourceSelection.askAi"), function () { aquilla.agent.ask(S.fileId, id, text).catch(function (err) { toast(errText(err)); }); });
        if (info && info.canAdd) btn("book-open", t("workspace.sourceSelection.addToTermbase"), function () { aquilla.terms.add(S.fileId, id, text, r).catch(noop); });
        src.appendChild(selBar);
      });
    }, 0);
  }
  doc.addEventListener("selectionchange", function () {
    if (!selBar || selBarDown) return;
    var sel = doc.getSelection();
    if (!sel || sel.isCollapsed) hideSelBar();
  });
`

export const SDK_REV4_STYLE = String.raw`
  /* Audio validation column (AudioValidationControl) */
  .valg.audio-check[hidden] { display: none; }
  .val.audio { color: color-mix(in oklab, var(--muted-foreground) 30%, transparent); }
  .val.audio[data-state="others"] { color: color-mix(in oklab, var(--muted-foreground) 60%, transparent); }
  .val.audio[data-state="self"], .val.audio[data-state="full"] { color: var(--aq-green-500); }
  .val.audio svg { width: 14px; height: 14px; stroke-width: 2.5; }
  .val.fillcap svg rect { fill: currentColor; }
  .val.frac { width: auto; padding: 0 4px; gap: 2px; } .val .fr { font-size: 10px; font-weight: 500; line-height: 1; font-variant-numeric: tabular-nums; }
  .skel { display: block; width: 14px; height: 14px; border-radius: 999px; background: var(--muted); animation: skel 1.4s ease-in-out infinite; }
  @keyframes skel { 50% { opacity: .45; } }

  /* Source cell menu (CellSourceMenu) */
  .srcmenu { position: absolute; inset-inline-end: 4px; top: 4px; z-index: 2; display: flex; width: 24px; height: 24px; align-items: center; justify-content: center;
             border-radius: var(--r-md); color: color-mix(in oklab, var(--muted-foreground) 50%, transparent); opacity: 0; transition: color .15s, background-color .15s; }
  .srcmenu[hidden] { display: none; }
  .row:hover .srcmenu, .srcmenu:focus-visible { opacity: 1; }
  .srcmenu:hover { background: var(--accent); color: var(--foreground); }
  .menu .mi .mil { display: flex; flex-direction: column; min-width: 0; }
  .menu .mi .reason { font-size: 12px; color: var(--muted-foreground); white-space: normal; }
  .menu .mi.has-reason:disabled { opacity: 1; } .menu .mi.has-reason:disabled > svg, .menu .mi.has-reason:disabled .mil > :first-child { opacity: .5; }
  .tsrow { display: flex; align-items: center; gap: 6px; } .tsrow input { width: 0; flex: 1; height: 28px; border: 1px solid var(--input, var(--border)); border-radius: var(--r-md);
           background: transparent; color: inherit; padding: 0 6px; font: inherit; font-size: 13px; font-variant-numeric: tabular-nums; }
  .k.err { color: var(--destructive); margin: 6px 0 0; }
  .src .txt.editing { user-select: text; cursor: text; outline: none; border-radius: var(--r-md); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--ring) 40%, transparent);
                      background: var(--background); padding: 2px 4px; margin: -2px -4px; white-space: pre-wrap; }

  /* Source selection toolbar (SourceSelectionToolbar) */
  .selbar { position: absolute; inset-inline-end: 4px; top: 0; z-index: 3; display: flex; align-items: center; gap: 2px; border-radius: var(--r-md); background: var(--card); padding: 4px;
            box-shadow: var(--shadow-soft-sm, 0 2px 6px -2px rgb(0 0 0 / .12)); user-select: none; }
  .btn-xs { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border-radius: var(--r-md); font-size: 12px; font-weight: 500; white-space: nowrap; }
  .btn-xs:hover { background: var(--muted); }

  /* Translation memory (ExamplePanel) */
  .ex-wrap { margin-top: 8px; }
  .ex-trig { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted-foreground); } .ex-trig:hover { color: var(--foreground); }
  .ex-pop { width: 320px; max-height: min(60vh, 480px); overflow-y: auto; overscroll-behavior: contain; padding: 12px; font-size: 12px; display: flex; flex-direction: column; gap: 8px; }
  .ex-row { border-radius: var(--r-sm); border-inline-start: 2px solid var(--aq-sky-500); background: color-mix(in oklab, var(--muted) 30%, transparent); padding: 8px; display: flex; flex-direction: column; gap: 4px; }
  .ex-row .k { font-size: 12px; color: color-mix(in oklab, var(--muted-foreground) 70%, transparent); }
  .ex-row ins { background: color-mix(in oklab, var(--aq-emerald-500) 15%, transparent); text-decoration: underline; text-decoration-color: var(--aq-emerald-600); text-underline-offset: 2px; }
  .ex-row del { color: color-mix(in oklab, var(--muted-foreground) 60%, transparent); }
  .ex-t { font-weight: 500; }
  .ex-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .ex-badge { border-radius: var(--r-sm); padding: 2px 6px; font-size: 10px; font-weight: 500; line-height: 1; background: var(--muted); color: var(--muted-foreground); }
  .ex-badge.exact { background: color-mix(in oklab, var(--aq-emerald-500) 15%, transparent); color: var(--aq-emerald-600); }
  .ex-badge.high { background: color-mix(in oklab, var(--aq-sky-500) 15%, transparent); color: var(--aq-sky-600); }
  .ex-badge.good { background: color-mix(in oklab, var(--aq-amber-500) 15%, transparent); color: var(--aq-amber-600); }
  .ex-ins { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--border); border-radius: var(--r-sm); padding: 2px 6px; font-size: 10px; font-weight: 500; }
  .ex-ins:hover { background: var(--accent); }

  /* Autopilot draft (ContextualDraftCard) */
  .ctx-card { margin-top: 4px; display: flex; flex-direction: column; gap: 4px; border-radius: var(--r-md); padding: 4px 8px; border: 1px dashed color-mix(in oklab, var(--primary) 40%, transparent);
              background: color-mix(in oklab, var(--primary) 4%, transparent); animation: pop-in .3s ease-out; }
  .ctx-card p { margin: 0; white-space: pre-wrap; line-height: 1.625; color: color-mix(in oklab, var(--foreground) 90%, transparent); }
  .ctx-row { display: flex; align-items: center; gap: 4px; } .ctx-row .k { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--muted-foreground); }
  .ctx-acts { margin-inline-start: auto; display: flex; gap: 2px; }

  /* Audio lens: waveform + trim, voice picker */
  .wf { position: relative; height: 56px; margin: 2px 0 6px; border-radius: var(--r-md); background: color-mix(in oklab, var(--muted) 50%, transparent); overflow: hidden; }
  .wf-bars { position: absolute; inset: 6px 4px; display: flex; align-items: center; gap: 1px; }
  .wf-bars i { flex: 1; min-width: 1px; border-radius: 1px; background: var(--primary); opacity: .75; }
  .wf-bars i.out { opacity: .18; }
  .wf-h { position: absolute; top: 0; bottom: 0; width: 6px; margin-inline-start: -3px; cursor: ew-resize; background: var(--foreground); opacity: .55; border-radius: 2px; }
  .wf-h:hover, .wf-h:focus-visible { opacity: .9; }
  .vpick { height: 28px; max-width: 160px; border: 1px solid var(--input, var(--border)); border-radius: var(--r-md); background: transparent; color: inherit; font: inherit; font-size: 12px; padding: 0 6px; }
  .k.pill { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 999px; background: var(--muted); margin-bottom: 4px; }

  /* Smart edits */
  .smart-edit { text-decoration: underline dotted var(--aq-violet-500); text-decoration-thickness: 2px; text-underline-offset: 3px; cursor: pointer; }
  .smart-edit.flag { text-decoration-color: var(--aq-amber-500); }
  .smart-diff del { color: var(--muted-foreground); } .smart-diff ins { text-decoration: none; font-weight: 600; color: var(--aq-emerald-600); }
`
