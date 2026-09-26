// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DaemonDb, type JobRow, type ProjectRow } from "../db"
import { PlanWriter, eventHash } from "../plan"
import { Pacer } from "../pacer"
import { HttpError, type SyncClient } from "../http"
import { pushJob, type PushDeps } from "../stages/push"
import type { MaterializeResult } from "../stages/materialize"
import type { IngestEvent } from "../../../src/lib/migrate/types"

let root: string
let db: DaemonDb
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "push-"))
  db = new DaemonDb(":memory:")
  db.upsertProject(PROJECT)
  db.enqueue(PROJECT.gitlab_id, "content", JOB.sha)
})
afterEach(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

const PROJECT: ProjectRow = {
  gitlab_id: 7, aquilla_id: "proj-7", name: "Seven", namespace: "ns/seven",
  org_id: 3, team_id: 4, owner_user_id: 5, last_activity_at: "2026-01-01T00:00:00Z",
  head_sha: "abc", applied_sha: null, audio_applied_sha: null, content_logic: 0, cast_hash: null,
  status: "ok", last_error: null, project_upserted: 1, updated_at: 0,
}
const JOB: JobRow = {
  id: 1, project_id: 7, kind: "content", sha: "abc", stage: "pushing", attempts: 0,
  next_run_at: 0, created_at: 0, updated_at: 0, error: null, plan_path: null,
}

function event(id: string, fileId?: string): IngestEvent {
  return {
    id, kind: "source.cell.create", author: "legacy-import", clientTs: 1, payload: { id },
    ...(fileId !== undefined ? { fileId } : {}),
  }
}

async function writePlan(name: string, ids: string[], prereq: string[] = []): Promise<string> {
  const w = new PlanWriter(path.join(root, name))
  for (const id of prereq) w.write({ id, event: event(id), prerequisite: true, hash: eventHash(event(id)) })
  for (const id of ids) w.write({ id, event: event(id), hash: eventHash(event(id)) })
  await w.close()
  return w.file
}

/** Plan whose lines carry explicit fileIds — AQU-557's finalize scope is built
 *  from them. `null` stands for a project-level event with no file. */
async function writePlanWithFiles(
  name: string,
  entries: Array<[id: string, fileId: string | null]>,
): Promise<string> {
  const w = new PlanWriter(path.join(root, name))
  for (const [id, fileId] of entries) {
    const e = event(id, fileId ?? undefined)
    w.write({ id, event: e, hash: eventHash(e) })
  }
  await w.close()
  return w.file
}

function plan(planPath: string, over: Partial<MaterializeResult> = {}): MaterializeResult {
  return {
    planPath, lines: 0, files: 1, changedFiles: 1, castHash: "cast-0",
    speakers: [], fileHashes: [{ path: "files/target/a.codex", hash: "h1" }], idml: [],
    ...over,
  }
}

interface Calls {
  ingest: string[][]
  finalize: number
  /** AQU-557: the file scope each finalize was given, in call order. */
  finalizeFileIds: string[][]
  settings: number
  upsert: number
  eventCount: number
}
function fakeSync(opts: {
  count?: number | (() => number)
  ingest?: (events: IngestEvent[], n: number) => void
  ids?: string[][]
} = {}): { sync: SyncClient; calls: Calls } {
  const calls: Calls = { ingest: [], finalize: 0, finalizeFileIds: [], settings: 0, upsert: 0, eventCount: 0 }
  let n = 0
  const impl = {
    upsertProject: async () => { calls.upsert++ },
    ingest: async (_projectId: string, events: IngestEvent[]) => {
      n++
      opts.ingest?.(events, n)
      calls.ingest.push(events.map((e) => e.id))
      return { status: 200, ms: 10, accepted: events.length }
    },
    finalize: async (_projectId: string, fileIds: string[] = []) => {
      calls.finalize++
      calls.finalizeFileIds.push(fileIds)
    },
    getSettings: async () => ({}),
    postSettings: async () => { calls.settings++ },
    eventCount: async () => {
      calls.eventCount++
      const c = opts.count
      return typeof c === "function" ? c() : c ?? calls.ingest.flat().length
    },
    eventIds: async function* () { for (const page of opts.ids ?? []) yield page },
  }
  return { sync: impl as unknown as SyncClient, calls }
}

function deps(sync: SyncClient, over: Partial<PushDeps> = {}): PushDeps {
  return {
    db, sync,
    pacer: new Pacer({ eventsPerSec: 1e9, chunkStart: 2, chunkMin: 2, chunkMax: 2, sleep: async () => {} }),
    dryRun: false, syncBase: "http://sync.test", syncSecret: "s", log: () => {},
    ...over,
  }
}

describe("pushJob", () => {
  it("ledgers ids only after a 2xx and keeps chunk 1 when chunk 2 throws", async () => {
    const planPath = await writePlan("a.ndjson", ["e1", "e2", "e3", "e4"])
    const { sync } = fakeSync({
      ingest: (_e, n) => { if (n === 2) throw new HttpError(503, "overloaded", true) },
    })
    const d = deps(sync)
    await expect(pushJob(d, { job: JOB, project: PROJECT, plan: plan(planPath) })).rejects.toThrow(HttpError)
    expect(db.ledgerCount(7)).toBe(2)
    expect(db.ledgerHas(7, "e1")).toBe(true)
    expect(db.ledgerHas(7, "e3")).toBe(false)
    // A failed push must not mark the job done or record the sha.
    expect(db.getProject(7)?.applied_sha).toBe(null)
    expect(d.pacer.snapshot().consecutiveFail).toBe(1)
  })

  it("pushes prerequisite lines first and warns when an IDML original is missing", async () => {
    const planPath = await writePlan("b.ndjson", ["e1", "e2"], ["p1"])
    const { sync, calls } = fakeSync()
    const logs: string[] = []
    const d = deps(sync, { log: (m) => logs.push(m) })
    const r = await pushJob(d, {
      job: JOB, project: PROJECT,
      plan: plan(planPath, { idml: [{ relPath: "a.idml", fileId: "f1", original: undefined }] }),
    })
    expect(calls.ingest[0]).toEqual(["p1"])
    expect(calls.ingest.slice(1).flat()).toEqual(["e1", "e2"])
    expect(r.pushed).toBe(3)
    expect(r.verified).toBe(true)
    expect(logs.some((m) => m.includes("a.idml"))).toBe(true)
  })

  it("scopes finalize to the files the push actually touched", async () => {
    // AQU-557: finalize used to recompute every file in the project on every
    // push. A push that landed events in two files must ask for those two,
    // not for the whole project.
    const planPath = await writePlanWithFiles("scope.ndjson", [
      ["e1", "f-gen"], ["e2", "f-gen"], ["e3", "f-exo"], ["e4", null],
    ])
    const { sync, calls } = fakeSync()
    const r = await pushJob(deps(sync), { job: JOB, project: PROJECT, plan: plan(planPath) })
    expect(r.finalized).toBe(true)
    expect(calls.finalize).toBe(1)
    // Deduplicated, and a project-level event with no fileId contributes none.
    expect([...calls.finalizeFileIds[0]].sort()).toEqual(["f-exo", "f-gen"])
  })

  it("keeps the finalize scope a strict prefix of what prod acked when a chunk fails", async () => {
    // Same write-after-ack contract as the ledger: a chunk that threw must not
    // put its file into the scope, or finalize would claim to have repaired a
    // file whose events never landed.
    const planPath = await writePlanWithFiles("scope-fail.ndjson", [
      ["e1", "f-gen"], ["e2", "f-gen"], ["e3", "f-exo"], ["e4", "f-exo"],
    ])
    const { sync, calls } = fakeSync({
      ingest: (_e, n) => { if (n === 2) throw new HttpError(503, "overloaded", true) },
    })
    await expect(pushJob(deps(sync), { job: JOB, project: PROJECT, plan: plan(planPath) }))
      .rejects.toThrow(HttpError)
    // The failed push never reaches finalize at all …
    expect(calls.finalize).toBe(0)
    // … and only chunk 1's events are ledgered, so the retry re-plans f-exo.
    expect(db.ledgerCount(7)).toBe(2)
    expect(db.ledgerHas(7, "e3")).toBe(false)
  })

  it("skips finalize on an empty plan and skips settings when the cast hash is unchanged", async () => {
    const planPath = await writePlan("c.ndjson", [])
    const { sync, calls } = fakeSync({ count: 0 })
    const r = await pushJob(deps(sync), {
      job: JOB,
      project: { ...PROJECT, cast_hash: "cast-0" },
      plan: plan(planPath, { speakers: [{ cellId: "c1", speaker: "Mary" }] }),
    })
    expect(calls.finalize).toBe(0)
    expect(calls.settings).toBe(0)
    expect(r).toEqual({ pushed: 0, finalized: false, settingsUpdated: false, verified: true, reseeded: false })
    expect(db.getJob(1)?.stage).toBe("done")
    expect(db.getProject(7)?.applied_sha).toBe("abc")
  })

  it("reseeds the ledger and reports unverified when prod holds FEWER events than the ledger", async () => {
    // Only a deficit is drift: prod is missing events the ledger says landed.
    const planPath = await writePlan("d.ndjson", ["e1", "e2"])
    const { sync, calls } = fakeSync({ count: 1, ids: [["x1", "x2"], ["x3"]] })
    const r = await pushJob(deps(sync), { job: JOB, project: PROJECT, plan: plan(planPath) })
    expect(calls.eventCount).toBe(1)
    expect(r.reseeded).toBe(true)
    expect(r.verified).toBe(false)
    expect(db.ledgerCount(7)).toBe(3)
    expect(db.ledgerHas(7, "x3")).toBe(true)
    // Not done: main.ts re-enqueues with force.
    expect(db.getJob(1)?.stage).not.toBe("done")
    expect(db.getProject(7)?.applied_sha).toBe(null)
    expect(db.fileHash(7, "files/target/a.codex")).toBe(undefined)
  })

  it("verifies when prod holds MORE events than the ledger (human-authored writes)", async () => {
    // `eventCount` counts every event in the project, including edits people
    // made in the app. A surplus must not be read as drift and trigger a reseed.
    const planPath = await writePlan("d2.ndjson", ["e1", "e2"])
    const { sync, calls } = fakeSync({ count: 9, ids: [["x1"]] })
    const r = await pushJob(deps(sync), { job: JOB, project: PROJECT, plan: plan(planPath) })
    expect(r.verified).toBe(true)
    expect(r.reseeded).toBe(false)
    expect(calls.eventCount).toBe(1)
    expect(db.ledgerCount(7)).toBe(2)
    expect(db.getJob(1)?.stage).toBe("done")
  })

  it("makes no write calls in dry-run", async () => {
    const planPath = await writePlan("e.ndjson", ["e1", "e2", "e3"])
    const { sync, calls } = fakeSync()
    const logs: string[] = []
    const r = await pushJob(deps(sync, { dryRun: true, log: (m) => logs.push(m) }), {
      job: JOB,
      project: { ...PROJECT, project_upserted: 0 },
      plan: plan(planPath, { speakers: [{ cellId: "c1", speaker: "Mary" }] }),
    })
    expect(calls).toMatchObject({ ingest: [], finalize: 0, settings: 0, upsert: 0 })
    expect(r).toEqual({ pushed: 3, finalized: false, settingsUpdated: false, verified: true, reseeded: false })
    expect(db.ledgerCount(7)).toBe(0)
    expect(db.getJob(1)?.stage).not.toBe("done")
    expect(logs.join("\n")).toContain("would push 3 events")
  })

  it("upserts the project once and posts merged cast settings when the hash changed", async () => {
    const planPath = await writePlan("f.ndjson", ["e1"])
    const { sync, calls } = fakeSync()
    const r = await pushJob(deps(sync), {
      job: JOB,
      project: { ...PROJECT, project_upserted: 0 },
      plan: plan(planPath, { castHash: "cast-1", speakers: [{ cellId: "c1", speaker: "Mary" }] }),
    })
    expect(calls.upsert).toBe(1)
    expect(calls.settings).toBe(1)
    expect(calls.finalize).toBe(1)
    expect(r.settingsUpdated).toBe(true)
    expect(r.finalized).toBe(true)
    expect(db.getProject(7)?.cast_hash).toBe("cast-1")
    expect(db.getProject(7)?.project_upserted).toBe(1)
  })
})
