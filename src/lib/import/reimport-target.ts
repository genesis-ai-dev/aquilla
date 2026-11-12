/**
 * AQU-2120: the existing file a hand-off panel re-imports into.
 *
 * The general dropzone resolves a collision into `reimportFileIds` (incoming
 * name → existing file id) and then hands spreadsheets and lone JSON
 * documents to their own panel for column mapping / key picking. Those
 * hand-offs used to drop the map, so "Update existing" quietly made a second
 * file with the same name.
 *
 * The map cannot simply be forwarded, because a panel may emit a *different*
 * name than the file it was handed: one sheet of `data.xlsx` is written as
 * `data.xlsx — Sheet1`. So the hand-off carries the resolved file's id **and
 * its name**, and the panel honours it only when the name it is about to emit
 * is that file's own name — picking Sheet2 out of the same workbook imports
 * fresh rather than overwriting Sheet1's file.
 */

export interface ReimportTarget {
  /** Existing file id to re-import into. */
  id: string
  /** That file's display name, as the project listing has it. */
  name: string
}

/**
 * The hand-off target for one file the dropzone is passing to a panel, or
 * `undefined` when the person did not choose "Update existing" for it (or the
 * matched file is not in the listing we were given).
 */
export function reimportTargetFor(
  fileName: string,
  reimportFileIds: ReadonlyMap<string, string> | undefined,
  existingFiles: readonly { id?: string; name: string }[] | undefined,
): ReimportTarget | undefined {
  const id = reimportFileIds?.get(fileName.trim().toLowerCase())
  if (!id) return undefined
  const existing = existingFiles?.find((file) => file.id === id)
  return existing ? { id, name: existing.name } : undefined
}

/**
 * The `ImportContext.reimportFileIds` map for a result about to be emitted —
 * keyed the way `emitParsedFile` looks it up, and only when the emitted name
 * is the target file's own name.
 */
export function reimportFileIdsForResult(
  resultName: string,
  target: ReimportTarget | undefined,
): ReadonlyMap<string, string> | undefined {
  if (!target) return undefined
  const key = resultName.trim().toLowerCase()
  return key === target.name.trim().toLowerCase() ? new Map([[key, target.id]]) : undefined
}
