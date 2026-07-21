// Guard tests for uploadCellAudio's client-side size cap.
//
// WHY: an oversized audio file used to travel all the way to sync-worker and
// die there (worst case as an opaque 500 mid-arrayBuffer). The client must
// refuse before any network I/O and explain the limit in plain language so
// the user knows to compress or split the file.

import { describe, it, expect, vi, afterEach } from "vitest"
import { uploadCellAudio, MAX_AUDIO_UPLOAD_BYTES } from "./upload"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("uploadCellAudio size guard", () => {
  it("throws a friendly error before fetching when the blob exceeds the cap", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const getSyncToken = vi.fn(async () => "tok")
    // A real 95 MB allocation is pointless in a unit test — only `size` is
    // read before the guard fires.
    const blob = { size: MAX_AUDIO_UPLOAD_BYTES + 1024 * 1024, type: "audio/mpeg" } as Blob

    await expect(
      uploadCellAudio({
        projectId: "p1",
        fileId: "f1",
        audioId: "audio-c1-1-abc",
        ext: "mp3",
        blob,
        getSyncToken,
      }),
    ).rejects.toThrow(/96 MB.*limit is 95 MB.*compressed format like mp3/s)

    // The guard must run before any token fetch or network round-trip.
    expect(getSyncToken).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("proceeds to upload blobs at or under the cap", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" })

    const result = await uploadCellAudio({
      projectId: "p1",
      fileId: "f1",
      audioId: "audio-c1-1-abc",
      ext: "mp3",
      blob,
      getSyncToken: async () => "tok",
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(result.sizeBytes).toBe(3)
    expect(result.url).toBe("frontier-audio://audio-c1-1-abc.mp3")
  })
})
