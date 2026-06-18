# TTS Provider Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OmniVoice a first-class TTS engine alongside Gemini/Kokoro/MMS in one provider picker, drive all per-cell generation by the assigned voice's engine, and remove the standalone OmniVoice rail button.

**Architecture:** Add `"omnivoice"` to the `TtsProvider` union with capability metadata (tier, cloning, named-voices). OmniVoice stays server-side (`synthesizeCellTts` → sync-worker) and is branched in the generation entry points (`generate-voice.ts`, `combined-voice.ts`); the three client engines keep the `synthesizeToWavBlob` path. Generation provider selection becomes **voice-first** (fixing a latent bug where the project provider always won). The CharacterModal picker groups Cloud (OmniVoice, Gemini) above On-device (Kokoro, MMS), hides the base-voice list for OmniVoice, and gates the clone section to cloud engines.

**Tech Stack:** React + TypeScript (Vite SPA), Vitest (happy-dom), Cloudflare Worker (`sync-worker`), package manager **pnpm**.

**Worktree:** Before Task 1, create an isolated worktree off live `main` via the `superpowers:using-git-worktrees` skill. All commits land there; promote to `main` only after the final verification task passes.

---

## File Structure

| File | Change |
|------|--------|
| `src/lib/parsers/types.ts` | `TtsProvider` union gains `"omnivoice"`. |
| `src/lib/audio/tts-providers.ts` | Capability metadata on `TtsProviderInfo`; reorder + add OmniVoice; default → omnivoice; `defaultVoiceNameForProvider`/`normalizeVoiceForProvider` omnivoice branches. |
| `src/lib/audio/tts.ts` | Voice-first provider in `synthesizeForCell`; OmniVoice guard in `synthesizeToWavBlob`. |
| `src/lib/audio/generate-voice.ts` | OmniVoice server branch in `generateAndAttachCellVoice`. |
| `src/lib/audio/combined-voice.ts` | OmniVoice server branch in `generateCombinedVoice`. |
| `src/components/voice/CharacterModal.tsx` | Grouped 4-engine picker; hide base voice for OmniVoice; clone-gating; OmniVoice server preview. |
| `src/components/CellTtsButton.tsx` | Voice-first provider; gate model-download UI to local engines. |
| `src/components/EditorTable.tsx` | Remove OmniVoice rail button, handler, state, unused imports. |
| `src/lib/audio/tts-providers.test.ts` | Extend with omnivoice cases. |
| `src/lib/audio/tts-routing.test.ts` | New: routing + precedence tests. |

---

## Task 1: Add `"omnivoice"` to the provider type

**Files:**
- Modify: `src/lib/parsers/types.ts` (the `TtsProvider` definition, ~line 185)

- [ ] **Step 1: Find the type**

Run: `grep -n "export type TtsProvider" src/lib/parsers/types.ts`
Expected: one line, e.g. `export type TtsProvider = "kokoro" | "gemini" | "mms"`

- [ ] **Step 2: Edit the union**

Replace that line with:

```ts
export type TtsProvider = "omnivoice" | "gemini" | "kokoro" | "mms"
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc -b --noEmit` (or `pnpm build` later)
Expected: PASS — the union is widened; the switch statements we touch in later tasks already have fallbacks, so no exhaustiveness errors here. If tsc flags an exhaustive `switch` on `TtsProvider` somewhere unexpected, note the file and handle it in that file's task.

- [ ] **Step 4: Commit**

```bash
git add src/lib/parsers/types.ts
git commit -m "feat(tts): add omnivoice to TtsProvider union"
```

---

## Task 2: Provider registry — capability metadata, OmniVoice entry, default

**Files:**
- Modify: `src/lib/audio/tts-providers.ts:4` (`DEFAULT_TTS_PROVIDER`)
- Modify: `src/lib/audio/tts-providers.ts:43-80` (`TtsProviderInfo` + `TTS_PROVIDER_INFOS`)
- Modify: `src/lib/audio/tts-providers.ts:129-157` (`defaultVoiceNameForProvider`, `normalizeVoiceForProvider`)
- Test: `src/lib/audio/tts-providers.test.ts`

- [ ] **Step 1: Write failing tests**

Append inside the existing `describe("TTS provider normalization", ...)` block in `src/lib/audio/tts-providers.test.ts` (and add imports at top: `DEFAULT_TTS_PROVIDER`, `TTS_PROVIDER_INFOS`, `defaultVoiceNameForProvider`, `providerInfo`):

