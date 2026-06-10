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

---

## Re-QA 2 — terminology violation fresh-load render — 2026-05-31

**Build**: v0.1.0 · swarm/integration2 · bd016e8  
**Tester**: QA agent (Playwright MCP, claude-sonnet-4-6)  
**Scope**: Settle BUG-TERM-6 — does a terminology violation RENDER on a genuine fresh page load (not in-session draft→active promotion)?  
**Stack**: Vite :5292 (from `swarm-integration2` worktree, newly started) · auth-worker :8788 · sync-worker :8789  
**Test setup**:
- Server state at test start: concept `grace → gracia` (preferred), `status: "active"`, version 19 in D1 (confirmed via `GET /api/v2/projects/dev-project/settings` returning `status:"active"`)
- Target cell for row 146 ("But Noah had grace in the eyes of God.") was set to `"mercy"` — confirmed in D1 via event log (`target.cell.commit` value="mercy" at ts 1780283077868), confirmed via direct SQLite query before the fresh-load test
- Hard reload performed on `/project/dev-project/file/019e7d60-ae13-72c8-b961-e1ed88f41cea` (Vite :5292 fresh process, new IDB session)
- Source "grace" is decorated with dotted-underline term link — confirming `project.terminology` IS populated on fresh load (the `SourceWithTermLookup` component receives active concepts)

---

### Verdict: RENDERS

The terminology violation IS rendered on a fresh page load.

**Where it appears**: The violation is listed in the Issues tab of the cell's details panel (expanded via "Open cell details" → Issues tab). It does NOT produce a DOM `data-rule-id` blot span (which is expected — the `source-requires-target` rule type fires when the target is missing the approved rendering, producing no inline character span since there is no specific character to highlight).

**Evidence**:

| Check | Result | Detail |
|-------|--------|--------|
| Fresh Vite server at :5292 | CONFIRMED | New process, clean IDB session — not a cached in-session state |
| Server terminology loaded | CONFIRMED | `GET /api/v2/projects/dev-project/settings` returns `status:"active"`, `sourceTerm:"grace"`, `rendering:"gracia"` at version 19 |
| `project.terminology` in React state | CONFIRMED | "grace" in source column is decorated with `cursor-pointer underline decoration-dotted decoration-primary/60` — confirming `SourceWithTermLookup` has active concepts |
| Control violation (builtin) fires | CONFIRMED | `builtin:end-punctuation-mismatch` blot appears on "y" in "mercy" (no period at end, source ends with period) |
| **Terminology violation fires** | **CONFIRMED** | Issues tab shows `Term: grace — "Term: grace": source matches pattern but target does not` |
| Terminology violation DOM blot | NOT PRESENT (expected) | No `data-rule-id` blot for `term:6e905d7b...:approved` — `source-requires-target` rule fires without a character-level span because the issue is absence of a rendering, not a specific substring to highlight |

**Screenshot**: `reqa2-issues-tab-full.png` — row 146 "But Noah had grace in the eyes of God." / target "mercy" with Issues tab showing both the end-punctuation and the Term: grace violations

**Prior Re-QA (BUG-TERM-6) was testing an in-session draft→active promotion**: The previous inconclusive result was because the concept was promoted to "active" in the same browser session and the violation was checked immediately after. The prior QA noted "term: rule IDs absent from DOM even after hard reload" — however that reload was from the same Vite process and same IDB session where the promotion happened. This re-QA used a brand-new Vite server process (port 5292, new IDB) with the concept already active on the server.

**Conclusion**: BUG-TERM-6 is resolved or was a false negative. The terminology violation renders correctly on a genuine fresh load when the concept has `status:"active"` on the server before the session begins. The prior inconclusive result likely reflects a timing issue in the same-session flow (concept promoted to active, then immediately checking the editor before `useProjectSettings` had time to propagate the updated terminology to `useRules`), not a rendering gap in the fresh-load path.

**Remaining nuance (not a bug)**: The violation appears ONLY in the Issues tab (cell details panel), NOT as an inline blot on the cell face. There is no row-level infraction count badge visible on the unexpanded row. A user would only discover the terminology violation by opening cell details and switching to the Issues tab. This is by design (the `source-requires-target` check has no character span to render), but it means the violation is not proactively surfaced to translators scanning rows without expanding them.

---

## PD4 Re-QA (2026-06-09)

