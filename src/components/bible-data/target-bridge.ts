// Who's Who, Bridge 2 for one editor (AQU-1694): source → target links,
// computed per chapter when a row of that chapter wants them.
//
// A row asks for its chapter; the bridge sends the book's translated cells
// (the training text) and the chapter's cells to the alignment worker, and
// keeps the answer per cell with the hashes of the two texts it was computed
// on. A cell whose texts change reads as "not computed" again, and its row's
// next request recomputes the chapter. Requests are coalesced per chapter,
// so a page of rows asks once. Nothing is persisted (see target-alignment.ts).

import { contentHash } from "@/lib/dcs/content-hash"
import { createTargetAligner, type TargetAligner } from "@/lib/bible-data/bridge-align-client"
import type { TargetCellLinks, TargetPairInput } from "@/lib/bible-data/target-alignment"
import type { AlignLink } from "@/lib/bible-data/word-align"

/** One cell of the book, with the chapter it belongs to ("JHN 4"). */
export interface TargetCorpusCell extends TargetPairInput {
  chapter: string
}

export interface TargetBridgeLinks {
  links: readonly AlignLink[]
  trainedPairs: number
}

export interface TargetBridge {
  /** The links for these exact texts, or undefined when they are not computed. */
  linksFor(cellId: string, source: string, target: string): TargetBridgeLinks | undefined
  /** Compute a chapter's links (no-op while that chapter is in flight). */
  request(chapter: string): void
  subscribe(listener: () => void): () => void
  /** Bumps whenever links arrive. */
  version(): number
  /** Release the worker (a later request starts a new one); computed links are kept. */
  dispose(): void
}

export interface TargetBridgeOptions {
  /** The book's cells now, read when a request goes out. */
  corpus: () => readonly TargetCorpusCell[]
  aligner?: TargetAligner
}

export function createTargetBridge({ corpus, aligner = createTargetAligner() }: TargetBridgeOptions): TargetBridge {
  const results = new Map<string, TargetCellLinks>()
  const inFlight = new Set<string>()
  const listeners = new Set<() => void>()
  let trainedPairs = 0
  let version = 0

  const notify = () => {
    version++
    for (const listener of listeners) listener()
  }

  return {
    linksFor(cellId, source, target) {
      const found = results.get(cellId)
      if (!found || found.sourceHash !== contentHash(source) || found.targetHash !== contentHash(target)) return undefined
      return { links: found.links, trainedPairs }
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
          trainedPairs = alignment.trainedPairs
          for (const cell of alignment.cells) results.set(cell.cellId, cell)
          // A chapter the model could not cover (too few translated cells) still
          // records its cells, with no links, so its rows stop asking.
          for (const cell of wanted) {
            if (!results.has(cell.cellId)) {
              results.set(cell.cellId, {
                cellId: cell.cellId,
                sourceHash: contentHash(cell.source),
                targetHash: contentHash(cell.target),
                links: [],
              })
            }
          }
          notify()
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
    version: () => version,
    dispose() {
      aligner.dispose()
    },
  }
}
