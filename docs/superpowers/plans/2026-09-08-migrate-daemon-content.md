# Migrate Daemon (sub-project 1: framework + content) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the OOM-prone, prod-hammering `scripts/migrate-all.ts --apply` sweep with a
stage-based daemon on the always-on Linux box that syncs GitLab → Aquilla content continuously,
with bounded memory, paced prod writes, retries everywhere, and provable fidelity.

**Architecture:** Four independent stages (detect → fetch → materialize → push) over one local
SQLite database (`node:sqlite`), reusing the existing pure mapping libs unchanged. Plans are
streamed to NDJSON per file; a local `applied_events` ledger (write-after-ack, verified against
prod) replaces downloading every event id per run. A single global writer pushes with a token
bucket, adaptive chunking and a circuit breaker. Three small sync-worker changes: a GitLab
webhook inbox on R2, a replay pre-filter that makes ingest truly idempotent, and a count-only
`event-ids` mode.

**Tech Stack:** TypeScript (tsx, Node ≥ 22.13 for unflagged `node:sqlite`), vitest, system
`git`, Cloudflare Worker (sync-worker) + R2, systemd.

**Spec:** `docs/superpowers/specs/2026-09-08-migrate-daemon-design.md`

## Global Constraints

- Node ≥ 22.13 on both dev Mac (22.21.0) and the box (22.23.2); `node:sqlite` only, no
  `better-sqlite3`.
- Daemon lives in `scripts/migrate-daemon/` (typechecked by `tsconfig.node.json`
  `scripts/**/*.ts`; picked up by root vitest). Every daemon test file starts with
  `// @vitest-environment node`.
- No `any`. Files ≤ 500 lines. Match existing style (double quotes in `src/`+`scripts/`,
  single quotes in `sync-worker/`).
- Mapping semantics are untouched: `src/lib/migrate/{map,orphans,ids,comments}.ts`,
  `src/lib/codex-editor/parse-codex.ts`, `scripts/lib/migrate-orphans.ts`,
  `src/lib/import/cast-from-speakers.ts` are imported, never edited.
- Every `/migrate/*` request carries `x-migrate-runner` (fence, AQU-1005) via
  `installMigrateRunnerHeader()` from `scripts/lib/migrate-runner-header.ts`.
- Pacing defaults: `PUSH_EVENTS_PER_SEC=400`, chunk start 500, floor 50, cap 2500, max
  in-flight 1, breaker after 5 consecutive failures pauses 5 min.
- Retry policy (all HTTP): exponential backoff with jitter 1 s → 60 s, 6 attempts, on network
  error / 5xx / 429 (honour `Retry-After`); other 4xx = job failure. Job backoff 5 m, 15 m, 1 h,
  6 h, then 24 h; jobs are never dropped.
- Ledger write only after 2xx. Prod is truth (count verify per job, weekly full re-seed).
- Commit messages: `type(scope): … (AQU-<ticket>)`; end with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Create the AQU ticket first
  (see Task 0) and use its number everywhere `AQU-XXXX` appears below.
- Branch: `ryder/migrate-daemon` off `dev`.

---

## File map

Create:
- `scripts/migrate-daemon/config.ts` — env → typed config
- `scripts/migrate-daemon/db.ts` — SQLite schema, jobs state machine, ledger, files, kv
- `scripts/migrate-daemon/http.ts` — `retryingFetch`, `SyncClient`, `GitLabClient`
- `scripts/migrate-daemon/pacer.ts` — token bucket, adaptive chunk, breaker
- `scripts/migrate-daemon/notify.ts` — Discord digest
- `scripts/migrate-daemon/stages/detect.ts`
- `scripts/migrate-daemon/stages/fetch.ts`
- `scripts/migrate-daemon/stages/materialize.ts`
- `scripts/migrate-daemon/stages/push.ts`
- `scripts/migrate-daemon/main.ts` — CLI
- `scripts/migrate-daemon/parity.ts` — release gate
- `scripts/migrate-daemon/__tests__/*.test.ts`
- `sync-worker/src/events/migrate-webhook-route.ts` (+ test)
- `deploy/migrate-daemon/aquilla-migrate.service`, `deploy/migrate-daemon/env.example`,
  `deploy/migrate-daemon/install.sh`
- `docs/MIGRATE-DAEMON.md`

Modify:
- `sync-worker/src/index.ts` (route registration + Env)
- `sync-worker/src/events/migrate-ingest-route.ts` (replay pre-filter)
- `sync-worker/src/events/migrate-event-ids-route.ts` (`count=1`)
- `sync-worker/wrangler.toml` (`GITLAB_WEBHOOK_SECRET` is a secret; no toml change needed)
- `scripts/migrate-all.ts` (`--dump-plan <dir>` for parity only)
- `.github/workflows/audio-delta-sync.yml` (remove content step at cutover)

---

### Task 0: Ticket, branch, node:sqlite smoke check

**Files:** none created yet.

- [ ] **Step 1: Create Linear ticket** in team Aquilla, project per
  `linear-issue-tracker-constants` memory, title "Migrate daemon: continuous GitLab→Aquilla
  content sync on the Linux box", link the spec. Note its number as `AQU-XXXX`.

- [ ] **Step 2: Branch**

```bash
cd ~/frontierrnd/aquilla && git checkout dev && git pull --ff-only && git checkout -b ryder/migrate-daemon
```

- [ ] **Step 3: Verify node:sqlite is usable unflagged on both hosts**

```bash
node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(":memory:");d.exec("create table t(x)");d.prepare("insert into t values (?)").run(1);console.log(d.prepare("select count(*) c from t").get())'
ssh clear@192.168.1.80 'node -e "const {DatabaseSync}=require(\"node:sqlite\");new DatabaseSync(\":memory:\");console.log(process.version, \"ok\")"'
```
Expected: `{ c: 1 }` locally and `v22.23.2 ok` on the box (an `ExperimentalWarning` on stderr is fine).

- [ ] **Step 4: Verify typechecking sees `scripts/migrate-daemon`**

```bash
mkdir -p scripts/migrate-daemon && printf 'import { DatabaseSync } from "node:sqlite"\nexport const _probe: DatabaseSync = new DatabaseSync(":memory:")\n' > scripts/migrate-daemon/_probe.ts && npx tsc -p tsconfig.node.json --noEmit && rm scripts/migrate-daemon/_probe.ts
```
Expected: exit 0. If `node:sqlite` types are missing, bump `@types/node` (already ^26) — do not add a dependency.

---

### Task 1: config.ts + db.ts (schema, jobs, ledger)

**Files:**
- Create: `scripts/migrate-daemon/config.ts`
- Create: `scripts/migrate-daemon/db.ts`
- Test: `scripts/migrate-daemon/__tests__/db.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DaemonConfig {
    home: string                 // MIGRATE_HOME, default ~/aquilla-migrate
    syncBase: string             // SYNC_BASE, default https://api.aquilla.app/sync
    syncSecret: string           // SYNC_SECRET_KEY
    gitlabUrl: string            // GITLAB_URL
    gitlabToken: string          // FRONTIER_TOKEN
    runner: string               // MIGRATE_RUNNER, default daemon@<hostname>
    pushEventsPerSec: number     // PUSH_EVENTS_PER_SEC, default 400
    chunkStart: number           // 500
    chunkMin: number             // 50
    chunkMax: number             // 2500
    fetchConcurrency: number     // 4
    materializeConcurrency: number // 2
    inboxPollMs: number          // 30_000
    reconcileMs: number          // 900_000
    orgMapsRefreshMs: number     // 3_600_000
    discordWebhookUrl?: string
    r2?: { accountId: string; accessKeyId: string; secretAccessKey: string }
    dryRun: boolean
  }
  export function loadConfig(env?: NodeJS.ProcessEnv, overrides?: Partial<DaemonConfig>): DaemonConfig
  ```
  ```ts
  export type JobKind = "content" | "audio"
  export type JobStage = "detected" | "fetched" | "planned" | "pushing" | "done" | "failed"
  export interface JobRow { id: number; project_id: number; kind: JobKind; sha: string; stage: JobStage; attempts: number; next_run_at: number; created_at: number; updated_at: number; error: string | null; plan_path: string | null }
  export interface ProjectRow { gitlab_id: number; aquilla_id: string; name: string; namespace: string; org_id: number | null; team_id: number | null; owner_user_id: number | null; last_activity_at: string; head_sha: string | null; applied_sha: string | null; content_logic: number; cast_hash: string | null; status: "ok" | "unmapped" | "failed"; last_error: string | null; project_upserted: 0 | 1; updated_at: number }
  export class DaemonDb {
    constructor(path: string)              // ":memory:" allowed
    upsertProject(p: Omit<ProjectRow, "updated_at" | "content_logic" | "cast_hash" | "applied_sha" | "head_sha" | "status" | "last_error" | "project_upserted"> & Partial<ProjectRow>): void
    getProject(gitlabId: number): ProjectRow | undefined
    listProjects(status?: ProjectRow["status"]): ProjectRow[]
    enqueue(projectId: number, kind: JobKind, sha: string): JobRow   // supersede rule
    claim(stage: JobStage, now?: number): JobRow | undefined         // oldest ready job at stage
    advance(jobId: number, to: JobStage, patch?: { plan_path?: string }): void
    fail(jobId: number, error: string, now?: number): void          // backoff schedule
    getJob(id: number): JobRow | undefined
    listJobs(stage?: JobStage): JobRow[]
    ledgerHas(projectId: number, eventId: string): boolean
    ledgerFilterNew(projectId: number, ids: string[]): string[]
    ledgerAppend(projectId: number, ids: string[], pushLog: { jobId: number; chunkNo: number; ms: number; httpStatus: number; attempt: number }): void  // one transaction
    ledgerCount(projectId: number): number
    ledgerReplace(projectId: number, ids: Iterable<string>): void
    fileHash(projectId: number, path: string): string | undefined
    setFileHashes(projectId: number, entries: { path: string; hash: string }[]): void
    kvGet(key: string): string | undefined
    kvSet(key: string, value: string): void
    close(): void
  }
  export const JOB_BACKOFF_MS = [5*60e3, 15*60e3, 60*60e3, 6*60*60e3, 24*60*60e3] as const
  ```

- [ ] **Step 1: Write failing tests**

