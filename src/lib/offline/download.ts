/**
 * Project Download UI (Phase 5): pulls a project's full cell snapshot (every
 * file, both sides, in anchor-chain order) from auth-worker/sync-worker HTTP
 * into the local LiveStore offline store, and tears a downloaded copy back
 * down again. This is the ONLY code that ever writes an `offline_projects`
 * row with `status: "ready"` — until this module runs, `sync-manager.ts`
 * (Phase 3) has nothing to react to and stays inert.
 *
 * Field mapping for `cells`/`files` mirrors `sync-adapter.ts`'s `applyRows` —
 * this is the same server data, just fetched by a one-shot HTTP crawl instead
 * of a WS `event.applied` frame.
 */
import { useEffect, useState, useSyncExternalStore } from "react"
import type { Store } from "@livestore/livestore"
import { events, tables, type schema } from "./schema"
import {
  fetchProjectFiles as fetchProjectFilesDefault,
  streamFileCells as streamFileCellsDefault,
} from "@/lib/sync/cells-read"
import { resolveCloudProjectResult as resolveCloudProjectResultDefault } from "@/lib/sync/cloud-projects"
import { fetchSyncToken as fetchSyncTokenDefault } from "@/lib/sync/sync-token"

// sync-worker's file-list/cells routes verify a short-lived sync-token (see
// cells-read.ts's header comment), never the raw session JWT — confirmed by
// a real 401 from a live sync-worker during Phase 5 manual verification.
// `verifyTokenForProject` (sync-worker/src/auth.ts) checks only the token's
// projectId claim, not fileId, so one token scoped to this constant, unused
// fileId authorizes every file's read for the whole download — no real file
// needs to exist yet, which matters for a project with zero files.
const OFFLINE_DOWNLOAD_TOKEN_FILE_ID = "__offline_download__"

export interface DownloadProgress {
  projectId: string
  filesTotal: number
  filesDone: number
  cellsDone: number
}

// Module-level reactive state, same pattern as conflicts.ts: a fresh Map on
// every mutation (never mutated in place) so useSyncExternalStore's
// Object.is snapshot comparison actually detects the change.
let progressByProject: ReadonlyMap<string, DownloadProgress> = new Map()
type Listener = () => void
const listeners = new Set<Listener>()

function notify(): void {
  for (const cb of listeners) cb()
}

function setProgress(projectId: string, progress: DownloadProgress | null): void {
  const next = new Map(progressByProject)
  if (progress) next.set(projectId, progress)
  else next.delete(projectId)
  progressByProject = next
  notify()
}

export function getDownloadProgress(projectId: string): DownloadProgress | null {
  return progressByProject.get(projectId) ?? null
}

