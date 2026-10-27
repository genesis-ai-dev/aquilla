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
 *  - Catch-up: every (re)connect, after the flush, pulls whatever changed on
 *    the server since this device last caught up (catch-up.ts). Live frames
 *    are best-effort — anything missed while closed, offline, or on a dead
 *    socket would otherwise stay stale forever.
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
import { recordOfflineUpload } from "./sync-times"
import type { Store } from "@livestore/livestore"
import {
  createWsReconciler,
  parseAppliedEventFrame,
  type ProjectWsServerMessage,
  type WsReconciler,
} from "@/lib/sync/ws-reconciler"
import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"
import type { OutboxEventKind, OutboxPayloadFor, OutboxRawEvent } from "@/lib/sync/outbox-types"
import { cellRowId, events, localLaneKey, tables, type schema } from "./schema"
import { markConflict } from "./conflicts"
import { catchUpProject, sameAsLocal, toCellSyncedArgs, type CatchUpDeps } from "./catch-up"
import { markProjectAvailable, withAccessTracking } from "./project-access"
import { desktopConnectivity, type ConnectivitySource } from "./connectivity"

/** Events per POST. sync-worker refuses more than 500 (413); a week offline can queue thousands. */
export const MAX_FLUSH_BATCH = 200

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
  /** How long live event.applied frames are buffered so a burst lands as one commit. */
  frameCoalesceMs?: number
  /** Test seam for the catch-up pull's HTTP reads (catch-up.ts). */
  catchUpDeps?: CatchUpDeps
  /** While this reports offline, nothing is attempted; coming online flushes. Defaults to the Rust probe. */
  connectivity?: ConnectivitySource
}

