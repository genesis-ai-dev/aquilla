// Computes the visible label / tooltip / ordinal for each footnote NODE and
// hands them to the node's NodeView via a node decoration. Numbering depends on
// the chapter-level `numberOffset` (footnotes in earlier cells), which lives
// outside the doc — so this rebuilds on doc change or on an explicit "rebuild"
// meta dispatched when the offset / tooltip preference changes.
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

/** Selection range (or null) used to highlight footnotes that fall inside it. */
interface SelectionRange {
  from: number
  to: number
}

export function buildFootnoteDecorationSet(
  doc: PMNode,
  numberOffset = 0,
  showTooltips = true,
  selection: SelectionRange | null = null,
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
    // The browser can't paint its text-selection highlight onto a
    // contenteditable=false pill, so when the node sits fully inside the
    // selection we add a class (PM applies it to the NodeView DOM) that mimics
    // the native highlight — making the marker read as selected, like Word.
    const selected = selection !== null && selection.from <= pos && selection.to >= pos + node.nodeSize
    decorations.push(
      Decoration.node(
        pos,
        pos + node.nodeSize,
        selected ? { class: "usfm-footnote-marker-selected" } : {},
        { [FOOTNOTE_DECORATION_SPEC]: info },
      ),
    )
    ordinal += 1
    return false
  })
  return decorations.length === 0 ? DecorationSet.empty : DecorationSet.create(doc, decorations)
}

function selectionRange(state: { selection: { from: number; to: number; empty: boolean } }): SelectionRange | null {
  const { selection } = state
  return selection.empty ? null : { from: selection.from, to: selection.to }
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
              selectionRange(state),
            ),
            apply: (tr, old, oldState, newState) => {
              const selectionChanged = !oldState.selection.eq(newState.selection)
              if (tr.docChanged || selectionChanged || tr.getMeta(footnoteDecorationPluginKey) === "rebuild") {
                return buildFootnoteDecorationSet(
                  newState.doc,
                  getNumberOffset(),
                  shouldShowTooltips(),
                  selectionRange(newState),
                )
              }
              return old
            },
          },
          props: {
            decorations(state) {
              return this.getState(state)
            },
          },
        }),
      ]
    },
  })
}
