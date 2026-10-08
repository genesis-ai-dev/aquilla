/** Selection helpers for the "words that fit here" thesaurus menu. */

import type { Editor } from "@tiptap/core"

const WHOLE_WORD = /^[\p{L}\p{N}\p{M}]+$/u

/** The selected text when it is exactly one word (no spaces or punctuation), else null. */
export function selectedSingleWord(editor: Editor): { word: string; from: number; to: number } | null {
  const { from, to } = editor.state.selection
  if (from === to) return null
  const word = editor.state.doc.textBetween(from, to, " ", " ")
  if (!WHOLE_WORD.test(word)) return null
  return { word, from, to }
}

/** Match the replaced word's leading capital (tokens are lower-cased). */
export function matchCase(original: string, replacement: string): string {
  const first = original.charAt(0)
  if (first && first !== first.toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1)
  }
  return replacement
}
