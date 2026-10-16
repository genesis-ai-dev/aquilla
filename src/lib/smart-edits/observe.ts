// Smart edits — settled pair → stored observations. One row per edit op.

import type { SettledPair } from "./chains"
import { extractEdits } from "./extract"
import type { Observation } from "./suggest"
import { tokenize } from "./tokens"

export const EVIDENCE_CHARS = 300
const MAX_SOURCE_NORMS = 80

export function clip(text: string, n = EVIDENCE_CHARS): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text
}

/** `cellKey` identifies the cell+lane (fileId/cellId/lane) — the unit a
 *  suggestion must never learn back onto itself. */
export function observationsFromPair(pair: SettledPair, cellKey: string, sourceText: string): Observation[] {
  const { ops } = extractEdits(pair.before, pair.after)
  if (ops.length === 0) return []
  const sourceNorms = [...new Set(tokenize(sourceText).map((t) => t.norm))].slice(0, MAX_SOURCE_NORMS)
  return ops.map((op, i) => ({
    id: `${pair.afterId}:${i}`,
    cellKey,
    afterId: pair.afterId,
    ts: pair.ts,
    beforeOrigin: pair.beforeOrigin,
    bulkKey: pair.bulkKey,
    old: op.old,
    oldNorm: op.oldNorm,
    new: op.new,
    newNorm: op.newNorm,
    left: op.left,
    right: op.right,
    sourceNorms,
    sourceText: clip(sourceText),
    beforeText: clip(pair.before),
    afterText: clip(pair.after),
  }))
}
