// Typed fetch wrapper for the per-file cell-audio attachment read. Pairs with
// cell-audio-read-types.ts (the server response mirror) and feeds the
// useFileAudioAttachments hook.

import { syncWorkerHttpOrigin } from "./sync-worker-url"
import type { FileAudioAttachmentsResponse } from "./cell-audio-read-types"

export async function fetchFileAudioAttachments(
  projectId: string,
  fileId: string,
  jwt: string,
): Promise<FileAudioAttachmentsResponse> {
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/` +
    `${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/audio-attachments`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`audio-attachments failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
  return (await res.json()) as FileAudioAttachmentsResponse
}
