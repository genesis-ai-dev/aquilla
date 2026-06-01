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
