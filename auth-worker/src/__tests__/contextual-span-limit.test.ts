// The next-step span limit (routes/contextual.ts + lib/contextual/tick.ts +
// db/shared/contextual-runs.ts, 2026-08-28 social-workspace design §v3
// "Next step only").
//
// WHY these assertions: `spanLimit` is a STOP control — "translate the next
// passage, then I look" — and a stop control has exactly two ways to be wrong.
// It can fail to stop (the run drafts the whole book anyway), or it can stop
// and then quietly restart, because the 5-minute sweeper's whole job is waking
// parked runs that still have spans on their cursor — which is precisely the
// shape a span-limited run leaves behind. Both are pinned here, against the
// real pipeline, alongside the unlimited control that proves the file really
// did have more work to do.

import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { _test } from "../routes/contextual"
import { authHeader, jwtFor, seedUser } from "./helpers/db"
import {
  claimStrandedRuns,
  getRun,
  spanLimitReached,
  type ContextualRun,
} from "../../../db/shared/contextual-runs"
import { scriptMockResponse } from "../../../scripts/mock-openrouter"

const PROJECT = "proj-span-limit"
const FILE = "file-span-limit"
const MOCK_BASE = "http://mock.local/api/v1"

const testEnv = env as typeof env & { OPENROUTER_BASE_URL?: string }
const realFetch = globalThis.fetch

let contrib: string

beforeEach(async () => {
  testEnv.OPENROUTER_API_KEY = "mock"
  testEnv.OPENROUTER_BASE_URL = MOCK_BASE
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === `${MOCK_BASE}/chat/completions`) {
      const body = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: string }[]
      }
      return new Response(JSON.stringify(scriptMockResponse(body.messages)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (url.includes("/admin/projects/")) return new Response("{}", { status: 200 })
    throw new Error(`unexpected fetch in span-limit test: ${url}`)
  })

  await seedUser(1, "lead")
  await seedUser(2, "contrib")
  contrib = await jwtFor("contrib")
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, 1)")
    .bind(PROJECT, "Span Limit")
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, 2, 400, 1)",
  )
    .bind(PROJECT)
    .run()
  // Four chapters → four derived spans, one span per wave at this size, so
  // "after the first span settles" is observable.
  for (const [cellId, ref, text] of [
    ["s1", "MRK 1:1", "In the beginning"],
    ["s2", "MRK 2:1", "Some days later"],
    ["s3", "MRK 3:1", "He went out again"],
    ["s4", "MRK 4:1", "Again he began to teach"],
  ] as const) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
       VALUES (?, ?, ?, 'source', ?, ?, ?, 0)`,
    )
      .bind(PROJECT, FILE, cellId, text, ref, `ev-${cellId}`)
      .run()
  }
})

afterEach(async () => {
  if (_test.lastLoop) await _test.lastLoop
  _test.lastLoop = null
  testEnv.OPENROUTER_API_KEY = undefined
  delete testEnv.OPENROUTER_BASE_URL
  vi.stubGlobal("fetch", realFetch)
})

async function startRun(body: Record<string, unknown>): Promise<Response> {
  return app.request(
    `/api/v2/projects/${PROJECT}/contextual/runs`,
    { method: "POST", headers: authHeader(contrib), body: JSON.stringify(body) },
    env,
  )
}

async function startAndSettle(body: Record<string, unknown>): Promise<string> {
  const res = await startRun(body)
  expect(res.status).toBe(201)
  const { runId } = (await res.json()) as { runId: string }
  if (_test.lastLoop) await _test.lastLoop
  _test.lastLoop = null
  return runId
}

async function loadRun(runId: string): Promise<ContextualRun> {
  const run = await getRun(env.AQUILLA_PG, runId)
  if (!run) throw new Error(`run ${runId} vanished`)
  return run
}

/** A run row with only the counters the predicate reads varied. */
function runWith(fields: Pick<ContextualRun, "doneSpans" | "failedSpans" | "spanLimit">): ContextualRun {
  return {
    id: "run-under-test",
    projectId: PROJECT,
    fileId: FILE,
    targetLang: "",
    status: "running",
    initiatedBy: null,
    roleSnapshot: null,
    spanCursor: null,
    totalSpans: 4,
    unitsSpent: 0,
    callsSpent: 0,
    lastError: null,
    steeringCursor: null,
    blockedOnDecisionId: null,
    anchorCellId: null,
    scopeGroup: null,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    ...fields,
  }
}

describe("spanLimit", () => {
  it("parks after the first span settles, with work still on the cursor", async () => {
    const runId = await startAndSettle({ fileId: FILE, spanLimit: 1 })

    const run = await loadRun(runId)
    expect(run.spanLimit).toBe(1)
    expect(run.status).toBe("parked")
    expect(run.doneSpans + run.failedSpans).toBe(1)
    // The point of the control: the file was NOT finished.
    expect(run.spanCursor?.nextIndex).toBe(1)
    expect(run.spanCursor?.seeds.length).toBe(4)
    expect(spanLimitReached(run)).toBe(true)
  })

  it("drafts the whole file when no limit is given", async () => {
    const runId = await startAndSettle({ fileId: FILE })

    const run = await loadRun(runId)
    expect(run.spanLimit).toBeNull()
    expect(run.status).toBe("parked")
    expect(run.doneSpans + run.failedSpans).toBe(4)
    expect(run.spanCursor?.nextIndex).toBe(4)
  })

  it("is sticky: the stranded-run sweeper will not wake a run that hit its limit", async () => {
    const limited = await startAndSettle({ fileId: FILE, spanLimit: 1 })
    // Age the heartbeat past the driver-stale window so the sweeper would
    // otherwise consider this parked-with-spans-left run adoptable.
    await env.AQUILLA_PG
      .prepare("UPDATE contextual_runs SET updated_at = now() - interval '1 hour' WHERE id = ?")
      .bind(limited)
      .run()

    expect(await claimStrandedRuns(env.AQUILLA_PG)).toEqual([])
    expect((await getRun(env.AQUILLA_PG, limited))?.status).toBe("parked")
  })

  it("rejects a non-positive limit at the route", async () => {
    const zero = await startRun({ fileId: FILE, spanLimit: 0 })
    expect(zero.status).toBe(400)
    const fractional = await startRun({ fileId: FILE, spanLimit: 1.5 })
    expect(fractional.status).toBe(400)
  })

  it("surfaces the limit on the run snapshot the pill hydrates from", async () => {
    await startAndSettle({ fileId: FILE, spanLimit: 2 })

    const res = await app.request(
      `/api/v2/projects/${PROJECT}/contextual/runs?fileId=${FILE}`,
      { headers: authHeader(contrib) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { run: { spanLimit: number | null; done: number } }
    expect(body.run.spanLimit).toBe(2)
    expect(body.run.done).toBe(2)
  })
})

describe("spanLimitReached", () => {
  it("is false without a limit and counts failures towards it", () => {
    expect(spanLimitReached(runWith({ doneSpans: 1, failedSpans: 1, spanLimit: null }))).toBe(false)
    // A failed span still consumed the user's "next step" — it is an outcome
    // to look at, not a free retry that silently spends another passage.
    expect(spanLimitReached(runWith({ doneSpans: 0, failedSpans: 1, spanLimit: 1 }))).toBe(true)
    expect(spanLimitReached(runWith({ doneSpans: 1, failedSpans: 1, spanLimit: 3 }))).toBe(false)
    expect(spanLimitReached(runWith({ doneSpans: 3, failedSpans: 1, spanLimit: 3 }))).toBe(true)
  })
})
