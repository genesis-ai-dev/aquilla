import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Source word left untranslated"

/**
 * MQM "Accuracy > Untranslated", for part of a cell. `target-equals-source`
 * catches a whole cell left as it was. This check catches a word copied
 * from the source when source and translation use different scripts. An
 * example is "Jesus" left in Latin letters in a Hindi verse.
 *
 * It needs the scripts to differ. When they are the same (English to
 * French), a word shared with the source can be a name, a loanword or a
 * cognate, and code can't tell which.
 *
 * Words of 2 letters or fewer, and ALL-CAPS words, don't count. ALL-CAPS
 * words are usually abbreviations, which `abbreviation-mismatch` handles.
 */
const WORD_RE = /\p{L}[\p{L}\p{M}'’-]*/gu
const MIN_LETTERS = 3

const SCRIPTS: Array<readonly [name: string, re: RegExp]> = [
  ["Latin", /\p{Script=Latin}/u],
  ["Cyrillic", /\p{Script=Cyrillic}/u],
  ["Greek", /\p{Script=Greek}/u],
  ["Arabic", /\p{Script=Arabic}/u],
  ["Hebrew", /\p{Script=Hebrew}/u],
  ["Devanagari", /\p{Script=Devanagari}/u],
  ["Han", /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ["Hangul", /\p{Script=Hangul}/u],
  ["Thai", /\p{Script=Thai}/u],
  ["Ethiopic", /\p{Script=Ethiopic}/u],
]

function scriptOf(word: string): string {
  const first = word[0]
  for (const [name, re] of SCRIPTS) if (re.test(first)) return name
  return "Other"
}

interface Word { text: string; index: number; script: string }

function words(text: string): Word[] {
  const out: Word[] = []
  for (const m of text.matchAll(WORD_RE)) {
    if (m.index === undefined) continue
    out.push({ text: m[0], index: m.index, script: scriptOf(m[0]) })
  }
  return out
}

/** The script that holds the most letters. */
function dominantScript(ws: Word[]): string | null {
  const letters = new Map<string, number>()
  for (const w of ws) letters.set(w.script, (letters.get(w.script) ?? 0) + w.text.length)
  let best: string | null = null
  let bestCount = 0
  for (const [script, count] of letters) {
    if (count > bestCount) { best = script; bestCount = count }
  }
  return best
}

/** Caseless scripts (Han, Arabic, Devanagari…) are never "all caps". */
function isAllCaps(word: string): boolean {
  return word === word.toUpperCase() && word !== word.toLowerCase()
}

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const targetWords = words(target)
  const targetScript = dominantScript(targetWords)
  if (!targetScript) return null
  // Most cells are in one script. Check that first, before reading the source.
  const foreign = targetWords.filter(
    (w) => w.script !== targetScript && w.text.length >= MIN_LETTERS && !isAllCaps(w.text),
  )
  if (foreign.length === 0) return null

  const sourceWords = words(source)
  if (dominantScript(sourceWords) === targetScript) return null
  const inSource = new Set(sourceWords.map((w) => w.text.toLowerCase()))

  const spans: InfractionSpan[] = foreign
    .filter((w) => inSource.has(w.text.toLowerCase()))
    .map((w) => ({ side: "target" as const, start: w.index, end: w.index + w.text.length, matchedText: w.text }))
  return spans.length > 0 ? spans : null
}