export function subscribeDownloadProgress(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** React binding — null when `projectId` has no download in flight. */
export function useDownloadProgress(projectId: string): DownloadProgress | null {
  return useSyncExternalStore(
    subscribeDownloadProgress,
    () => getDownloadProgress(projectId),
    () => null,
  )
}

/** Test-only reset. */
export function __resetDownloadProgressForTests(): void {
  progressByProject = new Map()
  listeners.clear()
}

export interface DownloadProjectDeps {
  resolveCloudProjectResult: typeof resolveCloudProjectResultDefault
  fetchSyncToken: typeof fetchSyncTokenDefault
  fetchProjectFiles: typeof fetchProjectFilesDefault
  streamFileCells: typeof streamFileCellsDefault
}

const defaultDeps: DownloadProjectDeps = {
  resolveCloudProjectResult: resolveCloudProjectResultDefault,
  fetchSyncToken: fetchSyncTokenDefault,
  fetchProjectFiles: fetchProjectFilesDefault,
  streamFileCells: streamFileCellsDefault,
}

/** Deletes every locally held row for a project (cells, files, the project
 *  row itself, and the offline_projects row) — used both for an explicit
 *  "Remove offline copy" and to roll back a failed/aborted download rather
 *  than leave a partial copy masquerading as complete. */
function deleteProjectRows(store: Store<typeof schema>, projectId: string): void {
  for (const row of store.query(tables.cells.select().where({ projectId }))) {
    store.commit(events.cellRemoved({ projectId, fileId: row.fileId, cellId: row.cellId, side: row.side }))
  }
  for (const row of store.query(tables.files.select().where({ projectId }))) {
    store.commit(events.fileRemoved({ id: row.id }))
  }
  store.commit(events.projectRemoved({ id: projectId }))
  store.commit(events.offlineProjectRemoved({ projectId }))
}

/**
 * Downloads `projectId` into the local LiveStore offline store: project row,
 * every file, and every cell (both sides) in anchor-chain order. Idempotent —
 * a no-op if the project is already `downloading` or `ready`. Throws (after
 * rolling back any partial rows) on failure, so the caller can surface the
 * error; the offline_projects row never lingers at `downloading` past the
 * call.
 */
export async function downloadProjectOffline(
  store: Store<typeof schema>,
  projectId: string,
  jwt: string,
  deps: DownloadProjectDeps = defaultDeps,
): Promise<void> {
  const existing = store.query(tables.offlineProjects.select().where({ projectId }).first())
  if (existing && existing.status !== "removing") return

  store.commit(
    events.offlineProjectStatusSet({ projectId, status: "downloading", syncedAt: null, queueDepth: 0 }),
  )
  setProgress(projectId, { projectId, filesTotal: 0, filesDone: 0, cellsDone: 0 })

  try {
    const projectResult = await deps.resolveCloudProjectResult(projectId, jwt)
    if (!projectResult.ok) {
      throw new Error(`downloadProjectOffline: could not resolve project ${projectId} (${projectResult.reason})`)
    }
    const summary = projectResult.project
    store.commit(
      events.projectSynced({
        id: projectId,
        name: summary.name,
        orgId: summary.orgId != null ? String(summary.orgId) : "",
        settings: null,
        syncedAt: new Date(),
      }),
    )

    const { token: syncToken } = await deps.fetchSyncToken(jwt, projectId, OFFLINE_DOWNLOAD_TOKEN_FILE_ID)

    const files = await deps.fetchProjectFiles(projectId, syncToken)
    let filesDone = 0
    let cellsDone = 0
    setProgress(projectId, { projectId, filesTotal: files.length, filesDone, cellsDone })

    // Sequential, not parallel: keeps at most one file's cell pages in flight
    // so a large project doesn't fan out dozens of concurrent paginated
    // streams against sync-worker at once.
    for (const [index, file] of files.entries()) {
      store.commit(
        events.fileSynced({
          id: file.fileId,
          projectId,
          name: file.name,
          type: file.fileType,
          // The files-list endpoint doesn't return a display sequenceIndex
          // (see FileSummary in cells-read-types.ts) — nothing offline reads
          // this column yet (Phase 4 only wired up cell reads), so list
          // position is a safe stand-in until a real ordering is needed.
          sequenceIndex: index,
        }),
      )
      await deps.streamFileCells(
        projectId,
        file.fileId,
        syncToken,
        (rows) => {
          for (const row of rows) {
            store.commit(
              events.cellSynced({
                projectId,
                fileId: file.fileId,
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
          cellsDone += rows.length
          setProgress(projectId, { projectId, filesTotal: files.length, filesDone, cellsDone })
        },
      )
      filesDone = index + 1
      setProgress(projectId, { projectId, filesTotal: files.length, filesDone, cellsDone })
    }

    store.commit(
      events.offlineProjectStatusSet({ projectId, status: "ready", syncedAt: new Date(), queueDepth: 0 }),
    )
  } catch (err) {
    deleteProjectRows(store, projectId)
    throw err
  } finally {
    setProgress(projectId, null)
  }
}

/** Count of locally queued writes (any status — `pending`, `flushing`, or
 *  stuck `failed`) for a project: none of these are confirmed synced, so a
 *  non-zero count means "Remove offline copy" would discard unsynced work. */
export function getOfflineQueueDepth(store: Store<typeof schema>, projectId: string): number {
  return store.query(tables.eventQueue.select().where({ projectId })).length
}

export type RemoveOfflineProjectResult =
  | { ok: true }
  | { ok: false; reason: "not-downloaded" }
  | { ok: false; reason: "queue-not-empty"; queueDepth: number }

/**
 * Removes a project's local offline copy. Blocked (not forced) when any
 * locally queued write hasn't reached the server yet — `pending`,
 * `flushing`, AND `failed` all count, since none of them are confirmed
 * synced; the caller should warn the user and let them decide rather than
 * silently discarding unsynced work.
 */
export function removeOfflineProject(store: Store<typeof schema>, projectId: string): RemoveOfflineProjectResult {
  const row = store.query(tables.offlineProjects.select().where({ projectId }).first())
  if (!row) return { ok: false, reason: "not-downloaded" }

  const queueDepth = getOfflineQueueDepth(store, projectId)
  if (queueDepth > 0) return { ok: false, reason: "queue-not-empty", queueDepth }

  store.commit(
    events.offlineProjectStatusSet({ projectId, status: "removing", syncedAt: row.syncedAt, queueDepth: 0 }),
  )
  deleteProjectRows(store, projectId)
  return { ok: true }
}

export interface OfflineProjectRow {
  projectId: string
  status: "downloading" | "ready" | "removing"
  syncedAt: Date | null
  queueDepth: number
}

function readOfflineProjectRow(
  store: Store<typeof schema> | null,
  projectId: string | null,
): OfflineProjectRow | null {
  if (!store || !projectId) return null
  return store.query(tables.offlineProjects.select().where({ projectId }).first()) ?? null
}

/**
 * Live-updating `offline_projects` row for one project — drives the "Make
 * available offline" / offline badge / "Remove offline copy" UI. Null
 * outside Tauri (no store) or when the project has no local offline copy.
 */
export function useOfflineProjectStatus(
  store: Store<typeof schema> | null,
  projectId: string | null,
): OfflineProjectRow | null {
  const [row, setRow] = useState<OfflineProjectRow | null>(() => readOfflineProjectRow(store, projectId))

  useEffect(() => {
    setRow(readOfflineProjectRow(store, projectId))
    if (!store || !projectId) return
    return store.subscribe(tables.offlineProjects.select().where({ projectId }), () => {
      setRow(readOfflineProjectRow(store, projectId))
    })
  }, [store, projectId])

  return row
}
