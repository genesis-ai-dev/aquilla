/**
 * Tauri desktop offline routing (Phase 4): decides which outbox events go to
 * LiveStore's local `event_queue` (src/lib/offline/schema.ts) instead of the
 * IndexedDB → HTTP outbox, and commits them there. outbox.ts calls this only
 * inside the Tauri runtime, so the browser SPA's write path never reaches it.
 *
 * The LiveStore-backed modules (store.ts, offline-reads.ts, schema.ts) are
 * dynamically imported rather than statically: outbox.ts is on every web-build
 * code path, and is-tauri.ts exists separately so modules like it can check
 * the runtime without pulling LiveStore/OPFS/wa-sqlite into the browser
 * bundle. Checking the kinds first (a synchronous Set lookup) also means the
 * common case — kinds that never route offline — never pays for the import or
 * a store round-trip at all.
 */

import { isLeaderStalled, watchLeaderPersisted } from "@/lib/offline/leader-watchdog"
import type { CqrsRawEvent, OutboxEventKind } from "./outbox-types"

/**
 * The three event kinds that make sense to keep working entirely offline.
 * Everything else (cell create/delete/reorder, comments, terminology, …)
 * always goes through the normal IndexedDB → HTTP outbox path, even offline in
 * Tauri — the UI is expected to disable those controls when offline; this
 * module isn't responsible for blocking them.
 */
const OFFLINE_ROUTABLE_KINDS: ReadonlySet<OutboxEventKind> = new Set<OutboxEventKind>([
  "target.cell.commit",
  "cell.validate",
  "cell.unvalidate",
])

let warnedOfflineStoreUnavailable = false
let warnedOfflineStoreShutDown = false
// A booted store answers at once; past this, the edit goes to IndexedDB.
const OFFLINE_STORE_WAIT_MS = 3_000

/**
 * Ids copied from LiveStore's queue into IndexedDB after the leader stalled
 * (see `rescueUnpersistedOfflineWrites` in outbox.ts). They stay in the
 * page's in-memory queue, which a dead leader never flushes, so the HTTP
 * flusher must not hold their dependents back waiting on them there.
 */
const rescuedIds = new Set<string>()

export function markRescuedFromOfflineQueue(ids: readonly string[]): void {
  for (const id of ids) rescuedIds.add(id)
}

/** Test-only reset. */
export function forgetRescuedIdsForTests(): void {
  rescuedIds.clear()
}

// Rows per v1.EventsQueued. One commit for a whole replace-all would put every
// edit's payload in one eventlog row, re-parsed whole on every rebuild.
const OFFLINE_QUEUE_CHUNK = 500

/** The booted offline store and its events, or null when writes must go to IndexedDB. */
async function openOfflineQueue() {
  const [
    { getOfflineStore },
    { isProjectOfflineReady },
    { events: offlineEvents, tables: offlineTables },
    { commitOrThrow, isOfflineStoreShutDown },
  ] = await Promise.all([
    import("@/lib/offline/store"),
    import("@/lib/offline/offline-reads"),
    import("@/lib/offline/schema"),
    import("@/lib/offline/checked-commit"),
  ])
  // Unopenable store (e.g. newer build owns it): queue in IndexedDB. Boot failure is memoized, so warn once.
  // A store still booting (minutes while the leader rebuilds after a schema
  // change, forever if it died) gets the same treatment — an edit must not
  // sit unwritten waiting on it.
  let timer: ReturnType<typeof setTimeout> | undefined
  const bootTimedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), OFFLINE_STORE_WAIT_MS)
  })
  const store = await Promise.race([
    getOfflineStore().catch((error: unknown) => {
      if (!warnedOfflineStoreUnavailable) {
        warnedOfflineStoreUnavailable = true
        console.warn("[outbox] offline store unavailable — queueing in IndexedDB", error)
      }
      return null
    }),
    bootTimedOut,
  ]).finally(() => clearTimeout(timer))
  if (!store) return null
  // getOfflineStore memoizes the store, so one that shut down (a failed
  // commit does that) keeps being handed out, and every query on it throws.
  // Queue in IndexedDB until a restart boots a new one.
  if (isOfflineStoreShutDown(store)) {
    if (!warnedOfflineStoreShutDown) {
      warnedOfflineStoreShutDown = true
      console.warn("[outbox] offline store has shut down — queueing in IndexedDB until restart")
    }
    return null
  }
  const liveStore = store
  return {
    offlineEvents,
    isReady: (projectId: string) => isProjectOfflineReady(liveStore, projectId),
    /** Ids queued offline and not yet sent (a `failed` row isn't going anywhere). */
    waitingIds: (): ReadonlySet<string> => new Set([
      ...liveStore.query(offlineTables.eventQueue.select("id").where({ status: "pending" })),
      ...liveStore.query(offlineTables.eventQueue.select("id").where({ status: "flushing" })),
    ].filter((id) => !rescuedIds.has(id))),
    commit: (run: (booted: typeof liveStore) => void): WhenPersisted => {
      commitOrThrow(liveStore, () => run(liveStore))
      // The commit is the newest pending event, so the leader has persisted
      // it once its confirmed head reaches the session's head.
      const head = liveStore.syncStatus().localHead
      return (onPersisted) => watchLeaderPersisted(liveStore, head, onPersisted)
    },
  }
}

