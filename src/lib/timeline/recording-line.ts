// AQU-2426: a line of SOURCE audio, as Split into lines… and the "Not split
// into lines yet" notice see it — never a take (Sam, Nov 6: "a split into lines
// should exist on any source audio, not recordings"; a take keeps Split at the
// playhead).
//
// A source line is a media line whose shared recording (the file's own upload,
// seeded with the FILE id) plays a stretch of it. It can be split when that
// recording is stored in the project (a frontier-audio:// upload); a streamed
// link can't be read here.

import type { CellData } from "@/hooks/useCells"
import { sourceClipAudioForCell } from "@/lib/audio/track-audio"
import { canReadLineAudio } from "@/lib/audio/recording-split"

/** "About a minute" (board 58 pick: longer than 60 seconds). */
export const NOT_SPLIT_NOTICE_MIN_MS = 60_000

export interface SourceRecordingLine {
  audioId: string
  url: string
  /** Its stretch of the recording, ms. */
  lo: number
  hi: number
  durationMs?: number
  /** It plays the whole recording: it was never split. */
  whole: boolean
  /** The recording is stored in the project, so it can be read and split. */
  readable: boolean
}

export function sourceRecordingLine(cell: CellData): SourceRecordingLine | null {
  const clip = sourceClipAudioForCell(cell)
  if (!clip) return null
  const att = cell.attachments?.[clip.audioId]
  const durationMs = att?.durationMs ?? undefined
  const lo = att?.trimStartMs ?? 0
  const timedLen = cell.startTime !== undefined && cell.endTime !== undefined
    ? Math.max(0, (cell.endTime - cell.startTime) * 1000)
    : undefined
  const hi = att?.trimEndMs ?? durationMs ?? (timedLen !== undefined ? lo + timedLen : undefined)
  if (hi === undefined || !(hi > lo)) return null
  const whole = lo <= 0 && (att?.trimEndMs == null || (durationMs !== undefined && att.trimEndMs >= durationMs - 50))
  return {
    audioId: clip.audioId,
    url: clip.url,
    lo,
    hi,
    ...(durationMs !== undefined ? { durationMs } : {}),
    whole,
    readable: canReadLineAudio(clip.url),
  }
}

/** A whole recording over about a minute that is still one line. */
export function needsSplitNotice(line: SourceRecordingLine | null): boolean {
  return Boolean(line && line.whole && line.readable && line.hi - line.lo > NOT_SPLIT_NOTICE_MIN_MS)
}
