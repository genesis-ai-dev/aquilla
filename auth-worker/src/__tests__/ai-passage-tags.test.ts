// Contract tests for POST /api/v1/ai/passage-tags/classify (AQU-657, slice 1).
//
// The load-bearing property is the seam route's: this route CANNOT fail the
// caller. Tagging enriches retrieval and shortlisting, so every degraded path —
// no key, upstream 500, upstream timeout, malformed body, rate limit — must still
// answer 200 with heuristic tags. A background pass whose only recovery is "use
// the heuristic" gains nothing from a 503.
//
// It also pins the response against the SHARED contract guard the SPA client
// uses (`isPassageTags`), so a field this route stops sending cannot be quietly
// dropped by the consumer instead of failing here.

import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"
import { resolvePassageTagUrl } from "../routes/ai-passage-tags"
import {
  nodeQuestionId,
  participantQuestionId,
  relatedQuestionId,
} from "../../../src/lib/understanding/passage-tag-request"
import { isPassageTags, type PassageTags } from "../../../src/lib/understanding/passage-tags"

const PROJECT_ID = "tag-project"
const URL = "/api/v1/ai/passage-tags/classify"

type TagBody = {
  tags: PassageTags[]
  model: string | null
  rateLimited?: boolean
}

/**
 * Two nodes from the fixture's hard case: the second continues the first's scene
 * and is almost entirely speech, and names nobody — Jesus is present in it only
 * as "He", which the name heuristic cannot see and the model can.
 */
function body(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    projectId: PROJECT_ID,
    nodes: [
      {
        key: "passage:LUK 5:27",
        label: "LUK 5:27–32",
        text: "After these things he went out, and saw a tax collector named Levi "
          + "sitting at the tax office, and said to him, “Follow me!”",
        startRef: "LUK 5:27",
        endRef: "LUK 5:32",
        participants: ["Jesus", "Levi"],
        related: [],
      },
      {
        key: "passage:LUK 5:33",
        label: "LUK 5:33–39",
        text: "They said to him, “Why do John’s disciples often fast and pray, "
          + "but yours eat and drink?”",
        startRef: "LUK 5:33",
        endRef: "LUK 5:39",
        participants: ["Jesus", "Levi"],
        related: [{
          key: "passage:LUK 5:27",
          label: "LUK 5:27–32",
          text: "Levi made a great feast for him in his house.",
        }],
      },
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

/** A decisive Jev response: node 1 is Jesus speaking, continuing node 0's scene,
 *  and depends on it. */
function jevAnswers(): Response {
  return new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        [nodeQuestionId(0, "speech")]: { type: "noul", noul: 0.2 },
        [participantQuestionId(0, 0)]: { type: "noul", noul: 0.97 },
        [participantQuestionId(0, 1)]: { type: "noul", noul: 0.96 },
        [nodeQuestionId(1, "speech")]: { type: "noul", noul: 0.93 },
        [nodeQuestionId(1, "scene_change")]: { type: "noul", noul: 0.04 },
        [participantQuestionId(1, 0)]: { type: "noul", noul: 0.91 },
        [participantQuestionId(1, 1)]: { type: "noul", noul: 0.08 },
        [relatedQuestionId(1, 0)]: { type: "noul", noul: 0.95 },
      },
      usage: { input_tokens: 900, output_tokens: 40 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )
}

async function seedMember(): Promise<string> {
  await seedUser(1, "tag-owner")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, created_by) VALUES (?, 'Tags', 1)",
  ).bind(PROJECT_ID).run()
  return jwtFor("tag-owner")
}

afterEach(() => vi.restoreAllMocks())

