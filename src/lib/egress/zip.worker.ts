/// <reference lib="webworker" />
// Egress zip packaging worker: runs JSZip DEFLATE (and cached-zip inflate) off
// the main thread so compressing a large org export — worse with audio/PCM —
// never freezes the UI while the next project is still being fetched.
//
// Protocol mirrors parse.worker.ts: one request in, {ok:true,…} or
// {ok:false,error} out, correlated by id. The main-thread client
// (zip-worker-client.ts) owns lifecycle + inline fallback.

import { packZip, unpackZip, type ZipWorkerRequest } from "./zip-core"

self.addEventListener("message", (event: MessageEvent<ZipWorkerRequest>) => {
  const req = event.data
  const post = (msg: unknown): void => {
    ;(self as unknown as Worker).postMessage(msg)
  }
  void (async () => {
    try {
      if (req.op === "pack") {
        post({ id: req.id, ok: true, blob: await packZip(req.entries) })
      } else {
        post({ id: req.id, ok: true, entries: await unpackZip(req.bytes) })
      }
    } catch (err) {
      post({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })()
})
