import { afterEach, describe, expect, it, vi } from "vitest"
import { transcribeHostedPcm } from "./transcribe-hosted"

vi.mock("@/lib/frontier/auth", () => ({ AUTH_BASE: "http://identity" }))
afterEach(() => vi.restoreAllMocks())

describe("hosted transcription client", () => {
  it("splits long clips and preserves clip-relative word timings", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ text: "hello", chunks: [
        { text: "hello", start: 0, end: 0.5 },
      ] }),
    )
    const result = await transcribeHostedPcm(
      new Float32Array(61 * 16000), "session-jwt", "project", "en",
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
