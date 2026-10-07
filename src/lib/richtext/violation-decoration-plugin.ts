import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Extension } from "@tiptap/core"
import type { RuleInfraction } from "@/lib/parsers/types"
import { buildUsfmPlainTextMap } from "@/lib/richtext/usfm-plain-text"
import { isSpanWaived, spanMatchHash } from "@/lib/rules/waivers"

export const violationPluginKey = new PluginKey<DecorationSet>("violationDecorations")

/**
 * AQU-1740: `waivedKeys` holds one key per active waiver on the cell —
 * `waiverKey(ruleId)` for a cell-wide waiver, `waiverKey(ruleId, matchHash)`
 * for a single accepted finding. A blot is drawn waived only when ITS OWN span
 * is covered, so accepting one repeated word leaves the next one red.
 */
export function buildViolationDecorationSet(
  doc: PMNode,
  infractions: RuleInfraction[],
  ruleSeverity: Map<string, "major" | "minor">,
  waivedKeys: Set<string>,
): DecorationSet {
  const decorations: Decoration[] = []
  // Convert plain-text offsets into ProseMirror positions by walking the doc
  // in reading order. Footnote nodes contribute their raw `\f...\f*` length so
  // offsets computed against the plain `value` stay aligned. For a
  // single-paragraph cell this reduces to pm_pos = plain_offset + 1.
  const { plainToPm } = buildUsfmPlainTextMap(doc)

  for (const inf of infractions) {
    for (const span of inf.spans) {
      if (span.side !== "target") continue
      if (span.start >= span.end) continue
      const from = plainToPm[span.start]
      const to = plainToPm[span.end]
      if (from === undefined || to === undefined) continue
      const severity = ruleSeverity.get(inf.ruleId) ?? "major"
      const waived = isSpanWaived(waivedKeys, inf.ruleId, span)
      // AQU-1740: the blot names the finding it covers, so a click can waive
      // just this match instead of the rule across the whole cell.
      const findingHash = spanMatchHash(span)
      const isTerminologyRule = inf.ruleId.startsWith("term:")
      const cls = [
        "violation-blot",
        waived
          ? "violation-blot-waived"
          : severity === "major"
            ? "violation-blot-major"
            : "violation-blot-minor",
        isTerminologyRule ? "violation-blot-term" : "",
      ].filter(Boolean).join(" ")
      decorations.push(Decoration.inline(from, to, {
        class: cls,
        "data-rule-id": inf.ruleId,
        ...(findingHash ? { "data-match-hash": findingHash } : {}),
      }))
    }
  }
  return DecorationSet.create(doc, decorations)
}

export function createViolationDecorationExtension(getState: () => {
  infractions: RuleInfraction[]
  ruleSeverity: Map<string, "major" | "minor">
  waivedKeys: Set<string>
}) {
  return Extension.create({
    name: "violationDecorations",
    addProseMirrorPlugins() {
      return [new Plugin({
        key: violationPluginKey,
        state: {
          init: (_, state) => {
            const s = getState()
            return buildViolationDecorationSet(state.doc, s.infractions, s.ruleSeverity, s.waivedKeys)
          },
          apply: (tr, old, _oldState, newState) => {
            if (tr.getMeta(violationPluginKey) === "rebuild") {
              const s = getState()
              return buildViolationDecorationSet(newState.doc, s.infractions, s.ruleSeverity, s.waivedKeys)
            }
            if (tr.docChanged) return old.map(tr.mapping, tr.doc)
            return old
          },
        },
        props: {
          decorations(state) { return this.getState(state) },
        },
      })]
    },
  })
}