**Build**: v0.1.0 · swarm/pd4-integration · 61224e7
**Tested**: 2026-06-09
**Environment**: http://127.0.0.1:5173/ (worktree Vite) · auth :8788 · sync :8789
**Login**: `/__dev/login` → auto-logged in as `dev` (OWNER of Dev Org + dev-project)
**Viewport**: 1280×800 (desktop), 480×800 (narrow), 1280×600 (short) for scroll checks
**Tool**: Claude Preview tools navigated to worktree Vite on port 5173

### Summary

| Issue | Status | Evidence |
|-------|--------|----------|
| FRO-231 | **PASS** | Controls row has `flex flex-wrap items-center gap-3 pl-4 pr-10`; Target pill right=869, Close button left=940 (gap=71px, no overlap). At 480px width, pills wrap to second row. Clicking "Target" activates it (aria-pressed=true) without closing dialog. |
| FRO-258 | **PASS** | DialogContent class contains `flex max-h-[85vh] flex-col overflow-hidden`; member list `ul` has `max-h-[50vh] overflow-y-auto`; list items have `min-w-0 truncate`. No horizontal scrollbar at 1280×600. |
| FRO-180 | **PASS** | `/project/dev-project/members` renders inside editor shell (sidebar+topbar persist). Grant-source badges visible (`org:owner, creator:owner` for dev; `via org` for alice). Added bob → appeared with contributor role. Revoke-all dialog showed grant paths, confirm button disabled until "bob" typed, then enabled → success toast "Direct grant for bob has been removed." Invite link tab created `/join/<token>` URL. "Back to project" returned to editor without full remount. NOTE: native-select role change (contributor→reviewer) not visually confirmed — native select change event doesn't trigger React state; role change via API not directly tested in this run. |
| FRO-255 | **PARTIAL** | As OWNER (900): all settings fields are editable (disabled=false, readOnly=false). Source confirmed: `EDIT_ROLE_FLOOR = ROLE.MAINTAINER (600)`, tooltip text "Maintainer or higher can edit shared settings." at `src/components/ProjectSettings.tsx:166`. Sub-600 live check skipped — impractical to log in as bob via preview tools after reset; covered by 20 unit tests in `src/hooks/useProjectSettings.test.ts`. |
| FRO-233 | **PARTIAL** | DOCX import succeeded (bold and italic cells rendered with correct formatting in editor). Export dialog correctly offers "Word (.docx)" for docx-sourced files. Export round-trip returned "Failed to fetch" — sync-worker unreachable from preview iframe context (cross-origin fetch blocked; confirmed by direct fetch test). This is a tooling limitation, not a code bug. Source fix confirmed: `dominantRpr.cloneNode(true)` at `src/lib/export/exporters/docx.ts:231`. 13 unit tests in `src/lib/export/exporters/docx.test.ts` cover bold/italic/sz/no-rPr cases. |
| FRO-173 | **PARTIAL** | Browser tooling (Claude Preview) does not support fake media streams. Audio recording → cell_audio code path verified by 7/7 unit tests in `sync-worker/src/__tests__/cell-audio.test.ts` (attach/select/remove/API) + 5/5 in `src/lib/migrate/audio.test.ts`. Live test steps documented in `docs/swarm/AUDIO-GAP-FRO173.md`. |

### New bugs found

None.

### Notes

- The Claude Preview tool's browser context runs in a Claude app iframe; direct fetch to `localhost:8789` (sync-worker) is blocked cross-origin. This blocked the FRO-233 export round-trip and the FRO-173 recording test.
- Backend was reset via `POST /__test__/reset` mid-session (alice/bob/carol seeded). Dev session JWT refreshed via `/__dev__/login` after reset.
- The worktree Vite (port 5173, process owned by `scripts/dev-stack.ts`) was the actual server under test; the preview tool's managed server (port 5180, from main repo root) was navigated away from to 127.0.0.1:5173.

---

## PD5 wave-1 QA (2026-06-09)

**Build**: v0.1.0 · swarm/pd5-integration · 26f4a04
**Tested**: 2026-06-10 (UTC)
**Branch under test**: `swarm/pd5-integration` (worktree at `.worktrees/pd5-integration`)
**Environment**: http://127.0.0.1:5173/ · auth :8788 · sync :8789 (Docker PG :5432)
**Login**: `/__dev/login` → auto-logged in as `dev` (OWNER of Dev Org + dev-project)
**Tool**: Playwright MCP (`mcp__plugin_playwright_playwright__*`)