```ts
it("defaults to omnivoice", () => {
  expect(DEFAULT_TTS_PROVIDER).toBe("omnivoice")
})

it("lists all four engines with cloud engines first", () => {
  expect(TTS_PROVIDER_INFOS.map((p) => p.id)).toEqual([
    "omnivoice", "gemini", "kokoro", "mms",
  ])
})

it("marks only cloud engines as cloning-capable", () => {
  const byId = Object.fromEntries(TTS_PROVIDER_INFOS.map((p) => [p.id, p]))
  expect(byId.omnivoice.supportsCloning).toBe(true)
  expect(byId.gemini.supportsCloning).toBe(true)
  expect(byId.kokoro.supportsCloning).toBe(false)
  expect(byId.mms.supportsCloning).toBe(false)
})

it("marks omnivoice as the only engine without named voices", () => {
  const byId = Object.fromEntries(TTS_PROVIDER_INFOS.map((p) => [p.id, p]))
  expect(byId.omnivoice.hasNamedVoices).toBe(false)
  expect(byId.gemini.hasNamedVoices).toBe(true)
  expect(byId.kokoro.hasNamedVoices).toBe(true)
  expect(byId.mms.hasNamedVoices).toBe(true)
})

it("tags each engine with its run tier", () => {
  const byId = Object.fromEntries(TTS_PROVIDER_INFOS.map((p) => [p.id, p]))
  expect(byId.omnivoice.tier).toBe("cloud")
  expect(byId.gemini.tier).toBe("cloud")
  expect(byId.kokoro.tier).toBe("device")
  expect(byId.mms.tier).toBe("device")
})

it("gives omnivoice no base voice name", () => {
  expect(defaultVoiceNameForProvider("omnivoice")).toBe("")
})

it("clears the voice name when normalizing to omnivoice", () => {
  expect(normalizeVoiceForProvider(geminiVoice, "omnivoice").voiceName).toBe("")
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/lib/audio/tts-providers.test.ts`
Expected: FAIL — `DEFAULT_TTS_PROVIDER` is `"gemini"`, registry has 3 entries, no `supportsCloning`/`hasNamedVoices`/`tier` fields, omnivoice unhandled.

- [ ] **Step 3: Change the default**

Edit `src/lib/audio/tts-providers.ts:4`:

```ts
export const DEFAULT_TTS_PROVIDER: TtsProvider = "omnivoice"
```

- [ ] **Step 4: Extend the `TtsProviderInfo` interface**

Replace the interface (currently lines ~43-51) with:

```ts
export interface TtsProviderInfo {
  id: TtsProvider
  title: string
  shortTitle: string
  hint: string
  /** Where the engine runs. Drives the Cloud/On-device grouping in the picker. */
  tier: "cloud" | "device"
  /** Whether a reference recording can clone a target timbre for this engine. */
  supportsCloning: boolean
  /** Whether the engine exposes named base voices (false for OmniVoice). */
  hasNamedVoices: boolean
  /** A few words of value-prop for the engine card. */
  blurb: string
  /** Short caveat shown under the blurb (key needed, performance, etc.). */
  caveat?: string
  /** Optional external info page; only set when a real page exists. */
  learnMoreUrl?: string
  badge?: string
  localModel?: "kokoro" | "mms"
  requiresGeminiKey?: boolean
}
```

- [ ] **Step 5: Replace `TTS_PROVIDER_INFOS`**

Replace the whole `TTS_PROVIDER_INFOS` array (currently lines ~53-80) with:

```ts
export const TTS_PROVIDER_INFOS: readonly TtsProviderInfo[] = [
  {
    id: "omnivoice",
    title: "OmniVoice",
    shortTitle: "OmniVoice",
    tier: "cloud",
    supportsCloning: true,
    hasNamedVoices: false,
    badge: "Recommended",
    blurb: "Hosted neural voice — no setup or API key.",
    hint: "Runs on our servers. No key or download; usage is cloud-metered. Supports voice cloning from a reference recording.",
  },
  {
    id: "gemini",
    title: "Gemini TTS",
    shortTitle: "Gemini",
    tier: "cloud",
    supportsCloning: true,
    hasNamedVoices: true,
    requiresGeminiKey: true,
    blurb: "Highest quality, promptable; many languages.",
    caveat: "Needs your own Google AI key.",
    hint: "BYOK Google AI key. Promptable, high-quality voices.",
  },
  {
    id: "kokoro",
    title: "Kokoro (local)",
    shortTitle: "Kokoro",
    tier: "device",
    supportsCloning: false,
    hasNamedVoices: true,
    localModel: "kokoro",
    blurb: "Free, on-device English voices.",
    caveat: "One-time download; may affect performance.",
    hint: "Runs in-browser after a one-time local model download.",
  },
  {
    id: "mms",
    title: "MMS (multilingual)",
    shortTitle: "MMS",
    tier: "device",
    supportsCloning: false,
    hasNamedVoices: true,
    localModel: "mms",
    blurb: "Free, on-device; many languages.",
    caveat: "One model per language; may affect performance.",
    hint: USE_SHERPA_MMS_MODELS
      ? "Local browser voices loaded from the Sherpa-ONNX MMS mirror."
      : HAS_HOSTED_MMS_MODELS
        ? "Local browser voices loaded from the hosted MMS model bucket."
        : "Local browser voices for supported MMS language repos.",
  },
] as const
```

