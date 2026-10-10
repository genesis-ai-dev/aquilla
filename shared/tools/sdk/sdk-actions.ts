/**
 * Aquilla extension SDK — part 5: aq.actions, the high-level cell actions
 * every view shares (draft with the app's confirm-before-replace, validate,
 * open the host's panels, audio, back-translation, suggestions, navigation).
 */
export const SDK_ACTIONS = String.raw`
  // ── Actions every view shares ────────────────────────────────────────────
  var skipReplaceConfirm = false;
  /** AI-draft cells with the host's pipeline. A single cell with text asks
   *  before replacing it (unless opts.confirm === false). */
  function draft(ids, opts) {
    opts = opts || {};
    ids = Array.isArray(ids) ? ids : [ids];
    if (ids.length === 1 && opts.confirm !== false && !opts.regenerate && cfg().ai.configured) {
      var c = S.byId[ids[0]];
      if (c && (c.target || "").trim() && (c.validated || !skipReplaceConfirm)) {
        return new Promise(function (resolve) {
          var dont = el("input", { type: "checkbox" });
          dialog(c.validated ? t("sdk.replace.validatedTitle") : t("sdk.replace.title"), [
            el("p", { text: c.validated ? t("sdk.replace.validatedDesc") : t("sdk.replace.desc") }),
            c.validated ? null : el("label", { class: "chk" }, [dont, t("workspace.generateOverwrite.dontAskAgain")]),
          ].filter(Boolean), [
            { label: t("common.cancel"), run: function () { resolve(false); } },
            { label: t("sdk.replace.action"), primary: true, run: function () {
              if (dont.checked) { skipReplaceConfirm = true; aquilla.storage.set("skipReplaceConfirm", true).catch(noop); }
              resolve(runDraft(ids, opts));
            } },
          ]);
        });
      }
    }
    return runDraft(ids, opts);
  }
  function runDraft(ids, opts) {
    ids.forEach(function (id) { delete S.errors[id]; });
    return aquilla.ai.draft(S.fileId, ids, { regenerate: !!opts.regenerate }).then(function () { return true; }, function (err) {
      if (err && err.code === "ai_not_configured") return false;
      ids.forEach(function (id) { S.errors[id] = errText(err); });
      notify(ids);
      return false;
    });
  }
  function draftParagraph(id) {
    var p = S.byId[id] && S.byId[id].paragraph;
    if (!p) return Promise.resolve(false);
    return new Promise(function (resolve) {
      dialog(t("editor.paragraph.confirmTitle"), [
        el("p", { text: p.draftable >= p.size ? t("editor.paragraph.confirmAll", { total: p.size }) : t("editor.paragraph.confirmPartial", { draftable: p.draftable, total: p.size }) }),
      ], [
        { label: t("common.cancel"), run: function () { resolve(false); } },
        { label: t("editor.paragraph.confirmAction"), primary: true, run: function () {
          resolve(aquilla.ai.draftParagraph(S.fileId, id).then(function () { return true; }, function (err) { S.errors[id] = errText(err); notify([id]); return false; }));
        } },
      ]);
    });
  }
  function hostCall(p) { return p.catch(function (err) { toast(errText(err)); }); }
  function generateVoice(id) {
    S.voicing[id] = "busy";
    notify([id]);
    if (cfg().lens !== "audio") toast(t("editor.tts.generatingAudio"));
    return aquilla.audio.generate(S.fileId, id).then(function (ok) {
      delete S.voicing[id];
      if (ok) return refreshAudio().then(function () { return aquilla.audio.play(S.fileId, id); });
      notify([id]);
    }).catch(function (err) { delete S.voicing[id]; notify([id]); toast(errText(err)); });
  }
  var actions = {
    commit: function (id, value, html) { return writeWhole(id, value, html); },
    validate: function (id) { return setValidated(id, true); },
    unvalidate: function (id) { return setValidated(id, false); },
    draft: draft,
    regenerate: function (id) { return draft([id], { regenerate: true }); },
    draftParagraph: draftParagraph,
    openHistory: function (id) { return hostCall(aquilla.history.open(S.fileId, id)); },
    openComments: function (id) { return hostCall(aquilla.comments.open(S.fileId, id)); },
    openAttachments: function (id) { return hostCall(aquilla.attachments.open(S.fileId, id)); },
    openRule: function (id, ruleId) { return hostCall(aquilla.rules.open(S.fileId, id, ruleId)); },
    openTerm: function (conceptId) { return hostCall(aquilla.terms.open(conceptId)); },
    playAudio: function (id) { return hostCall(aquilla.audio.play(S.fileId, id)); },
    stopAudio: function () { return hostCall(aquilla.audio.stop()); },
    recordAudio: function (id) { return hostCall(aquilla.audio.record(S.fileId, id)); },
    generateVoice: generateVoice,
    backtranslate: function (id) { return hostCall(aquilla.backtranslation.run(S.fileId, id)); },
    saveBacktranslation: function (id, text) { return aquilla.backtranslation.save(S.fileId, id, text); },
    suggestNext: suggestNext,
    nextUnfinished: nextUnfinished,
    goNextUnfinished: goNextUnfinished,
    edit: function (id) { return activate(id); },
    reveal: function (id, focus) { return reveal(id, focus !== false); },
    select: toggleSelect,
  };
`