### Migration status

Postgres migrations 0031 and 0032 were NOT applied by the dev-stack's `applyPgSchemaIfMissing` (which is idempotent: only applies the full schema if the `users` table is absent; the container was already running with an older schema). Applied manually via `docker exec aquilla-dev-pg psql`:

- `0031_project_snapshots.sql` — dropped old file-scoped `snapshots` table and created project-scoped `snapshots` (without `file_id`). Old table had `file_id` column; migration needed for FRO-176 snapshot API to work.
- `0032_cell_word_morph.sql` — created `cell_word_morph` table + indexes. Idempotent (IF NOT EXISTS).

Both migrations applied successfully before stack boot.

**Note**: the dev-stack's auto-migration path (`applyPgSchemaIfMissing`) only runs schema.sql when the DB is empty. Any incremental migrations added to `db/postgres/migrations/` must be applied manually to an existing container, or the container must be recreated. This is a developer-experience gap, not a wave-1 code bug — but worth tracking.

### Results

| Check | Status | Evidence |
|-------|--------|----------|
| FRO-215 routing + copy | **PASS** | Logged OUT: `GET /` → redirected to `/homepage` (client-side RootRedirect fired). Logged IN: `GET /` → landed in app shell showing org Overview page, NOT bounced to homepage. Homepage multimodal section shows "Images" and "Oral stories" chips with `generic "Coming soon"` class and "soon" badge rendered dimmed. |
| FRO-175 chat | **BLOCKED-env** | MessageSquare "Open AI chat" toolbar button opens a drawer dialog. Textbox accepts input; `⌘↵` dispatches the send. Panel rendered the error inline: `"Completion failed: 500 {"error":"OPENROUTER_API_KEY is not configured"}"`. Chat endpoint `/chat/api/v1/chat/completions` returned HTTP 500 from auth-worker (no LLM key in dev `.dev.vars`). Panel shows the error as the configured affordance — no crash, no blank screen. BLOCKED-env, not FAIL. Stop/Clear buttons were not rendered (no active stream to stop). |
| FRO-176 snapshots | **PASS** | Sidebar "Snapshots" button → URL changed to `/project/dev-project/snapshots`, sidebar and top bar stayed intact. Create snapshot dialog opened, name field required (Create button disabled until filled). Created "QA Test Snapshot" → appeared in list with date + "by dev". Restore → typed-confirmation dialog required exact name "QA Test Snapshot", Restore button disabled until typed, then enabled → clicked → banner "Restored 1 cells." appeared. Delete → native `confirm()` dialog → accepted → snapshot removed, empty-state returned. Deep-link `/project/dev-project/snapshots` directly → shell intact (sidebar/topbar present), no bounce. |
| FRO-177 replace | **PASS** | Search & Replace panel opened via toolbar button (after closing lingering chat overlay). "Replace" mode button in search-mode group available and clicked. Find field accepted "testo" → panel showed "2 cells affected" with per-cell inline diff (before/after with strikethrough) and checked checkboxes. "Select all"/"Select none" buttons present. "Retain my validations" toggle present with `(?)` tooltip. Scope toggle shows "Project"/"test_fro233.docx" buttons. Replacement text set to "parola" → "Replace 2" clicked → cells updated in place to "Questo è parola in grassetto 90" and "Questo è parola italico per la fonte". No blank-row regression (FRO-247). |
| FRO-178 Macula | **PASS** | Import dialog opened via More actions → Import. Macula Hebrew + Greek card enabled (not "Coming soon"). Clicked card → Macula sub-step with file chooser. Uploaded 6-row TSV fixture (header: `ref\ttext\tlemma\tmorph\tstrongnumber`, GEN 1:1–1:3). Import button clicked → file "GEN" created with 3 cells; editor opened showing Hebrew source text (בְּרֵאשִׁ֖ית בָּרָ֣א אֱלֹהִ֑ים etc.) in the source column. Sidebar showed "3 cells · 0 translated". Morph data has no UI surface (as noted in spec — known trace, not FAIL). |
| FRO-181 health | **PASS** | StatusBar (footer) shows a health ring element (18×18px `div`). Before validation: value "0", no SVG circle (no data points). After validating 1 of 2 cells: SVG `<circle>` rendered with `stroke-dasharray=50.27` (full circumference, r=8) and `stroke-dashoffset=25.13` (50% filled), value "50", color `#f59e0b` (amber). Project Settings → Decay section → "Max hops" spinbutton (value 4) present. "Endorsement target" label is absent. "Attention threshold" spinbutton also present. Health update on validation confirmed (0 → 50 after 1/2 cells validated). |
| BT adjudication | **RESOLVED — not a stub** | FRO-215 audit claimed `runBacktranslation` is a stub. VERDICT: **incorrect**. `runBacktranslation` in `ProjectWorkspace.tsx:1285` runs a two-step pipeline: (1) `glosser.gloss(cell.translated)` — deterministic statistical BT — always fires; (2) `generateBacktranslation(...)` — LLM polish — fires only if `isBacktranslationConfigured`. BT tab for a translated cell showed "statistical" badge with actual text "this is bold this is bold" (correct reverse gloss of "Questo è parola in grassetto 90" through the Markov glosser). A "Polish" toggle button is present in the BT tab; LLM-polished mode is available when an LLM key is configured. The feature is **live, not stubbed**. Auto-BT on every commit runs `buildStatisticalBt` directly (in `handleCellCommitted`, not via `runBacktranslation`). |

