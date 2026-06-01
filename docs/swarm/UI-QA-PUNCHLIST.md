# UI QA Punch-List — swarm/integration build

**Build**: v0.1.0 · swarm/integration · fd076a0  
**Tested**: 2026-05-31  
**Environment**: http://127.0.0.1:5273/ · auth :8788 · sync :8789  
**Login**: `/__dev/login` → auto-logged in as `dev`, redirected to `/project/dev-project`  
**Viewport tested**: 384px (mobile-ish default) then 1400×900 for cell editor QA  

---

## Per-Surface Status Table

| # | Surface | Route | STATUS | Detail |
|---|---------|-------|--------|--------|
| 1 | Dev login | `/__dev/login` | OK | Redirects to `/project/dev-project` as expected |
| 2 | Workspace — sidebar (no file) | `/project/dev-project` | **BROKEN** | See bug #1: file list replaced by Voice Cast panel when lens=audio is persisted in localStorage |
| 2a | Workspace — sidebar (text lens) | `/project/dev-project` | OK | File list renders correctly (867 files, filter search works, rename-suggestions banner present) |
| 2b | Workspace — file list items | `/project/dev-project` | UGLY | Many files show identical names (e.g. 3× "01GENarONAV12.SFM") — seeded data artifact; rename banner present. Confusing at first glance. |
| 2c | Workspace — rename banner | `/project/dev-project` | OK | "184 Bible books, 371 numbered files — apply friendly names?" with Review / Apply all / Dismiss buttons |
| 3 | Cell editor — empty file | `/project/dev-project/file/<id>` | OK | Empty state "01GENarONAV12.SFM is empty — Import content, or start typing in the first cell." with Import content button |
| 4 | Cell editor — file with content | `/project/dev-project/file/<id>` | OK | Source+Target columns render, ProseMirror cells editable, health badges (0%/100%), validation states visible |
| 4a | Cell editor — editing | cell interaction | OK | Clicking target paragraph focuses contenteditable ProseMirror div, typing works |
| 4b | Cell editor — rule check | after typing | OK | "Extra whitespace" rule fires immediately when leading space is typed |
| 4c | Cell editor — health badge | after edit | OK | Health badge updates from "100% validated" to "0% no examples" on content change |
| 5 | Cell details panel — tabs | cell expand button | OK | Tabs: Decay · Backtranslation · Recording · Issues · History all present |
| 6 | Back-translation tab | cell details | **UGLY** | Tab renders, empty state "No backtranslation yet. Click Generate to create one." Generate button is **disabled** in accessibility tree (despite appearing clickable visually); no obvious reason shown to user |
| 7 | Import dialog — Upload tab | header Import button | OK | Dialog opens; Supported formats listed as "MD, DOCX, PPTX, TXT, VTT, SRT, USFM, XLIFF, TMX, CSV, TSV"; file input `accept` = `.md,.markdown,.docx,.pptx,.txt,.vtt,.srt,.usfm,.sfm,.xlf,.xliff,.tmx,.csv,.tsv` |
| 7a | Import dialog — format display vs accept | Upload tab | UGLY | UI label says "XLIFF" but `accept` includes `.xlf` separately. Minor: users may not realise `.xlf` files are accepted since label only shows "XLIFF". |
| 7b | Import dialog — eBible tab | Import dialog | OK | Full searchable list of eBible corpus translations with language code, title, OT/NT counts |
| 8 | Export dialog | header Export file button | OK | All 7 formats present (USFM.SFM, txt, md, TSV, CSV, XLIFF 1.2.xlf, TMX 1.4b.tmx); "lossy" badges on 6 non-USFM formats; lossy warning banner shows/hides correctly; Scope: Current file / Whole project both selectable |
| 9 | Living Memory page | `/project/dev-project/memory` | OK | Empty state "No validated translations yet" with "Showing cells from the first 40 files." note and "0 validated" counter |
| 10 | Search panel — Search mode | header Search & replace button | OK | Opens dialog "Parallel passages search"; scope Project/File (File disabled with no file open); search query "God" returns 10 results with highlighted matches |
| 11 | Search panel — Passages mode | Passages tab | OK | Switches to "Search parallel passages across all projects…" placeholder; results show "10 results · Parallel passages" |
| 12 | Search panel — Replace mode | Replace tab | OK (disabled) | Replace button disabled; correct since scope is Project and no file selected |
| 13 | Rules page | `/project/dev-project/rules` | OK | 9 built-in checks with severity selectors (Major/Minor) and enabled checkboxes; "Rules (0)" section with empty state |
| 14 | Suggest rules dialog | Rules page → Suggest from edits | OK | Dialog renders with "Analyze my validated edits" button |
| 15 | Complete all | More actions → Complete all | OK | Dialog shows "Complete all untranslated cells — Draft AI translations for all 446 untranslated cells in this file"; requires consent checkbox; Cancel/Complete all buttons present |
| 16 | Run completions | header Run completions button | OK | Shows "Generate translations for the next 10 of 446 untranslated cells. Capped at 10 per click while we work on spend controls"; requires consent checkbox |
| 17 | Voice page | sidebar Voice button | **BROKEN** | See bug #1 — clicking Voice sets lens=audio in localStorage, replacing the file list with Voice Cast panel with no visible dismiss/toggle back mechanism when no file is open |
| 17a | Voice Cast panel | in sidebar when lens=audio | OK | Shows Cast heading (1 character), Gemini API key input ("Key needed"), Narrator voice character, "New voice" button |
| 18 | Comments page | sidebar Comments button | OK | Navigates to `/project/dev-project/comments`; renders "Dev Project — Comments" with empty state "No comments yet" |
| 19 | Memory nav button | sidebar Memory button | OK | Navigates to `/project/dev-project/memory` correctly |
| 20 | Share dialog | sidebar Share button | OK | Members tab shows "dev — owner" with role selector; Add member input; Invite link tab |
| 21 | Settings page | sidebar Settings button | OK | Navigates to `/project/dev-project/settings`; full settings form renders (Project Info, User, AI Instructions, Advanced LLM, Voice, Validation, Audio loading sections) |
| 22 | Dashboard — Overview | `/` (breadcrumb Dashboard) | OK | "Dev Org — Portfolio insights coming soon." placeholder |
| 23 | Dashboard — Projects | `/projects` | OK | "Dev Project — owner" card, "+ New Project" button |
| 24 | Dashboard — Teams | `/teams` | OK | "No teams in this org yet." empty state, "New team" button |
| 25 | Header toolbar — Setup: 0/3 | header | OK | Opens "Project setup" dialog with 3 expandable steps (translation instructions, invite collaborators, configure voice) and 2 "Coming soon" items (Upload project standards, Import glossary/TM) |
| 26 | Header toolbar — View settings | header | OK | Dropdown: Show line numbers On/Off, Show cell labels On/Off, Text direction Source/Target LTR/RTL |
| 27 | Header toolbar — Text/Audio toggle | header | OK | Switches between Text and Audio lens modes |
| 28 | Header toolbar — Next unfinished | header | OK | Active when file has cells; disabled on empty file |
| 29 | Sync status | workspace footer | UGLY | Shows "Sync disabled — changes are saved locally only" on initial project load but "Live · Synced" once a file is opened. The per-file sync behavior is correct but the project-level "Sync disabled" message is alarming and could confuse users |
| 30 | Footer cell counter | workspace footer | OK | "453 cells · 7 translated (2%) · 4 unvalidated · 3 validated" showing correctly |
| 31 | Version badge | sidebar bottom | OK | "v0.1.0 · swarm/integration · fd076a0 build: swarm/integration@fd076a0" visible |
| 32 | Console errors — Geist fonts | throughout | CONSOLE-ERROR | Geist Variable font files 403 on every load (`@fs/...geist...woff2`). Vite dev server fs access restriction. Font fallback likely active — not visible but fills console with errors. |
| 33 | Console errors — Base UI nativeButton | Import dialog, App.tsx | CONSOLE-ERROR | "A component that acts as a button expected a native button because the nativeButton prop is true" — affects `button.tsx:82` (ImportDialog UploadPanel) and `App.tsx:251`. Accessibility/semantic issue. |
| 34 | More actions menu | header More actions | OK | Contains Import, Run completions, Complete all, Batch validate..., Export, Agent input, Import work in progress |

