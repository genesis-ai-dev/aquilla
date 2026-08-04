// FRO-355: a per-cell Transcribe used to silently do nothing whenever the take
// wasn't yet synced to R2 or the user was signed out (it required a
// frontier-audio:// URL AND a JWT, then fetched bytes from the sync-worker).
// transcribeCell now reads the OPFS byte cache first, so a just-recorded /
// offline / signed-out take transcribes from local bytes; only the network
// fallback needs a JWT.
import "fake-indexeddb/auto"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { createOpfsFs } from "@/lib/fs/opfs-fs"
import { MemoryDirectoryHandle } from "@/lib/fs/__test__/mem-fs-handles"
import { __setRootForTests, audioCachePut, audioCacheGet } from "./bytes-cache"
import { __resetOpfsAvailabilityForTests } from "@/lib/storage/opfs-availability"
import { transcribeCell, slicePcmToTrim, __setTranscribeAudioForTests } from "./transcribe"
import { getTranscribeStatus, clearTranscribeStatus } from "./transcribe-status"
import { buildFrontierAudioUrl } from "./upload"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"

// fetchCellAudio is the network path; mock it, keep the real URL parse/build.
const fetchCellAudio = vi.fn()
vi.mock("./upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./upload")>()
  return { ...actual, fetchCellAudio: (...a: unknown[]) => fetchCellAudio(...a) }
})
// The timings emit hits the outbox — irrelevant here; stub it.
const emitCellAudioAttach = vi.fn(async (_input: unknown) => "evt-1")
vi.mock("@/lib/sync/events-emit", () => ({
  emitCellAudioAttach: (input: unknown) => emitCellAudioAttach(input),
}))

const AUDIO_ID = "audio-take-1"
const EXT = "webm"
const FULL_ID = `${AUDIO_ID}.${EXT}`

function makeCell(): CellData {
  return {
    id: "cell-1",
    original: "hello world", translated: "hola mundo", fileId: "file-1",
    context: "", group: "", type: "text", status: "unvalidated",
    validationStatus: "none", activeValidators: [], validationHistory: [],
    history: [], threads: [],
    selectedAudioId: FULL_ID,
    attachments: { [FULL_ID]: { type: "audio", url: buildFrontierAudioUrl(AUDIO_ID, EXT) } as never },
  } as CellData
}

const session: FrontierSession = { jwt: "jwt-x", username: "alice", createdAt: "2026-01-01T00:00:00Z" }

function fakeTranscribe(words: string[]) {
  return vi.fn(async () => ({
    text: words.join(" "),
    chunks: words.map((w, i) => ({ text: w, start: i, end: i + 1 })),
  }))
}

beforeEach(() => {
  __resetOpfsAvailabilityForTests()
  __setRootForTests(createOpfsFs(new MemoryDirectoryHandle("root") as unknown as FileSystemDirectoryHandle))
  fetchCellAudio.mockReset()
  emitCellAudioAttach.mockClear()
  clearTranscribeStatus(FULL_ID)
})
afterEach(() => { __setTranscribeAudioForTests(null) })

describe("transcribeCell — local-first bytes (FRO-355)", () => {
  it("transcribes a cached take with no session and never hits the network", async () => {
    await audioCachePut(AUDIO_ID, EXT, new Uint8Array([1, 2, 3]))
    const impl = fakeTranscribe(["hola", "mundo"])
    __setTranscribeAudioForTests(impl)

    const n = await transcribeCell({ cell: makeCell(), session: null, projectId: "proj-1" })

    expect(n).toBe(2)
    expect(fetchCellAudio).not.toHaveBeenCalled()
    expect(impl).toHaveBeenCalledOnce()
    expect(getTranscribeStatus(FULL_ID).kind).toBe("done")
    // author falls back to "local" when signed out
    expect(emitCellAudioAttach).toHaveBeenCalledWith(expect.objectContaining({ author: "local" }))
  })

  it("errors with the sign-in message only when the cache misses AND there is no session", async () => {
    const impl = fakeTranscribe(["x"])
    __setTranscribeAudioForTests(impl)

    const n = await transcribeCell({ cell: makeCell(), session: null, projectId: "proj-1" })

    expect(n).toBe(0)
    expect(impl).not.toHaveBeenCalled()
    const status = getTranscribeStatus(FULL_ID)
    expect(status.kind).toBe("error")
    expect(status.kind === "error" && status.message).toMatch(/sign in/i)
  })

  it("falls back to the network on a cache miss and writes through to the cache", async () => {
    fetchCellAudio.mockResolvedValue(new Uint8Array([9, 9, 9]))
    __setTranscribeAudioForTests(fakeTranscribe(["hola"]))

    const n = await transcribeCell({ cell: makeCell(), session, projectId: "proj-1" })

    expect(n).toBe(1)
    expect(fetchCellAudio).toHaveBeenCalledOnce()
    expect(getTranscribeStatus(FULL_ID).kind).toBe("done")
    // write-through: the fetched bytes are now cached
    expect(await audioCacheGet(AUDIO_ID, EXT)).not.toBeNull()
  })

  it("surfaces a network failure as an error status (regression guard for e7ce472a)", async () => {
    fetchCellAudio.mockRejectedValue(new Error("boom: R2 unreachable"))
    __setTranscribeAudioForTests(fakeTranscribe(["x"]))

    const n = await transcribeCell({ cell: makeCell(), session, projectId: "proj-1" })

    expect(n).toBe(0)
    const status = getTranscribeStatus(FULL_ID)
    expect(status.kind).toBe("error")
    expect(status.kind === "error" && status.message).toMatch(/boom/)
  })
})

