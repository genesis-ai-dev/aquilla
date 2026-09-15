/**
 * AQU-1245: resolve a jump target to a CELL ID rather than a whole-file row
 * index.
 *
 * The editor's index-based scroll entry indexes the rows it is *rendering*.
 * With "Split into milestones" on that is only the current milestone's rows, so
 * a target resolved to an index counted over the whole file is either out of
 * range (the scroll is silently dropped) or lands on an unrelated row of the
 * page already showing — and neither turns the page. The editor's id-based
 * scroll (`EditorTableHandle.scrollToCellId`) turns to the milestone that
 * contains the cell when it is off the current page, so every caller should
 * hand it an id.
 *
 * These are the two remaining callers' target lookups, kept pure so they are
 * testable away from the workspace shell (same split as
 * `lib/editor/current-index.ts`).
 */

/** The slice of the cell store these lookups need. */
export interface SectionCellIdLookup {
  findCellIdBySection(label: string): string | null
}

/**
 * The first cell of an assignment's scope, e.g. `"1 Thessalonians 4"` or
 * `"1 Thessalonians 4, 1 Thessalonians 5 in 1TH.usfm"`.
 *
 * FRO-192 shape: the scope label may name several chapters and may carry an
 * ` in <file>` suffix. The first chapter the file actually has wins; `null`
 * when none matches (a book-scope label on a file with no chapter sections),
 * which callers read as "fall back to the top of the file".
 */
export function resolveScopeLabelCellId(
  store: SectionCellIdLookup,
  scopeLabel: string,
): string | null {
  const chapterPart = scopeLabel.split(" in ")[0]?.trim() ?? scopeLabel
  const chapters = chapterPart.split(",").map((s) => s.trim()).filter(Boolean)
  for (const chapter of chapters) {
    const cellId = store.findCellIdBySection(chapter)
    if (cellId) return cellId
  }
  return null
}

/**
 * The row the recording modal's active cell should reveal behind it.
 *
 * A CUE has no row of its own, so the scroll follows its linked subtitle
 * instead — and an unlinked cue returns `null`, which is honest: there is no
 * row to show.
 */
export function resolveRecordingRowCellId(args: {
  cellId: string
  isCueArrangement: boolean
  linkedTextIds?: readonly string[]
}): string | null {
  if (!args.isCueArrangement) return args.cellId
  return args.linkedTextIds?.[0] ?? null
}
