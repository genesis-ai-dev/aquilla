// Local state for the migrate daemon: projects, jobs (state machine), the
// applied-events ledger (mirror of prod, write-after-ack), file hashes, kv.
import { DatabaseSync } from "node:sqlite"
import fs from "node:fs"
import path from "node:path"

export type JobKind = "content" | "audio"
export type JobStage = "detected" | "fetched" | "planned" | "pushing" | "done" | "failed"
export interface JobRow {
  id: number; project_id: number; kind: JobKind; sha: string; stage: JobStage
  attempts: number; next_run_at: number; created_at: number; updated_at: number
  error: string | null; plan_path: string | null
}
export interface ProjectRow {
  gitlab_id: number; aquilla_id: string; name: string; namespace: string
  org_id: number | null; team_id: number | null; owner_user_id: number | null
  last_activity_at: string; head_sha: string | null; applied_sha: string | null
  content_logic: number; cast_hash: string | null
  status: "ok" | "unmapped" | "failed"; last_error: string | null
  project_upserted: 0 | 1; updated_at: number
}
export const JOB_BACKOFF_MS = [5 * 60e3, 15 * 60e3, 60 * 60e3, 6 * 60 * 60e3, 24 * 60 * 60e3] as const
const UNFINISHED = `stage NOT IN ('done')`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  gitlab_id INTEGER PRIMARY KEY, aquilla_id TEXT NOT NULL, name TEXT NOT NULL, namespace TEXT NOT NULL,
  org_id INTEGER, team_id INTEGER, owner_user_id INTEGER, last_activity_at TEXT NOT NULL,
  head_sha TEXT, applied_sha TEXT, content_logic INTEGER NOT NULL DEFAULT 0, cast_hash TEXT,
  status TEXT NOT NULL DEFAULT 'ok', last_error TEXT, project_upserted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, kind TEXT NOT NULL, sha TEXT NOT NULL,
  stage TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT, plan_path TEXT);
