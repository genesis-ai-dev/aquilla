import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Extension } from "@tiptap/core"
import type { RuleInfraction } from "@/lib/parsers/types"

export const violationPluginKey = new PluginKey<DecorationSet>("violationDecorations")

export function buildViolationDecorationSet(
  doc: PMNode,
  infractions: RuleInfraction[],
  ruleSeverity: Map<string, "major" | "minor">,
  waivedRuleIds: Set<string>,
): DecorationSet {
  const decorations: Decoration[] = []
  // Convert plain-text offsets into ProseMirror positions by walking the doc
  // in reading order. For a single-paragraph cell (the common case —
  // TranslatedEditor disables headings/lists/blockquote), this reduces to
  // pm_pos = plain_offset + 1. Multi-paragraph cells will still work for
  // spans that live entirely inside one paragraph; spans crossing a
  // paragraph boundary are a follow-up (rare in translation cells).
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

  for (const inf of infractions) {
    for (const span of inf.spans) {
      if (span.side !== "target") continue
      const from = plainToPm[span.start]
      const to = plainToPm[span.end]
      if (from === undefined || to === undefined) continue
      const severity = ruleSeverity.get(inf.ruleId) ?? "major"
      const waived = waivedRuleIds.has(inf.ruleId)
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
      }))
    }
  }
  return DecorationSet.create(doc, decorations)
}

export function createViolationDecorationExtension(getState: () => {
  infractions: RuleInfraction[]
  ruleSeverity: Map<string, "major" | "minor">
  waivedRuleIds: Set<string>
}) {
  return Extension.create({
    name: "violationDecorations",
    addProseMirrorPlugins() {
      return [new Plugin({
        key: violationPluginKey,
        state: {
          init: (_, state) => {
            const s = getState()
            return buildViolationDecorationSet(state.doc, s.infractions, s.ruleSeverity, s.waivedRuleIds)
          },
          apply: (tr, old, _oldState, newState) => {
            if (tr.getMeta(violationPluginKey) === "rebuild") {
              const s = getState()
              return buildViolationDecorationSet(newState.doc, s.infractions, s.ruleSeverity, s.waivedRuleIds)
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
