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
import { ensureAgentMemoryTables } from "./helpers/agent-memory-schema"

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
  await ensureAgentMemoryTables()
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
      "run_code",
      "load_artifact",
      "read_sandbox_file",
      "plan_import",
      "propose_memory",
      "propose_brief_update",
      "read_memory",
    ]) {
      expect(toolNames).toContain(name)
    }

    // read_memory dispatched → its result reached the model on the next turn.
    const toolMsg = upstreamBodies[1].messages.find((m) => m.role === "tool")!
    expect(toolMsg.content).toContain("No approved memories")

    // The run settled ok with a done frame.
    expect(frames.find((f) => f.type === "done")).toMatchObject({ status: "ok" })
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
    expect(exhausted).toMatchObject({ capCents: 5 })
    expect((exhausted!.spentCents as number)).toBeGreaterThanOrEqual(5)
    expect(frames.find((f) => f.type === "done")).toMatchObject({ status: "capped" })
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
})
