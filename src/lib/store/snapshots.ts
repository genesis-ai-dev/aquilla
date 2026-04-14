import * as Y from "yjs"
import { IndexeddbPersistence } from "y-indexeddb"
import { v4 as uuid } from "uuid"
import type { ProjectSnapshot, SnapshotFile, ProjectRecord } from "../parsers/types"
import { getProject, updateProject, getDb } from "./project-index"

// --- base64 encoding helpers (Uint8Array <-> base64) ---

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ""
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK)
    binary += String.fromCharCode.apply(null, Array.from(chunk))
  }
  return btoa(binary)
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

// --- capture a file's Yjs state ---

async function captureFileState(fileId: string): Promise<string> {
  const doc = new Y.Doc()
  const persistence = new IndexeddbPersistence(`codex:file:${fileId}`, doc)
  await new Promise<void>((resolve) => {
    if (persistence.synced) resolve()
    else persistence.once("synced", () => resolve())
  })
  const update = Y.encodeStateAsUpdate(doc)
  persistence.destroy()
  doc.destroy()
  return uint8ArrayToBase64(update)
}

// --- restore a file by wiping and re-applying the state update ---

async function restoreFileState(fileId: string, base64State: string): Promise<void> {
  // Step 1: clear existing persisted state
  const oldDoc = new Y.Doc()
  const oldPersistence = new IndexeddbPersistence(`codex:file:${fileId}`, oldDoc)
  await new Promise<void>((resolve) => {
    if (oldPersistence.synced) resolve()
    else oldPersistence.once("synced", () => resolve())
  })
  await oldPersistence.clearData()
  oldDoc.destroy()

  // Step 2: create a fresh doc, apply snapshot state, persist
  const newDoc = new Y.Doc()
  const update = base64ToUint8Array(base64State)
  Y.applyUpdate(newDoc, update)
  const newPersistence = new IndexeddbPersistence(`codex:file:${fileId}`, newDoc)
  await new Promise<void>((resolve) => {
    if (newPersistence.synced) resolve()
    else newPersistence.once("synced", () => resolve())
  })
  // Wait a tick for persistence to flush
  await new Promise((r) => setTimeout(r, 50))
  newPersistence.destroy()
  newDoc.destroy()
}

// --- public API ---

export async function createSnapshot(
  projectId: string,
  name: string,
  description?: string,
  automatic = false
): Promise<ProjectSnapshot> {
  const project = await getProject(projectId)
  if (!project) throw new Error(`Project not found: ${projectId}`)

  const files: SnapshotFile[] = []
  for (const fileRef of project.files) {
    const ydocState = await captureFileState(fileRef.id)
    files.push({
      fileId: fileRef.id,
      fileName: fileRef.name,
      fileType: fileRef.type,
      ydocState,
    })
  }

  const snapshot: ProjectSnapshot = {
    id: uuid(),
    projectId,
    name,
    description,
    createdAt: new Date().toISOString(),
    createdBy: project.username || "anonymous",
    automatic,
    files,
    projectRecord: JSON.parse(JSON.stringify(project)) as ProjectRecord,
  }

  const db = await getDb()
  await db.put("snapshots", snapshot)
  return snapshot
}

export async function listSnapshots(projectId: string): Promise<ProjectSnapshot[]> {
  const db = await getDb()
  const all = await db.getAllFromIndex("snapshots", "by-project", projectId)
  return (all as ProjectSnapshot[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function getSnapshot(snapshotId: string): Promise<ProjectSnapshot | undefined> {
  const db = await getDb()
  return db.get("snapshots", snapshotId) as Promise<ProjectSnapshot | undefined>
}

export async function deleteSnapshot(snapshotId: string): Promise<void> {
  const db = await getDb()
  await db.delete("snapshots", snapshotId)
}

export async function restoreSnapshot(snapshotId: string, username: string): Promise<void> {
  const snapshot = await getSnapshot(snapshotId)
  if (!snapshot) throw new Error(`Snapshot not found: ${snapshotId}`)

  // Create an automatic safety snapshot of current state first
  await createSnapshot(
    snapshot.projectId,
    `Before restoring: ${snapshot.name}`,
    `Auto-created by ${username}`,
    true
  )

  // Restore each file
  for (const file of snapshot.files) {
    await restoreFileState(file.fileId, file.ydocState)
  }

  // Restore the ProjectRecord (preserving project id)
  const restored: ProjectRecord = {
    ...snapshot.projectRecord,
    id: snapshot.projectId,
  }
  await updateProject(restored)
}

export function exportSnapshotToBlob(snapshot: ProjectSnapshot): Blob {
  return new Blob([JSON.stringify(snapshot, null, 2)], {
    type: "application/json",
  })
}

export async function importSnapshotFromFile(
  file: File,
  overrideProjectId?: string
): Promise<ProjectSnapshot> {
  const text = await file.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("Invalid snapshot file: not valid JSON")
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid snapshot file: not an object")
  }

  const snap = parsed as ProjectSnapshot
  if (!snap.name || !Array.isArray(snap.files) || !snap.projectRecord) {
    throw new Error("Invalid snapshot file: missing required fields")
  }

  const imported: ProjectSnapshot = {
    ...snap,
    id: uuid(),
    projectId: overrideProjectId || snap.projectId,
    createdAt: new Date().toISOString(),
  }

  const db = await getDb()
  await db.put("snapshots", imported)
  return imported
}
