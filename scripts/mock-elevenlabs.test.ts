// @vitest-environment node
// Smoke for the local ElevenLabs mock (AQU-2299): boots the real server on an
// ephemeral port and walks the calls the sync-worker proxy makes, so `pnpm dev`
// never hands the app a mock that disagrees with sync-worker/src/elevenlabs-api.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AddressInfo } from "node:net"
import type http from "node:http"
import {
  MOCK_ELEVENLABS_FREE_KEY,
  MOCK_ELEVENLABS_QUOTA_KEY,
  MOCK_ELEVENLABS_VALID_KEY,
  createMockElevenLabsServer,
} from "./mock-elevenlabs"

let server: http.Server
let origin = ""
beforeAll(async () => {
  server = createMockElevenLabsServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const as = (key: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers ?? {}), "xi-api-key": key } })

describe("mock ElevenLabs", () => {
  it("answers each key the way the docs' error envelope would", async () => {
    const bad = await fetch(`${origin}/v1/user/subscription`, as("nope"))
    expect(bad.status).toBe(401)
    expect(((await bad.json()) as { detail: { code: string } }).detail.code).toBe("invalid_api_key")

    const ok = (await (await fetch(`${origin}/v1/user/subscription`, as(MOCK_ELEVENLABS_VALID_KEY))).json()) as Record<string, unknown>
    expect(ok).toMatchObject({ tier: "creator", character_limit: 100_000, can_use_instant_voice_cloning: true })

    const quota = await fetch(`${origin}/v1/text-to-speech/mockRachel01`, as(MOCK_ELEVENLABS_QUOTA_KEY, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Hi" }),
    }))
    expect(quota.status).toBe(401)
    expect(((await quota.json()) as { detail: { status: string } }).detail.status).toBe("quota_exceeded")
  })

  it("synthesizes audible mp3, serves previews, and lists a clone as cloned", async () => {
    const voices = (await (await fetch(`${origin}/v2/voices`, as(MOCK_ELEVENLABS_VALID_KEY))).json()) as {
      voices: { voice_id: string; category: string; preview_url: string }[]
    }
    expect(voices.voices.length).toBeGreaterThanOrEqual(5)
    const preview = await fetch(voices.voices[0].preview_url)
    expect(preview.headers.get("content-type")).toBe("audio/mpeg")
    expect((await preview.arrayBuffer()).byteLength).toBeGreaterThan(10_000)

    const tts = await fetch(`${origin}/v1/text-to-speech/${voices.voices[0].voice_id}?output_format=mp3_44100_128`, as(MOCK_ELEVENLABS_VALID_KEY, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "In the beginning" }),
    }))
    expect(tts.status).toBe(200)
    expect((await tts.arrayBuffer()).byteLength).toBeGreaterThan(10_000)

    const form = new FormData()
    form.append("name", "Maria")
    form.append("files", new Blob([new Uint8Array(100)], { type: "audio/webm" }), "a.webm")
    const clone = await fetch(`${origin}/v1/voices/add`, as(MOCK_ELEVENLABS_VALID_KEY, { method: "POST", body: form }))
    const { voice_id } = (await clone.json()) as { voice_id: string }
    const cloned = (await (await fetch(`${origin}/v2/voices?category=cloned`, as(MOCK_ELEVENLABS_VALID_KEY))).json()) as {
      voices: { voice_id: string; name: string }[]
    }
    expect(cloned.voices).toEqual([expect.objectContaining({ voice_id, name: "Maria" })])

    const sts = new FormData()
    sts.append("audio", new Blob([new Uint8Array(100)]), "source")
    const changed = await fetch(`${origin}/v1/voice-changer/${voice_id}`, as(MOCK_ELEVENLABS_VALID_KEY, { method: "POST", body: sts }))
    expect(changed.status).toBe(200)

    const free = await fetch(`${origin}/v1/voices/add`, as(MOCK_ELEVENLABS_FREE_KEY, { method: "POST", body: form }))
    expect(free.status).toBe(403)
  })
})
