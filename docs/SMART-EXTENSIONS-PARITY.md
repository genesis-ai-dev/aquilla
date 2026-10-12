# Smart Extensions editor parity (AQU-1793)

The product's default editor is the Aquilla **native** (built-in) editor ("Aquilla editor").
**Aquilla editor (Smart Extension)** is the same editor rebuilt as a first-party Smart Extension, an opt-in
(`shared/tools/first-party/default-editor*.ts`), written on the extension SDK
(`window.aq`, `shared/tools/sdk/`, see SMART-EXTENSIONS.md). It runs in the same sandboxed,
opaque-origin, no-network frame as any extension and reaches Aquilla only through
the `aquilla.*` bridge. This matrix compares it, feature by feature, with the
built-in editor (`EditorTable` + `TranslatedEditor` + what `ProjectWorkspace`
shows around them for a file). The inventory was taken from the code; where the
brief named something the built-in editor does **not** have on this branch, the
row says so.

Status: **✅ parity** · **🟡 partial** (difference stated) · **🧩 host panel**
(the extension opens the host's own UI, so the behaviour is identical by
construction) · **❌ gap** (reason stated) · **n/a** (the built-in doesn't have
it either).

How it works: editor mounts get the workspace's **editor services**
(`src/lib/tools/editor-services.ts`, assembled in
`src/components/tools/useExtensionEditorServices.ts`). Reads come from the
workspace's own cell store, so the file is read once, not twice. Writes go
through the host's own commit and validation pipeline, attributed with
`tool_origin`. Heavy features (AI drafting, back-translation, rules/health,
TTS, recording, drawers) stay host-owned and are invoked over the bridge. Every
call goes through the scope gate; no extension gets anything privileged.

## Matrix

