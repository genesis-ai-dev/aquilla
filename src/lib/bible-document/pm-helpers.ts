// ProseMirror-side helpers for the Bible document (AQU-2559): which cell a
// position belongs to, edits that leave verse chips alone, and replacing only
// the stretches of the document whose cells changed underneath it.

import { Fragment, type Node as PMNode, type Schema } from "@tiptap/pm/model"
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state"
import { readDoc, type BlockJSON, type DocJSON, type DocReading, type UnitLayout } from "./doc-model"

export const SYNC_META = "bibleDocumentSync"

const readings = new WeakMap<PMNode, DocReading>()

/** `readDoc` for a live document, computed once per document. */
export function readPm(doc: PMNode, layout: ReadonlyMap<string, UnitLayout>): DocReading {
  let reading = readings.get(doc)
  if (!reading) {
    reading = readDoc(doc.toJSON() as DocJSON, layout)
    readings.set(doc, reading)
  }
  return reading
}

export interface CellRange {
  cellId: string
  /** Where the cell's words start (after its chip, or inside its heading). */
  from: number
  /** Where they end: the next cell's start, or the end of its heading. */
  to: number
  heading: boolean
}

const ranges = new WeakMap<PMNode, CellRange[]>()

/** Every cell's stretch of the document, in order. */
export function cellRanges(doc: PMNode): CellRange[] {
  const cached = ranges.get(doc)
  if (cached) return cached
  const out: CellRange[] = []
  const state: { open: CellRange | null } = { open: null }
  doc.forEach((block, offset) => {
    if (block.type.name === "para") {
      block.forEach((node, inner) => {
        if (node.type.name !== "verse") return
        const pos = offset + 1 + inner
        if (state.open) state.open.to = pos
        state.open = { cellId: node.attrs.cellId as string, from: pos + 1, to: pos + 1, heading: false }
        out.push(state.open)
      })
      // Words at the start of a later paragraph still belong to the open verse.
      if (state.open) state.open.to = offset + block.nodeSize - 1
      return
    }
    state.open = null
    if (block.type.name === "cellHeading") {
      out.push({ cellId: block.attrs.cellId as string, from: offset + 1, to: offset + block.nodeSize - 1, heading: true })
    }
  })
  ranges.set(doc, out)
  return out
}

/** The cell a position belongs to. Inside a verse or heading, that cell. In a
 *  heading the translator added, the verse after it: that verse stores it. */
export function cellAt(doc: PMNode, pos: number): CellRange | null {
  const list = cellRanges(doc)
  let lo = 0
  let hi = list.length - 1
  let index = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].from <= pos) {
      index = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  if (index >= 0 && pos <= list[index].to) return list[index]
  return list[index + 1] ?? null
}

/** True when the range holds a node an edit may not remove. */
export function hasFixedNodes(doc: PMNode, from: number, to: number): boolean {
  let fixed = false
  doc.nodesBetween(from, to, (node, pos) => {
    const name = node.type.name
    if (name === "verse" || name === "chapterLabel") fixed = true
    // A heading cell is fixed when the range takes the whole node.
    if (name === "cellHeading" && from <= pos && to >= pos + node.nodeSize) fixed = true
    return !fixed
  })
  if (fixed) return true
  // A range that crosses a block boundary would join blocks around a chip.
  return !doc.resolve(from).sameParent(doc.resolve(to))
}

/** Delete the words in a range and nothing else: chips, labels and block
 *  boundaries stay. Returns the mapped start. */
export function deleteWordsOnly(tr: Transaction, from: number, to: number): number {
  const pieces: Array<[number, number]> = []
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) pieces.push([Math.max(from, pos), Math.min(to, pos + node.nodeSize)])
    else if (node.type.name === "note") pieces.push([pos, pos + node.nodeSize])
    return true
  })
  for (let i = pieces.length - 1; i >= 0; i--) tr.delete(pieces[i][0], pieces[i][1])
  return tr.mapping.map(from, -1)
}

interface Anchor { cellId: string; offset: number }

/** A position as "this many characters into this cell", which survives the
 *  cell's surroundings being rebuilt. */
