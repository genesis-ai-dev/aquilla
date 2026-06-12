// POST /api/v1/ai/agent/run — end-to-end loop against a scripted OpenRouter.
//
// WHY: the wire contract (SSE frames, tool plumbing, proposal shape) is what
// the client slice builds against byte-for-byte; these tests freeze it. The
// scripted model exercises the full loop: sql → compressed block fed back to
// the model → emit → proposal frame → final prose → done, plus the
// agent_runs ledger and the iteration cap.

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const PROJECT = "11111111-1111-4111-8111-111111111111"
const FILE = "22222222-2222-4222-8222-222222222222"
const CELL = "33333333-3333-4333-8333-333333333333"
const SOURCE_HEAD = "44444444-4444-4444-8444-444444444444"
const TARGET_HEAD = "55555555-5555-4555-8555-555555555555"

interface Frame {
  type: string
  [key: string]: unknown
}

function parseFrames(sse: string): Frame[] {
  return sse
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice("data: ".length)) as Frame)
}

/** Seed alice (contributor, NOT creator) on a project with one cell pair. */
async function seedProjectWorld() {
  await seedUser(1, "alice")
  await seedUser(2, "boss")
  await env.AQUILLA_PG.prepare(
    `INSERT INTO projects (id, name, created_by) VALUES (?, 'Test Project', 2)`,
  )
    .bind(PROJECT)
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES (?, 1, 400)`,
  )
    .bind(PROJECT)
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
     VALUES (?, ?, ?, 'source', 'In the beginning', 'GEN 1:1', ?, 0),
            (?, ?, ?, 'target', '', 'GEN 1:1', ?, 0)`,
  )
    .bind(PROJECT, FILE, CELL, SOURCE_HEAD, PROJECT, FILE, CELL, TARGET_HEAD)
    .run()
}

function modelTurn(message: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      choices: [{ message }],
      usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )
}

function toolCall(id: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id, type: "function", function: { name: "execute", arguments: JSON.stringify(args) } },
    ],
  }
}

function testEnv() {
  return Object.assign(Object.create(env), { OPENROUTER_API_KEY: "test-key" })
}

