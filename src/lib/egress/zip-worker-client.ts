// Main-thread client for the egress zip packaging worker (AQU-1269).
//
// Org export used to DEFLATE both the per-project cache zips and the final org
// zip on the UI thread, so a large payload (audio/PCM especially) froze the app
// for the whole of compression. Routing packaging through a Web Worker lets it
// overlap with the fetching the run is still doing.
//
// One worker is created lazily and reused for the whole run. Falls back to
// inline packing when a worker can't be created (SSR / tests / older runtimes)
// or crashes — an export must never fail just because the worker is
// unavailable, it just blocks the UI like it used to.

import {
  packZip,
  unpackZip,
  type ZipWorkerPayload,
  type ZipWorkerRequest,
  type ZipWorkerResponse,
} from "./zip-core"
import type { EgressZipEntry } from "./build-project-export"

/** Worker infrastructure failure (creation/crash) — distinct from a genuine
 *  zip error, which should propagate rather than silently re-run inline. */
class WorkerInfraError extends Error {}

export type ZipWorkerFactory = () => Promise<Worker | null>

const defaultCreateWorker: ZipWorkerFactory = async () => {
  if (typeof Worker === "undefined") return null
  try {
    const mod = await import("./zip.worker?worker")
    const Ctor = mod.default as new () => Worker
    return new Ctor()
  } catch {
    return null
  }
}

export interface EgressZipPacker {
  /** DEFLATE entries into one zip blob. */
  pack(entries: readonly EgressZipEntry[]): Promise<Blob>
  /** Inflate a cached per-project zip back into entries. */
  unpack(bytes: ArrayBuffer): Promise<EgressZipEntry[]>
  /** True once packaging has degraded to the main thread for this run. */
  readonly inline: boolean
  dispose(): void
}

interface Pending {
  resolve: (response: ZipWorkerResponse) => void
  reject: (error: unknown) => void
}

/**
 * Create a packer for one egress run. `createWorker` is an injection seam for
 * tests; production uses the bundled `?worker` module.
 */
export function createEgressZipPacker(
  createWorker: ZipWorkerFactory = defaultCreateWorker,
): EgressZipPacker {
  const pending = new Map<string, Pending>()
  let worker: Worker | undefined
  let workerPromise: Promise<Worker | null> | undefined
  let degraded = false
  let disposed = false
  let sequence = 0

  const failAll = (error: Error): void => {
    for (const [id, call] of [...pending]) {
      pending.delete(id)
      call.reject(error)
    }
  }

  const onMessage = (event: MessageEvent<ZipWorkerResponse>): void => {
    const response = event.data
    if (!response || typeof response.id !== "string") return
    const call = pending.get(response.id)
    if (!call) return
    pending.delete(response.id)
    call.resolve(response)
  }

  const onError = (event: ErrorEvent): void => {
    // A crash kills the worker for good — degrade the rest of the run inline.
    degraded = true
    failAll(new WorkerInfraError(event.message || "egress zip worker crashed"))
  }

  const getWorker = async (): Promise<Worker | null> => {
    if (disposed || degraded) return null
    if (!workerPromise) {
      workerPromise = Promise.resolve(createWorker())
        .then((created) => {
          if (!created) return null
          if (disposed) {
            created.terminate()
            return null
          }
          worker = created
          created.addEventListener("message", onMessage as EventListener)
          created.addEventListener("error", onError as EventListener)
          return created
        })
        .catch(() => null)
    }
    return workerPromise
  }

  const send = async (request: ZipWorkerPayload): Promise<ZipWorkerResponse> => {
    const endpoint = await getWorker()
    if (!endpoint) throw new WorkerInfraError("no egress zip worker available")
    const id = `zip-${++sequence}`
    return new Promise<ZipWorkerResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      try {
        endpoint.postMessage({ ...request, id } satisfies ZipWorkerRequest)
      } catch (err) {
        pending.delete(id)
        // postMessage only throws on a clone failure or a dead port; either
        // way this run belongs on the main thread now.
        degraded = true
        reject(new WorkerInfraError(err instanceof Error ? err.message : String(err)))
      }
    })
  }

  /** Run `request` in the worker, degrading to `inline` on infra failure. */
  const run = async <Result>(
    request: ZipWorkerPayload,
    read: (response: ZipWorkerResponse) => Result,
    inline: () => Promise<Result>,
  ): Promise<Result> => {
    if (degraded) return inline()
    let response: ZipWorkerResponse
    try {
      response = await send(request)
    } catch (err) {
      if (err instanceof WorkerInfraError) {
        degraded = true
        return inline()
      }
      throw err
    }
    if (!response.ok) throw new Error(response.error)
    return read(response)
  }

  return {
    pack: (entries) =>
      run(
        { op: "pack", entries },
        (response) => ("blob" in response ? response.blob : new Blob()),
        () => packZip(entries),
      ),
    unpack: (bytes) =>
      run(
        { op: "unpack", bytes },
        (response) => ("entries" in response ? response.entries : []),
        () => unpackZip(bytes),
      ),
    get inline(): boolean {
      return degraded
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      failAll(new WorkerInfraError("egress zip packer disposed"))
      if (worker) {
        worker.removeEventListener("message", onMessage as EventListener)
        worker.removeEventListener("error", onError as EventListener)
        worker.terminate()
        worker = undefined
      }
    },
  }
}
