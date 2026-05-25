import { openDB, type DBSchema } from "idb"
import type { ProjectRecord, ProjectSnapshot } from "../parsers/types"
import {
  archiveProjectRemote,
  unarchiveProjectRemote,
  type ArchiveResult,
  type UnarchiveResult,
} from "../sync/archive"

interface CodexDB extends DBSchema {
  projects: {
    key: string
    value: ProjectRecord
  }
  originals: {
    key: string
    value: ArrayBuffer
  }
  snapshots: {
    key: string
    value: ProjectSnapshot
    indexes: { "by-project": string }
  }
}

const DB_NAME = "codex"
// v4: drop the legacy `shares` store. Share-link invites now live server-side
// (project_invites in frontier-db-v2) and the joiner flow doesn't need a
// local mirror — accept-invite returns the projectId and the workspace loads
// it via the normal sync-token + sync-worker path.
const DB_VERSION = 4

let dbPromise: ReturnType<typeof openDB<CodexDB>> | null = null

export function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<CodexDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (!db.objectStoreNames.contains("projects")) {
          db.createObjectStore("projects", { keyPath: "id" })
        }
        if (!db.objectStoreNames.contains("originals")) {
          db.createObjectStore("originals")
        }
        if (oldVersion < 2 && !db.objectStoreNames.contains("snapshots")) {
          const store = db.createObjectStore("snapshots", { keyPath: "id" })
          store.createIndex("by-project", "projectId")
        }
        // v3 once created a `shares` store for the legacy share-link flow.
        // v4 removes it — pre-v4 databases get the store deleted on upgrade;
        // fresh databases never see it. Cast away the schema's discriminated
        // store-name union since `shares` is intentionally no longer typed.
        const storeNames = db.objectStoreNames as unknown as DOMStringList
        if (oldVersion < 4 && storeNames.contains("shares")) {
          (db as unknown as IDBDatabase).deleteObjectStore("shares")
        }
      },
      blocked() {
        dbPromise = null
      },
      blocking() {
        dbPromise = null
      },
      terminated() {
        dbPromise = null
      },
    })
  }
  return dbPromise
}

export async function _resetDbForTesting(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise
    db.close()
    dbPromise = null
  }
}

/**
 * Wipe all locally-cached project state. The server (auth-worker
 * GET /api/v2/projects + sync) is the source of truth for this thin client;
 * the IDB mirror is just a cache. Called on logout / account switch so no
 * stale projects, originals, or snapshots survive a session change (they
 * otherwise lingered — a local-first holdover from the pre-AD-3 architecture).
 */
export async function clearAllLocalData(): Promise<void> {
  const db = await getDb()
  await Promise.all([
    db.clear("projects"),
    db.clear("originals"),
    db.clear("snapshots"),
  ])
}

export interface ListProjectsOptions {
  /** Include soft-deleted (trashed) projects. Default: false. */
  includeTrashed?: boolean
}

// Phase 2b: the IDB project-index is no longer the authoritative project
// source — auth-worker's GET /api/v2/projects[/...] is. The hook layer
// (useProject, useAccessibleProjects, dashboard) bypasses these helpers in
// Phase 2b; we leave the implementations intact so existing tests + write
// callers keep working. Phase 2c deletes this file entirely. See spec
// 03-data-model and the Phase 2b commit for the migration plan.

export async function listProjects(
  opts: ListProjectsOptions = {}
): Promise<ProjectRecord[]> {
  const db = await getDb()
  const all = await db.getAll("projects")
  if (opts.includeTrashed) return all
  return all.filter((p) => !p.deletedAt)
}

export async function listTrashedProjects(): Promise<ProjectRecord[]> {
  const db = await getDb()
  const all = await db.getAll("projects")
  return all.filter((p) => Boolean(p.deletedAt))
}

export async function getProject(id: string): Promise<ProjectRecord | undefined> {
  const db = await getDb()
  return db.get("projects", id)
}

export async function createProject(project: ProjectRecord): Promise<void> {
  const db = await getDb()
  await db.put("projects", project)
}

