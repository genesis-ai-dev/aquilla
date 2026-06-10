// Typed fetch wrappers for the snapshot API routes (FRO-176).
//
// Endpoints consumed:
//   POST   /api/v1/projects/:id/snapshots           — create
//   GET    /api/v1/projects/:id/snapshots            — list
//   GET    /api/v1/projects/:id/snapshots/:sid       — view one
//   DELETE /api/v1/projects/:id/snapshots/:sid       — soft-delete
//   POST   /api/v1/projects/:id/snapshots/:sid/restore — restore

import { syncWorkerHttpOrigin } from "./sync-worker-url"

export interface Snapshot {
  id: string
  projectId: string
  name: string
  description: string | null
  createdBy: string
  snapshotTs: number
  createdAt: string
}

export interface RestoreResult {
  restored: number
  skippedIdentical: number
  skippedConcurrent: number
  message: string
}

export class SnapshotApiError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`snapshot-api: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = "SnapshotApiError"
  }
}

async function checkResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new SnapshotApiError(res.status, body)
  }
  return res.json() as Promise<T>
}

function projectBase(projectId: string): string {
  return `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/snapshots`
}

export async function createSnapshot(
  projectId: string,
  token: string,
  name: string,
  description?: string,
): Promise<Snapshot> {
  const res = await fetch(projectBase(projectId), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, description }),
  })
  const body = await checkResponse<{ snapshot: Snapshot }>(res)
  return body.snapshot
}

export async function listSnapshots(
  projectId: string,
  token: string,
): Promise<Snapshot[]> {
  const res = await fetch(projectBase(projectId), {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = await checkResponse<{ snapshots: Snapshot[] }>(res)
  return body.snapshots
}

export async function getSnapshot(
  projectId: string,
  snapshotId: string,
  token: string,
): Promise<Snapshot> {
  const res = await fetch(`${projectBase(projectId)}/${encodeURIComponent(snapshotId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = await checkResponse<{ snapshot: Snapshot }>(res)
  return body.snapshot
}

export async function deleteSnapshot(
  projectId: string,
  snapshotId: string,
  token: string,
): Promise<void> {
  const res = await fetch(`${projectBase(projectId)}/${encodeURIComponent(snapshotId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  })
  await checkResponse<{ ok: boolean }>(res)
}

export async function restoreSnapshot(
  projectId: string,
  snapshotId: string,
  token: string,
): Promise<RestoreResult> {
  const res = await fetch(
    `${projectBase(projectId)}/${encodeURIComponent(snapshotId)}/restore`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    },
  )
  return checkResponse<RestoreResult>(res)
}
