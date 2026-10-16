import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Extension } from "@tiptap/core"
import { HEALTH_SPAN_CLASS, type DraftHealthSpan } from "@/lib/completion/draft-health-spans"
import { buildUsfmPlainTextMap } from "@/lib/richtext/usfm-plain-text"

export const healthScorePluginKey = new PluginKey<DecorationSet>("healthScoreDecorations")

export interface HealthScoreDecorationSpan extends DraftHealthSpan {
  title?: string
}

export function buildHealthScoreDecorationSet(
  doc: PMNode,
  spans: readonly HealthScoreDecorationSpan[],
): DecorationSet {
  if (spans.length === 0) return DecorationSet.empty
  const decorations: Decoration[] = []
  const { plainToPm } = buildUsfmPlainTextMap(doc)

  for (const span of spans) {
    if (span.start >= span.end) continue
    const from = plainToPm[span.start]
    const to = plainToPm[span.end]
    if (from === undefined || to === undefined) continue
    decorations.push(Decoration.inline(from, to, {
      class: HEALTH_SPAN_CLASS[span.kind],
      "data-health-span": span.kind,
      ...(span.title ? { title: span.title } : {}),
    }))
  }
  return DecorationSet.create(doc, decorations)
}

export function createHealthScoreDecorationExtension(
  getSpans: () => readonly HealthScoreDecorationSpan[],
) {
  return Extension.create({
    name: "healthScoreDecorations",
    addProseMirrorPlugins() {
      return [new Plugin({
        key: healthScorePluginKey,
        state: {
          init: (_, state) => buildHealthScoreDecorationSet(state.doc, getSpans()),
          apply: (tr, old, _oldState, newState) => {
            if (tr.getMeta(healthScorePluginKey) === "rebuild") {
              return buildHealthScoreDecorationSet(newState.doc, getSpans())
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