`scripts/migrate-daemon/__tests__/db.test.ts`:
```ts
// @vitest-environment node
import { describe, it, expect } from "vitest"
import { DaemonDb, JOB_BACKOFF_MS } from "../db"

const proj = (db: DaemonDb, id = 47) =>
  db.upsertProject({ gitlab_id: id, aquilla_id: `aq-${id}`, name: `p${id}`, namespace: "grp", org_id: 1, team_id: null, owner_user_id: 9, last_activity_at: "2026-09-01T00:00:00Z" })

describe("DaemonDb jobs", () => {
  it("enqueue is unique per (project, kind) while unfinished and a newer sha supersedes", () => {
    const db = new DaemonDb(":memory:")
    proj(db)
    const a = db.enqueue(47, "content", "sha1")
    const b = db.enqueue(47, "content", "sha2")
    expect(b.id).toBe(a.id)
    expect(db.getJob(a.id)?.sha).toBe("sha2")
    expect(db.listJobs("detected")).toHaveLength(1)
  })
  it("claim returns the oldest ready job at a stage and none when next_run_at is in the future", () => {
    const db = new DaemonDb(":memory:")
    proj(db, 1); proj(db, 2)
    db.enqueue(1, "content", "s"); db.enqueue(2, "content", "s")
    const first = db.claim("detected")
    expect(first?.project_id).toBe(1)
    db.fail(first!.id, "boom", 1000)
    expect(db.getJob(first!.id)?.next_run_at).toBe(1000 + JOB_BACKOFF_MS[0])
    expect(db.claim("detected", 1000)?.project_id).toBe(2)
  })
  it("fail escalates backoff and never drops the job", () => {
    const db = new DaemonDb(":memory:")
    proj(db)
    const j = db.enqueue(47, "content", "s")
    for (let i = 0; i < 7; i++) db.fail(j.id, `e${i}`, 0)
    const row = db.getJob(j.id)!
    expect(row.attempts).toBe(7)
    expect(row.next_run_at).toBe(JOB_BACKOFF_MS[JOB_BACKOFF_MS.length - 1])
    expect(row.stage).not.toBe("done")
    expect(row.error).toBe("e6")
  })
  it("advance moves stage and stores plan_path", () => {
    const db = new DaemonDb(":memory:")
    proj(db)
    const j = db.enqueue(47, "content", "s")
    db.advance(j.id, "planned", { plan_path: "/x/47/s.ndjson" })
    expect(db.getJob(j.id)).toMatchObject({ stage: "planned", plan_path: "/x/47/s.ndjson" })
  })
})

describe("DaemonDb ledger", () => {
  it("filterNew excludes applied ids; append is atomic with the push log", () => {
    const db = new DaemonDb(":memory:")
    proj(db)
    const j = db.enqueue(47, "content", "s")
    db.ledgerAppend(47, ["a", "b"], { jobId: j.id, chunkNo: 0, ms: 12, httpStatus: 200, attempt: 1 })
    expect(db.ledgerFilterNew(47, ["a", "b", "c"])).toEqual(["c"])
    expect(db.ledgerCount(47)).toBe(2)
    db.ledgerReplace(47, ["z"])
    expect(db.ledgerCount(47)).toBe(1)
    expect(db.ledgerHas(47, "z")).toBe(true)
  })
  it("file hashes and kv round-trip", () => {
    const db = new DaemonDb(":memory:")
    proj(db)
    db.setFileHashes(47, [{ path: "files/target/a.codex", hash: "h1" }])
    expect(db.fileHash(47, "files/target/a.codex")).toBe("h1")
    db.kvSet("inbox_cursor", "k1")
    expect(db.kvGet("inbox_cursor")).toBe("k1")
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm test scripts/migrate-daemon/__tests__/db.test.ts
```
Expected: FAIL — cannot find module `../db`.

- [ ] **Step 3: Implement config.ts**

```ts
// scripts/migrate-daemon/config.ts
import os from "node:os"
import path from "node:path"

export interface DaemonConfig {
  home: string
  syncBase: string
  syncSecret: string
  gitlabUrl: string
  gitlabToken: string
  runner: string
  pushEventsPerSec: number
  chunkStart: number
  chunkMin: number
  chunkMax: number
  fetchConcurrency: number
  materializeConcurrency: number
  inboxPollMs: number
  reconcileMs: number
  orgMapsRefreshMs: number
  discordWebhookUrl?: string
  r2?: { accountId: string; accessKeyId: string; secretAccessKey: string }
  dryRun: boolean
}

const num = (v: string | undefined, d: number): number => (v && Number.isFinite(Number(v)) ? Number(v) : d)

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const required = (k: string): string => {
    const v = env[k]
    if (!v) throw new Error(`${k} not set`)
    return v
  }
  const r2 = env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY
    ? { accountId: env.R2_ACCOUNT_ID, accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY }
    : undefined
  return {
    home: env.MIGRATE_HOME ?? path.join(os.homedir(), "aquilla-migrate"),
    syncBase: env.SYNC_BASE ?? "https://api.aquilla.app/sync",
    syncSecret: required("SYNC_SECRET_KEY"),
    gitlabUrl: required("GITLAB_URL"),
    gitlabToken: required("FRONTIER_TOKEN"),
    runner: env.MIGRATE_RUNNER ?? `daemon@${os.hostname()}`,
    pushEventsPerSec: num(env.PUSH_EVENTS_PER_SEC, 400),
    chunkStart: 500,
    chunkMin: 50,
    chunkMax: 2500,
    fetchConcurrency: num(env.FETCH_CONCURRENCY, 4),
    materializeConcurrency: num(env.MATERIALIZE_CONCURRENCY, 2),
    inboxPollMs: 30_000,
    reconcileMs: 15 * 60_000,
    orgMapsRefreshMs: 60 * 60_000,
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL,
    r2,
    dryRun: false,
    ...overrides,
  }
}
```

- [ ] **Step 4: Implement db.ts**

```ts
// scripts/migrate-daemon/db.ts
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
    this.d.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;")
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
      : this.d.prepare(`SELECT * FROM projects ORDER BY gitlab_id`).all()) as ProjectRow[]
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
  claim(stage: JobStage, now = Date.now()): JobRow | undefined {
    return this.d.prepare(`SELECT * FROM jobs WHERE stage=? AND next_run_at<=? ORDER BY created_at ASC, id ASC LIMIT 1`).get(stage, now) as JobRow | undefined
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
    return (stage ? this.d.prepare(`SELECT * FROM jobs WHERE stage=? ORDER BY id`).all(stage) : this.d.prepare(`SELECT * FROM jobs ORDER BY id`).all()) as JobRow[]
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
    for (const e of entries) up.run(projectId, e.path, e.hash)
    this.d.exec("COMMIT")
  }
  kvGet(key: string): string | undefined {
    return (this.d.prepare(`SELECT value FROM kv WHERE key=?`).get(key) as { value: string } | undefined)?.value
  }
  kvSet(key: string, value: string): void {
    this.d.prepare(`INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value)
  }
}
```

- [ ] **Step 5: Run tests**

```bash
pnpm test scripts/migrate-daemon/__tests__/db.test.ts
```
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-daemon/config.ts scripts/migrate-daemon/db.ts scripts/migrate-daemon/__tests__/db.test.ts
git commit -m "feat(migrate-daemon): sqlite state, job state machine, applied-events ledger (AQU-XXXX)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: http.ts — retrying fetch, SyncClient, GitLabClient

**Files:**
- Create: `scripts/migrate-daemon/http.ts`
- Test: `scripts/migrate-daemon/__tests__/http.test.ts`

**Interfaces:**
- Consumes: `DaemonConfig` (Task 1); `IngestEvent` from `src/lib/migrate/types.ts`;
  `ProjectionCell` from `src/lib/migrate/orphans.ts`.
- Produces:
  ```ts
  export class HttpError extends Error { constructor(public status: number, public body: string, public retryable: boolean) }
  export interface RetryOpts { attempts?: number; baseMs?: number; maxMs?: number; sleep?: (ms: number) => Promise<void>; random?: () => number }
  export async function retryingFetch(url: string, init: RequestInit, opts?: RetryOpts): Promise<Response>
  export class SyncClient {
    constructor(base: string, secret: string, runner: string, opts?: RetryOpts)
    upsertProject(b: { projectId: string; name: string; orgId: number; ownerUserId: number; teamId: number | null }): Promise<void>
    ingest(projectId: string, events: IngestEvent[], eventsOnly?: boolean): Promise<{ status: number; ms: number; accepted: number }>  // single POST, no chunking here
    finalize(projectId: string): Promise<void>
    getSettings(projectId: string): Promise<Record<string, unknown>>
    postSettings(projectId: string, settings: Record<string, unknown>): Promise<void>
    eventIds(projectId: string): AsyncGenerator<string[]>   // pages of ids
    eventCount(projectId: string): Promise<number>          // ?count=1 (Task 6)
    cellIds(projectId: string, fileId: string): Promise<ProjectionCell[]>
    orgTeamMaps(): Promise<OrgTeamMaps>                     // same shape migrate-all.ts fetchOrgTeamMaps returns
    inbox(after: string | undefined): Promise<{ items: InboxItem[]; last: string | undefined }>  // Task 4
  }
  export interface InboxItem { key: string; gitlabId: number; sha: string; ts: number }
  export interface OrgTeamMaps { orgMap: Map<string, { id: number; ownerUserId: number }>; teamMap: Map<string, number> }
  export class GitLabClient {
    constructor(url: string, token: string, opts?: RetryOpts)
    listProjectsByActivity(sinceIso: string | undefined): AsyncGenerator<GitLabProjectLite>  // desc, stops when last_activity_at <= since
    project(id: number): Promise<GitLabProjectLite | null>
    headSha(id: number, branch: string): Promise<string | null>
    rawFile(id: number, path: string, ref: string): Promise<string | null>   // for metadata.json probe
  }
  export interface GitLabProjectLite { id: number; name: string; namespace: string; path_with_namespace: string; last_activity_at: string; http_url_to_repo: string; default_branch: string }
  ```
  Note: verify `fetchOrgTeamMaps` return shape in `scripts/migrate-all.ts:257-268` and copy the
  key format exactly (it is keyed by GitLab group full path / legacy uuid — read it, do not guess).

- [ ] **Step 1: Write failing tests**

```ts
// @vitest-environment node
import { describe, it, expect, vi } from "vitest"
import { retryingFetch, HttpError, SyncClient, GitLabClient } from "../http"