function toQueuedRow(event: CqrsRawEvent) {
  return {
    id: event.id,
    projectId: event.projectId,
    fileId: event.fileId ?? null,
    cellId: event.cellId ?? null,
    kind: event.kind,
    payload: event.payload,
    parentId: event.parentId ?? null,
    author: event.author,
    schemaVersion: event.schemaVersion,
    clientTs: new Date(event.clientTs),
    createdAt: new Date(),
  }
}

/** Calls back once the leader has written a commit to disk; returns a stop function. */
export type WhenPersisted = (onPersisted: () => void) => () => void

const nothingToPersist: WhenPersisted = (onPersisted) => {
  onPersisted()
  return () => {}
}

/** Where `planOfflineRouting` sends a batch. */
export interface OfflineRouting {
  /** The events for IndexedDB, in order. */
  rest: CqrsRawEvent[]
  /** The events `commit` queues offline, in order. */
  routed: CqrsRawEvent[]
  /** Commits the others to LiveStore's queue, or throws having queued none of
   *  them (the store shut down before or during the commit). Synchronous, so
   *  a caller can clear their journal entries with nothing able to land in
   *  between. A commit that returns is applied in memory only; the leader
   *  persists it to disk shortly after — the returned `WhenPersisted` says
   *  when, and never calls back if the leader has died. */
  commit: () => WhenPersisted
}

/** Which of `ids` are in the IndexedDB outbox, in any status. */
export type OutboxLookup = (ids: readonly string[]) => Promise<ReadonlySet<string>>

/** The events `event` chains on, validates or is guarded by, by id. */
export function dependencyIds(event: Pick<CqrsRawEvent, "parentId" | "payload">): string[] {
  const ids: string[] = []
  if (event.parentId) ids.push(event.parentId)
  const payload = event.payload as { editEventId?: unknown; expectedTargetEventId?: unknown } | null
  if (typeof payload?.editEventId === "string") ids.push(payload.editEventId)
  // A repin is refused unless this is still the cell's target head.
  if (typeof payload?.expectedTargetEventId === "string") ids.push(payload.expectedTargetEventId)
  return ids
}

/**
 * Ids still waiting in LiveStore's offline queue, or null when the store
 * can't say (not booted within the wait, unopenable, shut down). The HTTP
 * flusher holds back anything that depends on one of them: the two queues
 * flush independently, so a record that landed in IndexedDB while its parent
 * sits in the offline queue — a crash-recovered edit whose routing timed out,
 * a repin guarded by a commit queued offline — would otherwise reach the
 * server first and be refused or logged stale.
 */
export async function offlineQueueWaitingIds(): Promise<ReadonlySet<string> | null> {
  const queue = await openOfflineQueue()
  if (!queue) return null
  try {
    return queue.waitingIds()
  } catch (error) {
    console.warn("[outbox] offline store couldn't list its queue — not holding anything back for it", error)
    return null
  }
}

/** Labels each event with its dependency group: events linked, either way, by
 *  `dependencyIds` within the batch share a label. */