describe("resolvePassageTagUrl", () => {
  it("defaults to OpenRouter's decisions endpoint", () => {
    expect(resolvePassageTagUrl({})).toBe("https://openrouter.ai/api/alpha/decisions")
  })

  it("replaces the version segment rather than appending to it", () => {
    // /alpha/decisions is a SIBLING of /v1, not a child. Appending would point
    // the dev stack at /v1/alpha/decisions and 404 every call.
    expect(resolvePassageTagUrl({ OPENROUTER_BASE_URL: "http://127.0.0.1:9999/v1" }))
      .toBe("http://127.0.0.1:9999/alpha/decisions")
    expect(resolvePassageTagUrl({ OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1/" }))
      .toBe("https://openrouter.ai/api/alpha/decisions")
  })
})

describe("POST /api/v1/ai/passage-tags/classify", () => {
  it("requires authentication", async () => {
    const res = await app.request(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body(),
    }, testEnv())
    expect(res.status).toBe(401)
  })

  it("requires project access", async () => {
    await seedUser(7, "tag-outsider")
    const jwt = await jwtFor("tag-outsider")
    const res = await app.request(URL, {
      method: "POST",
      headers: authHeader(jwt),
      body: body({ projectId: "someone-elses-project" }),
    }, testEnv())
    expect(res.status).toBe(403)
  })

  it("rejects an empty node list", async () => {
    const jwt = await seedMember()
    const res = await app.request(URL, {
      method: "POST",
      headers: authHeader(jwt),
      body: body({ nodes: [] }),
    }, testEnv())
    expect(res.status).toBe(400)
  })

  it("returns model-decided tags per node, including against the heuristic", async () => {
    const jwt = await seedMember()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jevAnswers())
    const res = await app.request(URL, {
      method: "POST", headers: authHeader(jwt), body: body(),
    }, testEnv())

    expect(res.status).toBe(200)
    const out = await res.json() as TagBody
    expect(out.model).toBe("typesafe/jev-1.13")
    expect(out.tags.map((t) => t.nodeKey))
      .toEqual(["passage:LUK 5:27", "passage:LUK 5:33"])

    // The pronoun-only node: the name heuristic sees no "Jesus", the model does.
    const second = out.tags[1]
    expect(second.participants[0]).toMatchObject({
      name: "Jesus", value: true, decidedBy: "model",
    })
    expect(second.participants[1]).toMatchObject({ name: "Levi", value: false })
    expect(second.speech).toMatchObject({ value: true, decidedBy: "model" })
    expect(second.sceneChange).toMatchObject({ value: false, decidedBy: "model" })
    expect(second.refersTo[0]).toMatchObject({ key: "passage:LUK 5:27", value: true })
  })

  it("answers in the shape the SPA's shared contract guard accepts", async () => {
    const jwt = await seedMember()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jevAnswers())
    const res = await app.request(URL, {
      method: "POST", headers: authHeader(jwt), body: body(),
    }, testEnv())
    const out = await res.json() as TagBody
    expect(out.tags.every(isPassageTags)).toBe(true)
  })

  it("batches every node and candidate in the window into ONE upstream call", async () => {
    // Fanning out is the cost story: extra questions are nearly free, extra
    // round trips are not.
    const jwt = await seedMember()
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(jevAnswers())
    await app.request(URL, {
      method: "POST", headers: authHeader(jwt), body: body(),
    }, testEnv())

    expect(upstream).toHaveBeenCalledTimes(1)
    const sent = JSON.parse((upstream.mock.calls[0][1] as RequestInit).body as string)
    expect(sent.state.passages).toHaveLength(2)
    // node 0: speech + 2 participants (no scene_change — no predecessor in window)
    // node 1: speech + scene_change + 2 participants + 1 related
    expect(Object.keys(sent.questions)).toHaveLength(8)
    expect(sent.state.candidates).toHaveLength(1)
  })

  it("pins the model version rather than sending an alias", async () => {
    const jwt = await seedMember()
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(jevAnswers())
    await app.request(URL, {
      method: "POST", headers: authHeader(jwt), body: body(),
    }, testEnv())
    const sent = JSON.parse((upstream.mock.calls[0][1] as RequestInit).body as string)
    expect(sent.model).not.toMatch(/latest/)
    expect(sent.model).toMatch(/jev-1\.13/)
  })

  it("falls back to the heuristic when the key is unset, without calling upstream", async () => {
    const jwt = await seedMember()
    const upstream = vi.spyOn(globalThis, "fetch")
    const res = await app.request(URL, {
      method: "POST", headers: authHeader(jwt), body: body(),
    }, testEnv({ OPENROUTER_API_KEY: undefined }))

    expect(res.status).toBe(200)
    const out = await res.json() as TagBody
    expect(upstream).not.toHaveBeenCalled()
    expect(out.model).toBeNull()
    expect(out.tags).toHaveLength(2)
    expect(out.tags[0].participants.every((p) => p.decidedBy === "heuristic")).toBe(true)
    // The heuristic still earns its keep: "Levi" is named in node 0's text.
    expect(out.tags[0].participants[1]).toMatchObject({ name: "Levi", value: true })
  })

  it("falls back to the heuristic on an upstream error", async () => {
    const jwt = await seedMember()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }))
    const res = await app.request(URL, {
      method: "POST", headers: authHeader(jwt), body: body(),
    }, testEnv())

    expect(res.status).toBe(200)
    const out = await res.json() as TagBody
    expect(out.model).toBeNull()
    expect(out.tags[0].speech.decidedBy).toBe("heuristic")
  })

  it("falls back to the heuristic when the upstream call throws", async () => {
    const jwt = await seedMember()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timed out"))
    const res = await app.request(URL, {
      method: "POST", headers: authHeader(jwt), body: body(),
    }, testEnv())

    expect(res.status).toBe(200)
    const out = await res.json() as TagBody
    expect(out.tags).toHaveLength(2)
    expect(out.tags[1].participants.every((p) => p.decidedBy === "heuristic")).toBe(true)
  })

  it("degrades only the nodes a partial response left out", async () => {
    const jwt = await seedMember()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({
        answers: { [nodeQuestionId(0, "speech")]: { type: "noul", noul: 0.95 } },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ))
    const res = await app.request(URL, {
      method: "POST", headers: authHeader(jwt), body: body(),
    }, testEnv())

    const out = await res.json() as TagBody
    expect(out.tags[0].speech).toMatchObject({ value: true, decidedBy: "model" })
    expect(out.tags[1].speech.decidedBy).toBe("heuristic")
  })

  it("survives a malformed upstream body", async () => {
    const jwt = await seedMember()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json", {
      status: 200, headers: { "Content-Type": "application/json" },
    }))
    const res = await app.request(URL, {
      method: "POST", headers: authHeader(jwt), body: body(),
    }, testEnv())

    expect(res.status).toBe(200)
    const out = await res.json() as TagBody
    expect(out.tags.every(isPassageTags)).toBe(true)
  })

  it("rejects a window wider than the batch bound rather than truncating it", async () => {
    const jwt = await seedMember()
    const nodes = Array.from({ length: 11 }, (_, i) => ({
      key: `passage:${i}`, label: `${i}`, text: `Passage ${i}.`,
    }))
    const res = await app.request(URL, {
      method: "POST", headers: authHeader(jwt), body: body({ nodes }),
    }, testEnv())
    expect(res.status).toBe(400)
  })

  it("answers heuristic tags, not a 429, once the per-user cap is spent", async () => {
    const jwt = await seedMember()
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(jevAnswers())
    // The cap is 120 windows per sliding window; fill the ledger directly rather
    // than making 120 requests.
    for (let i = 0; i < 120; i += 1) {
      await env.AQUILLA_PG.prepare(
        "INSERT INTO auth_rate_limit_events (kind, identifier, success) VALUES (?, ?, ?)",
      ).bind("ai_passage_tags", "user:1", 1).run()
    }

    const res = await app.request(URL, {
      method: "POST", headers: authHeader(jwt), body: body(),
    }, testEnv())

    expect(res.status).toBe(200)
    const out = await res.json() as TagBody
    expect(out.rateLimited).toBe(true)
    expect(out.model).toBeNull()
    expect(upstream).not.toHaveBeenCalled()
    expect(out.tags[0].participants.every((p) => p.decidedBy === "heuristic")).toBe(true)
  })
})