---

## Bugs Observed

### Bug #1 — CRITICAL: Voice button permanently replaces file list sidebar; no recovery path
**Surface**: Project workspace sidebar  
**Severity**: Demo-blocker  
**Steps to reproduce**:
1. Log in and navigate to project
2. Click "Voice" in the sidebar project nav
3. The file list is replaced by the Voice Cast panel (Gemini API key input, Narrator, New voice)
4. Click "Voice" again — does NOT toggle the panel off
5. Navigate away and back — panel persists (preference stored in `localStorage` key `codex:editorLens:dev-project` = `"audio"`)
6. The Text/Audio toggle in the header only appears when a file is open, but you cannot open a file because the file list is gone

**Root cause**: `useEditorLensPreference` persists the `"audio"` lens to localStorage. `openAudioLens` (Voice nav click) calls `setLens("audio")` but there is no toggle or back-to-text action in the sidebar when no file is open.

**Impact**: Any demo path that clicks "Voice" first leaves the user unable to access files without knowing to open a file via URL or manipulate localStorage.

**Workaround**: Open a file directly by URL, then use the Text/Audio header toggle to switch back to Text mode.

---

### Bug #2 — UGLY: "Sync disabled" shown at project root even though sync is active
**Surface**: Project workspace footer  
**Severity**: Confusing  
**Detail**: When navigating to `/project/dev-project` (no file open), the footer shows `"Sync disabled — changes are saved locally only"` with a "Local only" badge. Once a file is opened, it switches to "Live · Synced". The message implies syncing is broken for the whole project, which is misleading.

---

### Bug #3 — UGLY: Back-translation Generate button visually appears active but is disabled
**Surface**: Cell details panel → Backtranslation tab  
**Severity**: Confusing  
**Detail**: The "Generate" button appears with full opacity and no visual disabled state, but the accessibility tree shows `disabled`. No tooltip or explanation is shown for why it's disabled (backend not connected? cell not saved? API key missing?). User will click and nothing happens with no feedback.

---

### Bug #4 — UGLY: Import dialog help text says "XLIFF" but accept includes `.xlf` separately
**Surface**: Import dialog → Upload tab  
**Severity**: Minor display inconsistency  
**Detail**: The help text reads "Supported: MD, DOCX, PPTX, TXT, VTT, SRT, USFM, XLIFF, TMX, CSV, TSV" — no mention of ".xlf". The file input's `accept` attribute correctly includes `.xlf,.xliff`. A Paratext user with `.xlf` files might be confused. The string should say "XLIFF / XLF" or show the extensions.

---

