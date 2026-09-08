// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "../main"
import { Scheduler, type SchedulerCtx, type StageFns } from "../loop"
import { Digest } from "../notify"
import { DaemonDb, type ProjectRow } from "../db"
import { loadConfig, type DaemonConfig } from "../config"
import { Pacer } from "../pacer"
import type { GitLabClient, GitLabProjectLite, SyncClient } from "../http"
import type { GitLabCredentials } from "../../../src/lib/migrate/gitlab/auth"
import type { MaterializeResult } from "../stages/materialize"
import type { PushResult } from "../stages/push"

describe("parseArgs", () => {
  it("defaults to the daemon command", () => {
    expect(parseArgs([], {})).toEqual({ cmd: "daemon", kind: "content", dryRun: false, force: false })
  })
  it("parses each command", () => {
    for (const cmd of ["daemon", "once", "status", "reconcile", "seed-ledger"] as const) {
      expect(parseArgs([cmd], {}).cmd).toBe(cmd)
    }
  })
  it("rejects an unknown command", () => {
    expect(() => parseArgs(["frobnicate"], {})).toThrow(/unknown command/i)
  })
  it("parses --only as a number", () => {
    expect(parseArgs(["once", "--only", "47"], {}).only).toBe(47)
  })
  it("rejects a non-numeric --only", () => {
    expect(() => parseArgs(["once", "--only", "abc"], {})).toThrow(/--only/)
  })
  it("parses --dry-run and --force", () => {
    const a = parseArgs(["once", "--dry-run", "--force"], {})
    expect(a.dryRun).toBe(true)
    expect(a.force).toBe(true)
  })
  it("takes dryRun from DRY_RUN=1 in the env", () => {
    expect(parseArgs(["once"], { DRY_RUN: "1" }).dryRun).toBe(true)
    expect(parseArgs(["once"], { DRY_RUN: "0" }).dryRun).toBe(false)
  })
  it("accepts --kind content", () => {
    expect(parseArgs(["once", "--kind", "content"], {}).kind).toBe("content")
    expect(() => parseArgs(["once", "--kind", "audio"], {})).toThrow(/kind/)
  })
})

const PROJECT: ProjectRow = {
  gitlab_id: 7, aquilla_id: "proj-7", name: "Seven", namespace: "ns/seven",
  org_id: 3, team_id: 4, owner_user_id: 5, last_activity_at: "2026-01-01T00:00:00Z",
  head_sha: "abc", applied_sha: null, content_logic: 0, cast_hash: null,
  status: "ok", last_error: null, project_upserted: 1, updated_at: 0,
}
const GL_PROJECT: GitLabProjectLite = {
  id: 7, name: "Seven", namespace: "ns/seven", path_with_namespace: "ns/seven",
  last_activity_at: "2026-01-01T00:00:00Z", http_url_to_repo: "https://git/ns/seven.git", default_branch: "main",
}
const ENV = { SYNC_SECRET_KEY: "s", GITLAB_URL: "https://git", FRONTIER_TOKEN: "t" }

