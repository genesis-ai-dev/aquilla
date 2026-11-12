// Contract tests for POST /api/v1/ai/seams/classify (AQU-1386).
//
// The load-bearing property is that this route CANNOT fail the caller: seam
// classification is an optimisation over punctuation, so every degraded path —
// no key, upstream 500, upstream timeout, malformed body, rate limit — must
// still answer 200 with heuristic decisions. A background job whose only
// recovery is "use the heuristic" gains nothing from a 503.

import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"
import { resolveSeamUrl } from "../routes/ai-seams"
import { seamQuestionId } from "../../../src/lib/completion/seam-request"

const PROJECT_ID = "seam-project"

type SeamBody = {
  seams: {
    join: boolean
    joinProbability: number
    confidence: number
    decidedBy: "model" | "heuristic"
    boundaryLevel: number | null
    prevCellId: string
    nextCellId: string
  }[]
  model: string | null
  rateLimited?: boolean
}

/** Two cells where the first stops mid-sentence — the EBL exercise-5 shape. */
function body(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    projectId: PROJECT_ID,
    cells: [
      { id: "c1", text: "And when he had finished speaking, he said", ref: "EX 5:1" },
      { id: "c2", text: "to Simon, Put out into the deep.", ref: "EX 5:2" },
    ],
    ...extra,
  })
}

function testEnv(overrides: Record<string, unknown> = {}): typeof env {
  return Object.assign(Object.create(env), {
    OPENROUTER_API_KEY: "test-key",
    ...overrides,
  })
}

/** A decisive Jev response: cell 2 completes cell 1's sentence, no section break. */
function jevSaysJoin(): Response {
  return new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        [seamQuestionId(0, "continues_sentence")]: { type: "noul", noul: 0.96 },
        [seamQuestionId(0, "same_item")]: { type: "noul", noul: 0.2 },
        [seamQuestionId(0, "refers_back")]: { type: "noul", noul: 0.4 },
        [seamQuestionId(0, "section_break")]: { type: "noul", noul: 0.02 },
        [seamQuestionId(0, "boundary_level")]: {
          type: "score",
          score: 0.1,
          probabilities: { "0": 0.9, "1": 0.1, "2": 0, "3": 0, "4": 0 },
          confidence: 0.9,
        },
      },
      usage: { input_tokens: 300, output_tokens: 20 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )
}

async function seedMember(): Promise<string> {
  await seedUser(1, "seam-owner")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, created_by) VALUES (?, 'Seams', 1)",
  ).bind(PROJECT_ID).run()
  return jwtFor("seam-owner")
}

afterEach(() => vi.restoreAllMocks())

