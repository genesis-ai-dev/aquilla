// Read/write helpers for per-word audio timing data living on cell metadata,
// plus a uniform-spacing fallback generator so the karaoke UI can be
// demonstrated before the Whisper / forced-alignment pipeline is wired in.

import * as Y from "yjs"
import type { CodexCell, WordTiming } from "@/lib/codex-editor/types"

// Timings live on the cell's __source.metadata, alongside attachments and
// selectedAudioId. Same JSON-clone-on-write pattern the desktop uses so
// readers (useCells.ts, etc.) can pick everything up in one place.

interface SourceLike extends Partial<CodexCell> {
  metadata?: CodexCell["metadata"]
}

function readSource(yCell: Y.Map<unknown>): SourceLike | undefined {
  return yCell.get("__source") as SourceLike | undefined
}

function cloneOrInit(prev: SourceLike | undefined, cellId: string): CodexCell {
  if (prev) return JSON.parse(JSON.stringify(prev)) as CodexCell
  return {
    kind: 2 as const,
    languageId: "html",
    value: "",
    metadata: { id: cellId, type: "text" },
  }
}

export function readCellTimings(
  doc: Y.Doc,
  cellId: string,
  audioId: string,
): WordTiming[] | undefined {
  const cellsMap = doc.getMap("cells")
  const yCell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!yCell) return undefined
  const src = readSource(yCell)
  return src?.metadata?.audioTimings?.[audioId]
}

export function writeCellTimings(
  doc: Y.Doc,
  cellId: string,
  audioId: string,
  timings: WordTiming[],
): void {
  const cellsMap = doc.getMap("cells")
  const yCell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!yCell) return
  doc.transact(() => {
    const next = cloneOrInit(readSource(yCell), cellId)
    if (!next.metadata) next.metadata = { id: cellId, type: "text" }
    next.metadata.audioTimings = {
      ...(next.metadata.audioTimings || {}),
      [audioId]: timings,
    }
    yCell.set("__source", next)
  })
}

export function clearCellTimings(
  doc: Y.Doc,
  cellId: string,
  audioId: string,
): void {
  const cellsMap = doc.getMap("cells")
  const yCell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!yCell) return
  const src = readSource(yCell)
  if (!src?.metadata?.audioTimings?.[audioId]) return
  doc.transact(() => {
    const next = cloneOrInit(src, cellId)
    if (next.metadata?.audioTimings) {
      delete next.metadata.audioTimings[audioId]
      if (Object.keys(next.metadata.audioTimings).length === 0) {
        delete next.metadata.audioTimings
      }
    }
    yCell.set("__source", next)
  })
}

/**
 * Tokenize plain text into word spans. A "word" is any maximal run of
 * non-whitespace characters. Returns inclusive-start/exclusive-end offsets.
 */
export function tokenizeWords(text: string): Array<{ word: string; start: number; end: number }> {
  const out: Array<{ word: string; start: number; end: number }> = []
  let i = 0
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++
    if (i >= text.length) break
    const start = i
    while (i < text.length && !/\s/.test(text[i])) i++
    out.push({ word: text.slice(start, i), start, end: i })
  }
  return out
}

/**
 * Spread a duration evenly across the words of `text`. Useful as a placeholder
 * before real ASR/alignment runs — the karaoke band will sweep through every
 * word but won't actually match the audio. Surface this clearly in the UI.
 */
export function uniformTimings(text: string, duration: number): WordTiming[] {
  const words = tokenizeWords(text)
  if (words.length === 0 || duration <= 0) return []
  const slice = duration / words.length
  return words.map((w, i) => ({
    word: w.word,
    start: w.start,
    end: w.end,
    t0: i * slice,
    t1: (i + 1) * slice,
  }))
}

/**
 * Find the index of the timing whose [t0, t1) contains `t`. Returns -1 if no
 * word is active at that time. O(log n) — assumes timings are sorted by t0
 * and non-overlapping (which both Whisper and forced aligners produce).
 */
export function findActiveTimingIndex(timings: WordTiming[] | undefined, t: number): number {
  if (!timings || timings.length === 0) return -1
  let lo = 0, hi = timings.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const w = timings[mid]
    if (t < w.t0) hi = mid - 1
    else if (t >= w.t1) lo = mid + 1
    else return mid
  }
  return -1
}
