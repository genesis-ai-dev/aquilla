// Main-thread client for the bridge-align worker (AQU-1694).
//
// Bridge 1 (a maintainer's "Align source text to Greek") runs in a worker of
// its own, created for the run: it reports progress per EM pass, and
// cancelling terminates it. Bridge 2 (target tints, per chapter) shares one
// long-lived worker, so the model it trains on the book stays warm between
// chapters. Like the parse and zip workers, both fall back to running inline
// when no Worker can be created (tests, SSR): slower for the UI, never broken.

import { handleBridgeRequest, type BridgeAlignRequest, type BridgeAlignResponse } from "./bridge-align-protocol"
import type { BkpRef, BkpTextLayer } from "./pack-types"
import type { SourceBookAlignment, SourceCellInput } from "./source-alignment"
import type { TargetAlignment, TargetPairInput } from "./target-alignment"

export type BridgeWorkerFactory = () => Promise<Worker | null>

const defaultCreateWorker: BridgeWorkerFactory = async () => {
  if (typeof Worker === "undefined") return null
  try {
    const mod = await import("./bridge-align.worker?worker")
    const Ctor = mod.default as new () => Worker
    return new Ctor()
  } catch {
    return null
  }
}

/** The run was cancelled; nothing it computed is used. */
export class AlignmentCancelledError extends Error {
  constructor() {
    super("alignment cancelled")
    this.name = "AbortError"
  }
}

let sequence = 0
const nextId = () => `bridge-${++sequence}`

/** Only the verses and word fields the aligner reads: a smaller message to the worker. */
export function trimTextLayer(text: BkpTextLayer, refs: Iterable<BkpRef>): BkpTextLayer {
  const out: BkpTextLayer = { book: text.book, verses: {}, words: {} }
  for (const ref of refs) {
    const ids = Object.hasOwn(text.verses, ref) ? text.verses[ref] : undefined
    if (!ids) continue
    out.verses[ref] = ids
    for (const id of ids) {
      const word = Object.hasOwn(text.words, id) ? text.words[id] : undefined
      if (!word) continue
      out.words[id] = {
        text: word.text,
        after: "",
        lemma: word.lemma,
        gloss: "",
        class: word.class,
        ...(word.type ? { type: word.type } : {}),
        morph: "",
      }
    }
  }
  return out
}

export interface SourceAlignOptions {
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
  createWorker?: BridgeWorkerFactory
}

/** Bridge 1 for a book, off the main thread. Rejects with AlignmentCancelledError when `signal` aborts. */
export async function alignSourceOffMainThread(
  text: BkpTextLayer,
  cells: SourceCellInput[],
  options: SourceAlignOptions = {},
): Promise<SourceBookAlignment> {
  const { signal, onProgress } = options
  if (signal?.aborted) throw new AlignmentCancelledError()
  const request: BridgeAlignRequest = {
    op: "source",
    id: nextId(),
    text: trimTextLayer(text, cells.flatMap((cell) => cell.refs)),
    cells,
  }
  const worker = await (options.createWorker ?? defaultCreateWorker)()
  if (!worker) {
    return await new Promise<SourceBookAlignment>((resolve, reject) => {
      handleBridgeRequest(
        request,
        (response) => settle(response, resolve, reject, onProgress),
        () => signal?.aborted ?? false,
      )
    })
  }
  return await new Promise<SourceBookAlignment>((resolve, reject) => {
    const stop = () => {
      worker.terminate()
      reject(new AlignmentCancelledError())
    }
    signal?.addEventListener("abort", stop, { once: true })
    const finish = () => {
      signal?.removeEventListener("abort", stop)
      worker.terminate()
    }
    worker.onmessage = (event: MessageEvent<BridgeAlignResponse>) => {
      settle(
        event.data,
        (result) => {
          finish()
          resolve(result)
        },
        (error) => {
          finish()
          reject(error)
        },
        onProgress,
      )
    }
    worker.onerror = (event) => {
      finish()
      reject(new Error(event.message || "alignment worker crashed"))
    }
    worker.postMessage(request)
  })
}

function settle(
  response: BridgeAlignResponse,
  resolve: (result: SourceBookAlignment) => void,
  reject: (error: Error) => void,
  onProgress?: (done: number, total: number) => void,
): void {
  if (response.kind === "progress") onProgress?.(response.done, response.total)
  else if (response.kind === "source") resolve(response.result)
  else if (response.kind === "error") reject(response.error === "cancelled" ? new AlignmentCancelledError() : new Error(response.error))
}

export interface TargetAligner {
  align(corpus: TargetPairInput[], wanted: TargetPairInput[]): Promise<TargetAlignment>
  dispose(): void
}

/** Bridge 2, one long-lived worker per editor. */
export function createTargetAligner(createWorker: BridgeWorkerFactory = defaultCreateWorker): TargetAligner {
  let worker: Promise<Worker | null> | null = null
  const pending = new Map<string, { resolve: (result: TargetAlignment) => void; reject: (error: Error) => void }>()
  const failAll = (error: Error) => {
    for (const call of pending.values()) call.reject(error)
    pending.clear()
  }
  const ready = (): Promise<Worker | null> => {
    worker ??= createWorker().then((created) => {
      if (!created) return null
      created.onmessage = (event: MessageEvent<BridgeAlignResponse>) => {
        const response = event.data
        const call = pending.get(response.id)
        if (!call || response.kind === "progress") return
        pending.delete(response.id)
        if (response.kind === "target") call.resolve(response.result)
        else call.reject(new Error(response.kind === "error" ? response.error : "unexpected reply"))
      }
      created.onerror = (event) => {
        failAll(new Error(event.message || "alignment worker crashed"))
        created.terminate()
        worker = null
      }
      return created
    })
    return worker
  }
  return {
    async align(corpus, wanted) {
      const request: BridgeAlignRequest = { op: "target", id: nextId(), corpus, wanted }
      const created = await ready()
      if (!created) {
        return await new Promise<TargetAlignment>((resolve, reject) => {
          handleBridgeRequest(request, (response) => {
            if (response.kind === "target") resolve(response.result)
            else if (response.kind === "error") reject(new Error(response.error))
          })
        })
      }
      return await new Promise<TargetAlignment>((resolve, reject) => {
        pending.set(request.id, { resolve, reject })
        created.postMessage(request)
      })
    },
    dispose() {
      failAll(new AlignmentCancelledError())
      void worker?.then((created) => created?.terminate())
      worker = null
    },
  }
}
