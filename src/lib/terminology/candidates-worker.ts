// Web Worker that runs candidate-term mining off the main thread. The C-value /
// NC-value / G² stack in `extractCandidates` is super-linear in the corpus
// size; running it inline wedged the terminology page on large projects. The
// worker accepts a corpus + options, returns the ranked candidates, and the
// page shows a loading state while it computes.

/// <reference lib="webworker" />
import { extractCandidates, type CandidateTerm } from "./candidates"
import type { Concept } from "./types"

interface MineRequest {
  type: "mine"
  requestId: string
  corpus: string[]
  managed?: Concept[]
  minTermFreq?: number
  maxResults?: number
  maxCorpusStrings?: number
}

interface MineResult {
  type: "result"
  requestId: string
  candidates: CandidateTerm[]
  /** Number of corpus strings actually mined (after any cap). */
  minedCount: number
}

interface MineError {
  type: "error"
  requestId: string
  message: string
}

self.onmessage = (e: MessageEvent<MineRequest>) => {
  const msg = e.data
  if (msg?.type !== "mine") return
  try {
    const minedCount =
      msg.maxCorpusStrings != null && msg.corpus.length > msg.maxCorpusStrings
        ? msg.maxCorpusStrings
        : msg.corpus.length
    const candidates = extractCandidates(msg.corpus, {
      managed: msg.managed,
      minTermFreq: msg.minTermFreq,
      maxResults: msg.maxResults,
      maxCorpusStrings: msg.maxCorpusStrings,
    })
    const result: MineResult = {
      type: "result",
      requestId: msg.requestId,
      candidates,
      minedCount,
    }
    ;(self as unknown as Worker).postMessage(result)
  } catch (err) {
    const error: MineError = {
      type: "error",
      requestId: msg.requestId,
      message: err instanceof Error ? err.message : String(err),
    }
    ;(self as unknown as Worker).postMessage(error)
  }
}

export type { MineRequest, MineResult, MineError }
