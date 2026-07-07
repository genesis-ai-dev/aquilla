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
import { transcribeCell, __setTranscribeAudioForTests } from "./transcribe"
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