export async function updateProject(project: ProjectRecord): Promise<void> {
  const db = await getDb()
  await db.put("projects", project)
}

/**
 * Read-then-apply: reads the latest record from IDB, passes it to a
 * transform function, and writes the result back. This avoids stale-state
 * overwrites when multiple async operations touch the same project.
 *
 * Returns the updated record (or undefined if the project was not found).
 */
export async function patchProject(
  id: string,
  transform: (latest: ProjectRecord) => ProjectRecord,
): Promise<ProjectRecord | undefined> {
  const latest = await getProject(id)
  if (!latest) return undefined
  const next = transform(latest)
  await updateProject(next)
  return next
}

export async function deleteProject(id: string): Promise<void> {
  const db = await getDb()
  await db.delete("projects", id)
}

export interface TombstoneOutcome {
  /** The updated project record, or null if the project disappeared. */
  project: ProjectRecord | null
  /** What happened on the server side. Useful for surfacing toasts. */
  remote: ArchiveResult | { kind: "skipped-no-session" }
}

/**
 * Move a project to Trash (soft-delete). For cloud-synced projects this hits
 * frontier-server so all collaborators see the tombstone on their next sync
 * event or dashboard load. For purely local projects (no server row yet)
 * we still set the local tombstone — the user experience is the same either
 * way. If the server returns 403, the local tombstone is NOT applied and
 * callers should surface an error.
 */
export async function tombstoneProject(
  project: ProjectRecord,
  opts: { jwt: string | null; fallbackUsername?: string }
): Promise<TombstoneOutcome> {
  let remote: TombstoneOutcome["remote"] = { kind: "skipped-no-session" }
  let deletedBy = opts.fallbackUsername ?? project.username ?? "you"
  let deletedAt = new Date().toISOString()

  if (opts.jwt) {
    remote = await archiveProjectRemote(project.id, opts.jwt)
    // Identity returns 403 for both "no role on this project" AND "no such
    // project" — deliberate existence-privacy. When the local record is
    // local-only-shaped (no origin, no syncRole — same check `canTrash`
    // uses), a 403 here actually means "server has no row for this id."
    // Reclassify so orphan IDB rows from a wizard run that pre-dated the
    // remote-create fix can still be trashed.
    if (remote.kind === "forbidden" && !project.origin && !project.syncRole) {
      remote = { kind: "local-only" }
    }
    if (remote.kind === "forbidden" || remote.kind === "error") {
      return { project: project, remote }
    }
    if (remote.kind === "archived") {
      deletedAt = remote.archivedAt
      deletedBy = remote.archivedBy.username
    }
    // kind === "local-only" — server had no row; continue with local tombstone.
  }

  const updated = await patchProject(project.id, (p) => ({
    ...p,
    deletedAt,
    deletedBy,
  }))

  return { project: updated ?? null, remote }
}

export interface RestoreOutcome {
  project: ProjectRecord | null
  remote: UnarchiveResult | { kind: "skipped-no-session" }
}

/**
 * Restore a trashed project. Symmetric to tombstoneProject.
 */
export async function restoreProject(
  project: ProjectRecord,
  opts: { jwt: string | null }
): Promise<RestoreOutcome> {
  let remote: RestoreOutcome["remote"] = { kind: "skipped-no-session" }

  if (opts.jwt) {
    remote = await unarchiveProjectRemote(project.id, opts.jwt)
    if (remote.kind === "forbidden" || remote.kind === "error") {
      return { project, remote }
    }
    // local-only or restored — both continue to clear the local tombstone.
  }

  const updated = await patchProject(project.id, (p) => {
    const next: ProjectRecord = { ...p }
    delete next.deletedAt
    delete next.deletedBy
    return next
  })

  return { project: updated ?? null, remote }
}

export async function storeOriginalFile(fileId: string, buffer: ArrayBuffer): Promise<void> {
  const db = await getDb()
  await db.put("originals", buffer, `codex:original:${fileId}`)
}

export async function getOriginalFile(fileId: string): Promise<ArrayBuffer | undefined> {
  const db = await getDb()
  return db.get("originals", `codex:original:${fileId}`)
}
