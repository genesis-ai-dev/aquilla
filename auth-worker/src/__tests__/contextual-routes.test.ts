// Contextual run-control routes (routes/contextual.ts, design §8 slice D1).
// WHY: the HTTP surface is where the role floors and the run's control
// contract face the client — each test pins a gate (CONTRIBUTOR to start /
// steer / review, VIEWER to read), a guarded transition surfaced as 409, the
// snapshot shape the pill hydrates from, and the steering wake-up of a parked
// run. The kicked tick loop runs for real against a stubbed global fetch
// (mock OpenRouter answers via scripts/mock-openrouter.ts; sync-worker
// notifications are swallowed) and is awaited via the _test seam before
// asserting.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import app from "../index"
import { _test } from "../routes/contextual"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { getRun, listDrafts } from "../../../db/shared/contextual-runs"
import { scriptMockResponse } from "../../../scripts/mock-openrouter"

const PROJECT = "proj-ctx-routes"
const FILE = "file-mrk"
const MOCK_BASE = "http://mock.local/api/v1"

// The test env object is shared per-file; add the OpenRouter mock wiring the
// contextual routes read (kept for the whole file — beforeEach re-asserts).
const testEnv = env as typeof env & {
  OPENROUTER_BASE_URL?: string
  CONTEXTUAL_FAST_MODEL?: string
  CONTEXTUAL_DEEP_MODEL?: string
}

const realFetch = globalThis.fetch
let syncFrames: { url: string; frame: Record<string, unknown> }[] = []

