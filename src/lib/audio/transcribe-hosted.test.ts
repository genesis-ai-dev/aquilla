import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { hostedLanguageTag, hostedWindowSeconds, transcribeHosted, transcribeHostedPcm } from "./transcribe-hosted"
import { setTranscriptionModel } from "./transcription-model"
import { __resetZsWarmupForTests, type WarmupUi } from "./omni-warmup"

vi.mock("@/lib/frontier/auth", () => ({ AUTH_BASE: "http://identity" }))
vi.mock("@/lib/sync/sync-worker-url", () => ({ syncWorkerHttpOrigin: () => "http://sync" }))
const toasts = vi.hoisted(() => ({ noExamples: vi.fn(), disabled: vi.fn() }))
vi.mock("./omni-warmup-toast", () => ({
  toastWarmupUi: {},
  toastZeroShotNoExamples: toasts.noExamples,
  toastZeroShotDisabled: toasts.disabled,
}))
beforeEach(() => {
  localStorage.clear()
  toasts.noExamples.mockClear()
  toasts.disabled.mockClear()
  __resetZsWarmupForTests()
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
})

// Whisper takes a minute per request; Omnilingual must stay under 40 s. The
// window follows where the SERVER will send the audio, and the server decides
// by the raw tag, so the client must send that tag rather than its own mapping.
describe("hosted routing", () => {
  const transcript = () => Response.json({ text: "w", chunks: [{ text: "w", start: 0, end: 1 }] })

  it("sizes windows by route: a minute for Whisper, 30 s for Omnilingual", async () => {
    expect(hostedWindowSeconds("auto", "es")).toBe(60)
    expect(hostedWindowSeconds("auto", undefined)).toBe(60) // Whisper auto-detect
    expect(hostedWindowSeconds("auto", "tpu")).toBe(30) // not a Whisper language → CTC
    expect(hostedWindowSeconds("zs", "es")).toBe(30)

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => transcript())
    const result = await transcribeHostedPcm(new Float32Array(61 * 16000), "j", "p", { language: "tpu" })
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(result.chunks.map(c => c.start)).toEqual([0, 30, 60])
  })

  it("sends the raw tag, and drops names and lane ids so Whisper still auto-detects", async () => {
    expect(hostedLanguageTag("fra-CA")).toBe("fra-CA")
    expect(hostedLanguageTag("Spanish")).toBeUndefined()
    expect(hostedLanguageTag("deadbeef")).toBeUndefined()
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => transcript())
    await transcribeHosted(new Float32Array(16000), { jwt: "j", projectId: "p", language: "tpu-Latn" })
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))
    expect(body.language).toBe("tpu-Latn")
    // The automatic route keeps the old payload: no model field at all.
    expect(body).not.toHaveProperty("model")
  })

  describe("zero-shot", () => {
    const readyUi: WarmupUi = { starting: vi.fn(), ready: vi.fn(), timedOut: vi.fn() }
    const cell = {
      cellId: "c1", fileId: "f1", sourceText: "In the beginning", lane: "tpu",
      getSyncToken: async () => "sync-token",
    }
    beforeEach(() => setTranscriptionModel("alice", "zs"))

    function server(examples: unknown[], transcribe: () => Response = transcript) {
      return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input)
        if (url.includes("/transcription-examples")) return Response.json(examples)
        if (url.includes("/status")) return Response.json({ state: "ready" })
        return transcribe()
      })
    }
    const run = (pcm = new Float32Array(16000)) => transcribeHosted(pcm, {
      jwt: "j", projectId: "p", username: "alice", language: "tpu", zeroShot: cell, warmupUi: readyUi,
    })
    const transcribeBodies = (spy: ReturnType<typeof server>) => spy.mock.calls
      .filter(([url]) => String(url).endsWith("/api/v1/audio/transcriptions"))
      .map(([, init]) => JSON.parse(String(init?.body)))

    it("fetches the cell's examples once and sends them with every window", async () => {
      const spy = server([{ cellId: "e1", fileId: "f1", text: "ahu", durationMs: 9000, audioUrl: "http://sync/a1" }])
      await run(new Float32Array(45 * 16000))
      const exampleCalls = spy.mock.calls.filter(([url]) => String(url).includes("/transcription-examples"))
      expect(exampleCalls).toHaveLength(1)
      const query = new URL(String(exampleCalls[0][0])).searchParams
      expect(Object.fromEntries(query)).toEqual({ lane: "tpu", sourceText: "In the beginning", excludeCellId: "c1" })
      expect(new Headers(exampleCalls[0][1]?.headers).get("Authorization")).toBe("Bearer sync-token")
      const bodies = transcribeBodies(spy)
      expect(bodies).toHaveLength(2) // 45 s in 30 s windows
      for (const body of bodies) {
        expect(body).toMatchObject({ model: "zs", language: "tpu", examples: [{ url: "http://sync/a1", text: "ahu" }] })
      }
    })

    it("with no examples, runs the automatic model and says why", async () => {
      const spy = server([])
      await run()
      expect(toasts.noExamples).toHaveBeenCalledOnce()
      const [body] = transcribeBodies(spy)
      expect(body).not.toHaveProperty("model")
      expect(body).not.toHaveProperty("examples")
    })

    it("when the org has turned zero-shot off, retries with the automatic model", async () => {
      let first = true
      const spy = server(
        [{ cellId: "e1", fileId: "f1", text: "ahu", durationMs: 9000, audioUrl: "http://sync/a1" }],
        () => {
          if (!first) return transcript()
          first = false
          return Response.json({ error: "zero_shot_disabled" }, { status: 403 })
        },
      )
      await expect(run()).resolves.toMatchObject({ text: "w" })
      expect(toasts.disabled).toHaveBeenCalledOnce()
      expect(transcribeBodies(spy).map(body => body.model)).toEqual(["zs", undefined])
    })

    it("a source clip (no cell context) never uses zero-shot", async () => {
      const spy = server([])
      await transcribeHosted(new Float32Array(16000), { jwt: "j", projectId: "p", username: "alice", language: "tpu" })
      expect(spy.mock.calls.some(([url]) => String(url).includes("/transcription-examples"))).toBe(false)
    })
  })
})
