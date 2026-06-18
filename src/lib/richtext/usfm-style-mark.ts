// Generic preserved-inline-annotation mark.
//
// Some inline annotations carry meaning the TipTap schema doesn't model
// natively — USFM character styles (\nd, \wj, \add, \sc, …) are the first case,
// but the mechanism is deliberately NOT USFM-specific: it round-trips ANY
// `<span data-usfm="X">` through the editor by treating the carrier attribute as
// opaque data, without enumerating the set of valid annotation names. A style a
// translator restores (or that arrives in stored value_html) therefore survives
// an edit and reconstructs on export, and supporting a new annotation family
// later is a parse/render tweak here rather than a new node type per name.
//
// Scope of this mark:
//   • Emphasis (<strong>/<em>/<u>/<s>/<code>) is owned by StarterKit's marks and
//     round-trips to \bd/\it/… via the export mapper's semantic-tag fallback, so
//     it is intentionally NOT matched here.
//   • Footnotes/cross-refs (<span data-usfm-footnote>) are owned by the atomic
//     UsfmFootnote node; this mark matches `span[data-usfm]` only, which never
//     overlaps a footnote span (that carrier is data-usfm-footnote).

import { Mark, mergeAttributes } from "@tiptap/core"

export const USFM_STYLE_MARK_NAME = "usfmStyle"

export const UsfmStyle = Mark.create({
  name: USFM_STYLE_MARK_NAME,

  // Not inclusive: typing immediately after a restored run shouldn't extend the
  // annotation onto new prose — the style belongs to the words it was applied to.
  inclusive: false,

  addAttributes() {
    return {
      // The opaque annotation key (USFM marker name today). Kept verbatim; the
      // export mapper turns `data-usfm="nd"` back into \nd…\nd* generically.
      usfm: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-usfm") ?? "",
        renderHTML: (attrs) =>
          attrs.usfm ? { "data-usfm": attrs.usfm as string } : {},
      },
    }
  },

  parseHTML() {
    return [{ tag: "span[data-usfm]" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "usfm-style" }), 0]
  },
})
