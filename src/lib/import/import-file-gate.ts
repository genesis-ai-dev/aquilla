/**
 * AQU-1365: when a translation import may start matching against its
 * destination file.
 *
 * The cell store only ever holds the OPEN file, so a translation for another
 * file opens that file in the editor behind the Import dialog and waits here
 * until every one of its lines is in the store. The review matches against
 * whatever `cells` it is handed when it mounts, so starting early would match
 * against the previous file's rows, or against the first page of a long file.
 *
 * Why not the workspace's paint gate (`nextPaintGate`): it opens on the first
 * painted page, which is right for deferring secondary reads and wrong here.
 * The same subtlety applies though: the store's `isLoading` starts FALSE and
 * only flips true once its fetch gets past an async cache read, and a cache
 * paint never flips it at all. So "not loading" alone never means "loaded".
 */

export interface ImportFileGate {
  /** The file this gate is waiting for, so a switch away and back starts over. */
  file: string | null
  /** True once a load for `file` has been seen in flight. */
  sawLoad: boolean
}

export type ImportFileGateState = "waiting" | "ready" | "failed"

export const CLOSED_IMPORT_FILE_GATE: ImportFileGate = { file: null, sawLoad: false }

export interface ImportFileGateInput {
  wantedFileId: string
  activeFileId: string | null
  cellsLoading: boolean
  cellsError: boolean
  cellCount: number
  /** `fileId` of the first cell in the store, which says whose rows they are. */
  firstCellFileId: string | undefined
}

/**
 * Rules, in order:
 * 1. The editor is not on the wanted file yet → waiting (and forget any load
 *    seen, since it was for another file).
 * 2. The load failed → failed.
 * 3. A load is running → waiting, and remember it was seen.
 * 4. The store holds the wanted file's rows → ready. This is the cache paint,
 *    which is a whole file and never sets `isLoading`.
 * 5. No rows, and a load for this file was seen to finish → ready (a file that
 *    genuinely has no lines).
 * 6. Otherwise waiting: the previous file's rows are still in the store, or
 *    the fetch has not started yet.
 *
 * Returns `prev` itself whenever the gate did not move, so a caller adjusting
 * state while rendering can compare by identity and settle.
 */
export function nextImportFileGate(
  prev: ImportFileGate,
  input: ImportFileGateInput,
): { gate: ImportFileGate; state: ImportFileGateState } {
  const wanted = input.wantedFileId
  if (input.activeFileId !== wanted) {
    const gate = prev.file === wanted && !prev.sawLoad ? prev : { file: wanted, sawLoad: false }
    return { gate, state: "waiting" }
  }
  const sawLoad = (prev.file === wanted && prev.sawLoad) || input.cellsLoading
  const gate = prev.file === wanted && prev.sawLoad === sawLoad ? prev : { file: wanted, sawLoad }
  if (input.cellsError) return { gate, state: "failed" }
  if (input.cellsLoading) return { gate, state: "waiting" }
  if (input.cellCount > 0 && input.firstCellFileId === wanted) return { gate, state: "ready" }
  if (input.cellCount === 0 && sawLoad) return { gate, state: "ready" }
  return { gate, state: "waiting" }
}
