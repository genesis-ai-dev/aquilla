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
import {
  _test,
  settleRunWithoutProjectLease,
  sweepStrandedContextualRuns,
} from "../routes/contextual"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import {
  createRun,
  getRun,
  insertDrafts,
  listDrafts,
  requestPause,
  confirmPause,
  resumeRun,
  terminateRun,
} from "../../../db/shared/contextual-runs"
import { getSceneBrief, proposeSceneBrief } from "../../../db/shared/scene-briefs"
import { makeLlmCall, runOneTick } from "../lib/contextual/tick"
import type { LlmCall } from "../lib/contextual/types"
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
let modelCallCount = 0

beforeEach(() => {
  testEnv.OPENROUTER_API_KEY = "mock"
  testEnv.OPENROUTER_BASE_URL = MOCK_BASE
  syncFrames = []
  modelCallCount = 0
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === `${MOCK_BASE}/chat/completions`) {
      modelCallCount += 1
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
  delete testEnv.CONTEXTUAL_MAX_CONCURRENCY
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

/** Real pipeline replies with a deliberately adversarial verifier panel. All
 * non-verifier nodes still use the production E2E script contract. */
function rejectingContextualLlm(mode: "all" | "second-cell"): LlmCall {
  return async (request) => {
    if (request.label?.startsWith("verify:")) {
      const count = Number(request.user.match(/Verify these (\d+) drafted cells/)?.[1] ?? 0)
      const cells = Array.from({ length: count }, (_, index) => ({
        i: index + 1,
        approve: mode === "second-cell" && count > 1 && index === 0,
        reason: "categorical test rejection",
      }))
      return JSON.stringify({ approve: false, reason: "test rejection", cells })
    }
    const response = scriptMockResponse([
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ])
    return response.choices[0]?.message.content ?? ""
  }
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
    expect(Object.keys(state ?? {}).sort()).toEqual([
      "done", "failed", "fileId", "runId", "status", "targetLang", "total", "type",
    ])
    expect(state?.targetLang).toBe("")

    const activity = await req("GET", `/runs/${runId}/activity`, contrib)
    const activityBody = (await activity.json()) as { events: { kind: string }[] }
    expect(activityBody.events.map((event) => event.kind)).toContain("run_created")
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

  it("rejects an unregistered multilingual lane and starts a registered one", async () => {
    const { contrib } = await seedWorld()
    const unregistered = await req("POST", "/runs", contrib, { fileId: FILE, targetLang: "fr" })
    expect(unregistered.status).toBe(400)
    const body = await unregistered.json() as { error: { code: string; message: string } }
    expect(body.error).toMatchObject({ code: "validation_failed" })
    expect(body.error.message).toMatch(/not registered/i)
    expect(syncFrames).toEqual([])

    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_settings (project_id, settings, version, updated_by)
       VALUES (?, ?, 1, 1)`,
    ).bind(PROJECT, JSON.stringify({ targetLanes: ["fr", "es"] })).run()

    const started = await req("POST", "/runs", contrib, { fileId: FILE, targetLang: "fr" })
    expect(started.status).toBe(201)
    const startedBody = await started.json() as { runId: string }
    if (_test.lastLoop) await _test.lastLoop
    _test.lastLoop = null
    const frenchRun = await getRun(env.AQUILLA_PG, startedBody.runId)
    expect(frenchRun).toMatchObject({ targetLang: "fr", status: "parked" })
    const frenchDrafts = await listDrafts(env.AQUILLA_PG, PROJECT, FILE, "proposed", "fr")
    expect(frenchDrafts.length).toBeGreaterThan(0)
    expect(frenchDrafts.every((draft) => draft.targetLang === "fr")).toBe(true)
    expect(await listDrafts(env.AQUILLA_PG, PROJECT, FILE, "proposed", "")).toEqual([])

    const whitespace = await req("POST", "/runs", contrib, { fileId: FILE, targetLang: "   " })
    expect(whitespace.status).toBe(201)
    const whitespaceBody = await whitespace.json() as { runId: string }
    if (_test.lastLoop) await _test.lastLoop
    _test.lastLoop = null
    expect((await getRun(env.AQUILLA_PG, whitespaceBody.runId))?.targetLang).toBe("")
  })

  it("keeps default and named-lane runs independently hydratable", async () => {
    const { viewer } = await seedWorld()
    const defaultRun = await createRun(env.AQUILLA_PG, {
      projectId: PROJECT,
      fileId: FILE,
      targetLang: "",
    })
    if (defaultRun.status !== "ok") throw new Error("default run not created")
    const frenchRun = await createRun(env.AQUILLA_PG, {
      projectId: PROJECT,
      fileId: FILE,
      targetLang: "fr",
    })
    if (frenchRun.status !== "ok") throw new Error("french run not created")
    await env.AQUILLA_PG.prepare(
      "UPDATE contextual_runs SET created_at = '2026-01-01T00:00:00Z' WHERE id = ?",
    ).bind(defaultRun.run.id).run()
    await env.AQUILLA_PG.prepare(
      "UPDATE contextual_runs SET created_at = '2026-01-02T00:00:00Z' WHERE id = ?",
    ).bind(frenchRun.run.id).run()

    const activityResponse = await req(
      "GET",
      `/runs/${frenchRun.run.id}/activity`,
      viewer,
    )
    expect(activityResponse.status).toBe(200)
    const activity = await activityResponse.json() as {
      run: { runId: string; targetLang: string; status: string }
    }
    expect(activity.run).toMatchObject({
      runId: frenchRun.run.id,
      targetLang: "fr",
      status: "running",
    })

    const overviewResponse = await req("GET", "/overview", viewer)
    const overview = await overviewResponse.json() as {
      activeRuns: number
      files: { runId: string; targetLang: string; status: string }[]
    }
    expect(overview.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: defaultRun.run.id, targetLang: "", status: "running" }),
      expect.objectContaining({ runId: frenchRun.run.id, targetLang: "fr", status: "running" }),
    ]))
    expect(overview.activeRuns).toBe(2)

    const defaultSnapshot = await req("GET", `/runs?fileId=${FILE}`, viewer)
    const defaultBody = await defaultSnapshot.json() as { run: { runId: string; targetLang: string } }
    expect(defaultBody.run).toMatchObject({ runId: defaultRun.run.id, targetLang: "" })

    const frenchSnapshot = await req("GET", `/runs?fileId=${FILE}&targetLang=fr`, viewer)
    const frenchBody = await frenchSnapshot.json() as { run: { runId: string; targetLang: string } }
    expect(frenchBody.run).toMatchObject({ runId: frenchRun.run.id, targetLang: "fr" })
  })

  it("never persists or surfaces a provider error response body", async () => {
    const { contrib } = await seedWorld()
    const sensitiveBody = "Authorization: Bearer opaque-provider-token; user draft text"
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `${MOCK_BASE}/chat/completions`) {
        return new Response(sensitiveBody, { status: 401 })
      }
      if (url.includes("/admin/projects/")) {
        syncFrames.push({ url, frame: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return new Response("{}", { status: 200 })
      }
      throw new Error(`unexpected fetch in route test: ${url}`)
    })

    const runId = await startRun(contrib)
    const stored = await getRun(env.AQUILLA_PG, runId)
    expect(stored?.lastError).toBe("provider_http_error status=401")
    const activity = await req("GET", `/runs/${runId}/activity`, contrib)
    expect(activity.status).toBe(200)
    const body = await activity.json() as { run: { lastError: string | null } }
    expect(body.run.lastError).toBe("provider_http_error status=401")
    expect(JSON.stringify({ body, syncFrames })).not.toContain("opaque-provider-token")
    expect(JSON.stringify({ body, syncFrames })).not.toContain("user draft text")
  })
})

describe("GET /contextual/runs snapshot", () => {
  it("counts named-lane proposals in overview and hydrates them on that lane", async () => {
    const { viewer } = await seedWorld()
    const defaultOwner = await createRun(env.AQUILLA_PG, {
      projectId: PROJECT,
      fileId: FILE,
    })
    if (defaultOwner.status !== "ok") throw new Error("default run not created")
    await insertDrafts(env.AQUILLA_PG, {
      runId: defaultOwner.run.id,
      projectId: PROJECT,
      fileId: FILE,
      drafts: [{ cellId: "default-editor-review", text: "default proposal" }],
    })
    await terminateRun(env.AQUILLA_PG, defaultOwner.run.id)

    const frenchOwner = await createRun(env.AQUILLA_PG, {
      projectId: PROJECT,
      fileId: FILE,
      targetLang: "fr",
    })
    if (frenchOwner.status !== "ok") throw new Error("French run not created")
    await insertDrafts(env.AQUILLA_PG, {
      runId: frenchOwner.run.id,
      projectId: PROJECT,
      fileId: FILE,
      drafts: [{ cellId: "french-review", text: "proposition française" }],
    })
    await terminateRun(env.AQUILLA_PG, frenchOwner.run.id)

    const editor = await req("GET", `/drafts?fileId=${FILE}&status=proposed`, viewer)
    expect(editor.status).toBe(200)
    const editorBody = await editor.json() as { drafts: { cellId: string }[] }
    expect(editorBody.drafts.map((draft) => draft.cellId)).toEqual(["default-editor-review"])

    const frenchEditor = await req("GET", `/drafts?fileId=${FILE}&status=proposed&targetLang=fr`, viewer)
    const frenchEditorBody = await frenchEditor.json() as { drafts: { cellId: string; targetLang: string }[] }
    expect(frenchEditorBody.drafts).toEqual([
      expect.objectContaining({ cellId: "french-review", targetLang: "fr" }),
    ])

    const snapshot = await req("GET", `/runs?fileId=${FILE}`, viewer)
    const snapshotBody = await snapshot.json() as {
      run: { runId: string; proposedDrafts: number } | null
      draftCounts: Record<string, number>
    }
    expect(snapshotBody.run).toMatchObject({ runId: defaultOwner.run.id, proposedDrafts: 1 })
    expect(snapshotBody.draftCounts.proposed).toBe(1)

    const frenchSnapshot = await req("GET", `/runs?fileId=${FILE}&targetLang=fr`, viewer)
    const frenchSnapshotBody = await frenchSnapshot.json() as {
      run: { runId: string; proposedDrafts: number } | null
      draftCounts: Record<string, number>
    }
    expect(frenchSnapshotBody.run).toMatchObject({ runId: frenchOwner.run.id, proposedDrafts: 1 })
    expect(frenchSnapshotBody.draftCounts.proposed).toBe(1)

    const overview = await req("GET", "/overview", viewer)
    const overviewBody = await overview.json() as { proposedDrafts: number }
    expect(overviewBody.proposedDrafts).toBe(2)

    const reviewOwners = await req("GET", "/runs?proposedOnly=true", viewer)
    const reviewOwnerBody = await reviewOwners.json() as { runs: { runId: string; targetLang: string }[] }
    expect(reviewOwnerBody.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: defaultOwner.run.id, targetLang: "" }),
      expect.objectContaining({ runId: frenchOwner.run.id, targetLang: "fr" }),
    ]))
  })

  it("viewer can hydrate: run snapshot + active directions + draft counts", async () => {
    const { contrib, viewer } = await seedWorld()
    const runId = await startRun(contrib)
    await req("POST", "/steering", contrib, { kind: "direction", body: "stay literal", fileId: "file-other" })

    const r = await req("GET", `/runs?fileId=${FILE}`, viewer)
    expect(r.status).toBe(200)
    const snap = (await r.json()) as {
      available: boolean
      run: {
        runId: string
        status: string
        done: number
        total: number
        failed: number
        proposedDrafts: number
      } | null
      activeDirections: string[]
      draftCounts: Record<string, number>
    }
    expect(snap.available).toBe(true)
    expect(snap.run?.runId).toBe(runId)
    expect(snap.run?.status).toBe("parked")
    expect(snap.run?.done).toBe(1)
    expect(snap.run?.total).toBe(1)
    expect(snap.run?.proposedDrafts).toBe(2)
    expect(snap.draftCounts.proposed).toBe(2)
    // The other-file direction is NOT in this file's snapshot.
    expect(snap.activeDirections).toEqual([])
  })

  it("pages project history and exposes review counts on the owning run", async () => {
    const { viewer } = await seedWorld()
    const older = await createRun(env.AQUILLA_PG, { projectId: PROJECT, fileId: FILE })
    if (older.status !== "ok") throw new Error("older run not created")
    await insertDrafts(env.AQUILLA_PG, {
      runId: older.run.id,
      projectId: PROJECT,
      fileId: FILE,
      drafts: [{ cellId: "older-review", text: "review belongs to older run" }],
    })
    await terminateRun(env.AQUILLA_PG, older.run.id)
    const newer = await createRun(env.AQUILLA_PG, { projectId: PROJECT, fileId: FILE })
    if (newer.status !== "ok") throw new Error("newer run not created")
    await env.AQUILLA_PG.prepare(
      "UPDATE contextual_runs SET created_at = '2026-01-01T00:00:00Z' WHERE id = ?",
    ).bind(older.run.id).run()
    await env.AQUILLA_PG.prepare(
      "UPDATE contextual_runs SET created_at = '2026-01-02T00:00:00Z' WHERE id = ?",
    ).bind(newer.run.id).run()

    const first = await req("GET", "/runs?limit=1", viewer)
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as {
      runs: { runId: string; proposedDrafts: number }[]
      truncated: boolean
      nextCursor: { createdAt: string; runId: string } | null
    }
    expect(firstBody.runs).toEqual([
      expect.objectContaining({ runId: newer.run.id, proposedDrafts: 0 }),
    ])
    expect(firstBody.truncated).toBe(true)
    expect(firstBody.nextCursor).not.toBeNull()

    const cursor = firstBody.nextCursor
    if (!cursor) throw new Error("missing cursor")
    const second = await req(
      "GET",
      `/runs?limit=1&beforeCreatedAt=${encodeURIComponent(cursor.createdAt)}&beforeRunId=${encodeURIComponent(cursor.runId)}`,
      viewer,
    )
    const secondBody = (await second.json()) as {
      runs: { runId: string; proposedDrafts: number }[]
      truncated: boolean
    }
    expect(secondBody.runs).toEqual([
      expect.objectContaining({ runId: older.run.id, proposedDrafts: 1 }),
    ])
    expect(secondBody.truncated).toBe(false)

    const reviewOnly = await req("GET", "/runs?proposedOnly=true", viewer)
    const reviewOnlyBody = await reviewOnly.json() as {
      runs: { runId: string; proposedDrafts: number }[]
      truncated: boolean
    }
    expect(reviewOnlyBody.runs).toEqual([
      expect.objectContaining({ runId: older.run.id, proposedDrafts: 1 }),
    ])
    expect(reviewOnlyBody.truncated).toBe(false)

    const overview = await req("GET", "/overview", viewer)
    const overviewBody = (await overview.json()) as {
      proposedDrafts: number
      files: { fileId: string; runId: string; proposedDrafts: number }[]
    }
    expect(overviewBody.proposedDrafts).toBe(1)
    expect(overviewBody.files.find((file) => file.fileId === FILE)).toMatchObject({
      runId: newer.run.id,
      proposedDrafts: 0,
    })
  })
})

describe("GET /contextual/runs/:runId/activity", () => {
  it.each([
    { mode: "all" as const, eventStatus: "failed", staged: 0, skipped: 2 },
    { mode: "second-cell" as const, eventStatus: "partial", staged: 1, skipped: 1 },
  ])("makes verifier-skipped work actionable ($mode)", async ({ mode, eventStatus, staged, skipped }) => {
    const { viewer } = await seedWorld()
    const created = await createRun(env.AQUILLA_PG, { projectId: PROJECT, fileId: FILE })
    if (created.status !== "ok") throw new Error("run not created")

    const tick = await runOneTick({
      db: env.AQUILLA_PG,
      runId: created.run.id,
      llm: rejectingContextualLlm(mode),
    })
    expect(tick.status).toBe("failed")
    const stored = await getRun(env.AQUILLA_PG, created.run.id)
    expect(stored).toMatchObject({ status: "failed", doneSpans: 0, failedSpans: 1 })
    expect(stored?.lastError).toBe(staged > 0
      ? "Some cells could not be drafted and need attention."
      : "This passage could not produce a reviewable draft.")

    const activityResponse = await req("GET", `/runs/${created.run.id}/activity`, viewer)
    const activity = await activityResponse.json() as {
      run: { done: number; failed: number; proposedDrafts: number }
      events: { kind: string; status: string | null; details: Record<string, unknown> }[]
    }
    expect(activity.run).toMatchObject({ done: 0, failed: 1, proposedDrafts: staged })
    const outcome = activity.events.find((event) => event.kind === "span_outcome")
    expect(outcome).toMatchObject({
      status: eventStatus,
      details: {
        staged,
        skipped,
        reasons: expect.arrayContaining(["span_failed", "rejected_by_quorum"]),
      },
    })
    expect(JSON.stringify(activity.events)).not.toContain("categorical test rejection")

    const overviewResponse = await req("GET", "/overview", viewer)
    const overview = await overviewResponse.json() as {
      failedSpans: number
      files: { runId: string; doneSpans: number; failedSpans: number; proposedDrafts: number }[]
    }
    expect(overview.files.find((row) => row.runId === created.run.id)).toMatchObject({
      doneSpans: 0,
      failedSpans: 1,
      proposedDrafts: staged,
    })
    expect(overview.failedSpans).toBe(1)

    if (mode === "second-cell") {
      const oldDrafts = await listDrafts(env.AQUILLA_PG, PROJECT, FILE, "proposed")
      expect(oldDrafts).toHaveLength(1)
      const preserved = oldDrafts[0]

      const retry = await createRun(env.AQUILLA_PG, { projectId: PROJECT, fileId: FILE })
      if (retry.status !== "ok") throw new Error("retry run not created")
      const retryResult = await runOneTick({
        db: env.AQUILLA_PG,
        runId: retry.run.id,
        llm: makeLlmCall({
          url: `${MOCK_BASE}/chat/completions`,
          apiKey: "mock",
          models: { fast: "mock/fast", mid: "mock/mid", deep: "mock/deep" },
        }),
      })
      expect(retryResult.status).toBe("parked")
      const recovered = await listDrafts(env.AQUILLA_PG, PROJECT, FILE, "proposed")
      expect(recovered).toHaveLength(2)
      expect(recovered.find((draft) => draft.id === preserved.id)).toMatchObject({
        id: preserved.id,
        runId: created.run.id,
        status: "proposed",
      })
      expect(recovered.find((draft) => draft.runId === retry.run.id)?.cellId).toBe("c2")
    }
  })

  it("composes the real tick producer through durable sanitized events and run evidence", async () => {
    const { viewer } = await seedWorld()
    const created = await createRun(env.AQUILLA_PG, {
      projectId: PROJECT,
      fileId: FILE,
      initiatedBy: "contrib",
      roleSnapshot: { userId: 2, username: "contrib", level: 400 },
      anchorCellId: "c1",
      scopeGroup: "scope-inspector",
    })
    if (created.status !== "ok") throw new Error("run not created")

    // Critical producer → persistence boundary: this is runOneTick's real
    // pipeline output, not synthetic event fixtures.
    await runOneTick({
      db: env.AQUILLA_PG,
      runId: created.run.id,
      llm: makeLlmCall({
        url: `${MOCK_BASE}/chat/completions`,
        apiKey: "mock",
        models: { fast: "mock/fast", mid: "mock/mid", deep: "mock/deep" },
      }),
    })

    const res = await req("GET", `/runs/${created.run.id}/activity`, viewer)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      run: {
        runId: string
        status: string
        initiatedBy: string | null
        scopeGroup: string | null
        anchorCellId: string | null
        proposedDrafts: number
      }
      events: {
        id: string
        kind: string
        createdAt: string
        details: Record<string, unknown>
      }[]
      sceneBriefs: { provenance: { runId?: string } | null }[]
      drafts: { runId: string; cellId: string; text: string }[]
      draftCounts: Record<string, number>
      draftNextCursor: { createdAt: string; draftId: string } | null
      truncated: boolean
      truncatedCollections: { events: boolean; sceneBriefs: boolean; drafts: boolean }
    }
    expect(Object.keys(body).sort()).toEqual([
      "draftCounts",
      "draftNextCursor",
      "drafts",
      "events",
      "run",
      "sceneBriefs",
      "truncated",
      "truncatedCollections",
    ])
    expect(body.run).toMatchObject({
      runId: created.run.id,
      status: "parked",
      initiatedBy: "contrib",
      scopeGroup: "scope-inspector",
      anchorCellId: "c1",
      proposedDrafts: 2,
    })
    const kinds = body.events.map((event) => event.kind)
    expect(kinds).toEqual(expect.arrayContaining([
      "run_state",
      "span_started",
      "phase",
      "scene_ready",
      "drafts_staged",
      "span_outcome",
    ]))
    const staged = body.events.find((event) => event.kind === "drafts_staged")
    expect(staged?.details.count).toBe(2)
    expect([...(staged?.details.cellIds as string[])].sort()).toEqual(["c1", "c2"])
    const outcome = body.events.find((event) => event.kind === "span_outcome")
    expect(outcome?.details).toMatchObject({ staged: 2, skipped: 0 })
    expect(typeof outcome?.details.calls).toBe("number")
    expect(typeof outcome?.details.units).toBe("number")
    expect(body.sceneBriefs).toHaveLength(1)
    expect(body.sceneBriefs[0].provenance?.runId).toBe(created.run.id)
    expect(body.drafts.map((draft) => draft.cellId).sort()).toEqual(["c1", "c2"])
    expect(body.drafts.every((draft) => draft.runId === created.run.id)).toBe(true)
    expect(body.draftCounts).toEqual({ proposed: 2, applied: 0, rejected: 0, superseded: 0 })
    expect(body.draftNextCursor).toBeNull()
    expect(body.truncated).toBe(false)
    expect(body.truncatedCollections).toEqual({ events: false, sceneBriefs: false, drafts: false })

    // The evidence rows intentionally contain the reviewable text. The event
    // stream itself never does, nor does it expose prompt/reasoning/token keys.
    const serializedEvents = JSON.stringify(body.events)
    for (const draft of body.drafts) expect(serializedEvents).not.toContain(draft.text)
    expect(serializedEvents).not.toMatch(/prompt|reasoning|completionTokens|promptTokens/i)

    // A viewer on another project still cannot turn a guessed run id into a
    // cross-project activity read.
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES ('other-project', 'Other', 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('other-project', 3, 100, 1)",
    ).run()
    const foreign = await app.request(
      `/api/v2/projects/other-project/contextual/runs/${created.run.id}/activity`,
      { headers: authHeader(viewer) },
      env,
    )
    expect(foreign.status).toBe(404)
  })

  it("reports truncation for the affected evidence collection", async () => {
    const { viewer } = await seedWorld()
    const created = await createRun(env.AQUILLA_PG, { projectId: PROJECT, fileId: FILE })
    if (created.status !== "ok") throw new Error("run not created")
    await env.AQUILLA_PG.prepare(
      "UPDATE contextual_runs SET last_error = 'Authorization: Bearer opaque-legacy-token user material' WHERE id = ?",
    )
      .bind(created.run.id)
      .run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO contextual_run_events
          (id, run_id, project_id, file_id, kind, status, summary, details, created_at)
       SELECT '00000000-0000-7000-8000-' || lpad(gs::text, 12, '0'),
              ?, ?, ?, 'run_state', 'running', 'Autopilot is running', '{}'::jsonb,
              now() + gs * interval '1 microsecond'
         FROM generate_series(1, 501) AS gs`,
    ).bind(created.run.id, PROJECT, FILE).run()

    const res = await req("GET", `/runs/${created.run.id}/activity`, viewer)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      run: { lastError: string | null }
      events: unknown[]
      truncated: boolean
      truncatedCollections: { events: boolean; sceneBriefs: boolean; drafts: boolean }
    }
    expect(body.events).toHaveLength(500)
    expect(body.run.lastError).toMatch(/redacted/i)
    expect(body.run.lastError).not.toContain("opaque-legacy-token")
    expect(body.truncated).toBe(true)
    expect(body.truncatedCollections).toEqual({ events: true, sceneBriefs: false, drafts: false })

    const overview = await req("GET", "/overview", viewer)
    const overviewBody = await overview.json() as { files: { runId: string; lastError: string | null }[] }
    const overviewError = overviewBody.files.find((row) => row.runId === created.run.id)?.lastError
    expect(overviewError).toMatch(/redacted/i)
    expect(overviewError).not.toContain("opaque-legacy-token")
  })

  it("pages all proposed evidence independently of mixed draft history", async () => {
    const { viewer } = await seedWorld()
    const created = await createRun(env.AQUILLA_PG, { projectId: PROJECT, fileId: FILE })
    if (created.status !== "ok") throw new Error("run not created")
    const rows = await insertDrafts(env.AQUILLA_PG, {
      runId: created.run.id,
      projectId: PROJECT,
      fileId: FILE,
      drafts: [
        { cellId: "p-old", text: "old proposed" },
        { cellId: "p-mid", text: "middle proposed" },
        { cellId: "p-new", text: "new proposed" },
        { cellId: "applied-new", text: "applied" },
        { cellId: "rejected-new", text: "rejected" },
      ],
    })
    const byCell = new Map(rows.map((row) => [row.cellId, row.id]))
    await env.AQUILLA_PG.prepare(
      `UPDATE contextual_drafts
          SET status = CASE cell_id
            WHEN 'applied-new' THEN 'applied'
            WHEN 'rejected-new' THEN 'rejected'
            ELSE status END,
              created_at = CASE cell_id
            WHEN 'p-old' THEN '2026-01-01T00:00:00Z'::timestamptz
            WHEN 'p-mid' THEN '2026-01-02T00:00:00Z'::timestamptz
            WHEN 'p-new' THEN '2026-01-03T00:00:00Z'::timestamptz
            WHEN 'applied-new' THEN '2026-01-04T00:00:00Z'::timestamptz
            ELSE '2026-01-05T00:00:00Z'::timestamptz END
        WHERE run_id = ?`,
    ).bind(created.run.id).run()

    const first = await req(
      "GET",
      `/runs/${created.run.id}/activity?draftStatus=proposed&draftLimit=2`,
      viewer,
    )
    const firstBody = await first.json() as {
      run: { proposedDrafts: number }
      drafts: { id: string; status: string }[]
      draftCounts: Record<string, number>
      draftNextCursor: { createdAt: string; draftId: string } | null
      truncatedCollections: { drafts: boolean }
    }
    expect(firstBody.run.proposedDrafts).toBe(3)
    expect(firstBody.draftCounts).toEqual({ proposed: 3, applied: 1, rejected: 1, superseded: 0 })
    expect(firstBody.drafts.map((row) => row.id)).toEqual([byCell.get("p-mid"), byCell.get("p-new")])
    expect(firstBody.drafts.every((row) => row.status === "proposed")).toBe(true)
    expect(firstBody.truncatedCollections.drafts).toBe(true)
    expect(firstBody.draftNextCursor).not.toBeNull()

    const cursor = firstBody.draftNextCursor
    if (!cursor) throw new Error("missing draft cursor")
    const second = await req(
      "GET",
      `/runs/${created.run.id}/activity?draftStatus=proposed&draftLimit=2`+
        `&draftBeforeCreatedAt=${encodeURIComponent(cursor.createdAt)}`+
        `&draftBeforeId=${encodeURIComponent(cursor.draftId)}`,
      viewer,
    )
    const secondBody = await second.json() as {
      drafts: { id: string }[]
      draftNextCursor: null
      truncatedCollections: { drafts: boolean }
    }
    expect(secondBody.drafts.map((row) => row.id)).toEqual([byCell.get("p-old")])
    expect(secondBody.draftNextCursor).toBeNull()
    expect(secondBody.truncatedCollections.drafts).toBe(false)

    expect((await req(
      "GET",
      `/runs/${created.run.id}/activity?draftBeforeCreatedAt=2026-01-01T00:00:00Z`,
      viewer,
    )).status).toBe(400)
  })
})

