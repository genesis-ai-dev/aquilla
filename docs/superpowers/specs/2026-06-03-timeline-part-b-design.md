# Timeline Part B — Silence-Split + Diarization (Design + Plan)

**Date:** 2026-06-03
**Status:** In progress (autonomous; pre-authorized). Some decisions flagged for user.
**Builds on:** Scope A (`2026-06-02-timeline-segment-model-design.md`), branch
`feat/timeline-segment-model`.

## Goal

So subtitles and real dialog audio can coexist in one project (for *The
Chosen*): when you import an audio/video file, instead of ONE media segment
spanning the whole file (Scope A 5b), split it into MANY media segments at
silences, so each spoken line becomes its own timed `medium:'media'` cell —
and (ideally) label who is speaking (diarization → cast).

## Decisions

1. **Silence-split runs client-side, on import.** Reuse the Web Audio API
   (`AudioContext.decodeAudioData`) already available in the browser; no new
   server dependency. Amplitude/RMS-threshold segmentation: find runs of
   "speech" (RMS above a noise floor) separated by silent gaps ≥ a min
   duration. Each speech run → one media segment (`startMs`/`endMs`).
2. **Pure core, thin integration.** The detector is a pure function over PCM
   samples (`detectSpeechSegments`) — fully unit-testable with synthetic
   signals. `emitMediaFile` decodes the file, calls it, and emits N segments
   (chained, `sequenceIndex` 0..n, each `medium:'media'`). The whole clip is
   still uploaded once to R2; each segment references the same clip with a
   trim window (`trimStartMs`/`trimEndMs`) — no re-encoding/splitting of bytes.
3. **Graceful fallback.** If decode fails, or the detector finds ≤1 region,
   fall back to Scope A's single whole-file segment. Never block import on the
   DSP. Tiny/short files → single segment.
4. **No fake timing.** Segment boundaries come from real detected energy; if
   detection is impossible the segment is whole-file (timed) — we never invent
   per-line boundaries.

## Open questions (flagged for user — NOT guessed)

- **Diarization** ("who is speaking" → auto-cast). Real diarization needs an ML
  model (e.g. pyannote / a hosted speaker-embedding + clustering service).
  That is server/model infrastructure this repo doesn't have and I won't
  fabricate. **Plan:** ship silence-split now; define a clean seam
  (`SpeakerLabeler` interface returning a speaker tag per segment) that a
  future model-backed worker can fill. Until then segments are unlabeled
  (no cast assignment). Needs a user decision on which model/service.
- **Threshold defaults** (noise floor, min-silence, min-segment). Start with
  conservative defaults (see plan); expose as options. May need tuning against
  real *The Chosen* audio — flag for user testing.
- **Where to run for large files.** Decoding a 40-min episode in the browser
  is heavy. Acceptable for first cut; a worker/streaming approach is a later
  optimization.

## Plan

### B1 — Pure silence-split core  ✅
- [x] `src/lib/timeline/silence-split.ts`: `detectSpeechSegments(channel, sampleRate, opts?)` → `{startMs,endMs}[]`. RMS-windowed classification; merge gaps < minSilenceMs; drop < minSegmentMs; pad + clamp disjoint. Pure/deterministic.
- [x] 7 unit tests (tone bursts, all-silence, all-speech, short gap, sub-min blip, padding-overlap clamp).

### B2 — Wire into audio import  ✅ (verified in running app)
- [x] `emitMediaFile` decodes via AudioContext + `detectSpeechSegments`; ≥2 regions → N chained media cells, each timed + attaching the shared clip with `trimStartMs/trimEndMs` (bytes uploaded once); decode-fail / ≤1 region → single whole-file segment. `decodeAudioFile` returns null when undecodable.
- [x] Verified: a 2-burst WAV imported as exactly **2** media segments in the Media layer; time-ordered; console clean (benign font 403 only).

### B3 — Diarization (DECIDED: sherpa-onnx WASM, quality path)

**Engine:** `sherpa-onnx` WebAssembly (Apache-2.0). Models baked into the wasm
`.data`: pyannote/segmentation-3.0 (MIT) + a 3D-Speaker/WeSpeaker embedding
(Apache-2.0 / CC-BY-4.0 — commercial OK; attribution line for CC-BY). Runs
fully client-side, no server.

