# TTS Provider Unification — Design

**Date:** 2026-06-17
**Status:** Approved for planning
**Owner:** Ryder

## Problem

Audio mode exposes three inconsistent ways to choose a text-to-speech engine:

1. A hover-rail button **"Generate audio (OmniVoice)"** (`EditorTable.tsx`) — one-click,
   hardcoded to the server-side OmniVoice Modal endpoint, ignores the cast entirely.
2. The cast voice editor (`CharacterModal.tsx`) — a per-voice engine picker offering only
   **Gemini / MMS / Kokoro** (no OmniVoice).
3. Per-cell generation (`CellVoicePanel` → `generate-voice.ts`) — routes by the assigned
   voice's engine, i.e. Gemini / MMS / Kokoro only.

So OmniVoice exists as a separate code path that can't be assigned to a cast voice, while the
three client-side engines can't be triggered from the rail button. The user can't reason about
"which engine is this line using," and OmniVoice — the best zero-setup option — is invisible to
the cast model.

## Goal

One mental model everywhere: **a voice has a TTS engine**, chosen from a single list of four,
grouped by where they run:

- **Cloud (primary):** OmniVoice, Gemini
- **On-device (secondary):** Kokoro, MMS

Generation is driven entirely by the assigned voice's engine. There is no separate
engine-specific button.

## Decisions (locked with user)

| # | Decision |
|---|----------|
| Scope | "One provider picker, four engines." Onboarding (`AiModelsStep`) and `LocalModelsSection` are **out of scope** — not touched this pass. |
| OmniVoice voice config | Default voice out of the box; optional reference clip for native cloning. OmniVoice has **no named voices**. |
| Cloning gating | **Per-provider capability.** OmniVoice + Gemini (cloud) support cloning; Kokoro + MMS (on-device) do **not** — selecting them disables the clone section with a note. This intentionally drops Kokoro/MMS's current (Seed-VC) clone capability, because a server round-trip defeats the on-device benefit. |
| Rail button | **Removed.** Generation is provider-driven through the per-cell control. |
| Default engine | **OmniVoice** (was Gemini). Zero setup — no API key, no download. |
| Engine cards | Each engine shows a short value-prop + caveat (see Copy below). |

## Architecture

### Two synthesis paths, reconciled behind one router

OmniVoice and the three client engines have genuinely different shapes:

- **OmniVoice** (`synthesizeCellTts` → sync-worker `/api/v1/voice/tts` → Modal): takes
  `{ projectId, fileId, cellId, text, language?, referenceAudioId? }`, synthesizes **and stores**
  the WAV in R2, returns `{ audioId, objectName, url, durationSeconds }`. Native cloning via the
  reference clip. Metered against the org TTS budget/credits.
- **Gemini / Kokoro / MMS** (`synthesizeToWavBlob` → returns a `Blob`): client-side synthesis.
  Cloning is a separate server post-process (Seed-VC, `convertToCloneVoice`). The blob is then
  uploaded to R2 and attached.

We **do not** push OmniVoice into `synthesizeToWavBlob` (it would leak project/session/token
concerns into the low-level dispatcher and the return shapes differ). Instead the per-cell
generation entry point branches by engine.

### Component changes

**1. Provider registry — `src/lib/audio/tts-providers.ts`**
- `TtsProvider`: add `"omnivoice"` → `"omnivoice" | "gemini" | "kokoro" | "mms"`.
- `TtsProviderInfo` gains capability metadata:
  - `tier: "cloud" | "device"`
  - `supportsCloning: boolean`
  - `hasNamedVoices: boolean`
  - `blurb: string` (a few words of value-prop)
  - `caveat?: string` (e.g. "needs your own key", "may affect performance")
  - `learnMoreUrl?: string` (optional info-page link)
- Reorder `TTS_PROVIDER_INFOS` to: **omnivoice, gemini, kokoro, mms**.
  - omnivoice: tier cloud, clone ✓, named ✗, badge "Recommended", no key.
  - gemini: tier cloud, clone ✓, named ✓, `requiresGeminiKey`.
  - kokoro: tier device, clone ✗, named ✓ (voice-id string).
  - mms: tier device, clone ✗, named ✓ (language code).
- `DEFAULT_TTS_PROVIDER = "omnivoice"`. (`providerInfo()` already falls back to
  `TTS_PROVIDER_INFOS[0]`, which becomes omnivoice after reorder — consistent.)
