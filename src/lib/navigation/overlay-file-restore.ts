import { fileIdFromEditorPath } from "./org-paths"

/**
 * Which file a fileless workspace surface should re-open on a cold mount.
 *
 * The overlay surfaces (`/agent`, `/comments`, `/terminology`, `/memory`)
 * deliberately carry no file in their path — they used to inherit the open file
 * purely from the surviving `ProjectWorkspace` instance. That breaks down on a
 * genuine fresh mount (a reload or a deep link on one of those URLs), and the
 * agent workbench reads the open file directly: with none it renders
 * "Choose a file" (AQU-1496).
 *
 * Order of evidence, strongest first:
 *   1. the `?return=` editor path on the URL — the surface was entered from
 *      that file, and it survives a reload because it is in the URL;
 *   2. the per-user last-location record;
 *   3. the legacy tabs-only last-active-file record.
 *
 * A file the project no longer has is ignored at every step. There is
 * deliberately no "the project has exactly one file" fallback: a project whose
 * file was never opened must keep showing the empty state.
 */
export function resolveOverlayFileId(args: {
  projectId: string
  /** `?return=` target for this project's editor, if the URL carries one. */
  returnPath: string | null
  savedFileId?: string | null
  legacyFileId?: string | null
  knownFileIds: readonly string[]
}): string | null {
  const known = (fileId: string | null | undefined) =>
    fileId && args.knownFileIds.includes(fileId) ? fileId : null

  return (
    known(fileIdFromEditorPath(args.returnPath, args.projectId))
    ?? known(args.savedFileId)
    ?? known(args.legacyFileId)
  )
}
