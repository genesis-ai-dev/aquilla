// AQU-1937: a cheap safety net under the bridge. data.put calls that arrive
// within a few milliseconds of each other for the same (namespace,
// collection) — a `forEach` / `map` / `Promise.all` over verses — are sent as
// ONE dataPutMany (one anchor lookup, one write batch) instead of one write
// round trip each. Every caller still gets its own result or error: if the
// batch fails (one bad anchor fails a putMany), each record is retried alone
// so only the bad one rejects. A put awaited inside a loop gains nothing (it
// waits before the next is made) — the builder rules steer code to putMany.

import type { ToolDataAnchor } from "./host-handlers-files"

export const DATA_PUT_COALESCE_MS = 4
/** Above this a window is flushed at once (well under MAX_DATA_PUT_MANY). */
const MAX_WINDOW_ITEMS = 1000

type Item = { id: string; doc: unknown; anchor: ToolDataAnchor | null }
type Result = { id: string; version: string }
type Waiter = { resolve: (r: Result) => void; reject: (e: unknown) => void }

export interface DataPutTarget {
  dataPut: (ns: string, coll: string, id: string, doc: unknown, anchor: ToolDataAnchor | null) => Promise<Result>
  dataPutMany: (ns: string, coll: string, items: Item[]) => Promise<Result[]>
}

export function createDataPutCoalescer(target: DataPutTarget, windowMs = DATA_PUT_COALESCE_MS) {
  const windows = new Map<string, { ns: string; coll: string; items: Item[]; waiters: Waiter[]; timer: ReturnType<typeof setTimeout> }>()

  const flush = (key: string) => {
    const w = windows.get(key)
    if (!w) return
    windows.delete(key)
    clearTimeout(w.timer)
    const { ns, coll, items, waiters } = w
    // A single put stays a single put (same path and errors as before).
    if (items.length === 1) {
      target.dataPut(ns, coll, items[0].id, items[0].doc, items[0].anchor).then(waiters[0].resolve, waiters[0].reject)
      return
    }
    target.dataPutMany(ns, coll, items).then(
      (results) => waiters.forEach((wt, i) => (results[i] ? wt.resolve(results[i]) : wt.reject(new Error("data.put: no result")))),
      // One failing record fails the batch: settle each on its own.
      () => items.forEach((it, i) => target.dataPut(ns, coll, it.id, it.doc, it.anchor).then(waiters[i].resolve, waiters[i].reject)),
    )
  }

  return function put(ns: string, coll: string, id: string, doc: unknown, anchor: ToolDataAnchor | null): Promise<Result> {
    const key = `${ns}\u0000${coll}`
    // The same record twice in one window: keep write order — send the window first.
    if (windows.get(key)?.items.some((it) => it.id === id)) flush(key)
    return new Promise<Result>((resolve, reject) => {
      let w = windows.get(key)
      if (!w) {
        w = { ns, coll, items: [], waiters: [], timer: setTimeout(() => flush(key), windowMs) }
        windows.set(key, w)
      }
      w.items.push({ id, doc, anchor })
      w.waiters.push({ resolve, reject })
      if (w.items.length >= MAX_WINDOW_ITEMS) flush(key)
    })
  }
}
