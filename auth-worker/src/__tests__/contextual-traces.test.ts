// Autopilot model-call traces (lib/contextual/traces.ts + makeLlmCall.onTrace).
//
// Why these matter: the Team step inspector is the only place a translator can
// see WHY the agent drafted what it did. That needs exactly one trace per call
// (retries collapsed, failures included), and it must hold the line on what
// leaves the worker: provider error bodies never land in a trace, and prompt
// text reaches PostHog only when an environment explicitly opts in.

import { describe, it, expect, vi, afterEach } from "vitest"
import { makeLlmCall, type LlmCallTrace } from "../lib/contextual/tick"
import { TraceRecorder, TRACE_TEXT_MAX_CHARS } from "../lib/contextual/traces"
import type { AquillaDb } from "../../../db/shim/postgres"

const URL_ = "http://upstream.local/chat/completions"
const MODELS = { fast: "m-fast", mid: "m-mid", deep: "m-deep" }
const REQ = {
  system: "you are a drafter",
  user: "translate Mark 4:1",
  tier: "mid" as const,
  maxTokens: 16,
  temperature: 0,
  label: "draft",
  spanId: "span-1",
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("makeLlmCall onTrace", () => {
  it("records the prompt, reply and generation id once per successful call", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      id: "gen-123",
      choices: [{ message: { content: "drafted text" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })))
    const traces: LlmCallTrace[] = []
    const llm = makeLlmCall({ url: URL_, apiKey: "k", models: MODELS, onTrace: (t) => traces.push(t) })
    await llm(REQ)
    expect(traces).toHaveLength(1)
    expect(traces[0]).toMatchObject({
      system: "you are a drafter",
      user: "translate Mark 4:1",
      output: "drafted text",
      error: null,
      generationId: "gen-123",
      label: "draft",
      spanId: "span-1",
      model: "m-mid",
      attempts: 1,
    })
  })

  it("records a failed call with a machine code, never the provider body", async () => {
    vi.stubGlobal("fetch", async () => new Response("secret sk-or-leak echo", { status: 400 }))
    const traces: LlmCallTrace[] = []
    const llm = makeLlmCall({ url: URL_, apiKey: "k", models: MODELS, onTrace: (t) => traces.push(t) })
    await expect(llm(REQ)).rejects.toThrow("provider_http_error")
    expect(traces).toHaveLength(1)
    expect(traces[0]!.output).toBeNull()
    expect(traces[0]!.error).toBe("provider_http_error status=400")
    expect(JSON.stringify(traces[0])).not.toContain("sk-or-leak")
  })

  it("collapses retries into one trace that counts the attempts", async () => {
    vi.useFakeTimers()
    let n = 0
    vi.stubGlobal("fetch", async () => {
      n++
      return n === 1
        ? new Response("busy", { status: 503 })
        : new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }))
    })
    const traces: LlmCallTrace[] = []
    const llm = makeLlmCall({ url: URL_, apiKey: "k", models: MODELS, onTrace: (t) => traces.push(t) })
    const done = llm(REQ)
    await vi.runAllTimersAsync()
    await done
    expect(traces).toHaveLength(1)
    expect(traces[0]!.attempts).toBe(2)
  })

  it("never lets a throwing trace sink break the call", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] })))
    const llm = makeLlmCall({
      url: URL_, apiKey: "k", models: MODELS,
      onTrace: () => { throw new Error("sink down") },
    })
    await expect(llm(REQ)).resolves.toBe("ok")
  })
})

function trace(over: Partial<LlmCallTrace> = {}): LlmCallTrace {
  return {
    ...REQ,
    tier: "mid",
    model: "m-mid",
    output: "reply",
    error: null,
    promptTokens: 1,
    completionTokens: 1,
    costCents: 0,
    latencyMs: 5,
    ok: true,
    attempts: 1,
    ...over,
  }
}

function fakeDb() {
  const writes: unknown[][] = []
  const db = {
    prepare: () => ({
      bind: (...binds: unknown[]) => ({
        run: async () => { writes.push(binds) },
      }),
    }),
  } as unknown as AquillaDb
  return { db, writes }
}

describe("TraceRecorder", () => {
  it("clips oversized text and marks the row truncated", async () => {
    const { db, writes } = fakeDb()
    const rec = new TraceRecorder(db, { runId: "r", projectId: "p" }, { store: true, posthog: null })
    rec.add(trace({ user: "x".repeat(TRACE_TEXT_MAX_CHARS + 10) }))
    await rec.flush()
    const row = writes[0]!
    expect((row[7] as string).length).toBeLessThan(TRACE_TEXT_MAX_CHARS + 20)
    expect(row[7]).toContain("[truncated]")
    expect(row[16]).toBe(true)
  })

  it("sends counts to PostHog but no prompt text unless content is opted in", async () => {
    const bodies: string[] = []
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return new Response("{}")
    })
    const { db } = fakeDb()
    const off = new TraceRecorder(db, { runId: "r", projectId: "p" }, {
      store: false, posthog: { key: "phc", host: "http://ph", content: false },
    })
    off.add(trace())
    await off.flush()
    expect(bodies[0]).toContain("$ai_generation")
    expect(bodies[0]).not.toContain("translate Mark 4:1")

    const on = new TraceRecorder(db, { runId: "r", projectId: "p" }, {
      store: false, posthog: { key: "phc", host: "http://ph", content: true },
    })
    on.add(trace())
    await on.flush()
    expect(bodies[1]).toContain("translate Mark 4:1")
  })

  it("does no work when storage and PostHog are both off", async () => {
    const { db, writes } = fakeDb()
    const rec = new TraceRecorder(db, { runId: "r", projectId: "p" }, { store: false, posthog: null })
    rec.add(trace())
    await rec.flush()
    expect(writes).toHaveLength(0)
  })
})
