// Saving a transcript: a human correction, or an AI cleanup.
//
// One path for both, so the rules that keep a transcript usable hold for each:
// word timings are remapped onto the new words (remapTranscriptTimings), the
// partial cell.audio.attach echoes the clip's own fields back, and a source
// segment's text also lands on the cell's `transcription`. The differences:
//   - a human correction teaches the project's learned word fixes (AQU-463);
//     an AI cleanup does not — the model must not learn from itself;
//   - an AI cleanup carries `transcriptAi`, the "Cleaned up" mark. A save
//     without it clears the mark on the server (migration 0186).

import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment, WordTiming } from "@/lib/codex-editor/types"
import { remapTranscriptTimings } from "@/lib/audio/correct-transcript"
import { isSourceSegmentSelected } from "@/lib/audio/batch-audio"
import { learnFromTranscriptCorrection } from "@/lib/store/transcript-corrections-store"
import { emitCellAudioAttach } from "@/lib/sync/events-emit"

export interface TranscriptSaveArgs {
  projectId: string
  owner: CellData
  audioId: string
  attachment: CodexCellAttachment
  /** The transcript's current word timings. */
  timings: readonly WordTiming[]
  text: string
  targetLang?: string
  author: string
  /** Set for an AI cleanup; absent for a human correction. */
  ai?: { model: string; at: number; changes: number }
}

/** Queues the save. Resolves once the attach is in the outbox; returns false
 *  when there is nothing to save onto (no timings, no clip url). */
export async function saveTranscript(args: TranscriptSaveArgs): Promise<boolean> {
  const { owner, attachment, audioId, timings, text } = args
  if (timings.length === 0 || !attachment.url) return false
  const nextTimings = remapTranscriptTimings(timings as WordTiming[], text)
  if (nextTimings.length === 0) return false

  if (!args.ai) {
    // AQU-463: best-effort and non-blocking — the correction is committed
    // below whatever happens here.
    try {
      learnFromTranscriptCorrection(args.projectId, timings.map((t) => t.word).join(" "), text)
    } catch (err) {
      console.warn("[transcript] learning from correction failed:", err)
    }
  }

  await emitCellAudioAttach({
    projectId: args.projectId,
    fileId: owner.fileId,
    cellId: owner.id,
    audioId,
    url: attachment.url,
    // AQU-646: the clip's own slot, inferred only when it is absent (a
    // hand-built stub). This attach assigns `slot` outright and deselects
    // the clip's siblings in that slot, so guessing it moves the take.
    slot: attachment.slot ?? (audioId === owner.selectedGeneratedVoiceAudioId ? "generatedVoice" : "recording"),
    timings: nextTimings,
    ...(attachment.durationMs != null ? { durationMs: attachment.durationMs } : {}),
    ...(attachment.voiceId ? { voiceId: attachment.voiceId } : {}),
    ...(attachment.referenceAudioId ? { referenceAudioId: attachment.referenceAudioId } : {}),
    ...(isSourceSegmentSelected(owner) ? { transcription: text } : {}),
    ...(args.ai ? { transcriptAi: args.ai } : {}),
    ...(args.targetLang ? { targetLang: args.targetLang } : {}),
    author: args.author,
  })
  return true
}
