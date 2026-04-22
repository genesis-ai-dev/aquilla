import { openDB, type DBSchema } from "idb"
import type { ProjectRecord, ProjectSnapshot, ShareInvite } from "../parsers/types"

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

export async function listProjects(): Promise<ProjectRecord[]> {
  const db = await getDb()
  return db.getAll("projects")
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

export async function storeOriginalFile(fileId: string, buffer: ArrayBuffer): Promise<void> {
  const db = await getDb()
  await db.put("originals", buffer, `codex:original:${fileId}`)
}

export async function getOriginalFile(fileId: string): Promise<ArrayBuffer | undefined> {
  const db = await getDb()
  return db.get("originals", `codex:original:${fileId}`)
}
