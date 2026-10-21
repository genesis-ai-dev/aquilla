import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  __resetHostedTranscriptionForTests, HostedTranscriptionUnavailableError, hostedLanguageTag, hostedWindowSeconds,
  transcribeHosted, transcribeHostedPcm,
} from "./transcribe-hosted"
import { categorizeAiError } from "./ai-error"
import { setTranscriptionModel } from "./transcription-model"
import { __resetZsWarmupForTests, type WarmupUi } from "./omni-warmup"

vi.mock("@/lib/frontier/auth", () => ({ AUTH_BASE: "http://identity" }))
vi.mock("@/lib/sync/sync-worker-url", () => ({ syncWorkerHttpOrigin: () => "http://sync" }))
const toasts = vi.hoisted(() => ({
  noExamples: vi.fn(async (): Promise<"omni-ctc" | "cancel"> => "omni-ctc"),
  disabled: vi.fn(),
}))
vi.mock("./omni-warmup-toast", () => ({
  toastWarmupUi: {},
  promptZeroShotNoExamples: toasts.noExamples,
  toastZeroShotDisabled: toasts.disabled,
}))
beforeEach(() => {
  localStorage.clear()
  toasts.noExamples.mockClear()
  toasts.disabled.mockClear()
  __resetZsWarmupForTests()
  __resetHostedTranscriptionForTests()
})
afterEach(() => vi.restoreAllMocks())

describe("hosted transcription client", () => {
  it("splits long clips and preserves clip-relative word timings", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ text: "hello", chunks: [
        { text: "hello", start: 0, end: 0.5 },
      ] }),
    )
    const result = await transcribeHostedPcm(
      new Float32Array(61 * 16000), "session-jwt", "project", { language: "en" },
    )
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    for (const [url, init] of fetchSpy.mock.calls) {
      expect(url).toBe("http://identity/api/v1/audio/transcriptions")
      expect(new Headers(init?.headers).get("Authorization"))
        .toBe("Bearer session-jwt")
      expect(new Headers(init?.headers).get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/)
      expect(JSON.parse(String(init?.body))).toMatchObject({
        projectId: "project", language: "en", input_audio: { format: "wav" },
      })
    }
    expect(result).toEqual({ text: "hello hello", chunks: [
      { text: "hello", start: 0, end: 0.5 },
      { text: "hello", start: 60, end: 60.5 },
    ] })
  })

  it("explains exhausted capacity without starting another request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: "weekly_ai_allowance_exhausted" }, { status: 429 }),
    )
    await expect(transcribeHostedPcm(new Float32Array(61000), "jwt", "p"))
      .rejects.toThrow(/AI capacity/)
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it("surfaces hosted failures without silently starting a model download", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }))
    await expect(transcribeHostedPcm(new Float32Array(16000), "jwt", "p"))
      .rejects.toThrow(/503/)
  })

  // 2026-10-20: every hosted Whisper request answered 502 for days and the
  // user saw "failed (502). Try again." with no way out. A server error from
  // the model must become the error whose copy names the remedy.
  it("turns a 5xx from the hosted model into the error that points to another model", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: "Transcription provider failed" }, { status: 502 }))
    const failure = await transcribeHostedPcm(new Float32Array(16000), "jwt", "p").catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(HostedTranscriptionUnavailableError)
    expect(categorizeAiError((failure as Error).message).category).toBe("transcription-model-unavailable")
  })

  // AQU-1681: a batch over an episode reaches the per-user limit (60 requests
  // per 15 minutes). It must wait as long as the limiter says and send the
  // same audio again — never skip it, never give the row up.
  it("waits out the per-user limit and resends the same audio, when asked to", async () => {
    let calls = 0
    const bodies: string[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bodies.push(String(init?.body))
      calls += 1
      return calls === 1
        ? Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "420" } })
        : Response.json({ text: "hello", chunks: [{ text: "hello", start: 0, end: 0.5 }], granularity: "word" })
    })
    const waits: number[] = []
    const result = await transcribeHostedPcm(new Float32Array(16000), "jwt", "p", {
      language: "en", onRateLimited: async (seconds) => { waits.push(seconds) },
    })
    expect(waits).toEqual([420])
    expect(calls).toBe(2)
    expect(JSON.parse(bodies[1]!).input_audio).toEqual(JSON.parse(bodies[0]!).input_audio)
    expect(result).toEqual({ text: "hello", chunks: [{ text: "hello", start: 0, end: 0.5 }], granularity: "word" })
  })

  it("asks again after a minute when the limiter's wait cannot be read", async () => {
    let calls = 0
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => (++calls === 1
      ? Response.json({ error: "rate_limited" }, { status: 429 })
      : Response.json({ text: "", chunks: [] })))
    const waits: number[] = []
    await transcribeHostedPcm(new Float32Array(16000), "jwt", "p", { onRateLimited: async (s) => { waits.push(s) } })
    expect(waits).toEqual([60])
  })

  it("still fails a refused request for a caller that does not wait (one row's Transcribe button)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "rate_limited" }, { status: 429 }))
    await expect(transcribeHostedPcm(new Float32Array(16000), "jwt", "p")).rejects.toThrow(/429/)
  })

  it("reports the coarsest timing any window came back with", async () => {
    let calls = 0
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      text: "x", chunks: [{ text: "x", start: 0, end: 1 }], granularity: ++calls === 1 ? "word" : "segment",
    }))
    const result = await transcribeHostedPcm(new Float32Array(61 * 16000), "jwt", "p")
    expect(result.granularity).toBe("segment")
  })
})

