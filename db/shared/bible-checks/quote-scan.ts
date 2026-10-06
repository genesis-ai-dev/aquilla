// Read the quotation marks in one cell's text, level by level (AQU-1688).
//
// The scan walks the text once with a stack of open quotations. Each mark is
// classified with the project's Language-profile marks:
//
//   1. the closing mark of the innermost open quotation closes it;
//   2. the opening mark of the next level opens a quotation one level deeper;
//   3. any other level's opening mark also opens one level deeper, but is
//      recorded with the marks it used (this is how V5 sees “ where ‘ belongs);
//   4. the closing mark of an outer open quotation closes it and every
//      quotation inside it;
//   5. any other closing mark is a stray close.
//
// With the "reopen-each-paragraph" convention, a quotation that is still open
// is reopened at each new paragraph, and a verse may hold a paragraph break
// (WEB, MAT 13:28: "…this.’ “The servants…"). So after sentence-final
// punctuation or a closing mark, the opening mark of an open quotation is a
// continuation, not a new quotation. A run of them (“‘) reopens each open
// level in turn. After a comma or colon it is still read as a new quotation.
//
// English uses ’ both to close a level-2 quotation and as an apostrophe, so a ’
// (or ' or ʼ) between two letters is skipped, and one that closes nothing is
// read as an apostrophe rather than a stray close.
//
// Relative imports only, no DOM: shared with the workers.

import type { QuoteMarksProfile } from '../language-profile'

export type QuoteTokenKind = 'open' | 'close' | 'stray-close' | 'continuation'

export interface QuoteToken {
  kind: QuoteTokenKind
  /**
   * The quote level the mark opened or closed (1 = outermost). For a
   * continuation mark, the level it continues. For a stray close, the profile
   * level whose closing mark it is.
   */
  depth: number
  /** The profile level whose marks it used (1-based). */
  set: number
  /** Offsets into the text (UTF-16), end exclusive. */
  start: number
  end: number
}

export interface QuoteScan {
  tokens: QuoteToken[]
  /** Quote levels still open at the end of the text. */
  finalDepth: number
}

/**
 * The profile level whose marks a quotation at `depth` uses. Levels deeper
 * than the profile alternate its last two levels, which is what English
 * (“ ‘ “ ‘ …) and German („ ‚ „ ‚ …) do.
 */
export function markSetForDepth(depth: number, levelCount: number): number {
  if (levelCount <= 1) return 1
  if (depth <= levelCount) return depth
  return levelCount - 1 + ((depth - levelCount - 1) % 2)
}

const APOSTROPHE_LIKE = new Set(['’', "'", 'ʼ'])
const WORD_CHAR = /[\p{L}\p{N}]/u
const WHITESPACE = /\s/u
/** Ends a sentence, so a paragraph may follow: . ! ? … and their full-width forms. */
const SENTENCE_END = /[.!?…。！？]/u

/** The last character before `index` that is not whitespace, or ''. */
function charBeforeSkippingSpace(text: string, index: number): string {
  let i = index
  while (i > 0 && WHITESPACE.test(charBefore(text, i))) i -= charBefore(text, i).length
  return charBefore(text, i)
}

function charAt(text: string, index: number): string {
  if (index < 0 || index >= text.length) return ''
  return String.fromCodePoint(text.codePointAt(index) ?? 0)
}

/** The character that ends just before `index` (a surrogate pair counts as one). */
function charBefore(text: string, index: number): string {
  if (index <= 0) return ''
  const low = text.charCodeAt(index - 1)
  const isLowSurrogate = low >= 0xdc00 && low <= 0xdfff
  return isLowSurrogate && index >= 2 ? text.slice(index - 2, index) : text.slice(index - 1, index)
}

interface OpenQuote {
  depth: number
  set: number
}

/**
 * Leading continuation marks of a cell that starts inside a quotation, e.g.
 * the “ that English repeats at a new paragraph. They neither open nor close.
 */