**JS API (from the official wasm example):**
```js
const sd = createOfflineSpeakerDiarization(Module)   // Module = emscripten wasm module
sd.setConfig({ clustering: { numClusters: -1, threshold: 0.5 } }) // -1 = auto-detect count
const segments = sd.process(float32Mono16k)          // → [{ start, end, speaker }] (sec, int)
```
Input MUST be **16 kHz mono Float32**. Use the **non-threaded SIMD** build (no
COOP/COEP headers needed).

**Architecture — opt-in quality path; RMS splitter stays the instant default.**
- B3a **Pure resampler** — `resampleToMono16k(channel, sampleRate)` → Float32Array. Linear interpolation. Unit-tested.
- B3b **Pure mapping** — `turnsToSegments(turns)` → media-cell specs (one per turn, `medium:'media'`, timing, trim window) + distinct speaker set for cast. Unit-tested.
- B3c **WASM worker** — load sherpa-onnx wasm in a Web Worker; `diarize(pcm16k) → turns`. Lazy-loaded.
- B3d **Asset hosting** — DECIDED: **self-host in R2** (Frontier R&D account `6a80496d1e59948a9cbaa3c643ba81d7`; confirm exact bucket before upload). Lazy-fetch the wasm bundle (`.js`/`.wasm`/`.data`, tens of MB) from R2 on first use, cache via Cache Storage. Never bundle into the main JS. Build/prove the loader locally first (bundle in `public/`, gitignored), upload to R2 once it works.
- B3e **Import integration** — opt-in setting "Diarize on import". When on + decode succeeds: run diarization → `turnsToSegments` → media cells labeled by speaker; map speakers → cast members (create "Speaker 1..N", assign per cell). Falls back to RMS split if diarization unavailable/fails.
- B3f **Verify** in running app with a 2-speaker clip → expect N labeled segments + N cast members.

#### B3c verification findings (2026-06-03, headless Chromium)
The loader works END-TO-END: 55 MB wasm + baked-in models load, `diarize()`
runs in ~2.7 s on a 13 s clip and returns `{start,end,speaker}` turns. BUT two
blockers for the quality path surfaced:

1. **Cross-origin isolation is REQUIRED.** The wasm uses threads /
   SharedArrayBuffer → the page must send `COOP: same-origin` +
   `COEP: require-corp` (else: "SharedArrayBuffer transfer requires
   self.crossOriginIsolated", hang). This is **app-wide invasive** (COEP blocks
   cross-origin subresources lacking CORP — images, fonts, embeds, the R2 audio
   itself would each need CORP headers). NOT committed app-wide; needs a
   decision. Mitigation options: serve diarization in an isolated context
   (dedicated COI iframe/popup or a COI worker scope) instead of the whole app.
2. **Stock embedding model is Chinese (`speech_eres2net…zh-cn`) → cannot
   separate English speakers.** A clean 2-voice English clip (macOS Alex +
   Samantha) returned **1 speaker** at thresholds 0.5/0.3/0.2; forced
   `numClusters:2` split at the wrong boundary (9.97 s vs true ~6.5 s). The
   prebuilt sherpa-onnx diarization wasm bakes this model into `.data`, so
   usable English quality requires **rebuilding the wasm with an English /
   multilingual embedding model** (e.g. WeSpeaker VoxCeleb resnet34 — CC-BY-4.0,
   or 3D-Speaker CAM++ en — Apache-2.0). This is the gating follow-up before
   B3e import+cast wiring is worth doing.

**Status:** B3a/B3b/B3c code is sound + committed (loader provably loads &
runs). B3d/B3e/B3f are **paused** pending two decisions: (a) how to scope COI
(app-wide vs isolated context), (b) rebuild the wasm with an English embedding
model. Diarization is NOT yet wired into import — the loader is dormant until
called, so merging the committed code changes no user-facing behavior.

Caveat: diarizing a full episode in-browser is heavy → Worker + (later) chunking. CC-BY embedding model needs a one-line attribution on a licenses page.

### Deferred (later phases)
- Waveform snap-and-stretch (the "dream feature").
- Combined three-track view (source audio / target audio / transcription).
- Per-line camera-state + transcription EDITING (create-time only today).
