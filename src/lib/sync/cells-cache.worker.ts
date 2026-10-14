import { createCacheWriterReceiver, type CacheWriterMessage } from "./cells-cache-writer"
import { isQuotaExceededError } from "@/lib/storage/storage-pressure"

const receive = createCacheWriterReceiver()
self.onmessage = async (event: MessageEvent<CacheWriterMessage>) => {
  try {
    await receive(event.data)
    self.postMessage({ ok: true })
  } catch (error) {
    // AQU-1865: distinguish "out of space" from every other write failure. The
    // main thread responds to the former by shedding cache bytes so the outbox
    // keeps its room; a DOMException cannot cross postMessage, so send a flag.
    self.postMessage({ ok: false, quotaExceeded: isQuotaExceededError(error) })
  }
}
