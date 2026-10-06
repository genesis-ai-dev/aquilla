// The words of a text layer that the pack-A checks read (AQU-1697), for a
// worker that keeps only a compact copy of the layer in memory
// (auth-worker/src/lib/bkp/pack-loader.ts). A full layer is several MB.
//
// Kept: the number words (N1, N2), each negator with two words either side
// (M3: εἰ δὲ μή, οὐ τὴν τυχοῦσαν), and each verse's last word, whose
// punctuation says whether the sentence goes on (S3).
//
// Relative imports only, no DOM: shared with the workers.

import { isNumberCheckLemma } from './greek-numbers'
import { isNegatorLemma, negationContextIds } from './negation'
import type { TextWordInput } from './types'

export interface FullTextWord {
  lemma: string
  gloss: string
  english?: string
  after: string
}

export interface FullTextLayer {
  verses: Readonly<Record<string, readonly string[]>>
  words: Readonly<Record<string, FullTextWord>>
}

/** The ids of the words the checks read. */
export function checkWordIds(layer: FullTextLayer): Set<string> {
  const ids = new Set<string>()
  for (const verseIds of Object.values(layer.verses)) {
    if (!Array.isArray(verseIds) || verseIds.length === 0) continue
    ids.add(verseIds[verseIds.length - 1])
    const negators: string[] = []
    for (const id of verseIds) {
      const word = Object.hasOwn(layer.words, id) ? layer.words[id] : undefined
      if (!word || typeof word.lemma !== 'string') continue
      if (isNumberCheckLemma(word.lemma)) ids.add(id)
      if (isNegatorLemma(word.lemma)) negators.push(id)
    }
    for (const id of negationContextIds(negators)) if (Object.hasOwn(layer.words, id)) ids.add(id)
  }
  return ids
}

/** The fields the checks read from a word. */
export function checkWordFields(word: FullTextWord): TextWordInput {
  return { lemma: word.lemma, gloss: word.gloss, after: word.after, ...(word.english ? { english: word.english } : {}) }
}
