// AQU-1573: does the draft quote a referenced verse word for word?
//
// The reference Bible check is a WARNING, never a block (Sam, 2026-10-02). It
// compares the target against the verses the SOURCE references, in the lane's
// reference Bible, and reports two things:
//
//   differs  the draft visibly quotes the verse (a run of at least three
//            words in a row match) but changes, adds or drops words inside
//            the quoted part;
//   missing  the source visibly quotes a referenced verse, yet the draft uses
//            none of that reference's wording. A source that only MENTIONS a
//            verse never triggers it, even when it quotes something else.
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
// The trimmed region alone never sees a word changed at either END of a quote
// (review of 2026-10-02), so the edges are checked too:
//   * inside the draft's own quotation marks, the WHOLE quoted text must be
//     verse words in order: a changed first or last word, or a quote that
//     copies the opening and paraphrases the rest, is a "differs". Leaving
//     out words at either end is still a partial quote, and the first or
//     last word may gain or lose an attached و/ف;
//   * outside quotation marks, and only for a verse the source visibly
//     quotes, a word that replaces the verse's next word with no punctuation
//     between them (the draft runs on where the verse runs on) is a "differs".
//
// When does the source "visibly quote" a reference (quotedReferenceGroups)?
// Quotation marks around at least three words, tied to the reference: the
// reference cites it right after the closing mark ("…" (John 3:16)), or
// introduces it a few words before the opening mark (Isaiah 40:25 says,
// "…"). Or, with no quotation marks, the reference in brackets closing a
// clause of at least three words. A quote with a reference elsewhere in the
// cell, and a "see also" after the cited one, do not count.
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
/** Most words between a reference and the quotation it introduces ("says", "tells us"). */
const LEAD_IN_WORDS = 4

type Op = { kind: "M" | "X" | "I" | "D"; pi: number; vi: number }

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
      ops.push({ kind: v[i - 1] === p[j - 1] ? "M" : "X", pi: j - 1, vi: i - 1 })
      i--
      j--
    } else if (t === 2) {
      ops.push({ kind: "D", pi: -1, vi: i - 1 })
      i--
    } else {
      ops.push({ kind: "I", pi: j - 1, vi: -1 })
      j--
    }
  }
  return ops.reverse()
}

/** Equal words, or equal once a leading و/ف ("and", "so") is set aside. */
function sameEdgeWord(a: string, b: string): boolean {
  if (a === b) return true
  const bare = (s: string) => (s.length > 2 && /^[وف]/.test(s) ? s.slice(1) : s)
  return bare(a) === b || a === bare(b)
}

/**
 * Does quoted text `q` differ from the verse words `v`? Every word of `q` must
 * be a verse word, in order; verse words may be left out at either end (a
 * partial quote) but not in between. The first and last words may differ by
 * an attached و/ف. Semi-global alignment: all of `q`, any stretch of `v`.
 */
function quotedTextDiffers(v: readonly string[], q: readonly string[]): boolean {
  const n = v.length
  const m = q.length
  if (m === 0) return false
  const w = m + 1
  const NEG = -1e9
  const H = new Float64Array((n + 1) * w)
  for (let j = 1; j <= m; j++) H[j] = NEG
  for (let i = 1; i <= n; i++) {
    H[i * w] = 0
    for (let j = 1; j <= m; j++) {
      const edge = j === 1 || j === m
      const same = v[i - 1] === q[j - 1] || (edge && sameEdgeWord(v[i - 1], q[j - 1]))
      // Only a run of exact matches can reach the full score of 2 per word;
      // anything else (substitution, extra word, inner dropped word) costs.
      const diag = H[(i - 1) * w + j - 1] + (same ? MATCH : MISMATCH)
      const up = j < m ? H[(i - 1) * w + j] + GAP : NEG
      const left = H[i * w + j - 1] + GAP
      H[i * w + j] = Math.max(diag, up, left)
    }
  }
  let best = NEG
  for (let i = 0; i <= n; i++) best = Math.max(best, H[i * w + m])
  return best < MATCH * m
}

type Attempt = { differs: boolean; firstPi: number; lastPi: number; firstVi: number; lastVi: number }

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
  return {
    differs: region.some((o) => o.kind !== "M"),
    firstPi: pis[0],
    lastPi: pis[pis.length - 1],
    // The region starts and ends on a match, so both have a verse word.
    firstVi: ops[from].vi,
    lastVi: ops[to].vi,
  }
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

type Span = { start: number; end: number }

const OPENERS: Record<string, string> = { "«": "»", "“": "”", "„": "“" }
const CLOSERS = new Set(["»", "”"])

/**
 * The draft's quotations, as the text between each pair of marks (« », “ ”,
 * „ “, " "). Paired with a stack, so a verse's own «…» copied inside the
 * draft's «…» is a quotation inside a quotation; a mark with no partner (a
 * speech that a verse opens and a later verse closes) is ignored.
 */
