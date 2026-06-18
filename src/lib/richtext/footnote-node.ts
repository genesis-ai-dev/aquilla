// Atomic inline ProseMirror node for a USFM footnote marker.
//
// Why a node (and not the old hidden-raw-text + widget decoration): keeping the
// raw `\f...\f*` as real characters and hiding them with `display:none` meant a
// drag-selection crossing a footnote ran across invisible text and a
// non-selectable widget, so the highlight "bugged out". As a single atomic,
// non-editable node the footnote behaves like one glyph — selecting text either
// side includes the whole marker and highlights it, exactly like Word.
//
// Round-trip: the canonical plain `value` still contains the raw `\f...\f*`.
//   - load:   injectFootnoteSpans() turns raw text into <span data-usfm-footnote>
//             which parseHTML() below turns into nodes.
//   - getText: renderText() emits the node's `raw` verbatim, so editor.getText()
//             reproduces the stored USFM byte-for-byte (no phantom revisions).
//   - getHTML: renderHTML() emits <span data-usfm-footnote="raw"> which feeds
//             straight back through the load path.
//
// The visible label / numbering / tooltip is supplied by the sibling decoration
// plugin (footnote-decoration-plugin.ts) so it can react to the chapter-level
// numbering offset; this NodeView just renders whatever that plugin computed.

import { Node, mergeAttributes } from "@tiptap/core"
import type { Decoration } from "@tiptap/pm/view"
import { extractUsfmFootnotes } from "@/lib/footnotes/extract"
import { FOOTNOTE_NODE_NAME } from "@/lib/richtext/usfm-plain-text"

export interface FootnoteMarkerInfo {
  label: string
  tooltip: string
  ariaLabel: string
  index: number
  showTooltips: boolean
}

/** Decoration spec key the plugin uses to hand display info to the NodeView. */
export const FOOTNOTE_DECORATION_SPEC = "footnoteMarker"

function readDecorationInfo(decorations: readonly Decoration[]): FootnoteMarkerInfo | null {
  for (const decoration of decorations) {
    const info = (decoration.spec as Record<string, unknown> | undefined)?.[FOOTNOTE_DECORATION_SPEC]
    if (info) return info as FootnoteMarkerInfo
  }
  return null
}

/** Transient fallback before the decoration plugin's set reaches the view. */
function fallbackInfo(raw: string): FootnoteMarkerInfo {
  const parsed = extractUsfmFootnotes(raw)[0]
  const caller = parsed?.caller ?? ""
  const explicit = caller && caller !== "+" && caller !== "-"
  const ref = parsed?.ref ?? ""
  const text = parsed?.text ?? ""
  const ariaLabel = `Footnote${ref ? ` ${ref}` : ""}${text ? `: ${text}` : ""}`
  return {
    label: explicit ? caller : "*",
    tooltip: text || ref || ariaLabel,
    ariaLabel,
    index: 0,
    showTooltips: true,
  }
}

export const UsfmFootnote = Node.create({
  name: FOOTNOTE_NODE_NAME,
  group: "inline",
  inline: true,
  atom: true,
  // Not NodeSelection-able: a stray/ballooned DOM selection would otherwise get
  // normalised into a NodeSelection of the marker, desyncing PM state from the
  // DOM. Deletion is handled explicitly via the Backspace/Delete keymap, so we
  // don't need NodeSelection for that.
  selectable: false,
  draggable: false,

  addAttributes() {
    return {
      raw: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-usfm-footnote") ?? "",
        renderHTML: (attributes) => ({ "data-usfm-footnote": (attributes.raw as string) ?? "" }),
      },
    }
  },

  parseHTML() {
    return [{ tag: "span[data-usfm-footnote]" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "usfm-footnote-marker" })]
  },

  // Drives editor.getText() → keeps the stored USFM byte-identical.
  renderText({ node }) {
    return (node.attrs.raw as string) ?? ""
  },

  addNodeView() {
    return ({ node, decorations }) => {
      const dom = document.createElement("span")
      dom.className = "usfm-footnote-marker"
      dom.setAttribute("role", "note")
      dom.setAttribute("contenteditable", "false")
      // NOTE: do NOT make this focusable (tabIndex). A focusable element inside
      // the contenteditable steals focus the moment a selection reaches it,
      // which blurs the editor and makes shift-selection collapse/balloon.

      const render = (raw: string, decos: readonly Decoration[]) => {
        const info = readDecorationInfo(decos) ?? fallbackInfo(raw)
        dom.dataset.footnoteIndex = String(info.index)
        dom.dataset.footnoteTooltip = info.tooltip
        dom.setAttribute("aria-label", info.ariaLabel)
        dom.replaceChildren(document.createTextNode(info.label))
        if (info.showTooltips && info.tooltip) {
          const tooltip = document.createElement("span")
          tooltip.className = "usfm-footnote-marker-tooltip"
          tooltip.setAttribute("role", "tooltip")
          tooltip.textContent = info.tooltip
          dom.append(tooltip)
        }
      }

      render((node.attrs.raw as string) ?? "", decorations)

      return {
        dom,
        ignoreMutation: () => true,
        update: (updatedNode, updatedDecorations) => {
          if (updatedNode.type.name !== FOOTNOTE_NODE_NAME) return false
          render((updatedNode.attrs.raw as string) ?? "", updatedDecorations)
          return true
        },
      }
    }
  },
})
