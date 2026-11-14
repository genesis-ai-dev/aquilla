// Which eventlog events a state-db rebuild can skip.
//
// LiveStore never compacts the eventlog, so a rebuild (after an offline
// schema change, or when the state db and eventlog disagree) replays every
// event ever committed — including every earlier download of a project the
// user has since removed and downloaded again. On a real 34k-cell project
// that was 60,958 events, of which 338 still need replaying.
//
// v1.OfflineCopyRemoved deletes every row of its project from cells, files,
// projects, sync_cursors and offline_projects, so an earlier event whose only
// effect is on rows keyed by that project can't change the rebuilt state.
// Our @livestore/common patch asks `globalThis.__livestoreRehydrateSkip` for
// a predicate before replaying; the leader worker installs this one.
//
// The outbox works the same way per row: once v1.EventDequeued or
// v1.EventsDequeued has deleted queue row X, every earlier event about X (its
// v1.EventQueued, status changes, and a single-row dequeue) nets out to
// nothing. Batch dequeues are always replayed — deleting rows that were never
// inserted is a no-op — so they never have to be split. A batch enqueue
// (v1.EventsQueued) is skipped only when every row in it has been dequeued
// since; otherwise it's replayed, and so is every queue event about its rows —
// skipping a row's single-row dequeue then would bring the row back.
//
// Deliberately kept, whatever comes after them: file events. Files are keyed
// by the server's file id, and an upsert can move a row between projects, so
// a removal's effect on them depends on history. There are only a handful.
//
// Only removals and dequeues at or below the confirmed sync head count.
// LiveStore only rolls back events above it, so a skipped event never needs
// its changeset.
//
// The eventlog's last event is never skipped. The leader takes the state db's
// head from its newest changeset row, and our @livestore/common patch rebuilds
// whenever that differs from the eventlog's head, so a skipped last event
// would mean a rebuild on every boot. (Every skippable event is clientOnly, so
// today a later synced checkpoint always follows a confirmed one — this keeps
// it safe if that changes.)
//
// A skipped event is never decoded, so it also skips LiveStore's check that
// every eventlog entry still matches the current schema ("the schema has
// changed in an incompatible way"). That's what lets an old, superseded event
// stop mattering — but it means `pnpm offline:replay-check` can't catch an
// incompatible schema change for events like it, only for ones still replayed.

/** The field holding the project id, for every event a later removal makes irrelevant. */
const PROJECT_FIELD: Record<string, "id" | "projectId"> = {
  "v1.ProjectSynced": "id",
  "v1.ProjectSnapshotSynced": "id",
  "v1.ProjectSettingsSnapshotSynced": "id",
  "v1.ProjectRemoved": "id",
  "v2.CellSynced": "projectId",
  "v2.CellRemoved": "projectId",
  "v2.CellsSynced": "projectId",
  "v2.CellsRemoved": "projectId",
  "v1.CellSynced": "projectId",
  "v1.CellRemoved": "projectId",
  "v1.CellsSynced": "projectId",
  "v1.CellsRemoved": "projectId",
  "v1.SyncCursorSet": "projectId",
  "v1.SyncCursorsRemoved": "projectId",
  "v1.OfflineProjectStatusSet": "projectId",
  "v1.OfflineProjectRemoved": "projectId",
  "v1.OfflineCopyRemoved": "projectId",
}

const WIPE_EVENT = "v1.OfflineCopyRemoved"

/** Queue events about one row, by its id: all skippable up to that row's last confirmed dequeue. */
const QUEUE_ROW_EVENTS = new Set(["v1.EventQueued", "v1.EventQueueStatusSet", "v1.EventDequeued"])

/** Queues many rows at once; see the header for when it can be skipped. */
const BATCH_QUEUE_EVENT = "v1.EventsQueued"

/**
 * Selects each v1.EventsQueued's seq and its rows' ids as a JSON array (NULL
 * when `rows` isn't an array). SQLite extracts the ids, so the payloads — up to
 * 500 edits per batch — are never decoded in JS just to read them.
 */
const batchIdsQuery = (eventlogTable: string) => `SELECT seqNumGlobal, seqNumClient,
  CASE WHEN json_type(argsJson, '$.rows') = 'array'
    THEN (SELECT json_group_array(json_extract(value, '$.id')) FROM json_each(argsJson, '$.rows'))
  END AS ids
  FROM ${eventlogTable} WHERE name = '${BATCH_QUEUE_EVENT}'`

/** The queue row ids from `batchIdsQuery`'s `ids` column, or undefined if they can't be read. */
const batchRowIds = (idsJson: unknown): string[] | undefined => {
  if (typeof idsJson !== "string") return undefined
  const ids = JSON.parse(idsJson) as unknown
  if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string")) return undefined
  return ids
}

export interface ReplayRow {
  name: string
  argsJson: string
  seqNumGlobal: number
  seqNumClient: number
}

export interface ReplayEventlog {
  select: (query: string) => Record<string, unknown>[]
  eventlogTable: string
  syncStatusTable: string
}

interface Seq {
  global: number
  client: number
}

const compare = (a: Seq, b: Seq): number => a.global - b.global || a.client - b.client

const argsOf = (row: { argsJson: string }): Record<string, unknown> => JSON.parse(row.argsJson) as Record<string, unknown>

const stringField = (args: Record<string, unknown>, field: string): string | undefined => {
  const value = args[field]
  return typeof value === "string" ? value : undefined
}