export interface OfflineSyncAdapter {
  isConnected(): boolean
  /** Flush the local event_queue now, outside the normal on-reconnect trigger. */
  flushNow(): Promise<void>
  /** Pull everything that changed on the server since the last catch-up. */
  catchUpNow(): Promise<void>
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

/** Queue order: oldest first, ties broken by the (time-ordered UUIDv7) id. */
function byQueueOrder(a: EventQueueRow, b: EventQueueRow): number {
  return a.clientTs.getTime() - b.clientTs.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
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
  // Every mint (WS connect, flush, catch-up) reports a 403 / success to
  // project-access.ts, so a project gone server-side is surfaced instead of
  // retried silently forever.
  const mintToken = withAccessTracking(options.mintToken)
  const baseUrl = options.baseUrl ?? syncWorkerHttpOrigin()
  const fetchFn = options.fetchImpl ?? fetch
  const flushDebounceMs = options.flushDebounceMs ?? 250
  const minFlushRetryMs = options.minFlushRetryMs ?? 2_000
  const maxFlushRetryMs = options.maxFlushRetryMs ?? 60_000
  const frameCoalesceMs = options.frameCoalesceMs ?? 100

  const connectivity = options.connectivity ?? desktopConnectivity
  // Unknown (no probe yet, or web) counts as online: try, and let a failure back off.
  const isOffline = (): boolean => connectivity.current() === false

  let closed = false
  let flushInFlight = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let flushRetryDelay = minFlushRetryMs

  type AppliedFrame = Extract<ProjectWsServerMessage, { t: "event.applied" }>
  /** The newest `serverSeq` each local cell row has landed at this session. */
  const landedSeqByRow = new Map<string, number>()
  type CommitInput = Parameters<typeof events.cellsSynced>[0]

  /**
   * The server rows `frames` carry, as one `v2.CellsSynced` per file, holding
   * only rows that differ from the local copy. AQU-1614: every lane's row
   * lands — the local row key carries the lane, so a second language no
   * longer overwrites the default lane's row. Skipping unchanged rows matters
   * after a flush: the socket echoes an event.applied for each write the
   * flush response already landed.
   */
  function syncedRowsEvents(frames: readonly AppliedFrame[]): ReturnType<typeof events.cellsSynced>[] {
    // Newest server write wins per row. Arrival order is not apply order: a
    // flush response lands after live frames that arrived while it was being
    // read — some still buffered, some already landed — and a peer's frame
    // among them may have been applied after our batch. So a frame's
    // `serverSeq` decides against any seq this row already landed with; a
    // frame without it (older workers) falls back to arrival order.
    const byFile = new Map<string, Map<string, ReturnType<typeof toCellSyncedArgs>>>()
    const seqByRow = new Map<string, number>()
    for (const frame of frames) {
      if (!frame.file || !frame.rows) continue
      let rows = byFile.get(frame.file)
      if (!rows) byFile.set(frame.file, (rows = new Map()))
      for (const row of frame.rows) {
        const args = toCellSyncedArgs(projectId, frame.file, row)
        const id = cellRowId(projectId, frame.file, args.cellId, args.side, localLaneKey(args.laneId, args.targetLang))
        const seen = seqByRow.get(id) ?? landedSeqByRow.get(id)
        if (frame.serverSeq !== undefined) {
          if (seen !== undefined && frame.serverSeq < seen) continue
          seqByRow.set(id, frame.serverSeq)
        }
        rows.set(id, args)
      }
    }
    // Callers commit what this returns straight away.
    for (const [id, seq] of seqByRow) landedSeqByRow.set(id, seq)
    const out: ReturnType<typeof events.cellsSynced>[] = []
    for (const [fileId, rows] of byFile) {
      const changed: CommitInput["rows"][number][] = []
      for (const [id, args] of rows) {
        const local = store.query(tables.cells.select().where({ id }).first())
        if (local && sameAsLocal(local, args)) continue
        const { projectId: _p, fileId: _f, ...row } = args
        changed.push(row)
      }
      if (changed.length > 0) out.push(events.cellsSynced({ projectId, fileId, rows: changed }))
    }
    return out
  }

  /**
   * AQU-1614: the local lane key of the target row a queued write belongs to.
   * The queued payload carries the lane TAG, so prefer the lane key of the
   * local row already standing in that lane (which may be keyed by `lanes.id`
   * once AQU-1616's backfill has run) and fall back to the tag key.
   */
  function queuedTargetLaneKey(fileId: string, cellId: string, payload: unknown): string {
    const tag = (payload as { targetLang?: unknown } | null | undefined)?.targetLang
    const targetLang = typeof tag === "string" ? tag : ""
    const existing = store.query(
      tables.cells.select().where({ projectId, fileId, cellId, side: "target", targetLang }).first(),
    )
    return existing?.laneKey ?? localLaneKey(null, targetLang)
  }

  // Live frames are buffered for a beat and landed together: the server
  // broadcasts one event.applied per event it applies, so a flush (or a peer's
  // bulk edit) arrives as hundreds of frames in a row — one commit each left
  // the leader the same backlog the flush batching removed.
  let bufferedFrames: AppliedFrame[] = []
  let frameTimer: ReturnType<typeof setTimeout> | null = null

  /** Takes the buffered frames, as the commits that land them: their writes
   *  leave the queue, their rows land. Empty when there is nothing to do. */
  function takeBufferedFrames(): { dequeued: string[]; frames: AppliedFrame[] } {
    if (frameTimer !== null) {
      clearTimeout(frameTimer)
      frameTimer = null
    }
    const frames = bufferedFrames
    bufferedFrames = []
    // Only ids still queued: a frame for someone else's event (or one the
    // flush response already resolved) has nothing to dequeue.
    const dequeued = frames
      .map((f) => f.id)
      .filter((id) => store.query(tables.eventQueue.select("id").where({ id }).first()) !== undefined)
    return { dequeued, frames }
  }

  function landBufferedFrames(): void {
    const { dequeued, frames } = takeBufferedFrames()
    const toCommit = [
      ...(dequeued.length > 0 ? [events.eventsDequeued({ ids: dequeued })] : []),
      ...syncedRowsEvents(frames),
    ]
    if (toCommit.length > 0) store.commit(...toCommit)
    // Resolved writes count as uploads, as they do from the flush response.
    if (dequeued.length > 0) recordOfflineUpload(projectId)
  }

  function handleMessage(msg: ProjectWsServerMessage): void {
    if (msg.t === "event.applied") {
      bufferedFrames.push(msg)
      frameTimer ??= setTimeout(landBufferedFrames, frameCoalesceMs)
      return
    }
    if (msg.t === "event.stale") {
      // Keep frames in arrival order.
      landBufferedFrames()
      const queued = store.query(tables.eventQueue.select().where({ id: msg.id }).first())
      if (!queued) return
      store.commit(events.eventDequeued({ id: msg.id }))
      if (queued.fileId && queued.cellId) {
        markConflict(
          cellRowId(
            projectId,
            queued.fileId,
            queued.cellId,
            "target",
            queuedTargetLaneKey(queued.fileId, queued.cellId, queued.payload),
          ),
        )
      }
    }
  }

  async function getToken(): Promise<string | null> {
    const file = store.query(tables.files.select().where({ projectId }).first())
    if (!file) return null
    const mint = await mintToken(projectId, file.id)
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
        // Flush first: our own writes' server rows land via the flush
        // response, so the catch-up then has fewer protected cells to skip.
        void flushNow()
          .catch(() => undefined)
          .then(() => catchUpNow())
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
    // Nothing is written to the store until the server answers: a queue that
    // sits through weeks of failed attempts must not grow the eventlog with
    // each one. An in-flight row is simply one a running flush holds.
    const pending = (
      store.query(tables.eventQueue.select().where({ projectId, status: "pending" })) as readonly EventQueueRow[]
    ).toSorted(byQueueOrder)
    if (pending.length === 0) return "idle"

    const file = store.query(tables.files.select().where({ projectId }).first())
    if (!file) return "retry"

    // A sync token is scoped to one file; the server refuses events for any
    // other file with 403 "token scoped to different file". So each file's
    // rows go up in their own POSTs under their own token.
    const byFile = new Map<string, EventQueueRow[]>()
    for (const r of pending) {
      const fileId = r.fileId ?? file.id
      const group = byFile.get(fileId)
      if (group) group.push(r)
      else byFile.set(fileId, [r])
    }
    let outcome: FlushOutcome = "ok"
    for (const [fileId, rows] of byFile) {
      // Oldest first, and stop at the first failure: a later edit to a cell
      // chains on an earlier one, so sending it first would only come back stale.
      for (let i = 0; i < rows.length; i += MAX_FLUSH_BATCH) {
        if (isOffline() || closed) return "retry"
        if ((await flushFileRows(fileId, rows.slice(i, i + MAX_FLUSH_BATCH))) === "retry") {
          outcome = "retry"
          break
        }
      }
    }
    return outcome
  }

  async function flushFileRows(fileId: string, pending: readonly EventQueueRow[]): Promise<FlushOutcome> {
    const ids = pending.map((r) => r.id)

    const mint = await mintToken(projectId, fileId)
    if (!mint.token) return "retry"

    const rawEvents = pending.map(toRawEvent)
    let res: Response
    try {
      res = await fetchFn(`${baseUrl}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mint.token}` },
        body: JSON.stringify({ events: rawEvents }),
      })
    } catch {
      return "retry"
    }
    if (!res.ok) return "retry"

