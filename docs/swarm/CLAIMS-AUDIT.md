# Homepage Claims Audit

**Audited:** 2026-05-30  
**Auditor role:** Sonnet research agent (read-only)  
**Source of claims:** `src/pages/Homepage/Homepage.tsx` (hero, manifesto, pricing list)

---

## Status Table

| ID | Claim | Status | Evidence (file:line) | Gap | Recommendation | Effort | Blocked by in-flight? |
|----|-------|--------|----------------------|-----|----------------|--------|-----------------------|
| C1 | CTA `/onboarding` → create account → workspace | **DONE** | `src/App.tsx:79`, `OnboardingWizard.tsx`, `SignInStep.tsx`, `ReadyStep.tsx` | No dead ends; sign-in is skippable; lands in workspace | — | — | No |
| C2 | Text translation "under one roof" (cell editor draft/edit/validate) | **DONE** | `src/components/EditorTable.tsx`, `TranslatedEditor.tsx`, `ProjectWorkspace.tsx:687` | Full pipeline: TipTap editor → event commit → D1 sync → validate | — | — | No |
| C3 | Audio translation: record / synthesize / play | **PARTIAL** | `whisper-worker.ts`, `mms-worker.ts`, `kokoro-worker.ts`, `VoiceSidebar.tsx`, `CellTtsButton.tsx` | On-device Whisper transcription + MMS/Kokoro TTS exist and run in-browser. **BUT** transcript-to-cell writeback is disabled (`CellTranscriptPreview.tsx:105–107`: "Transcript-to-cell write disabled in this build") and audio bulk progress banner warns write path gone. Recording and playback work; committing transcript text to cell is broken. | BUILD: reconnect transcript→cell writeback in event grammar | S | Yes — touches `sync-worker/src/events/` |
| C4 | **VIDEO translation** ("text, audio, video" hero + pricing) | **OVERCLAIM** | `ProjectWorkspace.tsx:479–485` | VideoAttachment is a no-op stub: `videoAttachment={}`, `videoSrc=null`, `saveVideo=()=>{}`. Comment: "Disabled…comes back via event grammar in v1.x". A `VideoPlayer` and `VideoAttachmentDialog` exist (UI shells) and a `vtt-generator` works for subtitle files already open, but users **cannot attach, view, or translate a video** in any path today. The `VideoPlayer` only renders when `videoSrc` is non-null, which it never is. No dub/lip-sync, no video export. | DIAL BACK COPY: change hero from "text, audio, and video" to "text and audio" until v1.x event-grammar video path lands; OR BUILD reconnect (M, blocked by sync-worker events) | M | Yes — `sync-worker/src/events/` |
| C5 | "A first draft in seconds" AI completion incl. low-resource | **DONE** | `completion-service.ts:buildPrompt`, `buildBatchPrompt`, `useCompletion.ts:100–145`, `whisper-worker.ts`, `mms-worker.ts` | Frontier (cloud) and custom-endpoint providers work. Few-shot retrieval via branching search feeds examples into prompt. Batch mode (up to 30 cells). MMS covers 1000+ low-resource languages locally. | — | — | No |
| C6 | "Real-time checks and back-translation as you work" | **STUB** | `ProjectWorkspace.tsx:691–696`, `backtranslation-service.ts` (full implementation), `EditorTable.tsx:326–327` | `runBacktranslation` is `async () => {}`, `isBacktranslationConfigured = false`, `backtranslating = new Set()`. Button renders in cell expansion with "Set up AI for backtranslation" prompt, but clicking it does nothing. The `backtranslation-service.ts` library is complete and correct — only the ProjectWorkspace hookup is missing. | BUILD: wire `generateBacktranslation()` → event commit in ProjectWorkspace | S | Yes — writes cell field, may touch `sync-worker/src/events/handlers/cell-events.ts` |
| C7 | Living Memory as ACTIVE LEARNING LOOP: "fix it once, the system learns" | **PARTIAL / OVERCLAIM** | `useCompletion.ts:116–121`, `RuleSuggestDialog.tsx`, `rule-suggester.ts`, `completion-service.ts:DEFAULT_SYSTEM_PROMPT` | **What works:** few-shot examples from branching-search DO feed the model (validated pairs as context = implicit memory). **What doesn't:** (1) `collectValidatedPairs()` in `RuleSuggestDialog.tsx:13–15` returns `[]` ("Phase 2c-gamma" stub — can't collect pairs without Y.Doc). (2) Project `rules` (TranslationRules with find/replace) are NOT injected into the completion system prompt — they only run as post-edit checks/violations, not as upstream guidance. (3) Autofix is disabled (`RuleDrawer.tsx:55,88`). The bienestar→bienes demo is aspirational: a correction updates a rule, but that rule never reaches the next draft prompt. | BUILD (M): inject active `rules` into system prompt in `useCompletion`; restore `collectValidatedPairs` from D1 projection. Not blocked by sync-worker events. | M | No (rules/completion path is pure client) |
| C8 | "Quality you can see": per-cell confidence score (HealthRing) + "biggest drags, ranked and one click away" | **PARTIAL** | `decay-engine.ts`, `HealthRing.tsx`, `DecayBreakdown.tsx:22–82`, `ProjectWorkspace.tsx:719–739`, `useCellConfidence.ts` | Per-cell HealthRing: **DONE** (endorsement-count decay, shown in every cell row). Biggest-drags popover: **DONE** (`DecayBreakdown` component, sorted by ascending health, one-click `jumpToCellId`). FTS5-derived confidence overlay: **PROTOTYPE / OPT-IN** (behind `localStorage("health-confidence-overlay")==="1"`, disabled by default). "Confidence derived on read — text and audio" claim is ahead of reality for audio (no audio-specific confidence path exists). | DIAL BACK COPY: remove "text and audio" qualifier from confidence claim, or add audio confidence path | S | No |
| C9 | "Many translators, one project" / "Cloud sync & team collaboration" | **DONE** | `ws-reconciler.ts`, `useFileSync.ts`, `SyncStatusIndicator.tsx`, `TeamsList.tsx`, `TeamDetail.tsx`, `JoinPage.tsx` | WS sync with presence + focus-locks (DO). Teams lifecycle (list/create/rename/delete/members) shipped in last commit. Invite links via `/join/:token`. Cloud D1 projection writer. | Minor: Teams don't yet gate project access (org permissions model is stub per `OrgHome.tsx:18` "Portfolio insights coming soon") | — | No |
| C10 | "On-device speech & private mode" | **PARTIAL** | `whisper-worker.ts` (Xenova/whisper-base via HuggingFace Transformers.js), `mms-worker.ts`, `kokoro-worker.ts`, `PrivateModeBanner.tsx`, `AiModelsStep.tsx` | **On-device speech: DONE** (Whisper transcription + MMS TTS + Kokoro TTS all run in-browser after a one-time model download). **"Private mode"**: NOT a feature toggle. `PrivateModeBanner` fires only when OPFS is unavailable (private browser tab degrades caching) — it is a degradation warning, not a "no cloud calls" mode. The pricing claim "On-device speech & private mode" implies a user can consciously choose to keep data local, which doesn't exist as a toggle. | DIAL BACK COPY: rename to "On-device speech" and drop "private mode" OR BUILD a local-only mode toggle that routes completion to on-device models only | S | No |
| C11 | "Free, forever · open source" / no billing gate | **DONE** | `OnboardingWizard.tsx` (sign-in is skippable), `App.tsx` (no paywall route), no Stripe/billing imports found | Workspace accessible without sign-in; AI features require Frontier account (free). No paywall. OSS is a repo-level claim. | — | — | No |
| C12 | Import/export of professional source files (USFM/Paratext) | **PARTIAL** | `lib/import.ts:24–67`, `ImportDialog.tsx`, `lib/parsers/usfm.ts`, `lib/parsers/paratext-project.ts`, `lib/export/export-service.ts:1` | **Import: DONE** (USFM lossless parser, Paratext project import, eBible source picker). **Export: DISABLED** (`exportFile()` throws: "Export disabled in Phase 2c-γ — coming back via event-grammar in v1.x"). | BUILD: restore USFM export via D1 cells projection (M, blocked by sync-worker events) | M | Yes — `sync-worker/src/events/` |
| C13 | Manifesto modalities "image, oral story" | **OVERCLAIM** | `Homepage.tsx` manifesto section (icons + tags), no implementing code | The manifesto lists Text / Audio / Video / Images / Oral stories as modal chips. Zero implementation exists for images or oral stories. These are vision copy only. | DIAL BACK COPY: reframe manifesto as "the future" / "what we're building toward" with clearer aspirational framing; or remove Images and Oral stories from the chip row | S | No |

