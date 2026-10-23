// Media redesign slice 2: the editor counts a language that delivers audio by
// its audio. One module for the inputs every editor surface reads — which of
// the open file's lines are recorded and approved in the active language, and
// what the OTHER files' bars say — so the status bar, the file bars, the
// chapter list and grid, the Details window and "Next unfinished" cannot
// disagree with each other or with the Plan.
//
// Every rule here is the shared one (src/lib/lanes/lane-delivers.ts). A Text
// language never reaches this module: its surfaces keep today's code.
import {
  cellAudioVotes,
  isCellAudioValidated,
  type CellAudioEntry,
} from "@/lib/sync/cell-audio-read-types"
import { laneCountsAudio, laneMeasure, type LaneDelivers } from "@/lib/lanes/lane-delivers"
import { planAudioTotal, type PlanUnit } from "@/lib/plan/plan-status"
import { cellHasOwnTake } from "./audio-progress-cells"
import type { FileStats } from "./file-summary-progress"

const NONE: ReadonlySet<string> = new Set()

/** Heard lines of a dubbing file: the lines it is counted by (gap 6). */
export interface HeardLineCounts {
  total: number
  recorded: number
  approved: number
}

export interface EditorLaneTakes {
  /** Lines of the open file with a selected recording in the active language. */
  recorded: ReadonlySet<string>
  /** Lines whose recording has the project's required audio validators. */
  approved: ReadonlySet<string>
  /**
   * A dubbing file (a subtitle file with an audio-cue sheet): its HEARD lines,
   * which are what it is counted by. Null for every other file.
   */
  heard: HeardLineCounts | null
  /**
   * A dubbing file: the subtitle lines some heard line performs. A line not
   * in it is never a stop for "Next unfinished" (P2.7). Null otherwise.
   */
  performed: ReadonlySet<string> | null
}

export const NO_LANE_TAKES: EditorLaneTakes = { recorded: NONE, approved: NONE, heard: null, performed: null }

/**
 * Which lines of the open file are recorded and approved in the active
 * language — the server's own definitions (`cellAudioVotes` is the progress
 * projection's `dub_votes` restated), so the editor and the Plan agree.
 *
 * A dubbing file records on its hidden cue sheet. Its subtitle lines take
 * their state from the heard lines that perform them: recorded when every
 * one of them is, approved when every one of them is. A subtitle line no
 * heard line performs is in neither set; "Next unfinished" leaves it alone
 * (`isUnfinishedLine`). The file itself is counted by its heard lines.
 */
export function editorLaneTakes(args: {
  delivers: LaneDelivers | null | undefined
  /** The open file's own recordings in the active language, by line. */
  ownAudio: ReadonlyMap<string, CellAudioEntry>
  /** The audio-cue sheet's lines, when the file has one. */
  cueIds: readonly string[] | null
  /** The cue sheet's recordings in the active language, by heard line. */
  cueAudio: ReadonlyMap<string, CellAudioEntry> | null
  /** subtitle line → the heard lines performing it. */
  cuesForText: ReadonlyMap<string, readonly string[]>
  /** The project's "Required validators (audio)". */
  audioThreshold: number
}): EditorLaneTakes {
  if (!laneCountsAudio(args.delivers)) return NO_LANE_TAKES
  const recordedIn = (audio: ReadonlyMap<string, CellAudioEntry>) => {
    const recorded = new Set<string>()
    const approved = new Set<string>()
    for (const [cellId, entry] of audio) {
      // A take of the line's OWN (AQU-2110's rule): a file's imported source
      // clip sits selected on every line and records none of them.
      if (cellAudioVotes(entry) == null || !cellHasOwnTake(cellId, entry)) continue
      recorded.add(cellId)
      if (isCellAudioValidated(entry, args.audioThreshold)) approved.add(cellId)
    }
    return { recorded, approved }
  }
  if (!args.cueIds || !args.cueAudio) return { ...recordedIn(args.ownAudio), heard: null, performed: null }

  const cues = recordedIn(args.cueAudio)
  const recorded = new Set<string>()
  const approved = new Set<string>()
  const performed = new Set<string>()
  for (const [textId, cueIds] of args.cuesForText) {
    if (cueIds.length === 0) continue
    performed.add(textId)
    if (cueIds.every((id) => cues.recorded.has(id))) recorded.add(textId)
    if (cueIds.every((id) => cues.approved.has(id))) approved.add(textId)
  }
  const heardIds = new Set(args.cueIds)
  let heardRecorded = 0
  let heardApproved = 0
  for (const id of heardIds) {
    if (cues.recorded.has(id)) heardRecorded++
    if (cues.approved.has(id)) heardApproved++
  }
  return {
    recorded,
    approved,
    heard: { total: heardIds.size, recorded: heardRecorded, approved: heardApproved },
    performed,
  }
}

/**
 * "Next unfinished" in a language that counts its recordings: a line is
 * unfinished until it is done by the shared rule. A subtitle line of a dubbing
 * file that no heard line performs is never a stop (P2.7).
 */
export function isUnfinishedLine(
  cell: { laneStatus?: "empty" | "unvalidated" | "validated" | undefined; id: string },
  performed: ReadonlySet<string> | null,
): boolean {
  if (performed && !performed.has(cell.id)) return false
  return cell.laneStatus !== "validated"
}

/**
 * The sidebar's bar for every file in a language that counts its recordings,
 * from the Plan's own read for that language — so the file bar, the Details
 * window and the Plan's readout cannot disagree (P2.1, P2.7). Bars are drawn
 * as "started" (the light half: recorded, or for Text and audio lines with
 * either half) and "done" (the dark half). Units of one file (a whole-Bible
 * import's books) add up to the file.
 */
export function planUnitsToFileProgress(
  units: readonly PlanUnit[],
  delivers: LaneDelivers | null | undefined,
): Map<string, FileStats> {
  const map = new Map<string, FileStats>()
  for (const u of units) {
    const m = laneMeasure(delivers, {
      total: u.totalCount,
      filled: u.filledCount,
      validated: u.validatedCount,
      audioTotal: planAudioTotal(u),
      recorded: u.audioCount,
      audioApproved: u.audioValidatedCount,
      bothApproved: u.bothValidatedCount ?? 0,
    })
    const prev = map.get(u.fileId)
    const started = Math.min(m.started, m.total)
    map.set(u.fileId, {
      total: (prev?.total ?? 0) + m.total,
      translated: (prev?.translated ?? 0) + started,
      validated: (prev?.validated ?? 0) + m.done,
      // An Audio language's started / done lines are its recorded / approved
      // ones, which is what the row's audio bar reads.
      ...(delivers === "audio"
        ? { recorded: (prev?.recorded ?? 0) + started, audioValidated: (prev?.audioValidated ?? 0) + m.done }
        : {}),
      delivers: delivers ?? null,
    })
  }
  return map
}
