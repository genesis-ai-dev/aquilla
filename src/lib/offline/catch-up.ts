/**
 * Catch-up pull for a downloaded offline project: brings the local LiveStore
 * copy level with the server after anything that could have made it miss
 * live `event.applied` frames — the app being closed or offline, a dead
 * WebSocket, or a leader that stopped persisting. Live frames alone
 * (sync-adapter.ts) are best-effort; without this, a missed frame left the
 * cell stale forever, and every later local edit chained onto a stale parent
 * and came back as a "changed elsewhere" conflict.
 *
 * Per file: a `?since=` delta when a trusted cursor exists (sync_cursors),
 * else a full stream. The cursor rules mirror useCells.ts (M2-1 / AQU-943):
 *  - a cursor is trusted only with BOTH a watermark and a project epoch;
 *  - a torn full stream (watermark moved between pages) mints no cursor;
 *  - if any server row was skipped to protect a queued local edit, the
 *    cursor holds instead of advancing past it.
 *
 * Cells with a queued local write (event_queue) are never overwritten here —
 * their server rows land through the flush response once the write is sent.
 * Only rows that differ from the local copy are committed, so a repeat
 * catch-up against an up-to-date copy writes nothing.
 */
import type { Store } from "@livestore/livestore"
import type { CellRow } from "@/lib/sync/cells-read-types"
import {
  fetchCellsDelta as fetchCellsDeltaDefault,
  fetchProjectFiles as fetchProjectFilesDefault,
  streamFileCells as streamFileCellsDefault,
} from "@/lib/sync/cells-read"
import { cellRowId, events, syncCursorId, tables, type schema } from "./schema"

type OfflineStore = Store<typeof schema>
type CellSyncedArgs = Parameters<typeof events.cellSynced>[0]
type LocalCell = typeof tables.cells.Type
type Side = "source" | "target"

const SIDES: readonly Side[] = ["source", "target"]
const COMMIT_CHUNK = 500

/**
 * The local `cells` table is keyed by side only, with no target-language
 * lane, so it holds the default lane ('') and nothing else — otherwise a
 * second language's row would overwrite the default translation. Shared by
 * every path that lands server rows (download, live frames, catch-up) so they
 * can never disagree about which row wins.
 */
export function isLocalLaneRow(row: Pick<CellRow, "targetLang">): boolean {
  return (row.targetLang ?? "") === ""
}

export function toCellSyncedArgs(projectId: string, fileId: string, row: CellRow): CellSyncedArgs {
  return {
    projectId,
    fileId,
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
  }
}

function sameAsLocal(local: LocalCell, args: CellSyncedArgs): boolean {
  return (
    local.value === args.value &&
    local.valueHtml === args.valueHtml &&
    local.eventId === args.eventId &&
    local.sourceEventId === args.sourceEventId &&
    local.validated === args.validated &&
    local.aiDrafted === args.aiDrafted &&
    local.sequenceIndex === args.sequenceIndex &&
    local.canonicalRef === args.canonicalRef
  )
}

export interface CatchUpDeps {
  fetchProjectFiles: typeof fetchProjectFilesDefault
  fetchCellsDelta: typeof fetchCellsDeltaDefault
  streamFileCells: typeof streamFileCellsDefault
}

const defaultDeps: CatchUpDeps = {
  fetchProjectFiles: fetchProjectFilesDefault,
  fetchCellsDelta: fetchCellsDeltaDefault,
  streamFileCells: streamFileCellsDefault,
}

export interface CatchUpResult {
  filesChecked: number
  /** Local cell rows written or removed. */
  rowsChanged: number
}

type SyncedRow = Omit<CellSyncedArgs, "projectId" | "fileId">
type RemovedCell = { cellId: string; side: Side }

/**
 * Lands rows as batched events — one per COMMIT_CHUNK rows, not one per row —
 * so a bulk write leaves the leader a short backlog (see schema.ts).
 */
function commitBatched(
  store: OfflineStore,
  projectId: string,
  fileId: string,
  upserts: readonly SyncedRow[],
  removals: readonly RemovedCell[],
): void {
  for (let i = 0; i < upserts.length; i += COMMIT_CHUNK) {
    store.commit(events.cellsSynced({ projectId, fileId, rows: upserts.slice(i, i + COMMIT_CHUNK) }))
  }
  for (let i = 0; i < removals.length; i += COMMIT_CHUNK) {
    store.commit(events.cellsRemoved({ projectId, fileId, cells: removals.slice(i, i + COMMIT_CHUNK) }))
  }
}

/**
 * Replaces each listed cell's local rows with the server's: upserts the
 * default-lane rows that differ, and removes local sides the server no longer
 * has (a cell listed with no server rows at all was deleted). Cells with a
 * queued local write are skipped. Returns how many rows changed and whether
 * anything was skipped.
 */