Note: no `learnMoreUrl` is set — there is no real info page yet. Do **not** fabricate one. If the user supplies URLs later, add them here.

- [ ] **Step 6: Handle omnivoice in `defaultVoiceNameForProvider`**

Replace the function (lines ~129-136) with:

```ts
export function defaultVoiceNameForProvider(
  provider: TtsProvider,
  context: { targetLanguage?: string } = {},
): string {
  if (provider === "omnivoice") return ""
  if (provider === "kokoro") return DEFAULT_KOKORO_VOICE
  if (provider === "mms") return inferMmsLanguageCode(context.targetLanguage) ?? DEFAULT_MMS_LANGUAGE
  return DEFAULT_GEMINI_VOICE
}
```

- [ ] **Step 7: Handle omnivoice in `normalizeVoiceForProvider`**

In the function (lines ~138-157), add an omnivoice branch as the FIRST check after building `next`:

```ts
export function normalizeVoiceForProvider(
  voice: Voice,
  provider: TtsProvider,
  context: { targetLanguage?: string } = {},
): Voice {
  const next: Voice = { ...voice, provider }
  if (provider === "omnivoice") {
    next.voiceName = ""
    return next
  }
  if (provider === "gemini") {
    if (!isGeminiVoiceName(next.voiceName)) next.voiceName = DEFAULT_GEMINI_VOICE
    return next
  }
  // ...rest unchanged (kokoro, then mms fallthrough)
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm exec vitest run src/lib/audio/tts-providers.test.ts`
Expected: PASS (all existing + 7 new cases).

- [ ] **Step 9: Commit**

```bash
git add src/lib/audio/tts-providers.ts src/lib/audio/tts-providers.test.ts
git commit -m "feat(tts): omnivoice provider entry, capability metadata, default"
```

---

## Task 3: Voice-first provider precedence + OmniVoice guard in `tts.ts`

**Files:**
- Modify: `src/lib/audio/tts.ts:124-135` (`synthesizeToWavBlob` guard)
- Modify: `src/lib/audio/tts.ts:212-231` (`synthesizeForCell` precedence)
- Test: `src/lib/audio/tts-routing.test.ts` (new)

- [ ] **Step 1: Write failing tests**

Create `src/lib/audio/tts-routing.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest"

// Mock the heavy engine deps so we test ONLY routing, not synthesis.
const geminiMock = vi.fn(async () => new Blob(["g"], { type: "audio/wav" }))
vi.mock("./gemini-tts", () => ({
  synthesizeGeminiTtsToWavBlob: (...a: unknown[]) => geminiMock(...a),
  GEMINI_TTS_VOICES: [{ name: "Kore", description: "" }],
}))

import { synthesizeForCell, synthesizeToWavBlob } from "./tts"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

beforeEach(() => geminiMock.mockClear())

describe("provider precedence", () => {
  it("uses the voice's own provider over the project default", async () => {
    // Project default is gemini; the voice says gemini explicitly -> gemini called.
    const settings: ProjectTtsSettings = {
      provider: "gemini",
      apiKey: "k",
      voices: [{ id: "v1", name: "N", provider: "gemini", voiceName: "Kore" }],
      defaultVoiceId: "v1",
    }
    await synthesizeForCell("hello", { projectTtsSettings: settings, cellVoiceId: "v1" })
    expect(geminiMock).toHaveBeenCalledTimes(1)
  })
})

describe("omnivoice guard", () => {
  it("synthesizeToWavBlob refuses omnivoice (server-only)", async () => {
    await expect(
      synthesizeToWavBlob("hi", {
        voice: { id: "v", name: "N", provider: "omnivoice" },
        projectProvider: "omnivoice",
      }),
    ).rejects.toThrow(/server-side/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/lib/audio/tts-routing.test.ts`
Expected: FAIL — the omnivoice guard does not exist yet (it would fall through to the Kokoro worker and hang/throw a different error).

- [ ] **Step 3: Add the OmniVoice guard**

In `src/lib/audio/tts.ts`, in `synthesizeToWavBlob`, right after the `const provider = ...` line (currently line 131) and BEFORE `normalizeVoiceForProvider`, insert:

```ts
  if (provider === "omnivoice") {
    throw new Error(
      "OmniVoice runs server-side — generate from a project cell, not the local synth path.",
    )
  }
```

- [ ] **Step 4: Make `synthesizeForCell` voice-first**

Replace the body of `synthesizeForCell` (lines ~212-231) with:

