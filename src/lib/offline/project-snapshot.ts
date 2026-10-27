// The last server response for a downloaded project's GET /projects/:id, kept
// so the desktop app can open that project after starting with no connection.
//
// `useProject` is server-only by design (AD-3), and the record it builds lives
// in memory for the tab, so a fresh page load offline — an app launch, a
// reload, a full-page navigation — had nothing to build the workspace from and
// showed "Can't reach the server" over a project whose every cell was on disk.
//
// Stored as the raw response, not a ProjectRecord: `minimalProjectRecord` then
// builds the record exactly as it does online (role, files, flags, lanes), so
// the offline path can't drift from it. Refreshed on every online open, so the
// role and file list are as fresh as the last time the project was opened.
//
// Both responses are per account — the role, and the lanes the server filters
// per member — but the offline store is one per device and survives an account
// switch. So each is kept with the username it was fetched for and is only
// ever handed back to that account; another account sees "nothing stored".
import type { Store } from "@livestore/livestore"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"
import type { ProjectStateResponse } from "@/lib/sync/archive"
import type { ProjectSettingsResponse } from "@/lib/sync/project-settings"
import { isProjectOfflineReady } from "./offline-reads"
import { events, tables, type schema } from "./schema"

export type ProjectSnapshot = ProjectStateResponse | CloudProjectSummary

/** What a column holds: a server response and the account it was fetched for. */
interface Owned<T> {
  owner: string
  response: T
}

function ownedBy<T>(stored: unknown, owner: string): T | null {
  if (!stored || typeof stored !== "object") return null
  const { owner: storedOwner, response } = stored as Partial<Owned<T>>
  return storedOwner === owner && response ? response : null
}

function sameStored(stored: unknown, next: Owned<unknown>): boolean {
  return JSON.stringify(stored ?? null) === JSON.stringify(next)
}

/** `owner`'s stored snapshot, or null when the project isn't downloaded or `owner` has none. */
export function readProjectSnapshot(
  store: Store<typeof schema>,
  projectId: string,
  owner: string,
): ProjectSnapshot | null {
  if (!isProjectOfflineReady(store, projectId)) return null
  const row = store.query(tables.projects.select().where({ id: projectId }).first())
  const snapshot = ownedBy<ProjectSnapshot>(row?.snapshot, owner)
  return snapshot && typeof snapshot === "object" && snapshot.id === projectId ? snapshot : null
}

/**
 * Records `snapshot` as `owner`'s, for a project that has a local row
 * (downloaded or downloading). A no-op when nothing changed, so an online open
 * that re-reads the same project doesn't grow the eventlog.
 */
export function writeProjectSnapshot(store: Store<typeof schema>, snapshot: ProjectSnapshot, owner: string): void {
  const row = store.query(tables.projects.select().where({ id: snapshot.id }).first())
  if (!row) return
  const next: Owned<ProjectSnapshot> = { owner, response: snapshot }
  if (sameStored(row.snapshot, next)) return
  store.commit(events.projectSnapshotSynced({ id: snapshot.id, snapshot: next }))
}

/** `owner`'s stored settings response, or null when the project isn't downloaded or `owner` has none. */
export function readProjectSettingsSnapshot(
  store: Store<typeof schema>,
  projectId: string,
  owner: string,
): ProjectSettingsResponse | null {
  if (!isProjectOfflineReady(store, projectId)) return null
  const row = store.query(tables.projects.select().where({ id: projectId }).first())
  const settings = ownedBy<ProjectSettingsResponse>(row?.settings, owner)
  return settings && typeof settings === "object" && "settings" in settings ? settings : null
}

/** As {@link writeProjectSnapshot}, for the project's settings response. */
export function writeProjectSettingsSnapshot(
  store: Store<typeof schema>,
  projectId: string,
  settings: ProjectSettingsResponse,
  owner: string,
): void {
  const row = store.query(tables.projects.select().where({ id: projectId }).first())
  if (!row) return
  const next: Owned<ProjectSettingsResponse> = { owner, response: settings }
  if (sameStored(row.settings, next)) return
  store.commit(events.projectSettingsSnapshotSynced({ id: projectId, settings: next }))
}
