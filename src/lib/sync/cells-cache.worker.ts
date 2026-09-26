import { createCacheWriterReceiver, type CacheWriterMessage } from "./cells-cache-writer"

const receive = createCacheWriterReceiver()
self.onmessage = async (event: MessageEvent<CacheWriterMessage>) => {
  try {
    await receive(event.data)
    self.postMessage({ ok: true })
  } catch {
    self.postMessage({ ok: false })
  }
}
