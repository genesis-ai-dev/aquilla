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
}

/** Maps server file rollups (GET /projects/:id/files) to the sidebar's FileStats shape. */
export function fileSummariesToProgress(
  summaries: readonly FileSummary[],
): Map<string, FileStats> {
  const map = new Map<string, FileStats>()
  for (const s of summaries) {
    map.set(s.fileId, { translated: s.filledCount, validated: s.approvedCount, total: s.cellCount })
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
  for (const [fileId, stats] of live) merged.set(fileId, stats)
  return merged
}
