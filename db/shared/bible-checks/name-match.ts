// Finding a name or a pronoun form in a cell's text, with its offsets (AQU-1699).
//
// A term matches as a whole word, ignoring case unless asked not to, and in a
// script written without spaces it matches anywhere (./text-match.ts). A NAME
// may also carry up to three letters of prefix or suffix: the target
// language's affixes (Indonesian "Petrusnya", Hausa "da Bitrus"), which the
// Language profile does not list. Apostrophes ' ’ ʼ ＇ count as one, and any
// run of spaces as one. Offsets are into the text as given, so a finding can
// mark the words at fault.
//
// Relative imports only, no DOM: shared with the workers.

import { UNSPACED_SCRIPT, WORD_PART, escapeRegExp } from './text-match'
import type { BibleCheckSpan } from './types'

/** Most letters of prefix or suffix a name may carry. */
export const NAME_AFFIX_CHARS = 3

const APOSTROPHE = /['’ʼ＇]/u
const MAX_CACHED = 4000
const cache = new Map<string, RegExp | null>()

export interface TermMatchOptions {
  /** Allow up to NAME_AFFIX_CHARS letters before and after the term (names). */
  affixes?: boolean
  /** Match case exactly: "LORD" is not "Lord" (P14). */
  caseSensitive?: boolean
}

function corePattern(value: string): string {
  return Array.from(value)
    .map((ch) => (APOSTROPHE.test(ch) ? "['’ʼ＇]" : /\s/u.test(ch) ? '\\s+' : escapeRegExp(ch)))
    .join('')
}

function compile(term: string, options: TermMatchOptions): RegExp | null {
  const value = term.normalize('NFC').trim().replace(/\s+/gu, ' ')
  const key = `${options.affixes ? 'a' : 'w'}${options.caseSensitive ? 'c' : 'i'}\u0001${value}`
  if (cache.has(key)) return cache.get(key) ?? null
  let re: RegExp | null = null
  if (value) {
    const core = corePattern(value)
    const affix = options.affixes ? `${WORD_PART}{0,${NAME_AFFIX_CHARS}}` : ''
    const source = UNSPACED_SCRIPT.test(value.replace(/\s/gu, ''))
      ? core
      : `(?<!${WORD_PART})${affix}${core}${affix}(?!${WORD_PART})`
    re = new RegExp(source, options.caseSensitive ? 'gu' : 'giu')
  }
  if (cache.size >= MAX_CACHED) cache.clear()
  cache.set(key, re)
  return re
}

/** Where `term` appears in `text`: whole words, with affixes when asked. */
export function termSpans(text: string, term: string, options: TermMatchOptions = {}): BibleCheckSpan[] {
  const re = compile(term, options)
  if (!re) return []
  const spans: BibleCheckSpan[] = []
  for (const match of text.matchAll(re)) {
    if (match.index === undefined || match[0].length === 0) continue
    spans.push({ start: match.index, end: match.index + match[0].length })
  }
  return spans
}

/** Where a name's rendering appears, affixes allowed. */
export function nameSpans(text: string, rendering: string, caseSensitive = false): BibleCheckSpan[] {
  return termSpans(text, rendering, { affixes: true, caseSensitive })
}

/** Where any of `forms` appears, each occurrence once (the longest form wins an overlap). */
export function formSpans(text: string, forms: readonly string[]): BibleCheckSpan[] {
  const spans: BibleCheckSpan[] = []
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    for (const span of termSpans(text, form)) {
      if (!spans.some((s) => s.start < span.end && span.start < s.end)) spans.push(span)
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}
