import type { CellData } from "@/hooks/useCells"
import { sourceClipAudioForCell } from "./track-audio"
import type { AlignmentWord } from "./script-alignment"

/** Source transcription timings are relative to the decoded trim window.
 * Recover whole-clip times, independent of later cell retiming or dub selection.
 * Overlapping cue transcriptions can repeat the same timed word.
 */
export function collectSourceAlignmentWords(
  cells: readonly CellData[],
  clipUrl: string,
): AlignmentWord[] {
  const words = new Map<string, AlignmentWord>()
  for (const cell of cells) {
    const source = sourceClipAudioForCell(cell)
    if (!source || source.url !== clipUrl) continue
    const attachment = cell.attachments?.[source.audioId]
    const offset = (attachment?.trimStartMs ?? 0) / 1000
    for (const timing of cell.audioTimings?.[source.audioId] ?? []) {
      if (!timing.word.trim()) continue
      const word = {
        text: timing.word, start: offset + timing.t0, end: offset + timing.t1,
      }
      const key = JSON.stringify([word.text, word.start, word.end])
      words.set(key, word)
    }
  }
  return [...words.values()].sort((a, b) => a.start - b.start || a.end - b.end)
}
