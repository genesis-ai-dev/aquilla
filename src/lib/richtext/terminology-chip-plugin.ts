/**
 * Terminology highlight decoration plugin.
 *
 * Scans the editor doc for active Concept sourceTerm matches (case-insensitive,
 * word-boundary aware) and wraps each match in the shared, subtle terminology
 * highlight. The matched term itself is the lookup target.
 *
 * Usage: wire into TranslatedEditor via the optional `terminologyConcepts` prop.
 * Clicks are annotated with `data-source-term` for AQU-204 (TermLookupPopover).
 */

import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Extension } from "@tiptap/core"
import type { Concept, RenderingStatus } from "@/lib/terminology/types"
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
 * The status a concept's highlight carries: the status of its best-ranked
 * rendering, using the same `preferred > admitted > forbidden` precedence
 * TermLookupPopover sorts renderings by, so the highlight and the popover never
 * disagree about which guidance a term carries.
 *
 * A concept whose renderings are *all* forbidden offers the translator no
 * acceptable option, so it reads `forbidden`. A concept with no renderings at
 * all carries no guidance yet, so it reads neutral (`admitted`) rather than
 * claiming a preference it does not have.
 *
 * Exported so the precedence can be unit-tested without ProseMirror.
 */
export function conceptChipStatus(concept: Concept): RenderingStatus {
  if (concept.renderings.some((r) => r.status === "preferred")) return "preferred"
  if (concept.renderings.some((r) => r.status === "admitted")) return "admitted"
  if (concept.renderings.some((r) => r.status === "forbidden")) return "forbidden"
  return "admitted"
}

/**
 * Build a DecorationSet with one inline decoration wrapping each match.
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
    // The status-tinted dot this used to drive is gone (AQU-1006/AQU-1110: one
    // quiet highlight marks a managed term, violation blots mark misuse), so
    // the status rides on the highlight itself, non-visually.
    const status = conceptChipStatus(concept)
    const label = `Managed term: ${concept.sourceTerm} (${status})`
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
          "data-status": status,
          "aria-label": label,
          title: label,
        })
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