---

## Disabled Features on Claimed Golden Paths

| Component | Disabled string | Claim it breaks |
|-----------|----------------|-----------------|
| `src/components/CellTranscriptPreview.tsx:105–107` | "Transcript-to-cell write disabled in this build" | C3 (audio translation workflow) |
| `src/components/RuleDrawer.tsx:55,88` | "Autofix is unavailable in this build" | C7 (living memory / correction loop) |
| `src/components/RuleSuggestDialog.tsx:9–15` | Phase 2c-gamma stub: `collectValidatedPairs` returns `[]` | C7 (living memory / rule suggestion from edits) |
| `src/lib/export/export-service.ts:1–22` | `exportFile()` throws hard | C12 (export) |
| `src/components/ProjectWorkspace.tsx:479–485` | `videoSrc=null`, `saveVideo=()=>{}` | C4 (video) |
| `src/components/ProjectWorkspace.tsx:691–696` | `runBacktranslation=async()=>{}` | C6 (back-translation) |
| `src/lib/workspace-actions/registry.ts:55–57` | "Complete all (coming soon)" | C5 (batch AI — single-cell batch works; "complete all" does not) |
| `src/components/onboarding/SetupChecklistDrawer.tsx:87–91` | "Upload project standards / Import glossary — Coming soon" | C7 (living memory — glossary/TM import) |

