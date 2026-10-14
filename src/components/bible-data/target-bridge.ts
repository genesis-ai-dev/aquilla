// Who's Who, Bridge 2 for one editor (AQU-1694): source → target links,
// computed per chapter when a row of that chapter wants them.
//
// A row asks for its chapter; the bridge sends the book's translated cells
// (the training text) and the chapter's cells to the alignment worker, and
// keeps the answer per cell with the hashes of the two texts it was computed
// on. A cell whose texts change reads as "not computed" again, and its row's
// next request recomputes the chapter. Requests are coalesced per chapter,
// so a page of rows asks once. Nothing is persisted (see target-alignment.ts).
//
// `linksFor` returns the same object for as long as a cell's answer stands,
// so a row can read it as a useSyncExternalStore snapshot and re-render only
// when its own links change, not whenever any chapter arrives.

import { contentHash } from "@/lib/dcs/content-hash"
import { createTargetAligner, type TargetAligner } from "@/lib/bible-data/bridge-align-client"
import type { TargetPairInput } from "@/lib/bible-data/target-alignment"
import type { AlignLink } from "@/lib/bible-data/word-align"

/** One cell of the book, with the chapter it belongs to ("JHN 4"). */
export interface TargetCorpusCell extends TargetPairInput {
  chapter: string
}

/** One cell's answer: its links, for the two texts with these hashes. */
export interface TargetBridgeLinks {
  sourceHash: string
  targetHash: string
  links: readonly AlignLink[]
  /** The translated cells the model that computed these links trained on. */
  trainedPairs: number
}

export interface TargetBridge {
  /** The answer for these exact texts (the same object each time), or undefined when not computed. */
  linksFor(cellId: string, source: string, target: string): TargetBridgeLinks | undefined
  /** Compute a chapter's links (no-op while that chapter is in flight). */
  request(chapter: string): void
  /** Called whenever answers arrive. */
  subscribe(listener: () => void): () => void
  /** Release the worker (a later request starts a new one); computed links are kept. */
  dispose(): void
}

export interface TargetBridgeOptions {
  /** The book's cells now, read when a request goes out. */
  corpus: () => readonly TargetCorpusCell[]
  aligner?: TargetAligner
}

export function createTargetBridge({ corpus, aligner = createTargetAligner() }: TargetBridgeOptions): TargetBridge {
  const results = new Map<string, TargetBridgeLinks>()
  const inFlight = new Set<string>()
  const listeners = new Set<() => void>()

  return {
    linksFor(cellId, source, target) {
      const found = results.get(cellId)
      if (!found || found.sourceHash !== contentHash(source) || found.targetHash !== contentHash(target)) return undefined
      return found
    },
    request(chapter) {
      if (inFlight.has(chapter)) return
      const cells = corpus()
      const wanted = cells.filter((cell) => {
        if (cell.chapter !== chapter || cell.source.trim() === "" || cell.target.trim() === "") return false
        const found = results.get(cell.cellId)
        return !found || found.sourceHash !== contentHash(cell.source) || found.targetHash !== contentHash(cell.target)
      })
      if (wanted.length === 0) return
      inFlight.add(chapter)
      const strip = ({ cellId, source, target }: TargetCorpusCell): TargetPairInput => ({ cellId, source, target })
      void aligner
        .align(cells.map(strip), wanted.map(strip))
        .then((alignment) => {
          const { trainedPairs } = alignment
          const answered = new Map(alignment.cells.map((cell) => [cell.cellId, cell]))
          // A cell the model could not cover (too few translated cells) is
          // recorded with no links, so its row stops asking.
          for (const cell of wanted) {
            const answer = answered.get(cell.cellId)
            results.set(cell.cellId, {
              sourceHash: answer?.sourceHash ?? contentHash(cell.source),
              targetHash: answer?.targetHash ?? contentHash(cell.target),
              links: answer?.links ?? [],
              trainedPairs,
            })
          }
          for (const listener of listeners) listener()
        })
        .catch(() => {
          // Leave the chapter uncomputed; a later render may ask again.
        })
        .finally(() => {
          inFlight.delete(chapter)
        })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      aligner.dispose()
    },
  }
}
