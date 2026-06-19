/**
 * Terminology chip decoration plugin.
 *
 * Scans the editor doc for active Concept sourceTerm matches (case-insensitive,
 * word-boundary aware) and renders a small status-tinted chip absolutely
 * positioned at the top-right of each matched word span. The host span is
 * `position:relative`; the chip is `position:absolute` so line height is
 * NOT affected.
 *
 * Usage: wire into TranslatedEditor via the optional `terminologyConcepts` prop.
 * Chip click is annotated with `data-source-term` for FRO-204 (TermLookupPopover).
 */

import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Extension } from "@tiptap/core"
import type { Concept } from "@/lib/terminology/types"
import { buildTermRegex } from "@/lib/terminology/match"
import { buildUsfmPlainTextMap } from "@/lib/richtext/usfm-plain-text"

export const terminologyChipPluginKey = new PluginKey<DecorationSet>("terminologyChipDecorations")

/**
 * Find all case-insensitive, word-boundary matches of `term` within `text`,
 * with inflectional wildcard support (`grac*` chips grace/graced/gracia). Uses
 * the shared matcher (lib/terminology/match) so chips agree with enforcement.
 * Returns plain-text [start, end) pairs.
 *
 * Exported so the match logic can be unit-tested independently of ProseMirror.
 */
export function findTermMatches(text: string, term: string): Array<{ start: number; end: number }> {
  if (!term || !text) return []
  const pattern = buildTermRegex(term, "giu")
  if (!pattern) return []
  const results: Array<{ start: number; end: number }> = []
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text)) !== null) {
    // Zero-width matches (defensive: a term that is only `*`) would loop forever.
    if (m[0].length === 0) {
      pattern.lastIndex += 1
      continue
    }
    results.push({ start: m.index, end: m.index + m[0].length })
  }
  return results
}

/**
 * Build a DecorationSet with:
 *  - an inline decoration wrapping each match (adds `position:relative` host span)
 *  - a widget decoration at the match start rendering the chip
 */
export function buildTerminologyChipDecorationSet(
  doc: PMNode,
  concepts: Concept[],
): DecorationSet {
  // Only active concepts participate
  const activeConcepts = concepts.filter(c => c.status === "active")
  if (activeConcepts.length === 0) return DecorationSet.empty

  // Build plain-text → PM position map (footnote nodes expand to their raw
  // `\f...\f*` so matches stay aligned with the plain `value`).
  const { text: plainText, plainToPm } = buildUsfmPlainTextMap(doc)

  const decorations: Decoration[] = []

  for (const concept of activeConcepts) {
    const matches = findTermMatches(plainText, concept.sourceTerm)
    for (const match of matches) {
      const from = plainToPm[match.start]
      const to = plainToPm[match.end]
      if (from === undefined || to === undefined) continue

      // Host span: position:relative wrapper so the chip can be absolute
      decorations.push(
        Decoration.inline(from, to, {
          class: "term-chip-host",
          "data-source-term": concept.sourceTerm,
        })
      )

      // Widget chip rendered at the END of the matched span (top-right visually
      // via CSS absolute positioning on the host span)
      decorations.push(
        Decoration.widget(to, () => {
          const chip = document.createElement("span")
          chip.className = `term-chip term-chip-preferred`
          chip.setAttribute("data-source-term", concept.sourceTerm)
          chip.setAttribute("aria-label", `Managed term: ${concept.sourceTerm}`)
          chip.setAttribute("title", `Managed term: ${concept.sourceTerm}`)
          // Dot rendered via CSS content/background, text is empty
          return chip
        }, { side: 1 }) // side:1 → placed after the character, before any following content
      )
    }
  }

  return DecorationSet.create(doc, decorations)
}

export function createTerminologyChipExtension(getConcepts: () => Concept[]) {
  return Extension.create({
    name: "terminologyChipDecorations",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: terminologyChipPluginKey,
          state: {
            init: (_, state) =>
              buildTerminologyChipDecorationSet(state.doc, getConcepts()),
            apply: (tr, old, _oldState, newState) => {
              if (tr.getMeta(terminologyChipPluginKey) === "rebuild") {
                return buildTerminologyChipDecorationSet(newState.doc, getConcepts())
              }
              // Chip matches are derived from the doc text itself (unlike the
              // violation/karaoke decorations, whose inputs are external props
              // rebuilt via meta). Mapping the old set through a doc change can
              // never ADD a chip for newly typed term matches, so rebuild.
              if (tr.docChanged) return buildTerminologyChipDecorationSet(tr.doc, getConcepts())
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
