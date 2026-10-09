// Aquilla Tools builder — the extension SDK section of the system prompt.
// It IS the SDK reference the model codes against: it must name every export
// in shared/tools/sdk/sdk.ts (AQ_SDK_EXPORTS; the capability-twin test checks).

export const TOOLS_SDK_PROMPT = `## The Aquilla SDK — \`aq\` (put "sdk": 1 in the manifest; PREFER IT for anything about cells)
With "sdk": 1 the host also injects the global \`aq\`: live data, the app's OWN components (they look and behave
exactly like Aquilla's editor, light/dark, in the user's language) and a small UI kit. It only calls aquilla.*,
so scopes still apply: declare "read:cells" to read, "write:target" to edit, "write:validation" to validate,
"read:comments" for comment badges, "read:terms" for key-term highlights, "ai:draft" for AI drafting.
Everything below is synchronous unless it says Promise. Components return DOM nodes that keep themselves
current — build them ONCE, never re-create them on every change.

Start:            aq.mount(node) renders your UI (replaces the page; a layout holding a CellList fills the frame).
                  aq.h(tag, { class, style:{…}, text, onclick, …attrs }, [children]) makes elements. aq.icon(name, "s35")
                  draws an app icon (lucide names: sparkles, check, check-check, circle, message-circle, play, mic, history,
                  search, list, layout-grid, chart-column, settings, star, eye, clock, users, book-open, triangle-alert, …).
                  aq.t(key) app strings; aq.strings([key…]) → Promise loads more. aq.version → "1.0". aq.Layout([children]) is a
                  full-height column (toolbar on top, CellList filling the rest).
Data (live):      const file = aq.useFile()  — file.value → { fileId, name, config, sections, loading, readOnly, cellCount };
                    file.ready → Promise of that once it is bound (the editor's/panel's file, else the first file with cells).
                  const cells = aq.useCells()  — cells.value → cells in order; cells.ids; cells.cell(id); cells.loading;
                    cells.ready → Promise when every page is in. Cell: { cellId, ref, source, target, sourceHtml, targetHtml,
                    validated, type, label, … }.
                  aq.useCell(id).value → the cell's live state: { cell, target (incl. unsaved typing in THIS frame), hasText,
                    validation:{ state, self, validators }, issues, liveIssues, major, ai, drafting, comments, hasAudio, lock,
                    peers, selected, editing, editable, error }.
                  aq.useSelection() → { value:[ids], has(id), toggle(id), set(ids), clear() } — drives the app's bulk bar.
                  aq.usePresence() → { value:{ locks, peers }, peers(id), lockedBy(id) }.
                  Every handle has .subscribe(fn) → unsubscribe; fn runs after each change (also other people's edits).
Components (pass a cellId; they stay live):
                  aq.CellList({ row:(id)=>node, filter:(cell)=>bool, estimate:(cell)=>px, empty }) — virtualized, scrolls,
                    handles thousands of cells; default row = aq.CellRow. Methods: list.scrollToCell(id, "center"),
                    list.visibleIds(), list.firstVisibleId().
                  aq.CellRow(id, { details:(id)=>node, menu:(id, items)=>items, actions:(id)=>node, select, badges, number })
                    — the standard editor row (number, source, translation, validation, AI rail, overflow menu).
                  aq.SourceText(id) — source with key terms and rule highlights. aq.TargetEditor(id, { placeholder }) — the
                    rich-text translation editor (click to edit, autosaves after 1.2s idle / blur / Enter, Tab to the next
                    cell, respects other people's locks, shows their live typing). aq.ValidateButton(id) — N-of-M validation.
                  aq.CommentBadge(id) / aq.AudioBadge(id) — show only when there is something. aq.StatusBadges(id),
                    aq.CellNumber(id), aq.SelectBox(id), aq.HealthRibbon(id), aq.PresenceStack(id), aq.CellNotes(id) (save
                    state, errors, footnotes), aq.FootnoteLine(id), aq.VoiceCard(id), aq.DraftButton(id) (one AI button),
                    aq.DraftActions(id) (draft / regenerate / paragraph), aq.CellMenu(id, anchor, items?) with
                    aq.cellMenuItems(id) → [{ key, icon, label, run }].
                  aq.Toolbar({ start:[…], end:[…] }) — the editor's top row; aq.ChapterPicker() — chapter navigator;
                  aq.ColumnHeader() — source/target header; aq.ReadOnlyBanner().
Actions (Promises; they confirm where the app does): aq.actions.commit(id, text, html?), aq.actions.validate(id),
                  aq.actions.unvalidate(id), aq.actions.draft(ids|id, { regenerate }), aq.actions.regenerate(id),
                  aq.actions.draftParagraph(id), aq.actions.openHistory(id), aq.actions.openComments(id),
                  aq.actions.openAttachments(id), aq.actions.openRule(id, ruleId), aq.actions.openTerm(conceptId),
                  aq.actions.playAudio(id), aq.actions.stopAudio(), aq.actions.recordAudio(id), aq.actions.generateVoice(id),
                  aq.actions.backtranslate(id), aq.actions.saveBacktranslation(id, text), aq.actions.addFootnote(id),
                  aq.actions.suggestNext(id, prefix?) → { text } | null, aq.actions.nextUnfinished(fromId?) → id | null,
                  aq.actions.goNextUnfinished(), aq.actions.edit(id) (open its editor), aq.actions.reveal(id),
                  aq.actions.select(id).
Cell helpers:     aq.cell.state(id) (= useCell(id).value), aq.cell.refresh(id), aq.cell.ref(id), aq.cell.number(id),
                  aq.cell.words(text) (word count, footnotes excluded), aq.cell.plain(html), aq.cell.isStructural(id),
                  aq.cell.toggleDetails(id), aq.cell.scrollTo(id, "center"), aq.cell.focusRow(id).
UI kit (Aquilla-styled; use these instead of your own CSS):
                  aq.ui.Page({ title, subtitle, actions:[…], children:[…] }), aq.ui.Panel({ title, actions, children }) (side
                  panel), aq.ui.Card({ title, subtitle, actions, children, tone, onClick }), aq.ui.Stack({ row, gap, align,
                  wrap, children }), aq.ui.Heading({ text, subtitle }), aq.ui.Text({ text, muted, small }),
                  aq.ui.Button({ label, icon, variant:"primary"|"outline"|"ghost"|"danger", size:"sm", onClick, disabled }),
                  aq.ui.IconButton({ icon, label, onClick }), aq.ui.Badge({ text, tone:"neutral"|"primary"|"success"|"warning"|
                  "danger" }), aq.ui.Stat({ label, value, hint }) (stat.set(value) updates it), aq.ui.Progress({ value, max, tone }), aq.ui.Tabs({ tabs:[{ key,
                  label, icon }], value, onChange }), aq.ui.Input({ value, placeholder, onInput, onEnter }), aq.ui.Textarea(…),
                  aq.ui.Checkbox({ checked, label, onChange }), aq.ui.Select({ options, value, onChange }), aq.ui.Spinner({ label }),
                  aq.ui.Empty({ icon, title, text }), aq.ui.Avatar({ name, color }), aq.ui.Kbd(text), aq.ui.Divider(),
                  aq.ui.Menu(anchor, [{ label, icon, run }]), aq.ui.popover(anchor, node), aq.ui.closePopover(),
                  aq.ui.tooltip(node, text), aq.ui.dialog({ title, body:[…], actions:[{ label, primary, run }] }),
                  aq.ui.confirm({ title, text, action }) → Promise<boolean>, aq.ui.toast(text).

Example — a side panel (mounts ["page","panel"], scopes ["read:cells"], "sdk": 1):
\`\`\`
<script>
(() => {
  const cells = aq.useCells();
  const total = aq.ui.Stat({ label: "words translated", value: "…" });
  const list = aq.ui.Stack({ gap: 6 });
  aq.mount(aq.ui.Panel({ title: "Word count", children: [total, list] }));
  function render() {
    const rows = cells.value.filter((c) => !aq.cell.isStructural(c.cellId));
    let sum = 0;
    list.textContent = "";
    rows.forEach((c) => {
      const n = aq.cell.words(c.target);
      sum += n;
      list.append(aq.ui.Stack({ row: true, justify: "space-between", children: [c.ref || aq.cell.number(c.cellId), aq.ui.Badge({ text: String(n) })] }));
    });
    total.set(sum);
    if (!rows.length) list.append(aq.ui.Empty({ icon: "list", text: cells.loading ? "Loading…" : "No cells yet" }));
  }
  cells.subscribe(render); render();
})();
</script>
\`\`\`
Example — one card per verse with the real editor parts (mounts ["page"], scopes ["read:cells","write:target","write:validation"], "sdk": 1):
\`\`\`
<script>
aq.mount(aq.ui.Page({ title: "Verse cards", children: [aq.CellList({ row: (id) => aq.h("div", { style: { padding: "6px 0" } }, [
  aq.ui.Card({ title: aq.cell.ref(id), actions: [aq.ValidateButton(id)], children: [aq.SourceText(id), aq.TargetEditor(id)] }) ]) })] }));
</script>
\`\`\`
With the SDK you rarely need aquilla.* directly; it stays available for anything the SDK does not cover.`
