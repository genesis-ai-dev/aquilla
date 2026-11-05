/**
 * Which file the editor should open when the URL carries no file id.
 *
 * `/project/:id/editor` is reachable with no file in the path — from the
 * project overview, from a dashboard row, after a detour through an overlay
 * surface, or on a cold reload. Landing there with nothing open makes the
 * translator's first action "go find a file" instead of "translate"
 * (AQU-1537), so the workspace restores a file whenever it can name one.
 *
 * Order of evidence, strongest first:
 *   1. the per-user last-location record — someone returning to a project
 *      goes back to the file they were working on;
 *   2. the legacy tabs-only last-active-file record (kept for browsers that
 *      only ever wrote the old key);
 *   3. the first open workspace tab;
 *   4. the project's single file, when it has exactly one — a one-file
 *      project has nothing to choose between, so an empty state there is
 *      never the right answer.
 *
 * A file the project no longer has is ignored at every step: a remembered id
 * that was deleted, or that belongs to another project, must not beat the
 * single-file fallback.
 *
 * Returning `null` means "keep the empty state": a multi-file project this
 * user has never opened a file in. That state carries its own instruction
 * (`editor.file.noneSelectedBody` — "Pick a file from the sidebar…"), so the
 * user is told what to do next rather than left guessing.
 *
 * A file id already in the URL is NOT this function's business — an explicit
 * deep link always wins and is handled by its caller before this is reached.
 */
export function resolveEditorFileId(args: {
  /** Per-user last-location record for this project, if any. */
  savedFileId?: string | null
  /** Legacy, tabs-only last-active-file record for this project. */
  legacyFileId?: string | null
  /** The first tab open in this project's workspace, if any. */
  firstOpenTabFileId?: string | null
  /** Every file id the project is currently known to have. */
  knownFileIds: readonly string[]
}): string | null {
  const known = (fileId: string | null | undefined) =>
    fileId && args.knownFileIds.includes(fileId) ? fileId : null
  const onlyFile = args.knownFileIds.length === 1 ? (args.knownFileIds[0] ?? null) : null

  return (
    known(args.savedFileId)
    ?? known(args.legacyFileId)
    ?? known(args.firstOpenTabFileId)
    ?? onlyFile
  )
}
