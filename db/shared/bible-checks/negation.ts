// Negation for M3 (AQU-1697; design doc §7.5): how many negations the Greek
// makes in a cell, and how many negators a translation has.
//
// The structure layer lists each verse's negators: Macula words whose lemma is
// οὐ, μή, οὐδέ, οὐδείς, οὐκέτι, … (bible-wiki pipeline/src/bkp/structure-layer.ts).
// A translation needs one negator per NEGATION, not per Greek word. With the
// text layer's lemmas and punctuation, negators in one clause make one:
//   • οὐ μή is one emphatic "never": οὐ μὴ διψήσει (JHN 4:14), οὐ γὰρ μή (GAL 4:30);
//   • a compound negative beside another negative strengthens it: οὐκ ἔφαγεν
//     οὐδέν, "he ate nothing" (LUK 4:2); οὐδὲν ὑμᾶς οὐ μὴ ἀδικήσῃ (LUK 10:19).
// Negators in different clauses stay apart: JHN 3:18 has three.
//
// Five uses are left out, because translations say them without a negator
// (each measured on the WEB New Testament, AQU-1697):
//   • εἰ μή, "except", "or else": εἰ μὴ εἷς ὁ θεός (MRK 2:7), εἰ δὲ μή (JHN 14:11);
//   • μή that opens a question expecting "no": Μὴ σὺ μείζων εἶ…; "Are you
//     greater…?" (JHN 4:12);
//   • μή after a verb of fearing, and μή πως, μή που: "I am afraid that…"
//     (2CO 11:3, ACT 27:29);
//   • litotes: οὐ πολλὰς ἡμέρας, "a few days" (JHN 2:12); οὐ μετρίως,
//     "greatly" (ACT 20:12).
// Without the text layer only adjacent negators merge (οὐ μή, μηδενὶ μηδέν).
//
// Relative imports only, no DOM: shared with the workers.

import { siblingWordId, wordNumber } from './refs'
import { containsWordCount } from './text-match'
import type { NegationFact, StructureLayerInput, TextLayerInput } from './types'

const SIMPLE_NEGATORS: ReadonlySet<string> = new Set(['οὐ', 'οὐκ', 'οὐχ', 'οὐχί', 'μή'])
const COMPOUND_NEGATORS: ReadonlySet<string> = new Set([
  'οὐδέ',
  'μηδέ',
  'οὐδείς',
  'μηδείς',
  'οὐκέτι',
  'μηκέτι',
  'οὔτε',
  'μήτε',
  'οὐδέποτε',
  'μηδέποτε',
])
/** How far a compound negative may stand from the negative it strengthens: Μηκέτι εἰς τὸν αἰῶνα ἐκ σοῦ μηδεὶς (MRK 11:14). */
const STRENGTHEN_REACH = 8
const CONDITIONAL = 'εἰ'
/** Words that may stand inside εἰ δὲ μή or οὐ γὰρ μή. */
const POSTPOSITIVES: ReadonlySet<string> = new Set(['δέ', 'γάρ', 'οὖν', 'τέ'])
/** οὐ before these says the opposite mildly: "not few" for "many" (litotes). */
const LITOTES: ReadonlySet<string> = new Set(['πολύς', 'ὀλίγος', 'τυγχάνω', 'μετρίως'])
const LITOTES_REACH = 3
/** μή after a verb of fearing is "that" or "lest": φοβηθεὶς ὁ χιλίαρχος μὴ διασπασθῇ (ACT 23:10). */
const FEARING = 'φοβέομαι'
const FEARING_REACH = 4
/** μή πως, μή που: "lest perhaps". */
const PERHAPS: ReadonlySet<string> = new Set(['πώς', 'ποῦ'])
const OR = 'ἤ'
/** Punctuation after a word that ends a clause: , . · ; and the Greek question mark. */
const CLAUSE_BREAK = /[,.;:\u00B7\u0387\u037E]/u
/** The words around each negator that M3 reads, for a compact text layer. */
const CONTEXT_BEFORE = Math.max(FEARING_REACH, 2)
const CONTEXT_AFTER = LITOTES_REACH

/** Every lemma M3 reads; a compact text layer keeps these words and their neighbours. */
export function isNegatorLemma(lemma: string): boolean {
  const key = lemma.normalize('NFC')
  return SIMPLE_NEGATORS.has(key) || COMPOUND_NEGATORS.has(key)
}

interface Word {
  lemma: string | null
  after: string
}

function wordAt(text: TextLayerInput | null | undefined, id: string, position: number): Word | null {
  if (!text || position < 1) return null
  const key = siblingWordId(id, position)
  if (!Object.hasOwn(text.words, key)) return null
  const word = text.words[key]
  return { lemma: word.lemma?.normalize('NFC') ?? null, after: word.after ?? '' }
}

