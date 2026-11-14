// AQU-1722, AQU-2278: what a line is called wherever it is mentioned in a list
// (the selection bar's notes, the generate-voice plan, the health card's
// "Biggest drags"), so one line is named identically everywhere.
//
// A line is named exactly as its row shows it: its reference ("RUT 1:4", a
// cue's timing, "RUT 1:5b" for a piece of a split verse), else the label in
// its # column ("row 4", the very label the table draws), else what its row
// shows in its corner (the line's own label or character), else its words,
// else "(empty line)".

import { namedCellRef } from "@/lib/cell-named-ref"
import type { createEditorStructureCache } from "@/lib/editor-structure-cache"
import {
  cellNumberLabel,
  importDisplayLabel,
  isScriptureStructureLocator,
  parseScriptureReference,
} from "@/lib/scripture-reference"
import { ownCastName } from "@/lib/timeline/cue-character"
import { splitFromCellId } from "@/lib/timeline/user-line-origin"

export interface LineNameCell {
  id: string
  type?: string | null
  /** The verse address the row's gutter reads ("RUT 1:4"). */
  group?: string | null
  context?: string | null
  globalReferences?: readonly string[] | null
  metadata?: Record<string, unknown> | null
  cellLabel?: string
  original?: string
}

/** The table's numbering over the file's rows. */
export interface LineNumbering {
  sequentialNumberByCellId: ReadonlyMap<string, number>
  versePartByCellId: ReadonlyMap<string, string>
  /** A file of chapters numbers its lines by verse, so an un-versed line has
   *  no number. Worked out on first use, once per reading. */
  scriptureNumbering: () => boolean
  /** Any line of the file, by id. */
  getCell: (id: string) => LineNameCell | null | undefined
}

/** A file of chapters numbers its lines by verse; anything else counts them. */
export function scriptureNumberingOf(navigation: readonly { kind: string }[]): boolean {
  return navigation.every((item) =>
    item.kind === "chapter" || item.kind === "chapter-range" || item.kind === "preface")
}

type StructureCache = ReturnType<typeof createEditorStructureCache>
type StructureReaders = Parameters<StructureCache["read"]>[1]

/** Read the table's numbering for `rowIds` (the file's rows in table order,
 *  `getCellIdsForLens`), as EditorTable reads it. */
export function readLineNumbering(
  store: StructureReaders & {
    getCellView(id: string): LineNameCell | null
    getNavigationIndex(ids?: readonly string[]): readonly { kind: string }[]
  },
  rowIds: readonly string[],
  structureCache: StructureCache,
): LineNumbering {
  const { sequentialNumberByCellId, versePartByCellId } = structureCache.read(rowIds, store)
  let scripture: boolean | undefined
  return {
    sequentialNumberByCellId,
    versePartByCellId,
    scriptureNumbering: () => (scripture ??= scriptureNumberingOf(store.getNavigationIndex(rowIds))),
    getCell: (id) => store.getCellView(id),
  }
}

/**
 * The label in a row's # column. EditorTable draws its column with this, and
 * a line's name reads it, so the two cannot drift apart.
 */
export function lineNumberLabel(
  cell: LineNameCell,
  row: {
    contentNumber: number | undefined
    versePart: string | undefined
    scriptureNumbering: boolean | (() => boolean)
    rowIndex?: number
  },
  lineNumbersEnabled = true,
): string | null {
  return cellNumberLabel({
    lineNumbersEnabled,
    cellType: cell.type,
    canonicalRef: cell.group,
    sourceCanonicalRef: cell.globalReferences?.[0],
    scriptureNumbering: typeof row.scriptureNumbering === "function" ? row.scriptureNumbering() : row.scriptureNumbering,
    rowIndex: row.rowIndex,
    contentNumber: row.contentNumber,
    displayLabel: importDisplayLabel(cell.metadata),
    versePart: row.versePart,
  })
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

/** The label the line's # column shows, or null when it shows none. */
export function lineNumber(cell: LineNameCell, numbering: LineNumbering): string | null {
  return lineNumberLabel(cell, {
    contentNumber: numbering.sequentialNumberByCellId.get(cell.id),
    versePart: numbering.versePartByCellId.get(cell.id),
    scriptureNumbering: numbering.scriptureNumbering,
  })
}

/** What the row shows in its corner of its own: the character the line names,
 *  else its label (EditorTable's `ownCastName(cell) ?? ownLabel`). */
function cornerLabel(cell: LineNameCell): string | null {
  return ownCastName(cell) ?? cell.cellLabel ?? null
}

export interface LineNameWords {
  /** "row {number}", given the # column's label. */
  row: (label: string) => string
  /** "(empty line)". */
  empty: string
}

/** The line's name; see the rule at the top of this file. */
export function lineName(cell: LineNameCell, numbering: LineNumbering, words: LineNameWords): string {
  const ref = lineReference(cell, numbering)
  if (ref) return ref
  const number = lineNumber(cell, numbering)
  if (number) return words.row(number)
  return cornerLabel(cell) || cell.original?.trim() || words.empty
}
