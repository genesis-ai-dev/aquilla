// agent telemetry — PostHog events for one agent run (AQU-1467).
//
// WHY: the events are the only window into how the in-app agent behaves in
// production, and the data policy is counts only. These tests freeze both:
// what is sent, and (more important) what is never sent.

import { describe, it, expect, afterEach, vi } from "vitest"
import { makeAgentTelemetry, errorClassOf, scrubSensitive, classifyToolRun } from "../lib/agent/telemetry"

const CTX = { runId: "run-1", projectId: "proj-1", userId: 42, orgId: 7, model: "test/model" }

interface Sent {
  api_key: string
  batch: { event: string; distinct_id: string; properties: Record<string, unknown>; timestamp: string }[]
}

function spyFetch(impl?: () => Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(impl ?? (async () => new Response("{}")))
}

function sentBatch(spy: ReturnType<typeof spyFetch>): Sent {
  return JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body)) as Sent
}

afterEach(() => vi.restoreAllMocks())

describe("makeAgentTelemetry — switch", () => {
  it("does nothing, and fetches nothing, when POSTHOG_KEY is blank or unset", async () => {
    const spy = spyFetch()
    for (const env of [{}, { POSTHOG_KEY: "" }, { POSTHOG_KEY: "   " }]) {
      const t = makeAgentTelemetry(env, CTX)
      t.toolRun({ tool: "read", args: {}, ok: true, resultText: "x", latencyMs: 1 })
      t.generation({ span: "orchestrator", model: "m", ok: true })
      await t.flush("ok")
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it("posts one batch to the EU host by default, and to POSTHOG_HOST when set", async () => {
    const spy = spyFetch()
    const t = makeAgentTelemetry({ POSTHOG_KEY: "phc_test" }, CTX)
    await t.flush("ok")
    expect(spy.mock.calls[0][0]).toBe("https://eu.i.posthog.com/batch/")

    spy.mockClear()
    await makeAgentTelemetry({ POSTHOG_KEY: "phc_test", POSTHOG_HOST: "https://ph.example.com" }, CTX).flush("ok")
    expect(spy.mock.calls[0][0]).toBe("https://ph.example.com/batch/")
  })
})

describe("agent_tool_run outcome classes", () => {
  it("ok: a read that returned rows", async () => {
    const spy = spyFetch()
    const t = makeAgentTelemetry({ POSTHOG_KEY: "phc_test" }, CTX)
    t.toolRun({
      tool: "read",
      args: { fileId: "f1", ref: "MRK 1:1-20", filter: "untranslated" },
      lane: "Burmese",
      ok: true,
      data: { cells: [{ cellId: "c1" }, { cellId: "c2" }] as never },
      resultText: "cell_id|value\nc1|x",
      latencyMs: 12,
    })
    await t.flush("ok")
    const ev = sentBatch(spy).batch.find((e) => e.event === "agent_tool_run")!
    expect(ev.distinct_id).toBe("42")
    expect(ev.properties).toMatchObject({
      tool: "read",
      run_id: "run-1",
      project_id: "proj-1",
      lane: "Burmese",
      file_id: "f1",
      ref: "MRK 1:1-20",
      filter: "untranslated",
      outcome: "ok",
      count: 2,
      latency_ms: 12,
    })
    expect(ev.properties.error_class).toBeUndefined()
  })

  it("nothing-to-do: zero rows, or the two known empty-result openers", () => {
    expect(classifyToolRun({ ok: true, count: 0, resultText: "0 rows" })).toBe("nothing-to-do")
    expect(classifyToolRun({ ok: true, resultText: "Nothing to draft here" })).toBe("nothing-to-do")
    expect(classifyToolRun({ ok: true, resultText: "No matches for that" })).toBe("nothing-to-do")
    expect(classifyToolRun({ ok: true, count: 3, resultText: "rows" })).toBe("ok")
  })

  it("error: not ok wins over an empty count, and carries a scrubbed error_class", async () => {
    const spy = spyFetch()
    const t = makeAgentTelemetry({ POSTHOG_KEY: "phc_test" }, CTX)
    t.toolRun({
      tool: "search",
      args: {},
      ok: false,
      data: { hits: [] },
      resultText: 'error: no match for "secret words" in file 123',
      latencyMs: 3,
    })
    await t.flush("ok")
    const ev = sentBatch(spy).batch.find((e) => e.event === "agent_tool_run")!
    expect(ev.properties.outcome).toBe("error")
    expect(ev.properties.count).toBe(0)
    expect(ev.properties.error_class).toBe("error: no match for in file")
  })
})

describe("error class scrub", () => {
  it("returns undefined for a result that is not an error line", () => {
    expect(errorClassOf("cell_id|value")).toBeUndefined()
  })

  it("strips quoted text, digits, and uuids; collapses whitespace; keeps tool_error", () => {
    expect(errorClassOf('error:   unknown cell "abc"  9f1c2d3e-1111-4222-8333-444455556666 at row 42')).toBe(
      "error: unknown cell at row",
    )
    expect(errorClassOf("tool_error: timed out after 30 s")).toBe("tool_error: timed out after s")
  })

  it("uses the first line only", () => {
    expect(errorClassOf("error: bad ref\nSELECT * FROM secret")).toBe("error: bad ref")
  })

  it("truncates to 80 chars", () => {
    expect(errorClassOf(`error: ${"word ".repeat(40)}`)!.length).toBeLessThanOrEqual(80)
  })

  it("drops the value entirely for aqk_ tokens, JWTs, Bearer headers, and emails", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.payloadpayload.sig"
    expect(errorClassOf("error: bad key aqk_abcdef")).toBeUndefined()
    expect(errorClassOf(`error: token ${jwt} rejected`)).toBeUndefined()
    expect(errorClassOf("error: Authorization: Bearer xyz rejected")).toBeUndefined()
    expect(errorClassOf("error: user a@b.com not found")).toBeUndefined()
    expect(errorClassOf('error: key "sk-or-v1-abc" invalid')).toBeUndefined()
  })

  it("scrubSensitive passes clean strings through", () => {
    expect(scrubSensitive("error: bad ref")).toBe("error: bad ref")
    expect(scrubSensitive("sk-or-x")).toBeUndefined()
  })
})

describe("payload contents", () => {
  it("never puts prompt, result, or cell text into any event", async () => {
    const SENTINEL = "SENTINEL-do-not-leak"
    const spy = spyFetch()
    const t = makeAgentTelemetry({ POSTHOG_KEY: "phc_test" }, CTX)
    t.toolRun({
      tool: "sql",
      args: { sql: `SELECT '${SENTINEL}'`, query: SENTINEL, text: SENTINEL, prompt: SENTINEL },
      ok: false,
      data: { cells: [{ cellId: "c1", source: SENTINEL, target: SENTINEL }] as never },
      resultText: `${SENTINEL}\nerror: ${SENTINEL}`,
      latencyMs: 1,
    })
    t.toolRun({
      tool: "read",
      args: {},
      ok: false,
      resultText: `error: bad "${SENTINEL}"`,
      latencyMs: 1,
    })
    t.generation({ span: "orchestrator", model: "m", ok: true, promptTokens: 1, inputChars: 10, outputChars: 5 })
    await t.flush("ok")
    const raw = String((spy.mock.calls[0][1] as RequestInit).body)
    expect(raw).not.toContain(SENTINEL)
    expect(raw).not.toContain("$ai_input\"")
    expect(raw).not.toContain("$ai_output_choices")
  })

  it("caps tool arguments at 80 chars and drops any that look like secrets", async () => {
    const spy = spyFetch()
    const t = makeAgentTelemetry({ POSTHOG_KEY: "phc_test" }, CTX)
    t.toolRun({
      tool: "read",
      args: { ref: "x".repeat(200), filter: "aqk_live_secret", fileId: "someone@example.com" },
      lane: "Bearer abc",
      ok: true,
      resultText: "ok",
      latencyMs: 1,
    })
    await t.flush("ok")
    const props = sentBatch(spy).batch.find((e) => e.event === "agent_tool_run")!.properties
    expect(props.ref).toBe("x".repeat(80))
    expect(props.filter).toBeUndefined()
    expect(props.file_id).toBeUndefined()
    expect(props.lane).toBeUndefined()
  })
})

describe("flush", () => {
  it("sends one request holding the trace and every generation under one $ai_trace_id", async () => {
    const spy = spyFetch()
    const t = makeAgentTelemetry({ POSTHOG_KEY: "phc_test" }, CTX)
    t.generation({ span: "orchestrator", model: "m", promptTokens: 100, completionTokens: 50, costUsd: 0.001, latencyMs: 2500, ok: true, httpStatus: 200 })
    t.generation({ span: "tool-model:draft", model: "d", promptTokens: 10, completionTokens: 5, costUsd: 0.0005, ok: true })
    t.generation({ span: "orchestrator", model: "m", latencyMs: 100, ok: false, httpStatus: 502 })
    await t.flush("error")

    expect(spy).toHaveBeenCalledTimes(1)
    const init = spy.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const sent = sentBatch(spy)
    expect(sent.api_key).toBe("phc_test")
    const gens = sent.batch.filter((e) => e.event === "$ai_generation")
    const trace = sent.batch.filter((e) => e.event === "$ai_trace")
    expect(gens).toHaveLength(3)
    expect(trace).toHaveLength(1)
    for (const e of [...gens, ...trace]) expect(e.properties.$ai_trace_id).toBe("run-1")
    expect(gens[0].properties).toMatchObject({
      $ai_span_name: "orchestrator",
      $ai_model: "m",
      $ai_provider: "openrouter",
      $ai_input_tokens: 100,
      $ai_output_tokens: 50,
      $ai_total_cost_usd: 0.001,
      $ai_latency: 2.5,
      $ai_is_error: false,
      $ai_http_status: 200,
    })
    expect(gens[1].properties.$ai_latency).toBeUndefined()
    expect(gens[2].properties).toMatchObject({ $ai_is_error: true, $ai_http_status: 502 })
    expect(trace[0].properties).toMatchObject({
      $ai_span_name: "agent-run",
      $ai_is_error: true,
      $ai_model: "test/model",
      generations: 3,
      prompt_tokens: 110,
      completion_tokens: 55,
    })
  })

  it("flags is_error on the trace only for status error", async () => {
    const spy = spyFetch()
    const t = makeAgentTelemetry({ POSTHOG_KEY: "phc_test" }, CTX)
    await t.flush("capped")
    expect(sentBatch(spy).batch[0].properties.$ai_is_error).toBe(false)
  })

  it("never throws: rejected fetch, synchronous throw, and a second flush", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const t = makeAgentTelemetry({ POSTHOG_KEY: "phc_test" }, CTX)
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("boom"))
    await expect(t.flush("ok")).resolves.toBeUndefined()

    const t2 = makeAgentTelemetry({ POSTHOG_KEY: "phc_test" }, CTX)
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => {
      throw new Error("sync boom")
    })
    await expect(t2.flush("ok")).resolves.toBeUndefined()
    await expect(t2.flush("ok")).resolves.toBeUndefined()
  })
})
