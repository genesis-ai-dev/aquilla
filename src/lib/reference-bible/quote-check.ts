// AQU-1573: does the draft quote a referenced verse word for word?
//
// The reference Bible check is a WARNING, never a block (Sam, 2026-10-02). It
// compares the target against the verses the SOURCE references, in the lane's
// reference Bible, and reports two things:
//
//   differs  the draft visibly quotes the verse (a run of at least three
//            words in a row match) but changes, adds or drops words inside
//            the quoted part;
//   missing  the source visibly quotes Scripture — quotation marks around at
//            least three words, or the reference in brackets after at least
//            three words — yet the draft uses none of the referenced verses'
//            wording. A source that only MENTIONS a verse never triggers it.
//
// Ignored throughout: vowel marks, tatweel, hamza/alef spelling, punctuation
// and case (normalize.ts). A partial quote passes when the quoted part
// matches. An ellipsis or a [bracketed insertion] in the draft splits a quote
// into parts that are checked separately.
//
// How a quote attempt is found: token-level local alignment (Smith–Waterman,
// match +2, mismatch −1, gap −1) of the verse words against each part of the
// draft. The aligned region is trimmed to start and end on a run of at least
// two matching words, so a word that happens to recur after the quote ends
// does not drag the region out; it counts as an attempt when it holds a run
// of at least three matches (or is the whole verse, for verses of three words
// or fewer). Any mismatch or gap left inside is a "differs".
//
// A reference whose verses are not loaded yet is skipped, so a slow lookup
// never shows a false warning.
//
// No path aliases: auth-worker imports this file too (see types.ts).

import { findScriptureReferences, uniqueReferences } from "./reference-finder"
import { quoteTokens, type QuoteToken } from "./normalize"
import type { FoundReference } from "./types"

/** Verse texts of a canonical reference, in order; undefined when not loaded. */
export type ReferenceQuoteLookup = (canonical: string) => readonly string[] | undefined

export type ReferenceQuoteFinding =
  | { kind: "differs"; canonical: string; label: string; targetStart: number; targetEnd: number }
  | { kind: "missing"; canonicals: string[]; labels: string[]; sourceStart: number; sourceEnd: number }

export interface ReferenceQuoteOptions {
  /** References already found in `source` (callers cache them per source text). */
  references?: readonly FoundReference[]
}

const MIN_RUN = 3
const EDGE_RUN = 2
const MATCH = 2
const MISMATCH = -1
const GAP = -1

type Op = { kind: "M" | "X" | "I" | "D"; pi: number }

/** Best local alignment of verse words `v` against draft words `p`, as ops. */
function align(v: readonly string[], p: readonly string[]): Op[] {
  const n = v.length
  const m = p.length
  const w = m + 1
  const H = new Int32Array((n + 1) * w)
  // 1 = diagonal, 2 = up (verse word dropped), 3 = left (extra draft word)
  const T = new Uint8Array((n + 1) * w)
  let best = 0
  let bi = 0
  let bj = 0
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = H[(i - 1) * w + j - 1] + (v[i - 1] === p[j - 1] ? MATCH : MISMATCH)
      const up = H[(i - 1) * w + j] + GAP
      const left = H[i * w + j - 1] + GAP
      let h = 0
      let t = 0
      if (diag > h) { h = diag; t = 1 }
      if (up > h) { h = up; t = 2 }
      if (left > h) { h = left; t = 3 }
      H[i * w + j] = h
      T[i * w + j] = t
      if (h > best) { best = h; bi = i; bj = j }
    }
  }
  const ops: Op[] = []
  let i = bi
  let j = bj
  while (i > 0 && j > 0 && H[i * w + j] > 0) {
    const t = T[i * w + j]
    if (t === 1) {
      ops.push({ kind: v[i - 1] === p[j - 1] ? "M" : "X", pi: j - 1 })
      i--
      j--
    } else if (t === 2) {
      ops.push({ kind: "D", pi: -1 })
      i--
    } else {
      ops.push({ kind: "I", pi: j - 1 })
      j--
    }
  }
  return ops.reverse()
}

type Attempt = { differs: boolean; firstPi: number; lastPi: number }

