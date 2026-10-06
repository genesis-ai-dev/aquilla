/// <reference lib="webworker" />
// Bridge alignment worker (AQU-1694): trains and runs the Bible data bridges
// off the main thread, so aligning a book never freezes the editor. The
// protocol and the work live in bridge-align-protocol.ts; the main-thread
// client (bridge-align-client.ts) owns lifecycle, cancellation (it
// terminates this worker) and the inline fallback.

import { handleBridgeRequest, type BridgeAlignRequest } from "./bridge-align-protocol"

self.addEventListener("message", (event: MessageEvent<BridgeAlignRequest>) => {
  handleBridgeRequest(event.data, (response) => {
    ;(self as unknown as Worker).postMessage(response)
  })
})
