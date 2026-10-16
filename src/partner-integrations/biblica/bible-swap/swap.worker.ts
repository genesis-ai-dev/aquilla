/// <reference lib="webworker" />

// Keeping this entry tiny means the swap the worker runs is byte-for-byte the
// same handler the protocol tests exercise on the main thread.
import { handleBibleSwapRequest } from "./swap-worker-handler"
import type { BibleSwapWorkerRequest, BibleSwapWorkerResponse } from "./swap-worker-protocol"

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.addEventListener("message", (event: MessageEvent<BibleSwapWorkerRequest>) => {
  const request = event.data
  if (!request || request.type !== "swap") return
  handleBibleSwapRequest(request, (response: BibleSwapWorkerResponse) =>
    scope.postMessage(response),
  )
})
