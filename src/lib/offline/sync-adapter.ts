/**
 * Custom LiveStore sync adapter (Phase 3) — keeps one project's local
 * SQLite copy in step with sync-worker, and flushes locally queued offline
 * writes back to the server on reconnect.
 *
 * Deliberately NOT LiveStore's own sync protocol (see schema.ts's header
 * comment): every event in schema.ts is `clientOnly`, so nothing here is
 * "LiveStore sync" in the framework sense. This module wraps the SAME
 * WebSocket/HTTP surface the browser SPA already uses
 * (src/lib/sync/ws-reconciler.ts, POST /events) and projects the results
 * into LiveStore tables instead of React state.
 *
 * Two directions:
 *  - Downstream: `event.applied` frames carrying projected `rows` (the
 *    server's per-cell content snapshot, same shape ProjectWorkspace lands
 *    via live-apply.ts) are written straight into the `cells` table.
 *  - Upstream: rows queued locally in `event_queue` (Phase 4 will populate
 *    this from offline writes) are POSTed to `/events` whenever the queue
 *    gains pending rows, and again on every reconnect.
 *    A `stale` result (AD-2 head CAS lost) dequeues the row and marks the
 *    cell conflicted (src/lib/offline/conflicts.ts) rather than retrying —
 *    retrying a stale write forever cannot succeed, since its `parentId` no
 *    longer matches the row's head.
 *
 * Flushing is triggered by an `event_queue` SUBSCRIPTION, not only by the
 * reconciler's `onOpen`. Reconnect-only flushing was the bug (AQU-1003
 * follow-up): on a
 * desktop that is online and already connected, the socket never reopens, so
 * every offline-routed write (target.cell.commit / cell.validate /
 * cell.unvalidate on a downloaded project — see OFFLINE_ROUTABLE_KINDS in
 * src/lib/sync/outbox.ts) sat in `event_queue` forever. Downstream kept
 * working over the same open socket, which is why it looked like "Tauri pulls
 * changes down but never pushes them up".
 */
import type { Store } from "@livestore/livestore"
import {
  createWsReconciler,
  parseAppliedEventFrame,
  type ProjectWsServerMessage,
  type WsReconciler,
} from "@/lib/sync/ws-reconciler"
import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"
import type { OutboxEventKind, OutboxPayloadFor, OutboxRawEvent } from "@/lib/sync/outbox-types"
import { cellRowId, events, tables, type schema } from "./schema"
import { markConflict } from "./conflicts"

/** Matches buildProjectAwareMinter's signature (src/lib/sync/cqrs-bridge.ts) —
 *  callers typically pass that function directly. */
export type MintToken = (
  projectId: string,
  fileId: string,
) => Promise<{ token: string | null; status: number | null }>

export interface OfflineSyncAdapterOptions {
  projectId: string
  store: Store<typeof schema>
  /**
   * Mints a sync-worker token scoped to (projectId, fileId). The adapter
   * picks any file already synced for this project — a file-scoped token
   * still authorizes the project-level DO connection, exactly like
   * ProjectWorkspace's own WS reconciler (see ws-reconciler.ts header).
   */
  mintToken: MintToken
  /** HTTP(S) origin for sync-worker. Defaults to syncWorkerHttpOrigin(). */
  baseUrl?: string
  fetchImpl?: typeof fetch
  webSocketCtor?: typeof WebSocket
  minBackoffMs?: number
  maxBackoffMs?: number
  /**
   * Coalescing delay between an `event_queue` insert and the POST it triggers.
   * A commit lands as several rows (a target.cell.commit plus its
   * cell.validate, say), and the editor's own debounce can land more right
   * behind them; waiting a beat sends them as one request instead of three.
   */
  flushDebounceMs?: number
  /** First retry delay after a transient flush failure (network down, 5xx). */
  minFlushRetryMs?: number
  /** Ceiling the retry delay backs off to. */
  maxFlushRetryMs?: number
}

export interface OfflineSyncAdapter {
  isConnected(): boolean
  /** Flush the local event_queue now, outside the normal on-reconnect trigger. */
  flushNow(): Promise<void>
  close(): void
}

interface FlushResponseBody {
  accepted?: Array<{ id: string }>
  rejected?: Array<{ id: string; status: number; reason: string }>
  stale?: Array<{ id: string; fileId: string | null; cellId: string | null }>
  applied?: unknown[]
}

/** Row shape returned by `tables.eventQueue.select()` — see schema.ts. */
interface EventQueueRow {
  id: string
  projectId: string
  fileId: string | null
  cellId: string | null
  kind: string
  payload: unknown
  parentId: string | null
  author: string
  schemaVersion: number
  clientTs: Date
  status: "pending" | "flushing" | "failed"
}

