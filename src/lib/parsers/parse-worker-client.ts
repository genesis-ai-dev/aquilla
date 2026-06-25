// Main-thread client for the import parse worker.
//
// Routes DOM-free formats (see parse-text-formats.ts) to a Web Worker so a
// large file (a ~30k-verse eBible parses to tens of thousands of cells) never
// blocks the UI thread. Falls back to inline parsing when a worker can't be
// created (SSR / tests / older runtimes) or crashes — import must never break
// just because the worker is unavailable.

import { parseTextFormat, type TextParseRequest } from "./parse-text-formats"
import type { ImportResult } from "../import"

/** Worker infrastructure failure (creation/crash) — distinct from a genuine
 *  parse error, which should propagate rather than silently re-run inline. */
class WorkerInfraError extends Error {}

type WorkerFactory = () => Promise<Worker | null>

const defaultCreateWorker: WorkerFactory = async () => {
  if (typeof Worker === "undefined") return null
  try {
    const mod = await import("./parse.worker?worker")
    const Ctor = mod.default as new () => Worker
    return new Ctor()
  } catch {
    return null
  }
}

function runInWorker(worker: Worker, req: TextParseRequest): Promise<ImportResult[]> {
  return new Promise<ImportResult[]>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as { ok?: boolean; results?: ImportResult[]; error?: string }
      if (data?.ok) resolve(data.results ?? [])
      else reject(new Error(data?.error ?? "parse worker failed"))
    }
    worker.onerror = (event: unknown) => {
      const msg = (event as { message?: string })?.message ?? "parse worker crashed"
      reject(new WorkerInfraError(msg))
    }
    worker.postMessage(req)
  })
}

/**
 * Parse a DOM-free import format off the main thread. `createWorker` is an
 * injection seam for tests; production uses the bundled `?worker` module.
 */
export async function parseTextFormatOffMainThread(
  req: TextParseRequest,
  createWorker: WorkerFactory = defaultCreateWorker,
): Promise<ImportResult[]> {
  const worker = await createWorker()
  if (!worker) return parseTextFormat(req)
  try {
    return await runInWorker(worker, req)
  } catch (err) {
    // Worker couldn't run (crash/infra) → degrade to inline so the import still
    // succeeds. A genuine parse failure (ok:false) propagates instead.
    if (err instanceof WorkerInfraError) return parseTextFormat(req)
    throw err
  } finally {
    worker.terminate()
  }
}
