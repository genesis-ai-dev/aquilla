// Contextual poll endpoints served from the isolate read cache
// (lib/contextual/read-cache.ts). WHY: the SPA polls overview / snapshot /
// activity every 4s while a run works; before this each poll ran 7-11 queries
// plus a full-project cells self-join. These tests pin (1) a repeat poll costs
// only the role gate, (2) an unchanged poll with If-None-Match is a bodiless
// 304, (3) every same-isolate writer — the live-frame funnel and the two
// frame-less routes (review, steering) — invalidates before it answers, and
// (4) the readiness self-join is off the hot path.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import app from "../index"
import { _test } from "../routes/contextual"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import {
  createRun,
  insertDrafts,
  parkRun,
} from "../../../db/shared/contextual-runs"
import { notifySyncWorkerOfContextualActivity } from "../services/sync-worker-notify"
import {
  CONTEXTUAL_READ_TTL_MS,
  CONTEXTUAL_READINESS_TTL_MS,
  clearContextualReadCache,
  getCachedContextualRead,
  getCachedContextualReadiness,
  invalidateContextualReads,
} from "../lib/contextual/read-cache"

const PROJECT = "proj-ctx-cache"
const FILE = "file-cache"

const realFetch = globalThis.fetch

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes("/admin/projects/")) return new Response("{}", { status: 200 })
    throw new Error(`unexpected fetch in read-cache test: ${url}`)
  })
})

afterEach(async () => {
  if (_test.lastLoop) await _test.lastLoop
  _test.lastLoop = null
  vi.stubGlobal("fetch", realFetch)
})

