// AQU-2664 (the weak-hardware rule): measure a take's loudness OFF the page.
//
// In the browser the meter runs in `loudness.worker.ts` (the repo's worker
// pattern, as forecast-client.ts), one worker reused take after take and let
// go after a minute idle. The samples are TRANSFERRED to it, never copied, so
// a long take costs no second copy of its PCM.
//
// THE FALLBACK is the existing simpler path: the same meter on the page,
// yielding a macrotask before every take and after about every second of
// samples inside one (loudness.ts `measureLoudnessYielding`), so typing and
// painting carry on. It is used when there is no Worker (the unit suite, an
// old WebView), when the worker can't be made, doesn't answer its "are you
// there?" within 5 s, or reports an error. The samples go to the worker only
// AFTER it has answered, so a worker that fails to start can never take them
// with it; one that fails on a take hands them back. After one failure the
// page path is used for the rest of the session. The only loss is a worker
// that dies mid-take (out of memory): the samples went with it, the take's
// measure fails, and evening out skips it (it plays at its own volume).

import { measureLoudnessYielding, yieldToPage, type LoudnessReading } from "./loudness"
import { buffersOf, type LoudnessRequest, type LoudnessResponse } from "./loudness-protocol"

export interface WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage(message: LoudnessRequest, transfer?: Transferable[]): void
  terminate(): void
}

export interface LoudnessClientOptions {
  /** Make the worker; null or a throw = no worker (the page path). */
  makeWorker?: () => WorkerLike | null
  /** How the page path gives the page a turn. */
  yieldFn?: () => Promise<void>
  /** How long a new worker has to answer before the page path is used. */
  readyTimeoutMs?: number
  /** A worker idle this long is let go (a new one starts on the next take). */
  idleMs?: number
}

export interface LoudnessClient {
  /** Measure a take. Its channels' buffers may be transferred: don't reuse them. */
  measure(channels: Float32Array[], rate: number): Promise<LoudnessReading>
  /** Which path the last measure took. */
  lastPath(): "worker" | "page" | null
  dispose(): void
}

function defaultWorker(): WorkerLike | null {
  if (typeof Worker === "undefined" || import.meta.env?.MODE === "test") return null
  return new Worker(new URL("./loudness.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike
}

class WorkerFailed extends Error {
  readonly channels: Float32Array[] | null
  constructor(message: string, channels: Float32Array[] | null) {
    super(message)
    this.channels = channels
  }
}

export function createLoudnessClient(opts: LoudnessClientOptions = {}): LoudnessClient {
  const makeWorker = opts.makeWorker ?? defaultWorker
  const pause = opts.yieldFn ?? yieldToPage
  const readyTimeoutMs = opts.readyTimeoutMs ?? 5_000
  const idleMs = opts.idleMs ?? 60_000
  let worker: WorkerLike | null = null
  let ready: Promise<WorkerLike | null> | null = null
  let broken = false
  let path: "worker" | "page" | null = null
  let nextId = 1
  let idle: ReturnType<typeof setTimeout> | null = null
  const pending = new Map<number, { resolve: (r: LoudnessReading) => void; reject: (e: WorkerFailed) => void }>()
  let onPong: (() => void) | null = null

  const drop = (why: string, markBroken: boolean) => {
    if (markBroken) broken = true
    const w = worker
    worker = null
    ready = null
    for (const p of pending.values()) p.reject(new WorkerFailed(why, null))
    pending.clear()
    try {
      w?.terminate()
    } catch {
      // already gone
    }
  }

  const start = (): Promise<WorkerLike | null> => {
    if (broken) return Promise.resolve(null)
    if (ready) return ready
    let w: WorkerLike | null
    try {
      w = makeWorker()
    } catch {
      w = null
    }
    if (!w) {
      broken = true
      return Promise.resolve(null)
    }
    worker = w
    w.onmessage = (event: MessageEvent) => {
      const msg = event.data as LoudnessResponse
      if (msg.type === "pong") {
        onPong?.()
        return
      }
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (!p) return
      if (msg.type === "result") p.resolve(msg.reading)
      else p.reject(new WorkerFailed(msg.message, msg.channels))
    }
    w.onerror = () => drop("loudness worker failed", true)
    ready = new Promise<WorkerLike | null>((resolve) => {
      const timer = setTimeout(() => {
        onPong = null
        drop("loudness worker did not answer", true)
        resolve(null)
      }, readyTimeoutMs)
      onPong = () => {
        clearTimeout(timer)
        onPong = null
        resolve(w)
      }
      const prevError = w!.onerror
      w!.onerror = (e) => {
        clearTimeout(timer)
        onPong = null
        prevError?.(e)
        resolve(null)
      }
      try {
        w!.postMessage({ type: "ping" })
      } catch {
        clearTimeout(timer)
        drop("loudness worker failed", true)
        resolve(null)
      }
    })
    return ready
  }

  const viaWorker = (w: WorkerLike, channels: Float32Array[], rate: number) =>
    new Promise<LoudnessReading>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      w.postMessage({ type: "measure", id, rate, channels }, buffersOf(channels))
    })

  const onPage = async (channels: Float32Array[], rate: number) => {
    path = "page"
    await pause()
    return measureLoudnessYielding(channels, rate, { yieldFn: pause })
  }

  const armIdle = () => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => {
      idle = null
      if (pending.size === 0 && worker) drop("idle", false)
    }, idleMs)
  }

  return {
    async measure(channels, rate) {
      const w = await start()
      if (!w) return onPage(channels, rate)
      try {
        const r = await viaWorker(w, channels, rate)
        path = "worker"
        armIdle()
        return r
      } catch (e) {
        drop("loudness worker failed", true)
        const back = e instanceof WorkerFailed ? e.channels : null
        // Handed back: measure them here. Gone with the worker: this take fails.
        if (back) return onPage(back, rate)
        throw e
      }
    },
    lastPath: () => path,
    dispose() {
      if (idle) clearTimeout(idle)
      drop("disposed", false)
    },
  }
}

let shared: LoudnessClient | null = null
/** The app's one loudness client. */
export function loudnessClient(): LoudnessClient {
  shared ??= createLoudnessClient()
  return shared
}