function quotationSpans(text: string): Span[] {
  const spans: Span[] = []
  const stack: { mark: string; at: number }[] = []
  const close = (k: number, at: number) => {
    spans.push({ start: stack[k].at + 1, end: at })
    stack.length = k
  }
  for (let at = 0; at < text.length; at++) {
    const ch = text[at]
    if (ch === "\"") {
      const k = stack.map((s) => s.mark).lastIndexOf("\"")
      if (k >= 0) close(k, at)
      else stack.push({ mark: ch, at })
      continue
    }
    // „ opens a quotation that “ closes; “ otherwise opens one.
    const top = stack[stack.length - 1]
    if (ch === "“" && top?.mark === "„") {
      close(stack.length - 1, at)
      continue
    }
    if (OPENERS[ch]) {
      stack.push({ mark: ch, at })
      continue
    }
    if (CLOSERS.has(ch)) {
      let k = stack.length - 1
      while (k >= 0 && OPENERS[stack[k].mark] !== ch) k--
      if (k >= 0) close(k, at)
    }
  }
  return spans
}

/** Words of `part` inside `span`, leaving out (parenthesised) asides such as a reference. */
function quotedWords(target: string, part: readonly QuoteToken[], span: Span): { tok: QuoteToken; pi: number }[] {
  const asides = [...target.slice(span.start, span.end).matchAll(/\([^()\n]*\)/g)].map((m) => ({
    start: span.start + m.index,
    end: span.start + m.index + m[0].length,
  }))
  const out: { tok: QuoteToken; pi: number }[] = []
  part.forEach((tok, pi) => {
    if (tok.start < span.start || tok.end > span.end) return
    if (asides.some((a) => a.start <= tok.start && tok.end <= a.end)) return
    out.push({ tok, pi })
  })
  return out
}

const QUOTED = /“([^”]*)”|"([^"\n]*)"|«([^»]*)»|‘([^’]*)’|(?<![\p{L}\p{N}])'([^'\n]*)'(?![\p{L}\p{N}])/gu
const SENTENCE_END = /[.!?؟]/

/** True when the text right after a reference closes a citation: ")", punctuation or the end. */
function endsCitation(source: string, at: number): boolean {
  return /^\s*(?:[)\]]|[.,;:!?؟"”»]|$)/u.test(source.slice(at))
}

/**
 * The references the source visibly quotes, one group per quotation: the
 * reference that cites it plus the references listed with it ("John 3:16,
 * 18", "Romans 8:28; John 3:16"). A "see also" after it is not in the group.
 * Groups hold every occurrence's FoundReference, in source order.
 */
