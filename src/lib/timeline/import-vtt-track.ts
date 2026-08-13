// AQU-904 — import a VTT/SRT into an EXISTING timeline file as its own track.
//
// The Import dialog can only ever create a NEW file, so a second cue file (Come
// and See ship an audio/dubbing VTT whose timestamps differ from the subtitle
// VTT) had nowhere to land except a second project. This appends its cues to
// the open file instead, tagged with a freshly minted track (see `tracks.ts`),
// so both cue sets sit on one timeline against one video.
//
// Same append shape as `attach-media.ts`: outbox events, caller flushes and
// revalidates afterwards.

import { v7 as uuidv7 } from "uuid"
import { extractSrtStrings, extractVttStrings } from "@/lib/parsers/subtitle"
import { emitSourceCellCreate } from "@/lib/sync/events-emit"
import { buildTrackMetadata, type TimelineTrackKind, type TimelineTrackRef } from "./tracks"

/** Cue-file extensions this import accepts (both timed-text formats we parse). */
export const TRACK_FILE_ACCEPT = ".vtt,.srt"

export interface TrackCue {
  /** Cue text, voice tag already stripped into `speaker`. */
  text: string
  startMs: number
  endMs: number
  /** VTT `<v Name>` label, when the cue carried one. */
  speaker?: string
}

/**
 * Parse a cue file into TIMED cues only. A track exists to sit at timestamps on
 * a shared clock, so an untimed cue has nowhere to go — it is dropped rather
 * than parked in the untimed strip, where it would read as a subtitle-lane row
 * that lost its track.
 *
 * Throws when the file yields no timed cue at all, so the UI can say why
 * instead of silently importing an empty track.
 */
export function parseTrackCues(content: string, fileName: string): TrackCue[] {
  const isSrt = fileName.toLowerCase().endsWith(".srt")
  const strings = isSrt ? extractSrtStrings(content) : extractVttStrings(content)
  const cues: TrackCue[] = []
  for (const s of strings) {
    if (typeof s.start !== "number" || typeof s.end !== "number") continue
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) continue
    const text = s.original.trim()
    if (text === "") continue
    cues.push({
      text,
      startMs: Math.round(s.start * 1000),
      endMs: Math.round(s.end * 1000),
      ...(s.speaker ? { speaker: s.speaker } : {}),
    })
  }
  if (cues.length === 0) {
    throw new Error(`"${fileName}" has no timed cues — a timeline track needs timecoded text.`)
  }
  return cues
}

export interface ImportTrackContext {
  projectId: string
  /** The existing time-ordered file receiving the track. */
  fileId: string
  author: string
  /**
   * Highest `sequenceIndex` already in the file. The new cues are appended
   * after it so they never interleave with the existing rows' home order —
   * their TIMING is what places them on the track; sequence is only the
   * text table's fallback order.
   */
  maxSequenceIndex?: number
  /** Last cell already in the file — the new chain hangs off it so the track
   *  appends rather than landing ahead of the existing rows. */
  anchorCellId?: string | null
}

export interface ImportTrackOptions {
  kind: TimelineTrackKind
  /** Defaults to the file's name — what the lane label shows. */
  label?: string
}

/**
 * Append a cue file to `ctx.fileId` as a new, separately-labeled track.
 *
 * Never touches existing cells: every cue is a genesis `source.cell.create`
 * chained onto the one before it, so the subtitle track already in the file (and
 * the source-audio lane) are left exactly as they were.
 */
export async function importTrackToTimeline(
  file: File,
  ctx: ImportTrackContext,
  opts: ImportTrackOptions,
): Promise<{ track: TimelineTrackRef; cues: number }> {
  const cues = parseTrackCues(await file.text(), file.name)
  const track: TimelineTrackRef = {
    id: `trk_${uuidv7()}`,
    label: (opts.label ?? file.name).trim() || file.name,
    kind: opts.kind,
  }
  const metadataFor = (cue: TrackCue): Record<string, unknown> => ({
    ...buildTrackMetadata(track),
    // Keep the VTT voice tag with its cue — the dub track's character labels
    // are the point of the file for a dubbing team.
    ...(cue.speaker ? { speaker: cue.speaker } : {}),
  })

  const base = Math.max(0, Math.floor(ctx.maxSequenceIndex ?? 0) + 1)
  let prevCellId: string | null = ctx.anchorCellId ?? null
  for (const [i, cue] of cues.entries()) {
    const cellId = uuidv7()
    await emitSourceCellCreate({
      projectId: ctx.projectId,
      fileId: ctx.fileId,
      cellId,
      anchorCellId: prevCellId,
      value: cue.text,
      type: "cue",
      startMs: cue.startMs,
      endMs: cue.endMs,
      sequenceIndex: base + i,
      metadata: metadataFor(cue),
      author: ctx.author,
    })
    prevCellId = cellId
  }

  return { track, cues: cues.length }
}
