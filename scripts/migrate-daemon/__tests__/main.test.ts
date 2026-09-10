// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs, withLock, type ProcLike } from "../main"
import { Scheduler, type SchedulerCtx, type StageFns } from "../loop"
import { Digest } from "../notify"
import { DaemonDb, type ProjectRow } from "../db"
import { loadConfig, type DaemonConfig } from "../config"
import { Pacer } from "../pacer"
import type { GitLabClient, GitLabProjectLite, SyncClient } from "../http"
import type { GitLabCredentials } from "../../../src/lib/migrate/gitlab/auth"
import type { MaterializeResult } from "../stages/materialize"
import type { PushResult } from "../stages/push"
import type { RunLock } from "../../../src/lib/migrate/run-lock"

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

/** Mirrors the real `plans/<gitlabId>/<sha>.ndjson` layout and actually writes
 *  the file, so a test can assert the scheduler deletes it on `done`. */
function planFor(jobId: number, sha = "abc"): MaterializeResult {
  const planPath = path.join(root, "plans", String(PROJECT.gitlab_id), `${sha}.ndjson`)
  fs.mkdirSync(path.dirname(planPath), { recursive: true })
  fs.writeFileSync(planPath, "")
  void jobId
  return {
    planPath, lines: 2, files: 1, changedFiles: 1,
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
      return planFor(input.job.id, input.job.sha)
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

  it("deletes the plan file once the job reaches done", async () => {
    db.enqueue(PROJECT.gitlab_id, "content", "abc")
    const { scheduler } = makeScheduler({})
    await scheduler.runOnce({})
    expect(fs.existsSync(path.join(root, "plans", "7", "abc.ndjson"))).toBe(false)
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

/** `weeklyReseed` is private; the scheduler's own tick calls it. Reaching it
 *  directly keeps the test about reseed semantics rather than loop timing. */
interface ReseedAccess { weeklyReseed(): Promise<void> }

function reseedScheduler(over: { fail?: Set<number>; discord?: string } = {}) {
  const config = loadConfig(ENV, { home: root, discordWebhookUrl: over.discord })
  const pages: string[][] = [["a"], ["b"], ["c"]]
  const sync = {
    eventIds: async function* (_projectId: string, onPage?: () => Promise<void>) {
      for (const page of pages) { if (onPage) await onPage(); yield page }
    },
  } as unknown as SyncClient
  const paced = { n: 0 }
  const ctx: SchedulerCtx = {
    config, db, sync,
    gitlab: { project: async () => GL_PROJECT } as unknown as GitLabClient,
    creds: {} as GitLabCredentials,
    pacer: { acquire: async () => { paced.n++ }, paused: false, chunkSize: 1, record: () => {}, snapshot: () => ({}) } as unknown as Pacer,
    log: () => {},
    digest: new Digest(),
    stages: {},
  }
  const scheduler = new Scheduler(ctx)
  const orig = ctx.sync.eventIds.bind(ctx.sync)
  if (over.fail) {
    // Fail per project by aquilla_id.
    ctx.sync.eventIds = ((projectId: string, onPage?: () => Promise<void>) => {
      const gid = Number(projectId.replace("proj-", ""))
      if (over.fail!.has(gid)) {
        return (async function* () {
          if (gid) throw new Error(`boom ${gid}`)
          yield []
        })()
      }
      return orig(projectId, onPage)
    }) as SyncClient["eventIds"]
  }
  return { scheduler: scheduler as unknown as ReseedAccess, paced }
}

describe("Scheduler.weeklyReseed", () => {
  const project = (gitlabId: number): void => {
    db.upsertProject({ ...PROJECT, gitlab_id: gitlabId, aquilla_id: `proj-${gitlabId}`, applied_sha: "abc" })
  }

  it("paces per page, marks the pass done, and force-re-materializes each project", async () => {
    project(7)
    const { scheduler, paced } = reseedScheduler()
    await scheduler.weeklyReseed()
    expect(paced.n).toBe(3) // one acquire per page, not one per project
    expect(db.kvGet("reseed_done:7")).toBe("0")
    expect(db.kvGet("last_full_reseed")).toBeDefined()
    expect(db.kvGet("reseed_failed_ids")).toBe("[]")
    expect(db.listJobs("detected").map((j) => j.project_id)).toContain(7)
  })

  it("skips projects already reseeded in this pass on a restart", async () => {
    project(7)
    const first = reseedScheduler()
    await first.scheduler.weeklyReseed()
    db.kvSet("last_full_reseed", "0") // pretend the pass was interrupted before it finished
    const second = reseedScheduler()
    await second.scheduler.weeklyReseed()
    expect(second.paced.n).toBe(0)
  })

  it("continues past a failing project, records it, and holds off re-entry for an hour", async () => {
    project(7)
    project(8)
    const { scheduler } = reseedScheduler({ fail: new Set([7]) })
    await scheduler.weeklyReseed()
    expect(JSON.parse(db.kvGet("reseed_failed_ids") ?? "[]")).toEqual([7])
    expect(db.getProject(7)?.last_error).toMatch(/reseed failed/)
    expect(db.kvGet("reseed_done:8")).toBe("0") // the pass carried on
    expect(Number(db.kvGet("reseed_next_attempt"))).toBeGreaterThan(Date.now() + 59 * 60_000)
  })

  it("does not re-enter while the last pass is inside the weekly interval", async () => {
    project(7)
    db.kvSet("last_full_reseed", String(Date.now()))
    const { scheduler, paced } = reseedScheduler()
    await scheduler.weeklyReseed()
    expect(paced.n).toBe(0)
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
      materialize: async (_deps, input) => planFor(input.job.id, input.job.sha),
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

describe("withLock", () => {
  function fakeLock(): RunLock & { acquire: ReturnType<typeof vi.fn>; heartbeat: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } {
    return {
      acquire: vi.fn(async () => {}),
      heartbeat: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    } as unknown as RunLock & { acquire: ReturnType<typeof vi.fn>; heartbeat: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }
  }

  function fakeProc(): ProcLike & { handlers: Map<NodeJS.Signals, (sig: NodeJS.Signals) => void>; exit: ReturnType<typeof vi.fn> } {
    const handlers = new Map<NodeJS.Signals, (sig: NodeJS.Signals) => void>()
    return {
      handlers,
      on: vi.fn((event: NodeJS.Signals, listener: (sig: NodeJS.Signals) => void) => { handlers.set(event, listener) }),
      off: vi.fn((event: NodeJS.Signals) => { handlers.delete(event) }),
      exit: vi.fn(() => undefined as never),
    }
  }

  it("drains on signal, releases the lock exactly once, then exits 130", async () => {
    const lock = fakeLock()
    const proc = fakeProc()
    let resolveDrain: () => void = () => {}
    const drainGate = new Promise<void>((resolve) => { resolveDrain = resolve })

    let signalSeen = false
    const done = withLock(
      loadConfig(ENV, { home: root }),
      async () => { await drainGate },
      { lock, proc, onSignal: () => { signalSeen = true } },
    )

    await new Promise((r) => setTimeout(r, 0))
    const sigint = proc.handlers.get("SIGINT")
    expect(sigint).toBeDefined()
    sigint!("SIGINT")

    // Signal received (onSignal invoked), but the drain (fn) hasn't resolved yet — no release/exit yet.
    await new Promise((r) => setTimeout(r, 10))
    expect(signalSeen).toBe(true)
    expect(lock.release).not.toHaveBeenCalled()
    expect(proc.exit).not.toHaveBeenCalled()

    resolveDrain()
    await done
    expect(lock.release).toHaveBeenCalledTimes(1)
    expect(proc.exit).not.toHaveBeenCalled() // no signal-triggered hard exit path here; fn returned normally
  })

  it("second signal during drain hard-exits immediately, release called at most once", async () => {
    const lock = fakeLock()
    const proc = fakeProc()
    let resolveDrain: () => void = () => {}
    const drainGate = new Promise<void>((resolve) => { resolveDrain = resolve })

    void withLock(
      loadConfig(ENV, { home: root }),
      async () => { await drainGate },
      { lock, proc, onSignal: () => {} },
    )

    await new Promise((r) => setTimeout(r, 0))
    const sigint = proc.handlers.get("SIGINT")!
    sigint("SIGINT") // first signal -> starts draining, onSignal is a no-op so drainGate never resolves on its own
    await new Promise((r) => setTimeout(r, 5))
    sigint("SIGINT") // second signal -> hard exit

    await new Promise((r) => setTimeout(r, 10))
    expect(proc.exit).toHaveBeenCalledWith(130)
    expect(lock.release).toHaveBeenCalledTimes(1)

    resolveDrain()
  })

  it("normal completion releases the lock exactly once, removes handlers, and never exits", async () => {
    const lock = fakeLock()
    const proc = fakeProc()

    await withLock(loadConfig(ENV, { home: root }), async () => {}, { lock, proc })

    expect(lock.release).toHaveBeenCalledTimes(1)
    expect(proc.off).toHaveBeenCalledWith("SIGINT", expect.any(Function))
    expect(proc.off).toHaveBeenCalledWith("SIGTERM", expect.any(Function))
    expect(proc.exit).not.toHaveBeenCalled()
  })

  it("keeps heartbeating the lock while draining", async () => {
    vi.useFakeTimers()
    try {
      const lock = fakeLock()
      const proc = fakeProc()
      let resolveDrain: () => void = () => {}
      const drainGate = new Promise<void>((resolve) => { resolveDrain = resolve })

      const done = withLock(loadConfig(ENV, { home: root }), async () => { await drainGate }, { lock, proc })

      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(lock.heartbeat).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(lock.heartbeat).toHaveBeenCalledTimes(2)

      resolveDrain()
      await done
    } finally {
      vi.useRealTimers()
    }
  })
})
