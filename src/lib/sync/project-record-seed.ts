// AQU-1325: the last ProjectRecord each useProject resolve produced, kept in
// memory for the lifetime of the tab.
//
// This is NOT a cache in the AD-3 sense — nothing is ever read from it
// instead of the server. It only seeds `useProject`'s initial state so a
// workspace opened from an overview (or an overview opened from a workspace)
// can render the chrome and project name at once while the authoritative
// GET /projects/:id revalidates in the background, exactly like the existing
// `initialProject` route-modal path. A hard reload or deep link starts empty
// and takes the cold path unchanged.

import type { ProjectRecord } from "@/lib/parsers/types"

const seeds = new Map<string, ProjectRecord>()

export function rememberResolvedProject(record: ProjectRecord): void {
  seeds.set(record.id, record)
}

export function readResolvedProjectSeed(projectId: string): ProjectRecord | null {
  return seeds.get(projectId) ?? null
}

/** Test-only. */
export function clearResolvedProjectSeeds(): void {
  seeds.clear()
}
