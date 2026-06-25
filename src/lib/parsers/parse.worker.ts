/// <reference lib="webworker" />
// Import parse worker: runs the DOM-free parse core off the main thread so a
// large file import never freezes the UI. Receives a TextParseRequest, replies
// with { ok: true, results } or { ok: false, error }. The main-thread client
// (parse-worker-client.ts) owns lifecycle + fallback.

import { parseTextFormat, type TextParseRequest } from "./parse-text-formats"

self.addEventListener("message", (event: MessageEvent<TextParseRequest>) => {
  try {
    const results = parseTextFormat(event.data)
    ;(self as unknown as Worker).postMessage({ ok: true, results })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
})
