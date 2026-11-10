import type { DaemonDb, ProjectRow } from './db'
import type { SyncClient } from './http'

const CHECK_MS = 15 * 60_000
/** Only an authenticated, placement-validated response can park or resume work. */
export async function admitProject(db: DaemonDb, sync: Pick<SyncClient, 'archiveStatus'>, project: ProjectRow): Promise<boolean> {
  const archived = await sync.archiveStatus(project)
  if (archived) {
    db.parkArchived(project.gitlab_id)
    db.kvSet(`archive_check:${project.gitlab_id}`, String(Date.now() + CHECK_MS))
    return false
  }
  if (db.kvGet(`archived:${project.gitlab_id}`) === 'true') db.resumeArchived(project.gitlab_id)
  return true
}

export async function checkArchived(db: DaemonDb, sync: Pick<SyncClient, 'archiveStatus'>): Promise<void> {
  const ids = new Set(db.listJobs('skipped_archived').map(j => j.project_id))
  for (const id of ids) {
    if (Number(db.kvGet(`archive_check:${id}`) ?? 0) > Date.now()) continue
    db.kvSet(`archive_check:${id}`, String(Date.now() + CHECK_MS))
    const project = db.getProject(id)
    if (!project) { db.archiveCheckError(id, 'Archived project record missing'); continue }
    try { await admitProject(db, sync, project) }
    catch (error) { db.archiveCheckError(id, error instanceof Error ? error.message : String(error)) }
  }
}