```ts
export async function synthesizeForCell(
  text: string,
  args: {
    projectTtsSettings?: ProjectTtsSettings
    cellVoiceId?: string
    speed?: number
    geminiContext?: GeminiTtsContext
    onProgress?: SynthOptions["onProgress"]
  },
): Promise<Blob> {
  const voice = resolveVoice(args.projectTtsSettings, args.cellVoiceId)
  // Engine is per-voice: the resolved voice's provider wins; the project
  // setting is only a fallback for legacy voices with no provider of their own.
  const provider = voice.provider ?? resolveTtsProvider(args.projectTtsSettings)
  return synthesizeToWavBlob(text, {
    voice,
    projectProvider: provider,
    apiKey: resolveApiKey("gemini-tts", args.projectTtsSettings?.apiKey),
    speed: args.speed,
    geminiContext: args.geminiContext,
    onProgress: args.onProgress,
  })
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run src/lib/audio/tts-routing.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/audio/tts.ts src/lib/audio/tts-routing.test.ts
git commit -m "feat(tts): voice-first provider precedence + omnivoice guard"
```

---

## Task 4: OmniVoice branch in `generateAndAttachCellVoice`

**Files:**
- Modify: `src/lib/audio/generate-voice.ts`
- Test: `src/lib/audio/tts-routing.test.ts` (extend)

- [ ] **Step 1: Write failing test**

Append to `src/lib/audio/tts-routing.test.ts`. This mocks every collaborator of `generateAndAttachCellVoice` and asserts that an omnivoice voice hits the server path (`synthesizeCellTts`) and NOT the client path (`synthesizeForCell`):

```ts
describe("generateAndAttachCellVoice routing", () => {
  it("omnivoice voice uses the server TTS path, not client synth", async () => {
    vi.resetModules()
    const synthCellTts = vi.fn(async () => ({
      audioId: "audio-tts-1", durationSeconds: 1.2,
      objectName: "audio-tts-1.wav", url: "frontier-audio://audio-tts-1.wav",
    }))
    const synthForCell = vi.fn(async () => new Blob(["x"], { type: "audio/wav" }))
    const emitAttach = vi.fn(async () => {})
    vi.doMock("@/lib/sync/tts", () => ({ synthesizeCellTts: synthCellTts }))
    vi.doMock("./tts", () => ({
      synthesizeForCell: synthForCell, setTtsStatus: vi.fn(),
      ttsStatusKey: (s: string) => s,
    }))
    vi.doMock("@/lib/sync/events-emit", () => ({ emitCellAudioAttach: emitAttach }))
    vi.doMock("./audio-attachments-bus", () => ({ notifyAudioAttachmentsChanged: vi.fn() }))
    vi.doMock("./sync-token-fetcher", () => ({ audioSyncTokenFetcherForSession: () => async () => "tok" }))
    vi.doMock("./upload", () => ({
      buildAudioId: () => "id", uploadCellAudio: vi.fn(),
      fetchCellAudio: vi.fn(async () => new ArrayBuffer(4)),
    }))
    vi.doMock("./voice-clone", () => ({ convertToCloneVoice: vi.fn() }))
    vi.doMock("./voices", () => ({
      resolveVoice: () => ({ id: "v", name: "N", provider: "omnivoice" }),
    }))
    const { generateAndAttachCellVoice } = await import("./generate-voice")
    await generateAndAttachCellVoice({
      projectId: "p", fileId: "f", cellId: "c", text: "hello",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { jwt: "j", username: "u" } as any, username: "u",
      geminiContext: { targetLanguage: "es" },
    })
    expect(synthCellTts).toHaveBeenCalledTimes(1)
    expect(synthForCell).not.toHaveBeenCalled()
    expect(emitAttach).toHaveBeenCalledWith(
      expect.objectContaining({ audioId: "audio-tts-1.wav", slot: "generatedVoice" }),
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/audio/tts-routing.test.ts -t "omnivoice voice uses the server"`
Expected: FAIL — currently `synthesizeForCell` is always called.

- [ ] **Step 3: Add the import**

At the top of `src/lib/audio/generate-voice.ts`, add:

```ts
import { synthesizeCellTts } from "@/lib/sync/tts"
```

- [ ] **Step 4: Add the OmniVoice branch**

In `generateAndAttachCellVoice`, immediately after `const getSyncToken = audioSyncTokenFetcherForSession(args.session)` (currently line 53) and BEFORE `// 1. Multilingual TTS.`, insert:

