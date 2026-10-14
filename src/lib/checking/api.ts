import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"
import { fetchSyncToken } from "@/lib/sync/sync-token"
import { fetchProjectFiles, fetchAllFileCells } from "@/lib/sync/cells-read"
import { checkingLabel, sectionForRef, type CheckingFile, type CheckingRole, type CheckingUnit } from "./scope"
export interface CheckingSession {
  session: string; guestId: string; name: string; title: string
  role: CheckingRole; projectId: string
}
export interface CheckingRow {
  fileId: string; cellId: string; fileName: string; label: string | null; text: string; side: "source" | "target"
}
export interface CheckingAudio {
  fileId: string; cellId: string; audioId: string; url: string
  trimStartMs: number | null; trimEndMs: number | null
}
export interface CheckingContent { rows: CheckingRow[]; audio: CheckingAudio[] }
export interface CheckingLink { token: string; title: string; role: CheckingRole; expiresAt: number; revokedAt: number | null }
export async function checkingRequest<T>(path: string, token?: string, body?: unknown): Promise<T> {
  const response = await fetch(`${syncWorkerHttpOrigin()}/checking${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? "Checking is unavailable.")
  return result as T
}
export async function loadCheckingFiles(jwt: string, projectId: string): Promise<CheckingFile[]> {
  const projectToken = await fetchSyncToken(jwt, projectId, "any")
  if (projectToken.role.level < 500) throw new Error("Project lead access is required to share checking links.")
  const files = await fetchProjectFiles(projectId, projectToken.token)
  const result: CheckingFile[] = []
  // Serial file reads bound load on large projects; no N-file Promise.all.
  for (const file of files.filter(file => file.role !== "audio-cues")) {
    const { token } = await fetchSyncToken(jwt, projectId, file.fileId)
    const cells = await fetchAllFileCells(projectId, file.fileId, token, "source")
    result.push({ fileId: file.fileId, name: file.name, units: cells.map((cell, index) => ({
      cellId: cell.cellId, label: checkingLabel(cell.canonicalRef, index), section: sectionForRef(cell.canonicalRef),
    })) })
  }
  return result
}
export async function createCheckingLink(jwt: string, data: { projectId: string; title: string; role: CheckingRole; units: CheckingUnit[]; pin?: string }) {
  const { token } = await fetchSyncToken(jwt, data.projectId, "any")
  return checkingRequest<{ token: string; expiresAt: number }>("", token, data)
}
export function checkingUrl(token: string) { return `${window.location.origin}/check/${token}` }
