# Smart Extensions editor parity (AQU-1793)

The product's default editor is **Aquilla Editor**, a first-party Smart Extension
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
| 7 | Read-only banner | amber banner for viewer/commenter/reviewer roles | ✅ | `editor.config.canEdit` |
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
| 39 | Audio validation column | separate check column for files with audio | 🟡 header shows the audio check mark; per-row audio validate isn't drawn | — |
| **Editing** |||||
| 40 | Activation | click read view → editor, caret at click point | ✅ | — |
| 41 | Commit | idle 1.2s, blur, Enter, Tab, page hide | ✅ (hide → blur) | host `commitTarget` |
| 42 | Keyboard | Tab/Shift+Tab, ↑/↓ at edges, Enter, Shift+Enter, Esc, row j/k/↑/↓/Enter | ✅ | — |
| 43 | Next unfinished | Cmd/Ctrl+. | ✅ | — |
| 44 | Formatting | Cmd/Ctrl+B/I/U, bubble menu B I U S code | ✅ | sanitized `html` |
| 45 | Paste | plain text only | ✅ | — |
| 46 | Footnotes | add dialog (numbered/lettered), inline panel edit/delete, Backspace confirm | ✅ | — |
| 47 | Footnote tray mode | `FootnotesTray` beside the table | 🟡 the host tray is mounted, but the frame doesn't feed it the visible footnotes; footnotes show inline in the rows instead | — |
| 48 | Write failure | red inline alert + dismiss | ✅ | — |
| 49 | "Saved" confirmation | ✓ Saved after commit | ✅ | — |
| 50 | Ghost text | **not on this branch** (forecasting is PR #1295) | ✅ generic hook: providers register host-side, Tab/→ accepts, Esc rejects; translation memory ships as the first provider | `suggestions.get/feedback` |
| 51 | IDML slot editing | protected slots in TipTap | 🟡 the host validates every commit (`validateIdmlEditorCommit`), but the frame edits as rich text | host `commitTarget` |
| 52 | Source editing / cell menu (edit source, timestamps, insert/remove/hide) | `CellSourceMenu` | ❌ needs `source.*` write scopes; not added in this round | — |
| **AI** |||||
| 53 | Draft one cell | ✨ with confirm-before-replace (and "don't ask again") | ✅ | `ai.draft` |
| 54 | Regenerate | ↻ on unvalidated text | ✅ | `ai.draft {regenerate}` |
| 55 | Draft paragraph | ¶→ with confirm (all/partial) | ✅ | `ai.draftParagraph` |
| 56 | Drag-across batch | drag over ✨ buttons | ✅ | `ai.draft` (many) |
| 57 | Streaming preview, phase pill, progress bar | overlay + fills | ✅ | `cells.signals.ai` |
| 58 | Set up AI | opens the chooser when not configured | ✅ host opens it | `ai.draft` → host |
| 59 | Translate as you read | File options checkbox, drafts visible cells | ✅ menu is the host's; visible rows reported | `editor.visible` |
| 60 | Examples panel / smart edits / contextual draft card | flag- and evidence-gated | ❌ not built in this round (flagged features) | — |
| 61 | Ask AI / add term from source selection | `SourceSelectionToolbar` | ❌ not built in this round | — |
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
| 71 | Audio lens | source column becomes the voice card | 🟡 voice card with play/record/generate·voice; no waveform/trim/clone | `voice`, `audio.*` |
| 72 | Media/timeline lens (time-ordered files) | timeline + video stacked above/left of the table | 🧩 the extension takes EditorTable's slot **inside** the same media layout; timeline chips, cue drawers and search jumps drive it through the same editor handle (`scrollToCellId`, `focusCellEditorIndex`); playback-follow scrolling is not drawn by the frame | `editor.reveal {focus}` |
| **Not in the built-in (brief items)** |||||
| — | AI-draft badge | removed in AQU-1041 | n/a | `aiDrafted` still delivered |
| — | Assignment gutter chip | data passed, never rendered | n/a | `cells.signals.assignments` |
| — | Alt+arrow shortcuts | don't exist | n/a | — |
| — | "Revert removing validations" | no such built-in feature | ✅ Smart Extensions revert now **puts back validations an extension withdrew** (`shared/tools/revert.ts` `revalidates`) | — |

**Count:** of the 72 rows, 58 are ✅, 7 are 🧩 (host panel, identical by construction), 4 are 🟡 and 3 are ❌.
So 65 of 72 are at parity, 4 are partial and 3 are gaps.

## Remaining gaps, and why

- **Source editing / cell menu (52).** These are `source.*` events (PROJECT_LEAD+). They need new
  write scopes and their own revert semantics. That's a design call to make, not a technical blocker.
- **Examples, smart edits, contextual draft card, selection toolbar (60, 61).** These are flag- or
  evidence-gated surfaces. They'd be bridged the same way as AI drafting (the host computes, the
  frame renders). Not built in this round.
- **Partial rows (39, 47, 51, 71).** The data is all available over the bridge; these are
  rendering work.

## Sandbox notes

Nothing here weakened the sandbox. The frame still has no network, no storage
of its own, no microphone and no app DOM. Fonts arrive as bytes. Audio plays
and records in the host. Panels open in the host. The one host element drawn
over the frame is the workspace's own file toolbar, which is app chrome, not
extension content.
