// Computes the visible label / tooltip / ordinal for each footnote NODE and
// hands them to the node's NodeView via a node decoration. Numbering depends on
// the chapter-level `numberOffset` (footnotes in earlier cells), which lives
// outside the doc — so this rebuilds on doc change or on an explicit "rebuild"
// meta dispatched when the offset / tooltip preference changes.
//
// IMPORTANT: this set is NOT rebuilt on selection change. The selected-state
// highlight is left entirely to the browser's native text selection (it paints
// over the contenteditable=false pill just fine — verified in WebKit/Blink).
// An earlier version toggled a "selected" class here on every selectionChanged,
// which recreated every node decoration's spec object each cursor move and made
// ProseMirror re-render the footnote NodeViews' DOM mid-selection. Real Safari
// reacts to that mid-selection DOM mutation by collapsing/ballooning the live
// selection (the "selects the whole row, then corrects on the next press" bug).
//
// The footnote itself is an atomic node (see footnote-node.ts); this plugin only
// decorates it, it does not hide or render raw text.

import { Extension } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { extractUsfmFootnotes } from "@/lib/footnotes/extract"
import { FOOTNOTE_NODE_NAME } from "@/lib/richtext/usfm-plain-text"
import { FOOTNOTE_DECORATION_SPEC, type FootnoteMarkerInfo } from "@/lib/richtext/footnote-node"

export const footnoteDecorationPluginKey = new PluginKey<DecorationSet>("footnoteDecorations")
export const footnoteSelectionPluginKey = new PluginKey<DecorationSet>("footnoteSelectionOverlay")

function docHasFootnote(doc: PMNode): boolean {
  let found = false
  doc.descendants((node) => {
    if (found) return false
    if (node.type.name === FOOTNOTE_NODE_NAME) {
      found = true
      return false
    }
    return true
  })
  return found
}

/**
 * Draw the text selection ourselves, positioned by document position, for cells
 * that contain footnotes. Safari mis-paints the native selection rectangles
 * around our contenteditable=false footnote pills (it highlights the adjacent
 * region when a selection edge lands at an element offset next to the atom), so
 * we hide the native paint (see .usfm-fn-editor ::selection in index.css) and
 * render an inline decoration over the live selection range instead. PM maps
 * the range to the DOM by position, sidestepping Safari's broken selection-rect
 * math entirely. Only active when the cell has a footnote AND the selection is a
 * non-empty text range.
 */
function buildSelectionOverlay(doc: PMNode, from: number, to: number, empty: boolean): DecorationSet {
  if (empty || from === to || !docHasFootnote(doc)) return DecorationSet.empty
  return DecorationSet.create(doc, [
    Decoration.inline(from, to, { class: "usfm-text-sel" }),
  ])
}

export function buildFootnoteDecorationSet(
  doc: PMNode,
  numberOffset = 0,
  showTooltips = true,
): DecorationSet {
  const decorations: Decoration[] = []
  let ordinal = 0
  doc.descendants((node, pos) => {
    if (node.type.name !== FOOTNOTE_NODE_NAME) return true
    const raw = (node.attrs.raw as string) ?? ""
    const parsed = extractUsfmFootnotes(raw)[0]
    const caller = parsed?.caller ?? ""
    const ref = parsed?.ref ?? ""
    const text = parsed?.text ?? ""
    const explicit = caller && caller !== "+" && caller !== "-"
    const ariaLabel = `Footnote${ref ? ` ${ref}` : ""}${text ? `: ${text}` : ""}`
    const info: FootnoteMarkerInfo = {
      label: explicit ? caller : String(numberOffset + ordinal + 1),
      tooltip: text || ref || ariaLabel,
      ariaLabel,
      index: ordinal,
      showTooltips,
    }
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {}, { [FOOTNOTE_DECORATION_SPEC]: info }),
    )
    ordinal += 1
    return false
  })
  return decorations.length === 0 ? DecorationSet.empty : DecorationSet.create(doc, decorations)
}

export function createFootnoteDecorationExtension(
  getNumberOffset: () => number = () => 0,
  shouldShowTooltips: () => boolean = () => true,
) {
  return Extension.create({
    name: "footnoteDecorations",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: footnoteDecorationPluginKey,
          state: {
            init: (_, state) => buildFootnoteDecorationSet(
              state.doc,
              getNumberOffset(),
              shouldShowTooltips(),
            ),
            apply: (tr, old) => {
              if (tr.docChanged || tr.getMeta(footnoteDecorationPluginKey) === "rebuild") {
                return buildFootnoteDecorationSet(
                  tr.doc,
                  getNumberOffset(),
                  shouldShowTooltips(),
                )
              }
              return old.map(tr.mapping, tr.doc)
            },
          },
          props: {
            decorations(state) {
              return this.getState(state)
            },
          },
        }),
        new Plugin({
          key: footnoteSelectionPluginKey,
          state: {
            init: (_, state) => buildSelectionOverlay(
              state.doc,
              state.selection.from,
              state.selection.to,
              state.selection.empty,
            ),
            apply: (tr, old, oldState, newState) => {
              if (tr.docChanged || !oldState.selection.eq(newState.selection) || !old) {
                return buildSelectionOverlay(
                  newState.doc,
                  newState.selection.from,
                  newState.selection.to,
                  newState.selection.empty,
                )
              }
              return old
            },
          },
          props: {
            // Tag the editor root so the CSS that hides native ::selection and
            // styles .usfm-text-sel only applies to footnote-bearing cells.
            attributes(state): { [name: string]: string } {
              return { class: docHasFootnote(state.doc) ? "usfm-fn-editor" : "" }
            },
            decorations(state) {
              return footnoteSelectionPluginKey.getState(state)
            },
          },
        }),
      ]
    },
  })
}
