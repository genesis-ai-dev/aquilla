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
import type { Concept, TermMatchingSettings } from "@/lib/terminology/types"
import { buildTermRegex, findConceptMatches } from "@/lib/terminology/match"
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
 * Find every plain-text [start, end) range a CONCEPT matches: its sourceTerm
 * plus any extra `match.forms`, with mark-folding, project affixes and
 * excluded forms applied (AQU-1271). Chips therefore highlight exactly the
 * surface forms the rule engine enforces.
 */
export function findConceptMatchRanges(
  text: string,
  concept: Concept,
  termMatching?: TermMatchingSettings,
): Array<{ start: number; end: number }> {
  return findConceptMatches(text, concept, termMatching).map(({ start, end }) => ({ start, end }))
}

/**
 * Build a DecorationSet with one inline decoration wrapping each match.
 */
export function buildTerminologyChipDecorationSet(
  doc: PMNode,
  concepts: Concept[],
  termMatching?: TermMatchingSettings,
): DecorationSet {
  // Only active concepts participate
  const activeConcepts = concepts.filter(c => c.status === "active")
  if (activeConcepts.length === 0) return DecorationSet.empty

  // Build plain-text → PM position map (footnote nodes expand to their raw
  // `\f...\f*` so matches stay aligned with the plain `value`).
  const { text: plainText, plainToPm } = buildUsfmPlainTextMap(doc)

  const decorations: Decoration[] = []

  for (const concept of activeConcepts) {
    const matches = findConceptMatchRanges(plainText, concept, termMatching)
    for (const match of matches) {
      const from = plainToPm[match.start]
      const to = plainToPm[match.end]
      if (from === undefined || to === undefined) continue

      // Host span: position:relative wrapper so the chip can be absolute
      decorations.push(
        Decoration.inline(from, to, {
          class: "term-chip-host",
          "data-source-term": concept.sourceTerm,
          "aria-label": `Managed term: ${concept.sourceTerm}`,
          title: `Managed term: ${concept.sourceTerm}`,
        })
      )
    }
  }

  return DecorationSet.create(doc, decorations)
}

export function createTerminologyChipExtension(
  getConcepts: () => Concept[],
  getTermMatching?: () => TermMatchingSettings | undefined,
) {
  return Extension.create({
    name: "terminologyChipDecorations",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: terminologyChipPluginKey,
          state: {
            init: (_, state) =>
              buildTerminologyChipDecorationSet(state.doc, getConcepts(), getTermMatching?.()),
            apply: (tr, old, _oldState, newState) => {
              if (tr.getMeta(terminologyChipPluginKey) === "rebuild") {
                return buildTerminologyChipDecorationSet(newState.doc, getConcepts(), getTermMatching?.())
              }
              // Chip matches are derived from the doc text itself (unlike the
              // violation/karaoke decorations, whose inputs are external props
              // rebuilt via meta). Mapping the old set through a doc change can
              // never ADD a chip for newly typed term matches, so rebuild.
              if (tr.docChanged) return buildTerminologyChipDecorationSet(tr.doc, getConcepts(), getTermMatching?.())
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
