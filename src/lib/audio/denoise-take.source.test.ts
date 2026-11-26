// AQU-2327: cleaning a whole take keeps its track, name, kept part, places and
// level (it used to land on the main track with its margins back).
import { describe, expect, it, vi } from "vitest"

const sent = vi.hoisted(() => ({ attach: [] as Record<string, unknown>[], place: [] as unknown[], gain: [] as unknown[], even: [] as unknown[], measure: [] as Record<string, unknown>[] }))
vi.mock("./upload", () => ({
  buildDenoisedAudioId: () => "dn-x",
  uploadCellAudio: vi.fn(async () => ({ audioId: "dn-x", ext: "webm", url: "frontier-audio://dn-x.webm" })),
  deleteCellAudio: vi.fn(),
  fetchCellAudio: vi.fn(async () => new Uint8Array(4)),
  parseFrontierAudioUrl: () => ({ audioId: "t", ext: "webm" }),
}))
vi.mock("./bytes-cache", () => ({ audioCachePutBlob: vi.fn(async () => {}) }))
const tone = vi.hoisted(() => Float32Array.from({ length: 48000 }, (_, i) => 0.1 * Math.sin((2 * Math.PI * 1000 * i) / 48000)))
vi.mock("./decode-mono", () => ({ TARGET_RATE: 48000, decodeToMono48k: vi.fn(async () => tone.slice()) }))
vi.mock("./denoise", () => ({ denoiseMono48k: vi.fn(async () => ({ blob: new Blob(["x"], { type: "audio/webm" }), durationMs: 1000, mimeType: "audio/webm" })) }))
const trims = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock("./audio-attachments-bus", () => ({
  injectOptimisticAudioAttachment: vi.fn(),
  injectOptimisticAudioTrim: vi.fn((_f: string, _c: string, att: Record<string, unknown>) => trims.push(att)),
  notifyAudioAttachmentsChanged: vi.fn(),
}))
vi.mock("./sync-token-fetcher", () => ({ audioSyncTokenFetcherForSession: () => async () => "jwt" }))
vi.mock("./project-audio-state", () => ({ markProjectHasAudioDataSoon: vi.fn() }))
vi.mock("./transcribe-status", () => ({ setTranscribeStatus: vi.fn() }))
vi.mock("@/lib/history/take-steps", () => ({ recordTakeAdded: vi.fn() }))
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: vi.fn(async (x: Record<string, unknown>) => (sent.attach.push(x), "e1")),
  emitCellAudioPlace: vi.fn(async (x: unknown) => (sent.place.push(x), "e2")),
  emitCellAudioGain: vi.fn(async (x: unknown) => (sent.gain.push(x), "e3")),
  emitCellAudioEven: vi.fn(async (x: unknown) => (sent.even.push(x), "e4")),
  emitCellAudioMeasure: vi.fn(async (x: Record<string, unknown>) => (sent.measure.push(x), "e5")),
}))

import { denoiseTake } from "./denoise-take"
import { decodeToMono48k } from "./decode-mono"

