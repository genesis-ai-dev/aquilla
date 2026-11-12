/**
 * TM-style fuzzy matching for the Examples panel (AQU-1393).
 *
 * `DualIndex` stays the candidate retriever: its token/IDF score is good at
 * *finding* similar pairs but is unbounded and not comparable between cells, so
 * it can never be shown as a "87% match" the way a TMS tool does. This module
 * re-ranks the retrieved candidates by a real, bounded source similarity —
 * `1 - normalizedEditDistance` over normalized text — and produces the
 * word-level diff the panel renders on the candidate's source.
 *
 * Re-ranking is deliberately capped (`TM_RERANK_LIMIT`): edit distance is
 * O(n·m) per candidate, and the retriever already returns its best guesses
 * first, so scoring the head of the list keeps this off the typing hot path.
 *
 * Nothing here touches LLM few-shot selection — that pool is chosen by
 * `selectApprovedExamples` and is intentionally left alone.
 */

import { normalizedEditDistance } from "@/lib/metrics/edit-distance"
import type { ScoredPair } from "./dual-index"
import { stripTags } from "./tokenizer"

/**
 * Percentage at and above which a candidate is presented as a *match* (with a
 * number) rather than as a loose *example*. The industry convention translators
 * arrive with is 75%.
 */
export const TM_MATCH_FLOOR = 75

/** How many retrieved candidates get the edit-distance re-rank. */
export const TM_RERANK_LIMIT = 20

/** Above this token count the word diff is skipped — see `diffSourceTokens`. */
export const DIFF_TOKEN_LIMIT = 200

/**
 * Match bands, coarse enough to carry a colour each. `example` is the
 * below-floor band and shows no percentage: a 40% "match" is noise dressed as
 * precision, and calling it an example is the honest label.
 */
export type MatchBand = "exact" | "high" | "good" | "fair" | "example"

export interface TmMatch extends ScoredPair {
  /**
   * 0–100 source similarity; 100 only for a normalization-equal source.
   * Meaningful for display only when `band` is not `example` — a below-floor
   * percentage is computed but deliberately not shown, and a candidate past the
   * re-rank limit carries 0 because it was never scored at all.
   */
  percent: number
  band: MatchBand
}

/**
 * Normalize for comparison only — never for display.
 *
 * Tags are stripped (a source cell can carry USFM/IDML markup that no
 * translator reads as text), case is folded, and whitespace is collapsed, so
 * "In  the beginning" and "In the beginning" are one match rather than a 97%.
 * Punctuation is deliberately KEPT: a differing final period is a real
 * difference a reviewer must see before accepting a 100% insert.
 */
