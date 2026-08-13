import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import { VOICE_PALETTE, getVoiceLibrary } from "@/lib/audio/voices"

export interface SpeakerAssignment {
  cellId: string
  speaker: string | undefined
}

export interface CastAdditions {
  /** Full voice library to persist (existing + newly created). */
  voices: Voice[]
  /** cellId → voiceId for every cue that had a speaker. */
  castAssignments: Record<string, string>
}

/** Labels that are structurally identifiers, never a person's name: bare
 *  numbers and timecodes ("12", "00:01:23,456"), positional labels
 *  ("clip 3", "segment_12"), and media/subtitle filenames. */
const NON_SPEAKER_LABEL: readonly RegExp[] = [
  /^\d+([.,:]\d+)*$/,
  /^(clip|cue|segment|section|cell|line|track|part|chunk|take|item|row)[\s_-]*\d+$/i,
  /\.(wav|mp3|m4a|aac|ogg|opus|flac|webm|mp4|mov|mkv|vtt|srt|txt|json)$/i,
]

/** A label set this large is a big enough sample to judge whether it repeats. */
const MIN_LABELS_TO_JUDGE_REPETITION = 4

function isSpeakerName(label: string): boolean {
  return !NON_SPEAKER_LABEL.some((re) => re.test(label))
}

/**
 * AQU-813: keep only (cellId, speaker) pairs that plausibly describe a **cast**,
 * dropping per-clip identifiers that would otherwise become phantom voices.
 *
 * Legacy Codex reuses one `cellLabel` field both for a character name and for a
 * per-cell identifier, so importing a project whose audio carries no voice
 * labels used to mint one Voice per clip — a single speaker showing up as dozens
 * of "voices". Two guards, applied to the whole import's labels at once:
 *
 *   1. drop labels that can't be a name (see `NON_SPEAKER_LABEL`);
 *   2. drop the *entire* set when its names barely repeat — a cast is a small
 *      set of names recurring across many lines, so more distinct labels than
 *      half the labelled cells means it's an identifier column, not a cast.
 *
 * Small sets (< `MIN_LABELS_TO_JUDGE_REPETITION`) skip guard 2 — too little
 * signal to call it either way, and a genuine two-hander would fail it.
 * Label-less audio then imports as one default voice rather than N fabricated
 * ones. Explicit voice metadata (VTT `<v Name>`, a spreadsheet cast column,
 * diarization's own "Speaker N") never routes through here.
 */
export function castLikeSpeakers(pairs: readonly SpeakerAssignment[]): SpeakerAssignment[] {
  const named: SpeakerAssignment[] = []
  for (const p of pairs) {
    const name = p.speaker?.trim()
    if (!name || !isSpeakerName(name)) continue
    named.push({ cellId: p.cellId, speaker: name })
  }
  const distinct = new Set(named.map((p) => p.speaker)).size
  if (named.length >= MIN_LABELS_TO_JUDGE_REPETITION && distinct * 2 > named.length) return []
  return named
}

/**
 * Given parsed (cellId, speaker) pairs and the current settings, mint one Voice
 * per *new* distinct speaker name (case-sensitive, trimmed) and build the
 * cellId→voiceId assignment map. Names already in the cast are reused. `mintId`
 * is injected for testability (production passes uuidv7).
 *
 * Seeds the voice list from `getVoiceLibrary(settings)` so that a project that
 * has never opened Voice Studio still starts with the built-in Narrator preset
 * as library[0] / default. Custom libraries are reused as-is.
 */
export function buildCastAdditions(
  pairs: SpeakerAssignment[],
  settings: ProjectTtsSettings | undefined,
  mintId: () => string,
): CastAdditions {
  const voices: Voice[] = [...getVoiceLibrary(settings)]
  const byName = new Map<string, string>() // name → voiceId
  for (const v of voices) byName.set(v.name, v.id)

  const castAssignments: Record<string, string> = {}
  for (const { cellId, speaker } of pairs) {
    const name = speaker?.trim()
    if (!name) continue
    let voiceId = byName.get(name)
    if (!voiceId) {
      voiceId = mintId()
      const color = VOICE_PALETTE[voices.length % VOICE_PALETTE.length]
      voices.push({ id: voiceId, name, color })
      byName.set(name, voiceId)
    }
    castAssignments[cellId] = voiceId
  }
  return { voices, castAssignments }
}