describe("run control transitions", () => {
  it("retries capacity instead of drafting if a paused run resumes after lease wait exits", async () => {
    await seedWorld()
    const created = await createRun(env.AQUILLA_PG, {
      projectId: PROJECT,
      fileId: FILE,
      initiatedBy: "contrib",
      roleSnapshot: { userId: 2, username: "contrib", level: 400 },
    })
    if (created.status !== "ok") throw new Error("run not created")

    // Model the exact race: capacity wait observed a control state and chose
    // the no-lease branch; another driver confirmed the pause and the user
    // resumed before that branch read the run again.
    expect((await requestPause(env.AQUILLA_PG, created.run.id)).status).toBe("ok")
    expect((await confirmPause(env.AQUILLA_PG, created.run.id)).status).toBe("ok")
    expect((await resumeRun(env.AQUILLA_PG, created.run.id)).status).toBe("ok")

    const result = await settleRunWithoutProjectLease(
      env.AQUILLA_PG,
      created.run.id,
      async () => {},
    )
    expect(result).toEqual({ continueRun: true, status: "running" })
    expect(modelCallCount).toBe(0)
    expect((await getRun(env.AQUILLA_PG, created.run.id))?.doneSpans).toBe(0)
  })

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
    const activity = await req("GET", `/runs/${runId}/activity`, contrib)
    const statuses = ((await activity.json()) as { events: { kind: string; status: string | null }[] })
      .events.filter((event) => event.kind === "run_state")
      .map((event) => event.status)
    expect(statuses).toEqual(expect.arrayContaining(["running", "parked", "terminated"]))

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
    const activity = await req("GET", `/runs/${runId}/activity`, contrib)
    const activityBody = (await activity.json()) as { events: { kind: string }[] }
    expect(activityBody.events.map((event) => event.kind)).toContain("steering_queued")

    // Validation errors surface as 400.
    const tooBig = await req("POST", "/steering", contrib, { kind: "note", body: "x".repeat(11_000) })
    expect(tooBig.status).toBe(400)

    const foreignLane = await proposeSceneBrief(env.AQUILLA_PG, {
      projectId: PROJECT,
      fileId: FILE,
      startCellId: "c1",
      endCellId: "c2",
      targetLang: "fr",
      construal: "Historic French-lane scene.",
      l1Summary: "Must remain evidence-only.",
    })
    if (foreignLane.status !== "ok") throw new Error(foreignLane.message)
    const wrongLaneRefresh = await req("POST", "/steering", contrib, {
      kind: "refresh_span",
      body: foreignLane.brief.id,
      fileId: FILE,
      runId,
    })
    expect(wrongLaneRefresh.status).toBe(400)
    expect((await getSceneBrief(env.AQUILLA_PG, foreignLane.brief.id))?.staleSince).toBeNull()
  })
})