describe("Remove noise on a whole take", () => {
  it("keeps the take's track, name, kept part, places and level", async () => {
    await denoiseTake({
      projectId: "p", fileId: "f", cellId: "c", sourceAudioId: "t.webm", sourceUrl: "frontier-audio://t.webm",
      author: "ana", session: { jwt: "j" } as never,
      source: { slot: "track-2", label: "Take 4", trimStartMs: 200, trimEndMs: 900, targetOffsetMs: 50, recordingsOffsetMs: null, gainDb: -3 },
    })
    expect(sent.attach[0]).toMatchObject({ slot: "track-2", label: "Take 4", trimStartMs: 200, trimEndMs: 900, referenceAudioId: "t.webm" })
    expect(sent.place[0]).toMatchObject({ targetOffsetMs: 50, recordingsOffsetMs: null })
    expect(sent.gain[0]).toMatchObject({ gainDb: -3, fadeInMs: null })
  })

  // AQU-2664 review M3: an evened-out take stays evened out when cleaned. The
  // cleaned audio is not measured here (it was encoded, not kept): it plays at
  // its own volume until Even out measures it — the fallback.
  it("carries the take's evening out to the cleaned take", async () => {
    sent.even.length = 0
    await denoiseTake({
      projectId: "p", fileId: "f", cellId: "c", sourceAudioId: "t.webm", sourceUrl: "frontier-audio://t.webm",
      author: "ana", session: { jwt: "j" } as never,
      source: { slot: "recording", gainDb: -3, evenTargetLufs: -16 },
    })
    expect(sent.even).toEqual([expect.objectContaining({ audioId: "dn-x.webm", evenTargetLufs: -16 })])
  })

  // AQU-2664: the cleaned take is measured right away, from the cleaned audio
  // the action already holds (off the page, with the page fallback), without
  // holding the save up. If that fails, it plays at its own volume.
  it("measures the cleaned take over its kept part, after the save", async () => {
    sent.measure.length = 0
    await denoiseTake({
      projectId: "p", fileId: "f", cellId: "c", sourceAudioId: "t.webm", sourceUrl: "frontier-audio://t.webm",
      author: "ana", session: { jwt: "j" } as never,
      source: { slot: "recording", trimStartMs: 250, trimEndMs: 900, evenTargetLufs: -16 },
    })
    // Earlier tests' takes are measured in the background too: find this one's.
    type M = { audioId: string; loudness: { loudnessLufs: number; truePeakDb: number; loudnessFromMs: number; loudnessToMs: number | null } }
    const mine = () => (sent.measure as unknown as M[]).filter((x) => x.loudness.loudnessFromMs === 250)
    await vi.waitFor(() => expect(mine()).toHaveLength(1))
    const m = mine()[0]
    expect(m.audioId).toBe("dn-x.webm")
    expect(m.loudness).toMatchObject({ loudnessFromMs: 250, loudnessToMs: 900 })
    expect(m.loudness.truePeakDb).toBeCloseTo(-20, 0)
    // Re-check S4: shown on the page at once, carrying what the take carries.
    await vi.waitFor(() => expect(trims.some((t) => t.loudnessFromMs === 250 && typeof t.loudnessLufs === "number" && t.evenTargetLufs === -16)).toBe(true))
  })

  it("never holds the save up: it resolves while the measuring is still going", async () => {
    sent.measure.length = 0
    let release: (v: Float32Array) => void = () => {}
    vi.mocked(decodeToMono48k)
      .mockImplementationOnce(async () => tone.slice()) // the source, for cleaning
      .mockImplementationOnce(() => new Promise<Float32Array>((r) => { release = r })) // the cleaned take
    const res = await denoiseTake({
      projectId: "p", fileId: "f", cellId: "c", sourceAudioId: "t.webm", sourceUrl: "frontier-audio://t.webm",
      author: "ana", session: { jwt: "j" } as never, source: { slot: "recording", trimStartMs: 300 },
    })
    const mine = () => sent.measure.filter((x) => (x.loudness as { loudnessFromMs: number }).loudnessFromMs === 300)
    expect(res.audioId).toBe("dn-x.webm")
    expect(mine()).toHaveLength(0)
    release(tone.slice())
    await vi.waitFor(() => expect(mine()).toHaveLength(1))
  })

  it("FALLBACK: a measurement that fails changes nothing — the take plays at its own volume", async () => {
    sent.measure.length = 0
    vi.mocked(decodeToMono48k)
      .mockImplementationOnce(async () => tone.slice())
      .mockImplementationOnce(async () => { throw new Error("can't decode") })
    await expect(denoiseTake({
      projectId: "p", fileId: "f", cellId: "c", sourceAudioId: "t.webm", sourceUrl: "frontier-audio://t.webm",
      author: "ana", session: { jwt: "j" } as never, source: { slot: "recording", trimStartMs: 400 },
    })).resolves.toBeTruthy()
    await new Promise((r) => setTimeout(r, 50))
    expect(sent.measure.filter((x) => (x.loudness as { loudnessFromMs: number }).loudnessFromMs === 400)).toHaveLength(0)
  })

  // AQU-2494 (review, Nov 9): on an added track an AI voice is known only by
  // the voice it was made with. The cleaned take lost it: no sparkle, and it
  // counted as a person's recording.
  it("keeps an AI voice marked as one, on an added track", async () => {
    sent.attach.length = 0
    const { injectOptimisticAudioAttachment } = await import("./audio-attachments-bus")
    vi.mocked(injectOptimisticAudioAttachment).mockClear()
    await denoiseTake({
      projectId: "p", fileId: "f", cellId: "c", sourceAudioId: "t.webm", sourceUrl: "frontier-audio://t.webm",
      author: "ana", session: { jwt: "j" } as never,
      source: { slot: "track-2", label: "Take 4", voiceId: "v-ana" },
    })
    expect(sent.attach[0]).toMatchObject({ slot: "track-2", voiceId: "v-ana" })
    expect(vi.mocked(injectOptimisticAudioAttachment).mock.calls[0][2]).toMatchObject({ slot: "track-2", voiceId: "v-ana" })
  })

  it("sends no voice for a person's take", async () => {
    sent.attach.length = 0
    await denoiseTake({
      projectId: "p", fileId: "f", cellId: "c", sourceAudioId: "t.webm", sourceUrl: "frontier-audio://t.webm",
      author: "ana", session: { jwt: "j" } as never,
      source: { slot: "track-2", voiceId: null },
    })
    expect(sent.attach[0]).not.toHaveProperty("voiceId")
  })
})