CREATE INDEX IF NOT EXISTS jobs_stage ON jobs(stage, next_run_at, created_at);
CREATE TABLE IF NOT EXISTS applied_events (project_id INTEGER NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY (project_id, event_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS push_log (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL, chunk_no INTEGER NOT NULL,
  events INTEGER NOT NULL, ms INTEGER NOT NULL, http_status INTEGER NOT NULL, attempt INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS files (project_id INTEGER NOT NULL, path TEXT NOT NULL, content_hash TEXT NOT NULL, PRIMARY KEY (project_id, path)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
`

export class DaemonDb {
  private readonly d: DatabaseSync
  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true })
    this.d = new DatabaseSync(file)
    this.d.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
    this.d.exec(SCHEMA)
  }
  close(): void { this.d.close() }

  upsertProject(p: Partial<ProjectRow> & Pick<ProjectRow, "gitlab_id" | "aquilla_id" | "name" | "namespace" | "org_id" | "team_id" | "owner_user_id" | "last_activity_at">): void {
    this.d.prepare(`INSERT INTO projects (gitlab_id, aquilla_id, name, namespace, org_id, team_id, owner_user_id, last_activity_at, status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(gitlab_id) DO UPDATE SET aquilla_id=excluded.aquilla_id, name=excluded.name, namespace=excluded.namespace,
        org_id=excluded.org_id, team_id=excluded.team_id, owner_user_id=excluded.owner_user_id,
        last_activity_at=excluded.last_activity_at, status=excluded.status, updated_at=excluded.updated_at`)
      .run(p.gitlab_id, p.aquilla_id, p.name, p.namespace, p.org_id, p.team_id, p.owner_user_id, p.last_activity_at, p.status ?? "ok", Date.now())
    const patch: Array<[keyof ProjectRow, unknown]> = []
    for (const k of ["head_sha", "applied_sha", "content_logic", "cast_hash", "last_error", "project_upserted"] as const) {
      if (p[k] !== undefined) patch.push([k, p[k]])
    }
    for (const [k, v] of patch) this.d.prepare(`UPDATE projects SET ${k}=? WHERE gitlab_id=?`).run(v as string | number | null, p.gitlab_id)
  }
  getProject(id: number): ProjectRow | undefined {
    return this.d.prepare(`SELECT * FROM projects WHERE gitlab_id=?`).get(id) as ProjectRow | undefined
  }
  listProjects(status?: ProjectRow["status"]): ProjectRow[] {
    return (status
      ? this.d.prepare(`SELECT * FROM projects WHERE status=? ORDER BY gitlab_id`).all(status)
      : this.d.prepare(`SELECT * FROM projects ORDER BY gitlab_id`).all()) as unknown as ProjectRow[]
  }
  setProjectFields(id: number, patch: Partial<Pick<ProjectRow, "head_sha" | "applied_sha" | "content_logic" | "cast_hash" | "status" | "last_error" | "project_upserted">>): void {
    for (const [k, v] of Object.entries(patch)) this.d.prepare(`UPDATE projects SET ${k}=?, updated_at=? WHERE gitlab_id=?`).run(v as string | number | null, Date.now(), id)
  }

  enqueue(projectId: number, kind: JobKind, sha: string): JobRow {
    const now = Date.now()
    const open = this.d.prepare(`SELECT * FROM jobs WHERE project_id=? AND kind=? AND ${UNFINISHED} ORDER BY id DESC LIMIT 1`).get(projectId, kind) as JobRow | undefined
    if (open) {
      if (open.sha !== sha) this.d.prepare(`UPDATE jobs SET sha=?, stage='detected', plan_path=NULL, updated_at=? WHERE id=?`).run(sha, now, open.id)
      return this.getJob(open.id)!
    }
    const r = this.d.prepare(`INSERT INTO jobs (project_id, kind, sha, stage, created_at, updated_at) VALUES (?,?,?,'detected',?,?)`).run(projectId, kind, sha, now, now)
    return this.getJob(Number(r.lastInsertRowid))!
  }
  advance(jobId: number, to: JobStage, patch: { plan_path?: string } = {}): void {
    if (patch.plan_path !== undefined) this.d.prepare(`UPDATE jobs SET stage=?, plan_path=?, error=NULL, updated_at=? WHERE id=?`).run(to, patch.plan_path, Date.now(), jobId)
    else this.d.prepare(`UPDATE jobs SET stage=?, error=NULL, updated_at=? WHERE id=?`).run(to, Date.now(), jobId)
  }
  fail(jobId: number, error: string, now = Date.now()): void {
    const j = this.getJob(jobId)
    if (!j) return
    const attempts = j.attempts + 1
    const delay = JOB_BACKOFF_MS[Math.min(attempts - 1, JOB_BACKOFF_MS.length - 1)]
    // Failed jobs retry from 'detected' so fetch/materialize re-run on a clean slate.
    this.d.prepare(`UPDATE jobs SET stage='detected', attempts=?, next_run_at=?, error=?, plan_path=NULL, updated_at=? WHERE id=?`)
      .run(attempts, now + delay, error.slice(0, 2000), now, jobId)
  }
  getJob(id: number): JobRow | undefined {
    return this.d.prepare(`SELECT * FROM jobs WHERE id=?`).get(id) as JobRow | undefined
  }
  listJobs(stage?: JobStage): JobRow[] {
    return (stage ? this.d.prepare(`SELECT * FROM jobs WHERE stage=? ORDER BY id`).all(stage) : this.d.prepare(`SELECT * FROM jobs ORDER BY id`).all()) as unknown as JobRow[]
  }

  ledgerHas(projectId: number, eventId: string): boolean {
    return !!this.d.prepare(`SELECT 1 FROM applied_events WHERE project_id=? AND event_id=?`).get(projectId, eventId)
  }
  ledgerFilterNew(projectId: number, ids: string[]): string[] {
    const q = this.d.prepare(`SELECT 1 FROM applied_events WHERE project_id=? AND event_id=?`)
    return ids.filter((id) => !q.get(projectId, id))
  }
  ledgerAppend(projectId: number, ids: string[], log: { jobId: number; chunkNo: number; ms: number; httpStatus: number; attempt: number }): void {
    const ins = this.d.prepare(`INSERT OR IGNORE INTO applied_events (project_id, event_id) VALUES (?,?)`)
    this.d.exec("BEGIN")
    try {
      for (const id of ids) ins.run(projectId, id)
      this.d.prepare(`INSERT INTO push_log (job_id, chunk_no, events, ms, http_status, attempt, at) VALUES (?,?,?,?,?,?,?)`)
        .run(log.jobId, log.chunkNo, ids.length, log.ms, log.httpStatus, log.attempt, Date.now())
      this.d.exec("COMMIT")
    } catch (e) {
      this.d.exec("ROLLBACK")
      throw e
    }
  }
  ledgerCount(projectId: number): number {
    return (this.d.prepare(`SELECT COUNT(*) c FROM applied_events WHERE project_id=?`).get(projectId) as { c: number }).c
  }
  ledgerReplace(projectId: number, ids: Iterable<string>): void {
    const ins = this.d.prepare(`INSERT OR IGNORE INTO applied_events (project_id, event_id) VALUES (?,?)`)
    this.d.exec("BEGIN")
    try {
      this.d.prepare(`DELETE FROM applied_events WHERE project_id=?`).run(projectId)
      for (const id of ids) ins.run(projectId, id)
      this.d.exec("COMMIT")
    } catch (e) {
      this.d.exec("ROLLBACK")
      throw e
    }
  }

  fileHash(projectId: number, p: string): string | undefined {
    return (this.d.prepare(`SELECT content_hash FROM files WHERE project_id=? AND path=?`).get(projectId, p) as { content_hash: string } | undefined)?.content_hash
  }
  setFileHashes(projectId: number, entries: { path: string; hash: string }[]): void {
    const up = this.d.prepare(`INSERT INTO files (project_id, path, content_hash) VALUES (?,?,?) ON CONFLICT(project_id, path) DO UPDATE SET content_hash=excluded.content_hash`)
    this.d.exec("BEGIN")
    try {
      for (const e of entries) up.run(projectId, e.path, e.hash)
      this.d.exec("COMMIT")
    } catch (e) {
      this.d.exec("ROLLBACK")
      throw e
    }
  }
  kvGet(key: string): string | undefined {
    return (this.d.prepare(`SELECT value FROM kv WHERE key=?`).get(key) as { value: string } | undefined)?.value
  }
  kvSet(key: string, value: string): void {
    this.d.prepare(`INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value)
  }
}
