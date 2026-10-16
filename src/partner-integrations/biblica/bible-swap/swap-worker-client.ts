/**
 * Client for the Bible Swap Web Worker.
 *
 * Produces a `BibleSwapParallelRunner` for `applyBibleSwapToIdml`, so the swap
 * (which walks megabytes of Story XML) stays off the main thread and the export
 * dialog keeps painting. Falls back to inline execution when the runtime has no
 * `Worker`, which is what keeps the swap usable under Vitest.
 */

import type { BibleSwapParallelRunner } from "./swap-runner"
import { handleBibleSwapRequest } from "./swap-worker-handler"
import type {
  BibleSwapWorkerProgress,
  BibleSwapWorkerRequest,
  BibleSwapWorkerResponse,
  BibleSwapWorkerResult,
} from "./swap-worker-protocol"

export type BibleSwapWorkerFactory = () => Worker | Promise<Worker>

export interface CreateBibleSwapRunnerOptions {
  /** Injection seam for protocol tests; production uses the bundled entry. */
  createWorker?: BibleSwapWorkerFactory
  onProgress?: (progress: BibleSwapWorkerProgress) => void
}

let requestSequence = 0

const defaultCreateWorker: BibleSwapWorkerFactory = async () => {
  const module = await import("./swap.worker?worker")
  const WorkerConstructor = module.default as new () => Worker
  return new WorkerConstructor()
}

function runInline(
  request: BibleSwapWorkerRequest,
  onProgress?: (progress: BibleSwapWorkerProgress) => void,
): Promise<readonly BibleSwapWorkerResult[]> {
  return new Promise((resolve, reject) => {
    handleBibleSwapRequest(request, (response) => {
      if (response.type === "progress") onProgress?.(response.progress)
      else if (response.type === "success") resolve(response.results)
      else reject(new Error(response.message))
    })
  })
}

function runInWorker(
  worker: Worker,
  request: BibleSwapWorkerRequest,
  onProgress?: (progress: BibleSwapWorkerProgress) => void,
): Promise<readonly BibleSwapWorkerResult[]> {
  return new Promise((resolve, reject) => {
    const settle = (finish: () => void) => {
      worker.removeEventListener("message", onMessage as EventListener)
      worker.removeEventListener("error", onError as EventListener)
      finish()
    }
    const onMessage = (event: MessageEvent<BibleSwapWorkerResponse>) => {
      const response = event.data
      if (!response || response.id !== request.id) return
      if (response.type === "progress") {
        onProgress?.(response.progress)
      } else if (response.type === "success") {
        settle(() => resolve(response.results))
      } else {
        settle(() => reject(new Error(response.message)))
      }
    }
    const onError = (event: ErrorEvent) => {
      settle(() => reject(new Error(event.message || "Bible Swap worker crashed")))
    }

    worker.addEventListener("message", onMessage as EventListener)
    worker.addEventListener("error", onError as EventListener)
    worker.postMessage(request)
  })
}

/**
 * Build a runner that swaps every story in one worker round-trip. The worker is
 * created per export and terminated when the pass finishes.
 */
export function createBibleSwapRunner(
  options: CreateBibleSwapRunnerOptions = {},
): BibleSwapParallelRunner {
  const createWorker = options.createWorker ?? defaultCreateWorker

  return async (bibleStoryXml, swapMode, stories, serializedPlan, language, studyVolume) => {
    const request: BibleSwapWorkerRequest = {
      type: "swap",
      id: `bible-swap-${Date.now()}-${++requestSequence}`,
      bibleStoryXml,
      swapMode,
      stories,
      ...(serializedPlan ? { serializedPlan } : {}),
      ...(language ? { language } : {}),
      ...(studyVolume ? { studyVolume } : {}),
    }

    if (!options.createWorker && typeof Worker === "undefined") {
      const results = await runInline(request, options.onProgress)
      return [...results]
    }

    const worker = await createWorker()
    try {
      const results = await runInWorker(worker, request, options.onProgress)
      return [...results]
    } finally {
      worker.terminate()
    }
  }
}
