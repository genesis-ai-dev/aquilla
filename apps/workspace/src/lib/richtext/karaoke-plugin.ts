// Tiptap extension that paints the active word as audio plays. The active
// index is computed externally (in TranslatedEditor, off the audio
// controller's currentTime) and pushed in via a meta-transaction so we
// don't redraw 60Hz — only when the active word actually changes.

import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Extension } from "@tiptap/core"
import type { WordTiming } from "@/lib/codex-editor/types"

export const karaokePluginKey = new PluginKey<DecorationSet>("karaokeDecorations")

export interface KaraokePluginState {
  timings: WordTiming[] | undefined
  activeIdx: number
  onSeekToWord?: (wordIdx: number, timing: WordTiming) => void
}

export function buildKaraokeDecorationSet(
  doc: PMNode,
  timings: WordTiming[] | undefined,
  activeIdx: number,
): DecorationSet {
  if (!timings || activeIdx < 0 || activeIdx >= timings.length) {
    return DecorationSet.empty
  }
  const w = timings[activeIdx]
  const { fromMap, toMap } = buildPlainMaps(doc)
  const from = fromMap[w.start]
  const to = toMap[w.end]
  if (from === undefined || to === undefined) return DecorationSet.empty
  if (from >= to) return DecorationSet.empty
  return DecorationSet.create(doc, [
    Decoration.inline(from, to, { class: "karaoke-active" }),
  ])
}

interface PlainMaps {
  /** plain offset → first PM position INSIDE the doc that yields that length.
   *  Used for the START of a decoration (so we never anchor at pos 0). */
  fromMap: number[]
  /** plain offset → first PM position that yields that length (including
   *  pos 0). Used for the END of a decoration. */
  toMap: number[]
}

function buildPlainMaps(doc: PMNode): PlainMaps {
  // Mirror getPlainText's "\n between blocks, \n for hardBreak" convention so
  // WordTiming offsets (computed against the cell's plain text) map correctly
  // even when the cell has multiple paragraphs or hard breaks.
  const totalSize = doc.content.size
  const fromMap: number[] = []
  const toMap: number[] = []
  for (let pmPos = 0; pmPos <= totalSize; pmPos++) {
    const plainLen = doc.textBetween(0, pmPos, "\n", "\n").length
    if (toMap[plainLen] === undefined) toMap[plainLen] = pmPos
    if (pmPos > 0 && fromMap[plainLen] === undefined) fromMap[plainLen] = pmPos
  }
  return { fromMap, toMap }
}

function pmPosToPlain(doc: PMNode, pmPos: number): number | null {
  if (pmPos < 0 || pmPos > doc.content.size) return null
  return doc.textBetween(0, pmPos, "\n", "\n").length
}

export function createKaraokeExtension(getState: () => KaraokePluginState) {
  return Extension.create({
    name: "karaokeDecorations",
    addProseMirrorPlugins() {
      return [new Plugin({
        key: karaokePluginKey,
        state: {
          init: (_, state) => {
            const s = getState()
            return buildKaraokeDecorationSet(state.doc, s.timings, s.activeIdx)
          },
          apply: (tr, old, _oldState, newState) => {
            if (tr.getMeta(karaokePluginKey) === "rebuild") {
              const s = getState()
              return buildKaraokeDecorationSet(newState.doc, s.timings, s.activeIdx)
            }
            if (tr.docChanged) return old.map(tr.mapping, tr.doc)
            return old
          },
        },
        props: {
          decorations(state) {
            return karaokePluginKey.getState(state)
          },
          handleClick(view, pos, event) {
            // Alt+click on a word → seek audio to that word's start. Plain
            // clicks fall through to normal cursor positioning.
            if (!event.altKey) return false
            const s = getState()
            if (!s.onSeekToWord || !s.timings || s.timings.length === 0) return false
            const plain = pmPosToPlain(view.state.doc, pos)
            if (plain === null) return false
            for (let i = 0; i < s.timings.length; i++) {
              const t = s.timings[i]
              if (plain >= t.start && plain < t.end) {
                s.onSeekToWord(i, t)
                return true
              }
            }
            return false
          },
        },
      })]
    },
  })
}