| # | Feature | Built-in behaviour | Extension | Bridge API |
|---|---|---|---|---|
| **Layout & chrome** |||||
| 1 | Chapter row | `EDITOR_SURFACE_TOOLBAR_CLASS`, 49px, blurred background | ✅ same metrics/tokens | theme vars, `editor.chrome` |
| 2 | Milestone navigator | ‹ [Label · "Verses a–b" ⌄] ›, searchable picker with % translated/validated, prev/next | ✅ incl. vocabulary per kind (chapter/slide/story/…), keyboard | `cells.sections` |
| 3 | Suggested passages | AQU-515 pericope popover next to the navigator | ✅ | `cells.pericopes` |
| 4 | Lens toggle, hidden-cells toggle, ⋯ File options, View settings | `FileChapterToolbar` + `ViewSettingsMenu` | 🧩 the host draws the **same component** over the frame's chapter row; the frame keeps that width clear | `editor.chrome` event |
| 5 | Column header | gutter marks (☑ ⚑ #), Source + language chip, Target + check marks (T, audio) | ✅ | `editor.config` |
| 6 | Lane switcher | chip with ⌄; lanes, "Change target language…", "Add lane…" (maintainers) | ✅ | `editor.setLane`, `editor.openSettings` |
| 7 | Read-only banner | amber banner for viewer/commenter/reviewer roles (and an archived lane, row 77) | ✅ (exact wording since apiRev 5) | `editor.config.canEdit`, `readOnlyLabel` |
| 8 | Responsive layout | md (≥768): 3 columns; below that, target stacked under source; keyed off the **app** viewport | ✅ breakpoints from the app's viewport, not the frame's | theme `--aq-viewport-width` |
| 9 | Typography and colours | Geist Variable, 14px/1.6 cells, light/dark tokens | ✅ app font sent as bytes (FontFace), tokens + `html.dark` | `fonts` event, theme vars |
| 10 | Icons | lucide | ✅ same glyphs, generated from the installed lucide-react | — |
| 11 | Virtualization | LegendList, measured rows, anchor-stable scroll | ✅ windowed rows with measured heights and scroll anchoring, DOM in document order | — |
| 12 | Long books | progressive store load | ✅ first page at once, rest streamed from the **same** store read | `cells.page` (store-backed) |
| 13 | Deep links `?cellId=` | scroll + flash + focus | ✅ | `editor.reveal` |
| 14 | Resume position | last cell per file | ✅ | `storage` |
| 15 | i18n / RTL UI | catalog `t()`, plural rules, `html[dir]` | ✅ the editor uses the app's own catalog in the user's locale | `ui.strings` |
| **Row anatomy** |||||
| 16 | Row grid and states | hover / expanded / selected / has-comments / drafting / hidden | ✅ | — |
| 17 | Paragraph boundary | pilcrow bar + `mt-3` | ✅ | `paragraphStart` |
| 18 | Select box | drag for a range, Shift extends, Cmd/Ctrl toggles, auto-scroll | ✅ | `selection.set` |
| 19 | Selection bar (bulk Translate, Validate, Remove my validations, Harmonize, Voice together) | `SelectionBar` | 🧩 the host's own bar acts on the extension's selection | `selection.set`, `selection.changed` |
| 20 | Stale-source badges | ⚠ direct / ⎇ upstream | ✅ | `cells.signals` |
| 21 | Formatting-loss badge | **B** when source marks are lost | ✅ | `sourceHtml`/`targetHtml` |
| 22 | Open-comments badge | blue bubble + row ring, opens drawer | ✅ | `comments.counts`, `comments.open` |
| 23 | Verse/line number | `cellNumberLabel`, tinted amber/red by issues | ✅ (host computes the label) | `numberLabel`, `cells.signals` |
| 24 | Source context lane | cell label, context, repetition ×N, hidden | ✅ | `label`, `context`, `cells.signals.repetition` |
| 25 | Key terms (source) | term highlight + lookup popover | ✅ highlight + card → opens the concept | `terms.matches`, `terms.open` |
| 26 | Key terms (target), forbidden renderings | chip host / blot | ✅ | `terms.matches` |
| 27 | Rule blots | wavy major/minor/waived underlines, click → rule | ✅ | `cells.signals.issues`, `rules.open` |
| 28 | Health ribbon | smoothed gradient line + tooltip | ✅ (host computes the smoothed ribbon) | `ribbon` |
| 29 | Footnote markers | atomic chips, raw USFM round-trip | ✅ byte-for-byte raw in plain value | — |
| 30 | Presence (others) | initials chips + typing/editing/viewing | ✅ | `presence.peers` |
| 31 | Focus lock | "Locked — X is editing", read-only | ✅ | `presence.list/claim/release` |
| 32 | Live typing preview | peer's draft text + named caret | ✅ | `presence.peers`, `presence.typing` |
| 33 | Remote change while editing | "Discard and reload" bar, never clobbers | ✅ | `cells.changed`, `cells.signals.remoteChanged` |
| **Validation** |||||
| 34 | Validation control | ○ / ✓ / ✓✓ / filled-○ (others), N-of-M | ✅ | `validators`, `validationStatus` |
| 35 | Validators popover | hover 400ms / click: list, "Remove your validation" 🗑, blocked note | ✅ | `cells.unvalidate` |
| 36 | Empty cell | faded unavailable circle | ✅ | — |
| 37 | Auto-validate own edit | `shouldAutoValidateHumanEdit` after commit | ✅ same host path | host `commitTarget` |
| 38 | Repetition propagation | on settle (leaving the cell) / explicit validate, with Undo toast | ✅ same host path | `cells.settle` |
| 39 | Audio validation column | separate check column for files with audio | ✅ per-take vote with the built-in's states (mic / ✓ / ✓✓, filled capsule for others, "1/2" on multi-take lines), validators popover with remove, the faded "no audio" mic and the checking placeholder; drawn only on files with audio | `audio.takes`, `audio.validate`, `audio.unvalidate`, `audio.changed` |
| **Editing** |||||
| 40 | Activation | click read view → editor, caret at click point | ✅ | — |
| 41 | Commit | idle 1.2s, blur, Enter, Tab, page hide | ✅ (hide → blur) | host `commitTarget` |
| 42 | Keyboard | Tab/Shift+Tab, ↑/↓ at edges, Enter, Shift+Enter, Esc, row j/k/↑/↓/Enter | ✅ | — |
| 43 | Next unfinished | Cmd/Ctrl+. | ✅ | — |
| 44 | Formatting | Cmd/Ctrl+B/I/U, bubble menu B I U S code | ✅ | sanitized `html` |
| 45 | Paste | plain text only | ✅ | — |
| 46 | Footnotes | add dialog (numbered/lettered), inline panel edit/delete, Backspace confirm | ✅ | — |
| 47 | Footnote tray mode | `FootnotesTray` beside the table | ✅ the host's tray, fed from the frame's visible rows (`editor.visible`) through the same entry builder the table uses (`visibleFootnoteEntriesFor`); edits there commit like the built-in's | `editor.visible` |
| 48 | Write failure | red inline alert + dismiss | ✅ | — |
| 49 | "Saved" confirmation | ✓ Saved after commit | ✅ | — |
| 50 | Ghost text | **not on this branch** (forecasting is PR #1295) | ✅ generic hook: providers register host-side, Tab/→ accepts, Esc rejects; translation memory ships as the first provider | `suggestions.get/feedback` |
| 51 | IDML slot editing | protected slots in TipTap | ✅ the frame renders the host-prepared slot/token markup and edits only inside editable slots (a `beforeinput` guard refuses typing, deleting or formatting across anchors, as the TipTap guard does); the commit keeps the markup and the host validates the anchors (`validateIdmlEditorCommit`) | cell `idml`, `cells.commit {html}` |
| 52 | Source editing / cell menu (edit source, timestamps, insert/remove/hide) | `CellSourceMenu` | ✅ the ⋮ menu on hover with the same items, reasons and gates (role floors, DCS pin, IDML, timing lock): edit the source in place (`source.cell.commit`, chained on the head, with `tool_origin`), timestamps, hide/show, insert above/below, remove (the host's own confirmation). New scope `write:source` (auto-granted to the first-party editor) | `source.*` |
| **AI** |||||
| 53 | Draft one cell | ✨ with confirm-before-replace (and "don't ask again") | ✅ | `ai.draft` |
| 54 | Regenerate | ↻ on unvalidated text | ✅ | `ai.draft {regenerate}` |
| 55 | Draft paragraph | ¶→ with confirm (all/partial) | ✅ | `ai.draftParagraph` |
| 56 | Drag-across batch | drag over ✨ buttons | ✅ | `ai.draft` (many) |
| 57 | Streaming preview, phase pill, progress bar | overlay + fills | ✅ | `cells.signals.ai` |
| 58 | Set up AI | opens the chooser when not configured | ✅ host opens it | `ai.draft` → host |
| 59 | Translate as you read | File options checkbox, drafts visible cells | ✅ menu is the host's; visible rows reported | `editor.visible` |
| 60 | Examples panel / smart edits / contextual draft card | flag- and evidence-gated | ✅ translation-memory matches (bands, diff, origin, Insert on exact), the autopilot draft card (accept writes it, dismiss reviews it), smart edits behind the same flags (underlined in the read view, accept / dismiss with feedback) | `ai.examples`, `ai.contextual`, `ai.reviewContextual`, `ai.smartEdits`, `ai.smartEditFeedback` |
| 61 | Ask AI / add term from source selection | `SourceSelectionToolbar` | ✅ the toolbar on a source selection (View term only on a matcher hit); Ask AI opens the host's chat with the selection as a chip, View term and Add to terminology open the host's own popovers at the selection | `terms.selection`, `terms.view`, `terms.add`, `agent.ask` |
| **Panels and actions** |||||
| 62 | Rail: comments, history | overflow buttons | 🧩 opens the host drawers | `comments.open`, `history.open` |
| 63 | History drawer + restore/promote | `HistoryDrawer` | 🧩 | `history.open` |
| 64 | Attachments | links + drawer + attach | 🧩 opens the drawer (attach from there) | `attachments.open` |
| 65 | Record audio | mic → recorder | 🧩 host recorder (the frame has no microphone) | `audio.record` |
| 66 | Play audio | ▶ | ✅ host plays (the frame has no network) | `audio.play/stop` |
| 67 | Voice (TTS) | generate + attach the cast voice | ✅ host synthesizes | `audio.generate` |
| 68 | Cell details: health tab | text summary | ✅ | `ribbon` |
| 69 | Cell details: back-translation | read back, regenerate, edit, stale warning | ✅ | `backtranslation.*` |
| 70 | Cell details: issues | list with severity, waived state, open rule | ✅ (waive from the rule card) | `cells.signals.issues` |
| 71 | Audio lens | source column becomes the voice card | ✅ voice card with the take's waveform (host-decoded peaks), drag-to-trim (persisted on the take), play/record, the voice picker, "make a character" (the host's clone dialog) and the take-voice pill; no per-line volume slider (a device preference) | `audio.take`, `audio.trim`, `audio.voices`, `audio.assignVoice`, `audio.clone` |
| 72 | Media/timeline lens (time-ordered files) | timeline + video stacked above/left of the table | 🧩 the extension takes EditorTable's slot **inside** the same media layout; timeline chips, cue drawers and search jumps drive it through the same editor handle (`scrollToCellId`, `focusCellEditorIndex`); playback-follow scrolling is not drawn by the frame | `editor.reveal {focus}` |
| **Not in the built-in (brief items)** |||||
| — | AI-draft badge | removed in AQU-1041 | n/a | `aiDrafted` still delivered |
| — | Assignment gutter chip | data passed, never rendered | n/a | `cells.signals.assignments` |
| — | Alt+arrow shortcuts | don't exist | n/a | — |
| — | "Revert removing validations" | no such built-in feature | ✅ Smart Extensions revert now **puts back validations an extension withdrew** (`shared/tools/revert.ts` `revalidates`) | — |

### apiRev 5 — what dev's built-in editor gained after the apiRev 4 claim (audit 2026-10-12)

Every dev commit since the branch's merge base that touched the built-in editor or the
workspace around it was audited. Host-drawn surfaces were already at parity by construction:
the File options menu (AQU-358 group names, AQU-983 batch validate/draft dialog), the selection
bar (AQU-1722 batch voice), View settings (Editor Settings scroll, the #946 toggle itself), the
rules panel (AQU-1805 jump/fix), comments (AQU-761), the AQU-1463 must-dismiss modal and the
media timeline (AQU-1565). The rest needed work:

| # | Feature | Built-in behaviour | Extension | Bridge API |
|---|---|---|---|---|
| 73 | Integrity explanations (AQU-757) | hover on the line number and the ribbon names each active check and why it fired; aria-label carries it | ✅ same lines, same aria/role/testid (`cell-issue-flag`); check names localized like the built-in's | `cells.signals` issues (`ruleName` localized) |
| 74 | Low-confidence attention (AQU-757) | number tinted when automatic confidence is below the warn threshold; hover "Not yet validated — …" | ✅ (the tint was a silent gap before rev 5) | `ribbon.needsAttention` |
| 75 | Align styles (IDML multi-run cells) | last cell-menu action; tooltip states; "Aligning styles…" overlay; Saved | ✅ same gates, states and overlay, through the host's `alignCellStyles` | `ai.alignStyles`, cell `canAlignStyles`, ai phase `aligning` |
| 76 | Validated vs guessed words (#946) | green/orange wash over AI drafts, cited example on hover, read view and editor, recomputed as you type | ✅ painted with the CSS Custom Highlight API (read view and editing surface), host-computed spans (re-measured on the live draft), cited example as the hover title | cell `healthSpans`, `ai.healthSpans` |
| 77 | Read-only banner wording | role / imported / reviewer-without-text-validation / archived-lane sentences, `role-read-only-banner` / `lane-archived-banner` | ✅ the built-in's own label and testid (row 7 was really 🟡 before: one generic sentence) | `editor.config.readOnlyLabel/readOnlyKind` |
| 78 | Archived lane locks writes (AQU-1463) | target edits and validation off for every role | ✅ | `editor.config.canEdit/canValidate` |
| 79 | Focus locks per lane (AQU-1808) | a lease on another lane never locks this row | ✅ only the active lane's leases reach the frame | `presence.changed` |
| 80 | Presence per connection (AQU-1791) | cell rows stay per connection while the roster collapses a user | ✅ per-connection rows (a second tab keeps its caret) | `presence.peers` |
| 81 | Empty time-ordered file (AQU-1565/1566) | linked-video panel (captions as rows / use a track), attach media, or waiting | 🧩 the host's own component (`TimeOrderedEmptyState`, shared with EditorTable) in place of a blank frame | — |
| 82 | Voice failure reason (AQU-510) | localized, actionable sentence (`categorizeAiError`) | ✅ the host returns the same sentence | `audio.generate` |

**Count:** **82/82 at parity** — 74 ✅ and 8 🧩 (host UI, identical by construction). Before
rev 5, measured against the current dev: 71/82 (row 7 partial; rows 73–82 missing). The
original 72 rows: 65 ✅ and 7 🧩; the last seven (39, 47, 51, 52, 60, 61, 71) landed in apiRev 4.

## Remaining differences

None of the 82 rows is partial. Small, deliberate differences, stated in their rows: smart edits
underline the read view rather than the open editor (they are flag-gated and off by default), and
the Audio lens has no per-line volume slider (a per-device preference). Structural source edits
(insert / remove / hide) run through the host's own handlers, so they are attributed to the user
without a `tool_origin` stamp; the source text commit carries one. Tool revert ("revert since T")
covers target and validation writes, not structural source changes — `write:source` is a separate,
explicit scope for that reason. The provenance wash (row 76) is painted with the CSS Custom
Highlight API (Chromium 105+, Safari 17.2+, Firefox 140+); a browser without it shows no wash in
the extension editor, and the cited example appears as the native hover title rather than a
decorated element.

## Sandbox notes

Nothing here weakened the sandbox. The frame still has no network, no storage
of its own, no microphone and no app DOM. Fonts arrive as bytes. Audio plays
and records in the host. Panels open in the host. The one host element drawn
over the frame is the workspace's own file toolbar, which is app chrome, not
extension content.
