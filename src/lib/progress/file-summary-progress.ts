// AQU-516: the file sidebar shows a per-file translated/validated progress
// indicator (FileRow's amber+emerald bars), but it only had data for the
// currently-open file (ProjectWorkspace fed useHealth a fileCells map with a
// single entry). fetchProjectFiles() already returns server-projected counts
// for EVERY file in the project (same source the PM dashboard's file table
// uses — see org/ProjectOverview.tsx) — this module maps that response into
// the sidebar's FileStats shape and merges it with the live, per-cell-derived
// stats for whichever file is currently open.
import type { FileSummary } from "@/lib/sync/cells-read-types"

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