async function postRun(jwt: string, body?: Record<string, unknown>) {
  return app.request(
    "/api/v1/ai/agent/run",
    {
      method: "POST",
      headers: authHeader(jwt),
      body: JSON.stringify(
        body ?? {
          projectId: PROJECT,
          messages: [{ role: "user", content: "Draft the empty verses in this chapter" }],
          context: { fileId: FILE },
        },
      ),
    },
    testEnv(),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("POST /api/v1/ai/agent/run — access control", () => {
  it("401 when unauthenticated", async () => {
    const res = await app.request(
      "/api/v1/ai/agent/run",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      testEnv(),
    )
    expect(res.status).toBe(401)
  })

  it("403 for a non-member — the agent never acts without a project role", async () => {
    await seedProjectWorld()
    await seedUser(3, "stranger")
    const res = await postRun(await jwtFor("stranger"))
    expect(res.status).toBe(403)
  })
})

describe("POST /api/v1/ai/agent/run — scripted full loop", () => {
  it("sql → compressed block → emit → proposal frame → done", async () => {
    await seedProjectWorld()
    const jwt = await jwtFor("alice")

    const upstreamBodies: { messages: { role: string; content: string }[] }[] = []
    const script = [
      // Turn 1: model reads the chapter.
      toolCall("tc1", {
        sql: "SELECT cell_id, value, canonical_ref FROM cells WHERE project_id = :project AND file_id = :file AND side = 'target' AND value = ''",
      }),
      // Turn 2: model drafts, addressing the cell by its alias.
      toolCall("tc2", {
        emit: [
          { kind: "target.cell.commit", fileId: ":file", cellId: "#c1", payload: { value: "Ɓǝrēšît drafted" } },
        ],
      }),
      // Turn 3: final prose, no tool calls → run completes.
      { role: "assistant", content: "Staged 1 draft for GEN 1:1 — review and apply." },
    ]
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      upstreamBodies.push(JSON.parse(String(init?.body)))
      return modelTurn(script.shift()!)
    })

    const res = await postRun(jwt)
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("text/event-stream")

    const frames = parseFrames(await res.text())
    const types = frames.map((f) => f.type)

    // Frame sequence per the wire contract.
    expect(types[0]).toBe("run_start")
    expect(types).toEqual([
      "run_start",
      "code_start", // sql
      "code_result",
      "code_start", // emit
      "proposal",
      "code_result",
      "assistant_delta",
      "usage",
      "done",
    ])

    const runId = frames[0].runId as string

    // The model's 2nd request saw the COMPRESSED pipe table with the alias.
    const toolMsg1 = upstreamBodies[1].messages.find((m) => m.role === "tool")!
    expect(toolMsg1.content).toContain("cell_id|value|canonical_ref")
    expect(toolMsg1.content).toContain("#c1")
    expect(toolMsg1.content).not.toContain(CELL) // UUIDs never reach the model

    // The system prompt is role-filtered for a contributor.
    const sysMsg = upstreamBodies[0].messages[0]
    expect(sysMsg.role).toBe("system")
    expect(sysMsg.content).toContain("target.cell.commit")
    expect(sysMsg.content).not.toContain("assignment.create")

    // Proposal frame: resolved ids + provenance, per the staged-event contract.
    const proposalFrame = frames.find((f) => f.type === "proposal")!
    const proposal = proposalFrame.proposal as {
      proposalId: string
      runId: string
      summary: string
      events: {
        kind: string
        fileId: string
        cellId: string
        parentId: string
        payload: Record<string, unknown>
        display: { canonicalRef?: string; before?: string; after?: string }
      }[]
    }
    expect(proposal.runId).toBe(runId)
    expect(proposal.events).toHaveLength(1)
    const staged = proposal.events[0]
    expect(staged.kind).toBe("target.cell.commit")
    expect(staged.fileId).toBe(FILE) // :file resolved
    expect(staged.cellId).toBe(CELL) // #c1 resolved
    expect(staged.parentId).toBe(TARGET_HEAD)
    expect(staged.payload.ai_suggestion).toBe(true)
    expect(staged.payload.agent_run_id).toBe(runId)
    expect(staged.payload.sourceEventId).toBe(SOURCE_HEAD)
    expect(staged.display).toEqual({ canonicalRef: "GEN 1:1", before: "", after: "Ɓǝrēšît drafted" })

    // Model saw the verdict block after the emit.
    const toolMsg2 = upstreamBodies[2].messages.filter((m) => m.role === "tool")[1]
    expect(toolMsg2.content).toContain("staged")

    // Final prose surfaced as assistant_delta; usage totals accumulated.
    expect(frames.find((f) => f.type === "assistant_delta")!.text).toContain("Staged 1 draft")
    const usage = frames.find((f) => f.type === "usage")!
    expect(usage.promptTokens).toBe(300)
    expect(usage.completionTokens).toBe(150)
    expect(usage.costCents).toBeCloseTo(0.3)

    const done = frames.find((f) => f.type === "done")!
    expect(done).toEqual({ type: "done", runId, status: "ok" })

    // agent_runs ledger finalised.
    const run = await env.AQUILLA_PG.prepare("SELECT * FROM agent_runs WHERE run_id = ?")
      .bind(runId)
      .first<Record<string, unknown>>()
    expect(run).not.toBeNull()
    expect(run!.status).toBe("ok")
    expect(run!.steps).toBe(2)
    expect(run!.prompt_tokens).toBe(300)
    expect(run!.project_id).toBe(PROJECT)
    expect(run!.username).toBe("alice")
    expect(run!.prompt).toBe("Draft the empty verses in this chapter")
    expect(run!.ended_at).not.toBeNull()
  })

  it("feeds guard rejections back to the model instead of failing the run", async () => {
    await seedProjectWorld()
    const jwt = await jwtFor("alice")

    const upstreamBodies: { messages: { role: string; content: string }[] }[] = []
    const script = [
      toolCall("tc1", { sql: "DELETE FROM cells WHERE project_id = :project" }),
      { role: "assistant", content: "I can't run that." },
    ]
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      upstreamBodies.push(JSON.parse(String(init?.body)))
      return modelTurn(script.shift()!)
    })

    const res = await postRun(jwt)
    const frames = parseFrames(await res.text())
    const codeResult = frames.find((f) => f.type === "code_result")!
    expect(codeResult.ok).toBe(false)
    expect(String(codeResult.summary)).toContain("only a single SELECT")
    // The rejection reached the model as the tool result…
    const toolMsg = upstreamBodies[1].messages.find((m) => m.role === "tool")!
    expect(toolMsg.content).toContain("only a single SELECT")
    // …and the run still ends cleanly.
    expect(frames.find((f) => f.type === "done")!.status).toBe("ok")
  })

  it("caps a runaway model at 12 sql/emit iterations with done:capped (docs-only rounds are free)", async () => {
    await seedProjectWorld()
    const jwt = await jwtFor("alice")

    let calls = 0
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++
      return modelTurn(
        toolCall(`tc${calls}`, {
          sql: "SELECT count(*) FROM cells WHERE project_id = :project",
        }),
      )
    })

    const res = await postRun(jwt)
    const frames = parseFrames(await res.text())
    expect(calls).toBe(12) // 12 sql model turns, each returning a tool call
    expect(frames.filter((f) => f.type === "code_result")).toHaveLength(12)
    expect(frames.find((f) => f.type === "error")!.message).toContain("Tool-iteration cap")
    expect(frames.find((f) => f.type === "done")!.status).toBe("capped")

    const run = await env.AQUILLA_PG.prepare("SELECT status, steps FROM agent_runs")
      .first<{ status: string; steps: number }>()
    expect(run!.status).toBe("capped")
    expect(run!.steps).toBe(12)
  })

  it("surfaces upstream failure as error frame + done:error + ledger status", async () => {
    await seedProjectWorld()
    const jwt = await jwtFor("alice")
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 502 }))

    const res = await postRun(jwt)
    const frames = parseFrames(await res.text())
    expect(frames.find((f) => f.type === "error")!.message).toContain("openrouter_error 502")
    expect(frames.find((f) => f.type === "done")!.status).toBe("error")

    const run = await env.AQUILLA_PG.prepare("SELECT status FROM agent_runs")
      .first<{ status: string }>()
    expect(run!.status).toBe("error")
  })
})
