// Contract tests for POST /api/v1/ai/transcript-cleanup.
//
// What matters: the call spends credits, so it is for contributors and up; the
// model is taught from the lane's own heard → corrected pairs and key terms;
// and a result that invents speech is reported, never returned as a cleanup.

import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"

const PROJECT_ID = "cleanup-project"

function cleanupEnv(): typeof env {
  return Object.assign(Object.create(env), {
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_BASE_URL: "http://127.0.0.1:9456/api/v1/",
    AI_BUDGET_ENFORCE: "false",
  })
}

async function seedLead(): Promise<string> {
  await seedUser(1, "lead")
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, 'Cleanup', 1)").bind(PROJECT_ID).run()
  return jwtFor("lead")
}

const body = (extra: Record<string, unknown> = {}) => JSON.stringify({
  projectId: PROJECT_ID,
  heard: "ni eema akaenda kwa mji kapernaumu",
  language: "Swahili",
  pairs: [{ heard: "eema akasema", corrected: "Yesu akasema" }],
  terms: [{ term: "Yesu" }],
  ...extra,
})

const reply = (content: unknown) => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify(content) } }], usage: { cost: 0.0004 },
}), { status: 200 })

type CleanupBody = { model: string; result: { kind: string; text?: string; changes?: number } }

afterEach(() => vi.restoreAllMocks())

