// Pure decider for "which file should the workspace open when the URL carries
// none?". Kept pure (no hook) so the priority rule is trivially testable —
// same pattern as deriveCellAreaState in ./cell-area-state.ts.
//
// AQU-339: on a cold load of a freshly-joined, multi-file project there is no
// saved location and no open tab. The old logic only auto-opened a file when
// the project had *exactly one*, so a multi-file project landed on a bare
// "No file selected" prompt that forced the user to hunt-and-click a source
// tab before any content appeared. Falling back to the first project file
// gives a sensible default source text on cold load instead.

export interface RestoreFileInput {
  /** Every file id that currently exists in the project (the valid set). */
  fileIds: readonly string[]
  /** Remembered file from the per-user last-location store, if any. */
  savedFileId: string | null
  /** Legacy tabs-only last-active file id, if any. */
  lastActiveFileId: string | null
  /** First currently-open workspace tab's file id, if any. */
  firstOpenTabFileId: string | null
  /** First file in the project (sidebar order) — the cold-load default. */
  firstProjectFileId: string | null
}

/**
 * Decide which file to open when the workspace URL has no file id.
 *
 * Priority: remembered per-user location → legacy last-active → first open
 * tab → first project file (AQU-339 cold-load default). Every candidate is
 * validated against `fileIds`; returns null only when the project genuinely
 * has no files (leave the editor on its "No files yet — import" empty state).
 */
export function pickRestoreFileId(input: RestoreFileInput): string | null {
  const valid = new Set(input.fileIds)
  const candidates = [
    input.savedFileId,
    input.lastActiveFileId,
    input.firstOpenTabFileId,
    input.firstProjectFileId,
  ]
  for (const id of candidates) {
    if (id && valid.has(id)) return id
  }
  return null
}