describe("resolveSeamUrl", () => {
  it("defaults to OpenRouter's decisions endpoint", () => {
    expect(resolveSeamUrl({})).toBe("https://openrouter.ai/api/alpha/decisions")
  })

  it("replaces the version segment rather than appending to it", () => {
    // /alpha/decisions is a SIBLING of /v1, not a child. Appending would point
    // the dev stack at /v1/alpha/decisions and 404 every call.
    expect(resolveSeamUrl({ OPENROUTER_BASE_URL: "http://127.0.0.1:9999/v1" }))
      .toBe("http://127.0.0.1:9999/alpha/decisions")
    expect(resolveSeamUrl({ OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1/" }))
      .toBe("https://openrouter.ai/api/alpha/decisions")
  })
})

describe("POST /api/v1/ai/seams/classify", () => {
  it("requires authentication", async () => {
    const res = await app.request("/api/v1/ai/seams/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body(),
    }, testEnv())
    expect(res.status).toBe(401)
  })

  it("requires project access", async () => {
    await seedUser(7, "outsider")
    const jwt = await jwtFor("outsider")
    const res = await app.request("/api/v1/ai/seams/classify", {
      method: "POST",
      headers: authHeader(jwt),
      body: body({ projectId: "someone-elses-project" }),
    }, testEnv())
    expect(res.status).toBe(403)
  })

  it("rejects a window with fewer than two cells — there is no seam", async () => {
    const jwt = await seedMember()
    const res = await app.request("/api/v1/ai/seams/classify", {
      method: "POST",
      headers: authHeader(jwt),
      body: body({ cells: [{ id: "c1", text: "alone" }] }),
    }, testEnv())
    expect(res.status).toBe(400)
  })

  it("returns one model-decided seam per boundary", async () => {
    const jwt = await seedMember()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jevSaysJoin())
    const res = await app.request("/api/v1/ai/seams/classify", {
      method: "POST",
      headers: authHeader(jwt),
      body: body(),
    }, testEnv())

    expect(res.status).toBe(200)
    const out = await res.json() as SeamBody
    expect(out.model).toBe("typesafe/jev-1.13")
    expect(out.seams).toHaveLength(1)
    expect(out.seams[0]).toMatchObject({
      join: true,
      decidedBy: "model",
      prevCellId: "c1",
      nextCellId: "c2",
      boundaryLevel: 0,
    })
  })

  it("batches every seam in the window into ONE upstream call", async () => {
    // Fanning out is the cost story: extra questions are nearly free, extra
    // round trips are not. One call per seam would be 10x the latency.
    const jwt = await seedMember()
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(jevSaysJoin())
    await app.request("/api/v1/ai/seams/classify", {
      method: "POST",
      headers: authHeader(jwt),
      body: body({
        cells: [
          { id: "c1", text: "one," }, { id: "c2", text: "two," },
          { id: "c3", text: "three." }, { id: "c4", text: "Four." },
        ],
      }),
    }, testEnv())

    expect(upstream).toHaveBeenCalledTimes(1)
    const sent = JSON.parse((upstream.mock.calls[0][1] as RequestInit).body as string)
    expect(sent.model).toBe("typesafe/jev-1.13")
    // 3 seams x (4 nouls + 1 score)
    expect(Object.keys(sent.questions)).toHaveLength(15)
    expect(sent.state.cells).toHaveLength(4)
  })

  it("pins the model version rather than sending an alias", async () => {
    // `jev-latest` would silently re-point the classifier at a model the
    // shadow eval never scored, invalidating the thresholds with nothing
    // failing.
    const jwt = await seedMember()
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(jevSaysJoin())
    await app.request("/api/v1/ai/seams/classify", {
      method: "POST", headers: authHeader(jwt), body: body(),
    }, testEnv())
    const sent = JSON.parse((upstream.mock.calls[0][1] as RequestInit).body as string)
    expect(sent.model).not.toMatch(/latest/)
    expect(sent.model).toMatch(/jev-1\.13/)
  })

  it("falls back to the heuristic when the key is unset", async () => {
    const jwt = await seedMember()
    const upstream = vi.spyOn(globalThis, "fetch")
    const res = await app.request("/api/v1/ai/seams/classify", {
      method: "POST",
      headers: authHeader(jwt),
      body: body(),
    }, testEnv({ OPENROUTER_API_KEY: undefined }))

    expect(res.status).toBe(200)
    const out = await res.json() as SeamBody
    expect(out.model).toBeNull()
    expect(out.seams[0].decidedBy).toBe("heuristic")
    // "…he said" has no sentence-final punctuation, so the heuristic joins.
    expect(out.seams[0].join).toBe(true)
    expect(upstream).not.toHaveBeenCalled()
  })

  it("falls back to the heuristic on an upstream error", async () => {
    const jwt = await seedMember()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }))
    const res = await app.request("/api/v1/ai/seams/classify", {
      method: "POST", headers: authHeader(jwt), body: body(),
    }, testEnv())

    expect(res.status).toBe(200)
    const out = await res.json() as SeamBody
    expect(out.seams[0].decidedBy).toBe("heuristic")
  })

  it("falls back to the heuristic when the upstream call throws", async () => {
    const jwt = await seedMember()
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timed out"))
    const res = await app.request("/api/v1/ai/seams/classify", {
      method: "POST", headers: authHeader(jwt), body: body(),
    }, testEnv())

    expect(res.status).toBe(200)
    expect((await res.json() as SeamBody).seams[0].decidedBy).toBe("heuristic")
  })

  it("falls back per-seam when the response omits that seam's answers", async () => {
    // A partial response degrades ONE seam. Throwing would un-group the file.
    const jwt = await seedMember()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          [seamQuestionId(0, "continues_sentence")]: { type: "noul", noul: 0.96 },
          [seamQuestionId(0, "same_item")]: { type: "noul", noul: 0.1 },
          [seamQuestionId(0, "refers_back")]: { type: "noul", noul: 0.1 },
          [seamQuestionId(0, "section_break")]: { type: "noul", noul: 0.02 },
          // seam 1 deliberately absent
        },
        usage: {},
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ))
    const res = await app.request("/api/v1/ai/seams/classify", {
      method: "POST",
      headers: authHeader(jwt),
      body: body({
        cells: [
          { id: "c1", text: "he said" },
          { id: "c2", text: "to Simon." },
          { id: "c3", text: "Then he left." },
        ],
      }),
    }, testEnv())

    const out = await res.json() as SeamBody
    expect(out.seams).toHaveLength(2)
    expect(out.seams[0].decidedBy).toBe("model")
    expect(out.seams[1].decidedBy).toBe("heuristic")
    // c2 ends with a full stop, so the heuristic breaks there.
    expect(out.seams[1].join).toBe(false)
  })

  it("sends the project's own text, not a generic sample", async () => {
    const jwt = await seedMember()
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(jevSaysJoin())
    await app.request("/api/v1/ai/seams/classify", {
      method: "POST", headers: authHeader(jwt), body: body(),
    }, testEnv())
    const sent = JSON.parse((upstream.mock.calls[0][1] as RequestInit).body as string)
    expect(sent.state.cells[0].text).toContain("he said")
    expect(sent.state.cells[0].ref).toBe("EX 5:1")
  })
})