// Whisper and Qwen take a minute per request; Omnilingual must stay under
// 40 s. The window follows where the SERVER will send the audio, and the
// server decides by the raw tag, so the client must send that tag rather than
// its own mapping.
describe("hosted routing", () => {
  const transcript = () => Response.json({ text: "w", chunks: [{ text: "w", start: 0, end: 1 }] })
  const bodies = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls
    .filter(([url]) => String(url).endsWith("/api/v1/audio/transcriptions"))
    .map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body)))

  it("sizes windows by model: a minute for Whisper and Qwen, 30 s for Omnilingual", () => {
    expect(hostedWindowSeconds("whisper", "tpi")).toBe(60)
    expect(hostedWindowSeconds("qwen3-asr", "yue")).toBe(60)
    expect(hostedWindowSeconds("omni-ctc", "en")).toBe(30)
    expect(hostedWindowSeconds("omni-zs", "en")).toBe(30)
    // Automatic: whatever the server's routing will pick.
    expect(hostedWindowSeconds("auto", "es")).toBe(60) // Whisper
    expect(hostedWindowSeconds("auto", "yue")).toBe(60) // Qwen
    expect(hostedWindowSeconds("auto", undefined)).toBe(60) // Whisper auto-detect
    expect(hostedWindowSeconds("auto", "tpi")).toBe(30) // Omnilingual CTC
  })

  it("cuts Omnilingual windows at the quietest point before 30 s, never after", async () => {
    const pcm = new Float32Array(50 * 16000).fill(0.5)
    // A pause at 27–27.5 s: the cut belongs there, not mid-word at 30 s.
    pcm.fill(0, 27 * 16000, 27.5 * 16000)
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => transcript())
    const result = await transcribeHostedPcm(pcm, "j", "p", { language: "tpi" })
    expect(bodies(spy)).toHaveLength(2)
    const cutSec = result.chunks[1].start
    expect(cutSec).toBeGreaterThanOrEqual(27)
    expect(cutSec).toBeLessThan(27.5)
  })

  it("sends the raw tag and the pinned model; Automatic sends no model field", async () => {
    expect(hostedLanguageTag("fra-CA")).toBe("fra-CA")
    expect(hostedLanguageTag("Spanish")).toBeUndefined()
    expect(hostedLanguageTag("deadbeef")).toBeUndefined()
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => transcript())
    await transcribeHosted(new Float32Array(16000), { jwt: "j", projectId: "p", username: "alice", language: "tpi-Latn" })
    setTranscriptionModel("alice", "qwen3-asr")
    await transcribeHosted(new Float32Array(16000), { jwt: "j", projectId: "p", username: "alice", language: "yue" })
    const [auto, qwen] = bodies(spy)
    expect(auto.language).toBe("tpi-Latn")
    expect(auto).not.toHaveProperty("model")
    expect(qwen).toMatchObject({ model: "qwen3-asr", language: "yue" })
  })

  it("carries the model the server used and whether timings are approximate", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      text: "w", chunks: [], model: "omni-ctc", timingsApproximate: true,
    }))
    await expect(transcribeHostedPcm(new Float32Array(16000), "j", "p")).resolves
      .toMatchObject({ model: "omni-ctc", timingsApproximate: true })
  })

  describe("zero-shot", () => {
    const readyUi: WarmupUi = { starting: vi.fn(), ready: vi.fn(), timedOut: vi.fn() }
    const cell = { cellId: "c1", fileId: "f1", lane: "tpi", getSyncToken: async () => "sync-token" }
    const example = { cellId: "e1", fileId: "f1", text: "ahu", durationMs: 9000, audioUrl: "http://sync/a1" }
    beforeEach(() => setTranscriptionModel("alice", "omni-zs"))

    function server(examples: unknown[], transcribe: () => Response = transcript) {
      return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input)
        if (url.includes("/transcription-examples")) return Response.json(examples)
        if (url.includes("/status")) return Response.json({ state: "ready" })
        return transcribe()
      })
    }
    const run = (pcm = new Float32Array(16000), onWaitingForModel?: (waiting: boolean) => void) =>
      transcribeHosted(pcm, {
        jwt: "j", projectId: "p", username: "alice", language: "tpi", zeroShot: cell, warmupUi: readyUi,
        ...(onWaitingForModel ? { onWaitingForModel } : {}),
      })

    it("fetches the cell's examples once by cellId and sends them with every window", async () => {
      const spy = server([example])
      await run(new Float32Array(45 * 16000))
      const exampleCalls = spy.mock.calls.filter(([url]) => String(url).includes("/transcription-examples"))
      expect(exampleCalls).toHaveLength(1)
      const query = new URL(String(exampleCalls[0][0])).searchParams
      expect(Object.fromEntries(query)).toEqual({ lane: "tpi", cellId: "c1", limit: "10" })
      expect(new Headers(exampleCalls[0][1]?.headers).get("Authorization")).toBe("Bearer sync-token")
      const sent = bodies(spy)
      expect(sent).toHaveLength(2) // 45 s in ≤30 s windows
      for (const body of sent) {
        expect(body).toMatchObject({ model: "omni-zs", language: "tpi", examples: [{ url: "http://sync/a1", text: "ahu" }] })
      }
    })

    it("with no examples, offers Omnilingual standard and runs it when accepted", async () => {
      const spy = server([])
      await run()
      expect(toasts.noExamples).toHaveBeenCalledOnce()
      const [body] = bodies(spy)
      expect(body).toMatchObject({ model: "omni-ctc" })
      expect(body).not.toHaveProperty("examples")
    })

    it("a batch with no examples asks once, and declining leaves every take untranscribed", async () => {
      toasts.noExamples.mockResolvedValueOnce("cancel")
      const spy = server([])
      await expect(run()).rejects.toThrow(/at least one recorded/)
      await expect(run()).rejects.toThrow(/at least one recorded/)
      expect(toasts.noExamples).toHaveBeenCalledOnce()
      expect(bodies(spy)).toHaveLength(0)
    })

    it("the server's zs_no_examples takes the same offer", async () => {
      const spy = server([example])
      spy.mockImplementation(async (input) => {
        const url = String(input)
        if (url.includes("/transcription-examples")) return Response.json([example])
        if (url.includes("/status")) return Response.json({ state: "ready" })
        const body = JSON.parse(String(spy.mock.calls.at(-1)?.[1]?.body))
        return body.model === "omni-zs" ? Response.json({ error: "zs_no_examples" }, { status: 400 }) : transcript()
      })
      await expect(run()).resolves.toMatchObject({ text: "w" })
      expect(bodies(spy).map(body => body.model)).toEqual(["omni-zs", "omni-ctc"])
    })

    it("on asr_warming waits for the model, then sends the take again exactly once", async () => {
      let warming = 2
      const spy = server([example], () => warming-- > 0
        ? Response.json({ error: "asr_warming" }, { status: 503 })
        : transcript())
      const waiting: boolean[] = []
      // The second 503 is not retried again: one retry per take.
      await expect(run(new Float32Array(16000), (w) => waiting.push(w))).rejects.toThrow()
      expect(bodies(spy)).toHaveLength(2)
      warming = 1
      await expect(run(new Float32Array(16000), (w) => waiting.push(w))).resolves.toMatchObject({ text: "w" })
      expect(bodies(spy)).toHaveLength(4)
      // The take shows "waiting for model" while it waits, and stops showing it.
      expect(waiting.at(-1)).toBe(false)
      expect(waiting).toContain(true)
    })

    it("when the org has turned zero-shot off, retries with the automatic model", async () => {
      let first = true
      const spy = server([example], () => {
        if (!first) return transcript()
        first = false
        return Response.json({ error: "zero_shot_disabled" }, { status: 403 })
      })
      await expect(run()).resolves.toMatchObject({ text: "w" })
      expect(toasts.disabled).toHaveBeenCalledOnce()
      expect(bodies(spy).map(body => body.model)).toEqual(["omni-zs", undefined])
    })

    it("a source clip (no cell context) never uses zero-shot", async () => {
      const spy = server([])
      await transcribeHosted(new Float32Array(16000), { jwt: "j", projectId: "p", username: "alice", language: "tpi" })
      expect(spy.mock.calls.some(([url]) => String(url).includes("/transcription-examples"))).toBe(false)
      expect(bodies(spy)[0]).not.toHaveProperty("model")
    })
  })
})
