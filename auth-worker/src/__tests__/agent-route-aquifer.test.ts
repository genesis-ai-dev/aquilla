// POST /api/v1/ai/agent/run — the execute.aquifer branch, end to end.
//
// WHY: freezes the Bible-Aquifer wire contract the client builds against —
// the search→read tool results, the aquifer_proposal frame (publish STAGES,
// it does NOT post live), and the per-project gate (off → the branch is
// rejected and the model is never told it exists). fetch is mocked so both the
// scripted model AND the aquifer client run offline.

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

async function seedWorld(opts: { enabled: boolean }) {
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
  if (opts.enabled) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 1, 2)`,
    )
      .bind(PROJECT, JSON.stringify({ bibleResourcesEnabled: true }))
      .run()
  }
}

function modelTurn(message: Record<string, unknown>) {
  return new Response(
    JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )
}

function toolCall(id: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name: "execute", arguments: JSON.stringify(args) } }],
  }
}

function aquiferJson(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
}

function testEnv() {
  return Object.assign(Object.create(env), { OPENROUTER_API_KEY: "test-key" })
}

async function postRun(jwt: string, content: string) {
  return app.request(
    "/api/v1/ai/agent/run",
    {
      method: "POST",
      headers: authHeader(jwt),
      body: JSON.stringify({ projectId: PROJECT, messages: [{ role: "user", content }] }),
    },
    testEnv(),
  )
}

afterEach(() => vi.restoreAllMocks())

describe("execute.aquifer — gate on", () => {
  it("search → read → publish stages an aquifer_proposal (no live POST)", async () => {
    await seedWorld({ enabled: true })
    const jwt = await jwtFor("alice")

    const modelScript = [
      toolCall("t1", { aquifer: { op: "search", q: "abraham" } }),
      toolCall("t2", { aquifer: { op: "read", path: "/en/people/abraham/" } }),
      toolCall("t3", {
        aquifer: {
          op: "publish",
          question: "Who was Abraham in the biblical narrative?",
          answer: "Abraham is the first patriarch of Israel, originally named Abram.",
          status: "answered",
          citations: [{ url: "https://bibletranslation.org/en/people/abraham/", quote: "first patriarch" }],
        },
      }),
      { role: "assistant", content: "Here's what the reference data says about Abraham — and I staged a Q&A to publish." },
    ]
    const sawAnswersPost: string[] = []
    const toolMessagesSeen: { role: string; content: string }[][] = []

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url)
      if (u.includes("/api/search")) return aquiferJson({ query: "abraham", lang: "en", count: 1, results: [{ title: "Abraham", url: "https://bibletranslation.org/en/people/abraham/", kind: "person", description: "First patriarch." }] })
      if (u.includes("/api/page")) return aquiferJson({ path: "/en/people/abraham/", url: "https://bibletranslation.org/en/people/abraham/", title: "Abraham", truncated: false, text: "Abraham\nThe first patriarch of Israel." })
      if (u.includes("/api/answers")) {
        sawAnswersPost.push(String(init?.body))
        return aquiferJson({ url: "https://bibletranslation.org/qa/x/" })
      }
      // OpenRouter
      toolMessagesSeen.push(JSON.parse(String(init?.body)).messages)
      return modelTurn(modelScript.shift()!)
    })

    const res = await postRun(jwt, "Look up Abraham in the Bible resources")
    expect(res.status).toBe(200)
    const frames = parseFrames(await res.text())

    // The L1 prompt advertised the aquifer branch (gate on).
    expect(JSON.stringify(toolMessagesSeen[0][0])).toContain("Bible reference data")

    // search + read returned ok results into the loop.
    const codeResults = frames.filter((f) => f.type === "code_result")
    expect(codeResults.every((f) => f.ok)).toBe(true)
    expect(frames.some((f) => f.type === "code_start" && f.kind === "aquifer")).toBe(true)

    // Publish STAGED a proposal — and never hit the network.
    const proposalFrame = frames.find((f) => f.type === "aquifer_proposal")
    expect(proposalFrame).toBeTruthy()
    const proposal = proposalFrame!.proposal as {
      proposalId: string
      runId: string
      question: string
      status: string
      citations: { url: string }[]
    }
    expect(proposal.status).toBe("answered")
    expect(proposal.citations[0].url).toContain("bibletranslation.org")
    expect(proposal.proposalId).toBeTruthy()
    expect(sawAnswersPost).toHaveLength(0) // nothing posted — staging only

    expect(frames.find((f) => f.type === "done")!.status).toBe("ok")
  })
})

describe("execute.aquifer — gate off", () => {
  it("rejects the branch and never mentions it in the prompt", async () => {
    await seedWorld({ enabled: false })
    const jwt = await jwtFor("alice")

    const modelScript = [
      toolCall("t1", { aquifer: { op: "search", q: "abraham" } }),
      { role: "assistant", content: "Bible resources aren't enabled here." },
    ]
    const promptSeen: string[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const u = String(url)
      if (u.includes("/api/search") || u.includes("/api/page") || u.includes("/api/answers")) {
        throw new Error("aquifer must not be called when the gate is off")
      }
      promptSeen.push(JSON.stringify(JSON.parse(String(init?.body)).messages[0]))
      return modelTurn(modelScript.shift()!)
    })

    const res = await postRun(jwt, "Look up Abraham")
    const frames = parseFrames(await res.text())

    expect(promptSeen[0]).not.toContain("Bible reference data") // contract hidden
    const codeResult = frames.find((f) => f.type === "code_result")!
    expect(codeResult.ok).toBe(false)
    expect(String(codeResult.summary)).toContain("not enabled")
    expect(frames.find((f) => f.type === "done")!.status).toBe("ok")
  })
})
