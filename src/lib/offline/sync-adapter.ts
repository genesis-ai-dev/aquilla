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
 *    this from offline writes) are POSTed to `/events` on every reconnect.
 *    A `stale` result (AD-2 head CAS lost) dequeues the row and marks the
 *    cell conflicted (src/lib/offline/conflicts.ts) rather than retrying —
 *    retrying a stale write forever cannot succeed, since its `parentId` no
 *    longer matches the row's head.
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
        void flushNow()
      },
    },
  )

  // Serialize flushes — a reconnect racing an explicit flushNow() must not
  // POST the same queued rows twice.
  let flushChain: Promise<void> = Promise.resolve()

  async function flushQueue(): Promise<void> {
    const pending = store.query(
      tables.eventQueue.select().where({ projectId, status: "pending" }),
    ) as readonly EventQueueRow[]
    if (pending.length === 0) return

    const ids = pending.map((r) => r.id)
    for (const id of ids) store.commit(events.eventQueueStatusSet({ id, status: "flushing" }))

    const revertToPending = (): void => {
      for (const id of ids) store.commit(events.eventQueueStatusSet({ id, status: "pending" }))
    }

    const file = store.query(tables.files.select().where({ projectId }).first())
    if (!file) {
      revertToPending()
      return
    }
    const mint = await options.mintToken(projectId, file.id)
    if (!mint.token) {
      revertToPending()
      return
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
      return
    }
    if (!res.ok) {
      revertToPending()
      return
    }

    let body: FlushResponseBody
    try {
      body = (await res.json()) as FlushResponseBody
    } catch {
      revertToPending()
      return
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
  }

  function flushNow(): Promise<void> {
    const run = flushChain.then(() => flushQueue())
    flushChain = run.catch(() => undefined)
    return run
  }

  return {
    isConnected: () => reconciler.isConnected(),
    flushNow,
    close: () => reconciler.close(),
  }
}