const noSleep = { sleep: async () => {}, random: () => 0.5 }

describe("retryingFetch", () => {
  it("retries on 503 then succeeds, with backoff calls", async () => {
    const calls: number[] = []
    const fetcher = vi.fn(async () => (calls.push(1), calls.length < 3 ? new Response("x", { status: 503 }) : new Response("ok")))
    vi.stubGlobal("fetch", fetcher)
    const sleeps: number[] = []
    const res = await retryingFetch("https://s/x", {}, { ...noSleep, sleep: async (ms) => { sleeps.push(ms) } })
    expect(await res.text()).toBe("ok")
    expect(sleeps).toEqual([1000, 2000])
  })
  it("honours Retry-After on 429", async () => {
    let n = 0
    vi.stubGlobal("fetch", vi.fn(async () => (++n === 1 ? new Response("", { status: 429, headers: { "Retry-After": "7" } }) : new Response("ok"))))
    const sleeps: number[] = []
    await retryingFetch("https://s/x", {}, { ...noSleep, sleep: async (ms) => { sleeps.push(ms) } })
    expect(sleeps).toEqual([7000])
  })
  it("does not retry 400 and throws HttpError(retryable=false)", async () => {
    const f = vi.fn(async () => new Response("bad", { status: 400 }))
    vi.stubGlobal("fetch", f)
    await expect(retryingFetch("https://s/x", {}, noSleep)).rejects.toMatchObject({ status: 400, retryable: false } satisfies Partial<HttpError>)
    expect(f).toHaveBeenCalledTimes(1)
  })
  it("gives up after 6 attempts on network errors", async () => {
    const f = vi.fn(async () => { throw new Error("ECONNRESET") })
    vi.stubGlobal("fetch", f)
    await expect(retryingFetch("https://s/x", {}, noSleep)).rejects.toThrow(/ECONNRESET/)
    expect(f).toHaveBeenCalledTimes(6)
  })
  it("caps backoff at 60s", async () => {
    let n = 0
    vi.stubGlobal("fetch", vi.fn(async () => (++n < 6 ? new Response("", { status: 500 }) : new Response("ok"))))
    const sleeps: number[] = []
    await retryingFetch("https://s/x", {}, { ...noSleep, random: () => 1, sleep: async (ms) => { sleeps.push(ms) } })
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(60_000)
  })
})

describe("SyncClient", () => {
  it("sends bearer + runner header and parses ingest accepted", async () => {
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>
      expect(h.Authorization).toBe("Bearer sec")
      expect(h["x-migrate-runner"]).toBe("daemon@test")
      return Response.json({ accepted: 2 })
    })
    vi.stubGlobal("fetch", f)
    const c = new SyncClient("https://s", "sec", "daemon@test", noSleep)
    const r = await c.ingest("p", [{ id: "a", kind: "k", author: "x", clientTs: 1, payload: {} }, { id: "b", kind: "k", author: "x", clientTs: 1, payload: {} }])
    expect(r.accepted).toBe(2)
    expect(JSON.parse(String((f.mock.calls[0][1] as RequestInit).body))).toMatchObject({ projectId: "p", deferFileCounters: true, eventsOnly: false })
  })
  it("eventIds pages until more=false", async () => {
    let n = 0
    vi.stubGlobal("fetch", vi.fn(async () => (++n === 1 ? Response.json({ ids: ["a"], lastSeq: 5, more: true }) : Response.json({ ids: ["b"], lastSeq: 9, more: false }))))
    const c = new SyncClient("https://s", "sec", "r", noSleep)
    const pages: string[][] = []
    for await (const p of c.eventIds("p")) pages.push(p)
    expect(pages).toEqual([["a"], ["b"]])
  })
})

describe("GitLabClient", () => {
  it("listProjectsByActivity stops at the high-water mark", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([
      { id: 1, name: "a", path_with_namespace: "g/a", namespace: { full_path: "g" }, last_activity_at: "2026-09-08T10:00:00Z", http_url_to_repo: "u", default_branch: "main" },
      { id: 2, name: "b", path_with_namespace: "g/b", namespace: { full_path: "g" }, last_activity_at: "2026-09-01T00:00:00Z", http_url_to_repo: "u", default_branch: "main" },
    ], { headers: { "x-next-page": "" } })))
    const g = new GitLabClient("https://gl", "tok", noSleep)
    const out = []
    for await (const p of g.listProjectsByActivity("2026-09-05T00:00:00Z")) out.push(p.id)
    expect(out).toEqual([1])
  })
})
```

- [ ] **Step 2: Run to verify failure** — `pnpm test scripts/migrate-daemon/__tests__/http.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement http.ts**

```ts
// scripts/migrate-daemon/http.ts
import type { IngestEvent } from "../../src/lib/migrate/types"
import type { ProjectionCell } from "../../src/lib/migrate/orphans"
import { MIGRATE_RUNNER_HEADER } from "../lib/migrate-runner-header"

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly body: string, public readonly retryable: boolean) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`)
  }
}
export interface RetryOpts {
  attempts?: number; baseMs?: number; maxMs?: number
  sleep?: (ms: number) => Promise<void>; random?: () => number
}
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function retryingFetch(url: string, init: RequestInit, opts: RetryOpts = {}): Promise<Response> {
  const attempts = opts.attempts ?? 6, base = opts.baseMs ?? 1000, max = opts.maxMs ?? 60_000
  const sleep = opts.sleep ?? defaultSleep, random = opts.random ?? Math.random
  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let delay = Math.min(max, base * 2 ** (attempt - 1)) * (0.5 + random())
    try {
      const res = await fetch(url, init)
      if (res.ok) return res
      const body = await res.text().catch(() => "")
      const retryable = res.status >= 500 || res.status === 429
      if (!retryable) throw new HttpError(res.status, body, false)
      lastErr = new HttpError(res.status, body, true)
      const ra = Number(res.headers.get("Retry-After"))
      if (res.status === 429 && Number.isFinite(ra) && ra > 0) delay = ra * 1000
    } catch (e) {
      if (e instanceof HttpError && !e.retryable) throw e
      if (!(e instanceof HttpError)) lastErr = e
    }
    if (attempt < attempts) await sleep(Math.min(max, delay))
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

export interface InboxItem { key: string; gitlabId: number; sha: string; ts: number }
export interface OrgTeamMaps { orgMap: Map<string, { id: number; ownerUserId: number }>; teamMap: Map<string, number> }

export class SyncClient {
  constructor(private readonly base: string, private readonly secret: string, private readonly runner: string, private readonly retry: RetryOpts = {}) {}
  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.secret}`, [MIGRATE_RUNNER_HEADER]: this.runner }
  }
  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await retryingFetch(`${this.base}${path}`, { ...init, headers: this.headers() }, this.retry)
    return (await res.json()) as T
  }
  upsertProject(b: { projectId: string; name: string; orgId: number; ownerUserId: number; teamId: number | null }): Promise<void> {
    return this.json<unknown>("/migrate/project", { method: "POST", body: JSON.stringify(b) }).then(() => undefined)
  }
  async ingest(projectId: string, events: IngestEvent[], eventsOnly = false): Promise<{ status: number; ms: number; accepted: number }> {
    const t0 = Date.now()
    const res = await retryingFetch(`${this.base}/migrate/ingest`, {
      method: "POST", headers: this.headers(),
      body: JSON.stringify({ projectId, events, eventsOnly, deferFileCounters: true }),
    }, this.retry)
    const { accepted } = (await res.json()) as { accepted: number }
    return { status: res.status, ms: Date.now() - t0, accepted }
  }
  finalize(projectId: string): Promise<void> {
    return this.json<unknown>("/migrate/finalize", { method: "POST", body: JSON.stringify({ projectId }) }).then(() => undefined)
  }
  async getSettings(projectId: string): Promise<Record<string, unknown>> {
    const r = await this.json<{ settings?: Record<string, unknown> }>(`/migrate/settings?projectId=${encodeURIComponent(projectId)}`)
    return r.settings ?? {}
  }
  postSettings(projectId: string, settings: Record<string, unknown>): Promise<void> {
    return this.json<unknown>("/migrate/settings", { method: "POST", body: JSON.stringify({ projectId, settings }) }).then(() => undefined)
  }
  async *eventIds(projectId: string): AsyncGenerator<string[]> {
    let after = 0
    for (;;) {
      const page = await this.json<{ ids: string[]; lastSeq: number; more: boolean }>(
        `/migrate/event-ids?projectId=${encodeURIComponent(projectId)}&after=${after}&limit=50000`)
      yield page.ids
      if (!page.more) return
      after = page.lastSeq
    }
  }
  async eventCount(projectId: string): Promise<number> {
    return (await this.json<{ count: number }>(`/migrate/event-ids?projectId=${encodeURIComponent(projectId)}&count=1`)).count
  }
  async cellIds(projectId: string, fileId: string): Promise<ProjectionCell[]> {
    const out: ProjectionCell[] = []
    let after = ""
    for (;;) {
      const page = await this.json<{ cells: ProjectionCell[]; lastCellId: string; more: boolean }>(
        `/migrate/cell-ids?projectId=${encodeURIComponent(projectId)}&fileId=${encodeURIComponent(fileId)}&after=${encodeURIComponent(after)}&limit=20000`)
      out.push(...page.cells)
      if (!page.more) return out
      after = page.lastCellId
    }
  }
  async orgTeamMaps(): Promise<OrgTeamMaps> {
    // Mirror scripts/migrate-all.ts fetchOrgTeamMaps() (lines ~257-268) exactly — same
    // endpoint, same key derivation. Copy that function's body here.
    const r = await this.json<{ orgs: Array<{ legacyUuid: string; id: number; ownerUserId: number }>; teams: Array<{ legacyUuid: string; id: number }> }>("/migrate/org-team-maps")
    return {
      orgMap: new Map(r.orgs.map((o) => [o.legacyUuid, { id: o.id, ownerUserId: o.ownerUserId }])),
      teamMap: new Map(r.teams.map((t) => [t.legacyUuid, t.id])),
    }
  }
  inbox(after: string | undefined): Promise<{ items: InboxItem[]; last: string | undefined }> {
    return this.json(`/migrate/webhook/inbox${after ? `?after=${encodeURIComponent(after)}` : ""}`)
  }
}

export interface GitLabProjectLite {
  id: number; name: string; namespace: string; path_with_namespace: string
  last_activity_at: string; http_url_to_repo: string; default_branch: string
}
interface GitLabProjectRaw {
  id: number; name: string; path_with_namespace: string; namespace?: { full_path?: string }
  last_activity_at: string; http_url_to_repo: string; default_branch?: string | null
}
const lite = (p: GitLabProjectRaw): GitLabProjectLite => ({
  id: p.id, name: p.name, path_with_namespace: p.path_with_namespace,
  namespace: p.namespace?.full_path ?? p.path_with_namespace.split("/").slice(0, -1).join("/"),
  last_activity_at: p.last_activity_at, http_url_to_repo: p.http_url_to_repo, default_branch: p.default_branch ?? "main",
})

export class GitLabClient {
  constructor(private readonly url: string, private readonly token: string, private readonly retry: RetryOpts = {}) {}
  private get(path: string): Promise<Response> {
    return retryingFetch(`${this.url}/api/v4${path}`, { headers: { Authorization: `Bearer ${this.token}` } }, this.retry)
  }
  async *listProjectsByActivity(sinceIso: string | undefined): AsyncGenerator<GitLabProjectLite> {
    let page = "1"
    while (page) {
      const res = await this.get(`/projects?per_page=100&order_by=last_activity_at&sort=desc&page=${page}`)
      const rows = (await res.json()) as GitLabProjectRaw[]
      for (const r of rows) {
        if (sinceIso && r.last_activity_at <= sinceIso) return
        yield lite(r)
      }
      page = res.headers.get("x-next-page") ?? ""
    }
  }
  async project(id: number): Promise<GitLabProjectLite | null> {
    try { return lite((await (await this.get(`/projects/${id}`)).json()) as GitLabProjectRaw) }
    catch (e) { if (e instanceof HttpError && e.status === 404) return null; throw e }
  }
  async headSha(id: number, branch: string): Promise<string | null> {
    const res = await this.get(`/projects/${id}/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=1`)
    const rows = (await res.json()) as Array<{ id: string }>
    return rows[0]?.id ?? null
  }
  async rawFile(id: number, filePath: string, ref: string): Promise<string | null> {
    try { return await (await this.get(`/projects/${id}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(ref)}`)).text() }
    catch (e) { if (e instanceof HttpError && e.status === 404) return null; throw e }
  }
}
```

