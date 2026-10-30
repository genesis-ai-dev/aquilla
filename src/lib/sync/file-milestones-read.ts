// Typed fetch wrapper for the per-file hand-set milestone read (AQU-2308).
//
// The route returns the stored records — id, name, and the two ANCHORS — and
// nothing about which cells each one covers. That resolution belongs to the
// navigator, which walks the file's live cell order between the anchors
// (db/shared/file-milestones.ts), so a cell inserted inside a range is covered
// without a write and there is no stored span to fall out of step.

import type { FileMilestone } from "../../../db/shared/file-milestones"
import { syncWorkerHttpOrigin } from "./sync-worker-url"

/** A stored milestone, with the provenance the read adds to the record. */
export interface FileMilestoneRow extends FileMilestone {
  author: string
  eventId: string
  createdAt: number
  updatedAt: number
}

export interface FileMilestonesResponse {
  milestones: FileMilestoneRow[]
}

export async function fetchFileMilestones(
  projectId: string,
  fileId: string,
  jwt: string,
): Promise<FileMilestonesResponse> {
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/` +
    `${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/milestones`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`file milestones failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
  return (await res.json()) as FileMilestonesResponse
}