async function seedWorld(): Promise<{ contrib: string; viewer: string }> {
  await seedUser(1, "contrib")
  await seedUser(2, "viewer")
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)")
    .bind(PROJECT, "Contextual read cache", 1)
    .run()
  for (const [userId, role] of [[1, 400], [2, 100]] as const) {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, 1)",
    ).bind(PROJECT, userId, role).run()
  }
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
     VALUES (?, ?, 'c1', 'source', 'In the beginning', 'MRK 1:1', 'ev-c1', 0)`,
  ).bind(PROJECT, FILE).run()
  return { contrib: await jwtFor("contrib"), viewer: await jwtFor("viewer") }
}

function get(path: string, jwt: string, extra: Record<string, string> = {}) {
  return app.request(
    `/api/v2/projects/${PROJECT}/contextual${path}`,
    { method: "GET", headers: { ...authHeader(jwt), ...extra } },
    env,
  )
}

function post(path: string, jwt: string, body: unknown) {
  return app.request(
    `/api/v2/projects/${PROJECT}/contextual${path}`,
    { method: "POST", headers: authHeader(jwt), body: JSON.stringify(body) },
    env,
  )
}

/** Count `prepare` calls on the shared db during `fn`. */
async function countQueries(fn: () => Promise<unknown>): Promise<number> {
  const spy = vi.spyOn(env.AQUILLA_PG, "prepare")
  try {
    await fn()
    return spy.mock.calls.length
  } finally {
    spy.mockRestore()
  }
}

async function seedParkedRunWithDraft(): Promise<string> {
  const created = await createRun(env.AQUILLA_PG, { projectId: PROJECT, fileId: FILE })
  if (created.status !== "ok") throw new Error("run not created")
  await insertDrafts(env.AQUILLA_PG, {
    runId: created.run.id,
    projectId: PROJECT,
    fileId: FILE,
    drafts: [{ cellId: "c1", text: "Au commencement" }],
  })
  await parkRun(env.AQUILLA_PG, created.run.id)
  return created.run.id
}

describe("read-cache unit", () => {
  it("serves within TTL, recomputes after it, and refuses to store a body computed before a write", async () => {
    let calls = 0
    const compute = async () => ({ n: ++calls })
    const t0 = 1_000_000
    const first = await getCachedContextualRead("p", "overview", compute, t0)
    const hit = await getCachedContextualRead("p", "overview", compute, t0 + CONTEXTUAL_READ_TTL_MS - 1)
    expect(hit).toBe(first)
    expect(calls).toBe(1)
    const expired = await getCachedContextualRead("p", "overview", compute, t0 + CONTEXTUAL_READ_TTL_MS)
    expect(expired.body).toBe('{"n":2}')
    expect(expired.etag).not.toBe(first.etag)

    // A read that started before a write must not land its stale body.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const slow = getCachedContextualRead("q", "overview", async () => { await gate; return { stale: true } }, t0)
    invalidateContextualReads("q")
    release()
    await slow
    const after = await getCachedContextualRead("q", "overview", async () => ({ fresh: true }), t0 + 1)
    expect(after.body).toBe('{"fresh":true}')

    // Readiness has its own, longer clock.
    let readinessCalls = 0
    const rc = async () => ({ validated: ++readinessCalls })
    await getCachedContextualReadiness("p", rc, t0)
    invalidateContextualReads("p")
    await getCachedContextualReadiness("p", rc, t0 + CONTEXTUAL_READ_TTL_MS + 1)
    expect(readinessCalls).toBe(1)
    await getCachedContextualReadiness("p", rc, t0 + CONTEXTUAL_READINESS_TTL_MS)
    expect(readinessCalls).toBe(2)
    clearContextualReadCache()
  })
})

describe("GET /contextual/overview|runs|activity through the cache", () => {
  it("a repeat poll costs only the role gate and answers 304 to a matching If-None-Match", async () => {
    const { viewer } = await seedWorld()
    const runId = await seedParkedRunWithDraft()

    const paths = ["/overview", `/runs?fileId=${FILE}`, `/runs/${runId}/activity`]
    for (const path of paths) {
      let etag = ""
      const cold = await countQueries(async () => {
        const res = await get(path, viewer)
        expect(res.status).toBe(200)
        etag = res.headers.get("ETag") ?? ""
        expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/)
        expect(res.headers.get("Cache-Control")).toBe("no-store")
      })
      const warm = await countQueries(async () => {
        const res = await get(path, viewer)
        expect(res.status).toBe(200)
        expect(res.headers.get("ETag")).toBe(etag)
      })
      const conditional = await countQueries(async () => {
        const res = await get(path, viewer, { "If-None-Match": etag })
        expect(res.status).toBe(304)
        expect(res.headers.get("ETag")).toBe(etag)
        expect(await res.text()).toBe("")
      })
      // Cold: the route's own reads plus the gate. Warm/304: the gate only —
      // the `projects` row plus the direct + group membership paths (session
      // cache absorbs auth) — and, for activity, the project-scoping `getRun`
      // that guards the 404.
      const gateOnly = path.includes("/activity") ? 4 : 3
      expect({ path, cold, warm, conditional }).toEqual({
        path,
        cold: expect.any(Number),
        warm: gateOnly,
        conditional: gateOnly,
      })
      expect(cold).toBeGreaterThan(gateOnly + 3)
    }
  })

  it("keeps the readiness cells self-join off the poll hot path", async () => {
    const { viewer } = await seedWorld()
    const selfJoin = (sql: unknown) => typeof sql === "string" && sql.includes("LEFT JOIN cells t")
    const spy = vi.spyOn(env.AQUILLA_PG, "prepare")
    try {
      await get("/overview", viewer)
      expect(spy.mock.calls.filter(([sql]) => selfJoin(sql))).toHaveLength(1)
      // A write invalidates the overview body; the readiness counts stay cached.
      invalidateContextualReads(PROJECT)
      const res = await get("/overview", viewer)
      expect(res.status).toBe(200)
      expect(spy.mock.calls.filter(([sql]) => selfJoin(sql))).toHaveLength(1)
      const body = await res.json() as { readiness?: { validatedExamples?: number } }
      expect(body.readiness).toBeDefined()
    } finally {
      spy.mockRestore()
    }
  })

  it("the live-frame funnel and the frame-less writers (review, steering) refresh the next poll", async () => {
    const { contrib, viewer } = await seedWorld()
    const runId = await seedParkedRunWithDraft()

    const overview = async () => (await (await get("/overview", viewer)).json()) as {
      proposedDrafts: number; appliedDrafts: number
    }
    const snapshot = async () => (await (await get(`/runs?fileId=${FILE}`, viewer)).json()) as {
      activeDirections: string[]
    }
    const activityKinds = async () => ((await (await get(`/runs/${runId}/activity`, viewer)).json()) as {
      events: { kind: string }[]
    }).events.map((e) => e.kind)

    expect(await overview()).toMatchObject({ proposedDrafts: 1, appliedDrafts: 0 })
    expect(await snapshot()).toMatchObject({ activeDirections: [] })
    expect(await activityKinds()).not.toContain("steering_queued")

    // 1. Steering (no frame unless it wakes the run — here it does wake the
    //    parked run, but the invalidation is unconditional either way).
    const steer = await post("/steering", contrib, { fileId: FILE, kind: "direction", body: "Keep it formal" })
    expect(steer.status).toBe(201)
    if (_test.lastLoop) await _test.lastLoop
    _test.lastLoop = null
    expect(await activityKinds()).toContain("steering_queued")

    // 2. Review: the draft flips to applied with no live frame at all.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_edit_at)
       VALUES (?, ?, 'c1', 'target', '', 'Au commencement', 'ev-review-c1', 0)`,
    ).bind(PROJECT, FILE).run()
    const { drafts } = (await (await get(`/drafts?fileId=${FILE}`, viewer)).json()) as { drafts: { id: string }[] }
    const review = await post(`/drafts/${drafts[0].id}/review`, contrib, { action: "applied" })
    expect(review.status).toBe(200)
    expect(await overview()).toMatchObject({ proposedDrafts: 0, appliedDrafts: 1 })
    expect(await activityKinds()).toContain("draft_reviewed")

    // 3. The live-frame funnel every tick/control writer goes through.
    await insertDrafts(env.AQUILLA_PG, {
      runId,
      projectId: PROJECT,
      fileId: FILE,
      drafts: [{ cellId: "c2", text: "second" }],
    })
    expect((await overview()).proposedDrafts).toBe(0) // still cached: direct DB write, no funnel
    await notifySyncWorkerOfContextualActivity(env, PROJECT, { type: "contextual.run.state" })
    expect((await overview()).proposedDrafts).toBe(1)
  })
})