interface Negator {
  id: string
  position: number
  /** Null without the text layer. */
  lemma: string | null
}

const lemmaAt = (text: TextLayerInput | null | undefined, n: Negator, offset: number) =>
  wordAt(text, n.id, n.position + offset)?.lemma ?? null

/** A negation a translation does not say with a negator (see the header). Needs the lemmas. */
function notSaidAsNegation(
  n: Negator,
  text: TextLayerInput | null | undefined,
  question: boolean,
  clauseStarts: ReadonlySet<string>,
): boolean {
  if (n.lemma === 'οὐ') {
    for (let offset = 1; offset <= LITOTES_REACH; offset++) if (LITOTES.has(lemmaAt(text, n, offset) ?? '')) return true
    return false
  }
  if (n.lemma !== 'μή') return false
  const before = lemmaAt(text, n, -1)
  if (before === CONDITIONAL) return true
  if (before !== null && POSTPOSITIVES.has(before) && lemmaAt(text, n, -2) === CONDITIONAL) return true
  if (PERHAPS.has(lemmaAt(text, n, 1) ?? '')) return true
  for (let offset = 1; offset <= FEARING_REACH; offset++) if (lemmaAt(text, n, -offset) === FEARING) return true
  if (!question) return false
  const previous = wordAt(text, n.id, n.position - 1)
  return (
    n.position === 1 ||
    clauseStarts.has(n.id) ||
    before === OR ||
    (previous !== null && CLAUSE_BREAK.test(previous.after))
  )
}

/** No clause break between two negators of one verse. Unknown without the text layer. */
function sameClause(text: TextLayerInput | null | undefined, a: Negator, b: Negator): boolean {
  for (let position = a.position; position < b.position; position++) {
    const word = wordAt(text, a.id, position)
    if (!word || CLAUSE_BREAK.test(word.after)) return false
  }
  return true
}

function joinsPrevious(text: TextLayerInput | null | undefined, previous: Negator, next: Negator): boolean {
  const gap = next.position - previous.position
  if (gap === 1) return true
  if (previous.lemma === null || next.lemma === null) return false
  // οὐ γὰρ μή (GAL 4:30)
  if (previous.lemma === 'οὐ' && next.lemma === 'μή' && gap === 2 && POSTPOSITIVES.has(lemmaAt(text, previous, 1) ?? '')) {
    return true
  }
  const compound = COMPOUND_NEGATORS.has(previous.lemma) || COMPOUND_NEGATORS.has(next.lemma)
  return compound && gap <= STRENGTHEN_REACH && sameClause(text, previous, next)
}

/**
 * The cell's negations: the structure layer's negators, merged into units and
 * without the uses a translation does not negate. `clauseStarts` holds the
 * word ids where a speech starts or a vocative ends, so a μή there can open a
 * question. Null when the cell has no negation to keep.
 */
export function cellNegation(
  refs: readonly string[],
  structure: StructureLayerInput | null | undefined,
  text: TextLayerInput | null | undefined,
  clauseStarts: ReadonlySet<string>,
): NegationFact | null {
  let units = 0
  const words: string[] = []
  const negatedRefs: string[] = []
  for (const ref of refs) {
    const verse = structure && Object.hasOwn(structure.verses, ref) ? structure.verses[ref] : undefined
    const negators: Negator[] = [...(verse?.negators ?? [])]
      .sort()
      .map((id) => ({ id, position: wordNumber(id), lemma: wordAt(text, id, wordNumber(id))?.lemma ?? null }))
      .filter((n) => !notSaidAsNegation(n, text, verse?.question === true, clauseStarts))
    let previous: Negator | null = null
    for (const negator of negators) {
      if (!previous || !joinsPrevious(text, previous, negator)) units++
      words.push(negator.id)
      previous = negator
    }
    if (negators.length > 0) negatedRefs.push(ref)
  }
  return units > 0 ? { units, words, refs: negatedRefs } : null
}

/** How many of the profile's negators the text has, each occurrence once. */
export function countNegators(text: string, negators: readonly string[]): number {
  return containsWordCount(text, negators)
}

/** The word ids M3 reads around each negator, for a compact text layer. */
export function negationContextIds(negatorIds: readonly string[]): string[] {
  const out: string[] = []
  for (const id of negatorIds) {
    const position = wordNumber(id)
    for (let p = Math.max(1, position - CONTEXT_BEFORE); p <= position + CONTEXT_AFTER; p++) out.push(siblingWordId(id, p))
  }
  return out
}