function toRawEvent(row: EventQueueRow): OutboxRawEvent {
  return {
    id: row.id,
    schemaVersion: row.schemaVersion,
    kind: row.kind as OutboxEventKind,
    projectId: row.projectId,
    fileId: row.fileId ?? undefined,
    cellId: row.cellId ?? undefined,
    parentId: row.parentId,
    author: row.author,
    payload: row.payload as OutboxPayloadFor<OutboxEventKind>,
    clientTs: row.clientTs.getTime(),
  }
}

export function createOfflineSyncAdapter(options: OfflineSyncAdapterOptions): OfflineSyncAdapter {
  const { projectId, store } = options
  const baseUrl = options.baseUrl ?? syncWorkerHttpOrigin()
  const fetchFn = options.fetchImpl ?? fetch
  const flushDebounceMs = options.flushDebounceMs ?? 250
  const minFlushRetryMs = options.minFlushRetryMs ?? 2_000
  const maxFlushRetryMs = options.maxFlushRetryMs ?? 60_000

  let closed = false
  let flushInFlight = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let flushRetryDelay = minFlushRetryMs

  function applyRows(frame: Extract<ProjectWsServerMessage, { t: "event.applied" }>): void {
    if (!frame.file || !frame.rows) return
    for (const row of frame.rows) {
      store.commit(
        events.cellSynced({
          projectId,
          fileId: frame.file,
          cellId: row.cellId,
          side: row.side,
          value: row.value,
          valueHtml: row.valueHtml,
          eventId: row.eventId,
          sourceEventId: row.sourceEventId,
          validated: row.validated,
          aiDrafted: row.aiDrafted ?? false,
          sequenceIndex: row.sequenceIndex ?? 0,
          canonicalRef: row.canonicalRef,
        }),
      )
    }
  }

  /** Dequeue a locally queued write once the server has resolved it (accepted
   *  or permanently rejected) — a no-op if `id` isn't in the queue. */
  function dequeueIfQueued(id: string): void {
    const queued = store.query(tables.eventQueue.select().where({ id }).first())
    if (queued) store.commit(events.eventDequeued({ id }))
  }

  function handleMessage(msg: ProjectWsServerMessage): void {
    if (msg.t === "event.applied") {
      dequeueIfQueued(msg.id)
      applyRows(msg)
      return
    }
    if (msg.t === "event.stale") {
      const queued = store.query(tables.eventQueue.select().where({ id: msg.id }).first())
      if (!queued) return
      store.commit(events.eventDequeued({ id: msg.id }))
      if (queued.fileId && queued.cellId) {
        markConflict(cellRowId(projectId, queued.fileId, queued.cellId, "target"))
      }
    }
  }

  async function getToken(): Promise<string | null> {
    const file = store.query(tables.files.select().where({ projectId }).first())
    if (!file) return null
    const mint = await options.mintToken(projectId, file.id)
    return mint.token
  }

  const reconciler: WsReconciler = createWsReconciler(
    {
      projectId,
      getToken,
      baseUrl,
      webSocketCtor: options.webSocketCtor,
      minBackoffMs: options.minBackoffMs,
      maxBackoffMs: options.maxBackoffMs,
    },
    {
      onMessage: handleMessage,
      onOpen: () => {
        // A reconnect means the network just came back: retry immediately and
        // from a clean backoff rather than serving out a delay earned while
        // the connection was down.
        flushRetryDelay = minFlushRetryMs
        cancelFlushTimer()
        void flushNow()
      },
    },
  )

  // Serialize flushes — a reconnect racing an explicit flushNow() must not
  // POST the same queued rows twice.
  let flushChain: Promise<void> = Promise.resolve()

  /**
   * "idle"  — nothing was pending, nothing to reschedule.
   * "ok"    — the server answered; every row was resolved per its verdict.
   * "retry" — transient failure (offline, unmintable token, 5xx, bad body);
   *           the rows are back to `pending` and need another attempt.
   */
  type FlushOutcome = "idle" | "ok" | "retry"

  async function flushQueue(): Promise<FlushOutcome> {
    const pending = store.query(
      tables.eventQueue.select().where({ projectId, status: "pending" }),
    ) as readonly EventQueueRow[]
    if (pending.length === 0) return "idle"

    const ids = pending.map((r) => r.id)
    for (const id of ids) store.commit(events.eventQueueStatusSet({ id, status: "flushing" }))

    const revertToPending = (): void => {
      for (const id of ids) store.commit(events.eventQueueStatusSet({ id, status: "pending" }))
    }

    const file = store.query(tables.files.select().where({ projectId }).first())
    if (!file) {
      revertToPending()
      return "retry"
    }
    const mint = await options.mintToken(projectId, file.id)
    if (!mint.token) {
      revertToPending()
      return "retry"
    }

    const rawEvents = pending.map(toRawEvent)
    let res: Response
    try {
      res = await fetchFn(`${baseUrl}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mint.token}` },
        body: JSON.stringify({ events: rawEvents }),
      })
    } catch {
      revertToPending()
      return "retry"
    }
    if (!res.ok) {
      revertToPending()
      return "retry"
    }

    let body: FlushResponseBody
    try {
      body = (await res.json()) as FlushResponseBody
    } catch {
      revertToPending()
      return "retry"
    }

    const acceptedIds = new Set((body.accepted ?? []).map((a) => a.id))
    const permanentlyRejected = new Map(
      (body.rejected ?? [])
        .filter((r) => r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 403)
        .map((r) => [r.id, r] as const),
    )
    const forbidden = new Set(
      (body.rejected ?? []).filter((r) => r.status === 403).map((r) => r.id),
    )
    const staleById = new Map((body.stale ?? []).map((s) => [s.id, s]))
    const rowById = new Map(pending.map((r) => [r.id, r]))

    for (const id of ids) {
      // Check stale FIRST: per CLAUDE.md's AD-2 head-CAS contract, a stale
      // sibling is "logged, 200-accepted, and reported in stale[]" — its id
      // lands in BOTH `accepted` and `stale`. Checking `accepted` first would
      // dequeue it silently without ever marking the conflict (caught by the
      // manual smoke test against the real server — the unit tests' fakes
      // had never modeled these two arrays overlapping).
      const stale = staleById.get(id)
      if (stale) {
        store.commit(events.eventDequeued({ id }))
        const row = rowById.get(id)
        if (row?.fileId && row.cellId) {
          markConflict(cellRowId(projectId, row.fileId, row.cellId, "target"))
        }
        continue
      }
      if (acceptedIds.has(id) || permanentlyRejected.has(id)) {
        store.commit(events.eventDequeued({ id }))
        continue
      }
      if (forbidden.has(id)) {
        // Not retryable and not a staleness conflict — leave it visibly
        // stuck ("failed") rather than dequeuing (silent data loss) or
        // retrying forever (head-of-line blocking every future flush).
        store.commit(events.eventQueueStatusSet({ id, status: "failed" }))
        continue
      }
      // 401 / 5xx / unacknowledged — transient, retry on the next reconnect
      // or explicit flushNow().
      store.commit(events.eventQueueStatusSet({ id, status: "pending" }))
    }

    // Land the server's projected rows for our own accepted writes directly,
    // rather than waiting for the WS echo of each event.applied — the flush
    // already has them and the round trip may be slower than this response.
    if (Array.isArray(body.applied)) {
      for (const raw of body.applied) {
        const frame = parseAppliedEventFrame(raw)
        if (frame) applyRows(frame)
      }
    }
    return "ok"
  }

  function hasPending(): boolean {
    return (
      store.query(tables.eventQueue.select().where({ projectId, status: "pending" }).first()) != null
    )
  }

  function cancelFlushTimer(): void {
    if (flushTimer === null) return
    clearTimeout(flushTimer)
    flushTimer = null
  }

  /** Arm a flush `delayMs` from now, unless one is already armed or the queue
   *  holds nothing to send. */
  function armFlush(delayMs: number): void {
    if (closed || flushTimer !== null) return
    if (!hasPending()) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flushNow()
    }, delayMs)
  }

  /** One flush attempt, plus the decision about when to try again. */
  async function runFlush(): Promise<void> {
    flushInFlight = true
    let outcome: FlushOutcome
    try {
      outcome = await flushQueue()
    } finally {
      flushInFlight = false
    }
    // flushQueue's own status commits fire the queue subscription; whether
    // that lands synchronously or on a microtask is LiveStore's business, so
    // drop anything it armed rather than reasoning about the timing. The
    // outcome below is the authority on when the next attempt happens.
    cancelFlushTimer()
    if (outcome === "retry") {
      armFlush(flushRetryDelay)
      flushRetryDelay = Math.min(flushRetryDelay * 2, maxFlushRetryMs)
      return
    }
    flushRetryDelay = minFlushRetryMs
    // Rows enqueued while the POST was in flight were never part of it —
    // a no-op when the queue came back empty.
    armFlush(flushDebounceMs)
  }

  function flushNow(): Promise<void> {
    const run = flushChain.then(() => runFlush())
    flushChain = run.catch(() => undefined)
    return run
  }

  // THE upstream trigger: a write reaching `event_queue` flushes it. Skipped
  // while a flush is in flight — runFlush() reschedules from the outcome, and
  // letting its own pending→flushing→pending churn arm timers here would
  // defeat the retry backoff (and, on a persistently failing flush, spin).
  const unsubscribeQueue = store.subscribe(
    tables.eventQueue.select().where({ projectId }),
    () => {
      if (flushInFlight) return
      armFlush(flushDebounceMs)
    },
  )

  // Anything already queued from a previous session (the app was closed with
  // unsynced work) goes out without waiting for the socket.
  armFlush(flushDebounceMs)

  return {
    isConnected: () => reconciler.isConnected(),
    flushNow,
    close: (): void => {
      closed = true
      cancelFlushTimer()
      unsubscribeQueue()
      reconciler.close()
    },
  }
}