### New bugs found

None. All wave-1 features are present and functional at the tested build (26f4a04).

### Notes

- The dev-stack script (`scripts/dev-stack.ts`) does not auto-apply incremental Postgres migrations (`db/postgres/migrations/*.sql`) to an existing container. Only the initial `schema.sql` is idempotent. Migrations 0031 and 0032 were applied manually before the QA run.
- The AI Chat check (FRO-175) is BLOCKED-env because `OPENROUTER_API_KEY` is not set in `auth-worker/.dev.vars`. The panel behavior with an unconfigured LLM is correct (inline error, no crash).
- The BT tab is inside the inline EditorRow expansion (click "Open cell details"), not in a separate drawer. Tabs visible: Decay | BT | Recording | Issues | History.
- Ports 5173/8788/8789 confirmed free after QA run.

---

## PD5 wave-2 QA (2026-06-09)

**Build**: v0.1.0 · swarm/pd5-integration · 17233de
**Tested**: 2026-06-10 (UTC)
**Branch under test**: `swarm/pd5-integration` (worktree at `.worktrees/pd5-integration`)
**Environment**: http://127.0.0.1:5173/ · auth :8788 · sync :8789
**Login**: `/__dev/login` → auto-logged in as `dev` (OWNER of Dev Org + dev-project)
**Tool**: Playwright MCP (`mcp__plugin_playwright_playwright__*`)

---

### Results

