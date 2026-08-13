// makeLlmCall's concurrency gate + capacity retry.
//
// Why these matter: span concurrency is NOT request concurrency — one span
// fans its verifier panel out three-wide, so N spans burst to ~3N requests.
// Against an upstream with a fixed slot count (a self-hosted llama.cpp server,
// or any provider rate limit) the surplus is rejected in milliseconds, and the
// pipeline treats a rejected `ambiguity` verifier as its whole span failing.
// The gate is what keeps wave width a scheduling decision rather than a way to
// silently lose spans.

import { describe, it, expect, vi, afterEach } from "vitest"
import { makeLlmCall } from "../lib/contextual/tick"
import type { LlmRequest } from "../lib/contextual/types"

const URL_ = "http://upstream.local/chat/completions"
const MODELS = { fast: "m-fast", mid: "m-mid", deep: "m-deep" }

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  system: "s",
  user: "u",
  tier: "mid",
  maxTokens: 16,
  temperature: 0,
  ...over,
})

const okBody = (content = "hi") =>
  JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("makeLlmCall concurrency gate", () => {
  it("never exceeds maxInFlight, even when every caller starts at once", async () => {
    let inFlight = 0
    let peak = 0
    const release: (() => void)[] = []

    vi.stubGlobal("fetch", async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      // Hold the slot until the test releases it, so overlap is observable.
      await new Promise<void>((r) => release.push(r))
      inFlight--
      return new Response(okBody(), { status: 200 })
    })

    const llm = makeLlmCall({ url: URL_, apiKey: "k", models: MODELS, maxInFlight: 3 })
    const calls = Promise.all(Array.from({ length: 12 }, () => llm(req())))

    // Drain: repeatedly release whatever is currently held until all settle.
    for (let i = 0; i < 12; i++) {
      await vi.waitFor(() => expect(release.length).toBeGreaterThan(0))
      release.shift()!()
      await Promise.resolve()
    }
    await calls

    expect(peak).toBe(3)
  })

  it("is uncapped when maxInFlight is omitted (unchanged OpenRouter behaviour)", async () => {
    let inFlight = 0
    let peak = 0
    const release: (() => void)[] = []
    vi.stubGlobal("fetch", async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise<void>((r) => release.push(r))
      inFlight--
      return new Response(okBody(), { status: 200 })
    })

    const llm = makeLlmCall({ url: URL_, apiKey: "k", models: MODELS })
    const calls = Promise.all(Array.from({ length: 5 }, () => llm(req())))
    await vi.waitFor(() => expect(release.length).toBe(5))
    release.forEach((r) => r())
    await calls

    expect(peak).toBe(5)
  })
})

describe("makeLlmCall capacity retry", () => {
  it("retries a 429 and succeeds, reporting every attempt to the meter", async () => {
    let n = 0
    vi.stubGlobal("fetch", async () => {
      n++
      return n < 3
        ? new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 })
        : new Response(okBody("done"), { status: 200 })
    })

    const seen: { ok: boolean; promptTokens: number }[] = []
    const llm = makeLlmCall({
      url: URL_,
      apiKey: "k",
      models: MODELS,
      onUsage: (u) => seen.push({ ok: u.ok, promptTokens: u.promptTokens }),
    })

    await expect(llm(req())).resolves.toBe("done")
    expect(n).toBe(3)
    // Both rejections are metered as zero-token failures: contention has to stay
    // visible in the ledger, not be smoothed away by the retry that hid it.
    expect(seen.map((s) => s.ok)).toEqual([false, false, true])
    expect(seen.filter((s) => !s.ok).every((s) => s.promptTokens === 0)).toBe(true)
  })

  it("does not retry a non-capacity error", async () => {
    let n = 0
    vi.stubGlobal("fetch", async () => {
      n++
      return new Response("bad model", { status: 400 })
    })
    const llm = makeLlmCall({ url: URL_, apiKey: "k", models: MODELS })
    await expect(llm(req())).rejects.toThrow(/provider_http_error status=400/)
    expect(n).toBe(1)
  })

  it("gives up after the attempt ceiling rather than retrying forever", async () => {
    let n = 0
    vi.stubGlobal("fetch", async () => {
      n++
      return new Response("busy", { status: 429 })
    })
    const llm = makeLlmCall({ url: URL_, apiKey: "k", models: MODELS })
    await expect(llm(req())).rejects.toThrow(/provider_http_error status=429/)
    expect(n).toBe(5)
  }, 30_000)

  it("categorizes an invalid success body without persisting its contents", async () => {
    vi.stubGlobal("fetch", async () => new Response(
      "Authorization: Bearer opaque-invalid-json user material",
      { status: 200, headers: { "Content-Type": "application/json" } },
    ))
    const llm = makeLlmCall({ url: URL_, apiKey: "k", models: MODELS })
    await expect(llm(req())).rejects.toThrow(/^provider_invalid_response status=200$/)
  })
})
