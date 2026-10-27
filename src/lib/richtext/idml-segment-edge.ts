/**
 * Apply a style-segment edge drag inside the protected IDML editor.
 * The transaction only replaces slot text; the guard still refuses a change
 * that would drop an anchor.
 */

import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import type { EditorView } from "@tiptap/pm/view"
import {
  reflowSegmentEdge,
  slotEmphasis,
  type SegmentEdge,
  type SegmentEdgeContext,
  type SegmentPiece,
} from "@/lib/idml/segment-edge"
import {
  IDML_PARAGRAPH_NODE_NAME,
  IDML_SLOT_NODE_NAME,
  IDML_TOKEN_NODE_NAME,
} from "@/lib/richtext/idml-editor"

function slotText(node: ProseMirrorNode): { text: string; broken: boolean } {
  let text = ""
  let broken = false
  node.forEach((child) => {
    if (child.type.name === "hardBreak") {
      broken = true
      text += "\n"
      return
    }
    if (child.isText) text += (child.text ?? "").replace(/\u200b/g, "")
  })
  return { text, broken }
}

export function segmentPiecesFromDoc(
  doc: ProseMirrorNode,
  context?: SegmentEdgeContext,
): SegmentPiece[] {
  const pieces: SegmentPiece[] = []
  doc.descendants((node) => {
    if (node.type.name !== IDML_PARAGRAPH_NODE_NAME) return true
    if (pieces.length > 0) pieces.push({ kind: "barrier" })
    node.forEach((child) => {
      if (child.type.name === IDML_TOKEN_NODE_NAME) {
        pieces.push({ kind: "barrier" })
        return
      }
      if (child.type.name !== IDML_SLOT_NODE_NAME) return
      const { text, broken } = slotText(child)
      const index = Number(child.attrs.slot)
      if (!Number.isInteger(index)) return
      pieces.push({
        kind: "slot",
        index,
        text,
        emphasis: slotEmphasis(String(child.attrs.characterStyle ?? ""), context),
        editable: child.attrs.editable !== false,
        broken,
      })
    })
    return false
  })
  return pieces
}

/** Replace the listed slots' text. Later slots are edited first so positions stay valid. */
export function applyIdmlSegmentEdge(
  view: EditorView,
  slotIndex: number,
  edge: SegmentEdge,
  boundary: number,
  context?: SegmentEdgeContext,
): boolean {
  const pieces = segmentPiecesFromDoc(view.state.doc, context)
  const updates = reflowSegmentEdge(pieces, slotIndex, edge, boundary)
  if (!updates || updates.size === 0) return false

  const located: { pos: number; node: ProseMirrorNode; text: string }[] = []
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== IDML_SLOT_NODE_NAME) return true
    const index = Number(node.attrs.slot)
    const text = updates.get(index)
    if (text === undefined) return false
    located.push({ pos, node, text })
    return false
  })
  if (located.length === 0) return false
  located.sort((left, right) => right.pos - left.pos)

  const { schema } = view.state
  let transaction = view.state.tr
  for (const slot of located) {
    const mapped = transaction.mapping.map(slot.pos)
    const current = transaction.doc.nodeAt(mapped)
    if (!current || current.type.name !== IDML_SLOT_NODE_NAME) return false
    const from = mapped + 1
    const to = mapped + current.nodeSize - 1
    if (slot.text.length === 0) {
      if (to > from) transaction = transaction.delete(from, to)
      continue
    }
    const textNode = schema.text(slot.text)
    transaction = to > from
      ? transaction.replaceWith(from, to, textNode)
      : transaction.insert(from, textNode)
  }
  if (!transaction.docChanged) return false
  view.dispatch(transaction)
  return true
}