function anchorOf(doc: PMNode, pos: number): Anchor | null {
  const cell = cellAt(doc, pos)
  if (!cell) return null
  let offset = 0
  doc.nodesBetween(cell.from, Math.max(cell.from, Math.min(pos, cell.to)), (node, at) => {
    if (node.isText) offset += Math.min(pos, at + node.nodeSize) - Math.max(cell.from, at)
    else if (node.type.name === "note") offset += 1
    return true
  })
  return { cellId: cell.cellId, offset }
}

function resolveAnchor(doc: PMNode, anchor: Anchor): number | null {
  const cell = cellRanges(doc).find((c) => c.cellId === anchor.cellId)
  if (!cell) return null
  let left = anchor.offset
  let found: number | null = null
  let last = cell.from
  doc.nodesBetween(cell.from, cell.to, (node, at) => {
    if (found !== null) return false
    if (node.isText) {
      const start = Math.max(cell.from, at)
      const size = Math.min(cell.to, at + node.nodeSize) - start
      if (left <= size) found = start + left
      else left -= size
      last = start + size
    } else if (node.type.name === "note") {
      if (left === 0) found = at
      else left -= 1
      last = at + node.nodeSize
    }
    return true
  })
  return found ?? last
}

/** Top-level blocks split at the fixed ones (chapter labels and heading
 *  cells). Two documents with the same skeleton have the same stretches. */
function stretches<T>(blocks: readonly T[], fixed: (b: T) => boolean): Array<{ start: number; end: number; fixed: boolean }> {
  const out: Array<{ start: number; end: number; fixed: boolean }> = []
  let start = 0
  blocks.forEach((b, i) => {
    if (!fixed(b)) return
    out.push({ start, end: i, fixed: false })
    out.push({ start: i, end: i + 1, fixed: true })
    start = i + 1
  })
  out.push({ start, end: blocks.length, fixed: false })
  return out
}

function cellIdsIn(blocks: readonly BlockJSON[]): string[] {
  const ids: string[] = []
  for (const b of blocks) {
    if (b.type === "cellHeading") ids.push(b.attrs.cellId)
    else if (b.type === "para") for (const n of b.content ?? []) if (n.type === "verse") ids.push(n.attrs.cellId)
  }
  return ids
}

/**
 * Bring the live document up to date with `desired` for the cells in
 * `changed`, replacing only the stretches that hold them. Returns null when
 * the two documents do not share a skeleton (cells were added or removed), in
 * which case the caller replaces the whole document.
 */
export function patchChangedCells(
  state: EditorState,
  schema: Schema,
  desired: DocJSON,
  changed: ReadonlySet<string>,
): Transaction | null {
  const current: PMNode[] = []
  const offsets: number[] = []
  state.doc.forEach((node, offset) => {
    current.push(node)
    offsets.push(offset)
  })
  const isFixedNode = (n: PMNode) => n.type.name === "chapterLabel" || n.type.name === "cellHeading"
  const isFixedJson = (b: BlockJSON) => b.type === "chapterLabel" || b.type === "cellHeading"
  const now = stretches(current, isFixedNode)
  const next = stretches(desired.content, isFixedJson)
  if (now.length !== next.length) return null

  const tr = state.tr
  const head = anchorOf(state.doc, state.selection.head)
  const anchor = anchorOf(state.doc, state.selection.anchor)
  let touched = false
  for (let i = now.length - 1; i >= 0; i--) {
    const blocks = desired.content.slice(next[i].start, next[i].end)
    if (now[i].fixed !== next[i].fixed) return null
    if (!cellIdsIn(blocks).some((id) => changed.has(id))) continue
    const from = now[i].start < current.length ? offsets[now[i].start] : state.doc.content.size
    const to = now[i].end > now[i].start ? offsets[now[i].end - 1] + current[now[i].end - 1].nodeSize : from
    tr.replaceWith(from, to, Fragment.fromJSON(schema, blocks))
    touched = true
  }
  if (!touched) return null
  if (head && anchor) {
    const h = resolveAnchor(tr.doc, head)
    const a = resolveAnchor(tr.doc, anchor)
    if (h !== null && a !== null) tr.setSelection(TextSelection.create(tr.doc, a, h))
  }
  return tr.setMeta(SYNC_META, true).setMeta("addToHistory", false)
}
