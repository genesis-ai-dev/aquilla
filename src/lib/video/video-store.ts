import { openDB } from "idb"

const DB_NAME = "codex"
const DB_VERSION = 3

// Videos share the existing "originals" object store (no schema bump needed).
// Key convention: `codex:video:{id}` to disambiguate from `codex:original:{fileId}`.

function videoKey(id: string): string {
  return `codex:video:${id}`
}

async function getDb() {
  return openDB(DB_NAME, DB_VERSION)
}

export async function storeVideoBlob(id: string, file: File | Blob): Promise<void> {
  const buffer = await file.arrayBuffer()
  const db = await getDb()
  await db.put("originals", buffer, videoKey(id))
}

export async function getVideoBlob(id: string): Promise<Blob | undefined> {
  const db = await getDb()
  const buffer = await db.get("originals", videoKey(id)) as ArrayBuffer | undefined
  if (!buffer) return undefined
  return new Blob([buffer], { type: "video/mp4" })
}

export async function deleteVideoBlob(id: string): Promise<void> {
  const db = await getDb()
  await db.delete("originals", videoKey(id))
}
