// AQU-1722, AQU-2278: what a line is called wherever it is mentioned in a list
// (the selection bar's notes, the generate-voice plan, the health card's
// "Biggest drags"), so one line is named identically everywhere.
//
// Its reference, else the table's # column, else nothing. A line's own typed
// label (`cellLabel`) is not part of it: the row shows that in its corner, not
// as its reference.

import { namedCellRef } from "@/lib/cell-named-ref"
import { isScriptureStructureLocator, parseScriptureReference } from "@/lib/scripture-reference"
import { splitFromCellId } from "@/lib/timeline/user-line-origin"
import type { createEditorStructureCache } from "@/lib/editor-structure-cache"

export interface LineNameCell {
  id: string
  context?: string | null
  globalReferences?: readonly string[] | null
  metadata?: Record<string, unknown> | null
}

/** The table's numbering over the file's rows, from the editor structure cache
 *  (`createEditorStructureCache().read(rowIds, store)`). */
export interface LineNumbering {
  sequentialNumberByCellId: ReadonlyMap<string, number>
  versePartByCellId: ReadonlyMap<string, string>
  /** The file's rows in table order (`getCellIdsForLens`). */
  rowIds: readonly string[]
  /** Any line of the file, by id. */
  getCell: (id: string) => LineNameCell | null | undefined
}

type StructureCache = ReturnType<typeof createEditorStructureCache>
type StructureReaders = Parameters<StructureCache["read"]>[1]

/** Read the table's numbering for `rowIds` (the file's rows in table order). */
export function readLineNumbering(
  store: StructureReaders & { getCellView(id: string): LineNameCell | null },
  rowIds: readonly string[],
  structureCache: StructureCache,
): LineNumbering {
  const { sequentialNumberByCellId, versePartByCellId } = structureCache.read(rowIds, store)
  return { sequentialNumberByCellId, versePartByCellId, rowIds, getCell: (id) => store.getCellView(id) }
}

/** `namedCellRef`, minus a heading's structure locator ("RUT 1:h:1"): that
 *  says where the heading sits in the book, and the table shows it no name. */
function ownReference(cell: LineNameCell): string | undefined {
  const named = (value?: string | null) => !isScriptureStructureLocator(value)
  return namedCellRef({
    context: named(cell.context) ? cell.context : null,
    globalReferences: (cell.globalReferences ?? []).filter(named),
  })
}

/** The verse row a split piece was cut from (itself, when it was not). */
function splitHead(cell: LineNameCell, numbering: LineNumbering): LineNameCell {
  let head = cell
  for (let hops = 0; hops < 64; hops++) {
    const from = splitFromCellId(head)
    const next = from ? numbering.getCell(from) : null
    if (!next) break
    head = next
  }
  return head
}

/**
 * The reference a person reads the line by ("GEN 1:1", "B4"), if it has one.
 * A verse split at its quotation marks reads as its part ("RUT 1:5b"), the way
 * the gutter numbers it: the pieces carry no reference of their own.
 */
export function lineReference(cell: LineNameCell, numbering: LineNumbering): string | undefined {
  const part = numbering.versePartByCellId.get(cell.id)
  const verse = part ? parseScriptureReference(ownReference(splitHead(cell, numbering))) : null
  if (part && verse) return `${verse.bookCode} ${verse.chapter}:${part}`
  return ownReference(cell)
}

/**
 * The line's number in the table's # column. A file with imported numbers
 * leaves its headings unnumbered, so those have none; a plain document numbers
 * by position instead.
 */
export function lineNumber(cell: LineNameCell, numbering: LineNumbering): number | undefined {
  const numbers = numbering.sequentialNumberByCellId
  return numbers.size > 0
    ? numbers.get(cell.id)
    : (numbering.rowIds.indexOf(cell.id) + 1) || undefined
}

/** The line's name: its reference, else "row 4" (`rowName`), else "". */
export function lineName(
  cell: LineNameCell,
  numbering: LineNumbering,
  rowName: (number: number) => string,
): string {
  const ref = lineReference(cell, numbering)
  if (ref) return ref
  const number = lineNumber(cell, numbering)
  return number === undefined ? "" : rowName(number)
}