---

## Biggest Broken Promises (Priority Order)

### 1. C4 — VIDEO TRANSLATION (OVERCLAIM, high-visibility)
The hero line "text, audio, and **video**" and the pricing list item "Full multimodal workspace — text, audio, **video**" are the most prominent broken claim. There is no video capability reachable by a user. The video infrastructure stubs exist but are explicitly disabled. Every user who clicks "Start free" because of the video claim will be misled.
**Recommendation:** DIAL BACK COPY immediately (change hero + pricing to "text and audio"); BUILD video path in v1.x (M effort, blocked by sync-worker events).

### 2. C7 — LIVING MEMORY ACTIVE LEARNING LOOP (OVERCLAIM)
The "Fix it once, the system learns" section with the bienestar→bienes demo is the emotional core of the homepage. In reality: (a) corrections → rules don't feed the next draft prompt, (b) rule suggestion from validated edits returns an empty list (stub), (c) autofix is disabled. The only "memory" is few-shot examples from branching search — real but not the same as the claimed contextual decision loop.
**Recommendation:** BUILD the rules→prompt injection (S/M, client-only, not blocked) immediately — this is the highest-leverage fix. The bienestar demo can become real with ~2 files changed.

### 3. C6 — BACK-TRANSLATION (STUB on a claimed real-time feature)
"Real-time checks and back-translation as you work" is listed in the Living Memory feature list. The back-translation service library is complete; only the ProjectWorkspace hookup is missing. It's a one-sprint fix but the button currently does nothing.
**Recommendation:** BUILD (S effort, touches sync-worker cell event handler — coordinate with in-flight work there).

### 4. C12 — EXPORT DISABLED (trust-breaking for Paratext cohort)
The first-user cohort is SIL/UBS Paratext consultants whose trust depends on round-trip fidelity. Import works but `exportFile()` hard-throws. A consultant who imports a USFM project, translates it, and tries to export will hit an error. This is credibility-critical.
**Recommendation:** BUILD USFM export via D1 cells projection (M effort, blocked by sync-worker events; coordinate with sync team).

### 5. C10 — "PRIVATE MODE" (misleading label)
"Private mode" on the pricing page implies a user can consciously work without cloud calls. What exists is a degradation banner when OPFS is unavailable. Not the same thing.
**Recommendation:** DIAL BACK COPY: rename to "On-device speech" (change 1 line in `Homepage.tsx:418`), or BUILD a real local-only toggle that bypasses the Frontier API.

---

## Summary by Status

| Status | Claims |
|--------|--------|
| DONE | C1, C2, C5, C9, C11 |
| PARTIAL | C3, C7, C8, C10, C12 |
| STUB | C6 |
| OVERCLAIM | C4, C13 |

**Safe to copy as-is:** C1, C2, C5, C9, C11  
**Fix copy immediately (no code needed):** C4 hero/pricing ("video"), C10 ("private mode"), C13 (images/oral stories)  
**Build soon (not blocked):** C7 rules→prompt injection, C6 backtranslation hookup  
**Build when sync-worker events land:** C3 transcript→cell, C4 video, C12 export  