let root: string
let db: DaemonDb
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-main-"))
  db = new DaemonDb(":memory:")
  db.upsertProject(PROJECT)
})
afterEach(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

function planFor(jobId: number): MaterializeResult {
  return {
    planPath: path.join(root, `job-${jobId}.ndjson`), lines: 2, files: 1, changedFiles: 1,
    castHash: "cast", speakers: [], fileHashes: [], idml: [],
  }
}

interface Calls { checkouts: number; materializes: { force: boolean }[]; pushes: number }

function makeScheduler(over: {
  config?: Partial<DaemonConfig>
  checkoutSha?: string
  materializeThrows?: boolean
  push?: PushResult
}) {
  const calls: Calls = { checkouts: 0, materializes: [], pushes: 0 }
  const config = loadConfig(ENV, { home: root, ...over.config })
  const stages: StageFns = {
    ensureCheckout: async (_deps, p) => {
      calls.checkouts++
      return { dir: path.join(root, "clones", String(p.gitlabId)), sha: over.checkoutSha ?? p.wantSha, recloned: false }
    },
    materialize: async (_deps, input) => {
      calls.materializes.push({ force: input.force === true })
      if (over.materializeThrows) throw new Error("boom")
      return planFor(input.job.id)
    },
    pushJob: async (deps, input) => {
      calls.pushes++
      const res = over.push ?? { pushed: 2, finalized: true, settingsUpdated: false, verified: true, reseeded: false }
      if (!deps.dryRun && res.verified) deps.db.advance(input.job.id, "done")
      return res
    },
  }
  const ctx: SchedulerCtx = {
    config,
    db,
    sync: {} as SyncClient,
    gitlab: { project: async () => GL_PROJECT } as unknown as GitLabClient,
    creds: { gitlabUrl: "https://git", gitlabToken: "t", accessToken: "", source: "direct-token" } as GitLabCredentials,
    pacer: new Pacer({ eventsPerSec: 1e9, chunkStart: 500, chunkMin: 50, chunkMax: 2500 }),
    log: () => {},
    digest: new Digest(),
    stages,
  }
  return { scheduler: new Scheduler(ctx), calls, ctx }
}

describe("Scheduler.runOnce", () => {
  it("walks a job detected → fetched → planned → done", async () => {
    const job = db.enqueue(PROJECT.gitlab_id, "content", "abc")
    const { scheduler, calls } = makeScheduler({})
    await scheduler.runOnce({})
    expect(calls).toMatchObject({ checkouts: 1, pushes: 1 })
    expect(db.getJob(job.id)?.stage).toBe("done")
    expect(scheduler.stageLog).toEqual(["fetched", "planned", "done"])
  })

  it("leaves the job at planned in dry-run and never advances it to done", async () => {
    const job = db.enqueue(PROJECT.gitlab_id, "content", "abc")
    const { scheduler, calls } = makeScheduler({ config: { dryRun: true } })
    await scheduler.runOnce({})
    expect(calls.pushes).toBe(1)
    const row = db.getJob(job.id)
    expect(row?.stage).toBe("planned")
    expect(row?.plan_path).toBe(planFor(job.id).planPath)
  })

  it("fails the job with backoff when a stage throws", async () => {
    const job = db.enqueue(PROJECT.gitlab_id, "content", "abc")
    const { scheduler, ctx } = makeScheduler({ materializeThrows: true })
    const t0 = Date.now()
    await scheduler.runOnce({})
    const row = db.getJob(job.id)!
    expect(row.stage).toBe("detected")
    expect(row.attempts).toBe(1)
    expect(row.error).toMatch(/boom/)
    expect(row.next_run_at).toBeGreaterThan(t0)
    expect(ctx.digest.failed).toBe(1)
  })

  it("sends an unverified push back to fetched and re-materializes with force", async () => {
    const job = db.enqueue(PROJECT.gitlab_id, "content", "abc")
    const { scheduler, calls } = makeScheduler({
      push: { pushed: 0, finalized: false, settingsUpdated: false, verified: false, reseeded: true },
    })
    await scheduler.runOnce({})
    expect(calls.materializes.length).toBeGreaterThanOrEqual(2)
    expect(calls.materializes[1]).toEqual({ force: true })
    // The forced re-materialize still failed to verify: the job fails with backoff
    // rather than spinning between fetched and planned forever.
    const row = db.getJob(job.id)!
    expect(row.stage).toBe("detected")
    expect(row.error).toMatch(/verify/i)
  })

  it("re-enqueues with the newer sha when the checkout moved ahead", async () => {
    const job = db.enqueue(PROJECT.gitlab_id, "content", "abc")
    const { scheduler } = makeScheduler({ checkoutSha: "def" })
    await scheduler.runOnce({})
    expect(db.getJob(job.id)?.sha).toBe("def")
  })
})

describe("Scheduler.runForever", () => {
  // Regression for the SIGINT/SIGTERM graceful-stop bug: abort must not tear
  // down a stage that is mid-flight. `runForever` should only resolve once
  // the in-flight `pushJob` call has actually finished.
  it("waits for an in-flight push to finish before resolving on abort", async () => {
    const job = db.enqueue(PROJECT.gitlab_id, "content", "abc")
    let releasePush: () => void = () => {}
    const pushGate = new Promise<void>((resolve) => { releasePush = resolve })
    let pushStarted: () => void = () => {}
    const pushStartedGate = new Promise<void>((resolve) => { pushStarted = resolve })
    let pushCalls = 0
    const config = loadConfig(ENV, { home: root })
    const stages: StageFns = {
      ensureCheckout: async (_deps, p) => ({ dir: path.join(root, "clones", String(p.gitlabId)), sha: p.wantSha, recloned: false }),
      materialize: async (_deps, input) => planFor(input.job.id),
      pushJob: async (deps, input) => {
        pushCalls++
        pushStarted()
        await pushGate
        deps.db.advance(input.job.id, "done")
        return { pushed: 1, finalized: true, settingsUpdated: false, verified: true, reseeded: false }
      },
    }
    const ctx: SchedulerCtx = {
      config,
      db,
      sync: {} as SyncClient,
      gitlab: { project: async () => GL_PROJECT } as unknown as GitLabClient,
      creds: { gitlabUrl: "https://git", gitlabToken: "t", accessToken: "", source: "direct-token" } as GitLabCredentials,
      pacer: new Pacer({ eventsPerSec: 1e9, chunkStart: 500, chunkMin: 50, chunkMax: 2500 }),
      log: () => {},
      digest: new Digest(),
      stages,
    }
    const scheduler = new Scheduler(ctx)
    const ac = new AbortController()

    let resolved = false
    const done = scheduler.runForever(ac.signal).then(() => { resolved = true })

    await pushStartedGate
    ac.abort()
    // Give the (now-aborted) loop a chance to spin if it were (wrongly) not
    // waiting on the in-flight stage.
    await new Promise((r) => setTimeout(r, 20))
    expect(resolved).toBe(false)
    expect(pushCalls).toBe(1)

    releasePush()
    await done
    expect(resolved).toBe(true)
    // No further claims happened after abort — the in-flight push is the only call.
    expect(pushCalls).toBe(1)
    expect(db.getJob(job.id)?.stage).toBe("done")
  })
})
