// Who's Who through the bridges (AQU-1694): which words of a cell to tint.
//
// Bridge links are token-level ("to" and "her" are two links of αὐτῇ). For
// drawing, a pack word's tokens that sit next to each other become one span
// ("to her"), and when two pack words claim the same token the more
// confident one keeps it. Every span says whether it is approximate (dotted),
// by bridge-compose.ts's rule, or because its word always draws dotted (an
// OT pronoun, AQU-1700). Pure.

import { tokenSpans, type TokenSpan } from "@/lib/completion/tokenize"
import { composeBridges, tintStyle, type WordTokenLink } from "./bridge-compose"
import type { AlignedWord } from "./macula-alignment"
import type { BkpWordId } from "./pack-types"
import type { AlignLink } from "./word-align"

/** A pack word on a run of a cell's tokens. */
export interface BridgedSpan {
  wordId: BkpWordId
  /** First and last token (inclusive), `tokenize` order. */
  firstToken: number
  lastToken: number
  conf: number
  approximate: boolean
}

/** A pack word on the cell's text, by UTF-16 offsets (for the source column). */
export interface BridgedWord extends AlignedWord {
  approximate: boolean
}

/** The training size under a bridge whose links are exact (a Greek source is its own alignment). */
export const EXACT_PAIRS = Number.POSITIVE_INFINITY

/**
 * Group a word's links into runs of adjacent tokens; resolve tokens two words
 * claim. A word `alwaysDotted` names is approximate whatever its confidence
 * (see alwaysDottedWords in bridge-compose.ts).
 */
export function spansFromLinks(
  links: readonly WordTokenLink[],
  trainedPairs: number,
  wanted: (wordId: BkpWordId) => boolean,
  alwaysDotted: (wordId: BkpWordId) => boolean = () => false,
): BridgedSpan[] {
  // Each token goes to its most confident word.
  const owner = new Map<number, WordTokenLink>()
  for (const link of links) {
    if (!wanted(link.wordId)) continue
    const held = owner.get(link.token)
    if (!held || held.conf < link.conf) owner.set(link.token, link)
  }
  const spans: BridgedSpan[] = []
  for (const token of [...owner.keys()].sort((a, b) => a - b)) {
    const link = owner.get(token)!
    const last = spans.at(-1)
    if (last && last.wordId === link.wordId && last.lastToken === token - 1) {
      last.lastToken = token
      last.conf = Math.max(last.conf, link.conf)
    } else {
      spans.push({ wordId: link.wordId, firstToken: token, lastToken: token, conf: link.conf, approximate: false })
    }
  }
  for (const span of spans) {
    span.approximate = alwaysDotted(span.wordId) || tintStyle(span.conf, trainedPairs) === "dotted"
  }
  return spans
}

/** Spans as offsets in `text` (whose `tokenSpans` the token indexes count). Null when the text has fewer tokens. */
export function wordsFromSpans(text: string, spans: readonly BridgedSpan[], tokens: readonly TokenSpan[] = tokenSpans(text)): BridgedWord[] | null {
  const out: BridgedWord[] = []
  for (const span of spans) {
    const first = tokens[span.firstToken]
    const last = tokens[span.lastToken]
    if (!first || !last) return null
    out.push({ start: first.start, end: last.end, wordId: span.wordId, approximate: span.approximate })
  }
  return out
}

/** A Greek source's own words as token links (confidence 1): Bridge 1 with nothing to guess. */
export function directTokenLinks(text: string, words: readonly AlignedWord[]): WordTokenLink[] {
  const tokens = tokenSpans(text)
  const out: WordTokenLink[] = []
  let k = 0
  for (const word of words) {
    while (k < tokens.length && tokens[k].end <= word.start) k++
    for (let j = k; j < tokens.length && tokens[j].start < word.end; j++) out.push({ wordId: word.wordId, token: j, conf: 1 })
  }
  return out
}

/** Bridge 1 then Bridge 2, as spans on the target's tokens. */
export function targetSpans(
  bridge1: { links: readonly WordTokenLink[]; trainedPairs: number },
  bridge2: { links: readonly AlignLink[]; trainedPairs: number },
  wanted: (wordId: BkpWordId) => boolean,
  alwaysDotted?: (wordId: BkpWordId) => boolean,
): BridgedSpan[] {
  return spansFromLinks(
    composeBridges(bridge1.links, bridge2.links),
    Math.min(bridge1.trainedPairs, bridge2.trainedPairs),
    wanted,
    alwaysDotted,
  )
}
