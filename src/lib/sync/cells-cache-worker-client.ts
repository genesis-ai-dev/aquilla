import type { CellsCacheEntry } from "./cells-cache"
import { CELLS_CACHE_BATCH_ROWS, type CacheWriterMessage } from "./cells-cache-writer"

export async function putCellsCacheInWorker(entry: CellsCacheEntry): Promise<void> {
  const worker = new Worker(new URL("./cells-cache.worker.ts", import.meta.url), { type: "module" })
  let rejectPending: ((reason: Error) => void) | undefined
  const fail = () => rejectPending?.(new Error("Cache worker failed"))
  worker.onerror = fail
  worker.onmessageerror = fail
  const send = (message: CacheWriterMessage) => new Promise<void>((resolve, reject) => {
    rejectPending = reject
    worker.onmessage = (event: MessageEvent<{ ok: boolean }>) => {
      if (event.data.ok) resolve()
      else reject(new Error("Cache worker write failed"))
    }
    worker.postMessage(message)
  })
  // Best-effort cache only; never leave a flush waiting forever on a crashed
  // or suspended worker. This does not affect the durable edit outbox.
  const timeout = setTimeout(fail, 60_000)
  try {
    const { rows, ...header } = entry
    await send({ type: "start", header })
    for (let i = 0; i < rows.length; i += CELLS_CACHE_BATCH_ROWS) {
      // Awaiting the acknowledgement yields to input between bounded clones.
      await send({ type: "rows", rows: rows.slice(i, i + CELLS_CACHE_BATCH_ROWS) })
    }
    await send({ type: "commit" })
  } finally {
    clearTimeout(timeout)
    worker.terminate()
  }
}