function replaceCells(
  store: OfflineStore,
  projectId: string,
  fileId: string,
  cellIds: Iterable<string>,
  serverRows: readonly CellRow[],
): { rowsChanged: number; skipped: boolean } {
  const queued = new Set(
    store
      .query(tables.eventQueue.select().where({ projectId, fileId }))
      .map((r) => r.cellId)
      .filter((id): id is string => id !== null),
  )
  const local = new Map(store.query(tables.cells.select().where({ projectId, fileId })).map((r) => [r.id, r]))
  const byCell = new Map<string, CellRow[]>()
  for (const row of serverRows) {
    if (!isLocalLaneRow(row)) continue
    const group = byCell.get(row.cellId)
    if (group) group.push(row)
    else byCell.set(row.cellId, [row])
  }

  const upserts: SyncedRow[] = []
  const removals: RemovedCell[] = []
  let skipped = false
  for (const cellId of cellIds) {
    if (queued.has(cellId)) {
      skipped = true
      continue
    }
    const rows = byCell.get(cellId) ?? []
    for (const row of rows) {
      const { projectId: _p, fileId: _f, ...args } = toCellSyncedArgs(projectId, fileId, row)
      const existing = local.get(cellRowId(projectId, fileId, cellId, row.side))
      if (!existing || !sameAsLocal(existing, { projectId, fileId, ...args })) upserts.push(args)
    }
    for (const side of SIDES) {
      if (rows.some((r) => r.side === side)) continue
      if (local.has(cellRowId(projectId, fileId, cellId, side))) {
        removals.push({ cellId, side })
      }
    }
  }
  commitBatched(store, projectId, fileId, upserts, removals)
  return { rowsChanged: upserts.length + removals.length, skipped }
}

function readCursor(store: OfflineStore, projectId: string, fileId: string) {
  return store.query(tables.syncCursors.select().where({ id: syncCursorId(projectId, fileId) }).first())
}

function setCursor(
  store: OfflineStore,
  projectId: string,
  fileId: string,
  serverSeq: number | null,
  projectEpoch: number | null,
): void {
  const current = readCursor(store, projectId, fileId)
  if (current && current.serverSeq === serverSeq && current.projectEpoch === projectEpoch) return
  store.commit(events.syncCursorSet({ projectId, fileId, serverSeq, projectEpoch }))
}

/**
 * Full stream of one file, replacing the local copy. Also the path that mints
 * a file's first cursor — used by the initial download too.
 */
export async function fullSyncFile(
  store: OfflineStore,
  projectId: string,
  fileId: string,
  token: string,
  deps: Pick<CatchUpDeps, "streamFileCells"> = defaultDeps,
  onRows?: (count: number) => void,
): Promise<number> {
  const serverRows: CellRow[] = []
  let firstSeq: number | null = null
  let firstEpoch: number | null = null
  let metaSeen = false
  let torn = false
  await deps.streamFileCells(
    projectId,
    fileId,
    token,
    (rows) => {
      for (const row of rows) serverRows.push(row)
      if (rows.length > 0) onRows?.(rows.length)
    },
    undefined,
    (meta) => {
      const seq = typeof meta.maxServerSeq === "number" ? meta.maxServerSeq : null
      if (!metaSeen) {
        metaSeen = true
        firstSeq = seq
        firstEpoch = typeof meta.projectEpoch === "number" ? meta.projectEpoch : null
      } else if (seq !== firstSeq) {
        torn = true
      }
    },
    undefined,
    true,
  )

  // A torn stream may have skipped rows that shifted across a page boundary,
  // so absence from it proves nothing: upsert what arrived, remove nothing.
  const cellIds = new Set(serverRows.map((r) => r.cellId))
  if (!torn) {
    for (const row of store.query(tables.cells.select().where({ projectId, fileId }))) cellIds.add(row.cellId)
  }
  const { rowsChanged, skipped } = replaceCells(store, projectId, fileId, cellIds, serverRows)

  const trusted = !torn && !skipped && firstSeq !== null && firstEpoch !== null
  setCursor(store, projectId, fileId, trusted ? firstSeq : null, trusted ? firstEpoch : null)
  return rowsChanged
}

async function catchUpFile(
  store: OfflineStore,
  projectId: string,
  fileId: string,
  token: string,
  deps: CatchUpDeps,
): Promise<number> {
  const cursor = readCursor(store, projectId, fileId)
  const since = cursor?.serverSeq ?? null
  const epoch = cursor?.projectEpoch ?? null
  if (since === null || epoch === null) return fullSyncFile(store, projectId, fileId, token, deps)

  const result = await deps.fetchCellsDelta(projectId, fileId, since, token, undefined, epoch)
  if (result.kind === "resync") return fullSyncFile(store, projectId, fileId, token, deps)

  const { rowsChanged, skipped } = replaceCells(store, projectId, fileId, result.changedCellIds, result.cells)
  // Hold the cursor if a protected cell's rows were skipped: advancing past
  // them would drop that peer commit from every future delta.
  const nextSeq = skipped ? since : result.maxServerSeq
  setCursor(store, projectId, fileId, nextSeq, result.projectEpoch ?? epoch)
  return rowsChanged
}

/**
 * Brings every file of `projectId` level with the server. `token` is a
 * sync-worker token for the project (a file-scoped token authorizes every
 * file's read). Adds files created since download; files deleted on the
 * server are left in place for now.
 */
export async function catchUpProject(
  store: OfflineStore,
  projectId: string,
  token: string,
  deps: CatchUpDeps = defaultDeps,
): Promise<CatchUpResult> {
  const files = await deps.fetchProjectFiles(projectId, token)
  const localFiles = new Set(store.query(tables.files.select().where({ projectId })).map((f) => f.id))
  for (const [index, file] of files.entries()) {
    if (localFiles.has(file.fileId)) continue
    store.commit(
      events.fileSynced({ id: file.fileId, projectId, name: file.name, type: file.fileType, sequenceIndex: index }),
    )
  }

  let rowsChanged = 0
  for (const file of files) {
    rowsChanged += await catchUpFile(store, projectId, file.fileId, token, deps)
  }

  const row = store.query(tables.offlineProjects.select().where({ projectId }).first())
  if (row?.status === "ready") {
    store.commit(
      events.offlineProjectStatusSet({ projectId, status: "ready", syncedAt: new Date(), queueDepth: row.queueDepth }),
    )
  }
  return { filesChecked: files.length, rowsChanged }
}
