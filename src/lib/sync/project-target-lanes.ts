// AQU-1902: the target lane rows of each project open in this tab, so the
// emit layer can stamp every lane-addressed write with its lane row before it
// is queued (src/lib/sync/events-emit.ts → resolveTargetLaneRef).
//
// Fed by useProject, the hook every project surface mounts:
//   - `null`  — the project is open and its lane rows have not loaded yet.
//               A write that names no lane id is refused at the emit, not
//               queued to be refused (and dropped) by the server.
//   - rows    — the loaded target lanes (possibly none).
//   - absent  — nothing in this tab has opened the project's settings. The
//               emit layer then leaves the payload as the caller built it and
//               the server stays authoritative.
//
// Module state rather than React context because the writers include plain
// modules (agent apply, importers) that never see a component tree.

import type { TargetLaneRow } from "@/lib/lanes/target-lane-ref"

const lanesByProject = new Map<string, readonly TargetLaneRow[] | null>()

/** Record a project's target lane rows, or `null` while they load. A `null`
 *  never replaces rows already known: a second surface mounting the same
 *  project must not freeze writes the first one can already address. */
export function setProjectTargetLanes(
  projectId: string,
  rows: readonly TargetLaneRow[] | null,
): void {
  if (rows === null && lanesByProject.get(projectId)) return
  lanesByProject.set(
    projectId,
    rows === null ? null : rows.map(({ id, legacyTag }) => ({ id, legacyTag })),
  )
}

/** The lane this tab last resolved for a project, by id and tag. */
export interface ProjectLaneHint {
  laneId: string
  targetLang: string
}

const hintByProject = new Map<string, ProjectLaneHint>()

/**
 * Record the persisted lane choice (an id read off a real lane row on an
 * earlier load) so writes to the lane the editor is showing can be stamped
 * while the rows are still loading — or never arrive, offline. Only a write
 * naming exactly this tag uses it (resolveTargetLaneRef).
 */
export function setProjectLaneHint(projectId: string, hint: ProjectLaneHint | null): void {
  if (hint) hintByProject.set(projectId, hint)
  else hintByProject.delete(projectId)
}

export function getProjectLaneHint(projectId: string): ProjectLaneHint | null {
  return hintByProject.get(projectId) ?? null
}

/** Forget a project (no surface can say what its lanes are any more). */
export function clearProjectTargetLanes(projectId: string): void {
  lanesByProject.delete(projectId)
}

/** The rows, `null` while loading, `undefined` when nothing registered them. */
export function getProjectTargetLanes(
  projectId: string,
): readonly TargetLaneRow[] | null | undefined {
  return lanesByProject.get(projectId)
}

/** Test seam. */
export function resetProjectTargetLanesForTests(): void {
  lanesByProject.clear()
  hintByProject.clear()
}