    let body: FlushResponseBody
    try {
      body = (await res.json()) as FlushResponseBody
    } catch {
      return "retry"
    }
    // Closed while the POST was out (offline copy removed): landing its rows
    // now would bring cells back. The server has the writes either way.
    if (closed) return "retry"

    const acceptedIds = new Set((body.accepted ?? []).map((a) => a.id))
    // 403 and every other 4xx but 401 (schema, unknown lane, …) won't
    // succeed on a retry.
    const refused = new Map(
      (body.rejected ?? [])
        .filter((r) => r.status >= 400 && r.status < 500 && r.status !== 401)
        .map((r) => [r.id, r] as const),
    )
    const staleById = new Map((body.stale ?? []).map((s) => [s.id, s]))
    const rowById = new Map(pending.map((r) => [r.id, r]))

    // Everything this response resolves lands in ONE commit: one transaction,
    // and a handful of batched events rather than one per write and per row.
    const dequeued: string[] = []
    const failed: string[] = []
    let accepted = 0
    for (const id of ids) {
      // Check stale FIRST: per CLAUDE.md's AD-2 head-CAS contract, a stale
      // sibling is "logged, 200-accepted, and reported in stale[]" — its id
      // lands in BOTH `accepted` and `stale`. Checking `accepted` first would
      // dequeue it silently without ever marking the conflict (caught by the
      // manual smoke test against the real server — the unit tests' fakes
      // had never modeled these two arrays overlapping).
      const stale = staleById.get(id)
      if (stale) {
        dequeued.push(id)
        const row = rowById.get(id)
        if (row?.fileId && row.cellId) {
          markConflict(
            cellRowId(projectId, row.fileId, row.cellId, "target", queuedTargetLaneKey(row.fileId, row.cellId, row.payload)),
          )
        }
        continue
      }
      if (acceptedIds.has(id)) {
        dequeued.push(id)
        accepted += 1
        continue
      }
      const refusal = refused.get(id)
      if (refusal) {
        // Not retryable and not a staleness conflict — leave it visibly
        // stuck ("failed") rather than dequeuing (silent data loss) or
        // retrying forever (head-of-line blocking every future flush).
        console.warn(`[offline] server refused queued write ${id}: ${refusal.status} ${refusal.reason}`)
        failed.push(id)
        continue
      }
      // 401 / 5xx / unacknowledged — transient: still "pending", so the next
      // reconnect or flushNow() sends it again.
    }