describe("POST /api/v1/ai/transcript-cleanup", () => {
  it("is for contributors and up — it spends credits", async () => {
    await seedLead()
    await seedUser(9, "viewer")
    await env.AQUILLA_PG.prepare("INSERT INTO project_members (project_id, user_id, role_level) VALUES (?, 9, 100)").bind(PROJECT_ID).run()
    const res = await app.request("/api/v1/ai/transcript-cleanup", { method: "POST", headers: authHeader(await jwtFor("viewer")), body: body() }, cleanupEnv())
    expect(res.status).toBe(403)
  })

  it("teaches the model from the lane's own corrections and returns the cleaned transcript", async () => {
    const jwt = await seedLead()
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply({
      text: "ni Yesu akaenda mjini kapernaumu",
      notes: [{ heard: "eema", wrote: "Yesu", reason: "The team spells the name Yesu." }],
    }))
    const res = await app.request("/api/v1/ai/transcript-cleanup", { method: "POST", headers: authHeader(jwt), body: body() }, cleanupEnv())
    expect(res.status).toBe(200)
    const prompt = String(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).messages[1].content)
    expect(prompt).toContain("heard: eema akasema\ncorrected: Yesu akasema")
    expect(prompt).toContain("<key-terms>\nYesu\n</key-terms>")
    const out = (await res.json()) as CleanupBody
    expect(out.result).toEqual(expect.objectContaining({ kind: "ok", text: "ni Yesu akaenda mjini kapernaumu", changes: 3 }))
  })

  it("reports a result that adds speech instead of returning it as a cleanup", async () => {
    const jwt = await seedLead()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(reply({
      text: "ni Yesu akaenda mjini kapernaumu pamoja na wanafunzi wake wote siku ile",
    }))
    const res = await app.request("/api/v1/ai/transcript-cleanup", { method: "POST", headers: authHeader(jwt), body: body() }, cleanupEnv())
    expect(res.status).toBe(200)
    expect(((await res.json()) as CleanupBody).result.kind).toBe("too-different")
  })

  // AQU-2226: a reasoning model can spend the whole max_tokens thinking. The
  // reply then stops mid-way (finish_reason "length"). Reading what it did
  // write as "no change needed" would tell the user ASR was already right.
  it("never reads a reply cut off at max_tokens as a result, and logs it", async () => {
    const jwt = await seedLead()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        finish_reason: "length",
        message: { content: JSON.stringify({ text: "ni eema akaenda kwa mji kapernaumu", notes: [] }) },
      }],
      usage: { cost: 0.0004, completion_tokens: 1200, completion_tokens_details: { reasoning_tokens: 1180 } },
    }), { status: 200 }))
    const res = await app.request("/api/v1/ai/transcript-cleanup", { method: "POST", headers: authHeader(jwt), body: body() }, cleanupEnv())
    expect(res.status).toBe(200)
    expect(((await res.json()) as CleanupBody).result.kind).toBe("invalid")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cut off at max_tokens"), expect.objectContaining({ reasoningTokens: 1180 }))
  })

  // Without effort "none", gpt-5.6-luna reasons for ~1,450 tokens a call and
  // cut off 49 of 60 Blackfoot replies at the old 1,200 cap (AQU-2226).
  it("asks OpenRouter for no reasoning, so thinking cannot use up the budget", async () => {
    const jwt = await seedLead()
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply({ text: "ni Yesu akaenda mjini kapernaumu" }))
    const openRouter = Object.assign(cleanupEnv(), { OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1" })
    await app.request("/api/v1/ai/transcript-cleanup", { method: "POST", headers: authHeader(jwt), body: body() }, openRouter)
    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as { reasoning?: { effort?: string } }
    expect(sent.reasoning?.effort).toBe("none")
  })

  // A new project has no corrected transcript to learn from. The lines the
  // team has written are then the only evidence of how the language is spelled.
  it("shows the model the team's written lines as spelling evidence", async () => {
    const jwt = await seedLead()
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(reply({ text: "Ni Yesu akaenda mjini Kapernaumu." }))
    await app.request("/api/v1/ai/transcript-cleanup", {
      method: "POST", headers: authHeader(jwt), body: body({ pairs: [], terms: [], samples: ["Yesu akawaambia, Njoni mnifuate."] }),
    }, cleanupEnv())
    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as { messages: { content: string }[] }
    expect(sent.messages[1].content).toContain("<written-in-this-language>\nYesu akawaambia, Njoni mnifuate.\n</written-in-this-language>")
    expect(sent.messages[0].content).toMatch(/Never copy a word from them that was not spoken/)
  })

  // Capital letters and punctuation are orthography. A CTC model writes lower
  // case with none, and a cleanup that only restored them used to come back
  // as "nothing to clean up".
  it("returns a cleanup that only restores capitals and punctuation as a cleanup", async () => {
    const jwt = await seedLead()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(reply({ text: "Ni eema akaenda kwa mji Kapernaumu." }))
    const res = await app.request("/api/v1/ai/transcript-cleanup", { method: "POST", headers: authHeader(jwt), body: body() }, cleanupEnv())
    expect(((await res.json()) as CleanupBody).result).toEqual(expect.objectContaining({ kind: "ok", changes: 2 }))
  })

  describe("stream: true", () => {
    const sse = (frames: unknown[]) => new Response(
      frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join(""),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    )
    const delta = (content: string) => ({ id: "gen-1", choices: [{ delta: { content } }] })
    const events = (text: string) => text.trim().split("\n\n").map((block) => {
      const [event, data] = block.split("\n")
      return { event: event.replace("event: ", ""), data: JSON.parse(data.replace("data: ", "")) as Record<string, unknown> }
    })

    // The point of streaming: the row shows the cleanup as it is written. The
    // deltas must be the transcript's own characters (JSON syntax and escapes
    // removed), and the last frame must be what the JSON reply would have been.
    it("streams the transcript as it is written, then the same result the JSON reply carries", async () => {
      const jwt = await seedLead()
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse([
        delta('{"te'), delta('xt":"ni Ye'), delta('su \\"aka'), delta('enda\\" mjini kapernaumu","notes":[]}'),
        { id: "gen-1", choices: [{ delta: {}, finish_reason: "stop" }], usage: { cost: 0.0004 } },
        "[DONE]",
      ]))
      const res = await app.request("/api/v1/ai/transcript-cleanup", { method: "POST", headers: authHeader(jwt), body: body({ stream: true }) }, cleanupEnv())
      expect(res.status).toBe(200)
      expect(res.headers.get("Content-Type")).toContain("text/event-stream")
      expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).stream).toBe(true)
      const got = events(await res.text())
      const written = got.filter((e) => e.event === "delta").map((e) => e.data.add).join("")
      expect(written).toBe('ni Yesu "akaenda" mjini kapernaumu')
      expect(got.at(-1)).toEqual({
        event: "result",
        data: { model: expect.any(String), result: expect.objectContaining({ kind: "ok", text: 'ni Yesu "akaenda" mjini kapernaumu' }) },
      })
    })

    // A stream that stops without [DONE] is not a reply. Saving what it had
    // written so far would store half a transcript as the cleanup.
    it("ends with an error frame, never a result, when the model's stream breaks off", async () => {
      const jwt = await seedLead()
      vi.spyOn(console, "error").mockImplementation(() => {})
      vi.spyOn(globalThis, "fetch").mockResolvedValue(sse([delta('{"text":"ni Yesu aka')]))
      const res = await app.request("/api/v1/ai/transcript-cleanup", { method: "POST", headers: authHeader(jwt), body: body({ stream: true }) }, cleanupEnv())
      const got = events(await res.text())
      expect(got.at(-1)?.event).toBe("error")
      expect(got.some((e) => e.event === "result")).toBe(false)
    })

    it("keeps the cut-off rule: a streamed reply that hit max_tokens is invalid", async () => {
      const jwt = await seedLead()
      vi.spyOn(console, "warn").mockImplementation(() => {})
      vi.spyOn(globalThis, "fetch").mockResolvedValue(sse([
        delta('{"text":"ni eema akaenda kwa mji kapernaumu","notes":[]}'),
        { choices: [{ delta: {}, finish_reason: "length" }], usage: { cost: 0.0004 } },
        "[DONE]",
      ]))
      const res = await app.request("/api/v1/ai/transcript-cleanup", { method: "POST", headers: authHeader(jwt), body: body({ stream: true }) }, cleanupEnv())
      expect(events(await res.text()).at(-1)?.data.result).toEqual({ kind: "invalid" })
    })

    it("answers a refused call as plain JSON, before any stream starts", async () => {
      const jwt = await seedLead()
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }))
      const res = await app.request("/api/v1/ai/transcript-cleanup", { method: "POST", headers: authHeader(jwt), body: body({ stream: true }) }, cleanupEnv())
      expect(res.status).toBe(502)
      expect(res.headers.get("Content-Type")).toContain("application/json")
    })
  })

  it("passes an upstream failure through as a 502, not a cleanup", async () => {
    const jwt = await seedLead()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }))
    const res = await app.request("/api/v1/ai/transcript-cleanup", { method: "POST", headers: authHeader(jwt), body: body() }, cleanupEnv())
    expect(res.status).toBe(502)
  })
})