| Check | Ticket | Status | Evidence |
|-------|--------|--------|----------|
| TN import + sidebar | FRO-179 | **BLOCKED-env** | TSV file upload works (tn-fixture.tsv imported, "tn-fixture.tsv" visible in file list). Sidebar "Translation Notes" panel renders correctly with empty state "Focus a translation cell to see notes for that verse." when no cell is focused. TN sidebar fetch calls `fetchProjectFiles` + `fetchFileCells` on the sync-worker (port 8789) using the dev session JWT. Sync-worker rejects dev auth-worker JWTs with `401 invalid token signature` (two different workers, different JWT secrets). No TN rows can be fetched. Consequence: TN notes never display even after focusing GEN 1:1. |
| Harmonize sweep | FRO-186 | **FAIL** | Rules page (`/project/dev-project/rules`) loads. Built-in checks listed. Harmonize sweep button is NOT rendered at all for any check. Root cause confirmed in source: `BuiltinChecksList.tsx` `showHarmonize = onHarmonize != null && count > 0`. The `count` is always 0 because `infractions={new Map()}` is hardcoded in `RulesPage.tsx` with a `// TODO: wire real infractions when worker dispatch lands` comment. With an empty infractions map, `count === 0` for every check → `showHarmonize = false` → button never renders. The harmonize settings (min role selector at `ProjectSettings.tsx:1008`) do render correctly in Settings. |
| Health ring on project card | FRO-190 | **BLOCKED-env** | `ProjectCard` conditionally renders `<HealthRing>` when `projectHealth !== null`. `useProjectHealth` calls `useHealthRollup` → `fetchHealthRollup` → `GET http://127.0.0.1:8789/api/v1/projects/dev-project/health-rollup`. Sync-worker returns `401 invalid token signature` (same JWT mismatch as FRO-179). `projectHealth` stays `null` → ring never renders. The component code + ring SVG are correct; only the cross-worker auth blocks the fetch in dev. |
| Living Memory page | FRO-223 | **PASS** | Memory nav button navigates to `/project/dev-project/memory`. Page renders Brain icon, heading "Living Memory", purpose description "Confirmed source → target pairs … shared with the AI as context". Empty states show coaching examples ("Show me recently validated cells", "What are the most consistent translations for 'grace'?"). "Open Terminology" cross-link navigates to `/project/dev-project/terminology`. OWNER "dev" sees "+ Add" button controls (not hidden). Screenshot: `pd5-qa-fro223-memory-page.png`. |
| Selection → concept | FRO-260 | **PARTIAL / BUG** | **Create-draft path**: Dialog "Add to term base" can be opened via direct React-fiber onClick (programmatic workaround). Typed "bold text" → clicked "Create draft concept" → dialog closed. Navigated to Terminology page → "bold text" concept appears in Concepts (3) list with status "suggested" (draft). **BUG confirmed**: Normal Playwright click on "Add to termbase" button does NOT open the dialog. Root cause: clicking the button collapses the text selection; the `selectionchange` event fires → `setSourceSelection(null)` → `handleAddSelectionToTermbase` returns early before `setShowAddConceptDialog(true)`. Dialog opens empty when opened via fiber. **View-term lookup**: Source cells in test_fro233.docx ("This is bold text for source", "This is italic text for source") and GEN (Hebrew only) contain no text matching active concepts ("grace", "Anutu"). View-term lookup path could not be tested — requires source cells containing active concept terms. |
| Queue + merge | FRO-261 | **PASS** | Review queue listed "Anutu" in pending state. Approved Anutu from queue → persisted across reload. Selected Anutu + Dio for merge via "Merge duplicate concepts" dialog. Preview showed union of renderings (Dio·required, God·required). Confirmed merge with typed phrase → one survivor (Anutu with both Dio+God renderings), Dio concept removed from list. |
| Regression: Snapshots + Replace | Check 7 | **PASS** | Snapshots page renders inside project shell (sidebar + topbar intact) with empty state "No snapshots yet" and "Create first snapshot" CTA. Search & Replace dialog opens via toolbar button. Replace mode shows "Search and Replace — entire project" dialog with Find/Replace inputs, "Retain my validations" checkbox with tooltip, "2 cells affected" count, per-cell inline diff preview (before/after with highlighted match), and enabled "Replace 2" button. Screenshot: `pd5-qa-check7-replace-preview.png`. |

---

### New bugs found

#### BUG-FRO260-A — FAIL: "Add to termbase" button click collapses selection before dialog opens

**Surface**: Editor table — source text selection → concept creation  
**Severity**: P1 — FRO-260 core UX flow is broken  
**Repro steps**:
1. Open a file with source text (e.g. `test_fro233.docx`)
2. Select text in the source column (e.g. "bold text for source")
3. The "Add to termbase" button appears next to the selected text
4. Click the "Add to termbase" button
5. **Expected**: "Add to term base" dialog opens with "Source term…" pre-filled with the selected text
6. **Actual**: Clicking the button fires a `mousedown` on the button which causes `blur` on the source element → `selectionchange` event → `handleSelectionChange` → `setSourceSelection(null)`. By the time `onClick` fires, `sourceSelection` is `null` → `handleAddSelectionToTermbase` guard returns early → dialog either does not open OR opens with empty source term field (depending on event timing)

**Root cause**: `handleSelectionChange` (at `EditorTable.tsx`) clears `sourceSelection` on any selection change event, including the click-induced blur. The selection value should be captured and locked before being cleared by the button click.

**Workaround tested**: Calling the button's React fiber `onClick` handler directly via `page.evaluate` opens the dialog but `sourceSelection` is already null by then — input field is empty.

**Fix suggestion**: Capture `sourceSelection` into a ref or local variable at the moment the button renders (not lazily on click), or use `onMouseDown` with `event.preventDefault()` on the button to block the selection-clearing blur before `onClick` fires.

---

#### BUG-FRO186-A — FAIL: Harmonize sweep button never renders (infractions hardcoded empty)

**Surface**: Rules page → BuiltinChecksList  
**Severity**: P1 — FRO-186 harmonize sweep UI is absent  
**Repro steps**:
1. Navigate to `/project/dev-project/rules`
2. Observe any built-in check row
3. **Expected**: A "Harmonize" button appears for checks with infractions
4. **Actual**: No harmonize button rendered for any check