- `defaultVoiceNameForProvider("omnivoice")` → `undefined`; `normalizeVoiceForProvider` treats
  omnivoice as having no `voiceName`.

**2. Cast voice editor — `src/components/voice/CharacterModal.tsx`**
- Engine buttons render in two labeled groups: **Cloud** (OmniVoice, Gemini) above,
  **On-device** (Kokoro, MMS) visually demoted below. Each button shows the engine name plus its
  `blurb`/`caveat` (and `learnMoreUrl` link where present).
- **Base voice** section hidden when `!hasNamedVoices` (OmniVoice). `PresetPicker` gets an
  omnivoice branch rendering a one-line explainer instead of a control.
- **Guidance** stays Gemini-only (unchanged).
- **Clone section** gated by `info.supportsCloning`:
  - OmniVoice / Gemini → enabled (current `VoiceCloneSection` UI).
  - Kokoro / MMS → section greyed/disabled with note "On-device voices don't support cloning."
- **Preview** for OmniVoice routes through the server synth (`synthesizeCellTts`) — the modal
  already receives `projectId`/`fileId`/`session`. One short metered sample. Other engines keep
  the existing `synthesizeToWavBlob` client preview.

**3. Per-cell generation — `src/lib/audio/generate-voice.ts`**
- Resolve the engine **voice-first**: `voice.provider ?? project default`.
- If engine is `omnivoice` → `synthesizeCellTts({ projectId, fileId, cellId, text, language,
  referenceAudioId })`, then attach the returned `url`/`objectName` to the generatedVoice slot.
  No client synth, no upload, no Seed-VC (the server already synthesized, stored, and — when a
  reference is present — cloned natively).
- Else → existing path (client synth → optional Seed-VC when `referenceAudioId` set → upload →
  attach).

**4. Cast roster — `src/components/VoiceLibraryPanel.tsx`**
- `engineLabel` already derives from `TTS_PROVIDER_INFOS`; adding OmniVoice yields the correct
  roster label automatically. Verify it reads as "OmniVoice."

**5. Rail button — `src/components/EditorTable.tsx`**
- Remove the "Generate audio (OmniVoice)" button and its handler (`synthesizeCellTts` call at the
  rail). The `synthesizeCellTts` lib stays — it's now invoked by the generation router for
  omnivoice voices.

### Copy (engine cards)

Short, a few words each. Exact wording to confirm during implementation; placeholders:

- **OmniVoice** — "Recommended. Hosted, no setup or key needed." (cloud)
- **Gemini** — "Highest quality, promptable; many languages. Needs your own Google AI key." (cloud)
- **Kokoro** — "Free, on-device English voices. One-time download; may affect performance." (device)
- **MMS** — "Free, on-device, many languages. One model per language; may affect performance." (device)

`learnMoreUrl`: only wired if a real info page exists — **do not fabricate URLs**. If none, omit
the link. Flag for the user during implementation.

## Out of scope (known follow-ups)

- Onboarding `AiModelsStep` and `LocalModelsSection` still list only Gemini/Kokoro/MMS and won't
  mention OmniVoice. A later "full registry consolidation" pass would unify those around the same
  registry.
- No change to the OmniVoice Modal endpoint, budget/credit model, or Seed-VC conversion worker.

## Testing (intent-encoding, Rule 9)

- **Registry:** four entries; omnivoice first; correct `tier`/`supportsCloning`/`hasNamedVoices`
  per engine; `DEFAULT_TTS_PROVIDER === "omnivoice"`.
- **Routing (`generate-voice`):** an omnivoice voice calls the server path and never the client
  synth/upload; a Gemini/Kokoro/MMS voice calls the client path and never `synthesizeCellTts`.
  Reference clip on an omnivoice voice is forwarded as `referenceAudioId`. (Both paths mocked.)
- **CharacterModal:** switching to Kokoro/MMS disables the clone section and shows the note;
  switching to OmniVoice hides the base-voice list and keeps cloning enabled. Switching to Gemini
  shows named voices + Guidance + cloning.
- **Regression:** existing `sync-worker/src/__tests__/tts.test.ts` stays green (endpoint
  unchanged).
- **UI walkthrough:** in audio mode — assign an OmniVoice voice to a cell, generate, hear it;
  switch a voice to MMS and confirm the clone section is disabled with the note; confirm the
  standalone rail button is gone.

## Implementation note

Work happens in a dedicated git worktree off live `main` (per workspace convention).
