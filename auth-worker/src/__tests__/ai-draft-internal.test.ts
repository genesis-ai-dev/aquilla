// POST /api/v1/ai/agent/internal/draft-cells (AQU-1186) — the server-to-server
// drafting endpoint the external Agent API's DraftCells command calls.
//
// WHY these behaviours are pinned: this endpoint is the ONLY place the copilot
// spends money on behalf of an agent, so its rails are the feature's cost
// contract — a shared-secret door, a live role check, a credit pre-flight that
// runs BEFORE any paid call, the project's configured batch cap, and a
// return-drafts-never-write shape that keeps the approval gate meaningful.

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import app from "../index"
import { seedUser } from "./helpers/db"

const PROJECT = "proj-draft-1"

const denv = {
  ...env,
  OPENROUTER_API_KEY: "test-openrouter-key",
  // Point the drafting model at a URL the fetch mock recognises.
  OPENROUTER_BASE_URL: "https://mock-openrouter",
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Two-phase drafting: call 1 = research, call 2 = the {i,t} JSON array. */
function mockDraftModel(translations: string[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> })
    const isResearch = calls.length === 1
    return Response.json({
      choices: [
        {
          message: {
            content: isResearch
              ? "Evidence: preserve every proposition."
              : JSON.stringify(translations.map((t, i) => ({ i: i + 1, t }))),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 },
    })
  }))
  return calls
}

async function seedProject(opts: { roleLevel: number; settings?: Record<string, unknown>; cells?: number } = { roleLevel: 400 }) {
  const cellCount = opts.cells ?? 2
  await seedUser(1, "alice")
  // The creator holds OWNER regardless of any membership row, so the acting
  // user (1) must NOT be the creator — otherwise a role floor can't be tested.
  await seedUser(9, "creator")
  await env.AQUILLA_PG.prepare(`INSERT INTO projects (id, name, created_by) VALUES (?, 'P', 9)`)
    .bind(PROJECT)
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES (?, 1, ?)`,
  )
    .bind(PROJECT, opts.roleLevel)
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, event_id) VALUES ('file-d', ?, 'Mark', ?)`,
  )
    .bind(PROJECT, crypto.randomUUID())
    .run()
  for (let i = 1; i <= cellCount; i++) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at)
       VALUES (?, 'file-d', ?, 'source', ?, ?, 0)`,
    )
      .bind(PROJECT, `c${i}`, `source ${i}`, crypto.randomUUID())
      .run()
  }
  if (opts.settings) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_settings (project_id, settings, version, updated_by, updated_at)
       VALUES (?, ?::text::jsonb, 1, 1, now())`,
    )
      .bind(PROJECT, JSON.stringify(opts.settings))
      .run()
  }
}

function draftReq(auth: string, body: unknown) {
  return app.request(
    "/api/v1/ai/agent/internal/draft-cells",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(body),
    },
    denv,
  )
}

const baseBody = { projectId: PROJECT, userId: 1, fileId: "file-d", cellIds: ["c1", "c2"] }

describe("POST /api/v1/ai/agent/internal/draft-cells", () => {
  it("rejects a wrong bearer before doing anything", async () => {
    const calls = mockDraftModel(["x"])
    const res = await draftReq("Bearer wrong", baseBody)
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it("returns drafts with ai_draft provenance and never writes a cell", async () => {
    await seedProject({ roleLevel: 400 })
    const calls = mockDraftModel(["borrador uno", "borrador dos"])

    const res = await draftReq(`Bearer ${env.SYNC_SECRET_KEY}`, baseBody)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      drafts: { cellId: string; value: string; aiDraft: { model: string; mode: string } }[]
      model: string
    }
    expect(body.drafts.map((d) => d.cellId)).toEqual(["c1", "c2"])
    expect(body.drafts.map((d) => d.value)).toEqual(["borrador uno", "borrador dos"])
    expect(body.drafts[0].aiDraft.model).toBe(body.model)
    expect(body.drafts[0].aiDraft.mode).toBe("agent")

    // Research + generation: two paid calls, no more.
    expect(calls).toHaveLength(2)

    // The endpoint returns text; it does not commit. No target cell exists.
    const targets = await env.AQUILLA_PG.prepare(
      `SELECT count(*)::int AS n FROM cells WHERE project_id = ? AND side = 'target'`,
    )
      .bind(PROJECT)
      .first<{ n: number }>()
    expect(targets?.n).toBe(0)
    const events = await env.AQUILLA_PG.prepare(
      `SELECT count(*)::int AS n FROM events WHERE project_id = ?`,
    )
      .bind(PROJECT)
      .first<{ n: number }>()
    expect(events?.n).toBe(0)
  })

  it("denies a caller below the contributor floor without spending", async () => {
    await seedProject({ roleLevel: 100 })
    const calls = mockDraftModel(["never"])

    const res = await draftReq(`Bearer ${env.SYNC_SECRET_KEY}`, baseBody)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe("permission_denied")
    expect(calls).toHaveLength(0)
  })

  it("rejects a request past the project's configured batch size, naming the cap", async () => {
    await seedProject({ roleLevel: 400, settings: { completionSettings: { completionBatchSize: 2 } }, cells: 4 })
    const calls = mockDraftModel(["never"])

    const res = await draftReq(`Bearer ${env.SYNC_SECRET_KEY}`, {
      ...baseBody,
      cellIds: ["c1", "c2", "c3"],
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as { cap: number }).toMatchObject({ error: "validation_failed", cap: 2 })
    expect(calls).toHaveLength(0)
  })

  it("rejects an empty cellIds list (no 'draft everything' shape)", async () => {
    await seedProject({ roleLevel: 400 })
    const res = await draftReq(`Bearer ${env.SYNC_SECRET_KEY}`, { ...baseBody, cellIds: [] })
    expect(res.status).toBe(400)
  })

  it("meters the run against the org's credit ledger on the agent rail", async () => {
    await seedUser(2, "orgowner")
    await env.AQUILLA_PG.prepare(
      `INSERT INTO organizations (id, name, owner_user_id) VALUES (42, 'Org', 2)`,
    ).run()
    await seedUser(1, "alice")
    await env.AQUILLA_PG.prepare(`INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'P', 42, 1)`)
      .bind(PROJECT)
      .run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_members (project_id, user_id, role_level) VALUES (?, 1, 400)`,
    )
      .bind(PROJECT)
      .run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO files (id, project_id, name, event_id) VALUES ('file-d', ?, 'Mark', ?)`,
    )
      .bind(PROJECT, crypto.randomUUID())
      .run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at)
       VALUES (?, 'file-d', 'c1', 'source', 'source 1', ?, 0)`,
    )
      .bind(PROJECT, crypto.randomUUID())
      .run()
    mockDraftModel(["uno"])

    const res = await draftReq(`Bearer ${env.SYNC_SECRET_KEY}`, { ...baseBody, cellIds: ["c1"] })
    expect(res.status).toBe(200)

    const ledger = await env.AQUILLA_PG.prepare(
      `SELECT rail, raw_cost_cents FROM org_credit_usage_daily WHERE org_id = 42`,
    ).first<{ rail: string; raw_cost_cents: number }>()
    expect(ledger?.rail).toBe("agent")
    // Two model calls at cost 0.0001 each → 0.02 cents raw.
    expect(Number(ledger?.raw_cost_cents)).toBeCloseTo(0.02, 4)
  })
})
