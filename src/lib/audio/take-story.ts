// How a take came to be (AQU-2577), read off what the take itself records.
//
// A take is one of three things, and the clip inspector says which:
//   recorded   a person recorded it
//   spoken     a voice read the line's text (text to speech)
//   revoiced   an earlier take — recorded or spoken — was changed into a
//              character's voice (speech to speech)
//
// Nothing extra is stored for this. A voice-changed take keeps its source in
// `referenceAudioId` and is named by its id (change-voice.ts); a spoken take
// carries the voice that read it in `voiceId`.

import { isVoiceChangedAudioId, originalTakeId } from "./change-voice"
import { findVoice } from "./voices"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

export interface TakeStory {
  kind: "recorded" | "spoken" | "revoiced"
  /** The voice that read the text. Null when a person's recording is underneath, or the voice is gone. */
  reader: Voice | null
  /** The voice the take was changed into. Null unless `revoiced`, or the voice is gone. */
  character: Voice | null
  /** Who recorded the take underneath, when a person did. */
  recordedBy: string | null
}

export function takeStory(cell: CellData, audioId: string, settings: ProjectTtsSettings | undefined): TakeStory | null {
  const attachments = cell.attachments
  const att = attachments?.[audioId]
  if (!attachments || !att) return null
  if (isVoiceChangedAudioId(audioId)) {
    const source = attachments[originalTakeId(attachments, audioId)]
    const sourceIsTake = source && source !== att
    return {
      kind: "revoiced",
      reader: sourceIsTake ? findVoice(settings, source.voiceId) ?? null : null,
      character: findVoice(settings, att.voiceId) ?? null,
      recordedBy: sourceIsTake && !source.voiceId ? source.recordedBy ?? null : null,
    }
  }
  if (att.voiceId) return { kind: "spoken", reader: findVoice(settings, att.voiceId) ?? null, character: null, recordedBy: null }
  return { kind: "recorded", reader: null, character: null, recordedBy: att.recordedBy ?? null }
}
