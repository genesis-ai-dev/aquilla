// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { DaemonDb } from '../db'
import { admitProject, checkArchived } from '../archive'

it('parks both kinds, preserves new revisions, reports new errors and resumes only after verified unarchive', async () => {
  const db = new DaemonDb(':memory:')
  db.upsertProject({gitlab_id: 1, aquilla_id: 'a', name: 'p', namespace: 'g', org_id: 1, team_id: null, owner_user_id: 1, last_activity_at: ''})
  db.enqueue(1, 'content', 'old'); db.enqueue(1, 'audio', 'old')
  const sync = { archiveStatus: vi.fn(async () => true) }
  expect(await admitProject(db, sync, db.getProject(1)!)).toBe(false)
  expect(db.listJobs().every(j => j.stage === 'skipped_archived' && j.error === null)).toBe(true)
  db.enqueue(1, 'content', 'new')
  expect(db.listJobs('skipped_archived').find(j => j.kind === 'content')?.sha).toBe('new')
  await checkArchived(db, sync)
  expect(sync.archiveStatus).toHaveBeenCalledTimes(1)
  db.kvSet('archive_check:1', '0')
  sync.archiveStatus.mockRejectedValueOnce(new Error('HTTP 409 placement changed'))
  await checkArchived(db, sync)
  expect(db.listJobs('skipped_archived').every(j => j.error?.includes('placement changed'))).toBe(true)
  db.enqueue(1, 'content', 'newest')
  expect(db.listJobs('skipped_archived').every(j => j.error?.includes('placement changed'))).toBe(true)
  db.kvSet('archive_check:1', '0'); sync.archiveStatus.mockResolvedValue(false)
  await checkArchived(db, sync)
  expect(db.listJobs('detected')).toHaveLength(2)
  expect(db.listJobs().every(j => j.error === null && j.next_run_at === 0)).toBe(true)
  expect(db.listJobs().find(j => j.kind === 'content')?.sha).toBe('newest')
  db.close()
})
