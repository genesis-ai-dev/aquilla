import { openDB, type DBSchema } from "idb"
import type { ProjectRecord, ProjectSnapshot, ShareInvite } from "../parsers/types"
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
  shares: {
    key: string
    value: ShareInvite
    indexes: { "by-project": string }
  }
}

const DB_NAME = "codex"
const DB_VERSION = 3

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
        if (oldVersion < 3 && !db.objectStoreNames.contains("shares")) {
          const store = db.createObjectStore("shares", { keyPath: "token" })
          store.createIndex("by-project", "projectId")
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

export interface ListProjectsOptions {
  /** Include soft-deleted (trashed) projects. Default: false. */
  includeTrashed?: boolean
}

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