const seqKey = (seq: Seq): string => `${seq.global}.${seq.client}`

const seqOf = (row: Record<string, unknown>): Seq => ({ global: Number(row.seqNumGlobal), client: Number(row.seqNumClient) })

/** Records `seq` for `key` if it's confirmed and later than what's there. */
const keepLatest = (map: Map<string, Seq>, key: string | undefined, seq: Seq, confirmed: Seq) => {
  if (key === undefined || compare(seq, confirmed) > 0) return
  const known = map.get(key)
  if (known === undefined || compare(seq, known) > 0) map.set(key, seq)
}

/** Returns a predicate for rows to skip, or undefined to replay everything. Never throws. */
export function planReplaySkip(eventlog: ReplayEventlog): ((row: ReplayRow) => boolean) | undefined {
  try {
    const head = eventlog.select(`SELECT head FROM ${eventlog.syncStatusTable}`)[0]?.head
    if (typeof head !== "number") {
      // Replaying everything is always correct, just slow; say so in case it's a type surprise.
      if (head !== undefined) console.warn("[offline] Replaying the whole eventlog: unexpected sync head", { head })
      return undefined
    }
    const confirmed: Seq = { global: head, client: 0 }
    const lastRow = eventlog.select(
      `SELECT seqNumGlobal, seqNumClient FROM ${eventlog.eventlogTable} ORDER BY seqNumGlobal DESC, seqNumClient DESC LIMIT 1`,
    )[0]
    if (lastRow === undefined) return undefined
    const last = seqOf(lastRow)

    const lastWipe = new Map<string, Seq>()
    const wipes = eventlog.select(
      `SELECT seqNumGlobal, seqNumClient, argsJson FROM ${eventlog.eventlogTable} WHERE name = '${WIPE_EVENT}'`,
    )
    for (const wipe of wipes) {
      keepLatest(lastWipe, stringField(argsOf({ argsJson: String(wipe.argsJson) }), "projectId"), seqOf(wipe), confirmed)
    }

    const lastDequeue = new Map<string, Seq>()
    const dequeues = eventlog.select(
      `SELECT seqNumGlobal, seqNumClient, name, argsJson FROM ${eventlog.eventlogTable} WHERE name IN ('v1.EventDequeued', 'v1.EventsDequeued')`,
    )
    for (const dequeue of dequeues) {
      const args = argsOf({ argsJson: String(dequeue.argsJson) })
      const ids = dequeue.name === "v1.EventsDequeued" ? args.ids : [args.id]
      if (!Array.isArray(ids)) continue
      for (const id of ids) keepLatest(lastDequeue, typeof id === "string" ? id : undefined, seqOf(dequeue), confirmed)
    }

    const all = [...lastWipe.values(), ...lastDequeue.values()]
    if (all.length === 0) return undefined
    const latest = all.reduce((a, b) => (compare(a, b) >= 0 ? a : b))

    // Batch enqueues: skippable ones by seq, and the rows of the rest.
    const skippableBatches = new Set<string>()
    const replayedRows = new Set<string>()
    // A batch whose row ids can't be read: replay every queue event.
    let unreadableBatch = false
    const batches = eventlog.select(batchIdsQuery(eventlog.eventlogTable))
    for (const batch of batches) {
      const seq = seqOf(batch)
      const ids = batchRowIds(batch.ids)
      if (ids === undefined) {
        unreadableBatch = true
        continue
      }
      const allDequeued = ids.every((id) => {
        const dequeued = lastDequeue.get(id)
        return dequeued !== undefined && compare(seq, dequeued) < 0
      })
      if (allDequeued && compare(seq, last) !== 0) skippableBatches.add(seqKey(seq))
      else for (const id of ids) replayedRows.add(id)
    }
    if (unreadableBatch) {
      console.warn("[offline] Replaying every queue event: a batch enqueue's row ids couldn't be read")
    }

    return (row) => {
      try {
        const seq = { global: row.seqNumGlobal, client: row.seqNumClient }
        if (row.name === BATCH_QUEUE_EVENT) return skippableBatches.has(seqKey(seq))
        const field = PROJECT_FIELD[row.name]
        const queueRow = QUEUE_ROW_EVENTS.has(row.name)
        if (field === undefined && !queueRow) return false
        // Most of a log after the last removal: no need to parse anything.
        if (compare(seq, latest) > 0 || compare(seq, last) === 0) return false
        const args = argsOf(row)
        if (queueRow) {
          const id = stringField(args, "id")
          if (id === undefined || unreadableBatch || replayedRows.has(id)) return false
          const dequeued = lastDequeue.get(id)
          return dequeued !== undefined && compare(seq, dequeued) <= 0
        }
        const projectId = field === undefined ? undefined : stringField(args, field)
        const wipe = projectId === undefined ? undefined : lastWipe.get(projectId)
        return wipe !== undefined && compare(seq, wipe) < 0
      } catch {
        return false
      }
    }
  } catch (error) {
    console.warn("[offline] Replaying the whole eventlog: couldn't plan which events to skip", error)
    return undefined
  }
}

type SkipHook = (eventlog: ReplayEventlog) => ((row: ReplayRow) => boolean) | undefined

/** Leader-worker side: install the hook the @livestore/common patch calls. */
export function installReplaySkip(): void {
  ;(globalThis as { __livestoreRehydrateSkip?: SkipHook }).__livestoreRehydrateSkip = planReplaySkip
}
