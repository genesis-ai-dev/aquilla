// AQU-AGENT §2/§4 — the harness route end-to-end: new tools are registered and
// dispatched, the cost cap halts a run gracefully, and the untrusted-content
// guard blocks memory writes mid-turn.
//
// WHY: agent.ts is the integration seam — unit tests prove each module, but only
// a route test proves the loop wires them together: the tools reach the model,
// the budget frames fire, and dispatch routes to the right handler.
import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const PROJECT = "11111111-1111-4111-8111-111111111111"

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

async function seedWorld() {
  await seedUser(1, "alice")
  await seedUser(2, "boss")
  await env.AQUILLA_PG.prepare(`INSERT INTO projects (id, name, created_by) VALUES (?, 'P', 2)`)
    .bind(PROJECT)
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES (?, 1, 400)`,
  )
    .bind(PROJECT)
    .run()
}

/** A scripted OpenRouter turn with a controllable per-turn cost (dollars). */
function modelTurn(message: Record<string, unknown>, cost = 0.001) {
  return new Response(
    JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5, cost } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  }
}

function testEnv(extra?: Record<string, unknown>) {
  return Object.assign(Object.create(env), { OPENROUTER_API_KEY: "test-key" }, extra)
}

async function postRun(jwt: string, body: Record<string, unknown>, extra?: Record<string, unknown>) {
  return app.request(
    "/api/v1/ai/agent/run",
    { method: "POST", headers: authHeader(jwt), body: JSON.stringify(body) },
    testEnv(extra),
  )
}

afterEach(() => vi.restoreAllMocks())

describe("agent route — harness tool registration & dispatch", () => {
  it("serves the new tools to the model and dispatches read_memory", async () => {
    await seedWorld()
    const jwt = await jwtFor("alice")

    const upstreamBodies: { tools?: { function: { name: string } }[]; messages: { role: string; content: string }[] }[] = []
    const script = [
      toolCall("t1", "read_memory", {}),
      { role: "assistant", content: "No memories yet." },
    ]
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      upstreamBodies.push(JSON.parse(String(init?.body)))
      return modelTurn(script.shift()!)
    })

    const res = await postRun(jwt, {
      projectId: PROJECT,
      messages: [{ role: "user", content: "What do you know?" }],
    })
    expect(res.status).toBe(200)
    const frames = parseFrames(await res.text())

    // Tool registration: the served tool list carries every new harness tool.
    const toolNames = (upstreamBodies[0].tools ?? []).map((t) => t.function.name)
    for (const name of [
      "focus",
      "run_code",
      "load_artifact",
      "read_sandbox_file",
      "propose_memory",
      "propose_brief_update",
      "read_memory",
    ]) {
      expect(toolNames).toContain(name)
    }
    expect(toolNames).not.toContain("plan_import")

    // read_memory dispatched → its result reached the model on the next turn.
    const toolMsg = upstreamBodies[1].messages.find((m) => m.role === "tool")!
    expect(toolMsg.content).toContain("No approved memories")

    // The run settled ok with a done frame.
    expect(frames.find((f) => f.type === "done")).toMatchObject({ status: "ok" })
  })

  it("focuses a verified project file and rebinds later tools in the same run", async () => {
    await seedWorld()
    const jwt = await jwtFor("alice")
    const fileId = "33333333-3333-4333-8333-333333333333"
    const cellId = "44444444-4444-4444-8444-444444444444"
    await env.AQUILLA_PG.prepare(
      "INSERT INTO files (id, project_id, name, book_code, event_id) VALUES (?, ?, 'Mark.usfm', 'MRK', 'file-event')",
    ).bind(fileId, PROJECT).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
       VALUES (?, ?, ?, 'source', 'The beginning', 'MRK 1:1', 'source-event', 0),
              (?, ?, ?, 'target', '', 'MRK 1:1', 'target-event', 0)`,
    ).bind(PROJECT, fileId, cellId, PROJECT, fileId, cellId).run()

    const focusThenRead = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "f1", type: "function", function: { name: "focus", arguments: JSON.stringify({ fileName: "Mark" }) } },
        { id: "r1", type: "function", function: { name: "read", arguments: JSON.stringify({ fileId: ":file" }) } },
      ],
    }
    const script: Record<string, unknown>[] = [focusThenRead, { role: "assistant", content: "Mark is open." }]
    const upstreamBodies: { messages: { role: string; content: string; tool_call_id?: string }[] }[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      upstreamBodies.push(JSON.parse(String(init?.body)))
      return modelTurn(script.shift()!)
    })

    const res = await postRun(jwt, {
      projectId: PROJECT,
      messages: [{ role: "user", content: "Open Mark and show me what is there" }],
    })
    const frames = parseFrames(await res.text())

    expect(frames.find((frame) => frame.type === "focus_changed")).toMatchObject({
      fileId,
      fileName: "Mark.usfm",
    })
    const readResult = upstreamBodies[1].messages.find((message) => message.tool_call_id === "r1")
    expect(readResult?.content).toContain("The beginning")
  })

  it("emits a budget meter and halts with budget.exhausted at the cost cap", async () => {
    await seedWorld()
    const jwt = await jwtFor("alice")

    // Each turn costs $0.10 = 10 cents; cap is 5 cents → after turn 1 the loop
    // halts at the top of turn 2 before another paid call.
    const script = [
      toolCall("t1", "read_memory", {}), // free tool keeps the loop going
      toolCall("t2", "read_memory", {}),
    ]
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => modelTurn(script.shift() ?? { role: "assistant", content: "done" }, 0.1))

    const res = await postRun(
      jwt,
      { projectId: PROJECT, messages: [{ role: "user", content: "loop" }] },
      { AGENT_RUN_COST_CAP_CENTS: "5" },
    )
    const frames = parseFrames(await res.text())

    expect(frames.some((f) => f.type === "budget")).toBe(true)
    const exhausted = frames.find((f) => f.type === "budget.exhausted")
    expect(exhausted).toBeDefined()
    // Frames carry CREDITS: cap 5¢ × agentMarkup 5 = 25 cr; spend ≥ cap.
    expect(exhausted).toMatchObject({ capCredits: 25 })
    expect((exhausted!.spentCredits as number)).toBeGreaterThanOrEqual(25)
    expect(frames.find((f) => f.type === "done")).toMatchObject({ status: "capped" })
  })

  it("blocks propose_memory in the same turn after read_sandbox_file (untrusted guard, authz-M2)", async () => {
    await seedWorld()
    const jwt = await jwtFor("alice")

    // read_sandbox_file THEN propose_memory in one turn. read_sandbox_file marks
    // the turn untrusted (even though the sandbox is unconfigured in tests) →
    // propose_memory must return the guard message.
    const twoCalls = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "t1", type: "function", function: { name: "read_sandbox_file", arguments: JSON.stringify({ path: "/workspace/out.txt" }) } },
        { id: "t2", type: "function", function: { name: "propose_memory", arguments: JSON.stringify({ path: "observations/x.md", content: "note", rationale: "why" }) } },
      ],
    }
    const script: Record<string, unknown>[] = [twoCalls, { role: "assistant", content: "ok" }]
    const upstreamBodies: { messages: { role: string; content: string; tool_call_id?: string }[] }[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      upstreamBodies.push(JSON.parse(String(init?.body)))
      return modelTurn(script.shift()!)
    })

    const res = await postRun(jwt, {
      projectId: PROJECT,
      messages: [{ role: "user", content: "read and remember" }],
    })
    const frames = parseFrames(await res.text())

    const toolMsgs = upstreamBodies[1].messages.filter((m) => m.role === "tool")
    const memResult = toolMsgs.find((m) => m.tool_call_id === "t2")!
    expect(memResult.content).toContain("memory writes disabled while processing untrusted content")
    expect(frames.some((f) => f.type === "memory.proposed")).toBe(false)
  })

  it("carries the untrusted lock across runs on the same session (races-F2)", async () => {
    await seedWorld()
    const jwt = await jwtFor("alice")
    const sessionId = "22222222-2222-4222-8222-222222222222"

    // Run 1: a turn uses read_sandbox_file (untrusted) then finishes. The session
    // must persist untrusted_active=true.
    const run1Script: Record<string, unknown>[] = [
      toolCall("r1t1", "read_sandbox_file", { path: "/workspace/a.txt" }),
      { role: "assistant", content: "done run 1" },
    ]
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => modelTurn(run1Script.shift()!))
    const res1 = await postRun(jwt, {
      projectId: PROJECT,
      sessionId,
      messages: [{ role: "user", content: "read a file" }],
    })
    expect(res1.status).toBe(200)
    await res1.text()
    vi.restoreAllMocks()

    const flag = await env.AQUILLA_PG.prepare(
      "SELECT untrusted_active FROM agent_sessions WHERE session_id = ?",
    )
      .bind(sessionId)
      .first<{ untrusted_active: boolean }>()
    expect(flag?.untrusted_active).toBe(true)

    // Run 2 on the SAME session: the FIRST turn calls propose_memory. Because the
    // session started locked, the write is blocked before any clean turn.
    const run2Script: Record<string, unknown>[] = [
      toolCall("r2t1", "propose_memory", { path: "observations/y.md", content: "note", rationale: "why" }),
      { role: "assistant", content: "done run 2" },
    ]
    const upstreamBodies: { messages: { role: string; content: string; tool_call_id?: string }[] }[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      upstreamBodies.push(JSON.parse(String(init?.body)))
      return modelTurn(run2Script.shift()!)
    })
    const res2 = await postRun(jwt, {
      projectId: PROJECT,
      sessionId,
      messages: [{ role: "user", content: "remember this" }],
    })
    const frames2 = parseFrames(await res2.text())

    const toolMsg = upstreamBodies[1].messages.find((m) => m.tool_call_id === "r2t1")!
    expect(toolMsg.content).toContain("memory writes disabled while processing untrusted content")
    expect(frames2.some((f) => f.type === "memory.proposed")).toBe(false)
  })

  it("blocks propose_memory in the same turn after run_code (untrusted guard)", async () => {
    await seedWorld()
    const jwt = await jwtFor("alice")

    // One assistant turn calling run_code THEN propose_memory. run_code marks
    // the turn untrusted → propose_memory returns validation_failed.
    const twoCalls = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "t1", type: "function", function: { name: "run_code", arguments: JSON.stringify({ language: "python", code: "x=1" }) } },
        { id: "t2", type: "function", function: { name: "propose_memory", arguments: JSON.stringify({ path: "observations/x.md", content: "note", rationale: "why" }) } },
      ],
    }
    const script: Record<string, unknown>[] = [twoCalls, { role: "assistant", content: "ok" }]
    const upstreamBodies: { messages: { role: string; content: string; tool_call_id?: string }[] }[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      upstreamBodies.push(JSON.parse(String(init?.body)))
      return modelTurn(script.shift()!)
    })

    const res = await postRun(jwt, {
      projectId: PROJECT,
      messages: [{ role: "user", content: "parse and remember" }],
    })
    const frames = parseFrames(await res.text())

    // The propose_memory tool-result fed back to the model is the guard message.
    const toolMsgs = upstreamBodies[1].messages.filter((m) => m.role === "tool")
    const memResult = toolMsgs.find((m) => m.tool_call_id === "t2")!
    expect(memResult.content).toContain("memory writes disabled while processing untrusted content")
    // No memory.proposed frame emitted (the write was blocked).
    expect(frames.some((f) => f.type === "memory.proposed")).toBe(false)
  })

  it("re-checks the budget mid-turn: a second expensive tool never runs once the cap trips (races-F3)", async () => {
    await seedWorld()
    const jwt = await jwtFor("alice")
    // Draft needs an untranslated cell in scope to reach its (paid) model call.
    const FILE = "33333333-3333-4333-8333-333333333333"
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at)
       VALUES (?, ?, 'c1', 'source', 'In the beginning', 'GEN 1:1', 'ev-s', 0),
              (?, ?, 'c1', 'target', '', 'GEN 1:1', 'ev-t', 0)`,
    )
      .bind(PROJECT, FILE, PROJECT, FILE)
      .run()

    // One assistant turn issuing TWO draft calls. Draft is budgeted and folds its
    // internal model-call cost via addUsage — so after the FIRST draft the run is
    // over budget and the SECOND draft must be skipped.
    const twoDrafts = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "d1", type: "function", function: { name: "draft", arguments: JSON.stringify({ fileId: FILE }) } },
        { id: "d2", type: "function", function: { name: "draft", arguments: JSON.stringify({ fileId: FILE }) } },
      ],
    }

    let agentTurns = 0
    let draftCalls = 0
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { tools?: unknown }
      if (body.tools) {
        // Main agent turn: cheap; hands back the two-draft turn once, then prose.
        agentTurns++
        return modelTurn(agentTurns === 1 ? twoDrafts : { role: "assistant", content: "done" }, 0.001)
      }
      // Draft's internal model call: EXPENSIVE (10 cents) → trips the 5-cent cap.
      draftCalls++
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "1. traducción" } }], usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.1 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    })

    const res = await postRun(
      jwt,
      { projectId: PROJECT, context: { fileId: FILE }, messages: [{ role: "user", content: "draft twice" }] },
      { AGENT_RUN_COST_CAP_CENTS: "5" },
    )
    const frames = parseFrames(await res.text())

    // Exactly ONE draft internal call ran — the second was skipped by the mid-turn
    // budget re-check.
    expect(draftCalls).toBe(1)
    expect(frames.find((f) => f.type === "budget.exhausted")).toBeDefined()
    expect(frames.find((f) => f.type === "done")).toMatchObject({ status: "capped" })
  })
})
