// Smart edits — turn one (before, after) pair of a cell's text into phrase-level
// edit operations with context.
//
// This is the successor of codex-editor's ICE edits (iceEdits.ts, removed
// 2026-02). Two of its bugs are fixed by construction here:
//   - A contiguous run of deleted + inserted tokens is ONE operation
//     ("the Lord" → "Yahweh"), never paired token by token by position.
//   - Context is the 2 tokens either side in the BEFORE text, so a lookup can
//     back off from 2 tokens to 1 to none instead of failing on an exact match.
//
// Whole-sentence rewrites are not patterns anyone can reuse, so pairs that
// change too much, or ops longer than a short phrase, are dropped here rather
// than polluting the memory.

import { phraseKey, tokenize, type Token } from "./tokens"

/** Longest old/new phrase (in tokens) kept as a reusable pattern. */
export const MAX_OLD_TOKENS = 4
export const MAX_NEW_TOKENS = 6
/** Above this share of changed tokens (deleted + inserted over both texts'
 *  length) the pair is a retranslation, not an edit. */
export const MAX_CHANGED_RATIO = 0.5
/** Cells longer than this are skipped: the diff is O(n·m). */
export const MAX_DIFF_TOKENS = 400
export const CONTEXT_TOKENS = 2

export interface EditOp {
  /** Surface text of the replaced phrase in the before text ("" for a pure insertion). */
  old: string
  oldNorm: string
  /** Surface text of the replacement ("" for a pure deletion). */
  new: string
  newNorm: string
  /** Normalized context in the BEFORE text, nearest token last / first. */
  left: string[]
  right: string[]
}

type Step = { op: "eq"; i: number; j: number } | { op: "del"; i: number } | { op: "ins"; j: number }

function lcsSteps(a: readonly string[], b: readonly string[]): Step[] {
  const n = a.length
  const m = b.length
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const steps: Step[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      steps.push({ op: "eq", i, j })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      steps.push({ op: "del", i })
      i++
    } else {
      steps.push({ op: "ins", j })
      j++
    }
  }
  while (i < n) steps.push({ op: "del", i: i++ })
  while (j < m) steps.push({ op: "ins", j: j++ })
  return steps
}

function surface(text: string, tokens: readonly Token[], from: number, to: number): string {
  if (from >= to) return ""
  return text.slice(tokens[from].start, tokens[to - 1].end)
}

export interface ExtractResult {
  ops: EditOp[]
  /** Why nothing was extracted, when nothing was. */
  skipped?: "identical" | "empty_before" | "too_long" | "rewrite"
}

export function extractEdits(before: string, after: string): ExtractResult {
  const a = tokenize(before)
  const b = tokenize(after)
  if (a.length === 0) return { ops: [], skipped: "empty_before" }
  if (a.length > MAX_DIFF_TOKENS || b.length > MAX_DIFF_TOKENS) return { ops: [], skipped: "too_long" }
  const an = a.map((t) => t.norm)
  const bn = b.map((t) => t.norm)
  const steps = lcsSteps(an, bn)

  let changed = 0
  for (const s of steps) if (s.op !== "eq") changed++
  if (changed === 0) return { ops: [], skipped: "identical" }
  if (changed / (a.length + b.length) > MAX_CHANGED_RATIO) return { ops: [], skipped: "rewrite" }

  const ops: EditOp[] = []
  // Walk steps; each maximal run of non-eq steps is one op. `ai` tracks the
  // before-token index where the run starts, `bj` the after-token index.
  let ai = 0
  let bj = 0
  let k = 0
  while (k < steps.length) {
    const s = steps[k]
    if (s.op === "eq") {
      ai = s.i + 1
      bj = s.j + 1
      k++
      continue
    }
    const oldFrom = ai
    const newFrom = bj
    while (k < steps.length && steps[k].op !== "eq") {
      const r = steps[k]
      if (r.op === "del") ai = r.i + 1
      else bj = r.j + 1
      k++
    }
    const oldTo = ai
    const newTo = bj
    if (oldTo - oldFrom > MAX_OLD_TOKENS || newTo - newFrom > MAX_NEW_TOKENS) continue
    ops.push({
      old: surface(before, a, oldFrom, oldTo),
      oldNorm: phraseKey(an.slice(oldFrom, oldTo)),
      new: surface(after, b, newFrom, newTo),
      newNorm: phraseKey(bn.slice(newFrom, newTo)),
      left: an.slice(Math.max(0, oldFrom - CONTEXT_TOKENS), oldFrom),
      right: an.slice(oldTo, oldTo + CONTEXT_TOKENS),
    })
  }
  return { ops }
}
