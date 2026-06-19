// Few-shot examples are retrieved source-side (branching-search) and can be long
// passages. We compress the INVARIANT (examples) so the freed budget can hold the
// VARIANT (the discourse window). Compression is deterministic selection/truncation
// — NEVER summarization through a weak model — and only the example SOURCE is cut;
// the (small) target is left whole, because target-side truncation would need
// within-cell alignment we don't trust on low-resource languages.
// See docs/superpowers/specs/2026-06-18-paragraph-drafting-retrieval-context-design.md (D6, D8).

/** Boundary chars (ordered like text-splitter's BREAK_PATTERNS) used to snap an
 *  ellipsis cut to a natural edge instead of mid-word. */
const BOUNDARY_RE = /[\s.!?;:,—-]/

export interface CompressExampleOptions {
  /** Tokens that matched the query (branching-search provenance) — locate the span to keep. */
  matchedTokens?: string[]
  /** Return the source unchanged when its length ≤ this. Default 160. */
  keepWholeUnder?: number
  /** Chars of margin kept on each side of the matched span. Default 60. */
  marginChars?: number
}

function snapForward(text: string, idx: number): number {
  for (let i = Math.max(0, idx); i < text.length; i++) if (BOUNDARY_RE.test(text[i])) return i
  return text.length
}

function snapBackward(text: string, idx: number): number {
  for (let i = Math.min(text.length, idx); i > 0; i--) if (BOUNDARY_RE.test(text[i])) return i + 1
  return 0
}

function headWithEllipsis(text: string, max: number): string {
  const cut = snapBackward(text, max)
  return text.slice(0, cut > 0 ? cut : max).trim() + "…"
}

export function compressExampleSource(source: string, opts: CompressExampleOptions = {}): string {
  const keepWholeUnder = opts.keepWholeUnder ?? 160
  const marginChars = opts.marginChars ?? 60
  if (source.length <= keepWholeUnder) return source

  const tokens = (opts.matchedTokens ?? []).map((t) => t.toLowerCase()).filter(Boolean)
  if (!tokens.length) return headWithEllipsis(source, keepWholeUnder)

  const lower = source.toLowerCase()
  let first = Infinity
  let last = -1
  for (const tok of tokens) {
    const i = lower.indexOf(tok)
    if (i === -1) continue
    first = Math.min(first, i)
    last = Math.max(last, i + tok.length)
  }
  if (last === -1) return headWithEllipsis(source, keepWholeUnder)

  const start = snapBackward(source, Math.max(0, first - marginChars))
  const end = snapForward(source, Math.min(source.length, last + marginChars))
  const head = start > 0 ? "…" : ""
  const tail = end < source.length ? "…" : ""
  return head + source.slice(start, end).trim() + tail
}

/** Drop examples whose whitespace-normalized source duplicates an earlier one
 *  (keep the first = highest-ranked). */
export function dedupeExamples<T extends { source: string }>(examples: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const ex of examples) {
    const key = ex.source.trim().toLowerCase().replace(/\s+/g, " ")
    if (!key || seen.has(key)) {
      if (key) continue
    }
    seen.add(key)
    out.push(ex)
  }
  return out
}
