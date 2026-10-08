/**
 * Cheap word-level provenance for an AI draft (#946).
 *
 * The health ribbon's percentage is neighbor-confidence, not "which words
 * matched examples." This module answers that second question by overlapping
 * the draft TARGET with the TARGET text of the cited examples — no model-side
 * attribution. Display-only: callers paint the returned offsets; they never
 * write them back into `translatedHtml`.
 */

import { tokenizeWithOffsets, type TextToken } from "./tokenize"

export interface DraftHealthExample {
  cellId: string
  source: string
  target: string
}

export interface DraftHealthSpan {
  start: number
  end: number
  kind: "supported" | "guessed"
  exampleId?: string
  exampleSource?: string
  exampleTarget?: string
}

export const HEALTH_SPAN_CLASS = {
  supported: "bg-emerald-500/20",
  guessed: "bg-amber-500/25",
} as const

const MARKS_RE = /\p{M}/gu

/** A token is worth colouring when it has at least two letters/digits. */
export function isColorableToken(text: string): boolean {
  return text.replace(MARKS_RE, "").length >= 2
}

function containsNgram(haystack: readonly string[], ngram: readonly string[]): boolean {
  if (ngram.length === 0 || ngram.length > haystack.length) return false
  outer: for (let i = 0; i <= haystack.length - ngram.length; i++) {
    for (let j = 0; j < ngram.length; j++) {
      if (haystack[i + j] !== ngram[j]) continue outer
    }
    return true
  }
  return false
}

function longestSupportedMatch(
  draft: readonly TextToken[],
  start: number,
  examples: readonly { example: DraftHealthExample; tokens: string[] }[],
): { length: number; example: DraftHealthExample } | null {
  const remaining = draft.length - start
  for (let n = remaining; n >= 1; n--) {
    const ngram = draft.slice(start, start + n).map((token) => token.text)
    for (const { example, tokens } of examples) {
      if (containsNgram(tokens, ngram)) return { length: n, example }
    }
  }
  return null
}

/**
 * Resolve the examples a draft should be compared against.
 * Live `ScoredPair`s (still in `useCompletion` memory) win; otherwise use the
 * source/target snapshot stored on `aiDraft` at commit time; finally look up
 * persisted `aiDraft.exampleIds` in the in-memory cell list (legacy drafts).
 */
export function resolveDraftHealthExamples(opts: {
  live?: readonly { cellId: string; source: string; target: string }[] | null
  persisted?: readonly { cellId: string; source: string; target: string }[] | null
  exampleIds?: readonly string[] | null
  lookup?: (cellId: string) => { source: string; target: string } | undefined
}): DraftHealthExample[] {
  const seen = new Set<string>()
  const out: DraftHealthExample[] = []

  const push = (example: DraftHealthExample) => {
    if (seen.has(example.cellId) || !example.target.trim()) return
    seen.add(example.cellId)
    out.push(example)
  }

  for (const live of opts.live ?? []) {
    push({ cellId: live.cellId, source: live.source, target: live.target })
  }
  if (out.length > 0) return out

  for (const persisted of opts.persisted ?? []) {
    push({ cellId: persisted.cellId, source: persisted.source, target: persisted.target })
  }
  if (out.length > 0) return out

  const lookup = opts.lookup
  if (!lookup) return out
  for (const id of opts.exampleIds ?? []) {
    const pair = lookup(id)
    if (pair) push({ cellId: id, source: pair.source, target: pair.target })
  }
  return out
}

/** Phrase-overlap spans of `draft` against cited example targets. */
export function buildDraftHealthSpans(
  draft: string,
  examples: readonly DraftHealthExample[],
): DraftHealthSpan[] {
  if (!draft) return []

  const indexed = examples
    .map((example) => ({ example, tokens: tokenizeWithOffsets(example.target).map((t) => t.text) }))
    .filter((entry) => entry.tokens.length > 0)

  const tokens = tokenizeWithOffsets(draft)
  const spans: DraftHealthSpan[] = []
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (!isColorableToken(token.text)) {
      i += 1
      continue
    }
    const match = longestSupportedMatch(tokens, i, indexed)
    if (match) {
      const last = tokens[i + match.length - 1]
      spans.push({
        start: token.start,
        end: last.end,
        kind: "supported",
        exampleId: match.example.cellId,
        exampleSource: match.example.source,
        exampleTarget: match.example.target,
      })
      i += match.length
      continue
    }
    spans.push({ start: token.start, end: token.end, kind: "guessed" })
    i += 1
  }
  return mergeAdjacentGuessed(spans, draft)
}

function mergeAdjacentGuessed(spans: DraftHealthSpan[], draft: string): DraftHealthSpan[] {
  if (spans.length < 2) return spans
  const out: DraftHealthSpan[] = [spans[0]]
  for (let i = 1; i < spans.length; i++) {
    const prev = out[out.length - 1]
    const next = spans[i]
    if (
      prev.kind === "guessed" &&
      next.kind === "guessed" &&
      !tokenizeWithOffsets(draft.slice(prev.end, next.start)).some((t) => isColorableToken(t.text))
    ) {
      prev.end = next.end
      continue
    }
    out.push(next)
  }
  return out
}

/** Truncate an example side for the hover label. */
export function clipDraftHealthExcerpt(value: string, max = 80): string {
  const compact = value.replace(/\s+/g, " ").trim()
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`
}

/** Hover label naming the cited example a supported span came from. */
export function formatDraftHealthExampleTitle(source: string, target: string, max = 80): string {
  return `${clipDraftHealthExcerpt(source, max)} → ${clipDraftHealthExcerpt(target, max)}`
}
