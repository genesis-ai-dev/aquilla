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

### B3 — Diarization seam  ⏸ pending user decision
- Deliberately NOT scaffolded yet (YAGNI — an unused interface is speculative). Real diarization needs an ML model/service (pyannote / hosted speaker-embedding + clustering) that this repo lacks. **Needs user decision on model/service** before building. Until then, split segments are unlabeled (no auto-cast).

### Deferred (later phases)
- Waveform snap-and-stretch (the "dream feature").
- Combined three-track view (source audio / target audio / transcription).
- Per-line camera-state + transcription EDITING (create-time only today).