```ts
  // OmniVoice is server-side: the sync-worker synthesizes, stores the clip in
  // R2 (native voice-cloning when a reference is set), and returns its id —
  // no client synth, no upload, no Seed-VC. Branch out entirely.
  if (voice.provider === "omnivoice") {
    const result = await synthesizeCellTts(
      {
        projectId: args.projectId,
        fileId: args.fileId,
        cellId: args.cellId,
        text,
        ...(args.geminiContext?.targetLanguage ? { language: args.geminiContext.targetLanguage } : {}),
        ...(voice.referenceAudioId ? { referenceAudioId: voice.referenceAudioId } : {}),
      },
      getSyncToken,
    )
    await emitCellAudioAttach({
      projectId: args.projectId,
      fileId: args.fileId,
      cellId: args.cellId,
      audioId: result.objectName,
      url: result.url,
      durationMs: Math.round(result.durationSeconds * 1000),
      slot: "generatedVoice",
      mimeType: "audio/wav",
      voiceId: voice.id,
      ...(voice.referenceAudioId ? { referenceAudioId: voice.referenceAudioId } : {}),
      author: args.username,
    })
    notifyAudioAttachmentsChanged(args.fileId)
    const bytes = await fetchCellAudio({
      projectId: args.projectId,
      fileId: args.fileId,
      audioId: result.audioId,
      ext: "wav",
      getSyncToken,
    })
    return {
      audioId: result.objectName,
      url: result.url,
      blob: new Blob([bytes as BlobPart], { type: "audio/wav" }),
    }
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/audio/tts-routing.test.ts`
Expected: PASS (all routing + guard + precedence tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/audio/generate-voice.ts src/lib/audio/tts-routing.test.ts
git commit -m "feat(tts): route omnivoice cell generation to the server path"
```

---

## Task 5: OmniVoice branch in `generateCombinedVoice`

**Files:**
- Modify: `src/lib/audio/combined-voice.ts`

This mirrors Task 4 for the "voice together" flow. Since OmniVoice is now the default engine, a multi-cell selection with default voices must not fall through to the local Kokoro worker.

- [ ] **Step 1: Add the import**

At the top of `src/lib/audio/combined-voice.ts`, add:

```ts
import { synthesizeCellTts } from "@/lib/sync/tts"
```

- [ ] **Step 2: Branch the synth+store block**

Replace the block from `setAll({ kind: "synthesizing" })` (line ~98) through the end of the `else { ... }` upload branch (line ~142) — i.e. the `try { ... }` body up to and including the line `const objectName = \`${audioId}.${ext}\`` — with this. Keep everything below `const objectName` (the attach loop, `notifyAudioAttachmentsChanged`, `setAll({ kind: "idle" })`, and the `return`) unchanged:

```ts
  setAll({ kind: "synthesizing" })
  try {
    let audioId: string
    let ext: string
    let url: string

    if (voice.provider === "omnivoice") {
      // Server-side: one OmniVoice call for the whole joined clip; the worker
      // stores it (native clone when a reference is set) and returns its id.
      onProgress?.("Synthesizing combined clip…")
      const result = await synthesizeCellTts(
        {
          projectId: project.id,
          fileId,
          cellId: chosen[0].id,
          text: joined,
          ...(project.targetLanguage ? { language: project.targetLanguage } : {}),
          ...(voice.referenceAudioId ? { referenceAudioId: voice.referenceAudioId } : {}),
        },
        getSyncToken,
      )
      audioId = result.audioId
      ext = "wav"
      url = result.url
    } else {
      onProgress?.("Synthesizing combined clip…")
      const ttsBlob = await synthesizeForCell(joined, {
        projectTtsSettings: settings,
        cellVoiceId: voice.id,
        geminiContext: {
          sourceLanguage: project.sourceLanguage,
          targetLanguage: project.targetLanguage,
          original: chosen[0].original,
          context: chosen[0].context,
          cellLabel: chosen[0].cellLabel,
        },
        onProgress: (p) => setAll(
          p.status === "ready" || (p.total > 0 && p.loaded >= p.total)
            ? { kind: "synthesizing" }
            : { kind: "loading", loaded: p.loaded, total: p.total, file: p.file },
        ),
      })

      if (voice.referenceAudioId) {
        onProgress?.("Applying voice clone…")
        const conv = await convertToCloneVoice({
          projectId: project.id,
          fileId,
          referenceAudioId: voice.referenceAudioId,
          source: ttsBlob,
          getSyncToken,
        })
        audioId = conv.audioId
        ext = conv.ext
        url = conv.url
        await fetchCellAudio({ projectId: project.id, fileId, audioId: conv.audioId, ext: conv.ext, getSyncToken })
      } else {
        const baseId = buildAudioId(chosen[0].id)
        ext = "wav"
        const res = await uploadCellAudio({ projectId: project.id, fileId, audioId: baseId, ext, blob: ttsBlob, getSyncToken })
        audioId = res.audioId
        url = res.url
      }
    }
    const objectName = `${audioId}.${ext}`
```

- [ ] **Step 3: Typecheck + run the audio suite**

Run: `pnpm exec tsc -b --noEmit && pnpm exec vitest run src/lib/audio`
Expected: PASS (no behavior change for non-omnivoice; omnivoice no longer falls through).

- [ ] **Step 4: Commit**

```bash
git add src/lib/audio/combined-voice.ts
git commit -m "feat(tts): route omnivoice voice-together to the server path"
```

---

## Task 6: CharacterModal — grouped picker, base-voice hiding, clone-gating, OmniVoice preview

**Files:**
- Modify: `src/components/voice/CharacterModal.tsx`

- [ ] **Step 1: Add imports**

Add `providerInfo` to the existing `tts-providers` import (line ~46-48) and add a `synthesizeCellTts` import:

```ts
import {
  normalizeVoiceForProvider, defaultVoiceNameForProvider, providerInfo, TTS_PROVIDER_INFOS,
} from "@/lib/audio/tts-providers"
import { synthesizeCellTts } from "@/lib/sync/tts"
```

- [ ] **Step 2: Derive the active engine's capabilities**

After `const activeProvider = draft.provider ?? provider` (line ~156), add:

```ts
  const activeInfo = providerInfo(activeProvider)
```

- [ ] **Step 3: Replace the Engine picker block**

Replace the Engine `<div className="space-y-2">...</div>` block (lines ~304-328) with a grouped Cloud/On-device layout. Each button shows the short title, blurb, and caveat:

```tsx
          {/* Engine — per-voice. Cloud engines first; on-device demoted below.
              Switching resets the base voice to that engine's default. */}
          <div className="space-y-2">
            <Label>Engine</Label>
            {(["cloud", "device"] as const).map((tier) => (
              <div key={tier} className="space-y-1.5">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {tier === "cloud" ? "Cloud" : "On-device"}
                </p>
                <div className="grid grid-cols-2 gap-1.5">
                  {TTS_PROVIDER_INFOS.filter((info) => info.tier === tier).map((info) => (
                    <button
                      key={info.id}
                      type="button"
                      onClick={() => update({
                        provider: info.id,
                        voiceName: defaultVoiceNameForProvider(info.id, { targetLanguage }),
                      })}
                      aria-pressed={activeProvider === info.id}
                      className={cn(
                        "rounded-lg border px-2.5 py-2 text-left transition-colors",
                        activeProvider === info.id ? "border-primary bg-primary/10" : "hover:bg-accent/40",
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium">{info.shortTitle ?? info.title}</span>
                        {info.badge && (
                          <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                            {info.badge}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{info.blurb}</p>
                      {info.caveat && (
                        <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground/70">{info.caveat}</p>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
```

- [ ] **Step 4: Hide the base-voice section for OmniVoice**

Wrap the Base voice block (lines ~330-339) so it only renders when the engine has named voices; otherwise show a one-line explainer:

```tsx
          {/* Base voice — driven by the draft's engine. OmniVoice has no named
              voices (its timbre comes from the optional clone below). */}
          {activeInfo.hasNamedVoices ? (
            <div className="space-y-2">
              <Label>Base voice</Label>
              <PresetPicker
                isGemini={isGemini}
                isMms={isMms}
                value={effectiveVoice.voiceName ?? ""}
                onChange={(v) => update({ voiceName: v || undefined })}
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              OmniVoice uses a single neural voice. Add a reference recording below to
              clone a specific person.
            </p>
          )}
```

- [ ] **Step 5: Gate the clone section by capability**

The clone layer block (lines ~360-445) currently always renders. Wrap its INNER content so that when `!activeInfo.supportsCloning` it shows a disabled note instead of the controls. Replace the inner content after the header `<div className="space-y-1">...</div>` (i.e. the `<VoiceCloneSection .../>` and the `{takes.length > 0 && (...)}` details) with a conditional:

```tsx
            {activeInfo.supportsCloning ? (
              <>
                {/* Priority: record a segment or upload an audio file. */}
                <VoiceCloneSection
                  voice={draft}
                  projectId={projectId}
                  fileId={fileId}
                  session={session}
                  onChange={update}
                />

                {/* Secondary, collapsed: reuse audio already in the project. */}
                {takes.length > 0 && (
                  <details open={seededTakePresent} className="rounded-lg border bg-muted/10">
                    {/* ...existing details content UNCHANGED... */}
                  </details>
                )}
              </>
            ) : (
              <p className="rounded-lg border border-dashed bg-muted/20 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
                On-device voices (Kokoro, MMS) don't support voice cloning. Switch to
                OmniVoice or Gemini to clone a specific person.
              </p>
            )}
```

Keep the existing `<details>...</details>` body verbatim inside the `<>` fragment — only the wrapping conditional is new. Leave the header (`Clone a voice (optional)` label + `Cloned` badge + the descriptive `<p>`) above this conditional as-is.

- [ ] **Step 6: Branch `handlePreview` for OmniVoice**

In `handlePreview` (lines ~187-214), add an OmniVoice branch at the top of the `try` (after `setPreview({ kind: "loading" })`). It synthesizes one sample clip server-side and plays it. Replace the gemini-key guard + `try` opening with:

```tsx
    if (activeProvider === "gemini" && !apiKey.trim()) {
      setPreview({ kind: "error", message: "Add a Gemini API key to test voices." })
      return
    }
    if (activeProvider === "omnivoice" && (!projectId || !fileId || !session?.jwt)) {
      setPreview({ kind: "error", message: "Open a project file to preview OmniVoice." })
      return
    }
    setPreview({ kind: "loading" })
    try {
      let blob: Blob
      if (activeProvider === "omnivoice") {
        const getSyncToken = audioSyncTokenFetcherForSession(session ?? null)
        const result = await synthesizeCellTts(
          {
            projectId: projectId!,
            fileId: fileId!,
            text: SAMPLE_TEXT,
            ...(targetLanguage ? { language: targetLanguage } : {}),
            ...(draft.referenceAudioId ? { referenceAudioId: draft.referenceAudioId } : {}),
          },
          getSyncToken,
        )
        const bytes = await fetchCellAudio({
          projectId: projectId!, fileId: fileId!, audioId: result.audioId, ext: "wav", getSyncToken,
        })
        blob = new Blob([bytes as BlobPart], { type: "audio/wav" })
      } else {
        blob = await synthesizeToWavBlob(SAMPLE_TEXT, {
          voice: effectiveVoice,
          projectProvider: activeProvider,
          apiKey,
          geminiContext: { targetLanguage },
        })
      }
      const url = URL.createObjectURL(blob)
      // ...rest of the existing play logic UNCHANGED (previewUrlRef, new Audio, etc.)...
```

Update the `useCallback` dependency array for `handlePreview` to include `projectId`, `fileId`, `session`, and `draft.referenceAudioId`.

- [ ] **Step 7: Typecheck**

Run: `pnpm exec tsc -b --noEmit`
Expected: PASS. (`fileId` is `string | null | undefined`; the `!`-assertions are guarded by the early-return checks above.)

- [ ] **Step 8: Manual smoke in the running app — deferred to Task 10.** Mark this step done now; the real UI check happens in the verification task.

- [ ] **Step 9: Commit**

```bash
git add src/components/voice/CharacterModal.tsx
git commit -m "feat(tts): 4-engine grouped picker with clone-gating + omnivoice preview"
```

---

## Task 7: CellTtsButton — voice-first provider, gate model-download UI to local engines

**Files:**
- Modify: `src/components/CellTtsButton.tsx:110-113`, `:261`

- [ ] **Step 1: Make provider voice-first**

Replace lines ~110-113:

```tsx
  const baseVoice = resolveVoice(projectTtsSettings, cellTtsSettings?.voiceId)
  const provider = baseVoice.provider ?? resolveTtsProvider(projectTtsSettings)
  const voice = normalizeVoiceForProvider(baseVoice, provider, { targetLanguage })
  const modelStatus = useModelStatus(provider === "mms" ? "mms" : "kokoro")
```

- [ ] **Step 2: Gate the model-download indicator to local engines**

Replace line ~261 (`const downloadingModel = ...`):

```tsx
  const isLocalModel = provider === "mms" || provider === "kokoro"
  const downloadingModel = !playableAttachId && isLocalModel && modelStatus.kind === "downloading" && status.kind !== "idle"
```

This stops OmniVoice/Gemini (neither has a local model) from ever showing a "Downloading voice model" state.

- [ ] **Step 3: Typecheck + run any CellTtsButton tests**

Run: `pnpm exec tsc -b --noEmit && pnpm exec vitest run src/components 2>/dev/null || true`
Expected: tsc PASS; component tests (if any) green.

- [ ] **Step 4: Commit**

```bash
git add src/components/CellTtsButton.tsx
git commit -m "fix(tts): CellTtsButton honors per-voice engine, hides local-model UI for cloud"
```

---

## Task 8: Verify cast roster label includes OmniVoice

**Files:**
- Read: `src/components/VoiceLibraryPanel.tsx` (the `engineLabel` helper, ~line 65)

- [ ] **Step 1: Inspect `engineLabel`**

Run: `grep -n "engineLabel\|TTS_PROVIDER_INFOS\|shortTitle\|\.title" src/components/VoiceLibraryPanel.tsx`
Expected: `engineLabel` looks up `TTS_PROVIDER_INFOS` by id and returns a title/shortTitle.

- [ ] **Step 2: Decide**

- If `engineLabel` derives purely from `TTS_PROVIDER_INFOS` (find by id), it already returns "OmniVoice" — **no code change**. Mark this task complete.
- If it has a hardcoded `switch`/map over the three old providers, add an `omnivoice` case returning `"OmniVoice"`, then commit:

```bash
git add src/components/VoiceLibraryPanel.tsx
git commit -m "feat(tts): show OmniVoice label in the cast roster"
```

---

## Task 9: Remove the OmniVoice rail button from EditorTable

**Files:**
- Modify: `src/components/EditorTable.tsx` (state ~1852-1854, handler ~2251-2298, button ~3269-3300, imports)

- [ ] **Step 1: Remove the state**

Delete lines ~1852-1854:

```ts
  // OmniVoice TTS generation state for the "Generate audio" rail button.
  const [omniTtsLoading, setOmniTtsLoading] = useState(false)
  const [omniTtsError, setOmniTtsError] = useState<string | null>(null)
```

- [ ] **Step 2: Remove the handler**

Delete the entire `handleOmniTts` block including its leading doc comment (lines ~2251-2298, from `/**` describing "OmniVoice TTS (use case 1)" through the closing `}, [...])`).

- [ ] **Step 3: Remove the rail button**

Delete the rail button JSX block (lines ~3269-3300, the `{/* OmniVoice TTS: ... */}` comment through the closing `)}` of that conditional).

- [ ] **Step 4: Remove now-unused imports**

Run: `pnpm exec tsc -b --noEmit && pnpm exec eslint src/components/EditorTable.tsx`
Expected: errors/warnings for unused symbols. Remove each that is genuinely unused **only after confirming with grep it has no other use in the file**:

```bash
grep -n "synthesizeCellTts\|AudioLines\|audioSyncTokenFetcherForSession\|emitCellAudioAttach\|notifyAudioAttachmentsChanged\|\bSpinner\b\|AlertCircle" src/components/EditorTable.tsx
```

Remove `synthesizeCellTts` (line ~67) and the `AudioLines` icon import if they have no remaining references. Keep `Spinner`, `AlertCircle`, `emitCellAudioAttach`, `notifyAudioAttachmentsChanged`, `audioSyncTokenFetcherForSession` if any other code in the file still uses them (they likely do).

- [ ] **Step 5: Typecheck + lint clean**

Run: `pnpm exec tsc -b --noEmit && pnpm exec eslint src/components/EditorTable.tsx`
Expected: PASS, no unused-symbol warnings.

- [ ] **Step 6: Commit**

```bash
git add src/components/EditorTable.tsx
git commit -m "feat(tts): remove standalone OmniVoice rail button (generation is provider-driven)"
```

---

## Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full unit suite**

Run: `pnpm test`
Expected: PASS (entire Vitest suite green, including `sync-worker` tts tests if covered by the root run; otherwise run `pnpm --dir sync-worker test`).

- [ ] **Step 2: Typecheck + production build**

Run: `pnpm build`
Expected: `tsc -b` clean, `vite build` succeeds, brand-build check passes.

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: no new errors.

- [ ] **Step 4: UI walkthrough (use the `verify-dev-change` skill / dev stack in this worktree).** Drive the real app as the seeded dev user:
  1. Open a project with translated cells, enter **audio mode**.
  2. Open the cast → **Craft character**: confirm the picker shows **Cloud (OmniVoice, Gemini)** above **On-device (Kokoro, MMS)**, each with a blurb/caveat, OmniVoice badged "Recommended".
  3. Select **OmniVoice**: base-voice list is hidden; the clone section is enabled.
  4. Select **MMS** (or Kokoro): clone section shows "On-device voices … don't support voice cloning."; base voice (language) reappears.
  5. Assign an OmniVoice voice to a cell and generate via the per-cell control → audio attaches and plays.
  6. Confirm the old **"Generate audio (OmniVoice)"** rail button is gone.
  - Per memory, agent model/TTS calls may 500 without server keys (OmniVoice Modal + budget). If OmniVoice synthesis can't run headlessly in dev, verify the UI state transitions (picker grouping, clone-gating, button removal) and flag live OmniVoice synthesis for manual confirmation rather than claiming it passed.

- [ ] **Step 5: Finalize**

Use `superpowers:finishing-a-development-branch` to merge/PR. Commit the spec + plan docs alongside:

```bash
git add docs/superpowers/specs/2026-06-17-tts-provider-unification-design.md docs/superpowers/plans/2026-06-17-tts-provider-unification.md
git commit -m "docs(tts): provider unification spec + plan"
```

---

## Self-Review notes

- **Spec coverage:** registry+default (T2), OmniVoice voice config / no named voices (T2, T6), clone-gating to cloud (T6), OmniVoice generation path (T4, T5), rail-button removal (T9), engine cards copy (T2/T6), voice-first precedence (T3). All spec sections map to a task.
- **Out of scope (per spec):** onboarding `AiModelsStep` and `LocalModelsSection` untouched — confirmed not in any task.
- **Type consistency:** `supportsCloning` / `hasNamedVoices` / `tier` / `blurb` / `caveat` used identically in T2 (definition) and T6 (consumption); `providerInfo()` and `TTS_PROVIDER_INFOS` are the single source.
- **Known follow-ups:** OmniVoice preview in CharacterModal is metered (one real synth per click); combined-voice OmniVoice path uses the first cell's id for the shared clip key, matching the existing combined behavior.
