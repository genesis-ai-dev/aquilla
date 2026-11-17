// Run with tsx from the repository; argument is the staged optimized daemon directory.
import assert from 'node:assert/strict'
import type { JobRow } from '../db'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { DaemonDb } = await import(pathToFileURL(join(resolve(process.argv[2]), 'db.ts')).href)
const home = mkdtempSync(join(tmpdir(), 'archive-overlay-'))
const filename = join(home, 'daemon.db')
let db = new DaemonDb(filename)
try {
  db.upsertProject({ gitlab_id: 1, aquilla_id: 'a', name: 'fixture', namespace: 'fixture', org_id: 1, team_id: null, owner_user_id: 1, last_activity_at: '' })
  const job = db.enqueue(1, 'content', 'old')
  assert.equal(db.claim(job.id, 'old'), true)
  db.enqueue(1, 'content', 'pending')
  db.parkArchived(1)
  db.archiveCheckError(1, 'placement changed')
  db.release(job.id)
  assert.equal(db.getJob(job.id).stage, 'skipped_archived')
  assert.equal(db.getJob(job.id).sha, 'pending')
  assert.equal(db.getJob(job.id).error, 'placement changed')
  db.claim(job.id, 'pending'); db.enqueue(1, 'content', 'restart-pending')
  db.close(); db = new DaemonDb(filename); db.recoverJobs()
  assert.equal(db.getJob(job.id).stage, 'skipped_archived')
  assert.equal(db.getJob(job.id).sha, 'restart-pending')
  assert.equal(db.getJob(job.id).error, 'placement changed')
  db.enqueue(1, 'content', 'newest')
  db.enqueue(1, 'audio', 'newest')
  assert.equal(db.getJob(job.id).error, 'placement changed')
  assert.equal(db.listJobs('skipped_archived').length, 2)
  db.resumeArchived(1)
  assert.equal(db.listJobs('detected').length, 2)
  assert.ok(db.listJobs().every((j: JobRow) => j.sha === 'newest' && j.error === null))
  console.log('PASS optimized claim/release, restart, latest SHA, archive errors and unarchive')
} finally { db.close(); rmSync(home, { recursive: true, force: true }) }