// ── AQU-646: trim-window slicing (imported segments share ONE clip) ────────

describe("slicePcmToTrim", () => {
  // 2 s of 16 kHz PCM where sample i holds value i — slice boundaries are
  // directly readable off the values.
  const ramp = () => Float32Array.from({ length: 32000 }, (_, i) => i)

  it("slices [trimStartMs, trimEndMs) at 16 kHz sample indices", () => {
    const out = slicePcmToTrim(ramp(), { trimStartMs: 500, trimEndMs: 1500 })
    expect(out.length).toBe(16000)
    expect(out[0]).toBe(8000) // 0.5 s * 16 kHz
    expect(out[out.length - 1]).toBe(23999)
  })

  it("returns the buffer untouched when there is no trim", () => {
    const pcm = ramp()
    expect(slicePcmToTrim(pcm)).toBe(pcm)
    expect(slicePcmToTrim(pcm, { trimStartMs: null, trimEndMs: null })).toBe(pcm)
  })

  it("clamps edges to the clip bounds", () => {
    const out = slicePcmToTrim(ramp(), { trimStartMs: -200, trimEndMs: 99999 })
    expect(out.length).toBe(32000)
    const tail = slicePcmToTrim(ramp(), { trimStartMs: 1500, trimEndMs: null })
    expect(tail.length).toBe(8000)
    expect(tail[0]).toBe(24000)
  })

  it("returns the full clip for an inverted/empty window (defensive)", () => {
    const pcm = ramp()
    expect(slicePcmToTrim(pcm, { trimStartMs: 1500, trimEndMs: 500 })).toBe(pcm)
    expect(slicePcmToTrim(pcm, { trimStartMs: 700, trimEndMs: 700 })).toBe(pcm)
  })
})

// ── AQU-646: media segments — trim + source language + transcription emit ──

function makeMediaCell(): CellData {
  const cell = makeCell()
  return {
    ...cell,
    medium: "media",
    translated: "",
    attachments: {
      [FULL_ID]: {
        type: "audio",
        url: buildFrontierAudioUrl(AUDIO_ID, EXT),
        trimStartMs: 1000,
        trimEndMs: 4000,
        durationMs: 3000,
      } as never,
    },
  } as CellData
}

describe("transcribeCell — imported media segments (AQU-646)", () => {
  it("passes the attachment's trim window and the mapped language to Whisper", async () => {
    await audioCachePut(AUDIO_ID, EXT, new Uint8Array([1, 2, 3]))
    const impl = fakeTranscribe(["bonjour", "monde"])
    __setTranscribeAudioForTests(impl)

    await transcribeCell({ cell: makeMediaCell(), session, projectId: "proj-1", language: "fra" })

    expect(impl).toHaveBeenCalledOnce()
    const opts = (impl.mock.calls[0] as unknown[])[1] as import("./transcribe").TranscriptionOptions
    expect(opts.trim).toEqual({ trimStartMs: 1000, trimEndMs: 4000 })
    expect(opts.language).toBe("fr")
  })

  it("leaves language undefined (auto-detect) for unmapped tags", async () => {
    await audioCachePut(AUDIO_ID, EXT, new Uint8Array([1, 2, 3]))
    const impl = fakeTranscribe(["x"])
    __setTranscribeAudioForTests(impl)

    await transcribeCell({ cell: makeMediaCell(), session, projectId: "proj-1", language: "Tripuri" })

    const opts = (impl.mock.calls[0] as unknown[])[1] as import("./transcribe").TranscriptionOptions
    expect(opts.language).toBeUndefined()
  })

  it("re-emits attach carrying the transcription AND the preserved trim window", async () => {
    await audioCachePut(AUDIO_ID, EXT, new Uint8Array([1, 2, 3]))
    __setTranscribeAudioForTests(fakeTranscribe(["bonjour", "monde"]))

    await transcribeCell({ cell: makeMediaCell(), session, projectId: "proj-1", language: "fra" })

    expect(emitCellAudioAttach).toHaveBeenCalledOnce()
    const input = emitCellAudioAttach.mock.calls[0][0] as Record<string, unknown>
    expect(input.transcription).toBe("bonjour monde")
    // Latent-bug guard: the projection UPSERT overwrites trim columns with the
    // emitted values, so the re-emit MUST carry them or the segment loses its
    // slice of the shared clip.
    expect(input.trimStartMs).toBe(1000)
    expect(input.trimEndMs).toBe(4000)
    expect(input.durationMs).toBe(3000)
  })

  it("recorded takes (non-media) never emit transcription", async () => {
    await audioCachePut(AUDIO_ID, EXT, new Uint8Array([1, 2, 3]))
    __setTranscribeAudioForTests(fakeTranscribe(["hola", "mundo"]))

    await transcribeCell({ cell: makeCell(), session, projectId: "proj-1", language: "spa" })

    expect(emitCellAudioAttach).toHaveBeenCalledOnce()
    const input = emitCellAudioAttach.mock.calls[0][0] as Record<string, unknown>
    expect(input).not.toHaveProperty("transcription")
  })

  it("does not pass a trim for recorded takes (whole clip)", async () => {
    await audioCachePut(AUDIO_ID, EXT, new Uint8Array([1, 2, 3]))
    const impl = fakeTranscribe(["hola"])
    __setTranscribeAudioForTests(impl)

    await transcribeCell({ cell: makeCell(), session, projectId: "proj-1" })

    const opts = (impl.mock.calls[0] as unknown[])[1] as import("./transcribe").TranscriptionOptions
    expect(opts.trim).toBeUndefined()
  })
})

