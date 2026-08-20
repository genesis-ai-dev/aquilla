// AQU-926 (COMMAND-REGISTRY §4) — the registered-command tools through the
// agent route, proving the loop wires them together: both tools are served to
// the model, propose_command is budgeted while describe_command stays free,
// the staging POST reaches sync-worker with a sync token minted for the RUN'S
// user, the changeset.staged frame carries the new optional fields, and the
// external error contract maps to readable tool errors.
//
// The sync-worker session route is built in parallel to the same contract, so
// its HTTP surface is MOCKED here (fetch is split by URL: /api/v1/changesets/
// → scripted sync-worker; everything else → scripted OpenRouter turns).
import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import { verify } from "hono/jwt"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const PROJECT = "55555555-5555-4555-8555-555555555555"
const SYNC_PREPARE_URL = `https://api.aquilla.app/sync/api/v1/changesets/${PROJECT}`

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

async function seedWorld(roleLevel = 400) {
  await seedUser(1, "alice")
  await seedUser(2, "boss")
  await env.AQUILLA_PG.prepare(`INSERT INTO projects (id, name, created_by) VALUES (?, 'P', 2)`)
    .bind(PROJECT)
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES (?, 1, ?)`,
  )
    .bind(PROJECT, roleLevel)
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

interface UpstreamBody {
  tools?: { function: { name: string } }[]
  messages: { role: string; content: string; tool_call_id?: string }[]
}

/** Split the global fetch: sync-worker prepare calls vs OpenRouter turns. */
function mockUpstreams(
  script: Record<string, unknown>[],
  syncResponder: () => Response,
  turnCost = 0.001,
) {
  const upstreamBodies: UpstreamBody[] = []
  const syncCalls: { url: string; init?: RequestInit }[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.includes("/api/v1/changesets/")) {
      syncCalls.push({ url, init })
      return syncResponder()
    }
    upstreamBodies.push(JSON.parse(String(init?.body)) as UpstreamBody)
    return modelTurn(script.shift() ?? { role: "assistant", content: "done" }, turnCost)
  })
  return { upstreamBodies, syncCalls }
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

const STAGED_RESPONSE = {
  changeset: {
    id: "cs-1",
    status: "staged",
    digest: "sha256:abc",
    summary: { translationsAdded: 1, translationsModified: 1, warnings: [] },
  },
  summary: {
    translationsAdded: 1,
    translationsModified: 1,
    warnings: [{ code: "duplicate_command", fileId: "f1", cellId: "c2", message: "last one wins" }],
  },
  digest: "sha256:abc",
  approvalUrl: "https://aquilla.app/approve/cs-1",
}

afterEach(() => vi.restoreAllMocks())

describe("agent route — registered-command tool registration", () => {
  it("serves propose_command and describe_command to the model", async () => {
    await seedWorld()
    const jwt = await jwtFor("alice")
    const { upstreamBodies } = mockUpstreams(
      [{ role: "assistant", content: "hi" }],
      () => Response.json(STAGED_RESPONSE),
    )
    const res = await postRun(jwt, {
      projectId: PROJECT,
      messages: [{ role: "user", content: "hello" }],
    })
    expect(res.status).toBe(200)
    await res.text()
    const toolNames = (upstreamBodies[0].tools ?? []).map((t) => t.function.name)
    expect(toolNames).toContain("propose_command")
    expect(toolNames).toContain("describe_command")
    // The propose_command schema teaches the review flow + describe_command.
    const proposeDef = JSON.stringify(
      (upstreamBodies[0].tools ?? []).find((t) => t.function.name === "propose_command"),
    )
    expect(proposeDef).toContain("human review")
    expect(proposeDef).toContain("describe_command")
  })

  it("renders the role-filtered command index in the system prompt", async () => {
    await seedWorld(600)
    const jwt = await jwtFor("alice")
    const { upstreamBodies } = mockUpstreams(
      [{ role: "assistant", content: "hi" }],
      () => Response.json(STAGED_RESPONSE),
    )
    await (await postRun(jwt, { projectId: PROJECT, messages: [{ role: "user", content: "hello" }] })).text()
    const systemPrompt = upstreamBodies[0].messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n")
    expect(systemPrompt).toContain("## Changeset commands")
    expect(systemPrompt).toContain("PatchSettings")
  })
})

describe("agent route — propose_command staging", () => {
  it("happy path: POSTs the commands with a token minted for the run's user, emits the frame, returns the verdict", async () => {
    await seedWorld(400)
    const jwt = await jwtFor("alice")
    const commands = [
      { kind: "SetTranslation", fileId: "f1", cellId: "c1", value: "hola" },
      { kind: "SetTranslation", fileId: "f1", cellId: "c2", value: "mundo" },
    ]
    const script = [
      toolCall("t1", "propose_command", { commands }),
      { role: "assistant", content: "staged it" },
    ]
    const { upstreamBodies, syncCalls } = mockUpstreams(script, () => Response.json(STAGED_RESPONSE))

    const res = await postRun(jwt, {
      projectId: PROJECT,
      messages: [{ role: "user", content: "stage these" }],
    })
    const frames = parseFrames(await res.text())

    // Transport: one POST to the session prepare route with the command batch.
    expect(syncCalls).toHaveLength(1)
    expect(syncCalls[0].url).toBe(SYNC_PREPARE_URL)
    expect(syncCalls[0].init?.method).toBe("POST")
    expect(JSON.parse(String(syncCalls[0].init?.body))).toEqual({ commands })

    // The bearer is a sync token minted for the RUN'S user + project (never a
    // shared secret): verifies against SYNC_SECRET_KEY with alice's identity.
    const headers = syncCalls[0].init?.headers as Record<string, string>
    const token = headers.Authorization.replace(/^Bearer /, "")
    const claims = (await verify(token, "sync-secret", "HS256")) as Record<string, unknown>
    expect(claims).toMatchObject({
      userId: 1,
      username: "alice",
      projectId: PROJECT,
      fileId: "__project__",
      role: 400,
      aud: "sync",
    })

    // Frame: changeset.staged with the AQU-926 optional fields.
    const staged = frames.find((f) => f.type === "changeset.staged")
    expect(staged).toMatchObject({
      runId: expect.any(String),
      changesetId: "cs-1",
      approvalUrl: "https://aquilla.app/approve/cs-1",
      digest: "sha256:abc",
      tier: "prepared",
      kinds: ["SetTranslation"],
      cellCount: 2,
    })

    // Verdict fed back to the model: compact JSON + the do-not-poll sentence.
    const toolMsg = upstreamBodies[1].messages.find((m) => m.role === "tool")!
    expect(toolMsg.content).toContain('"changesetId":"cs-1"')
    expect(toolMsg.content).toContain('"status":"staged"')
    expect(toolMsg.content).toContain('"digest":"sha256:abc"')
    expect(toolMsg.content).toContain("duplicate_command")
    expect(toolMsg.content).toContain("do not poll")
    expect(frames.find((f) => f.type === "done")).toMatchObject({ status: "ok" })
  })

  it("passes a model-supplied changesetId through as the idempotent body id", async () => {
    await seedWorld(400)
    const jwt = await jwtFor("alice")
    const script = [
      toolCall("t1", "propose_command", {
        commands: [{ kind: "SetTranslation", fileId: "f1", cellId: "c1", value: "hola" }],
        changesetId: "cs-client-1",
      }),
      { role: "assistant", content: "done" },
    ]
    const { syncCalls } = mockUpstreams(script, () => Response.json(STAGED_RESPONSE))
    await (await postRun(jwt, { projectId: PROJECT, messages: [{ role: "user", content: "go" }] })).text()
    expect(JSON.parse(String(syncCalls[0].init?.body))).toMatchObject({ id: "cs-client-1" })
  })

  it("maps 403 permission_denied to a readable tool error and emits no frame", async () => {
    await seedWorld(500) // PlanImport passes the static floor; server denies dynamically
    const jwt = await jwtFor("alice")
    const script = [
      toolCall("t1", "propose_command", {
        commands: [{ kind: "PlanImport", fileName: "GEN.usfm", fileType: "usfm", cells: [] }],
      }),
      { role: "assistant", content: "ok" },
    ]
    const { upstreamBodies, syncCalls } = mockUpstreams(script, () =>
      Response.json(
        { error: { code: "permission_denied", message: "PlanImport requires project_lead on this org" } },
        { status: 403 },
      ),
    )
    const res = await postRun(jwt, { projectId: PROJECT, messages: [{ role: "user", content: "import" }] })
    const frames = parseFrames(await res.text())

    expect(syncCalls).toHaveLength(1)
    const toolMsg = upstreamBodies[1].messages.find((m) => m.role === "tool")!
    expect(toolMsg.content).toContain("permission_denied")
    expect(toolMsg.content).toContain("PlanImport requires project_lead")
    expect(toolMsg.content).toContain("report it to the user")
    expect(frames.some((f) => f.type === "changeset.staged")).toBe(false)
  })

  it("maps 400 validation_failed to an actionable error naming describe_command, no frame", async () => {
    await seedWorld(400)
    const jwt = await jwtFor("alice")
    const script = [
      toolCall("t1", "propose_command", {
        commands: [{ kind: "SetTranslation", fileId: "f1", cellId: "missing", value: "x" }],
      }),
      { role: "assistant", content: "ok" },
    ]
    const { upstreamBodies } = mockUpstreams(script, () =>
      Response.json(
        { error: { code: "validation_failed", message: "cell missing not found in f1" } },
        { status: 400 },
      ),
    )
    const res = await postRun(jwt, { projectId: PROJECT, messages: [{ role: "user", content: "go" }] })
    const frames = parseFrames(await res.text())

    const toolMsg = upstreamBodies[1].messages.find((m) => m.role === "tool")!
    expect(toolMsg.content).toContain("validation_failed")
    expect(toolMsg.content).toContain("cell missing not found in f1")
    expect(toolMsg.content).toContain("describe_command")
    expect(frames.some((f) => f.type === "changeset.staged")).toBe(false)
  })

  it("pre-validation short-circuits below the static floor: no HTTP call at all", async () => {
    await seedWorld(400) // CONTRIBUTOR proposes a 500-floor command
    const jwt = await jwtFor("alice")
    const script = [
      toolCall("t1", "propose_command", {
        commands: [{ kind: "PlanImport", fileName: "GEN.usfm", fileType: "usfm", cells: [] }],
      }),
      { role: "assistant", content: "ok" },
    ]
    const { upstreamBodies, syncCalls } = mockUpstreams(script, () => Response.json(STAGED_RESPONSE))
    const res = await postRun(jwt, { projectId: PROJECT, messages: [{ role: "user", content: "import" }] })
    const frames = parseFrames(await res.text())

    expect(syncCalls).toHaveLength(0)
    const toolMsg = upstreamBodies[1].messages.find((m) => m.role === "tool")!
    expect(toolMsg.content).toContain("PlanImport needs role 500+")
    expect(toolMsg.content).toContain("Commands available at your role:")
    expect(toolMsg.content).toContain("SetTranslation")
    expect(frames.some((f) => f.type === "changeset.staged")).toBe(false)
  })
})

describe("agent route — command tool budget classification", () => {
  it("propose_command is BUDGETED: skipped by the mid-turn re-check once the cap trips", async () => {
    await seedWorld(400)
    const jwt = await jwtFor("alice")
    const sessionId = "66666666-6666-4666-8666-666666666666"
    // Turn 1 costs 10¢ against a 5¢ cap → the budgeted tool must NOT run.
    const script = [
      toolCall("t1", "propose_command", {
        commands: [{ kind: "SetTranslation", fileId: "f1", cellId: "c1", value: "hola" }],
      }),
    ]
    const { syncCalls } = mockUpstreams(script, () => Response.json(STAGED_RESPONSE), 0.1)
    const res = await postRun(
      jwt,
      { projectId: PROJECT, sessionId, messages: [{ role: "user", content: "stage" }] },
      { AGENT_RUN_COST_CAP_CENTS: "5" },
    )
    const frames = parseFrames(await res.text())

    expect(syncCalls).toHaveLength(0)
    expect(frames.find((f) => f.type === "budget.exhausted")).toBeDefined()
    expect(frames.find((f) => f.type === "done")).toMatchObject({ status: "capped" })
    const stored = await env.AQUILLA_PG.prepare(
      "SELECT convo FROM agent_sessions WHERE session_id = ?",
    )
      .bind(sessionId)
      .first<{ convo: string }>()
    const convo = JSON.parse(stored!.convo) as { role: string; content: string }[]
    const toolMsg = convo.find((m) => m.role === "tool")!
    expect(toolMsg.content).toContain("budget exhausted before this tool ran")
  })

  it("describe_command is FREE: it still executes after the cap has tripped", async () => {
    await seedWorld(400)
    const jwt = await jwtFor("alice")
    const sessionId = "77777777-7777-4777-8777-777777777777"
    const script = [toolCall("t1", "describe_command", { kind: "SetTranslation" })]
    mockUpstreams(script, () => Response.json(STAGED_RESPONSE), 0.1)
    const res = await postRun(
      jwt,
      { projectId: PROJECT, sessionId, messages: [{ role: "user", content: "describe" }] },
      { AGENT_RUN_COST_CAP_CENTS: "5" },
    )
    const frames = parseFrames(await res.text())

    expect(frames.find((f) => f.type === "done")).toMatchObject({ status: "capped" })
    const stored = await env.AQUILLA_PG.prepare(
      "SELECT convo FROM agent_sessions WHERE session_id = ?",
    )
      .bind(sessionId)
      .first<{ convo: string }>()
    const convo = JSON.parse(stored!.convo) as { role: string; content: string }[]
    const toolMsg = convo.find((m) => m.role === "tool")!
    // The free tool RAN — its result is the paramsDoc, not the halt message.
    expect(toolMsg.content).toContain("### SetTranslation")
    expect(toolMsg.content).not.toContain("budget exhausted")
  })

  it("describe_command dispatches through the route and feeds the doc to the model", async () => {
    await seedWorld(400)
    const jwt = await jwtFor("alice")
    const script = [
      toolCall("t1", "describe_command", { kind: "EmitEvents" }),
      { role: "assistant", content: "got it" },
    ]
    const { upstreamBodies } = mockUpstreams(script, () => Response.json(STAGED_RESPONSE))
    await (await postRun(jwt, { projectId: PROJECT, messages: [{ role: "user", content: "?" }] })).text()
    const toolMsg = upstreamBodies[1].messages.find((m) => m.role === "tool")!
    expect(toolMsg.content).toContain("### EmitEvents")
    expect(toolMsg.content).toContain("comment.create")
  })
})