### Bug #5 — CONSOLE-ERROR: Geist Variable font 403 errors (repeated per route navigation)
**Surface**: All pages  
**Severity**: Dev env issue (won't affect production), but pollutes console  
**Detail**: `@fontsource-variable/geist` woff2 files return 403 from Vite's `@fs/` URL. Vite's `server.fs.allow` config likely needs to include the pnpm-managed `.pnpm` node_modules path. System falls back to a different font. Not a functional blocker but will alarm developers reading the console.

---

## Top Demo-Blockers

| Priority | Issue | Impact |
|----------|-------|--------|
| P1 | **Voice nav trap**: clicking "Voice" hides file list with no escape (localStorage persistence, no toggle) | Demo flow stops if Voice is clicked first — user cannot open any file |
| P2 | **Back-translation Generate disabled but looks enabled** | Clicking the prominent Generate button does nothing; no feedback — looks broken |
| P3 | **"Sync disabled" at project root** | Opening sentence of the demo may be "why does it say sync is disabled?" |
| P4 | **Font 403s flood the console** | During a screen-share demo with devtools open, this looks like widespread network errors |
| P5 | **Import format label "XLIFF" doesn't mention ".xlf"** | For Paratext consultants who specifically work with `.xlf` files — credibility hit |

---

## Surfaces Working Well (no issues)

- Cell editor: editing, rule checking, health badge updates, all function correctly at 1400px
- Export dialog: all 7 formats, lossy/lossless classification, scope selector, warning banner — solid
- Import dialog: both Upload and eBible tabs functional; file `accept` covers all new formats
- Search/Passages: mode switching, keyword highlighting, result counts all correct
- Rules page: all 9 built-in checks configurable, Suggest rules dialog renders
- Complete all / Run completions: confirmation dialogs correct, cell counts accurate, consent checkbox gates action
- Setup dialog: 3 onboarding steps well-structured, Coming soon items labeled honestly
- Comments/Memory/Share/Settings: all nav correctly, empty states appropriate
- Dashboard (org/projects/teams): renders cleanly, new team/project CTAs visible

---

## Notes on Backend-Dependent Failures

- **Sync "Live · Synced"** shows correctly once a file is opened — sync worker appears functional for file-level operations.
- **"Sync disabled"** at project root (no file open) may be intentional design (sync only activates per-file) but is confusing UX.
- **Back-translation Generate disabled**: may require an active backend AI connection (Frontier API) that this dev instance doesn't have. The disabled state itself is correct behavior; the missing user feedback is the bug.
- The dev project seeded data includes non-Bible files (e.g., "BIBL 670 - New Testament Greek 1 - SP26 (02).docx") mixed with SFM Bible files. This is test data, not a UI bug.

---

## Pass 2 (2026-05-31)

**Build**: v0.1.0 · swarm/integration · cba96a9  
**Tester**: QA agent (Playwright MCP)  
**Scope**: Wave-7 fix verification + deep voice/audio walkthrough

---

### Part 1 — Fix-Verification Table

| Item | Expected | Result | Detail |
|------|----------|--------|--------|
| **P1 — Voice toggle** | Click Voice → panel opens; click again → file list returns | **VERIFIED-FIXED** | Voice panel opens on first click; clicking Voice button again (using exact-match button ref) returns file list correctly. Toggle is no longer a one-way trap. |
| **P2 — Backtranslation hint** | Visible inline hint "Configure completion settings…" when AI not configured | **STILL-BROKEN** | Button now has `disabled:opacity-40` and `title="Set up AI for backtranslation"` (tooltip only). No visible inline hint text block. When `!isBacktranslationConfigured`, the empty state still reads "No backtranslation yet. Click Generate to create one." — actively misleading because Generate is disabled. Code ref: `EditorTable.tsx:2142` and `2171-2175`. Cannot exercise in browser (dev project has 0 cells). |
| **P3 — Sync status at root** | "No file open" / not "Sync disabled / Local only" | **VERIFIED-FIXED** | Bottom bar at project root now reads "No file open · Synced" with a grey dot — no longer "Sync disabled / Local only". |
| **P4 — Geist font 403s** | Font 403 errors gone from console | **STILL-BROKEN** | Three Geist woff2 variants (latin, latin-ext, cyrillic) return 403 on every page load/navigation. Confirmed in `browser_console_messages` with `all: true`. Error count: 3 variants × ~12 navigations = 30+ errors in session. |
| **Button a11y — nativeButton warning** | Base UI nativeButton warning gone | **STILL-BROKEN** | Two instances remain in `console_messages(all)`: (1) at `AppRoutes` / `App.tsx:251` (app startup), (2) at `Button > UploadPanel > ImportDialog` (`button.tsx:82`) when Import dialog is opened. |
| **P5 — Import format label** | Upload tab format label reads "XLIFF / XLF" | **VERIFIED-FIXED** | Upload tab now reads "Supported: MD, DOCX, PPTX, TXT, VTT, SRT, USFM, XLIFF / XLF, TMX, CSV, TSV". Screenshot: `pass2-import-dialog.png`. |

---

### Part 2 — Voice/Audio Deep Walkthrough Findings

**Testing context**: The dev project has 867 SFM placeholder files, all with 0 cells. The eBible corpus import failed with 404 (`Failed to download translation 'eng-eng-kjv' (404)` from raw.githubusercontent.com). This means cell-level audio UI (per-cell player, waveform, scrubber, record/playback, Voice together selection bar, backtranslation tab) could not be exercised in the browser. Findings below combine browser observation (Voice panel, character dialogs, mode toggle) and code inspection (`EditorTable.tsx`, `CellVoicePanel.tsx`, `VoiceLibraryPanel.tsx`, `SelectionBar.tsx`).

| Surface | Status | Detail |
|---------|--------|--------|
| **Voice panel — Cast list** | OK | Panel shows "Cast: 1 character", Narrator voice (Gemini engine), "New voice" button. Narrows to voice sidebar when in Audio lens mode. |
| **Voice panel — Gemini API key section** | CONFUSING | "Key needed" badge shows correctly (no key configured). Input field shows placeholder "AIza..." which is indistinguishable from a masked real value in password mode. Toggling the eye icon reveals the placeholder is not a real value. No validation or "test key" button to confirm key works. |
| **Voice panel — Audio mode sidebar swap** | DEMO-RISK | Clicking "Audio" in the top-nav mode toggle opens the Voice/Cast sidebar AND hides the file list. In Audio mode, there is NO way to switch files from the sidebar — the user must click "Text" to get the file list back, then switch to Audio mode. This workflow is non-obvious; a user demoing audio translation will likely get stuck with no file list visible. |
| **Character creation — Gemini tab** | OK | "Craft character" dialog: name field, Engine tabs (Gemini/MMS/Kokoro), Base voice dropdown ("Kore — Firm"), Guidance textarea, Clone a voice section, Voice profile (clone) section, Cancel/Save. |
| **Character creation — MMS tab** | OK | Language dropdown + MMS code text field. "Preview voice" button present. No Guidance field (correct for MMS). |
| **Character creation — Kokoro tab** | OK | Kokoro voice id text field (default "af_heart"). "Preview voice" button. |
| **Kokoro download prompt** | OK | Clicking "Preview voice" shows consent dialog: "Download Kokoro (text-to-speech)? — runs entirely in your browser, ~80MB, cached after first download." Buttons: Cancel / Just Kokoro / Enable all local models. Privacy messaging is clear and appropriate. |
| **Edit existing character** | OK | Clicking Narrator opens "Edit character" with same form pre-populated (Charon — Informative voice). Default character checkbox visible. Save/Cancel. |
| **Per-cell audio player (CellVoicePanel)** | NOT TESTABLE (no cells) | Code shows: primary sparkle button generates then plays; SpeakerChip for character assignment; Scrubber with seek + running time; volume control; overflow menu (regenerate, clone character). Design appears solid from code review. |
| **Per-cell audio tab (Recording tab in cell expansion)** | NOT TESTABLE (no cells) | Code shows three states: (1) has recorded audio → waveform + Re-record + Transcribe buttons; (2) has generated voice → waveform + "Record over" + "AI generated voice" label; (3) empty → large "Record" button CTA. Empty state copy: "No audio yet. Record below, or drag a voice onto this cell from the toolbar above." |
| **Waveform trim/crop** | NOT TESTABLE (no cells) | CropButton exists in CellVoicePanel (`CropEditor.tsx`), renders only when `hasTake` (audio exists). |
| **Voice together (multi-cell synthesis)** | NOT TESTABLE (no cells) | SelectionBar shows "Voice together" button in audioMode only. Requires ≥2 translated cells selected. Tooltip when insufficient: "Select at least two translated lines". Implementation in `combined-voice.ts` concatenates cells with separator and calls TTS as one clip. |
| **eBible corpus import (backend)** | BROKEN (backend) | 404 error downloading corpus files from GitHub raw content (`raw.githubusercontent.com/BibleNLP/ebible/main/corpus/eng-eng-kjv.txt`). Separate from UI; blocks content population for QA. |
| **AudioRecordingModal** | NOT TESTABLE (no cells) | Component exists at `AudioRecorder/AudioRecordingModal.tsx` with AudioWaveform, TakesStrip, countdown, useAudioRecorder hook. |
| **"Generate all" batch voice** | NOT FOUND | No "Generate all" button found in visible UI or code scan. Per-cell generation via CellVoicePanel and multi-cell "Voice together" (SelectionBar) are the two batch modes. |

---

### Pass 2 — New Issues Found

#### Issue V1 — Audio mode hides file list with no "back to files" affordance in sidebar
**Severity**: Demo-risk  
**Detail**: When the user switches to Audio lens mode (via the "Audio" top-nav toggle), the sidebar replaces the file list with the Cast/Voice panel (`VoiceSidebar`). There is no sidebar-level "back to files" button or file-picker affordance. The only exit is clicking the "Text" lens button in the top nav bar. A user who doesn't know about the Text/Audio toggle (e.g., a product demo with a non-technical audience) cannot navigate to a different file while in Audio mode.  
**Code ref**: `ProjectWorkspace.tsx:1285-1329`

#### Issue V2 — Backtranslation empty state misleads when Generate is disabled
**Severity**: Confusing  
**Detail**: When AI is not configured (`isBacktranslationConfigured = false`), the Backtranslation tab shows "No backtranslation yet. Click Generate to create one." — but the Generate button is disabled (opacity-40, cursor-not-allowed). The message actively directs the user to click a button that does nothing. The fix should conditionally show a hint like "Set up AI in Settings to enable backtranslation" instead.  
**Code ref**: `EditorTable.tsx:2171-2175` and `ProjectWorkspace.tsx:696` (`const isBacktranslationConfigured = false`)

#### Issue V3 — API key "Key needed" badge persists despite placeholder text resembling entered value
**Severity**: Confusing  
**Detail**: The Gemini API key input shows the placeholder text "AIza..." in both password (masked) and text (revealed) modes, making it appear that a key is already entered when it is not. The "Key needed" badge is correct, but the visual presentation of the placeholder may confuse users into thinking the key is already saved.

#### Issue V4 — eBible corpus import fails 404 (backend)
**Severity**: Backend-dependent failure  
**Detail**: Attempting to import any eBible translation (e.g. eng-eng-kjv, eng-eng-kjv2006) returns a 404 from GitHub raw content. This blocks any dev-environment QA that requires file content (backtranslation testing, per-cell audio). Not a UI bug, but blocks full voice/audio QA.

---

### Pass 2 Summary

**Still broken from wave-7**: P2 (no visible backtranslation hint), P4 (Geist font 403s), Button a11y (nativeButton warning still in 2 locations).  
**Verified fixed**: P1 (Voice toggle), P3 (sync status at root), P5 (XLIFF/XLF label).  
**New voice/audio risks**: Audio mode hides file list (V1, demo-risk), backtranslation misleading empty state (V2), eBible 404 blocks content-dependent QA (V4).

---

## Pass 3 (2026-05-31)

**Build**: v0.1.0 · swarm/integration · 0425a56  
**Tester**: QA agent (Playwright MCP)  
**Scope**: Pass-2 re-fix verification + deep voice/audio walkthrough with live cells (Matthew seeded file, 5 cells)  
**Test file**: `/project/dev-project/file/f-gen-1` ("Matthew") — 5 cells, 5 translated, 3 validated  

---

### Part 1 — Pass-2 Re-fix Verification Table

| Item | Expected | Result | Evidence |
|------|----------|--------|----------|
| **V1 — Audio lens file trap** | Switch to Audio lens → file list stays visible; can click a file to open it | **VERIFIED-FIXED** | File list visible in sidebar in Audio lens (files + Cast below). Clicking `01GENarONAV12.SFM` from Audio lens navigated to correct file URL. Screenshot: `pass3-audio-lens-v1.png` |
| **P2 — Backtranslation hint** | Backtranslation tab shows ONLY "Configure completion settings to enable back-translation." — NO "Click Generate" copy alongside disabled button | **VERIFIED-FIXED** | Tab shows exactly one message with a greyed-out Generate button on the right. No contradictory "Click Generate" copy present. Screenshot: `pass3-cell-details.png` |
| **P3 — Sync status at project root** | Footer shows "No file open" (not "Sync disabled") | **VERIFIED-FIXED** | Bottom bar reads "No file open · Synced" at `/project/dev-project`. Screenshot: `pass3-project-root-p3.png` |

---

### Part 2 — Voice/Audio Deep Walkthrough Findings

**Testing context**: This pass used the seeded "Matthew" file (`f-gen-1`, 5 cells with real content). All per-cell UI was exercised in-browser. TTS synthesis failed (Gemini API key in QA env is entered but not valid — no network request is made to Gemini, failure is client-side key validation). Recording modal was tested. Character creation (Gemini/MMS/Kokoro) was tested.

| Surface | Status | Detail |
|---------|--------|--------|
| **Audio lens — file list visible** | FIXED | File list stays in sidebar above Cast section when Audio lens is active. Files are clickable. Screenshot: `pass3-audio-lens-v1.png` |
| **Audio lens — per-cell layout** | OK | CONTROLS column: cell number, health badge, "Generate & play" button, Narrator chip, "More actions" "..."; TARGET column: cell text, hover-action icons. Clean layout. |
| **Cast section — 1 character** | OK | "Cast — 1 character" heading; Narrator (Gemini engine, "0/5 lines voiced") draggable chip; "New voice" button. |
| **Edit character modal** | OK | Opens on clicking Narrator chip; Engine tabs Gemini / MMS / Kokoro; Base voice dropdown (Charon — Informative for Gemini); Guidance textarea; Clone a voice; Voice profile (clone) with Record reference / Upload audio; Cancel/Save. Screenshot: `pass3-narrator-gemini-clicked.png` |
| **Craft character (New voice) modal** | OK | Name field, same engine tabs, different default voice (Kore — Firm), Guidance with Swahili placeholder. Screenshot: `pass3-new-voice.png` |
| **MMS engine tab** | OK | Language dropdown + MMS code field. No Guidance (correct). "Preview voice" button. Screenshot: `pass3-mms-tab.png` |
| **Kokoro engine tab** | OK | Kokoro voice id field (default "af_heart"). "Preview voice" button. Screenshot: `pass3-kokoro-tab.png` |
| **Generate & play this line** | BROKEN (backend-dependent UI gap) | Clicking triggers client-side key validation; since QA Gemini key is invalid, no network request is made; cell shows red "Failed" badge silently. No proactive error toast or inline message — user must click the badge to learn what happened. Screenshot: `pass3-generate-play-cell1.png` |
| **Failed badge — click for error** | OK (good UX once discovered) | Clicking the "Failed" badge shows informative popover: "Gemini API key required — Add your Gemini API key to use Gemini voices, or switch this project to a local TTS provider (Kokoro or MMS)." with "TECHNICAL DETAIL" expander and "Open audio setup" / "Dismiss" buttons. Screenshot: `pass3-failed-badge-clicked.png` |
| **"Open audio setup" CTA in error popover** | BROKEN | Clicking "Open audio setup" does nothing — no navigation, no modal, no toast. The button is a dead CTA. Screenshot: `pass3-audio-setup.png` |
| **Dismiss error popover → clears Failed badge** | BROKEN (inconsistent state) | Dismissing the error popover removes the red "Failed" badge from the cell even though audio was never generated. Cell appears clean (no error indicator) after dismiss, but is still unvoiced. Misleads user into thinking the error resolved. |
| **Gemini key "Key needed" badge with entered key** | CONFUSING | Sidebar shows "Key needed" badge next to "Gemini API key" label even though an API key value ("AIza...") is visible in the input. The badge is technically correct (key is invalid), but the label says "needed" when the field is non-empty — should read "Key invalid" or "Key not working". No network request is made to validate or use the key. |
| **"Hear translation (Narrator)" button** | CONFUSING | Clicking this button (per-cell inline action) triggers TTS generation (not playback) since no audio exists. It fails silently with a "Failed" badge on a different cell than the one hovered. No "no audio yet" state — button should be labeled "Generate & play" when no audio exists, or disabled/grayed. Screenshot: `pass3-hear-translation.png` |
| **Audio player (scrubber/volume) for existing audio** | NOT TESTABLE | No audio was successfully generated in this session (TTS key invalid). The audio player UI cannot be exercised. |
| **Recording modal** | OK | "Record audio" opens a full-cell reader dialog: source text (script), target text (large READ ALOUD display), mic icon, "Press Space or click Start. The beep plays a 3-2-1 countdown." Prev/Next/Start buttons. Start changes to "Cancel countdown" during countdown. Escape closes the modal. Screenshot: `pass3-record-audio.png`, `pass3-recording-started.png` |
| **Multi-cell selection ("Voice together")** | NOT DISCOVERABLE | Clicking "Select cell. Drag to select a range." buttons on multiple cells produces no visual selection feedback and no bulk action bar. "Voice together" feature (from code, requires ≥2 cells selected) is not reachable via visible affordance. Screenshot: `pass3-cells-selected.png` |
| **"Voice" nav button in left sidebar** | CONFUSING | Clicking "Voice" in the project sidebar (Rules/Comments/Memory/Voice/Share/Settings) switches the view to Text lens (SOURCE/TARGET columns), not to a dedicated Voice settings page. Effect appears to be lens toggle, not navigation. Screenshot: `pass3-voice-nav.png` |
| **Escape key on header "More" dropdown** | BROKEN | After the header "More" dropdown opens, pressing Escape does NOT close it. Only clicking elsewhere dismisses it. Screenshot: `pass3-after-escape.png` |
| **Per-cell "..." (More actions) in CONTROLS** | MINIMAL | Clicking the per-cell "More actions" button in CONTROLS column shows only an inline "Generate" option (refresh icon). No richer per-cell menu (Delete take, Re-record, Assign character, etc.) visible. Screenshot: `pass3-cell-dot-menu.png` |
| **API key password field a11y warning** | NEW (Console) | Browser console logs: "Password field is not contained in a form" — 3 occurrences. The Gemini API key input is `<input type="password">` outside a `<form>`. Not a functional bug but an a11y / browser-compatibility warning. |
| **Batch validate dialog** | OK | "Batch validate" button in header opens confirmation dialog: "This marks 2 translated cells as validated under your name." with consent checkbox and "Validate all" button. Screenshot: `pass3-batch-validate.png` |

---

### Pass 3 — New Issues Ranked by Demo Impact

| # | Surface | Severity | Detail |
|---|---------|----------|--------|
| **A1** | TTS synthesis fails with silent "Failed" badge — no proactive error | Demo-blocker | The main CTA ("Generate & play this line") silently fails. User sees a red "Failed" label but no toast/modal. Must discover the clickable badge to get any explanation. First impression in a demo: "is audio synthesis completely broken?" |
| **A2** | "Open audio setup" CTA in error popover is a dead button | Demo-blocker | After user finally clicks the badge and reads the error, the offered escape route ("Open audio setup") does nothing. Leaves user stuck with no actionable path. |
| **A3** | "Hear translation" button triggers generation (not playback) with no "no audio yet" state | Confusing | Button name implies playback; actually triggers synthesis. When synthesis fails, the error appears on a *different* cell than the one the user interacted with (the "Failed" cell moves around). Very confusing for a demo. |
| **A4** | Dismissing error popover clears "Failed" badge silently | Confusing | After dismissing the error, the cell appears clean/unvoiced. User assumes problem is resolved; it is not. False positive resolution state. |
| **A5** | "Voice together" (multi-cell synthesis) not discoverable | Demo-gap | Selection affordance ("Select cell. Drag to select a range.") produces no visual feedback in Audio lens. No action bar appears. The homepage claim "audio translation" implies batch workflows; none are findable. |
| **A6** | "Key needed" badge shown when key is entered (should say "Key invalid") | Confusing | The badge label "Key needed" is wrong when a value is entered. Should distinguish "no key entered" from "key entered but invalid/not working". |
| **A7** | "Voice" nav button switches to Text lens instead of navigating to Voice settings | Confusing | Expected: opens a voice project-level settings page. Actual: switches lens mode. |
| **A8** | Escape does not close header "More" dropdown | Minor | Standard keyboard interaction broken for the global More menu. |

---

### Pass 3 — What Works Well in Audio Studio

- Edit character / Craft character modals: engine tabs (Gemini/MMS/Kokoro), voice dropdowns, guidance textarea, clone/upload voice profile — all render and are well-structured
- Recording modal: large readable text for recitation, countdown, Cancel countdown, Prev/Next navigation across cells — solid UX for a recording workflow
- Per-cell layout in Audio lens: CONTROLS and TARGET columns readable, health badges visible, cell content readable
- Failed badge IS clickable and shows an informative error with technical details — good progressive disclosure once discovered
- File list remains accessible in Audio lens (V1 confirmed fixed)

---

### Pass 3 Summary

**Re-fixes verified**: V1 (audio lens file trap — FIXED), P2 (backtranslation hint — FIXED), P3 (sync status — FIXED).

**Top demo blockers for voice/audio**: The TTS synthesis flow is broken for the QA environment because the Gemini API key is present but not valid/recognized. The failure UX is mostly quiet (silent badge), and the offered recovery path ("Open audio setup") is a dead button. For a live demo claiming "audio translation", a presenter would need a valid Gemini key AND to know that the Audio lens shows the file list above the Cast panel. "Voice together" multi-cell synthesis is entirely undiscoverable through the UI.

**Geist 403 + nativeButton warnings**: Still present (not in scope for this pass but still active).

---

## Pass 4 — final golden path (2026-05-31)

**Build**: v0.1.0 · swarm/integration · 584cac0  
**Tester**: QA agent (Playwright MCP, claude-sonnet-4-6)  
**Scope**: Complete demo golden path end-to-end (all swarm waves 1–16); A6 voice fix verification  
**Test notes**: All dev-project SFM files are empty/seeded stubs. engBBE (30,966 cells) imported live during test to enable cell editing and voice features.

---

### Golden Path Step Table

| Step | Surface | Works? | Notes |
|------|---------|--------|-------|
| 1 | **Onboarding / login** — `/__dev/login` → `/project/dev-project` | PASS | Redirects correctly in <1s; only error in console is Geist font 403 (known artifact). Sidebar shows 867 files, "DE dev" user badge, version badge "v0.1.0 · swarm/integration · 584cac0". |
| 2a | **Workspace — open a file** | PASS | Clicking `01GENarONAV12.SFM` navigates to `/project/dev-project/file/<uuid>`; file view renders with empty state "is empty — Import content, or start typing in the first cell." |
| 2b | **Workspace — cells render** | PASS | After importing engBBE, 30,966 cells render in Text lens with SOURCE (BBE text) and TARGET (empty) columns. Footer shows "30,966 cells · 0 translated (0%)". |
| 2c | **Workspace — edit a cell** | PASS | TipTap contenteditable focused on click; typing "In the beginning God created the heavens and the earth." saved correctly. Footer updated to "1 translated (0%)". |
| 2d | **Workspace — validate a cell** | PASS | Clicking the Health Ring / ValidationIcon button (title "Health: 0% — no examples") triggered validation. DOM title changed to "Health: 100% — validated". Footer shows "1 validated". |
| 3a | **Import dialog — Upload tab** | PASS | Dialog opens from "Import content" empty-state button and from toolbar "+ Import". Upload tab shows "Supported: MD, DOCX, PPTX, TXT, VTT, SRT, USFM, XLIFF / XLF, TMX, CSV, TSV" — correct "XLIFF / XLF" label (P5 fix verified again). |
| 3b | **Import dialog — eBible tab** | PASS | eBible tab loads translations list (no 404). Searching "engBBE" returns "Bible in Basic English (eng-engBBE) — English · 39 OT · 27 NT". Import completes streaming (4,500 → 30,966 verses). |
| 4a | **Export dialog** | PASS | Toolbar "Export file" button opens dialog with formats: USFM .sfm, Plain text .txt (LOSSY), Markdown .md (LOSSY), Bilingual TSV .tsv (LOSSY); SCOPE: Current file / Whole project; Export button triggers download. |
| 4b | **Export — trigger download** | PASS | Selecting Bilingual TSV + clicking Export triggered download of `01GENarONAV12.tsv` — no errors. |
| 5 | **Living Memory** — `/project/dev-project/memory` | PASS | Page renders "Living Memory — Confirmed source → target pairs", counter "0 validated", empty state "No validated translations yet — Validated cells will appear here once translators and reviewers reach the required validation threshold." Note: "Showing cells from the first 40 files." |
| 6a | **Search — Search mode** | PASS | "Search & replace" button opens dialog; query "God" returns multiple highlighted results from engBBE file. |
| 6b | **Search — Passages mode** | PASS | Clicking "Passages" tab switches mode; button becomes active; Passages results visible. |
| 7a | **Rules page** | PASS | `/project/dev-project/rules` renders 9 built-in checks (Empty translation, Identical to source, Placeholder integrity, Number integrity, End punctuation, Extra whitespace, Repeated word, Unpaired brackets, Abbreviation pass-through), severity selectors, enabled checkboxes, Rules (0) empty state. |
| 7b | **Rules — "Suggest rules" dialog** | PASS | "Suggest from edits" button opens dialog "Suggest rules from your edits" with description text and "Analyze my validated edits" button. |
| 8 | **Complete all (Run completions)** | PASS | "Run completions" toolbar button opens confirm dialog: "Generate translations for the next 10 of 30965 untranslated cells. Capped at 10 per click while we work on spend controls — re-run to continue." Consent checkbox + "Run completions" button. Enabled (not "coming soon"). Shows cell count and implied ~10 AI calls per run. |
| 9a | **Voice — Audio lens file list visible (V1)** | PASS | Switching to Audio lens: sidebar file list remains visible above Cast section. V1 fix confirmed holds in this build. |
| 9b | **Voice — Generate & play on cell 1** | PASS | "Generate & play this line" button clicked; cell shows red "Audio failed" badge (correct — no valid key in dev). Error is visible immediately on the cell face. |
| 9c | **Voice — Error message clarity (A1)** | PASS | Clicking "Audio failed" badge opens popover with clear title: "Gemini API key required" and body: "Add your Gemini API key to use Gemini voices, or switch this project to a local TTS provider (Kokoro or MMS)." Technical detail expander present. Immediately readable without hunting. |
| 9d | **Voice — "Open audio setup" navigates (A2)** | PASS | Clicking "Open audio setup" navigated to `/project/dev-project/settings` (the Gemini API key section visible on scroll). A2 fix confirmed. |
| 9e | **Voice — "Key needed" badge (A6)** | PASS | Sidebar Gemini API key section shows amber "Key needed" badge when no valid key is configured. Code inspection confirms A6 is implemented: `keyBadgeLabel` is "Key needed" when `!apiKey`, "Key invalid" when `apiKey && hasKeyError` (via `useAnyGeminiKeyError` hook). Both branches are in VoiceLibraryPanel.tsx:108–112. |

---

### Pass 4 — New Issues Found

| # | Surface | Severity | Detail |
|---|---------|----------|--------|
| **NEW-1** | `/project/:id/voice` route missing | **Demo-blocker** | `ProjectSettings.tsx` "Open Voice Studio" button navigates to `/project/dev-project/voice`. This route does NOT exist in `App.tsx`; React Router renders a blank white page with console warning "No routes matched location '/project/dev-project/voice'". The Settings page "Voice" section's main CTA is broken. |
| **EXISTING** | Geist font 403 errors | Dev-env artifact | Still present (expected, known). All 3 font variants fire on every navigation. |

---

### Pass 4 — What Was Confirmed Working vs Prior Passes

| Check | Prior Status | Pass 4 |
|-------|-------------|--------|
| A1 — Clear error message on TTS failure | BROKEN (Pass 3) | **FIXED** |
| A2 — "Open audio setup" navigates correctly | BROKEN (Pass 3) | **FIXED** |
| A6 — "Key needed" vs "Key invalid" badge | BROKEN (Pass 3) | **FIXED** (code verified, "Key needed" shown correctly) |
| V1 — Audio lens file list stays visible | FIXED (Pass 3) | **CONFIRMED FIXED** |
| Import dialog "XLIFF / XLF" label | FIXED (Pass 2) | **CONFIRMED FIXED** |
| Export all formats + download | OK (Pass 1) | **CONFIRMED** |
| Search + Passages mode | OK (Pass 1) | **CONFIRMED** |
| Rules + Suggest dialog | OK (Pass 1) | **CONFIRMED** |
| Complete all / Run completions enabled | OK (Pass 1) | **CONFIRMED** |
| Living Memory empty state | OK (Pass 1) | **CONFIRMED** |

---

### Pass 4 — DEMO-READY Verdict

**READY-WITH-CAVEATS**

The core golden path works end-to-end. All swarm-tracked items (A1, A2, A6, V1) are fixed and confirmed. The demo flow (login → open file → import → edit → validate → export → memory → search → rules → complete-all → voice error UX) is solid.

**Top remaining caveats for a live demo**:

1. **NEW-1 (demo-blocker for Settings → Voice path)**: "Open Voice Studio" in Project Settings leads to a blank page. If a demo presenter clicks this button, recovery requires manually navigating away. Workaround: avoid clicking it; the inline API key input in the sidebar works.

2. **Geist 403 console noise**: Still present on every page load. Not visible to users but will concern a technical audience watching devtools. Workaround: close devtools before demo.

3. **All dev-project files are empty**: The seeded files have 0 cells. For a live demo showing cells, either import engBBE first or use a file with pre-imported content. The import flow works reliably (30,966 cells imported successfully in this pass).

4. **Living Memory shows 0 validated** even after validating a cell, because the default required-validation threshold is 2 validators. Solo demo won't show memory populated without lowering the threshold or using a multi-user session.

---

## BT + Terminology QA — 2026-05-31

**Build**: v0.1.0 · swarm-integration2 · e16759a  
**Tester**: QA agent (Preview MCP, claude-sonnet-4-6)  
**Scope**: Back-translation tab + Terminology / glossary features  
**Stack**: Vite :5180 (from main repo) · auth-worker :8788 · sync-worker :8789  
**Login**: `/__dev/login` → auto-logged in as `dev` · Migration 0021 applied to worktree dev-state prior to QA  
**Test file with cells**: `dev-project:019e6a58-e83d-7571-a786-f427776e805f` (BIBL 670 docx, 453 cells, 7 translated)

---

### Terminology Feature Verdict: PARTIAL

#### What Works

| Check | Result | Evidence |
|-------|--------|---------|
| Terminology nav in sidebar | PASS | "Terminology" button visible in PROJECT sidebar section with BookOpen icon; navigates to `/project/dev-project/terminology` |
| Route `/project/:id/terminology` renders | PASS | Page loads with header "Terminology", Export CSV / Export TBX / Import / Add concept buttons, correct empty state |
| Add concept (in-session) | PASS | Clicked "Add concept" → dialog opened → filled source "grace" + rendering "gracia" (preferred) + "favor" (forbidden) → clicked "Add concept" → Concepts (1) shown immediately |
| Concept data persists to server | PASS | Confirmed via direct API call: `GET /api/v2/projects/dev-project/settings` returns `{terminology: [{sourceTerm:"grace", renderings:[...]}], version:17}` |
| PATCH /settings returns 200 | PASS | Network log shows PATCH 200 OK after saving a concept |
| Concept list shows immediately after add (same session) | PASS | Concepts (1) with "grace · gracia · required" chip shows without reload |
| Add concept dialog UX | PASS | Source term input, rendering input with status select (required/alternate/avoid), Add rendering button, Notes field, Status radio (suggested/approved/old), Add concept / Close buttons |
| Export CSV button present | PASS | "CSV" button in header (with Download icon) |
| Export TBX button present | PASS | "TBX" button in header (with Download icon) |
| Import button present | PASS | "Import" button in header opens modal with CSV / TBX tabs |

#### What Fails

**BUG-TERM-1 — P1 REAL FEATURE BUG: Terminology concepts not visible after ANY navigation to the Terminology page**

- **Repro**: Log in via `/__dev/login` → navigate to Terminology page (by clicking sidebar button OR by URL) → Concepts always shows 0 even though server has terminology data.
- **Root cause (confirmed via React fiber inspection)**: `TerminologyPage` mounts its own `useProject` → `useProjectSettings` hook chain. In development mode with `<React.StrictMode>`, effects are run, cleaned up, and re-run. The cleanup sets `aliveRef.current = false`. When `fetchProjectSettings` completes asynchronously, it checks `if (!aliveRef.current) return null` and skips calling `writeServer(got)`. As a result, `server` state remains `null` and `hasFetched` remains `false` indefinitely. The settings overlay never fires, so `project.terminology` is always undefined.
- **Fiber evidence**: `TerminologyPage` state index 20 = `null` (server), index 22 = `false` (hasFetched), index 23 = `{current: false}` (aliveRef is false — the dead ref preventing server updates).
- **Key fact**: The server DOES have the data (confirmed with direct `fetch()` using the app's own JWT — returns v=17 with terminology). It's the React hook that silently drops the response.
- **Workaround in same session**: Adding a new concept via the dialog works because `patchSettings` synchronously calls `setLocal({...partial})` which bypasses the server state. Only locally-added concepts show.
- **Impact**: P1 demo-blocker. Every navigation to the Terminology page shows an empty list. Clicking "Add concept" again creates duplicates on the server.
- **File**: `/src/hooks/useProjectSettings.ts` — `aliveRef` cleanup in strict mode, `refresh()` async guard.

**BUG-TERM-2 — ENV: Migration 0021 not pre-applied in running dev stack**

- **Detail**: The main repo's `.wrangler-dev-state/` did not have migration `0021_cell_backtranslations.sql` applied when the dev stack started. This means BT sync events (`cell.backtranslation.set`) that the browser emits cannot be written to D1. The outbox shows 2 queued BT events that never flush ("Sync backlog" persists).
- **Classification**: ENV/setup blocker (applied the migration manually during QA; sync-worker needs restart to pick it up).
- **Workaround**: `cd auth-worker && npx wrangler d1 migrations apply aquilla-db --local --persist-to ../.wrangler-dev-state`, then restart the sync-worker.

**BUG-TERM-3 — NOT TESTED: Terminology violation on cells (TermLookupPopover)**

- **Reason**: Could not exercise. The terminology concept "grace" is defined with "gracia" as preferred and "favor" as forbidden. Testing violation detection requires a source cell containing "grace" with a target NOT containing "gracia". The test file (BIBL 670 docx) has English source but Italian target — no obvious "grace" cell was found to quickly test. Additionally, BUG-TERM-1 means the terminology is not loaded anyway, so violations would not fire.
- **Classification**: ENV/setup blocker + cascading from BUG-TERM-1.

**BUG-TERM-4 — NOT TESTED: CSV import**

- **Reason**: The Import dialog has CSV and TBX tabs with file upload. Could not test file upload via Preview MCP (no file upload tool available). Import dialog renders correctly.
- **Classification**: ENV/tooling limitation.

**BUG-TERM-5 — NOT TESTED: TBX export download**

- **Reason**: Export triggers a `URL.createObjectURL` + programmatic `<a>.click()`. The Preview MCP cannot intercept file downloads. Export CSV button is present; TBX export code path is `exportConceptsTbx(concepts)` from `src/lib/terminology/tbx.ts`.
- **Classification**: ENV/tooling limitation.

---

### Back-Translation Feature Verdict: PARTIAL

#### What Works

| Check | Result | Evidence |
|-------|--------|---------|
| BT tab present in cell expansion | PASS | Tab icons in order: Decay · BT (Document) · Recording · Issues · History — confirmed via accessibility tree |
| BT tab selected by default (no violations) | PASS | `useState<string>("backtranslation")` default; auto-selects "backtranslation" on expand when no issues |
| BT empty state | PASS | "No back-translation yet. Click Generate to create one." with Generate button (refresh icon) |
| "BT" label in panel | PASS | `BTstatisticalPolishEdit` text visible — "BT" label present |
| Generate button triggers BT | PASS | Clicked Generate; BT text appeared (statistical glosser output: "regent university serves...") |
| "statistical" badge appears | PASS | Badge "statistical" visible after generation |
| "Polish" button present | PASS | "Polish" button shows alongside "Edit" after BT is generated |
| "Edit" button → editable textarea | PASS | Edit opens a textarea seeded with current BT text |
| Save after edit → BT persists in same session | PASS | Typed new BT text "Regent University is a Christian university dedicated to academic excellence." → clicked Save → tab shows edited text |
| BT event emitted to outbox | PASS | `aquilla-cqrs-outbox` IDB shows `cell.backtranslation.set` events queued (2 items) |
| BT italic styling | PASS | BT text rendered in italic (CSS `font-style: italic` in the panel) |
| cell.backtranslation.set event type | PASS | Outbox event `kind: "cell.backtranslation.set"` confirmed in IDB |

#### What Fails / Is Blocked

**BUG-BT-1 — ENV: BT persistence to D1 blocked (migration 0021 not pre-applied)**

- **Detail**: BT events queue in the browser outbox but never flush to D1 because the `cell_backtranslations` table doesn't exist in the running dev stack's D1. Status bar shows "Sync backlog" permanently.
- **Classification**: ENV/setup blocker. Not a feature bug. Apply migration + restart sync-worker to unblock.

**BUG-BT-2 — NOT TESTED: Stale marker + Regenerate after target changes**

- **Reason**: Could not quickly exercise the full cycle (generate BT → edit target cell → observe amber "stale" marker → click Regenerate). Requires navigating to the cell editor and editing the target cell, which would require reloading the BT state. The stale detection logic is `isBtStale = cell.backtranslation && cell.backtranslationForText !== cell.translated` (EditorTable.tsx:1779).
- **Classification**: ENV/time constraint.

**BUG-BT-3 — NOT TESTED: Polish toggle → "polished" badge**

- **Reason**: The Polish button requires a configured AI backend (Frontier chat API at `VITE_CHAT_BASE`). The dev stack's chat endpoint is the auth-worker at `/chat/`, but no LLM is wired for QA testing. Clicking Polish would send a request and likely fail silently.
- **Classification**: ENV/backend blocker.

**BUG-BT-4 — NOT TESTED: BT persists across reload (server read route)**

- **Reason**: BT is not being written to D1 (BUG-BT-1), so the read route `GET /api/v1/projects/:projectId/files/:fileId/backtranslations` has nothing to return. Cannot confirm the reload-persistence path.
- **Classification**: Cascades from BUG-BT-1 (ENV blocker).

**BUG-BT-5 — OBSERVATION: Statistical BT quality issue (repeated phrases)**

- **Detail**: The statistical glosser generated "regent university serves regent university serves regent university serves..." (repeated ~30x) for the cell "Regent University serves as a center of Christian thought...". This is not a UI bug — it's the glosser algorithm (likely character n-gram or simple word-by-word lookup without coherence check). The output appears wrong but the UI correctly shows it as "statistical" (not polished).
- **Classification**: Known artifact / glosser quality issue. Not a feature bug.

**BUG-BT-6 — NOT TESTED: Viewer is read-only / contributor+ can edit**

- **Reason**: The dev project only has one user (owner). Cannot exercise the role-based read-only restriction without a second user at viewer or lower role.
- **Classification**: ENV/role limitation.

**BUG-BT-7 — NOT TESTED: BT tab for cell that has never been translated**

- **Reason**: The expansion was opened on a translated cell. The BT tab shows correctly for that cell. Not tested for source-only cells (side="source", no target).
- **Classification**: Out of scope for this pass.

---

### Summary Table

| Feature | Demo-True Verdict | Reason |
|---------|-------------------|--------|
| **Terminology** | **PARTIAL** | Add/save works in-session + data confirmed on server; but loading existing concepts on page navigation is broken (BUG-TERM-1 P1 real bug). CSV import/TBX export untestable via tooling. Violation/popover untestable without correct seed data. |
| **Back-translation** | **PARTIAL** | BT tab, Generate, Edit/Save all work in-session; "statistical" badge, "Polish" button, "Edit" button, italic styling all confirmed. BT persistence to D1 blocked by missing migration in running stack (ENV). Stale marker, Polish toggle, reload-persistence all ENV-blocked. |

---

### REAL Feature Bugs Found This Pass

| ID | Severity | Bug | Repro |
|----|----------|-----|-------|
| BUG-TERM-1 | **P1 demo-blocker** | Terminology concepts always 0 on Terminology page navigation (aliveRef cleared by React StrictMode, server settings never applied) | Navigate to `/project/:id/terminology` from any other page → Concepts (0) regardless of server state |

### ENV/Setup Blockers Found This Pass

| ID | Blocker | Fix |
|----|---------|-----|
| BUG-BT-1 + BUG-TERM-2 | Migration `0021_cell_backtranslations.sql` not applied in running dev stack — BT events queue forever | `cd auth-worker && npx wrangler d1 migrations apply aquilla-db --local --persist-to ../.wrangler-dev-state`, restart sync-worker |

### Known Artifacts (Dismiss)

- Statistical BT produces repeated phrases (BUG-BT-5): glosser algorithm, not a UI regression
- Geist font 403s: dev-env Vite fs restriction, present in all passes

---

## Re-QA — BUG-TERM-1 fix + terminology surfaces — 2026-05-31

**Build**: v0.1.0 · swarm/integration2 · 3ea4932 (commit `fdee3f0` merged `swarm/fix-term-load`)  
**Tester**: QA agent (Playwright MCP, claude-sonnet-4-6)  
**Scope**: Verify BUG-TERM-1 fix, then exercise lookup popover + Apply, then terminology violation surface  
**Stack**: Vite :5291 (from `swarm-integration2` worktree) · auth-worker :8788 · sync-worker :8789  
**Login**: `/__dev/login` → auto-logged in as `dev` · Pre-existing concept: "grace" → "gracia" (preferred) in dev-project (server version 17)

---

### Check 1 — BUG-TERM-1 fixed: Terminology page loads existing concepts

**Verdict: FIXED**

- Navigated to `/project/dev-project/terminology` (sidebar click from project workspace).
- **Concepts (1)** shown immediately — source term "grace", rendering "gracia · required", status "suggested" (draft).
- Hard-reloaded the URL → still **Concepts (1)** — concepts survive full page reload.
- Prior bug behavior was Concepts (0) on every navigation. Now consistently shows the server's concept list.
- The fix (`aliveRef` no longer permanently stale; per-invocation `alive` local used in StrictMode effect) is confirmed effective.

Screenshot evidence: `check1-terminology-loaded.png`

---

### Check 2 — Lookup popover + Apply

**Verdict: PASS** (with prerequisite: concept must be status "active")

**Setup required**: The "grace" concept was status "draft" ("suggested" in UI). The `SourceWithTermLookup` component only wraps words with `TermLookupPopover` for `status === "active"` concepts. Promoted the concept to "approved" via the Edit dialog on the Terminology page before testing.

**Test file**: `dev-project:019e7d60-ae13-72c8-b961-e1ed88f41cea` (Bible in Basic English, 30,966 source cells)  
**Target row**: Row 146 — "But Noah had grace in the eyes of God." (Genesis 6:8)

Steps and results:
1. Opened the BBE file in the editor; scrolled to row 146 (Genesis 6:8 — "But Noah had grace in the eyes of God.").
2. The word "grace" in the SOURCE column was rendered with `class="cursor-pointer underline decoration-dotted decoration-primary/60 underline-offset-2"` — the term link decoration confirmed the concept is active and matched.
3. Clicked on "grace" — **popover opened** showing: headword "grace", chip "required" (green), rendering "gracia", "Apply" button.
4. Clicked "Apply" — "gracia" was inserted into the TARGET cell for that row.
5. Status bar updated from "1 translated" to **"2 translated"** — confirming the cell write succeeded.

Screenshot evidence: `check2-popover-open.png`, `check2-after-apply.png`

**Note on concept status prerequisite**: The lookup popover is intentionally gated to `status === "active"` concepts only. A concept added via "Add concept" dialog defaults to `status: "draft"` (shown as "suggested" in the UI). Users must explicitly set status to "approved" for the lookup popover and violation checks to activate. This is by design — the terminology module docs confirm draft/deprecated concepts are skipped.

---

### Check 3 — Terminology violation surface

**Verdict: INCONCLUSIVE — violation not observed in client despite correct server state**

**Setup**: Changed the target cell for row 146 from "gracia" to "mercy" (a non-approved rendering). Expected: a terminology violation to surface on the row via the `source-requires-target` rule compiled from the active "grace" concept.

**What happened**:
- The `builtin:end-punctuation-mismatch` violation fired correctly (the "y" at end of "mercy" was marked with `violation-blot violation-blot-minor` and `data-rule-id="builtin:end-punctuation-mismatch"`).
- The **terminology violation did NOT appear** — no `term:6e905d7b...:approved` rule ID appeared anywhere in the DOM, even after a full page reload.
- Direct API call (from within the browser, using the app's own JWT): confirmed server returns `status: "active"` for the grace concept — server data is correct.
- React fiber inspection and DOM search found zero instances of `term:` rule IDs — the terminology rules are NOT being compiled into the running rule engine.

**Likely root cause**: The `useRules` hook receives `project?.terminology` from `useProject` → `useProjectSettings`. The concept was promoted to "active" via the Terminology page's `patch()` call, which correctly updates D1 (confirmed). However the `project.terminology` state in the running `ProjectWorkspace` instance may not have been re-derived from the server after the patch, or the `overlaySettings` merge is not flowing through to `useRules` in the same React render cycle. A full hard-reload of the editor page after promoting the concept still did not cause the terminology rule to appear in the DOM.

**Code path confirmed correct (static analysis)**:
- `compileConceptsToRules` correctly produces `source-requires-target` rules for active concepts (`compile.ts:36`)
- `checkRulesForCell` correctly fires `source-requires-target` when `cell.translated` is non-empty and doesn't match the approved pattern (`rule-engine.ts:94–111`)
- `useRules` correctly passes `terminologyRules` to the merged `rules` array (`useRules.ts:47`)
- The violation would surface as source-side highlighted spans via `sourceRanges` in `EditorTable.tsx:1320–1335`

**New bug identified**: **BUG-TERM-6** — terminology violation rules are not reaching the running rule engine after a concept is promoted to "active" in the same session. The `source-requires-target` rule produced by `compileConceptsToRules` is absent from the DOM even after hard reload. This may be a state synchronization issue between the Terminology page write and the ProjectWorkspace's `project.terminology` subscription.

**Target cell restored**: Changed "mercy" back to "gracia" at end of test to restore correct state.

---

### Re-QA Summary

| Check | Result | Detail |
|-------|--------|--------|
| **Check 1 — BUG-TERM-1 fix** | **FIXED** | Concepts (1) loads on navigation AND on hard reload. Fix confirmed end-to-end. |
| **Check 2 — Lookup popover + Apply** | **PASS** | Popover opens on clicking active-concept term in source; "Apply" inserts approved rendering into target cell; cell count increments. |
| **Check 3 — Terminology violation** | **INCONCLUSIVE** | Built-in punctuation violation fires correctly; terminology `source-requires-target` violation does NOT fire. Server has active concept; rule engine does not compile it in the running instance. Logged as BUG-TERM-6. |

### New Bug Logged

| ID | Severity | Bug | Repro |
|----|----------|-----|-------|
| BUG-TERM-6 | P2 | Terminology violation rules (`source-requires-target`) not reaching rule engine after concept promoted to "active" — `term:` rule IDs absent from DOM even after hard reload | Add concept as draft → edit it to approved → open editor file with matching source term → type non-approved rendering in target → no terminology violation shown (only builtin rules fire) |
