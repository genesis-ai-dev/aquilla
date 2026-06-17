import { Extension } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { extractUsfmFootnotes } from "@/lib/footnotes/extract"

export const footnoteDecorationPluginKey = new PluginKey<DecorationSet>("footnoteDecorations")

export function buildFootnoteDecorationSet(doc: PMNode, numberOffset = 0, showTooltips = true): DecorationSet {
  const plainToPm: number[] = []
  let plainCursor = 0
  doc.descendants((node, pos) => {
    if (node.isText) {
      const len = node.text?.length ?? 0
      for (let i = 0; i <= len; i++) plainToPm[plainCursor + i] = pos + i
      plainCursor += len
    }
  })
  if (!(plainCursor in plainToPm)) plainToPm[plainCursor] = doc.content.size

  let plainText = ""
  doc.descendants((node) => {
    if (node.isText) plainText += node.text ?? ""
  })

  const footnotes = extractUsfmFootnotes(plainText)
  if (footnotes.length === 0) return DecorationSet.empty

  const decorations: Decoration[] = []
  footnotes.forEach((footnote, index) => {
    const from = plainToPm[footnote.index]
    const to = plainToPm[footnote.index + footnote.raw.length]
    if (from === undefined || to === undefined) return

    const label = footnote.caller && footnote.caller !== "+" && footnote.caller !== "-"
      ? footnote.caller
      : String(numberOffset + index + 1)
    const ariaLabel = `Footnote${footnote.ref ? ` ${footnote.ref}` : ""}${footnote.text ? `: ${footnote.text}` : ""}`
    const tooltip = footnote.text || footnote.ref || ariaLabel

    decorations.push(
      Decoration.widget(to, () => {
        const marker = document.createElement("span")
        marker.className = "usfm-footnote-marker"
        marker.setAttribute("aria-label", ariaLabel)
        marker.setAttribute("role", "note")
        marker.tabIndex = 0
        marker.dataset.footnoteIndex = String(index)
        marker.dataset.footnoteTooltip = tooltip
        marker.append(document.createTextNode(label))
        if (showTooltips) {
          const tooltipNode = document.createElement("span")
          tooltipNode.className = "usfm-footnote-marker-tooltip"
          tooltipNode.setAttribute("role", "tooltip")
          tooltipNode.textContent = tooltip
          marker.append(tooltipNode)
        }
        return marker
      }, { side: -1 }),
    )
    decorations.push(
      Decoration.inline(from, to, {
        class: "usfm-footnote-raw",
        style: "display: none;",
        "aria-hidden": "true",
      }),
    )
  })

  return DecorationSet.create(doc, decorations)
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
            init: (_, state) => buildFootnoteDecorationSet(state.doc, getNumberOffset(), shouldShowTooltips()),
            apply: (tr, old, _oldState, newState) => {
              if (tr.docChanged || tr.getMeta(footnoteDecorationPluginKey) === "rebuild") {
                return buildFootnoteDecorationSet(newState.doc, getNumberOffset(), shouldShowTooltips())
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
