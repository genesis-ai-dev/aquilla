// AQU-1758: a take's voice, when it is not the line's.
//
// Picking a voice for a line only assigns it, so a generated take can outlive
// the voice it was made in: the line now reads "Naomi" while its take is still
// the Narrator. The Audio view's card named the take's voice in that case; with
// the card gone, the take's clip on the timeline does. A recording carries no
// voice of its own, and takes from before takes carried their voice have none
// to compare, so both say nothing.
//
// Pure; the timeline asks it for each clip it draws.

import { findVoice, resolveCastVoice } from "@/lib/audio/voices"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

export interface TakeVoiceNote {
  /** The voice the take was made in, or null when that voice has since been
   *  removed from the project. */
  takeVoiceName: string | null
  /** The voice the line is cast to now. */
  lineVoiceName: string
}

/** What to say about the take `audioId` on `cell`, or null when its voice is
 *  the line's (or it has none to compare). */
export function takeVoiceNote(
  cell: CellData,
  audioId: string,
  settings: ProjectTtsSettings | undefined,
): TakeVoiceNote | null {
  const takeVoiceId = cell.attachments?.[audioId]?.voiceId
  if (!takeVoiceId) return null
  const line = resolveCastVoice(settings, cell, cell.ttsSettings?.voiceId)
  if (takeVoiceId === line.id) return null
  return { takeVoiceName: findVoice(settings, takeVoiceId)?.name ?? null, lineVoiceName: line.name }
}
