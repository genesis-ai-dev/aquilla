// The words of a text layer that the pack-A checks read (AQU-1697), for a
// worker that keeps only a compact copy of the layer in memory
// (auth-worker/src/lib/bkp/pack-loader.ts). A full layer is several MB.
//
// Kept: the number words (N1, N2), each negator with two words either side
// (M3: εἰ δὲ μή, οὐ τὴν τυχοῦσαν), and each verse's last word, whose
// punctuation says whether the sentence goes on (S3). AQU-1699 (check pack B):
// every name (P1, P3, P4), every "we" (P9, X4), and κύριος and πνεῦμα (P14).
//
// Relative imports only, no DOM: shared with the workers.

import { isNameWord } from './agreed-names'
import { isNumberCheckLemma } from './greek-numbers'
import { isNegatorLemma, negationContextIds } from './negation'
import type { TextWordInput } from './types'

export interface FullTextWord {
  lemma: string
  gloss: string
  english?: string
  after: string
  class?: string
  type?: string
  morph?: string
  person?: string
  number?: string
  case?: string
}

export interface FullTextLayer {
  verses: Readonly<Record<string, readonly string[]>>
  words: Readonly<Record<string, FullTextWord>>
}

/** AQU-1699: a word check pack B reads: a name, a "we", or κύριος / πνεῦμα. */
function isParticipantWord(word: FullTextWord): boolean {
  if (word.lemma === 'κύριος' || word.lemma === 'πνεῦμα') return true
  if ((word.person === 'first' && word.number === 'plural') || (word.class === 'pron' && /^P-1.P/.test(word.morph ?? ''))) return true
  return isNameWord(word)
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
      if (isNumberCheckLemma(word.lemma) || isParticipantWord(word)) ids.add(id)
      if (isNegatorLemma(word.lemma)) negators.push(id)
    }
    for (const id of negationContextIds(negators)) if (Object.hasOwn(layer.words, id)) ids.add(id)
  }
  return ids
}

/** The fields the checks read from a word. AQU-1699: a proper noun's type, and the case (a vocative κύριε is no title). */
export function checkWordFields(word: FullTextWord): TextWordInput {
  return {
    lemma: word.lemma,
    gloss: word.gloss,
    after: word.after,
    ...(word.english ? { english: word.english } : {}),
    ...(word.type ? { type: word.type } : {}),
    ...(word.case ? { case: word.case } : {}),
  }
}
