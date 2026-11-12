// Typed fetch wrapper for the per-file cell-audio attachment read. Pairs with
// cell-audio-read-types.ts (the server response mirror) and feeds the
// useFileAudioAttachments hook.

import { syncWorkerHttpOrigin } from "./sync-worker-url"
import type { FileAudioAttachmentsResponse } from "./cell-audio-read-types"

/**
 * AQU-1591: `lane` is the target-language lane whose takes the caller wants —
 * its own dubs plus the shared programme audio. `undefined` asks for every
 * lane's takes, which is what the whole-project export paths want and what the
 * wire looked like before lanes; `''` is a REAL lane (the default one), so the
 * param is appended whenever it is a string, not whenever it is truthy.
 */
export async function fetchFileAudioAttachments(
  projectId: string,
  fileId: string,
  jwt: string,
  lane?: string,
): Promise<FileAudioAttachmentsResponse> {
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/` +
    `${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/audio-attachments` +
    (typeof lane === "string" ? `?lane=${encodeURIComponent(lane)}` : "")
  const res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`audio-attachments failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
  return (await res.json()) as FileAudioAttachmentsResponse
}