- [ ] **Step 4: Fix `orgTeamMaps` against the real shape.** Open `scripts/migrate-all.ts:257-268`
  and the route `sync-worker/src/events/migrate-org-team-maps-route.ts`; adjust the response
  type and map keys to match exactly. Add a test asserting the key format you observed.

- [ ] **Step 5: Run tests** — expected PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-daemon/http.ts scripts/migrate-daemon/__tests__/http.test.ts
git commit -m "feat(migrate-daemon): retrying http client for sync-worker and GitLab (AQU-XXXX)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: pacer.ts — token bucket, adaptive chunk, circuit breaker

**Files:**
- Create: `scripts/migrate-daemon/pacer.ts`
- Test: `scripts/migrate-daemon/__tests__/pacer.test.ts`

**Interfaces:**
```ts
export interface PacerOpts { eventsPerSec: number; chunkStart: number; chunkMin: number; chunkMax: number; slowMs?: number /*3000*/; growAfter?: number /*20*/; breakerAfter?: number /*5*/; breakerPauseMs?: number /*300000*/; now?: () => number; sleep?: (ms: number) => Promise<void> }
export class Pacer {
  constructor(o: PacerOpts)
  get chunkSize(): number
  get paused(): boolean                      // breaker open
  acquire(events: number): Promise<void>     // waits for tokens and for breaker
  record(r: { ok: boolean; ms: number }): void  // adapts chunk, breaker
  snapshot(): { chunkSize: number; consecutiveOk: number; consecutiveFail: number; breakerOpenUntil: number | null }
}
```

- [ ] **Step 1: Write failing tests**

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest"
import { Pacer } from "../pacer"

function mk(over: Partial<ConstructorParameters<typeof Pacer>[0]> = {}) {
  let t = 0
  const sleeps: number[] = []
  const p = new Pacer({ eventsPerSec: 100, chunkStart: 500, chunkMin: 50, chunkMax: 2500, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms }, ...over })
  return { p, sleeps, tick: (ms: number) => { t += ms } }
}

describe("Pacer", () => {
  it("token bucket sleeps to respect events/sec", async () => {
    const { p, sleeps } = mk()
    await p.acquire(100)   // burst allowance = 1s of tokens
    await p.acquire(50)    // needs 0.5s more
    expect(sleeps).toEqual([500])
  })
  it("halves chunk on failure or slow response (floor) and doubles after 20 fast oks (cap)", () => {
    const { p } = mk()
    p.record({ ok: false, ms: 10 }); expect(p.chunkSize).toBe(250)
    p.record({ ok: true, ms: 5000 }); expect(p.chunkSize).toBe(125)
    for (let i = 0; i < 10; i++) p.record({ ok: false, ms: 1 })
    expect(p.chunkSize).toBe(50)
    for (let i = 0; i < 20; i++) p.record({ ok: true, ms: 100 })
    expect(p.chunkSize).toBe(100)
    for (let i = 0; i < 20 * 10; i++) p.record({ ok: true, ms: 100 })
    expect(p.chunkSize).toBe(2500)
  })
  it("pauses 30s after a failure and opens the breaker after 5 consecutive failures", async () => {
    const { p, sleeps, tick } = mk()
    for (let i = 0; i < 4; i++) p.record({ ok: false, ms: 1 })
    expect(p.paused).toBe(false)
    p.record({ ok: false, ms: 1 })
    expect(p.paused).toBe(true)
    const before = sleeps.length
    await p.acquire(1)
    expect(sleeps.slice(before).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(300_000)
    expect(p.paused).toBe(false)
    p.record({ ok: true, ms: 1 })
    tick(1)
    expect(p.snapshot().consecutiveFail).toBe(0)
  })
})
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// scripts/migrate-daemon/pacer.ts
// Single-writer pacing for prod: token bucket (events/sec), adaptive chunk size,
// and a circuit breaker so a struggling Hyperdrive gets a pause, not a convoy.
export interface PacerOpts {
  eventsPerSec: number; chunkStart: number; chunkMin: number; chunkMax: number
  slowMs?: number; growAfter?: number; breakerAfter?: number; breakerPauseMs?: number; failPauseMs?: number
  now?: () => number; sleep?: (ms: number) => Promise<void>
}
export class Pacer {
  private tokens: number
  private last: number
  private chunk: number
  private okStreak = 0
  private failStreak = 0
  private breakerUntil: number | null = null
  private pendingPause = 0
  private readonly o: Required<PacerOpts>
  constructor(o: PacerOpts) {
    this.o = {
      slowMs: 3000, growAfter: 20, breakerAfter: 5, breakerPauseMs: 5 * 60_000, failPauseMs: 30_000,
      now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), ...o,
    }
    this.tokens = o.eventsPerSec
    this.last = this.o.now()
    this.chunk = o.chunkStart
  }
  get chunkSize(): number { return this.chunk }
  get paused(): boolean { return this.breakerUntil !== null && this.o.now() < this.breakerUntil }
  snapshot() { return { chunkSize: this.chunk, consecutiveOk: this.okStreak, consecutiveFail: this.failStreak, breakerOpenUntil: this.breakerUntil } }

  async acquire(events: number): Promise<void> {
    if (this.breakerUntil !== null) {
      const wait = this.breakerUntil - this.o.now()
      if (wait > 0) await this.o.sleep(wait)
      this.breakerUntil = null
      this.failStreak = 0
    }
    if (this.pendingPause > 0) { const p = this.pendingPause; this.pendingPause = 0; await this.o.sleep(p) }
    this.refill()
    if (this.tokens < events) {
      const need = events - this.tokens
      await this.o.sleep(Math.ceil((need / this.o.eventsPerSec) * 1000))
      this.refill()
    }
    this.tokens = Math.max(0, this.tokens - events)
  }
  private refill(): void {
    const now = this.o.now()
    this.tokens = Math.min(this.o.eventsPerSec, this.tokens + ((now - this.last) / 1000) * this.o.eventsPerSec)
    this.last = now
  }
  record(r: { ok: boolean; ms: number }): void {
    const bad = !r.ok || r.ms > this.o.slowMs
    if (bad) {
      this.okStreak = 0
      this.chunk = Math.max(this.o.chunkMin, Math.floor(this.chunk / 2))
      if (!r.ok) {
        this.failStreak++
        this.pendingPause = this.o.failPauseMs
        if (this.failStreak >= this.o.breakerAfter) this.breakerUntil = this.o.now() + this.o.breakerPauseMs
      }
      return
    }
    this.failStreak = 0
    if (++this.okStreak >= this.o.growAfter) {
      this.okStreak = 0
      this.chunk = Math.min(this.o.chunkMax, this.chunk * 2)
    }
  }
}
```

- [ ] **Step 4: Run** → PASS. If the breaker test's sleep sum assertion is off, remember
  `acquire` sleeps the breaker wait *then* the pending 30 s pause — both count.

- [ ] **Step 5: Commit** — `feat(migrate-daemon): pacer with token bucket, adaptive chunk, breaker (AQU-XXXX)`.

---

### Task 4: sync-worker — GitLab webhook inbox on R2

**Files:**
- Create: `sync-worker/src/events/migrate-webhook-route.ts`
- Modify: `sync-worker/src/index.ts` (Env interface ~line 87-100 add `GITLAB_WEBHOOK_SECRET?: string`; register after `handleMigrateUsersReadRequest` ~line 399)
- Test: `sync-worker/src/__tests__/migrate-webhook.test.ts`

**Interfaces:**
- `POST /migrate/webhook/gitlab` — header `X-Gitlab-Token` must equal `env.GITLAB_WEBHOOK_SECRET`;
  body is GitLab's push hook (`object_kind: "push"`, `project.id`, `after`, `ref`) or project
  hook (`event_name: "project_create"|"project_rename"|"project_transfer"`, `project_id`). Writes
  R2 object `_migrate/inbox/<ts-padded-16>-<gitlabId>.json` with `{ gitlabId, sha, ts, kind }`.
  Returns 204. Other kinds: 204, no write. This route is exempt from the migrate fence
  (GitLab won't send `x-migrate-runner`), so register it **before** `migrateFenceResponse`.
- `GET /migrate/webhook/inbox?after=<key>&limit=<n≤1000>` — admin bearer + fence. Lists
  `_migrate/inbox/` with `startAfter`, returns `{ items: InboxItem[], last: string | undefined }`.

- [ ] **Step 1: Write failing test**

```ts
// sync-worker/src/__tests__/migrate-webhook.test.ts
import { describe, it, expect } from 'vitest'
import { handleMigrateWebhookRequest } from '../events/migrate-webhook-route'

