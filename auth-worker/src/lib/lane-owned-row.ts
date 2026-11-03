// Validate the `laneId` a caller may put on a row that ONE language lane owns
// — a knowledge document or a style rule (AQU-2348).
//
// The shape rule (it must be the lane's opaque 8-hex `lanes.id`, and an
// org-shared row can never carry one) lives in db/shared/lane-memory.ts so the
// SPA, this worker and sync-worker all state it the same way. What this adds is
// the part only the database can answer: the id must name a LIVE TARGET lane of
// THIS project.
//
// Why each refusal:
//   * a source lane — the lane a project reads FROM has no memory of its own;
//   * another project's lane id — lane ids are unique per project, so an
//     unchecked id would hide a row behind a lane this project cannot select;
//   * an archived lane (AQU-1462 / AQU-2223) — an archived lane accepts no
//     writes. Its EXISTING rows are untouched, so restoring it brings its
//     documents and rules back; this only refuses adding more while it is
//     closed.
import { laneOwnedRowProblem } from "../../../db/shared/lane-memory"
import { listProjectLanes } from "../../../db/shared/lanes"
import type { AquillaDb } from "../../../db/shim/postgres"

/**
 * The problem with giving a project row to `laneId`, or null when it is fine.
 * `null`/`undefined`/`""` means "the project's own row", which is always fine
 * and is what every row written before this column was.
 */
export async function projectLaneOwnerProblem(
  db: AquillaDb,
  projectId: string,
  laneId: string | null | undefined,
): Promise<string | null> {
  if (laneId == null || laneId === "") return null
  const shape = laneOwnedRowProblem(laneId, { orgOwned: false })
  if (shape) return shape
  const lanes = await listProjectLanes(db, projectId)
  const row = lanes.find((lane) => lane.id === laneId)
  if (!row || row.role !== "target") {
    return `laneId "${laneId}" is not a target lane of this project`
  }
  if (row.archivedAt != null) {
    return `laneId "${laneId}" names an archived lane, which accepts no new rows`
  }
  return null
}