function readContinuation(
  text: string,
  marks: QuoteMarksProfile,
  startDepth: number,
  tokens: QuoteToken[],
): number {
  if (startDepth === 0 || marks.continuation === 'none') return 0
  let index = 0
  for (let depth = 1; depth <= startDepth; depth++) {
    while (index < text.length && WHITESPACE.test(charAt(text, index))) index += charAt(text, index).length
    const set = markSetForDepth(depth, marks.levels.length)
    const pair = marks.levels[set - 1]
    const expected = marks.continuation === 'reopen-each-paragraph' ? pair.open : pair.close
    const char = charAt(text, index)
    if (char !== expected) break
    tokens.push({ kind: 'continuation', depth, set, start: index, end: index + char.length })
    index += char.length
  }
  return index
}

/**
 * Every quotation mark in `text`, classified by level. `startDepth` is how
 * many quote levels are already open where the text starts (a cell inside a
 * speech that began in an earlier verse).
 */
export function scanQuotes(text: string, marks: QuoteMarksProfile, startDepth: number): QuoteScan {
  const levels = marks.levels
  const markChars = new Set(levels.flatMap((pair) => [pair.open, pair.close]))
  const stack: OpenQuote[] = []
  for (let depth = 1; depth <= startDepth; depth++) {
    stack.push({ depth, set: markSetForDepth(depth, levels.length) })
  }
  const tokens: QuoteToken[] = []
  const setWithOpen = (char: string) => levels.findIndex((pair) => pair.open === char) + 1
  const setWithClose = (char: string) => levels.findIndex((pair) => pair.close === char) + 1
  const closeChars = new Set(levels.map((pair) => pair.close))
  const reopens = marks.continuation === 'reopen-each-paragraph'
  // Stack index of the level a run of paragraph reopens (“‘) expects next; -1 outside a run.
  let reopenNext = -1

  /** The stack index of the open quotation `char` reopens at a paragraph break here, or -1. */
  const paragraphReopen = (char: string, start: number): number => {
    const previous = tokens[tokens.length - 1]
    if (reopenNext >= 0 && previous?.kind === 'continuation' && text.slice(previous.end, start).trim() === '') {
      const next = stack[reopenNext]
      return next && levels[next.set - 1].open === char ? reopenNext : -1
    }
    const before = charBeforeSkippingSpace(text, start)
    if (!SENTENCE_END.test(before) && !closeChars.has(before)) return -1
    return stack.findIndex((quote) => levels[quote.set - 1].open === char)
  }

  let index = readContinuation(text, marks, startDepth, tokens)
  while (index < text.length) {
    const char = charAt(text, index)
    const start = index
    index += char.length
    if (!markChars.has(char)) continue
    const end = index
    const apostropheLike = APOSTROPHE_LIKE.has(char)
    if (apostropheLike && WORD_CHAR.test(charBefore(text, start)) && WORD_CHAR.test(charAt(text, end))) continue

    const top = stack[stack.length - 1]
    if (top && levels[top.set - 1].close === char) {
      reopenNext = -1
      stack.pop()
      tokens.push({ kind: 'close', depth: top.depth, set: top.set, start, end })
      continue
    }
    if (reopens && stack.length > 0) {
      const level = paragraphReopen(char, start)
      if (level >= 0) {
        tokens.push({ kind: 'continuation', depth: stack[level].depth, set: stack[level].set, start, end })
        reopenNext = level + 1
        continue
      }
    }
    reopenNext = -1
    const depth = stack.length + 1
    const expectedSet = markSetForDepth(depth, levels.length)
    const openSet = levels[expectedSet - 1].open === char ? expectedSet : setWithOpen(char)
    if (openSet > 0) {
      stack.push({ depth, set: openSet })
      tokens.push({ kind: 'open', depth, set: openSet, start, end })
      continue
    }
    // A plain loop: workers target ES2022, which has no findLastIndex.
    let outer = stack.length - 1
    while (outer >= 0 && levels[stack[outer].set - 1].close !== char) outer--
    if (outer >= 0) {
      const closed = stack[outer]
      stack.length = outer
      tokens.push({ kind: 'close', depth: closed.depth, set: closed.set, start, end })
      continue
    }
    // A ’ that closes nothing is far more likely a possessive apostrophe.
    if (apostropheLike) continue
    const closeSet = setWithClose(char)
    if (closeSet > 0) tokens.push({ kind: 'stray-close', depth: closeSet, set: closeSet, start, end })
  }
  return { tokens, finalDepth: stack.length }
}
