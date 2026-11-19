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
import { candidateConcepts, findConceptMatches, findPlainTermMatches } from "@/lib/terminology/match"
import { AnchorIndex, prefilterForTerms } from "@/lib/terminology/prefilter"
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
  // AQU-2654: the pattern is cached by the term and compiled once, and a text
  // the term cannot occur in is turned away before any regex runs.
  return findPlainTermMatches(text, term)
}

interface ApprovedRenderings {
  /** Approved renderings of active concepts, in concept then rendering order. */
  entries: Array<{ rendering: string; term: string }>
  index: AnchorIndex
}

const approvedRenderings = new WeakMap<readonly Concept[], ApprovedRenderings>()

/**
 * Every match of an approved (preferred or admitted) rendering of an active
 * concept in `text`, tagged with the concept's source term — in concept order,
 * then rendering order, then position, which is the order the nested loop over
 * `findTermMatches` produced.
 *
 * AQU-2654: the read-mode target column asks this for every row. Looping over
 * the glossary there cost two regex builds per concept per row; here the
 * renderings are indexed once per termbase array and a row runs only the ones
 * that can occur in its text. The array must be replaced, not edited in place,
 * when a term changes (the matcher's caches rely on the same contract).
 */
export function findApprovedRenderingMatches(
  text: string,
  concepts: readonly Concept[],
): Array<{ start: number; end: number; term: string }> {
  if (!text || concepts.length === 0) return []
  let approved = approvedRenderings.get(concepts)
  if (!approved) {
    approved = { entries: [], index: new AnchorIndex() }
    for (const concept of concepts) {
      if (concept.status !== "active") continue
      for (const rendering of concept.renderings) {
        if (rendering.status !== "preferred" && rendering.status !== "admitted") continue
        // A blank rendering has no pattern and can never match.
        if (!rendering.rendering.trim()) continue
        approved.index.add(approved.entries.length, prefilterForTerms([rendering.rendering]))
        approved.entries.push({ rendering: rendering.rendering, term: concept.sourceTerm })
      }
    }
    approvedRenderings.set(concepts, approved)
  }
  const out: Array<{ start: number; end: number; term: string }> = []
  for (const i of approved.index.candidates(text)) {
    const { rendering, term } = approved.entries[i]
    for (const match of findPlainTermMatches(text, rendering)) out.push({ ...match, term })
  }
  return out
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
  if (concepts.length === 0) return DecorationSet.empty

  // Build plain-text → PM position map (footnote nodes expand to their raw
  // `\f...\f*` so matches stay aligned with the plain `value`).
  const { text: plainText, plainToPm } = buildUsfmPlainTextMap(doc)

  const decorations: Decoration[] = []

  // AQU-2654: this runs on every keystroke in the open cell. Only the concepts
  // that can match the text as it now stands are visited — the matcher's
  // candidate index finds them in one pass over the text — so typing costs the
  // same with a 600-term glossary as with none.
  for (const concept of candidateConcepts(plainText, concepts, termMatching)) {
    // Only active concepts participate
    if (concept.status !== "active") continue
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
