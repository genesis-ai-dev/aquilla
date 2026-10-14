/**
 * Main-thread handle on the BIA forecast engine.
 *
 * In the browser the engine lives in `forecast.worker.ts`; where `Worker` is
 * unavailable (Vitest/happy-dom, very old WebViews) the same protocol is
 * answered in-thread, so callers never branch.
 */

import { BiaEngine, type Suggestion } from "./bia-engine"
import type { ForecastCell } from "./bia-index"
import {
  answerForecastQuery,
  applyForecastCommand,
  type FitResult,
  type ForecastCommand,
  type ForecastQuery,
  type ForecastRequest,
  type ForecastResponse,
} from "./forecast-protocol"

export interface ForecastClient {
  upsert(cells: ForecastCell[]): void
  remove(ids: string[]): void
  clear(): void
  /** Ghost-text suggestions for a caret between `left` and `right`. */
  suggest(left: string, right: string, opts?: { excludeCellId?: string; limit?: number }): Promise<Suggestion[]>
  /** "Words that fit here" for `word` in the sentence `left word right`. */
  wordsThatFit(word: string, left: string, right: string, opts?: { excludeCellId?: string; limit?: number }): Promise<FitResult[]>
  /** Called once, on the first query — lets the owner defer corpus loading. */
  onFirstUse?: () => void
  dispose(): void
}

interface Transport {
  send(command: ForecastCommand): void
  ask(query: ForecastQuery): Promise<Omit<ForecastResponse, "id">>
  dispose(): void
}

function inThreadTransport(engine = new BiaEngine()): Transport {
  return {
    send: (command) => applyForecastCommand(engine, command),
    ask: async (query) => answerForecastQuery(engine, query),
    dispose: () => engine.index.clear(),
  }
}

function workerTransport(worker: Worker): Transport {
  let nextId = 1
  const pending = new Map<number, (response: ForecastResponse) => void>()
  worker.onmessage = (event: MessageEvent<ForecastResponse>) => {
    const resolve = pending.get(event.data.id)
    pending.delete(event.data.id)
    resolve?.(event.data)
  }
  const failAll = () => {
    for (const [id, resolve] of pending) resolve({ id, error: "forecast worker failed" })
    pending.clear()
  }
  worker.onerror = failAll
  worker.onmessageerror = failAll
  return {
    send: (command) => worker.postMessage(command satisfies ForecastRequest),
    ask: (query) =>
      new Promise((resolve) => {
        const id = nextId++
        pending.set(id, resolve)
        worker.postMessage({ type: "query", id, query } satisfies ForecastRequest)
      }),
    dispose: () => {
      failAll()
      worker.terminate()
    },
  }
}

function createTransport(): Transport {
  if (typeof Worker === "undefined" || import.meta.env?.MODE === "test") return inThreadTransport()
  try {
    return workerTransport(new Worker(new URL("./forecast.worker.ts", import.meta.url), { type: "module" }))
  } catch {
    return inThreadTransport()
  }
}

export function createForecastClient(transport: Transport = createTransport()): ForecastClient {
  let used = false
  const client: ForecastClient = {
    upsert: (cells) => {
      if (cells.length > 0) transport.send({ type: "upsert", cells })
    },
    remove: (ids) => {
      if (ids.length > 0) transport.send({ type: "remove", ids })
    },
    clear: () => transport.send({ type: "clear" }),
    suggest: async (left, right, opts = {}) => {
      markUsed()
      const response = await transport.ask({ kind: "suggest", left, right, ...opts })
      return response.suggestions ?? []
    },
    wordsThatFit: async (word, left, right, opts = {}) => {
      markUsed()
      const response = await transport.ask({ kind: "fit", word, left, right, ...opts })
      return response.fits ?? []
    },
    dispose: () => transport.dispose(),
  }
  function markUsed() {
    if (used) return
    used = true
    client.onFirstUse?.()
  }
  return client
}

/** For tests and the eval: a client answering in-thread over a given engine. */
export function createInThreadForecastClient(engine = new BiaEngine()): ForecastClient {
  return createForecastClient(inThreadTransport(engine))
}
