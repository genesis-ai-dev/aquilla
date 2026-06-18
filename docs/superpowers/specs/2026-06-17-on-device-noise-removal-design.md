# On-device noise removal (RNNoise) — design

Date: 2026-06-17 · Status: implementing

## Goal

Let a translator strip background noise from a recorded cell take, entirely
on-device, without losing the original audio. A "Remove noise" affordance in
the audio mode animates while it works, then shows it has been applied to the
cell. The cleaned audio is a new *take* alongside the original (multiple-takes
affordance we already have), and the user can revert to the original.

## Decisions (locked with user)

- **Library:** `@sapphi-red/web-noise-suppressor` (0.3.5) — packaged RNNoise
  AudioWorklet + bundled `.wasm`. `RnnoiseWorkletNode` requires a *live* 48 kHz
  `AudioContext` ("Assumes sample rate to be 48kHz") — OfflineAudioContext is
  not supported, which is why processing is real-time.
- **Output encoding:** WebM/Opus via `MediaRecorder` (matches existing
  recordings; small files). Processing runs ~clip-length — fine for verse cells.
- **Active take after denoise:** auto-select the cleaned take. Original stays
  in the takes strip.
- **Placement:** both — an inline button in the cell audio tab and a per-take
  button in the takes strip.
- **Icon:** lucide has no `chicken`; use `Bird` as the (whimsical) stand-in.
- **Cleaned takes pinned above originals** in the takes strip; a **revert**
  button switches the active clip back to the original.

## Mechanism

Denoise = produce a *new take* from the selected recording. No bytes are
mutated. Falls out of the existing `cell.audio.attach` grammar (attach records a
clip *and* selects it in its slot → `selected = 1` in the projection).

Pipeline (`src/lib/audio/denoise.ts`, browser-only, verified via UI not units):
1. `fetchCellAudio` → bytes of the selected recording.
2. `decodeToMono48k` (existing) → Float32 mono @ 48 kHz (RNNoise's native rate).
3. Real-time render: `AudioBufferSource → RnnoiseWorkletNode →
   MediaStreamAudioDestinationNode`, captured by `MediaRecorder` → WebM/Opus.
   wasm + worklet loaded via Vite `?url` imports, wasm cached as a singleton.
   No SharedArrayBuffer / COOP-COEP headers required.
4. `uploadCellAudio` → R2, then `emitCellAudioAttach({ slot: "recording" })`
   (auto-selects) + `injectOptimisticAudioAttachment` + `notifyAudioAttachmentsChanged`.

## Identity & revert linkage

- **Marker:** denoised takes get id `dn-<buildAudioId(...)>` →
  `isDenoisedAudioId(id) === id.startsWith("dn-")`. Pure client-side, self-
  describing, syncs for free — no projection/read-type/schema change.
- **Revert:** the denoised attach stores `referenceAudioId = <source take id>`
  (existing field, round-trips through projection + read). Revert =
  `emitCellAudioSelect({ audioId: referenceAudioId, slot: "recording" })`. If
  the source was deleted, revert is hidden/disabled.

## UI

`useDenoiseTake` orchestrator shared by both placements.

- **Inline** (`components/audio/DenoiseButton.tsx`, audio tab next to
  Re-record/Transcribe):
  - selected take is an original → "Remove noise" (Bird), actionable.
  - processing → animated "Removing noise…" (mirrors Transcribe's `animate-pulse`).
  - selected take is `dn-` → static emerald "Noise removed ✓" + "Revert".
  - hidden unless the recording slot has audio; disabled offline / no session.
- **Takes strip** (`AudioRecorder/TakesStrip.tsx`):
  - denoised takes sorted first ("Cleaned" label + Bird badge); originals keep
    "Take N" numbering among themselves.
  - per-take Bird button on originals → clean that specific take.
  - cleaned take card shows a revert (return-to-original) affordance.

## Edge cases

No recording-slot audio → affordance hidden. Already-denoised selected take →
applied state (no re-denoise). Worklet/wasm load or render failure → catch,
revert to idle, surface error. Offline / no jwt → disabled with tooltip.

## Testing

- Unit: `isDenoisedAudioId` / `buildDenoisedAudioId`; TakesStrip cleaned-first
  ordering + numbering.
- UI walkthrough (browser): record → Remove noise → button animates → cleaned
  take auto-selected and pinned on top → original still present → playback →
  revert returns to original.
