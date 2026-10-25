// AQU-516: the file sidebar shows a per-file translated/validated progress
// indicator (FileRow's amber+emerald bars), but it only had data for the
// currently-open file (ProjectWorkspace fed useHealth a fileCells map with a
// single entry). fetchProjectFiles() already returns server-projected counts
// for EVERY file in the project (same source the PM dashboard's file table
// uses — see org/ProjectOverview.tsx) — this module maps that response into
// the sidebar's FileStats shape and merges it with the live, per-cell-derived
// stats for whichever file is currently open.
import type { FileSummary } from "@/lib/sync/cells-read-types"
import { deliversView, type DeliversView, type LaneDelivers } from "@/lib/lanes/lane-delivers"

export interface FileStats {
  translated: number
  validated: number
  total: number
  /**
   * AQU-2111: lines with a take of their own, and lines whose audio meets the
   * project's audio validation requirement.
   *
   * OPTIONAL, and undefined means "not known here" rather than "none" — the
   * same contract `ProgressCounts` keeps for the same pair. A sync-worker from
   * before AQU-2111 sends neither, and an audio-only file whose figures were
   * fabricated as 0 would read as nothing-recorded, which is the very bug this
   * pair exists to fix. A caller draws the audio part only when it has them.
   */
  recorded?: number
  audioValidated?: number
  /**
   * Media redesign slice 2: what the open language delivers, when someone has
   * chosen. Audio and Text and audio re-read `translated` as the lines STARTED
   * (recorded, for Audio; text or recording, for Text and audio) and
   * `validated` as the lines DONE (src/lib/lanes/lane-delivers.ts); Audio fills
   * `recorded` / `audioValidated` with the same lines. Text keeps the text
   * figures and draws no audio. Absent: nobody chose, and the figures show
   * what the file holds (AQU-2110), exactly as AQU-2111 draws them.
   */
  delivers?: LaneDelivers | null
  /** Text and audio: lines whose text still needs validating. */
  needsText?: number
  /** Text and audio: lines whose recording still needs approving. */
  needsAudio?: number
  /**
   * Text and audio: the text half on its own — lines with target text, and
   * lines whose text is validated. The file row draws these and `recorded` /
   * `audioValidated` as two bars, exactly as a not-chosen file holding both is
   * drawn (Sam, Oct 24); `translated` / `validated` stay the lines started /
   * done, which the footer reads.
   */
  textTranslated?: number
  textValidated?: number
}

/** Does this file have audio worth drawing? Undefined counts never do. */
export function hasAudioProgress(stats: Pick<FileStats, "recorded"> | undefined): boolean {
  return (stats?.recorded ?? 0) > 0
}

/**
 * Does this file's progress live on its audio alone?
 *
 * The display rule AQU-2110 settled and AQU-2111 applies here: a file with
 * recordings and no target text in the lane being viewed shows its audio
 * figures ONLY, so an audio-only project never reads "0% translated" beside
 * work that is done. A file with both shows text as before and gains audio.
 */
export function isAudioOnlyProgress(stats: FileStats | undefined): boolean {
  return hasAudioProgress(stats) && (stats?.translated ?? 0) === 0
}

/**
 * Which figures a file shows: its text, its audio, or both side by side. What
 * the open language delivers decides when someone has chosen (`deliversView`);
 * otherwise what the file holds, by the AQU-2110 rule above.
 */
export function fileProgressView(stats: FileStats | undefined): DeliversView {
  return deliversView(
    stats?.delivers,
    isAudioOnlyProgress(stats) ? "audio" : hasAudioProgress(stats) ? "both" : "text",
  )
}

/** Maps server file rollups (GET /projects/:id/files) to the sidebar's FileStats shape. */
export function fileSummariesToProgress(
  summaries: readonly FileSummary[],
): Map<string, FileStats> {
  const map = new Map<string, FileStats>()
  for (const s of summaries) {
    map.set(s.fileId, {
      translated: s.filledCount,
      validated: s.approvedCount,
      total: s.cellCount,
      // Spread rather than assigned, so an older worker's absent pair stays
      // absent instead of becoming an explicit `undefined` that a caller
      // merging objects could not tell from a deliberate one.
      ...(s.audioCount == null ? {} : { recorded: s.audioCount }),
      ...(s.audioValidatedCount == null ? {} : { audioValidated: s.audioValidatedCount }),
    })
  }
  return map
}

/**
 * Merges a project-wide snapshot (every file, server-projected) with a live
 * map (typically just the currently-open file, derived from in-memory cell
 * state via useHealth). Live entries win — the open file must keep showing
 * up-to-the-keystroke progress, not the last server snapshot.
 */
export function mergeFileProgress(
  base: ReadonlyMap<string, FileStats>,
  live: ReadonlyMap<string, FileStats>,
): Map<string, FileStats> {
  const merged = new Map(base)
  for (const [fileId, stats] of live) {
    // AQU-2111: the TEXT half is wholly the live entry's, as it always was.
    // The audio half is only taken from it when it has one: the live count is
    // derived from an attachment map that is fetched separately and arrives
    // after the cells do, so a blanket overwrite would blank an audio-only
    // file's bar on open — the server snapshot is the only thing that knows
    // those figures until then.
    const previous = merged.get(fileId)
    merged.set(fileId, stats.recorded == null && previous?.recorded != null
      ? { ...stats, recorded: previous.recorded, audioValidated: previous.audioValidated }
      : stats)
  }
  return merged
}

/**
 * Put a file's audio pair onto the text figures a surface is about to draw.
 *
 * AQU-2132: one rule for every surface that reports the OPEN file, because the
 * editor footer had its own and they disagreed. `stats` is the merged entry —
 * the server's per-file rollup with the live, cell-derived one on top, as
 * `mergeFileProgress` composes them — so the pair is the server's until the
 * attachment map lands and the live count's afterwards. The footer used to
 * read the live count alone and fall through to the text pair when it was not
 * there yet, which is why an audio-only file reported `0 translated` and drew
 * no audio half while the sidebar row beside it read the same file correctly.
 *
 * `recorded == null` means no audio figures from anywhere — a file the server
 * described before it sent the pair at all — and leaves `text` untouched
 * rather than fabricating `0 recorded`, which is the distinction the whole
 * optional pair exists to keep.
 */
export function withAudioProgress<T extends { translated: number; validated: number; total: number }>(
  text: T,
  stats: FileStats | undefined,
): T & { recorded?: number; audioValidated?: number } {
  if (stats?.recorded == null) return text
  return { ...text, recorded: stats.recorded, audioValidated: stats.audioValidated ?? 0 }
}