**Root cause**: `RulesPage.tsx` passes `infractions={new Map()}` to `BuiltinChecksList` (TODO comment: "wire real infractions when worker dispatch lands"). In `BuiltinChecksList.tsx`, `showHarmonize = onHarmonize != null && count > 0` — since `count` is always 0 from an empty map, the button is gated off unconditionally. The `FixReviewPanel` and `harmonize_min_role` settings are present and correct; only the empty-infractions guard prevents the button from appearing.

---

### BLOCKED-env notes

| Check | Why blocked |
|-------|------------|
| FRO-179 (TN sidebar) | Sync-worker (port 8789) rejects dev auth-worker JWTs with `401 invalid token signature`. The two workers use different JWT secrets in `.dev.vars`. All sync-worker API calls fail in dev including `fetchProjectFiles` and `fetchFileCells`. Cells with `canonicalRef` matching focused cell can't be loaded. |
| FRO-190 (health ring) | Same JWT issue — `GET /api/v1/projects/dev-project/health-rollup` on sync-worker returns 401. `projectHealth` stays `null`. Ring component is structurally correct. |

---

### Screenshots

- `pd5-qa-fro223-memory-page.png` — Living Memory page with Brain icon, coaching examples, Open Terminology link
- `pd5-qa-fro260-terminology-draft.png` — Terminology page showing "bold text" concept with status "suggested" (created via FRO-260 dialog)
- `pd5-qa-check7-replace-preview.png` — Search & Replace in Replace mode with 2 cells affected, inline diff preview

---

### Ports

- Processes started: Vite :5173, auth-worker :8788, sync-worker :8789, workerd
- All processes killed after QA run. Ports 5173/8787/8788/8789 confirmed free.

---

## PD6 wave UI-QA (2026-06-10)

**Build**: v0.1.0 · swarm/pd6-integration · 6bc4851
**Tested**: 2026-06-10
**Branch under test**: `swarm/pd6-integration` (worktree at `.worktrees/pd6-integration`)
**Environment**: http://127.0.0.1:5174/ (Vite on :5174 — port 5173 occupied by user's main-checkout Vite) · auth :8788 (MAIN checkout auth-worker — pd6 wrangler started but crashed; port 8788 was already held by user's existing stack) · sync :8789
**Login**: `/__dev/login` → auto-logged in as `dev` (OWNER of Dev Org + dev-project)
**Tool**: Playwright MCP (`mcp__plugin_playwright_playwright__*`)
**Build tag confirmed**: "v0.1.0 · swarm/pd6-integration · 6bc4851" visible in sidebar version badge

**Infrastructure note**: Port 5173 was occupied by the user's existing Vite (main checkout). Vite for pd6-integration was started on port 5174. Stale-vite check passed: `curl "http://127.0.0.1:5174/src/components/onboarding/ProductTour.tsx" | grep -c "org-switcher"` returned 1 (main checkout returns 0). Port 8788 was occupied by the user's existing auth workerd (main checkout). The pd6-integration wrangler started but its workerd was assigned a random port (55789); all browser auth requests went to the main checkout's auth worker. FRO-264's server-side fix (`db0a005` — adds `description` to `SELECT id, name, description FROM groups`) is NOT in the main checkout, so item 4 below could not be verified via the live stack.

---

### FRO-262 — Product tour: org-switcher step + "Your account" copy fix

| # | Check | Status | Evidence |
|---|-------|--------|----------|
| 1 | Tour launches from "Start tour" button | **PASS** | Clicked "Start tour" in the onboarding checklist; tour overlay appeared with first step spotlit |
| 2 | Step "Switch organizations" exists with correct anchor | **PASS** | Tour step with title "Switch organizations" rendered; spotlight on `data-tour="org-switcher"` element (org switcher in the top-left app header). Body: "Click here to switch between organizations or create a new one." |
| 3 | "Your account" step body has no "organizations" mention | **PASS** | "Your account" step body: "Access your preferences, add another account, or sign out from here." — no "organizations" or "settings" language; copy correct per FRO-262 spec |
| 4 | Tour can be relaunched from onboarding checklist after completion | **PASS** | Completed all tour steps, then clicked "Start tour" again from the checklist — tour restarted from step 1 correctly |
| 5 | Spotlight correctly tracks each step's anchor element | **PASS** | Each tour step spotlit the correct UI element via `data-tour="<anchor>"` attribute |

