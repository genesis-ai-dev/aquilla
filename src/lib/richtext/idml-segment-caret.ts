import { Extension } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { Plugin } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import type { IdmlStyleCatalog } from "@aquilla/idml-roundtrip"
import {
  IDML_PARAGRAPH_NODE_NAME,
  IDML_SLOT_NODE_NAME,
  IDML_TOKEN_NODE_NAME,
} from "@/lib/richtext/idml-editor"
import {
  IDML_PLAIN_GROUP_ATTR,
  idmlCharacterStyleEmphasis,
  idmlSlotHasVisibleContent,
} from "@/lib/richtext/idml-style-display"
import { getVisibleStyleSegments } from "@/lib/store/visible-style-segments-pref"

export const IDML_SEGMENT_CARET_CLASS = "idml-segment-caret"

interface SlotSpan {
  /** Position of the first character inside the slot. */
  start: number
  /** Position after the last character inside the slot. Equal to `start` when empty. */
  end: number
  /** Position of the slot node itself, for the caret decoration. */
  nodeFrom: number
  nodeTo: number
  /** Bold or italic. Plain runs are invisible, so the caret walks through them. */
  emphasis: boolean
}

export interface IdmlSegmentCaretContext {
  catalog?: IdmlStyleCatalog
  paragraphStyleId?: string
}

function editableSlotSpans(doc: ProseMirrorNode, context?: IdmlSegmentCaretContext): SlotSpan[] {
  const spans: SlotSpan[] = []
  doc.descendants((node, position) => {
    if (node.type.name !== IDML_SLOT_NODE_NAME) return true
    if (node.attrs.editable === false) return false
    const start = position + 1
    spans.push({
      start,
      end: start + node.content.size,
      nodeFrom: position,
      nodeTo: position + node.nodeSize,
      emphasis: slotIsEmphasis(node, context),
    })
    return false
  })
  return spans
}

function slotIsEmphasis(node: ProseMirrorNode, context?: IdmlSegmentCaretContext): boolean {
  const styleId = String(node.attrs.characterStyle ?? "")
  const paragraphStyleId = context?.paragraphStyleId
  const inherit = Boolean(paragraphStyleId) && isDefaultCharacterStyle(styleId)
  const face = idmlCharacterStyleEmphasis(
    inherit ? paragraphStyleId! : styleId,
    context?.catalog,
  )
  return face.bold || face.italic
}

function isDefaultCharacterStyle(styleId: string): boolean {
  if (!styleId) return true
  return styleId.includes("[No character style]")
}

/**
 * Arrow movement while bold and italic runs are the only visible blocks.
 *
 * Inside a run the browser still moves a character at a time. At a plain run's
 * edge, one press continues a character into the next plain run, skipping
 * empty plain runs, so the regular text feels like one sentence. Entering or
 * leaving a bold or italic run stops at that block, including an empty one,
 * so the next characters typed belong to it.
 *
 * Returns null when the caret is not on a boundary this should handle.
 */
export function idmlSegmentCaretStep(
  doc: ProseMirrorNode,
  selection: { empty: boolean; from: number },
  direction: "forward" | "backward",
  context?: IdmlSegmentCaretContext,
): number | null {
  if (!selection.empty) return null
  const pos = selection.from
  const spans = editableSlotSpans(doc, context)
  const index = spans.findIndex((span) => pos >= span.start && pos <= span.end)
  if (index < 0) {
    if (direction === "forward") {
      return spans.find((span) => span.start > pos)?.start ?? null
    }
    for (let cursor = spans.length - 1; cursor >= 0; cursor -= 1) {
      const span = spans[cursor]
      if (span && span.end < pos) return span.end
    }
    return null
  }
  const span = spans[index]
  if (!span) return null
  if (direction === "forward") {
    if (pos !== span.end) return null
    return landInNeighbour(spans, index, "forward")
  }
  if (pos !== span.start) return null
  return landInNeighbour(spans, index, "backward")
}

function landInNeighbour(
  spans: readonly SlotSpan[],
  fromIndex: number,
  direction: "forward" | "backward",
): number | null {
  const origin = spans[fromIndex]
  if (!origin) return null
  let nextIndex = direction === "forward" ? fromIndex + 1 : fromIndex - 1
  while (nextIndex >= 0 && nextIndex < spans.length) {
    const next = spans[nextIndex]
    if (!next) return null
    if (!next.emphasis && next.end === next.start) {
      nextIndex += direction === "forward" ? 1 : -1
      continue
    }
    if (next.emphasis || origin.emphasis) {
      return direction === "forward" ? next.start : next.end
    }
    return direction === "forward"
      ? Math.min(next.start + 1, next.end)
      : Math.max(next.end - 1, next.start)
  }
  return null
}

/**
 * One decoration per empty plain slot in a consecutive run. The first slot of
 * an empty run is the single Regular label; the rest join that typing space.
 * ProseMirror applies these itself, so they do not feed back into the document.
 */
function plainGroupDecorations(
  doc: ProseMirrorNode,
  context?: IdmlSegmentCaretContext,
): Decoration[] {
  const decorations: Decoration[] = []
  doc.descendants((paragraph, position) => {
    if (paragraph.type.name !== IDML_PARAGRAPH_NODE_NAME) return true
    let group: { from: number; to: number; empty: boolean }[] = []
    const close = () => {
      const anyText = group.some((slot) => !slot.empty)
      group.forEach((slot, index) => {
        if (!slot.empty) return
        decorations.push(Decoration.node(slot.from, slot.to, {
          [IDML_PLAIN_GROUP_ATTR]: !anyText && index === 0 ? "label" : "join",
        }))
      })
      group = []
    }
    let cursor = position + 1
    paragraph.forEach((child) => {
      const from = cursor
      cursor += child.nodeSize
      if (child.type.name === IDML_TOKEN_NODE_NAME || child.type.name !== IDML_SLOT_NODE_NAME) {
        close()
        return
      }
      if (slotIsEmphasis(child, context)) {
        close()
        return
      }
      let text = ""
      let hasBreak = false
      child.forEach((content) => {
        if (content.type.name === "hardBreak") hasBreak = true
        else if (content.isText) text += content.text ?? ""
      })
      group.push({
        from,
        to: cursor,
        empty: !idmlSlotHasVisibleContent(text, hasBreak),
      })
    })
    close()
    return false
  })
  return decorations
}

/** Outlines the bold or italic run that currently holds the caret. Plain runs stay unmarked. */
export function createIdmlActiveSegmentExtension(): Extension {
  return Extension.create({
    name: "idmlActiveSegment",
    addProseMirrorPlugins() {
      const editor = this.editor
      return [new Plugin({
        props: {
          decorations(state) {
            const guard = editor.storage.idmlTransactionGuard
            const context = {
              catalog: guard?.styleCatalog,
              paragraphStyleId: guard?.paragraphStyleId,
            }
            const decorations = plainGroupDecorations(state.doc, context)
            if (getVisibleStyleSegments() && state.selection.empty) {
              const span = editableSlotSpans(state.doc, context).find((candidate) => (
                candidate.emphasis
                && state.selection.from >= candidate.start
                && state.selection.from <= candidate.end
              ))
              if (span) {
                decorations.push(Decoration.node(span.nodeFrom, span.nodeTo, {
                  class: IDML_SEGMENT_CARET_CLASS,
                }))
              }
            }
            if (decorations.length === 0) return null
            return DecorationSet.create(state.doc, decorations)
          },
        },
      })]
    },
  })
}