export function quotedReferenceGroups(source: string, refs: readonly FoundReference[]): FoundReference[][] {
  const sorted = [...refs].sort((a, b) => a.start - b.start)
  // The run of references listed together with sorted[k], joined by nothing
  // but separators (", ", "; ", " and ").
  const listOf = (k: number): FoundReference[] => {
    const joined = (a: FoundReference, b: FoundReference) =>
      /^[\s,;&]*(?:and)?[\s,;&]*$/iu.test(source.slice(a.end, b.start))
    let lo = k
    let hi = k
    while (lo > 0 && joined(sorted[lo - 1], sorted[lo])) lo--
    while (hi + 1 < sorted.length && joined(sorted[hi], sorted[hi + 1])) hi++
    return sorted.slice(lo, hi + 1)
  }
  const groups: FoundReference[][] = []
  const add = (k: number) => {
    const group = listOf(k)
    if (!groups.some((g) => g[0] === group[0])) groups.push(group)
  }

  for (const m of source.matchAll(QUOTED)) {
    const inner = m.slice(1).find((g) => g !== undefined) ?? ""
    if (quoteTokens(inner).length < MIN_RUN) continue
    const open = m.index
    const close = m.index + m[0].length
    // Cited right after the closing mark: "…" (John 3:16), "…" — John 3:16,
    // or "…," says Paul in Romans 5:8 when the quoted sentence runs on.
    const after = sorted.findIndex((r) => r.start >= close)
    if (after >= 0 && endsCitation(source, sorted[after].end)) {
      const gap = source.slice(close, sorted[after].start)
      const bare = !/[\p{L}\p{N}]/u.test(gap)
      const runsOn = !SENTENCE_END.test(inner.trim().slice(-1)) && !SENTENCE_END.test(gap) && quoteTokens(gap).length <= LEAD_IN_WORDS
      if (bare || runsOn) {
        add(after)
        continue
      }
    }
    // Introduced a few words before the opening mark: Isaiah 40:25 says, "…".
    let before = -1
    for (let k = 0; k < sorted.length && sorted[k].end <= open; k++) before = k
    if (before >= 0) {
      const gap = source.slice(sorted[before].end, open)
      if (!SENTENCE_END.test(gap) && quoteTokens(gap).length <= LEAD_IN_WORDS) add(before)
    }
  }

  // No quotation marks: "The Lord is my shepherd, I lack nothing (Psalm 23:1)."
  // The bracket must hold the reference first and close the clause, and the
  // clause before it must have at least three words of its own.
  sorted.forEach((r, k) => {
    const lead = source.slice(0, r.start)
    const bracket = /[([]\s*$/.exec(lead)
    if (!bracket) return
    if (!/^[^)\]\n]{0,80}[)\]]\s*(?:[.,;:!?؟"”»]|$)/u.test(source.slice(r.end))) return
    const clause = lead.slice(0, bracket.index).replace(/[\s.!?؟]+$/u, "")
    const sentenceStart = Math.max(...[".", "!", "?", "؟"].map((p) => clause.lastIndexOf(p)))
    if (quoteTokens(clause.slice(sentenceStart + 1)).length >= MIN_RUN) add(k)
  })
  return groups
}

/** Does the source visibly quote any of its references? */
export function sourceVisiblyQuotes(source: string, refs: readonly FoundReference[]): boolean {
  return quotedReferenceGroups(source, refs).length > 0
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

  const groups = quotedReferenceGroups(source, found)
  const quotedBySource = new Set(groups.flat().map((r) => r.canonical))
  const parts = draftParts(target)
  const spans = quotationSpans(target)
  const findings: ReferenceQuoteFinding[] = []
  const attempted = new Set<string>()
  for (const { ref, verses } of loaded) {
    const verseText = verses.join(" ")
    const vTok = quoteTokens(verseText)
    const v = vTok.map((t) => t.norm)
    const vSet = new Set(v)
    for (const part of parts) {
      const p = part.map((t) => t.norm)
      // Cheap filter: a quote needs at least min(3, |v|) shared words.
      let shared = 0
      for (const word of p) if (vSet.has(word)) shared++
      if (shared < Math.min(MIN_RUN, v.length)) continue
      const attempt = attemptOf(align(v, p), v.length)
      if (!attempt) continue
      attempted.add(ref.canonical)
      let { differs, firstPi, lastPi } = attempt
      const regionStart = part[firstPi].start
      const regionEnd = part[lastPi].end
      // The innermost of the draft's quotations that holds the whole attempt.
      const span = spans
        .filter((s) => s.start <= regionStart && regionEnd <= s.end)
        .sort((a, b) => a.end - a.start - (b.end - b.start))[0]
      if (span) {
        const quoted = quotedWords(target, part, span)
        if (quotedTextDiffers(v, quoted.map((w) => w.tok.norm))) {
          differs = true
          firstPi = Math.min(firstPi, quoted[0].pi)
          lastPi = Math.max(lastPi, quoted[quoted.length - 1].pi)
        }
      } else if (quotedBySource.has(ref.canonical)) {
        // Unquoted draft of a quoted verse: the draft must not run on with a
        // different word where the verse runs on.
        const runsOn = (a: { end: number }, b: { start: number }, text: string) => !/\S/.test(text.slice(a.end, b.start))
        const next = part[lastPi + 1]
        const vNext = vTok[attempt.lastVi + 1]
        if (next && vNext && runsOn(part[lastPi], next, target) && runsOn(vTok[attempt.lastVi], vNext, verseText) && !sameEdgeWord(next.norm, vNext.norm)) {
          differs = true
          while (part[lastPi + 1] && runsOn(part[lastPi], part[lastPi + 1], target)) lastPi++
        }
        const prev = part[firstPi - 1]
        const vPrev = vTok[attempt.firstVi - 1]
        if (prev && vPrev && runsOn(prev, part[firstPi], target) && runsOn(vPrev, vTok[attempt.firstVi], verseText) && !sameEdgeWord(prev.norm, vPrev.norm)) {
          differs = true
          while (firstPi > 0 && runsOn(part[firstPi - 1], part[firstPi], target)) firstPi--
        }
      }
      if (differs) {
        findings.push({
          kind: "differs",
          canonical: ref.canonical,
          label: ref.label,
          targetStart: part[firstPi].start,
          targetEnd: part[lastPi].end,
        })
      }
    }
  }

  // "missing": a quotation in the source whose references the draft never
  // quotes. Named by the references that cite that quotation only.
  const isLoaded = new Set(loaded.map((l) => l.ref.canonical))
  for (const group of groups) {
    const cited = uniqueReferences(group).filter((r) => isLoaded.has(r.canonical))
    if (cited.length === 0 || cited.some((r) => attempted.has(r.canonical))) continue
    if (findings.some((f) => f.kind === "missing" && f.canonicals.join() === cited.map((r) => r.canonical).join())) continue
    findings.push({
      kind: "missing",
      canonicals: cited.map((r) => r.canonical),
      labels: cited.map((r) => r.label),
      sourceStart: cited[0].start,
      sourceEnd: cited[0].end,
    })
  }
  return findings
}
