import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"

afterEach(() => vi.restoreAllMocks())

const settings = () => Object.assign(Object.create(env), {
  OPENROUTER_API_KEY: "platform-secret",
  OPENROUTER_BASE_URL: "https://upstream.example/api/v1/",
})
const body = { projectId: "audio-project",
  input_audio: { data: "UklGRg==", format: "wav" } }

async function owner() {
  await seedUser(1, "audio-owner")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, created_by) VALUES (?, 'Audio', 1)",
  ).bind(body.projectId).run()
  return jwtFor("audio-owner")
}

describe("hosted transcription", () => {
  it("requires authentication", async () => {
    const response = await app.request("/api/v1/audio/transcriptions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, settings())
    expect(response.status).toBe(401)
  })

  it("rejects users without project access before spending", async () => {
    await seedUser(1, "outsider")
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const response = await app.request("/api/v1/audio/transcriptions", {
      method: "POST", headers: authHeader(await jwtFor("outsider")),
      body: JSON.stringify(body),
    }, settings())
    expect(response.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("reports missing server credentials", async () => {
    const jwt = await owner()
    const response = await app.request("/api/v1/audio/transcriptions", {
      method: "POST", headers: authHeader(jwt), body: JSON.stringify(body),
    }, Object.assign(settings(), { OPENROUTER_API_KEY: undefined }))
    expect(response.status).toBe(503)
  })

  it("passes real client WAV requests through auth to Whisper", async () => {
    const jwt = await owner()
    const upstreamBodies: Record<string, unknown>[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://upstream.example/api/v1/audio/transcriptions")
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer platform-secret")
      const payload = JSON.parse(String(init?.body))
      upstreamBodies.push(payload)
      expect(payload).toMatchObject({
        model: "openai/whisper-1", language: "fr",
        response_format: "verbose_json",
        timestamp_granularities: ["word", "segment"],
        input_audio: { format: "wav" },
      })
      expect(atob(payload.input_audio.data).slice(0, 4)).toBe("RIFF")
      expect(payload.projectId).toBeUndefined()
      return Response.json({ text: "bonjour", words: [
        { word: "bonjour", start: 0, end: 0.5 },
      ], usage: { cost: 0.001 } })
    })
    // Load the SPA producer at runtime: its DOM types belong to the SPA build,
    // while this test runs the actual payload through the Worker consumer.
    const producerPath = new URL(
      "../../../src/lib/audio/transcription-request.ts", import.meta.url,
    ).pathname
    const { buildTranscriptionRequest } = await import(producerPath)
    const request = await buildTranscriptionRequest(
      new Float32Array(60 * 16000), body.projectId, "fr",
    )
    const response = await app.request("/api/v1/audio/transcriptions", {
      method: "POST", headers: authHeader(jwt), body: JSON.stringify(request),
    }, settings())
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(upstreamBodies).toHaveLength(1)
    expect(result).toEqual({ text: "bonjour", chunks: [
      { text: "bonjour", start: 0, end: 0.5 },
    ] })
  })

  it("rejects provider text without timings", async () => {
    const jwt = await owner()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ text: "hello" }))
    const response = await app.request("/api/v1/audio/transcriptions", {
      method: "POST", headers: authHeader(jwt), body: JSON.stringify(body),
    }, settings())
    expect(response.status).toBe(502)
  })
})