function dependencyGroups(events: readonly CqrsRawEvent[]): string[] {
  const parent = new Map<string, string>()
  for (const event of events) parent.set(event.id, event.id)
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)!
    while (id !== root) {
      const next = parent.get(id)!
      parent.set(id, root)
      id = next
    }
    return root
  }
  for (const event of events) {
    for (const dep of dependencyIds(event)) {
      if (parent.has(dep)) parent.set(find(event.id), find(dep))
    }
  }
  return events.map((event) => find(event.id))
}

/**
 * Picks every event that is one of the offline-routable kinds AND whose
 * project has a ready local LiveStore copy for LiveStore's `event_queue`
 * (Phase 3's sync adapter owns flushing those to the server), and returns the
 * rest, in order — the caller must write only those to IndexedDB, and should
 * do so before `commit()`, so a failed IndexedDB write leaves nothing queued.
 * All routed events go in one `store.commit`: one commit per event re-ran
 * every query on the queue each time, so a 200-edit batch took seconds,
 * longer the more was already queued.
 *
 * Events linked by a chain or a validate, in either direction, go to the
 * same queue: the two flush independently, so splitting them could send a
 * commit before the create it chains on (AQU-890), or a delete before the
 * commit it chains on, and the server would log it stale. A group goes to
 * LiveStore only if every event in it can, and only if nothing it depends on
 * outside the batch is still waiting in the IndexedDB outbox (`inOutbox`) —
 * an earlier edit can have gone there while the store was still booting.
 */
export async function planOfflineRouting(
  events: CqrsRawEvent[],
  inOutbox: OutboxLookup,
): Promise<OfflineRouting> {
  const none: OfflineRouting = { rest: events, routed: [], commit: () => nothingToPersist }
  if (!events.some((event) => OFFLINE_ROUTABLE_KINDS.has(event.kind))) return none
  // A stalled leader persists nothing: a commit would live only in this
  // page's memory. IndexedDB until it recovers (OfflineLeaderWatchdog).
  if (isLeaderStalled()) return none
  const queue = await openOfflineQueue()
  if (!queue) return none
  const readiness = new Map<string, boolean>()
  const isReady = (projectId: string) => {
    let ready = readiness.get(projectId)
    if (ready === undefined) {
      ready = queue.isReady(projectId)
      readiness.set(projectId, ready)
    }
    return ready
  }
  const groups = dependencyGroups(events)
  const blocked = new Set<string>()
  try {
    events.forEach((event, i) => {
      if (!OFFLINE_ROUTABLE_KINDS.has(event.kind) || !isReady(event.projectId)) blocked.add(groups[i])
    })
  } catch (error) {
    // A store that can't answer can't take the writes either.
    console.warn("[outbox] offline store couldn't check project readiness — queueing in IndexedDB", error)
    return none
  }
  // Dependencies outside the batch, of the groups still headed offline.
  const batchIds = new Set(events.map((event) => event.id))
  const external = new Map<string, string[]>()
  events.forEach((event, i) => {
    if (blocked.has(groups[i])) return
    for (const dep of dependencyIds(event)) {
      if (batchIds.has(dep)) continue
      const waiting = external.get(dep)
      if (waiting) waiting.push(groups[i])
      else external.set(dep, [groups[i]])
    }
  })
  if (external.size > 0) {
    try {
      const queued = await inOutbox([...external.keys()])
      for (const [dep, dependents] of external) {
        if (queued.has(dep)) for (const group of dependents) blocked.add(group)
      }
    } catch (error) {
      // An outbox nobody can read isn't flushing a parent ahead of us either.
      console.warn("[outbox] couldn't check the IndexedDB outbox for an edit's parent", error)
    }
  }
  const routed: CqrsRawEvent[] = []
  const rest: CqrsRawEvent[] = []
  events.forEach((event, i) => (blocked.has(groups[i]) ? rest : routed).push(event))
  const commit = (): WhenPersisted => {
    if (routed.length === 0) return nothingToPersist
    return queue.commit((store) => {
      const batches = []
      for (let i = 0; i < routed.length; i += OFFLINE_QUEUE_CHUNK) {
        batches.push(queue.offlineEvents.eventsQueued({ rows: routed.slice(i, i + OFFLINE_QUEUE_CHUNK).map(toQueuedRow) }))
      }
      store.commit(...batches)
    })
  }
  return { rest, routed, commit }
}