beforeEach(() => {
  testEnv.OPENROUTER_API_KEY = "mock"
  testEnv.OPENROUTER_BASE_URL = MOCK_BASE
  syncFrames = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === `${MOCK_BASE}/chat/completions`) {
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
      return new Response(JSON.stringify(scriptMockResponse(body.messages)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (url.includes("/admin/projects/")) {
      // Sync-worker progress fan-out — capture the frames for shape asserts.
      syncFrames.push({ url, frame: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return new Response("{}", { status: 200 })
    }
    throw new Error(`unexpected fetch in route test: ${url}`)
  })
})

afterEach(async () => {
  // Let any kicked loop settle BEFORE the harness truncates tables.
  if (_test.lastLoop) await _test.lastLoop
  _test.lastLoop = null
  testEnv.OPENROUTER_API_KEY = undefined
  delete testEnv.OPENROUTER_BASE_URL
  vi.stubGlobal("fetch", realFetch)
})

async function seedWorld(): Promise<{ lead: string; contrib: string; viewer: string }> {
  await seedUser(1, "lead")
  await seedUser(2, "contrib")
  await seedUser(3, "viewer")
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)")
    .bind(PROJECT, "Contextual Routes", 1)
    .run()
  for (const [userId, role] of [
    [1, 500],
    [2, 400],
    [3, 100],
  ] as const) {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, 1)",
    )
      .bind(PROJECT, userId, role)
      .run()
  }
  // A tiny file so the kicked loop has real work: one chapter, two cells.
  for (const [cellId, ref, text] of [
    ["c1", "MRK 1:1", "In the beginning"],
    ["c2", "MRK 1:2", "was the word"],
  ] as const) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
       VALUES (?, ?, ?, 'source', ?, ?, ?, 0)`,
    )
      .bind(PROJECT, FILE, cellId, text, ref, `ev-${cellId}`)
      .run()
  }
  return { lead: await jwtFor("lead"), contrib: await jwtFor("contrib"), viewer: await jwtFor("viewer") }
}

async function req(method: string, path: string, jwt: string, body?: unknown) {
  return app.request(
    `/api/v2/projects/${PROJECT}/contextual${path}`,
    {
      method,
      headers: authHeader(jwt),
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  )
}

async function startRun(jwt: string): Promise<string> {
  const r = await req("POST", "/runs", jwt, { fileId: FILE })
  expect(r.status).toBe(201)
  const { runId } = (await r.json()) as { runId: string }
  if (_test.lastLoop) await _test.lastLoop // settle the kicked loop
  _test.lastLoop = null
  return runId
}

describe("POST /contextual/runs", () => {
  it("viewer → 403; contributor starts a run that ticks to parked and stages drafts", async () => {
    const { contrib, viewer } = await seedWorld()

    const denied = await req("POST", "/runs", viewer, { fileId: FILE })
    expect(denied.status).toBe(403)

    const runId = await startRun(contrib)
    const run = await getRun(env.AQUILLA_PG, runId)
    expect(run?.status).toBe("parked") // one span, processed by the kicked loop
    expect(run?.doneSpans).toBe(1)
    expect(run?.initiatedBy).toBe("contrib")

    const drafts = await listDrafts(env.AQUILLA_PG, PROJECT, FILE, "proposed")
    expect(drafts.map((d) => d.cellId).sort()).toEqual(["c1", "c2"])

    // Progress frames went to the sync-worker admin route with the design's shapes.
    const url = syncFrames[0]?.url ?? ""
    expect(url).toContain(`/admin/projects/${PROJECT}/contextual-activity`)
    const types = syncFrames.map((f) => f.frame.type)
    expect(types).toContain("contextual.run.state")
    expect(types).toContain("contextual.scene")
    expect(types).toContain("contextual.span")
    const state = syncFrames.map((f) => f.frame).find((f) => f.type === "contextual.run.state")
    expect(Object.keys(state ?? {}).sort()).toEqual(["done", "failed", "fileId", "runId", "status", "total", "type"])
  })

  it("refuses a second active run with 409 + the existing runId", async () => {
    const { contrib } = await seedWorld()
    const runId = await startRun(contrib)
    // parked is still ACTIVE — a second start on the same file/lane refuses.
    const dup = await req("POST", "/runs", contrib, { fileId: FILE })
    expect(dup.status).toBe(409)
    const body = (await dup.json()) as { error: { code: string; details: { runId: string } } }
    expect(body.error.code).toBe("run_exists")
    expect(body.error.details.runId).toBe(runId)
  })
})

describe("GET /contextual/runs snapshot", () => {
  it("viewer can hydrate: run snapshot + active directions + draft counts", async () => {
    const { contrib, viewer } = await seedWorld()
    const runId = await startRun(contrib)
    await req("POST", "/steering", contrib, { kind: "direction", body: "stay literal", fileId: "file-other" })

    const r = await req("GET", `/runs?fileId=${FILE}`, viewer)
    expect(r.status).toBe(200)
    const snap = (await r.json()) as {
      available: boolean
      run: { runId: string; status: string; done: number; total: number; failed: number } | null
      activeDirections: string[]
      draftCounts: Record<string, number>
    }
    expect(snap.available).toBe(true)
    expect(snap.run?.runId).toBe(runId)
    expect(snap.run?.status).toBe("parked")
    expect(snap.run?.done).toBe(1)
    expect(snap.run?.total).toBe(1)
    expect(snap.draftCounts.proposed).toBe(2)
    // The other-file direction is NOT in this file's snapshot.
    expect(snap.activeDirections).toEqual([])
  })
})

describe("run control transitions", () => {
  it("pause → 200 pausing; pausing a paused run → 409; resume re-runs; terminate ends it", async () => {
    const { contrib } = await seedWorld()
    const runId = await startRun(contrib)

    // Run is parked; pause only applies to running → 409 invalid_state.
    const pauseParked = await req("POST", `/runs/${runId}/pause`, contrib)
    expect(pauseParked.status).toBe(409)
    const err = (await pauseParked.json()) as { error: { code: string; details: { current: string } } }
    expect(err.error).toMatchObject({ code: "invalid_state", details: { current: "parked" } })

    // Resume from parked → running; the re-kicked loop parks it again (no new spans... it re-parks).
    const resume = await req("POST", `/runs/${runId}/resume`, contrib)
    expect(resume.status).toBe(200)
    if (_test.lastLoop) await _test.lastLoop
    _test.lastLoop = null
    expect((await getRun(env.AQUILLA_PG, runId))?.status).toBe("parked")

    const term = await req("POST", `/runs/${runId}/terminate`, contrib)
    expect(term.status).toBe(200)
    const terminated = (await term.json()) as { run: { status: string } }
    expect(terminated.run.status).toBe("terminated")

    // Terminated is terminal — resume refuses.
    expect((await req("POST", `/runs/${runId}/resume`, contrib)).status).toBe(409)
    // Unknown run / unknown action → 404.
    expect((await req("POST", `/runs/nope/pause`, contrib)).status).toBe(404)
    expect((await req("POST", `/runs/${runId}/explode`, contrib)).status).toBe(404)
  })
})

describe("POST /contextual/steering", () => {
  it("viewer → 403; contributor's steering wakes a parked run", async () => {
    const { contrib, viewer } = await seedWorld()
    const runId = await startRun(contrib)
    expect((await getRun(env.AQUILLA_PG, runId))?.status).toBe("parked")

    const denied = await req("POST", "/steering", viewer, { kind: "direction", body: "nope" })
    expect(denied.status).toBe(403)

    const r = await req("POST", "/steering", contrib, {
      kind: "direction",
      body: "prefer plain speech",
      fileId: FILE,
    })
    expect(r.status).toBe(201)
    const body = (await r.json()) as { steering: { id: string }; wokeRunId?: string }
    expect(body.wokeRunId).toBe(runId)
    if (_test.lastLoop) await _test.lastLoop
    _test.lastLoop = null
    // Woken loop consumed the steering and re-parked at the cursor's end.
    expect((await getRun(env.AQUILLA_PG, runId))?.status).toBe("parked")

    // Validation errors surface as 400.
    const tooBig = await req("POST", "/steering", contrib, { kind: "note", body: "x".repeat(11_000) })
    expect(tooBig.status).toBe(400)
  })
})

describe("draft listing + review handshake", () => {
  it("viewer lists but cannot review; contributor reviews; double review → 409", async () => {
    const { contrib, viewer } = await seedWorld()
    await startRun(contrib)

    const list = await req("GET", `/drafts?fileId=${FILE}`, viewer)
    expect(list.status).toBe(200)
    const { drafts } = (await list.json()) as { drafts: { id: string; status: string }[] }
    expect(drafts).toHaveLength(2)

    const deniedReview = await req("POST", `/drafts/${drafts[0].id}/review`, viewer, { action: "applied" })
    expect(deniedReview.status).toBe(403)

    const applied = await req("POST", `/drafts/${drafts[0].id}/review`, contrib, { action: "applied" })
    expect(applied.status).toBe(200)
    const appliedBody = (await applied.json()) as { draft: { status: string; reviewedBy: string } }
    expect(appliedBody.draft.status).toBe("applied")
    expect(appliedBody.draft.reviewedBy).toBe("contrib")

    const again = await req("POST", `/drafts/${drafts[0].id}/review`, contrib, { action: "rejected" })
    expect(again.status).toBe(409)

    // Cross-project probing by id → 404 (project scoping).
    const foreign = await app.request(
      `/api/v2/projects/other-project/contextual/drafts/${drafts[1].id}/review`,
      { method: "POST", headers: authHeader(contrib), body: JSON.stringify({ action: "applied" }) },
      env,
    )
    expect([403, 404]).toContain(foreign.status)

    // Missing fileId on the list → 400.
    expect((await req("GET", "/drafts", viewer)).status).toBe(400)
  })
})

// ── Project-wide fan-out + the PM overview ─────────────────────────────────

/** A second discourse file so a project-wide start has more than one target. */
async function seedSecondFile(): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, kind, event_id, cell_count) VALUES (?, ?, ?, ?, ?, 0)`,
  )
    .bind("file-luk", PROJECT, "LUK.usfm", "usfm", "ev-file-luk")
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, kind, event_id, cell_count) VALUES (?, ?, ?, ?, ?, 0)`,
  )
    .bind(FILE, PROJECT, "MRK.usfm", "usfm", "ev-file-mrk")
    .run()
  // A key/value catalog, which has no discourse to construe.
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, kind, event_id, cell_count) VALUES (?, ?, ?, ?, ?, 0)`,
  )
    .bind("file-ui", PROJECT, "ui.json", "json", "ev-file-ui")
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
     VALUES (?, 'file-luk', 'l1', 'source', 'A careful account', 'LUK 1:1', 'ev-l1', 0)`,
  )
    .bind(PROJECT)
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
     VALUES (?, 'file-ui', 'u1', 'source', 'Save', NULL, 'ev-u1', 0)`,
  )
    .bind(PROJECT)
    .run()
}

