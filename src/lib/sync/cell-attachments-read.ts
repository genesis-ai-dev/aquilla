// Typed fetch wrapper for the sync-worker cell-attachments read API (AQU-777).
//
// Pattern follows comments-read.ts, minus the paging: the read route returns a
// whole file's attachments in one response (see its header for why there is no
// cursor).

import { syncWorkerHttpOrigin } from './sync-worker-url'
import type { CellAttachmentRecord, CellAttachmentsResponse } from './cell-attachments-read-types'

export class CellAttachmentsReadError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`cell-attachments-read failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = 'CellAttachmentsReadError'
  }
}

/**
 * GET /api/v1/projects/:projectId/attachments?fileId=&cellId=
 *
 * Every live attachment in `fileId`, ordered by (cellId, createdAt,
 * attachmentId) so the caller can group by cell in one pass.
 */
export async function fetchAttachmentsForFile(
  projectId: string,
  fileId: string,
  jwt: string,
  opts: { cellId?: string } = {},
): Promise<{ attachments: CellAttachmentRecord[]; truncated: boolean }> {
  const params = new URLSearchParams()
  params.set('fileId', fileId)
  if (opts.cellId) params.set('cellId', opts.cellId)
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/attachments?${params.toString()}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new CellAttachmentsReadError(res.status, body)
  }
  const parsed = (await res.json()) as CellAttachmentsResponse
  return { attachments: parsed.attachments, truncated: parsed.truncated === true }
}