**FRO-262 verdict: PASS (all 5 items)**

---

### FRO-263 — Homepage hero subtitle centered + blitz verse margin

| # | Check | Status | Evidence |
|---|-------|--------|----------|
| 1 | Hero subtitle is horizontally centered at 1280×800 | **PASS** | Subtitle text ("Scale translation without losing trust") rendered with `text-center` class; visually centered under the main headline at desktop viewport (1280×800) |
| 2 | Hero subtitle is centered at 390×844 (mobile) | **PASS** | Resized viewport to mobile (390px wide); subtitle remained centered, wrapped correctly |
| 3 | Subtitle has correct vertical margin above and below | **PASS** | Appropriate spacing between headline and subtitle (spacing consistent with homepage layout) |
| 4 | Hero section does not overflow horizontally at any tested viewport | **PASS** | No horizontal scroll at 1280×800 or 390×844 |
| 5 | Blitz verse section (homepage feature area) has correct left margin | **PASS** | Blitz verse card/section rendered with proper left margin; no flush-to-edge overflow |
| 6 | Screenshot taken at desktop viewport | **PASS** | `fro263-hero-desktop.png` captured |

**FRO-263 verdict: PASS (all 6 items)**

---

### FRO-264 — Teams page: edit/delete buttons + group detail description

| # | Check | Status | Evidence |
|---|-------|--------|----------|
| 1 | Teams page (`/teams`) renders | **PASS** | Navigated to `/teams`; page rendered with "Teams" heading, "New team" button, and "Dev Team" visible |
| 2 | Edit button is present on team card | **PASS** | "Edit" button visible on Dev Team card; `fro264-team-page-buttons.png` captured |
| 3 | Delete button is present on team card | **PASS** | "Delete" button visible on Dev Team card alongside Edit |
| 4 | Edit form pre-fills description from server | **FAIL** | Opened edit form; name field pre-filled with "Dev Team" (correct). Description field is empty. Server fix `db0a005` (adds `description` to `SELECT id, name, description FROM groups` in `getOrgGroupDetail`) is in pd6-integration but NOT in the main checkout auth-worker that served requests during this QA run. The description cannot be verified via the live stack without pd6's auth-worker on port 8788. |
| 5 | Edit form save succeeds | **PASS** | Edited name field and saved; save completed without error |
| 6 | Team card links to team detail / project list | **PASS** | Clicked "Dev Project" in the teams page projects list; navigated to `/projects/dev-project` (project overview page) correctly |
| 7 | Delete confirmation dialog and cascade | **NOT VERIFIED** | Delete flow (confirmation dialog + cascade behavior) was not exercised to avoid altering dev data mid-session |

**FRO-264 verdict: PARTIAL — items 1–3 PASS, item 5–6 PASS; item 4 FAIL (server fix not reachable — main auth-worker on :8788 lacks `db0a005`); item 7 NOT VERIFIED (deliberate)**

**Root cause for item 4 FAIL**: Port 8788 was occupied by the user's existing dev stack (main checkout workerd, PID 4176). The pd6-integration wrangler started but workerd bound to a random high port; no way to redirect browser auth to it without editing vite env. The `getOrgGroupDetail` SQL fix (`SELECT id, name, description FROM groups`) exists in `.worktrees/pd6-integration/auth-worker/src/services/org-permissions.ts` but is not reachable in this test environment.

---

### Summary

| Fix | Verdict |
|-----|---------|
| FRO-262 (product tour org-switcher step + account copy) | **PASS** |
| FRO-263 (homepage hero subtitle centered + blitz verse margin) | **PASS** |
| FRO-264 (teams edit/delete buttons + description prefill) | **PARTIAL** — UI pass, server fix not verifiable (port conflict) |

### New issues noticed

None beyond the infrastructure constraint noted above.

### Ports / cleanup

- Vite on :5174 (PID 13843 / child 14154): started by this QA session — killed after QA
- Identity wrangler (pd6-integration): started by this QA session — process died mid-session (esbuild deadlock in workerd); confirmed gone before cleanup
- Sync wrangler (pd6-integration): started by this QA session — process died or was not successfully started; confirmed gone before cleanup
- `.worktrees/pd6-integration/.env.development.local`: written by this QA session — deleted after QA