describe("POST /contextual/runs {scope:'project'}", () => {
  it("viewer → 403; contributor fans out across discourse files and skips catalogs", async () => {
    const { contrib, viewer } = await seedWorld()
    await seedSecondFile()

    expect((await req("POST", "/runs", viewer, { scope: "project" })).status).toBe(403)

    const started = await req("POST", "/runs", contrib, { scope: "project" })
    expect(started.status).toBe(201)
    if (_test.lastLoop) await _test.lastLoop
    _test.lastLoop = null

    const body = (await started.json()) as {
      scopeGroup: string
      started: { runId: string; fileId: string }[]
      skipped: { fileId: string }[]
    }
    expect(body.scopeGroup).toBeTruthy()
    const fileIds = body.started.map((s) => s.fileId).sort()
    expect(fileIds).toEqual(["file-luk", FILE].sort())
    // The JSON catalog is not a discourse file — nothing to construe there.
    expect(fileIds).not.toContain("file-ui")
  })

  it("reports files already running as skipped rather than failing the start", async () => {
    const { contrib } = await seedWorld()
    await seedSecondFile()
    await startRun(contrib) // MRK is now active

    const started = await req("POST", "/runs", contrib, { scope: "project" })
    expect(started.status).toBe(201)
    if (_test.lastLoop) await _test.lastLoop
    _test.lastLoop = null

    const body = (await started.json()) as {
      started: { fileId: string }[]
      skipped: { fileId: string; reason: string }[]
    }
    expect(body.skipped.map((s) => s.fileId)).toContain(FILE)
    expect(body.started.map((s) => s.fileId)).toContain("file-luk")
  })

  it("400s when no file in the project has work left", async () => {
    const { contrib } = await seedWorld()
    // Translate everything the seeded world has.
    for (const cellId of ["c1", "c2"]) {
      await env.AQUILLA_PG.prepare(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, source_event_id, last_edit_at, validated)
         VALUES (?, ?, ?, 'target', 'ya hecho', 'MRK 1:1', ?, ?, 0, 0)`,
      )
        .bind(PROJECT, FILE, cellId, `ev-t-${cellId}`, `ev-${cellId}`)
        .run()
    }
    const started = await req("POST", "/runs", contrib, { scope: "project" })
    expect(started.status).toBe(400)
  })

  it("400s a single-file start with no fileId", async () => {
    const { contrib } = await seedWorld()
    expect((await req("POST", "/runs", contrib, {})).status).toBe(400)
  })
})

describe("GET /contextual/overview", () => {
  it("viewer can read the project rollup: per-file runs plus the review backlog", async () => {
    const { contrib, viewer } = await seedWorld()
    await startRun(contrib)

    const res = await req("GET", "/overview", viewer)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      available: boolean
      files: { fileId: string; proposedDrafts: number; totalSpans: number }[]
      proposedDrafts: number
      totalSpans: number
    }
    expect(body.available).toBe(true)
    const row = body.files.find((f) => f.fileId === FILE)
    expect(row).toBeTruthy()
    expect(row?.proposedDrafts).toBe(2)
    expect(body.proposedDrafts).toBe(2)
    expect(body.totalSpans).toBeGreaterThan(0)
  })

  it("reports an empty rollup for a project autopilot has never touched", async () => {
    const { viewer } = await seedWorld()
    const res = await req("GET", "/overview", viewer)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { files: unknown[]; activeRuns: number; proposedDrafts: number }
    expect(body.files).toEqual([])
    expect(body.activeRuns).toBe(0)
    expect(body.proposedDrafts).toBe(0)
  })
})

describe("live draft streaming", () => {
  it("fans a contextual.drafts frame with the verified text out to the project DO", async () => {
    const { contrib } = await seedWorld()
    await startRun(contrib)

    const draftFrames = syncFrames.filter((f) => f.frame.type === "contextual.drafts")
    expect(draftFrames.length).toBeGreaterThan(0)
    const payload = draftFrames[0].frame as unknown as {
      fileId: string
      drafts: { draftId: string; cellId: string; text: string }[]
    }
    expect(payload.fileId).toBe(FILE)
    expect(payload.drafts.map((d) => d.cellId).sort()).toEqual(["c1", "c2"])
    expect(payload.drafts[0].text).toMatch(/^MOCK /)
    expect(payload.drafts[0].draftId).toBeTruthy()
  })

  it("opens a lane before the first model output so the UI never shows dead air", async () => {
    const { contrib } = await seedWorld()
    await startRun(contrib)

    const types = syncFrames.map((f) => f.frame.type)
    const firstStart = types.indexOf("contextual.span.start")
    const firstScene = types.indexOf("contextual.scene")
    expect(firstStart).toBeGreaterThanOrEqual(0)
    expect(firstStart).toBeLessThan(firstScene)
    expect(types).toContain("contextual.phase")
  })
})