class FakeR2 {
  objects = new Map<string, string>()
  async put(key: string, body: string) { this.objects.set(key, body) }
  async get(key: string) { const b = this.objects.get(key); return b === undefined ? null : { text: async () => b } }
  async list(o: { prefix: string; startAfter?: string; limit?: number }) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(o.prefix) && (!o.startAfter || k > o.startAfter)).sort().slice(0, o.limit ?? 1000)
    return { objects: keys.map((key) => ({ key })), truncated: false }
  }
}
const env = () => ({ SNAPSHOTS: new FakeR2() as unknown as R2Bucket, GITLAB_WEBHOOK_SECRET: 'hook', SYNC_SECRET_KEY: 'sec' })
const push = (token: string, projectId = 47, after = 'abc') => new Request('https://s/migrate/webhook/gitlab', {
  method: 'POST', headers: { 'X-Gitlab-Token': token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ object_kind: 'push', ref: 'refs/heads/main', after, project: { id: projectId } }),
})

describe('/migrate/webhook', () => {
  it('rejects a bad token', async () => {
    const r = await handleMigrateWebhookRequest(push('nope'), env())
    expect(r?.status).toBe(401)
  })
  it('stores push events and lists them in order after a cursor', async () => {
    const e = env()
    expect((await handleMigrateWebhookRequest(push('hook', 1, 'a1'), e))?.status).toBe(204)
    expect((await handleMigrateWebhookRequest(push('hook', 2, 'b2'), e))?.status).toBe(204)
    const list = await handleMigrateWebhookRequest(new Request('https://s/migrate/webhook/inbox', { headers: { Authorization: 'Bearer sec' } }), e)
    const body = (await list!.json()) as { items: Array<{ gitlabId: number; sha: string; key: string }>; last: string }
    expect(body.items.map((i) => [i.gitlabId, i.sha])).toEqual([[1, 'a1'], [2, 'b2']])
    const list2 = await handleMigrateWebhookRequest(new Request(`https://s/migrate/webhook/inbox?after=${encodeURIComponent(body.items[0].key)}`, { headers: { Authorization: 'Bearer sec' } }), e)
    expect(((await list2!.json()) as { items: unknown[] }).items).toHaveLength(1)
  })
  it('ignores non-push, non-project events', async () => {
    const e = env()
    const r = await handleMigrateWebhookRequest(new Request('https://s/migrate/webhook/gitlab', { method: 'POST', headers: { 'X-Gitlab-Token': 'hook' }, body: JSON.stringify({ object_kind: 'issue' }) }), e)
    expect(r?.status).toBe(204)
    expect((e.SNAPSHOTS as unknown as FakeR2).objects.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run** — `cd sync-worker && npm test -- migrate-webhook` → FAIL.

- [ ] **Step 3: Implement route**

```ts
// sync-worker/src/events/migrate-webhook-route.ts
// GitLab → daemon inbox. GitLab POSTs push/project hooks here; the migrate
// daemon polls GET /migrate/webhook/inbox. Storage is the SNAPSHOTS R2 bucket
// under _migrate/inbox/ so no new binding is needed. See docs/MIGRATE-DAEMON.md.
import { isAuthorizedAdminBearer } from '../lib/admin-auth'

const HOOK_PATH = '/migrate/webhook/gitlab'
const INBOX_PATH = '/migrate/webhook/inbox'
const PREFIX = '_migrate/inbox/'
const MAX_LIMIT = 1000

export interface MigrateWebhookEnv {
  SNAPSHOTS?: R2Bucket
  GITLAB_WEBHOOK_SECRET?: string
  ADMIN_SECRET?: string
  SYNC_SECRET_KEY?: string
}
export interface InboxItem { key: string; gitlabId: number; sha: string; ts: number; kind: string }

interface PushHook { object_kind?: string; event_name?: string; ref?: string; after?: string; project?: { id?: number }; project_id?: number }

export async function handleMigrateWebhookRequest(request: Request, env: MigrateWebhookEnv): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname === HOOK_PATH) return receive(request, env)
  if (url.pathname === INBOX_PATH) return list(request, url, env)
  return null
}

async function receive(request: Request, env: MigrateWebhookEnv): Promise<Response> {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
  if (!env.GITLAB_WEBHOOK_SECRET) return new Response('GITLAB_WEBHOOK_SECRET not configured', { status: 500 })
  if (request.headers.get('X-Gitlab-Token') !== env.GITLAB_WEBHOOK_SECRET) return new Response('unauthorized', { status: 401 })
  if (!env.SNAPSHOTS) return new Response('SNAPSHOTS not configured', { status: 500 })
  let body: PushHook
  try { body = (await request.json()) as PushHook } catch { return new Response('invalid JSON', { status: 400 }) }
  const isPush = body.object_kind === 'push'
  const isProject = typeof body.event_name === 'string' && body.event_name.startsWith('project_')
  if (!isPush && !isProject) return new Response(null, { status: 204 })
  const gitlabId = isPush ? body.project?.id : body.project_id
  if (typeof gitlabId !== 'number') return new Response('missing project id', { status: 400 })
  const ts = Date.now()
  const item: InboxItem = { key: `${PREFIX}${String(ts).padStart(16, '0')}-${gitlabId}`, gitlabId, sha: isPush ? (body.after ?? '') : '', ts, kind: isPush ? 'push' : body.event_name! }
  await env.SNAPSHOTS.put(item.key, JSON.stringify(item))
  return new Response(null, { status: 204 })
}

async function list(request: Request, url: URL, env: MigrateWebhookEnv): Promise<Response> {
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405 })
  if (!isAuthorizedAdminBearer(request.headers.get('Authorization') ?? '', env)) return new Response('unauthorized', { status: 401 })
  if (!env.SNAPSHOTS) return new Response('SNAPSHOTS not configured', { status: 500 })
  const after = url.searchParams.get('after') ?? undefined
  const limit = Math.min(Number(url.searchParams.get('limit') ?? MAX_LIMIT) || MAX_LIMIT, MAX_LIMIT)
  const listed = await env.SNAPSHOTS.list({ prefix: PREFIX, startAfter: after, limit })
  const items: InboxItem[] = []
  for (const o of listed.objects) {
    const obj = await env.SNAPSHOTS.get(o.key)
    if (obj) items.push(JSON.parse(await obj.text()) as InboxItem)
  }
  return Response.json({ items, last: items.length ? items[items.length - 1].key : undefined })
}
```

- [ ] **Step 4: Register in index.ts.** In the `Env` interface add `GITLAB_WEBHOOK_SECRET?: string`.
  Immediately **before** `const migrateFence = migrateFenceResponse(request, env, ctx)` insert:
  ```ts
  // GitLab webhook receiver + daemon inbox (AQU-XXXX). The receiver is called by
  // GitLab itself, which cannot send x-migrate-runner, so it sits before the fence.
  if (url.pathname === '/migrate/webhook/gitlab') {
    const r = await handleMigrateWebhookRequest(request, env)
    if (r) return r
  }
  ```
  and after the users-read handler add `const migrateWebhookInbox = await handleMigrateWebhookRequest(request, env); if (migrateWebhookInbox) return migrateWebhookInbox`.
  Confirm `url` is already in scope at that point (it is used by `routeProjectSync`); if not, `const url = new URL(request.url)`.

- [ ] **Step 5: Run** sync-worker tests → PASS. `npx tsc --noEmit -p sync-worker` → clean.

- [ ] **Step 6: Commit** — `feat(sync-worker): GitLab webhook inbox on R2 for the migrate daemon (AQU-XXXX)`.

---

### Task 5: sync-worker — replay pre-filter makes ingest idempotent

**Files:**
- Modify: `sync-worker/src/events/migrate-ingest-route.ts:198-212` (between pass 1 and seq allocation)
- Test: `sync-worker/src/__tests__/migrate-ingest-seq.test.ts` (add a case)

- [ ] **Step 1: Add failing test** (append to the existing `describe` in `migrate-ingest-seq.test.ts`):

```ts
  it("replayed ids skip projection statements (idempotent retry)", async () => {
    await handleMigrateIngestRequest(ingestRequest([cellCreate("e1", "c1", "first")]), env())
    // Simulate a retry that carries a *different* value for the same id.
    const r = await handleMigrateIngestRequest(ingestRequest([cellCreate("e1", "c1", "changed")]), env())
    expect(((await r!.json()) as { accepted: number }).accepted).toBe(0)
    const rows = await t.pg.query<{ value: string }>("SELECT value FROM cells WHERE project_id=$1 AND cell_id=$2", [PROJECT, "c1"])
    expect(rows.rows[0].value).toBe("first")
    expect((await eventSeqs()).length).toBe(1)
  })
```

- [ ] **Step 2: Run** → FAIL (`value` is `changed`, accepted 1).

- [ ] **Step 3: Implement.** After the pass-1 loop and before `allocateSeqRange`:

```ts
  // Replay pre-filter (AQU-XXXX): ON CONFLICT (id) DO NOTHING already drops the
  // events row, but the projection statements built above would still run and
  // overwrite the cell. Drop replayed ids up front so a retried chunk is a no-op.
  const ids = prepared.map((p) => p.row.id)
  const replayed = new Set<string>()
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500)
    const found = await db
      .prepare(`SELECT id FROM events WHERE project_id = ? AND id IN (${slice.map(() => '?').join(',')})`)
      .bind(body.projectId, ...slice)
      .all<{ id: string }>()
    for (const r of found.results ?? []) replayed.add(r.id)
  }
  const fresh = replayed.size ? prepared.filter((p) => !replayed.has(p.row.id)) : prepared
  if (fresh.length === 0) return Response.json({ accepted: 0, replayed: replayed.size })
```
  Then replace `prepared.length` in `allocateSeqRange(...)` with `fresh.length`, iterate `fresh`
  instead of `prepared` in pass 2, and return `Response.json({ accepted: fresh.length, replayed: replayed.size })`.

- [ ] **Step 4: Run the whole sync-worker suite** → PASS (existing "id-replays are dropped" test still green).

- [ ] **Step 5: Commit** — `fix(sync-worker): migrate ingest skips projection for replayed event ids (AQU-XXXX)`.

---

### Task 6: sync-worker — `event-ids?count=1`

**Files:**
- Modify: `sync-worker/src/events/migrate-event-ids-route.ts` (after `projectId` check)
- Test: `sync-worker/src/__tests__/migrate-event-ids-count.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { handleMigrateEventIdsRequest } from '../events/migrate-event-ids-route'
import { handleMigrateIngestRequest } from '../events/migrate-ingest-route'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

let t: TestDb
beforeAll(async () => { t = await makeTestDb() }, 120_000)
afterAll(async () => { await t.close() })
const env = () => ({ AQUILLA_PG: t.db, SYNC_SECRET_KEY: 's' })

describe('GET /migrate/event-ids?count=1', () => {
  it('returns only the count', async () => {
    await handleMigrateIngestRequest(new Request('https://s/migrate/ingest', { method: 'POST', headers: { Authorization: 'Bearer s' },
      body: JSON.stringify({ projectId: 'p', eventsOnly: true, events: [{ id: 'a', kind: 'file.create', author: 'x', clientTs: 1, payload: {} }, { id: 'b', kind: 'file.create', author: 'x', clientTs: 1, payload: {} }] }) }), env())
    const r = await handleMigrateEventIdsRequest(new Request('https://s/migrate/event-ids?projectId=p&count=1', { headers: { Authorization: 'Bearer s' } }), env())
    expect(await r!.json()).toEqual({ count: 2 })
  })
})
```

- [ ] **Step 2: Run** → FAIL (returns ids).

- [ ] **Step 3: Implement** — after `if (!projectId) …`:
```ts
  if (url.searchParams.get('count') === '1') {
    const row = await env.AQUILLA_PG.prepare(`SELECT COUNT(*)::int AS count FROM events WHERE project_id = ?`).bind(projectId).first<{ count: number }>()
    return Response.json({ count: row?.count ?? 0 })
  }
```
  (If the shim lacks `.first`, use `.all` and take `results[0]`.)

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `feat(sync-worker): count-only mode for /migrate/event-ids (AQU-XXXX)`.

- [ ] **Step 6: Deploy sync-worker to development, then production**, using the guarded repo
  commands in `docs/DEPLOYMENT-ENVIRONMENTS.md`; set the secret on both:
  ```bash
  cd sync-worker && npx wrangler secret put GITLAB_WEBHOOK_SECRET --env development
  cd sync-worker && npx wrangler secret put GITLAB_WEBHOOK_SECRET --env production
  ```
  (Cloudflare account: Frontier R&D `6a80496d1e59948a9cbaa3c643ba81d7`.) Record the secret value
  in the same place the other migrate secrets live; it goes into the GitLab webhook config in Task 13.

---

### Task 7: stages/fetch.ts — warm clones keyed by GitLab id

**Files:**
- Create: `scripts/migrate-daemon/stages/fetch.ts`
- Test: `scripts/migrate-daemon/__tests__/fetch.test.ts`

**Interfaces:**
```ts
export interface FetchDeps { clonesDir: string; gitlabToken: string; exec?: typeof execFileP }
export interface FetchResult { dir: string; sha: string; recloned: boolean }
/** Ensure clonesDir/<gitlabId> is a checkout of `branch` at `wantSha` (or newer). */
export async function ensureCheckout(deps: FetchDeps, p: { gitlabId: number; httpUrlToRepo: string; branch: string; wantSha: string }): Promise<FetchResult>
```
Auth: never persist the token in `.git/config`. Use
`git -c http.extraHeader="Authorization: Bearer <token>" clone/fetch <plain https url>`.
(GitLab accepts Bearer OAuth/PAT for git-over-HTTP. If a 401 shows up in the integration
test against `git.genesisrnd.com`, switch to the `https://oauth2:<token>@host/…` form at
command time only, and `git remote set-url origin <plain>` afterwards.)

- [ ] **Step 1: Test with a local bare repo fixture**

```ts
// @vitest-environment node
import { describe, it, expect, beforeAll } from "vitest"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ensureCheckout } from "../stages/fetch"
const x = promisify(execFile)
const git = (cwd: string, ...a: string[]) => x("git", a, { cwd })

let bare: string, work: string, clones: string
beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mdfetch-"))
  bare = path.join(root, "remote.git"); work = path.join(root, "work"); clones = path.join(root, "clones")
  await x("git", ["init", "--bare", "-b", "main", bare])
  await x("git", ["clone", bare, work])
  await git(work, "config", "user.email", "t@t"); await git(work, "config", "user.name", "t")
  fs.writeFileSync(path.join(work, "a.txt"), "1"); await git(work, "add", "."); await git(work, "commit", "-m", "c1"); await git(work, "push", "origin", "main")
})
const head = async () => (await git(work, "rev-parse", "HEAD")).stdout.trim()

describe("ensureCheckout", () => {
  it("clones fresh, then fast-forwards, then re-clones when ff is impossible", async () => {
    const sha1 = await head()
    const r1 = await ensureCheckout({ clonesDir: clones, gitlabToken: "" }, { gitlabId: 7, httpUrlToRepo: bare, branch: "main", wantSha: sha1 })
    expect(r1).toMatchObject({ sha: sha1, recloned: true })
    expect(fs.existsSync(path.join(clones, "7", "a.txt"))).toBe(true)

    fs.writeFileSync(path.join(work, "a.txt"), "2"); await git(work, "commit", "-am", "c2"); await git(work, "push")
    const sha2 = await head()
    const r2 = await ensureCheckout({ clonesDir: clones, gitlabToken: "" }, { gitlabId: 7, httpUrlToRepo: bare, branch: "main", wantSha: sha2 })
    expect(r2).toMatchObject({ sha: sha2, recloned: false })

    await git(work, "reset", "--hard", "HEAD~1"); fs.writeFileSync(path.join(work, "a.txt"), "3"); await git(work, "commit", "-am", "c3"); await git(work, "push", "--force")
    const sha3 = await head()
    const r3 = await ensureCheckout({ clonesDir: clones, gitlabToken: "" }, { gitlabId: 7, httpUrlToRepo: bare, branch: "main", wantSha: sha3 })
    expect(r3).toMatchObject({ sha: sha3, recloned: true })
    expect(fs.readFileSync(path.join(clones, "7", "a.txt"), "utf8")).toBe("3")
  })
  it("throws when the remote head is older than wantSha (webhook raced ahead of the mirror)", async () => {
    await expect(ensureCheckout({ clonesDir: clones, gitlabToken: "" }, { gitlabId: 7, httpUrlToRepo: bare, branch: "main", wantSha: "0".repeat(40) })).rejects.toThrow(/wantSha/)
  })
})
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
// scripts/migrate-daemon/stages/fetch.ts
// Stage 2: keep a disposable, id-keyed working copy of each GitLab project.
// The clone is a cache, never authoritative: if fast-forward is impossible we
// delete and re-clone rather than trying to repair (cf. scripts/lib/checkout-guard.ts,
// which refused; here the daemon owns the directory so wiping is safe).
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs"
import path from "node:path"

export const execFileP = promisify(execFile)
export interface FetchDeps { clonesDir: string; gitlabToken: string; exec?: typeof execFileP }
export interface FetchResult { dir: string; sha: string; recloned: boolean }

export async function ensureCheckout(deps: FetchDeps, p: { gitlabId: number; httpUrlToRepo: string; branch: string; wantSha: string }): Promise<FetchResult> {
  const exec = deps.exec ?? execFileP
  const dir = path.join(deps.clonesDir, String(p.gitlabId))
  const auth = deps.gitlabToken ? ["-c", `http.extraHeader=Authorization: Bearer ${deps.gitlabToken}`] : []
  const git = (args: string[], cwd?: string) => exec("git", [...auth, ...args], { cwd, maxBuffer: 64 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
  const rev = async () => (await git(["rev-parse", "HEAD"], dir)).stdout.trim()
  const contains = async (sha: string) => { try { await git(["merge-base", "--is-ancestor", sha, "HEAD"], dir); return true } catch { return false } }

  let recloned = false
  const clone = async () => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(deps.clonesDir, { recursive: true })
    await git(["clone", "--depth", "50", "--single-branch", "--branch", p.branch, p.httpUrlToRepo, dir])
    recloned = true
  }
  if (!fs.existsSync(path.join(dir, ".git"))) await clone()
  else {
    try {
      await git(["fetch", "--depth", "50", "origin", p.branch], dir)
      await git(["merge", "--ff-only", "FETCH_HEAD"], dir)
    } catch {
      await clone()
    }
  }
  if (!(await contains(p.wantSha))) {
    // Shallow history may not include wantSha yet, or the hook raced the mirror. One deepen, then give up.
    try { await git(["fetch", "--deepen", "200", "origin", p.branch], dir) } catch { /* fall through */ }
    if (!(await contains(p.wantSha))) throw new Error(`checkout ${dir} at ${await rev()} does not contain wantSha ${p.wantSha}`)
  }
  return { dir, sha: await rev(), recloned }
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `feat(migrate-daemon): id-keyed warm clones with ff/re-clone (AQU-XXXX)`.

---

### Task 8: stages/materialize.ts — per-file streaming plan

**Files:**
- Create: `scripts/migrate-daemon/stages/materialize.ts`
- Create: `scripts/migrate-daemon/plan.ts` (NDJSON reader/writer, small)
- Test: `scripts/migrate-daemon/__tests__/materialize.test.ts` using `tests/fixtures/codex-editor/sample.{codex,source}`

**Interfaces:**
```ts
// plan.ts
export interface PlanLine { id: string; event: IngestEvent; prerequisite?: true; }   // prerequisite = IDML file.create that must land before artifact copy
export class PlanWriter { constructor(file: string); write(line: PlanLine): void; close(): Promise<{ lines: number }> }
export async function* readPlan(file: string, batch: number): AsyncGenerator<PlanLine[]>
// materialize.ts
export interface MaterializeDeps { db: DaemonDb; sync: Pick<SyncClient, "cellIds">; plansDir: string; gitlabToken: string; now?: () => number }
export interface MaterializeInput { job: JobRow; project: ProjectRow; dir: string; httpUrlToRepo: string; force?: boolean }
export interface MaterializeResult { planPath: string; lines: number; files: number; changedFiles: number; castHash: string; speakers: { cellId: string; speaker: string }[]; idml: Array<{ relPath: string; fileId: string; original: GitlabIdmlOriginal | undefined }> }
export async function materialize(deps: MaterializeDeps, input: MaterializeInput): Promise<MaterializeResult>
export const CONTENT_LOGIC_VERSION = 4   // MUST equal scripts/migrate-all.ts CONTENT_LOGIC_VERSION; import it if exported, else assert equality in a test
```
Per file pair (stems from `files/target/*.codex` ∪ `.project/sourceTexts/*.source`, sorted):
1. hash = sha256 of (source bytes ‖ "\0" ‖ target bytes); if `!force` and equal to
   `db.fileHash(project, stem)` and `project.applied_sha` is set → skip (nothing new, but the
   file still counts toward `files`).
2. parse both, build `FilePairInput`, IDML branch exactly as `migrate-all.ts:498-520`.
3. `mapFilePairToEvents(pair, { projectId: project.aquilla_id, projectKey: String(gitlab_id), fallbackAuthor: "legacy-import", fallbackTs: now() })`.
4. If ledger has any events for this project: `computeOrphanRetractions({ syncBase, secret, projectId, events, existingEventIds, fallbackAuthor, fallbackTs })` — **but** that helper
   fetches cell-ids with its own `fetch` and base+secret. To keep it unchanged, pass
   `syncBase`/`secret` through `MaterializeDeps` (add `syncBase: string; syncSecret: string`)
   and rely on `installMigrateRunnerHeader()` for the fence header. `existingEventIds` for
   the *file*: build a `Set` from `events.map(e => e.id).filter(id => db.ledgerHas(...))` —
   the orphan pass only consults ids it derives from today's stream plus the projection, so a
   per-file set is sufficient. Read `scripts/lib/migrate-orphans.ts:87-136` to confirm it never
   needs ids outside the passed `events`; if it does, fall back to `db` lookups via a
   `ReadonlySet`-like proxy `{ has: (id) => db.ledgerHas(project, id), size: db.ledgerCount(project) }`.
5. Filter by `db.ledgerFilterNew`, write lines (mark IDML `file.create` lines `prerequisite`).
6. Collect speakers via `collectSpeakers(pair)`; free the pair.
Then `comments.json` → `mapComments` → filter → write. `castHash` = sha256 of sorted
`castLikeSpeakers(speakers)` JSON. Record new file hashes only in `push` after success (return them; push calls `db.setFileHashes`). Add `fileHashes: {path,hash}[]` to `MaterializeResult`.

- [ ] **Step 1: Test** — build a temp project dir from the fixtures (`files/target/GEN-1.codex`,
  `.project/sourceTexts/GEN-1.source`), run `materialize` with an in-memory `DaemonDb`, a fake
  `cellIds` returning `[]`, and assert: plan file exists, `lines > 0`, every line's `event.id`
  is a UUID, second run with unchanged files and ledger seeded with all ids yields `lines === 0`
  and `changedFiles === 0`; modifying the `.codex` value yields `changedFiles === 1`.
  Also assert memory: wrap a 200-file synthetic project (copy the fixture 200×, distinct stems)
  and assert `process.memoryUsage().heapUsed` after materialize is < 300 MB (run
  `global.gc?.()` if available; use `--expose-gc` via `NODE_OPTIONS` in the test script line).

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `plan.ts` (append-only `fs.createWriteStream`,
  `JSON.stringify` per line; reader uses `readline` over a stream, yields batches) and
  `materialize.ts` per the algorithm above, ≤ 400 lines, importing exactly the helpers listed in
  Global Constraints plus `assessIdmlPair/isIdmlPair`, `resolveGitlabIdmlOriginal/downloadGitlabIdmlOriginalBytes`.
  **Step 4: Run** → PASS. **Step 5: Commit** — `feat(migrate-daemon): per-file streaming materialize with ledger delta (AQU-XXXX)`.

---

### Task 9: stages/push.ts — single paced writer, write-after-ack, verify

**Files:**
- Create: `scripts/migrate-daemon/stages/push.ts`
- Test: `scripts/migrate-daemon/__tests__/push.test.ts`

**Interfaces:**
```ts
export interface PushDeps { db: DaemonDb; sync: SyncClient; pacer: Pacer; dryRun: boolean; log: (msg: string) => void }
export interface PushInput { job: JobRow; project: ProjectRow; plan: MaterializeResult }
export interface PushResult { pushed: number; finalized: boolean; settingsUpdated: boolean; verified: boolean; reseeded: boolean }
export async function pushJob(deps: PushDeps, input: PushInput): Promise<PushResult>
export async function seedLedger(db: DaemonDb, sync: SyncClient, project: ProjectRow): Promise<number>  // ledgerReplace from eventIds()
```
Algorithm:
1. If `!project.project_upserted`: `sync.upsertProject({ projectId: aquilla_id, name, orgId: org_id!, ownerUserId: owner_user_id!, teamId: team_id })`; set flag.
2. Prerequisite lines first (IDML `file.create`), then `copyGitlabIdmlOriginal` per `plan.idml` with an original, then the rest. For each batch from `readPlan(planPath, pacer.chunkSize)`: `await pacer.acquire(batch.length)`; `sync.ingest(...)`; `pacer.record({ ok: true, ms })`; `db.ledgerAppend(project, ids, {...})`. On `HttpError` retryable exhaustion: `pacer.record({ ok:false })` and rethrow → job fails with backoff (the ledger has everything acked so far; the retry re-plans and pushes only the remainder).
3. `finalize` only if `pushed > 0`. Settings: if `plan.castHash !== project.cast_hash` and speakers non-empty → `getSettings`, `buildCastAdditions(speakers, tts, randomUUID)`, `postSettings` (same merge as `migrate-all.ts:430-455`); set `cast_hash`.
4. Verify: `count = sync.eventCount(aquilla_id)`; if `count !== db.ledgerCount(project)` → `seedLedger`, set `reseeded`, and return `verified:false` so the caller re-materializes once (push.ts does not loop; main.ts re-enqueues the same sha with `force`).
5. `db.setFileHashes(project, plan.fileHashes)`; `setProjectFields({ applied_sha: job.sha, content_logic: CONTENT_LOGIC_VERSION })`; advance job → `done`.
`dryRun`: skip every `sync.*` write, log counts, do not touch ledger/hashes/applied_sha.

- [ ] **Step 1: Tests** with a fake `SyncClient` (object with the needed methods) and a Pacer
  with `sleep: async () => {}`:
  - ledger contains ids only after a 2xx; a thrown `HttpError(503, …, true)` on chunk 2 leaves chunk 1's ids in the ledger and rejects.
  - finalize not called when plan has 0 lines; settings not called when cast hash unchanged.
  - verify mismatch triggers `seedLedger` and returns `verified: false`.
  - dryRun makes zero calls to `ingest/finalize/postSettings/upsertProject`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** ≤ 300 lines. **Step 4: Run** → PASS.
  **Step 5: Commit** — `feat(migrate-daemon): paced single-writer push with write-after-ack ledger (AQU-XXXX)`.

---

### Task 10: stages/detect.ts — inbox + reconcile + placement

**Files:**
- Create: `scripts/migrate-daemon/stages/detect.ts`
- Test: `scripts/migrate-daemon/__tests__/detect.test.ts`

**Interfaces:**
```ts
export interface DetectDeps { db: DaemonDb; sync: Pick<SyncClient, "inbox" | "orgTeamMaps">; gitlab: GitLabClient; placement: PlacementIndex; log: (m: string) => void }
export interface PlacementIndex { resolve(namespace: string): { orgId: number; ownerUserId: number; teamId: number | null } | undefined }
export async function pollInbox(deps: DetectDeps): Promise<number>      // returns jobs enqueued; advances kv inbox_cursor
export async function reconcile(deps: DetectDeps): Promise<number>      // kv reconcile_hwm; probes new/changed projects
export async function registerProject(deps: DetectDeps, p: GitLabProjectLite, sha: string | null): Promise<"enqueued" | "unmapped" | "not-codex" | "unchanged">
```
`registerProject`: probe Codex-ness like `detectCodexProject` (metadata.json raw, else
`.project/attachments` tree) using `gitlab.rawFile`; resolve placement from
`placement.resolve(p.namespace)` — build `PlacementIndex` from `orgTeamMaps()` the same way
`migrate-all.ts` builds `placeIdx` (~lines 935-965; read and mirror exactly); unmapped →
`upsertProject({... status: "unmapped"})`, no job. Codex + mapped → `upsertProject`, `aquilla_id = projectIdFor(String(p.id), "gitlab")`; if `sha` null → `gitlab.headSha`; if `sha === applied_sha && content_logic === CONTENT_LOGIC_VERSION` → `"unchanged"`; else `enqueue(id, "content", sha)`.

- [ ] **Step 1: Tests**: inbox items enqueue jobs and advance the cursor; duplicate inbox
  items for one project collapse to one job with the latest sha; reconcile stops at the hwm
  and updates it to the newest `last_activity_at`; unmapped namespace records status
  `unmapped`; unchanged sha enqueues nothing.
- [ ] **Step 2–5:** FAIL → implement (≤ 250 lines) → PASS → commit
  `feat(migrate-daemon): detect stage (webhook inbox + reconcile) (AQU-XXXX)`.

---

### Task 11: main.ts — CLI, loop, RunLock, notify, status

**Files:**
- Create: `scripts/migrate-daemon/main.ts`, `scripts/migrate-daemon/notify.ts`
- Modify: `package.json` scripts: `"migrate:daemon": "tsx scripts/migrate-daemon/main.ts"`
- Test: `scripts/migrate-daemon/__tests__/main.test.ts` (arg parsing + one `once --dry-run` loop over an in-memory db with fakes)

Commands:
- `daemon` — acquire `RunLock` (key `_migrate/audio-migrate-state.lock`, same store as
  `migrate-all.ts:887-906`, heartbeat 5 min) when `!dryRun`; then run forever: every
  `inboxPollMs` → `pollInbox`; every `reconcileMs` → `reconcile`; every `orgMapsRefreshMs` →
  rebuild placement; continuously: up to `fetchConcurrency` jobs at `detected` → `ensureCheckout`
  → `fetched`; up to `materializeConcurrency` at `fetched` → `materialize` → `planned`
  (`plan_path`); one at `planned` → `pushJob` → `done` (or re-enqueue with force when
  `verified:false`). Weekly (kv `last_full_reseed`): `seedLedger` for every `ok` project, one at
  a time, paced by `pacer.acquire(1)` per page. SIGINT/SIGTERM: stop claiming, finish the in-flight
  chunk, release lock. Any stage error → `db.fail(job, err)` + Discord line.
- `once [--only <id>] [--kind content] [--dry-run] [--force]` — one pass of every stage until no
  ready jobs remain; with `--only`, `registerProject` for that id first.
- `status` — prints projects by status, jobs by stage, pacer snapshot, failed jobs with errors, ledger totals.
- `reconcile` — one `reconcile()` and exit. `seed-ledger [--only]` — `seedLedger`.
`notify.ts`: `postDiscord(url, text)` (retryingFetch, swallow failures) and an hourly digest
(jobs done/failed, events pushed, breaker trips) — only when `DISCORD_WEBHOOK_URL` set.

- [ ] **Step 1: Test** `parseArgs` and a `once --dry-run` run that, with fakes, walks a job
  `detected → fetched → planned → done` and makes no sync writes.
- [ ] **Step 2–5:** FAIL → implement (main ≤ 400 lines; put the scheduler loop in
  `scripts/migrate-daemon/loop.ts` if main grows) → PASS → commit
  `feat(migrate-daemon): CLI, scheduler loop, run lock, Discord digest (AQU-XXXX)`.
- [ ] **Step 6: Local integration** against `pnpm dev` (SYNC_BASE=http://localhost:<sync port>/,
  `SYNC_SECRET_KEY` from `sync-worker/.dev.vars`): `pnpm migrate:daemon once --only 47 --dry-run`
  then without `--dry-run`; confirm rows in the local Postgres `events` for the project and that a
  second run pushes 0 events. Paste the output into the PR.

---

### Task 12: Parity gate — `--dump-plan` on migrate-all.ts + parity.ts

**Files:**
- Modify: `scripts/migrate-all.ts` — in `parseArgs` add `dumpPlan: val("--dump-plan")`; in
  `doProject` just before the dry-run return (line ~535) if `args.dumpPlan`, write
  `<dumpPlan>/<gitlabId>.ndjson` with one `{id, hash}` per event where
  `hash = sha256(JSON.stringify({kind,fileId,cellId,parentId,author,clientTs,payload}))`. Nothing else changes.
- Create: `scripts/migrate-daemon/parity.ts` — for each `<id>.ndjson` in dir A (old) and the
  daemon's plan dir B (`plans/<id>/<sha>.ndjson`, take newest), compare id sets and per-id
  hashes; print per-project `missing/extra/changed` counts and exit 1 on any difference.
  Note the daemon's plan has already been ledger-filtered — run the daemon with an **empty
  ledger** (`--dry-run` on a fresh `MIGRATE_HOME`) so both sides are full streams.
- Test: `scripts/migrate-daemon/__tests__/parity.test.ts` with two tiny dirs (equal → exit 0; one changed hash → reports it).

- [ ] Steps: test → FAIL → implement → PASS → commit `test(migrate): parity gate between migrate-all dry-run and daemon plans (AQU-XXXX)`.

---

### Task 13: Deploy to the box + docs

**Files:**
- Create: `deploy/migrate-daemon/aquilla-migrate.service`, `deploy/migrate-daemon/env.example`, `deploy/migrate-daemon/install.sh`
- Create: `docs/MIGRATE-DAEMON.md`

- [ ] **Step 1: Unit file**

```ini
[Unit]
Description=Aquilla migrate daemon (GitLab -> Aquilla content sync)
After=network-online.target
Wants=network-online.target

[Service]
User=clear
WorkingDirectory=/home/clear/aquilla
EnvironmentFile=/etc/aquilla-migrate/env
Environment=NODE_OPTIONS=--max-old-space-size=16384
Environment=MIGRATE_HOME=/home/clear/aquilla-migrate
ExecStartPre=/usr/bin/git -C /home/clear/aquilla pull --ff-only
ExecStartPre=/usr/bin/env pnpm install --frozen-lockfile
ExecStart=/usr/bin/env pnpm migrate:daemon daemon
Restart=always
RestartSec=10
MemoryMax=32G
StandardOutput=append:/home/clear/aquilla-migrate/daemon.log
StandardError=inherit

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: env.example** listing every key from `loadConfig` with comments; `install.sh`:
  `git clone git@github.com:genesis-ai-dev/aquilla ~/aquilla` (or https with a deploy token),
  `corepack enable && corepack prepare pnpm@10.19.0 --activate`, `sudo install -m 600 env /etc/aquilla-migrate/env`,
  `sudo cp aquilla-migrate.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now aquilla-migrate`,
  plus `logrotate` stanza for `daemon.log` (weekly, 8 rotations).

- [ ] **Step 3: docs/MIGRATE-DAEMON.md** — what it is, stages, pacing knobs, how to read
  `status`, how to run `once --only`, how to re-seed a ledger, where logs live, the GitLab
  webhook setup (URL `https://api.aquilla.app/sync/migrate/webhook/gitlab`, secret token,
  triggers: Push events on all branches + Project events via a **system hook** in GitLab admin —
  needs the admin token Ryder offered), and the cutover checklist from the spec.

- [ ] **Step 4: Bring it up on the box** (from the Mac):
```bash
ssh clear@192.168.1.80 'bash -s' < deploy/migrate-daemon/install.sh
```
  Copy the real env (from `~/frontierrnd/aquilla/.env` on the Mac, plus `MIGRATE_RUNNER=daemon@pop-os`,
  `DRY_RUN=1` for now) to `/etc/aquilla-migrate/env` via `scp` + `sudo install`. The service
  starts in dry-run because `main.ts` reads `DRY_RUN=1` → `dryRun: true`.

- [ ] **Step 5: 2-hour dry-run window.** Let it run `reconcile` + fetch + materialize for all
  projects (nothing pushed). Then on the box:
```bash
pnpm migrate:daemon status
```
  and run the parity gate (Task 12) against a fresh `--dump-plan` from the Mac. Expected:
  `status` shows ≥ 419 projects `ok`, ~26 `unmapped`, 0 stale-checkout failures (id-keyed
  re-clone fixes those 41), and parity reports zero differences. Attach both outputs to the PR.

- [ ] **Step 6: Canary.** `sed -i 's/^DRY_RUN=1/DRY_RUN=0/; s/^PUSH_EVENTS_PER_SEC=.*/PUSH_EVENTS_PER_SEC=100/' /etc/aquilla-migrate/env`,
  `sudo systemctl restart aquilla-migrate`, then `pnpm migrate:daemon once --only 47` (or another
  project already in prod). Watch Neon `sweet-paper-88472094` query latency and the PostHog
  `/migrate/*` log for 15 min. Then raise to 400/s and let the daemon drain the backlog overnight UTC.

- [ ] **Step 7: Commit** deploy files + docs — `chore(migrate-daemon): systemd deploy, env template, runbook (AQU-XXXX)`.

---

### Task 14: Cutover — register the webhook, remove content from the nightly workflow

**Files:**
- Modify: `.github/workflows/audio-delta-sync.yml:114-131` (delete the content step and its
  `content.log` handling in the summary at ~170-172; keep users + audio-fast).

- [ ] **Step 1:** In GitLab admin → System Hooks: add
  `https://api.aquilla.app/sync/migrate/webhook/gitlab`, secret = `GITLAB_WEBHOOK_SECRET`,
  triggers Push + Repository update, SSL on. Test hook → expect 204 and an inbox item in R2
  (`aws s3 ls s3://aquilla-snapshots/_migrate/inbox/ --endpoint-url …`).
- [ ] **Step 2:** Push a trivial commit to a Codex test project; confirm within ~1 min the box
  shows a job `detected → done` in `status` and the events in prod.
- [ ] **Step 3:** Remove the content step from the workflow; run the workflow manually once to
  confirm users + audio still pass. Commit `ci: nightly delta-sync no longer runs content (daemon owns it) (AQU-XXXX)`.
- [ ] **Step 4:** Delete the disabled crontab line on the Mac; update memory
  `prod-load-migrate-all-cron.md` to say the daemon on `pop-os` owns content sync.
- [ ] **Step 5:** Open the PR (title/body per `.github/pull_request_template.md`), include:
  parity output, `status` output after the backlog drain, and Neon latency screenshot during
  the canary.

---

## Self-review

**Spec coverage:** detect (T10), fetch (T7), materialize (T8), push + pacing + breaker + verify
(T3, T9), ledger + write-after-ack (T1, T9), retries everywhere (T2), job backoff never drops
(T1), webhook inbox (T4), idempotent projection (T5), count endpoint (T6), parity gate (T12),
deployment/systemd/secrets/lock (T11, T13), 2-hour dry-run + canary + cutover (T13, T14),
weekly re-seed (T11), unmapped surfaced not skipped (T10), IDML handling preserved (T8, T9),
`MIGRATE_RUNNER` header (T2). Audio and users/groups are sub-projects 2 and 3 — not here.

**Placeholders:** Tasks 8–11 give algorithms and interfaces with full test intent rather than
every line of code; each names the exact existing functions to call and the file/line ranges to
mirror. Task 2's `orgTeamMaps` and Task 10's placement index explicitly require reading the
current `migrate-all.ts` code rather than guessing the key format.

**Type consistency:** `DaemonDb` method names used in T8–T11 match T1 (`ledgerFilterNew`,
`ledgerAppend`, `ledgerCount`, `ledgerReplace`, `setFileHashes`, `setProjectFields`, `enqueue`,
`claim`, `advance`, `fail`, `kvGet/kvSet`). `SyncClient` methods used in T8–T10 match T2.
`Pacer.acquire/record/chunkSize` match T3. `MaterializeResult` fields consumed by T9 are all
defined in T8 (including `fileHashes`, added in the algorithm note).