/** The quote attempt inside an alignment, or null when it is not one. */
function attemptOf(ops: readonly Op[], verseLength: number): Attempt | null {
  const runs: { start: number; end: number }[] = []
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].kind !== "M") continue
    const start = k
    while (k + 1 < ops.length && ops[k + 1].kind === "M") k++
    runs.push({ start, end: k })
  }
  const len = (r: { start: number; end: number }) => r.end - r.start + 1
  const wholeShortVerse =
    verseLength <= MIN_RUN && verseLength > 0 && ops.length === verseLength && ops.every((o) => o.kind === "M")
  if (!wholeShortVerse && !runs.some((r) => len(r) >= MIN_RUN)) return null
  const edgeRuns = runs.filter((r) => len(r) >= EDGE_RUN || wholeShortVerse)
  const from = edgeRuns[0].start
  const to = edgeRuns[edgeRuns.length - 1].end
  const region = ops.slice(from, to + 1)
  const pis = region.filter((o) => o.pi >= 0).map((o) => o.pi)
  return { differs: region.some((o) => o.kind !== "M"), firstPi: pis[0], lastPi: pis[pis.length - 1] }
}

/** Draft words split into parts at ellipses and [bracketed insertions]. */
function draftParts(target: string): QuoteToken[][] {
  const breaks: { start: number; end: number; drop: boolean }[] = []
  for (const m of target.matchAll(/…|\.{3,}|(?:\.\s){2}\./g)) breaks.push({ start: m.index, end: m.index + m[0].length, drop: false })
  for (const m of target.matchAll(/\[[^\]\n]*\]/g)) breaks.push({ start: m.index, end: m.index + m[0].length, drop: true })
  breaks.sort((a, b) => a.start - b.start)
  const parts: QuoteToken[][] = [[]]
  let b = 0
  for (const tok of quoteTokens(target)) {
    let inDropped = false
    while (b < breaks.length && breaks[b].end <= tok.start) {
      if (parts[parts.length - 1].length) parts.push([])
      b++
    }
    if (b < breaks.length && breaks[b].start <= tok.start && tok.end <= breaks[b].end) inDropped = breaks[b].drop
    if (!inDropped) parts[parts.length - 1].push(tok)
  }
  return parts.filter((p) => p.length > 0)
}

const QUOTED = /“([^”]*)”|"([^"\n]*)"|«([^»]*)»|‘([^’]*)’|(?<![\p{L}\p{N}])'([^'\n]*)'(?![\p{L}\p{N}])/gu

/**
 * Does the source visibly quote Scripture? Quotation marks around at least
 * three words, or a reference in brackets that follows at least three words.
 */
export function sourceVisiblyQuotes(source: string, refs: readonly FoundReference[]): boolean {
  for (const m of source.matchAll(QUOTED)) {
    const inner = m.slice(1).find((g) => g !== undefined) ?? ""
    if (quoteTokens(inner).length >= MIN_RUN) return true
  }
  for (const r of refs) {
    const before = source.slice(0, r.start)
    const bracket = /[([]\s*$/.exec(before)
    if (bracket && quoteTokens(before.slice(0, bracket.index)).length >= MIN_RUN) return true
  }
  return false
}

export function checkReferenceQuotes(
  source: string,
  target: string,
  lookup: ReferenceQuoteLookup,
  opts: ReferenceQuoteOptions = {},
): ReferenceQuoteFinding[] {
  if (!source || !target.trim()) return []
  const found = opts.references ?? findScriptureReferences(source)
  const refs = uniqueReferences(found)
  if (refs.length === 0) return []

  const loaded = refs
    .map((ref) => ({ ref, verses: lookup(ref.canonical) }))
    .filter((r): r is { ref: FoundReference; verses: readonly string[] } => !!r.verses && r.verses.length > 0)
  if (loaded.length === 0) return []

  const parts = draftParts(target)
  const findings: ReferenceQuoteFinding[] = []
  let anyAttempt = false
  for (const { ref, verses } of loaded) {
    const v = quoteTokens(verses.join(" ")).map((t) => t.norm)
    const vSet = new Set(v)
    for (const part of parts) {
      const p = part.map((t) => t.norm)
      // Cheap filter: a quote needs at least min(3, |v|) shared words.
      let shared = 0
      for (const word of p) if (vSet.has(word)) shared++
      if (shared < Math.min(MIN_RUN, v.length)) continue
      const attempt = attemptOf(align(v, p), v.length)
      if (!attempt) continue
      anyAttempt = true
      if (attempt.differs) {
        findings.push({
          kind: "differs",
          canonical: ref.canonical,
          label: ref.label,
          targetStart: part[attempt.firstPi].start,
          targetEnd: part[attempt.lastPi].end,
        })
      }
    }
  }

  if (!anyAttempt && sourceVisiblyQuotes(source, found)) {
    const first = loaded[0].ref
    findings.push({
      kind: "missing",
      canonicals: loaded.map((l) => l.ref.canonical),
      labels: loaded.map((l) => l.ref.label),
      sourceStart: first.start,
      sourceEnd: first.end,
    })
  }
  return findings
}