export function normalizeForMatch(text: string): string {
  return stripTags(text || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
}

/**
 * Source similarity as an integer percentage.
 *
 * 100 is reserved for a normalization-equal source: anything else rounds down
 * to at most 99, so "100%" on a row always means "the same source text" and the
 * one-click insert it unlocks can be trusted. An empty side scores 0 rather
 * than dividing by zero.
 */
export function matchPercent(currentSource: string, candidateSource: string): number {
  const a = normalizeForMatch(currentSource)
  const b = normalizeForMatch(candidateSource)
  if (!a || !b) return 0
  if (a === b) return 100
  const percent = Math.round((1 - normalizedEditDistance(a, b)) * 100)
  return Math.max(0, Math.min(99, percent))
}

export function matchBand(percent: number): MatchBand {
  if (percent >= 100) return "exact"
  if (percent >= 95) return "high"
  if (percent >= 85) return "good"
  if (percent >= TM_MATCH_FLOOR) return "fair"
  return "example"
}

/**
 * Re-rank retrieved pairs by source similarity.
 *
 * Only the first `rerankLimit` candidates are scored; the tail keeps its
 * retrieval order and stays an unscored example. Scored matches at or above the
 * floor sort first by descending percent (retrieval order breaks ties), then
 * everything else in retrieval order — so the panel reads top-down as
 * "exact → close → examples" without ever dropping a candidate the retriever
 * thought was worth showing.
 */
export function rankTmMatches(
  currentSource: string,
  pairs: readonly ScoredPair[],
  rerankLimit: number = TM_RERANK_LIMIT,
): TmMatch[] {
  const ranked = pairs.map((pair, index) => {
    const percent = index < rerankLimit ? matchPercent(currentSource, pair.source) : 0
    return { pair, index, percent, band: matchBand(percent) }
  })

  ranked.sort((a, b) => {
    const aScored = a.band !== "example"
    const bScored = b.band !== "example"
    if (aScored !== bScored) return aScored ? -1 : 1
    if (aScored && a.percent !== b.percent) return b.percent - a.percent
    return a.index - b.index
  })

  return ranked.map(({ pair, percent, band }) => ({ ...pair, percent, band }))
}

/** One run of the candidate/current source, classified against the other side. */
export interface DiffSegment {
  /**
   * `equal` — text both sources share; `added` — text only the CANDIDATE has;
   * `removed` — text only the CURRENT cell has (rendered struck through at the
   * position it would occupy).
   */
  kind: "equal" | "added" | "removed"
  text: string
}

interface DisplayToken {
  /** The word exactly as authored — what gets rendered. */
  text: string
  /** Case-folded form — what gets compared. */
  norm: string
  /** Whitespace/punctuation that followed the word, carried so rendering the
   *  segments back to back reproduces the original string byte for byte. */
  trailing: string
}

const WORD_RUN = /[\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+/gu
const IS_WORD = /^[\p{L}\p{M}\p{N}]/u

/**
 * Split into word tokens plus the separators around them. Splitting on word
 * runs (rather than `tokenizeText`, which lowercases and discards punctuation)
 * is what lets the diff be rendered over the author's own text.
 */
function splitWords(text: string): { leading: string; tokens: DisplayToken[] } {
  const runs = stripTags(text || "").match(WORD_RUN) ?? []
  let leading = ""
  const tokens: DisplayToken[] = []
  for (const run of runs) {
    if (IS_WORD.test(run)) {
      tokens.push({ text: run, norm: run.toLowerCase(), trailing: "" })
    } else if (tokens.length === 0) {
      leading += run
    } else {
      tokens[tokens.length - 1].trailing += run
    }
  }
  return { leading, tokens }
}

/**
 * Word-level diff of a candidate source against the current cell's source.
 *
 * Alignment is the standard LCS backtrace over case-folded words, so the output
 * is one deterministic minimum-cost script. Segments are returned in candidate
 * order with same-kind neighbours merged, and concatenating the `equal` +
 * `added` text reproduces the candidate source — the panel can render the
 * segments directly without re-assembling the string.
 *
 * Above `DIFF_TOKEN_LIMIT` words on either side the quadratic table is skipped
 * and the candidate comes back as a single `equal` segment: a paragraph-length
 * cell is not a fuzzy match worth diffing, and the panel renders it plainly
 * rather than stalling a keystroke.
 */
export function diffSourceTokens(currentSource: string, candidateSource: string): DiffSegment[] {
  const current = splitWords(currentSource)
  const candidate = splitWords(candidateSource)
  const candidateText = candidate.leading
    + candidate.tokens.map((t) => t.text + t.trailing).join("")

  if (candidate.tokens.length === 0) {
    return candidateText ? [{ kind: "equal", text: candidateText }] : []
  }
  if (
    current.tokens.length > DIFF_TOKEN_LIMIT
    || candidate.tokens.length > DIFF_TOKEN_LIMIT
  ) {
    return [{ kind: "equal", text: candidateText }]
  }

  const a = current.tokens
  const b = candidate.tokens
  // lcs[i][j] = longest common subsequence length of a[i…] and b[j…].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i].norm === b[j].norm
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const raw: DiffSegment[] = []
  if (candidate.leading) raw.push({ kind: "equal", text: candidate.leading })
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].norm === b[j].norm) {
      raw.push({ kind: "equal", text: b[j].text + b[j].trailing })
      i++
      j++
    } else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      raw.push({ kind: "added", text: b[j].text + b[j].trailing })
      j++
    } else {
      // A word the current cell has and the candidate lacks. Rendered with a
      // single trailing space, not the current source's own spacing, so the
      // strike-through reads as an annotation on the candidate rather than
      // smuggling the other cell's punctuation into it.
      raw.push({ kind: "removed", text: a[i].text + " " })
      i++
    }
  }

  const merged: DiffSegment[] = []
  for (const segment of raw) {
    const last = merged[merged.length - 1]
    if (last && last.kind === segment.kind) last.text += segment.text
    else merged.push({ ...segment })
  }
  return merged
}
