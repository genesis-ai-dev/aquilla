/**
 * Planted errors for the Bible data evals (design doc §10, "Recall on seeded
 * errors"): seeded sampling and the text mutations each eval plants in a
 * published translation. AQU-1699 wrote the first ones for check pack B
 * (scripts/lib/bible-checks-eval-pack-b.ts); AQU-1701 shares them with the Jev
 * shadow eval (scripts/jev-shadow-eval.ts) and adds negation drops, question
 * removal and a wrong referent. English text: the World English Bible.
 */

/** Deterministic, so a run can be repeated. */
export function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function sample<T>(items: readonly T[], n: number, rand: () => number): T[] {
  const pool = [...items]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, n)
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

/** Two names swapped as whole words: Peter ↔ John. */
export function swapNames(text: string, a: string, b: string): string {
  return text.replace(new RegExp(`\\b(${escape(a)}|${escape(b)})\\b`, "gu"), (word) => (word === a ? b : a))
}

/** Every match of `pattern` removed, and the spaces it leaves collapsed: a name dropped from its verse. */
export function dropMatches(text: string, pattern: RegExp): string {
  return text.replace(pattern, "").replace(/\s{2,}/gu, " ")
}

/** English "you" and "we" as words, for planting a profile's forms in their place. */
export const ENGLISH_YOU = /\b(?:you|your|yours|yourself|yourselves)\b/giu
export const ENGLISH_WE = /\b(?:we|us|our|ours|ourselves)\b/giu

/** Every match of `pattern` replaced by `form`: a profile's "you" or "we" planted in the text. */
export function plantForm(text: string, pattern: RegExp, form: string): string {
  return text.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`), form)
}

// ── AQU-1701 ────────────────────────────────────────────────────────────────

/** The English negators of the pack-A eval profile (scripts/bible-checks-eval.ts), as a reader would list them. */
const NEGATOR = /\b(?:not|no|never|nothing|none|nobody|neither|nor|cannot|nowhere|without|unless|lest|\w+n['’]t)\b/iu

export function hasNegator(text: string): boolean {
  return NEGATOR.test(text)
}

const POSITIVE: readonly (readonly [RegExp, string])[] = [
  [/\bwon['’]t\b/giu, "will"],
  [/\bcan['’]t\b/giu, "can"],
  [/\bshan['’]t\b/giu, "shall"],
  [/\bcannot\b/giu, "can"],
  [/\b(\w+)n['’]t\b/giu, "$1"],
  [/\bno one\b/giu, "someone"],
  [/\bnobody\b/giu, "somebody"],
  [/\bnothing\b/giu, "something"],
  [/\bnowhere\b/giu, "somewhere"],
  [/\bnone\b/giu, "some"],
  [/\bneither\b/giu, "either"],
  [/\bnor\b/giu, "or"],
  [/\b(?:not|never|no)\s+/giu, ""],
]

/**
 * A negative statement made positive: every negator dropped or turned
 * ("don’t" → "do", "nothing" → "something"). Null when one survives
 * ("No," as an answer), so the case is never a half-planted error.
 */
export function dropNegation(text: string): string | null {
  const out = POSITIVE.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text)
  return out === text || hasNegator(out) ? null : out
}

/** A question made a statement: every "?" becomes ".". Null when there is none. */
export function removeQuestion(text: string): string | null {
  return text.includes("?") ? text.replace(/\?/gu, ".") : null
}

/** English subject and object pronouns for a participant of this gender and number ("m:one", "f:one", "many"). */
const PRONOUNS: Readonly<Record<string, { subject: string; object: string }>> = {
  "m:one": { subject: "he", object: "him" },
  "f:one": { subject: "she", object: "her" },
  many: { subject: "they", object: "them" },
}

/**
 * After these words a name is a subject ("and Philip said", "did Isaiah
 * prophesy"); after any other word, an object ("found Philip").
 */
const SUBJECT_AFTER =
  /\b(?:and|but|then|so|when|that|because|for|while|as|if|did|does|do|is|was|were|are|has|had|have|will|would|shall|should|can|could|may|might|must)\s+$/iu

/**
 * Every whole-word `name` replaced by the pronoun its place needs: "he found
 * Philip" → "he found him", "Philip said" → "He said". Null without the name
 * or a pronoun for `kind`.
 */
export function nameToPronoun(text: string, name: string, kind: string): string | null {
  const forms = PRONOUNS[kind]
  const word = `\\b${escape(name)}\\b`
  if (!forms || !new RegExp(word, "u").test(text)) return null
  return text.replace(new RegExp(word, "gu"), (_, offset: number) => {
    const before = text.slice(0, offset)
    const startsSentence = /(?:^|[.!?“"‘(]\s*)$/u.test(before)
    if (startsSentence) return forms.subject.charAt(0).toUpperCase() + forms.subject.slice(1)
    return /\b[a-z]+\s+$/u.test(before) && !SUBJECT_AFTER.test(before) ? forms.object : forms.subject
  })
}

/**
 * A wrong referent planted: a subject pronoun of `kind` ("he") made a
 * look-alike's name ("Peter"). With `verb`, only the pronoun of that verb
 * ("He brought", "he had brought"): another "he" in the verse may be someone
 * else, and naming them would plant nothing. Null when there is none.
 */
export function pronounToName(text: string, kind: string, name: string, verb?: string): string | null {
  const forms = PRONOUNS[kind]
  if (!forms) return null
  const pattern = verb
    ? new RegExp(`\\b${forms.subject}\\b(?=\\s+(?:[\\p{L}’']+\\s+){0,2}?${escape(verb)}\\b)`, "iu")
    : new RegExp(`\\b${forms.subject}\\b`, "iu")
  return pattern.test(text) ? text.replace(pattern, name) : null
}

/**
 * The name stands in an apposition or a longer name ("John the Baptizer",
 * "Daniel the prophet", "Judas Iscariot", "Simon Peter"): swapping it alone
 * leaves them identified.
 */
export function nameInApposition(text: string, name: string): boolean {
  const word = escape(name)
  return (
    new RegExp(`\\b${word},?\\s+the\\s+\\p{L}`, "u").test(text) ||
    new RegExp(`\\b${word}\\s+\\p{Lu}`, "u").test(text) ||
    new RegExp(`\\p{Lu}\\p{Ll}+\\s+${word}\\b`, "u").test(text)
  )
}
