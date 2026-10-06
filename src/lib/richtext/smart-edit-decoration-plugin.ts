import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Extension } from "@tiptap/core"
import { buildUsfmPlainTextMap } from "@/lib/richtext/usfm-plain-text"
import type { SmartEditSuggestion } from "@/lib/smart-edits/client"
import { suggestionId } from "@/lib/smart-edits/store"
import { normalizeToken } from "@/lib/smart-edits/tokens"

export const smartEditPluginKey = new PluginKey<DecorationSet>("smartEditDecorations")

/** PM range for a suggestion, or null when the doc no longer has its text
 *  there — offsets were computed against the committed plain text, and a
 *  misplaced underline is worse than a missing one. */
export function smartEditRange(doc: PMNode, s: Pick<SmartEditSuggestion, "start" | "end" | "old">): { from: number; to: number } | null {
  if (s.start >= s.end) return null
  const { plainToPm } = buildUsfmPlainTextMap(doc)
  const from = plainToPm[s.start]
  const to = plainToPm[s.end]
  if (from === undefined || to === undefined || from >= to) return null
  if (normalizeToken(doc.textBetween(from, to)) !== normalizeToken(s.old)) return null
  return { from, to }
}

export function buildSmartEditDecorationSet(doc: PMNode, suggestions: readonly SmartEditSuggestion[]): DecorationSet {
  const decorations: Decoration[] = []
  for (const s of suggestions) {
    const range = smartEditRange(doc, s)
    if (!range) continue
    decorations.push(Decoration.inline(range.from, range.to, {
      class: `smart-edit-blot smart-edit-blot-${s.tier}`,
      "data-smart-edit-id": suggestionId(s),
    }))
  }
  return DecorationSet.create(doc, decorations)
}

export function createSmartEditDecorationExtension(getSuggestions: () => readonly SmartEditSuggestion[]) {
  return Extension.create({
    name: "smartEditDecorations",
    addProseMirrorPlugins() {
      return [new Plugin({
        key: smartEditPluginKey,
        state: {
          init: (_, state) => buildSmartEditDecorationSet(state.doc, getSuggestions()),
          apply: (tr, old, _oldState, newState) => {
            if (tr.getMeta(smartEditPluginKey) === "rebuild") return buildSmartEditDecorationSet(newState.doc, getSuggestions())
            // Typing inside or beside an underline means the suggestion no
            // longer describes the text; drop all of them until the next
            // commit brings fresh ones rather than map stale ranges around.
            if (tr.docChanged) return DecorationSet.empty
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
