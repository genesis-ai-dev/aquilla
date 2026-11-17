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
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"

const seeds = new Map<string, ProjectRecord>()

// What the account's project directory (OrgContext, one fetch per account)
// last said about each project. A project nobody has opened in this tab has no
// resolved seed above, but every list that links to it was drawn from this
// directory, so its name, org, role, PM and file list are already in memory.
// `useProject` paints from it and marks the record provisional until its own
// GET lands: the directory is as old as the session, so nothing may DECIDE on
// it (a redirect away from a file it does not list, an empty-project state).
const listed = new Map<string, CloudProjectSummary>()

/** Replaces the whole set: an account switch must not leave the last account's rows behind. */
export function rememberListedProjects(projects: readonly CloudProjectSummary[]): void {
  listed.clear()
  for (const project of projects) listed.set(project.id, project)
}

export function readListedProject(projectId: string): CloudProjectSummary | null {
  return listed.get(projectId) ?? null
}

export function rememberResolvedProject(record: ProjectRecord): void {
  seeds.set(record.id, record)
}

export function readResolvedProjectSeed(projectId: string): ProjectRecord | null {
  return seeds.get(projectId) ?? null
}

/** Test-only. */
export function clearResolvedProjectSeeds(): void {
  seeds.clear()
  listed.clear()
}
