// decide() — the shared Jev decision seam (docs/superpowers/specs/
// 2026-09-30-jev-react-decisions-design.md §1). What these pin down: a Jev
// outage, a missing key, the kill switch, or the per-project cap can never
// break the caller — every path returns answers for every key, and says
// honestly whether the model or the fixed rules produced them.

import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { decide, JEV_BIBLE_QA_CAP_PER_WINDOW, JEV_PROJECT_CAP_PER_WINDOW, type JevAnswer, type JevPurpose } from "../lib/jev/decide"
import { countRecentRateLimitEvents, recordRateLimitEvent } from "../../../db/shared/rate-limit"

const QUESTIONS = {
  substantive: { type: "noul" as const, instructions: { question: "Is it substantive?" } },
  severity: { type: "score" as const, instructions: { question: "How bad?" }, criteria: ["none", "low", "mid", "high", "critical"] },
}

const FALLBACK: Record<string, JevAnswer> = {
  substantive: { kind: "noul", p: 0 },
  severity: { kind: "score", score: 1 },
}

function testEnv(overrides: Record<string, unknown> = {}): typeof env {
  return Object.assign(Object.create(env), { OPENROUTER_API_KEY: "test-key", ...overrides })
}

function jevReply(answers: Record<string, unknown>, status = 200): Response {
  return new Response(
    JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 50, output_tokens: 4 } }),
    { status, headers: { "Content-Type": "application/json" } },
  )
}

let projectSeq = 0
function input(purpose: JevPurpose = "react") {
  projectSeq += 1
  return {
    purpose,
    projectId: `jev-project-${projectSeq}-${Date.now()}`,
    state: { cells: [{ ref: "GEN 1:1", before: "a", after: "b" }] },
    questions: QUESTIONS,
    fallback: () => FALLBACK,
  }
}

afterEach(() => vi.restoreAllMocks())

describe("decide()", () => {
  it("returns the model's answers when Jev answers every question", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jevReply({
        substantive: { type: "noul", noul: 0.91 },
        severity: { type: "score", score: 3, probabilities: { "3": 0.8 } },
      }),
    )
    const out = await decide(testEnv(), input())
    expect(out.decidedBy).toBe("model")
    expect(out.answers.substantive).toEqual({ kind: "noul", p: 0.91 })
    expect(out.answers.severity).toMatchObject({ kind: "score", score: 3 })
    expect(out.usage).toEqual({ input_tokens: 50, output_tokens: 4 })
    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))
    expect(sent.model).toBe("typesafe/jev-1.13")
    expect(Object.keys(sent.questions)).toEqual(["substantive", "severity"])
  })

  it("fills a question the model skipped from the fixed rules, and says so", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jevReply({ substantive: { type: "noul", noul: 0.7 } }))
    const out = await decide(testEnv(), input())
    expect(out.decidedBy).toBe("mixed")
    expect(out.reason).toBe("partial")
    expect(out.answers.substantive).toEqual({ kind: "noul", p: 0.7 })
    expect(out.answers.severity).toEqual(FALLBACK.severity)
  })

  it.each([
    ["an upstream error", () => Promise.resolve(jevReply({}, 502)), "upstream"],
    ["a thrown fetch", () => Promise.reject(new Error("boom")), "upstream"],
  ])("falls back on %s", async (_label, impl, reason) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(impl as () => Promise<Response>)
    const out = await decide(testEnv(), input())
    expect(out).toMatchObject({ decidedBy: "heuristic", reason, model: null })
    expect(out.answers).toEqual(FALLBACK)
  })

  it("falls back without calling Jev when there is no key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const out = await decide(testEnv({ OPENROUTER_API_KEY: "" }), input())
    expect(out).toMatchObject({ decidedBy: "heuristic", reason: "no_key" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("JEV_REACT=off turns react decisions back into the fixed rules, without a deploy", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const out = await decide(testEnv({ JEV_REACT: "off" }), input("react"))
    expect(out).toMatchObject({ decidedBy: "heuristic", reason: "disabled" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("stops calling Jev for a project past its cap", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const req = input()
    for (let i = 0; i < JEV_PROJECT_CAP_PER_WINDOW; i++) {
      await recordRateLimitEvent(env.AQUILLA_PG, "jev_decisions", `project:${req.projectId}`)
    }
    const out = await decide(testEnv(), req)
    expect(out).toMatchObject({ decidedBy: "heuristic", reason: "capped" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("does not wait past a deadline that has already gone by", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const out = await decide(testEnv(), { ...input(), deadline: Date.now() - 1 })
    expect(out).toMatchObject({ decidedBy: "heuristic", reason: "timeout" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// AQU-1690: autopilot's Bible data questions run on every span of a run. They
// must never use up the cap react and triage share, and they need their own
// off switch.
describe("decide() — purpose bible-qa", () => {
  it("counts against its own bucket: triage's cap is not consumed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jevReply({ substantive: { type: "noul", noul: 0.8 } }))
    const req = input("bible-qa")
    const identifier = `project:${req.projectId}`
    for (let i = 0; i < 3; i++) await decide(testEnv(), req)
    expect(await countRecentRateLimitEvents(env.AQUILLA_PG, "jev_decisions", identifier)).toBe(0)
    expect(await countRecentRateLimitEvents(env.AQUILLA_PG, "jev_bible_qa", identifier)).toBe(3)
  })

  it("still calls Jev when triage's shared cap is spent, and stops at its own", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jevReply({ substantive: { type: "noul", noul: 0.8 } }))
    const req = input("bible-qa")
    for (let i = 0; i < JEV_PROJECT_CAP_PER_WINDOW; i++) {
      await recordRateLimitEvent(env.AQUILLA_PG, "jev_decisions", `project:${req.projectId}`)
    }
    expect((await decide(testEnv(), req)).decidedBy).not.toBe("heuristic")
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    for (let i = 0; i < JEV_BIBLE_QA_CAP_PER_WINDOW; i++) {
      await recordRateLimitEvent(env.AQUILLA_PG, "jev_bible_qa", `project:${req.projectId}`)
    }
    expect(await decide(testEnv(), req)).toMatchObject({ decidedBy: "heuristic", reason: "capped" })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("JEV_BIBLE_QA=off keeps every Bible data question unasked; react and triage are untouched", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jevReply({ substantive: { type: "noul", noul: 0.8 } }))
    expect(await decide(testEnv({ JEV_BIBLE_QA: "off" }), input("bible-qa"))).toMatchObject({ decidedBy: "heuristic", reason: "disabled" })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect((await decide(testEnv({ JEV_BIBLE_QA: "off" }), input("triage"))).decidedBy).not.toBe("heuristic")
  })
})
