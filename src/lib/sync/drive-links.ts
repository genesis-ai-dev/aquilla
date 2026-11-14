// Client for the sync-worker's Drive folder links
// (sync-worker/src/drive/drive-links-route.ts). A linked folder is polled by
// the server; this module only lists, links, unlinks and asks for a pass now.

import { syncWorkerHttpOrigin } from "./sync-worker-url"

export interface DriveLink {
  id: string
  folderId: string
  folderName: string | null
  linkedBy: string
  lastSyncedAt: number | null
  lastError: string | null
  fileCount: number
}

export interface DriveLinkList {
  /** The address a folder must be shared with; null when the server has no key. */
  serviceAccountEmail: string | null
  links: DriveLink[]
}

export interface DriveSyncPass {
  created: string[]
  revised: string[]
  unchanged: number
  errors: string[]
}

/** Any id works: the route checks the token's project only. */
const TOKEN_SCOPE = "drive-links"

type GetToken = (fileId: string) => Promise<string | null>

async function call(projectId: string, getToken: GetToken, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getToken(TOKEN_SCOPE)
  const response = await fetch(
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/drive-links${path}`,
    {
      ...init,
      headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${token ?? ""}` },
    },
  )
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    let message = text
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text
    } catch {
      // plain-text error body
    }
    throw new Error(message || `Drive link request failed (HTTP ${response.status})`)
  }
  return response
}

export async function listDriveLinks(projectId: string, getToken: GetToken): Promise<DriveLinkList> {
  return (await call(projectId, getToken, "")).json() as Promise<DriveLinkList>
}

export async function createDriveLink(projectId: string, getToken: GetToken, folder: string): Promise<void> {
  await call(projectId, getToken, "", { method: "POST", body: JSON.stringify({ folder }) })
}

export async function deleteDriveLink(projectId: string, getToken: GetToken, linkId: string): Promise<void> {
  await call(projectId, getToken, `/${encodeURIComponent(linkId)}`, { method: "DELETE" })
}

export async function syncDriveLinkNow(projectId: string, getToken: GetToken, linkId: string): Promise<DriveSyncPass> {
  return (await call(projectId, getToken, `/${encodeURIComponent(linkId)}/sync`, { method: "POST" })).json() as Promise<DriveSyncPass>
}
