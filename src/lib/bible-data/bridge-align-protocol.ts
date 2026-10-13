// What the bridge-align worker understands (AQU-1694). Shared by the worker
// and by the inline fallback the client uses when no Worker can be created
// (tests, SSR), so the two cannot answer differently.
//
//   source — Bridge 1: align a book's source cells to the pack's words.
//            Reports progress per EM pass, then the whole book.
//   target — Bridge 2: align some cells' source and target texts, with a
//            model trained on the book's translated cells. The model is kept
//            between requests while the training text stays the same.

import type { BkpTextLayer } from "./pack-types"
import { alignSourceBook, type SourceBookAlignment, type SourceCellInput } from "./source-alignment"
import { alignTargetCells, corpusKey, trainTargetModel, type TargetAlignment, type TargetModel, type TargetPairInput } from "./target-alignment"

export type BridgeAlignRequest =
  | { op: "source"; id: string; text: BkpTextLayer; cells: SourceCellInput[] }
  | { op: "target"; id: string; corpus: TargetPairInput[]; wanted: TargetPairInput[] }

export type BridgeAlignResponse =
  | { id: string; kind: "progress"; done: number; total: number }
  | { id: string; kind: "source"; result: SourceBookAlignment }
  | { id: string; kind: "target"; result: TargetAlignment }
  | { id: string; kind: "error"; error: string }

let targetModel: TargetModel | null = null

/** Answer one request; `post` receives progress and then exactly one result or error. */
export function handleBridgeRequest(
  request: BridgeAlignRequest,
  post: (response: BridgeAlignResponse) => void,
  shouldStop: () => boolean = () => false,
): void {
  try {
    if (request.op === "source") {
      const result = alignSourceBook(request.text, request.cells, {
        onProgress: (done, total) => post({ id: request.id, kind: "progress", done, total }),
        shouldStop,
      })
      if (!result) {
        post({ id: request.id, kind: "error", error: "cancelled" })
        return
      }
      post({ id: request.id, kind: "source", result })
      return
    }
    if (!targetModel || targetModel.key !== corpusKey(request.corpus)) targetModel = trainTargetModel(request.corpus)
    post({ id: request.id, kind: "target", result: alignTargetCells(targetModel, request.wanted) })
  } catch (err) {
    post({ id: request.id, kind: "error", error: err instanceof Error ? err.message : String(err) })
  }
}

/** Forget the kept Bridge 2 model (tests). */
export function __resetBridgeModelForTests(): void {
  targetModel = null
}