    // Land the server's projected rows for our own accepted writes directly,
    // rather than waiting for the WS echo of each event.applied — the flush
    // already has them and the round trip may be slower than this response.
    const frames = Array.isArray(body.applied)
      ? body.applied.map(parseAppliedEventFrame).filter((f): f is AppliedFrame => f !== null)
      : []

    // Live frames still buffered land in the same commit; syncedRowsEvents
    // orders them against the response's frames by serverSeq.
    const buffered = takeBufferedFrames()
    const allDequeued = [...new Set([...buffered.dequeued, ...dequeued])]
    const toCommit = [
      ...(allDequeued.length > 0 ? [events.eventsDequeued({ ids: allDequeued })] : []),
      ...failed.map((id) => events.eventQueueStatusSet({ id, status: "failed" })),
      ...syncedRowsEvents([...buffered.frames, ...frames]),
    ]
    if (toCommit.length > 0) store.commit(...toCommit)
    if (accepted > 0) recordOfflineUpload(projectId)
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
    // Offline, the queue just waits on disk; coming online flushes it.
    if (isOffline()) return
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
      // Dropped offline mid-flush: no backoff earned, the online edge retries.
      if (isOffline()) return
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

  // Serialized like flushes; a request made while one runs coalesces into a
  // single follow-up run, since the in-flight one may have read before the
  // change that prompted the new request.
  let catchUpRunning: Promise<void> | null = null
  let catchUpFollowUp: Promise<void> | null = null

  async function runCatchUp(): Promise<void> {
    if (closed) return
    const token = await getToken()
    if (!token || closed) return
    try {
      await catchUpProject(store, projectId, token, options.catchUpDeps)
    } catch (err) {
      // Best-effort: the next reconnect retries. Reads stay on the local copy.
      console.warn(`[offline] catch-up failed for project ${projectId}`, err)
    }
  }

  function catchUpNow(): Promise<void> {
    if (!catchUpRunning) {
      catchUpRunning = runCatchUp().finally(() => {
        catchUpRunning = null
      })
      return catchUpRunning
    }
    catchUpFollowUp ??= catchUpRunning.then(() => {
      catchUpFollowUp = null
      return catchUpNow()
    })
    return catchUpFollowUp
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

  // A row left at "flushing" belongs to a flush that died with a previous
  // session (reload/quit mid-POST). No flush of ours is in flight yet, so it
  // is safe to retry — POST /events is idempotent on event id. Left as-is it
  // would never be sent (flushes only pick up "pending"), and catch-up would
  // skip its cell forever as a protected local edit.
  const interrupted = store.query(tables.eventQueue.select().where({ projectId, status: "flushing" }))
  if (interrupted.length > 0) {
    store.commit(...interrupted.map((row) => events.eventQueueStatusSet({ id: row.id, status: "pending" })))
  }

  // The network came back: send what queued up while it was gone, from a
  // clean backoff. (The socket's onOpen does the same once it reconnects;
  // flushes are serialized, so the second finds less or nothing to send.)
  const unsubscribeConnectivity = connectivity.subscribe((online) => {
    if (closed || online !== true) return
    flushRetryDelay = minFlushRetryMs
    cancelFlushTimer()
    void flushNow()
  })

  // Anything already queued from a previous session (the app was closed with
  // unsynced work) goes out without waiting for the socket.
  armFlush(flushDebounceMs)

  return {
    isConnected: () => reconciler.isConnected(),
    flushNow,
    catchUpNow,
    close: (): void => {
      closed = true
      // Removed offline copy (or manager teardown): stop warning about it.
      markProjectAvailable(projectId)
      cancelFlushTimer()
      // Dropped, not landed: close() follows removing the offline copy, and
      // landing its rows now would bring cells back.
      if (frameTimer !== null) clearTimeout(frameTimer)
      bufferedFrames = []
      unsubscribeQueue()
      unsubscribeConnectivity()
      reconciler.close()
    },
  }
}