describe("draft listing + review handshake", () => {
  it("viewer lists but cannot review; applied waits for projection; decisions are terminal", async () => {
    const { contrib, viewer } = await seedWorld()
    const runId = await startRun(contrib)

    const list = await req("GET", `/drafts?fileId=${FILE}`, viewer)
    expect(list.status).toBe(200)
    const { drafts } = (await list.json()) as {
      drafts: { id: string; status: string; cellId: string; text: string }[]
    }
    expect(drafts).toHaveLength(2)

    const deniedReview = await req("POST", `/drafts/${drafts[0].id}/review`, viewer, { action: "applied" })
    expect(deniedReview.status).toBe(403)

    // A rolling client may report the review before its outbox event reaches
    // the sync projection. The route must leave that proposal pending.
    const beforeProjection = await req(
      "POST",
      `/drafts/${drafts[0].id}/review`,
      contrib,
      { action: "applied" },
    )
    expect(beforeProjection.status).toBe(409)
    const pendingBody = (await beforeProjection.json()) as {
      error: { code: string; message: string }
    }
    expect(pendingBody.error).toEqual({
      code: "not_projected",
      message: "The target commit has not been applied yet. Wait for sync to finish, then retry.",
    })
    expect(JSON.stringify(pendingBody)).not.toContain(drafts[0].text)

    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells
          (project_id, file_id, cell_id, side, target_lang, value, event_id, last_edit_at)
       VALUES (?, ?, ?, 'target', '', ?, ?, 0)`,
    ).bind(
      PROJECT,
      FILE,
      drafts[0].cellId,
      drafts[0].text,
      `ev-review-${drafts[0].cellId}`,
    ).run()

    const applied = await req("POST", `/drafts/${drafts[0].id}/review`, contrib, { action: "applied" })
    expect(applied.status).toBe(200)
    const appliedBody = (await applied.json()) as { draft: { status: string; reviewedBy: string } }
    expect(appliedBody.draft.status).toBe("applied")
    expect(appliedBody.draft.reviewedBy).toBe("contrib")
    const activity = await req("GET", `/runs/${runId}/activity`, viewer)
    const reviewed = ((await activity.json()) as {
      events: { kind: string; status: string | null; details: Record<string, unknown> }[]
    }).events.find((event) => event.kind === "draft_reviewed")
    expect(reviewed).toMatchObject({ status: "applied", details: { outcome: "applied" } })

    // A lost first response is safe to retry and does not append duplicate
    // activity evidence for the same durable decision.
    const idempotent = await req("POST", `/drafts/${drafts[0].id}/review`, contrib, { action: "applied" })
    expect(idempotent.status).toBe(200)
    const afterRetry = await req("GET", `/runs/${runId}/activity`, viewer)
    expect(((await afterRetry.json()) as { events: { kind: string }[] }).events
      .filter((event) => event.kind === "draft_reviewed")).toHaveLength(1)

    const again = await req("POST", `/drafts/${drafts[0].id}/review`, contrib, { action: "rejected" })
    expect(again.status).toBe(409)

    const rejected = await req(
      "POST",
      `/drafts/${drafts[1].id}/review`,
      contrib,
      { action: "rejected" },
    )
    expect(rejected.status).toBe(200)
    expect(((await rejected.json()) as { draft: { status: string } }).draft.status).toBe("rejected")

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
  // IDML target slots require protected structure that a plain contextual
  // draft cannot preserve, so v1 must not offer or stage them.
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, kind, event_id, cell_count) VALUES (?, ?, ?, ?, ?, 0)`,
  )
    .bind("file-layout", PROJECT, "layout.idml", "idml", "ev-file-layout")
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
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
     VALUES (?, 'file-layout', 'i1', 'source', 'Protected layout text', NULL, 'ev-i1', 0)`,
  )
    .bind(PROJECT)
    .run()
}

async function seedFanoutFiles(count: number): Promise<void> {
  const statements = []
  for (let index = 1; index <= count; index++) {
    const suffix = String(index).padStart(2, "0")
    const fileId = `fanout-${suffix}`
    statements.push(
      env.AQUILLA_PG.prepare(
        `INSERT INTO files (id, project_id, name, kind, event_id, cell_count)
         VALUES (?, ?, ?, 'usfm', ?, 1)`,
      ).bind(fileId, PROJECT, `Book ${suffix}`, `ev-file-${suffix}`),
      env.AQUILLA_PG.prepare(
        `INSERT INTO cells
            (project_id, file_id, cell_id, side, target_lang, value,
             canonical_ref, event_id, last_edit_at)
         VALUES (?, ?, ?, 'source', '', ?, ?, ?, 0)`,
      ).bind(
        PROJECT,
        fileId,
        `cell-${suffix}`,
        `Source ${suffix}`,
        `GEN ${index}:1`,
        `ev-cell-${suffix}`,
      ),
    )
  }
  await env.AQUILLA_PG.batch(statements)
}

async function seedFairnessFiles(): Promise<void> {
  const statements = []
  for (const fileIndex of [1, 2]) {
    const fileId = `fair-${fileIndex}`
    statements.push(
      env.AQUILLA_PG.prepare(
        `INSERT INTO files (id, project_id, name, kind, event_id, cell_count)
         VALUES (?, ?, ?, 'usfm', ?, 2)`,
      ).bind(fileId, PROJECT, `Fair ${fileIndex}`, `ev-fair-file-${fileIndex}`),
    )
    for (const chapter of [1, 2]) {
      statements.push(
        env.AQUILLA_PG.prepare(
          `INSERT INTO cells
              (project_id, file_id, cell_id, side, target_lang, value,
               canonical_ref, event_id, last_edit_at)
           VALUES (?, ?, ?, 'source', '', ?, ?, ?, 0)`,
        ).bind(
          PROJECT,
          fileId,
          `fair-${fileIndex}-${chapter}`,
          `Source ${fileIndex}/${chapter}`,
          `GEN ${chapter}:1`,
          `ev-fair-${fileIndex}-${chapter}`,
        ),
      )
    }
  }
  await env.AQUILLA_PG.batch(statements)
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
    expect(fileIds).not.toContain("file-layout")
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
    expect(body.skipped).toContainEqual({
      fileId: FILE,
      reason: "idle run owns file; review or stop it before rerunning",
    })
    expect(body.started.map((s) => s.fileId)).toContain("file-luk")
  })

  it("drives earlier and later runs when one candidate creation fails mid-batch", async () => {
    const { contrib } = await seedWorld()
    await seedFanoutFiles(3)
    const originalPrepare = env.AQUILLA_PG.prepare.bind(env.AQUILLA_PG)
    let runInserts = 0
    const prepareSpy = vi.spyOn(env.AQUILLA_PG, "prepare").mockImplementation((query: string) => {
      if (query.includes("INSERT INTO contextual_runs")) {
        runInserts++
        if (runInserts === 2) throw new Error("injected candidate insert failure")
      }
      return originalPrepare(query)
    })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    let response: Response
    try {
      response = await req("POST", "/runs", contrib, { scope: "project" })
    } finally {
      prepareSpy.mockRestore()
      errorSpy.mockRestore()
    }
    expect(response.status).toBe(201)
    const body = await response.json() as {
      started: { runId: string; fileId: string }[]
      skipped: { fileId: string; reason: string }[]
      totalCandidates: number
    }
    expect(body.totalCandidates).toBe(3)
    expect(body.started.map((run) => run.fileId)).toEqual(["fanout-01", "fanout-03"])
    expect(body.skipped).toContainEqual({ fileId: "fanout-02", reason: "start_failed" })
    expect(_test.lastLoop).not.toBeNull()
    if (_test.lastLoop) await _test.lastLoop
    for (const started of body.started) {
      expect((await getRun(env.AQUILLA_PG, started.runId))?.status).not.toBe("running")
    }
    _test.lastLoop = null
  })

  it("yields a released project slot so every driver enters a first wave before any second wave", async () => {
    const { contrib } = await seedWorld()
    await seedFairnessFiles()
    testEnv.CONTEXTUAL_MAX_CONCURRENCY = "1"

    const response = await req("POST", "/runs", contrib, { scope: "project" })
    expect(response.status).toBe(201)
    const body = await response.json() as {
      started: { runId: string; fileId: string }[]
    }
    expect(body.started).toHaveLength(2)
    if (_test.lastLoop) await _test.lastLoop
    _test.lastLoop = null

    const runIds = new Set(body.started.map((run) => run.runId))
    const spanStarts = syncFrames
      .map((entry) => entry.frame)
      .filter((frame) =>
        frame.type === "contextual.span.start"
        && typeof frame.runId === "string"
        && runIds.has(frame.runId))
      .map((frame) => frame.runId as string)
    expect(spanStarts).toHaveLength(4)
    expect(new Set(spanStarts.slice(0, 2))).toEqual(runIds)
  }, 30_000)

  it("defers beyond 24 truthfully, advances on a second start, and weights the project concurrency cap", async () => {
    const { contrib } = await seedWorld()
    await seedFanoutFiles(26)
    testEnv.CONTEXTUAL_MAX_CONCURRENCY = "4"

    let releaseModel!: () => void
    const modelHeld = new Promise<void>((resolve) => {
      releaseModel = resolve
    })
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === `${MOCK_BASE}/chat/completions`) {
        await modelHeld
        const request = JSON.parse(String(init?.body)) as {
          messages: { role: string; content: string }[]
        }
        return new Response(JSON.stringify(scriptMockResponse(request.messages)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      if (url.includes("/admin/projects/")) {
        syncFrames.push({ url, frame: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return new Response("{}", { status: 200 })
      }
      throw new Error(`unexpected fetch in route test: ${url}`)
    })

    type ProjectStartBody = {
      started: { runId: string; fileId: string }[]
      skipped: { fileId: string; reason: string }[]
      totalCandidates: number
      deferred: { count: number; reason: "batch_limit" | null }
      truncated: boolean
    }

    let firstLoop: Promise<void> | null = null
    let secondLoop: Promise<void> | null = null
    try {
      const first = await req("POST", "/runs", contrib, { scope: "project" })
      expect(first.status).toBe(201)
      const firstBody = await first.json() as ProjectStartBody
      expect(firstBody).toMatchObject({
        totalCandidates: 26,
        deferred: { count: 2, reason: "batch_limit" },
        truncated: true,
        skipped: [],
      })
      expect(firstBody.started).toHaveLength(24)
      expect(firstBody.started.map((run) => run.fileId)).not.toContain("fanout-25")
      firstLoop = _test.lastLoop

      // The first 24 loops are deliberately held in-flight. Active files are
      // removed before the batch cap, so the next bounded start reaches the
      // never-started tail instead of slicing the same 24 forever.
      const second = await req("POST", "/runs", contrib, { scope: "project" })
      expect(second.status).toBe(201)
      const secondBody = await second.json() as ProjectStartBody
      expect(secondBody).toMatchObject({
        totalCandidates: 26,
        deferred: { count: 0, reason: null },
        truncated: false,
      })
      expect(secondBody.started.map((run) => run.fileId).sort()).toEqual([
        "fanout-25",
        "fanout-26",
      ])
      expect(secondBody.skipped).toHaveLength(24)
      expect(new Set(secondBody.skipped.map((item) => item.reason))).toEqual(
        new Set(["already running"]),
      )
      secondLoop = _test.lastLoop
      await expect.poll(async () => {
        const row = await env.AQUILLA_PG.prepare(
          `SELECT COALESCE(SUM(weight), 0) AS weight
             FROM contextual_project_leases
            WHERE project_id = ? AND expires_at > now()`,
        ).bind(PROJECT).first<{ weight: number }>()
        return Number(row?.weight ?? 0)
      }).toBe(4)
    } finally {
      releaseModel()
    }

    await Promise.all([firstLoop, secondLoop].filter((loop): loop is Promise<void> => loop !== null))
    const remainingLeases = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS count FROM contextual_project_leases WHERE project_id = ?",
    ).bind(PROJECT).first<{ count: number }>()
    expect(Number(remainingLeases?.count ?? -1)).toBe(0)
  }, 30_000)

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

  it("computes readiness from the default target lane only", async () => {
    const { viewer } = await seedWorld()
    for (const cellId of ["c1", "c2"]) {
      await env.AQUILLA_PG.prepare(
        `INSERT INTO cells
            (project_id, file_id, cell_id, side, target_lang, value, canonical_ref,
             event_id, source_event_id, last_edit_at, validated)
         VALUES (?, ?, ?, 'target', 'fr', 'traduit', 'MRK 1:1', ?, ?, 0, 1)`,
      ).bind(PROJECT, FILE, cellId, `ev-fr-${cellId}`, `ev-${cellId}`).run()
    }
    const response = await req("GET", "/overview", viewer)
    const body = await response.json() as {
      readiness: { items: { id: string; level: string }[] }
    }
    expect(body.readiness.items.find((item) => item.id === "examples")?.level).toBe("missing")
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
      targetLang: string
      drafts: { draftId: string; cellId: string; text: string }[]
    }
    expect(payload.fileId).toBe(FILE)
    expect(payload.targetLang).toBe("")
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

describe("sweepStrandedContextualRuns", () => {
  it("adopts a run whose driver died and drives it to completion", async () => {
    const { contrib } = await seedWorld()
    // Start a run, then leave it mid-flight: 'running' with a quiet heartbeat
    // and spans still on the cursor is exactly what a dead Worker request
    // leaves behind, and `resumeRun` refuses that state.
    const runId = await startRun(contrib)
    await env.AQUILLA_PG.prepare(
      `UPDATE contextual_runs
          SET status = 'running', span_cursor = jsonb_set(span_cursor, '{nextIndex}', '0'),
              updated_at = now() - interval '1 hour'
        WHERE id = ?`,
    )
      .bind(runId)
      .run()

    const sweep = await sweepStrandedContextualRuns(testEnv as unknown as Parameters<typeof sweepStrandedContextualRuns>[0])
    expect(sweep.adopted).toBeGreaterThanOrEqual(1)
    // `done` is the caller's contract: the cron must not close the shared
    // Postgres connection until every adopted loop has finished with it.
    await sweep.done
    _test.lastLoop = null

    const after = await getRun(env.AQUILLA_PG, runId)
    expect(after?.status).toBe("parked")
  })

  it("adopts nothing when every run has a live heartbeat", async () => {
    const { contrib } = await seedWorld()
    await startRun(contrib)
    const sweep = await sweepStrandedContextualRuns(testEnv as unknown as Parameters<typeof sweepStrandedContextualRuns>[0])
    await sweep.done
    expect(sweep.adopted).toBe(0)
  })
})