// ── AQU-783: the attach emit must be AWAITED before transcribeCell resolves ──
// The transcript/timings only surface after a completion handler flushes the
// outbox and revalidates the cell. If the emit were fire-and-forget, that flush
// could run before the event reached IDB — nothing to push, so the result would
// only appear after a manual page refresh (the reported bug).
describe("transcribeCell — durable attach before resolve (AQU-783)", () => {
  it("does not resolve until the cell.audio.attach emit settles", async () => {
    await audioCachePut(AUDIO_ID, EXT, new Uint8Array([1, 2, 3]))
    __setTranscribeAudioForTests(fakeTranscribe(["bonjour", "monde"]))

    let releaseEmit: (v: string) => void = () => {}
    emitCellAudioAttach.mockImplementationOnce(
      () => new Promise<string>((resolve) => { releaseEmit = resolve }),
    )

    let settled = false
    const p = transcribeCell({ cell: makeMediaCell(), session, projectId: "proj-1", language: "fra" })
      .then((n) => { settled = true; return n })

    // Flush all pending microtasks/timers: execution should now be parked on the
    // still-pending attach emit, so transcribeCell must NOT have resolved yet.
    await new Promise((r) => setTimeout(r, 0))
    expect(emitCellAudioAttach).toHaveBeenCalledOnce()
    expect(settled).toBe(false)

    releaseEmit("evt-1")
    const words = await p
    expect(settled).toBe(true)
    expect(words).toBe(2)
    expect(getTranscribeStatus(FULL_ID).kind).toBe("done")
  })
})

// ── SUB-29: a TAKE recorded onto a media cell is target speech ─────────────

function makeMediaCellWithTake(): CellData {
  // Take audioId is seeded with the CELL id (recorder convention).
  const takeId = `audio-${"cell-1"}-1700000000-abcdefgh.webm`
  const base = makeCell()
  return {
    ...base,
    medium: "media",
    translated: "hola mundo",
    selectedAudioId: takeId,
    attachments: {
      [takeId]: { type: "audio", url: buildFrontierAudioUrl(`audio-cell-1-1700000000-abcdefgh`, "webm") } as never,
    },
  } as CellData
}

describe("transcribeCell — dub take on a media cell (SUB-29)", () => {
  it("transcribes the WHOLE take (no trim window) and never writes transcription", async () => {
    const takeAudioId = "audio-cell-1-1700000000-abcdefgh"
    await audioCachePut(takeAudioId, "webm", new Uint8Array([1, 2, 3]))
    const impl = fakeTranscribe(["hola", "mundo"])
    __setTranscribeAudioForTests(impl)

    await transcribeCell({ cell: makeMediaCellWithTake(), session, projectId: "proj-1", language: "spa" })

    const opts = (impl.mock.calls[0] as unknown[])[1] as import("./transcribe").TranscriptionOptions
    expect(opts.trim).toBeUndefined() // take plays/transcribes in full
    expect(emitCellAudioAttach).toHaveBeenCalledOnce()
    const input = emitCellAudioAttach.mock.calls[0][0] as Record<string, unknown>
    expect(input).not.toHaveProperty("transcription") // source text untouched
  })
})
