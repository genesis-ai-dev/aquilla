/**
 * The first-party default editor, expressed on the extension SDK (window.aq):
 * the built-in's layout (chapter row, column header, virtualized rows) from
 * SDK components, plus the one editor-specific piece — the cell details
 * panel (health · back-translation · footnotes · issues). Everything else —
 * rich-text editing, validation, AI drafting, presence, comments, audio, key
 * terms, selection — is the SDK's, the same components any extension gets.
 * Plain ES2020 in a classic <script>; it touches Aquilla only through `aq`
 * (which itself only uses `aquilla.*`).
 */
export const DEFAULT_EDITOR_APP = String.raw`
(function () {
  "use strict";
  var h = aq.h, t = aq.t, ui = aq.ui, A = aq.actions, icon = aq.icon;
  var file = aq.useFile();
  var tabOf = Object.create(null);

  // ── Cell details (CellExpansion): health · back-translation · footnotes · issues
  function details(id) {
    var st = aq.cell.state(id), c = st.cell, cfg = file.value.config;
    var issues = st.issues, live = st.liveIssues, bt = st.bt;
    var tabs = [
      { key: "health", icon: "activity", label: t("editor.expansion.retrievalSupport") },
      { key: "bt", icon: "file-text", label: t("editor.bt.label"), dot: bt && bt.stale ? "amber" : null },
    ];
    if (cfg.footnotes === "off" && c.footnotes && (c.footnotes.source.length || c.footnotes.target.length)) tabs.push({ key: "fn", icon: "notebook-pen", label: t("editor.footnotes.label") });
    tabs.push({ key: "issues", icon: "triangle-alert", label: t("editor.expansion.issues"), dot: st.major ? "red" : live.length ? "amber" : null, disabled: !issues.length });
    var cur = tabs.some(function (x) { return x.key === tabOf[id] && !x.disabled; }) ? tabOf[id] : live.length ? "issues" : bt && bt.stale ? "bt" : "health";
    tabOf[id] = cur;
    var bar = ui.Tabs({ tabs: tabs, value: cur, onChange: function (key, viaKeys) {
      tabOf[id] = key;
      aq.cell.refresh(id);
      if (viaKeys) setTimeout(function () { var b = document.querySelector('[data-cell-id="' + id + '"] .exp [aria-selected="true"]'); if (b) b.focus(); }, 0);
    } });
    bar.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.preventDefault(); aq.cell.toggleDetails(id, false); aq.cell.focusRow(id); } });
    var panel = h("div", { class: "panel", role: "tabpanel" });
    if (cur === "health") {
      var rb = c.ribbon;
      panel.appendChild(h("p", { style: { "font-weight": "500" }, text: rb ? rb.label : t("editor.expansion.retrievalSupport") }));
      if (c.validated) panel.appendChild(h("p", { class: "k", text: live.length ? t("editor.assurance.validatedWithInfractions") : t("editor.assurance.validatedClean") }));
      else if (rb && rb.score !== null) panel.appendChild(h("p", { class: "k", text: rb.score < 50 ? t("editor.assurance.lowerSupport") : t("editor.assurance.betterSupport") }));
    } else if (cur === "bt") panel.appendChild(btPanel(id, st, cfg));
    else if (cur === "fn") panel.appendChild(aq.FootnoteLine(id));
    else if (cur === "issues") {
      if (!issues.length) panel.appendChild(h("p", { class: "k", text: t("editor.issues.none") }));
      issues.forEach(function (i) {
        panel.appendChild(h("div", { class: "issue " + (i.severity === "error" ? "major" : "minor") + (i.waived ? " waived" : "") }, [
          icon("triangle-alert", "s35"),
          h("div", { class: "b" }, [h("b", { text: i.ruleName }), h("span", { class: "k", text: i.message + (i.waived ? " · " + t("editor.issues.waived") : "") })]),
          h("button", { class: "btn-s", type: "button", onclick: function () { A.openRule(id, i.ruleId); } }, [t("sdk.openRule")]),
        ]));
      });
    }
    return h("div", { class: "exp-in", "data-testid": "cell-expansion" }, [bar, panel]);
  }
  function btPanel(id, st, cfg) {
    var bt = st.bt, box = h("div", {});
    var busy = (aq.debug.state.signals.backtranslating || []).indexOf(id) >= 0;
    if (!st.hasText) { box.appendChild(h("p", { class: "k", text: t("editor.bt.translateFirst") })); return box; }
    if (bt && bt.error) box.appendChild(h("p", { style: { color: "var(--destructive)" }, text: t("editor.bt.failed") + ": " + bt.error }));
    var runBtn = function (label, ic, primary) {
      return h("button", { class: "btn-s" + (primary ? " primary" : ""), type: "button", disabled: busy || null, "aria-label": primary ? null : t("editor.bt.regenerateAria"),
        onclick: function () { A.backtranslate(id); } }, [icon(busy ? "loader-circle" : ic, busy ? "s3 spin" : "s3"), busy ? t("editor.bt.readingItBack") : label]);
    };
    if (bt && bt.text) {
      box.appendChild(h("p", { class: "k", text: (bt.polished ? t("editor.bt.originAi") : t("editor.bt.originCorrected")) + (bt.stale ? "" : " · " + t("editor.bt.freshLabel")) }));
      if (bt.stale) box.appendChild(h("p", { style: { color: "var(--aq-amber-600)" }, text: t("editor.bt.staleWarning") }));
      var ta = h("textarea", { "aria-label": t("editor.bt.editTooltip") });
      ta.value = bt.text;
      box.appendChild(ta);
      box.appendChild(h("div", { class: "actions" }, [
        h("button", { class: "btn-s", type: "button", onclick: function () { A.saveBacktranslation(id, ta.value).then(function () { ui.toast(t("common.saved")); }, function (err) { ui.toast(err.message || String(err)); }); } },
          [icon("pencil", "s3"), t("common.save")]),
        cfg.backtranslation.configured ? runBtn(t("editor.bt.regenerateTooltip"), "refresh-cw", false) : null,
      ]));
    } else if (cfg.backtranslation.configured) {
      box.appendChild(h("p", { class: "k", text: t("editor.bt.emptyPitch") }));
      box.appendChild(h("div", { class: "actions" }, [runBtn(t("editor.bt.readItBack"), "sparkles", true)]));
    } else box.appendChild(h("p", { class: "k", text: t("editor.bt.needsAiHint") }));
    return box;
  }

  // ── Layout: the built-in's chrome over the virtualized rows ──────────────
  var list = aq.CellList({ row: function (id) { return aq.CellRow(id, { details: details }); } });
  aq.mount(aq.Layout([
    aq.Toolbar({ start: [aq.ChapterPicker()] }),
    aq.ReadOnlyBanner(),
    aq.ColumnHeader(),
    list,
  ]));
  // Ctrl/Cmd+. — the next unfinished cell.
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "." && !e.shiftKey && !e.altKey) { e.preventDefault(); A.goNextUnfinished(); }
  });
  // Load the details panel's strings, then reopen where the user left off.
  aq.strings(STRING_KEYS);
  file.ready.then(function (f) {
    if (!f.fileId) return;
    var S = aq.debug.state;
    var waitRows = function () { return S.loading ? new Promise(function (r) { var off = file.subscribe(function (v) { if (!v.loading) { off(); r(); } }); }) : Promise.resolve(); };
    return Promise.all([aquilla.storage.get("pos:" + f.fileId).catch(function () { return null; }), waitRows()]).then(function (res) {
      var saved = res[0];
      if (!S.pendingReveal && typeof saved === "string" && S.index[saved] !== undefined) aq.cell.scrollTo(saved, "center", false);
    });
  });
  // Inspection hook for tests and debugging (frame-local; opaque origin).
  window.__AQ_EDITOR__ = { S: aq.debug.state, scrollToCell: aq.cell.scrollTo, activate: A.edit };
})();
`
