// Guard tests for uploadCellAudio's client-side size cap.
//
// WHY: an oversized audio file used to travel all the way to sync-worker and
// die there (worst case as an opaque 500 mid-arrayBuffer). The client must
// refuse before any network I/O and explain the limit in plain language so
// the user knows to compress or split the file.

import { describe, it, expect, vi, afterEach } from "vitest"
import { uploadCellAudio, probeCellAudioPresent, MAX_AUDIO_UPLOAD_BYTES } from "./upload"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("probeCellAudioPresent", () => {
  const args = {
    projectId: "p1", fileId: "f1", audioId: "a1", ext: "webm",
    getSyncToken: async () => "tok",
  }

  it("reports 'missing' on a 404 (R2 object gone)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("gone", { status: 404 }))
    expect(await probeCellAudioPresent(args)).toBe("missing")
  })

  it("reports 'present' on a 206 partial (ranged GET honored)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("x", { status: 206 }))
    expect(await probeCellAudioPresent(args)).toBe("present")
    // Single-byte ranged GET — never pulls the whole object.
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ headers: { Range: "bytes=0-0" } })
  })

  it("reports 'present' on a 200 (Range ignored by server)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x", { status: 200 }))
    expect(await probeCellAudioPresent(args)).toBe("present")
  })

  it("reports 'unknown' on a transient 5xx — never a false 'missing'", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }))
    expect(await probeCellAudioPresent(args)).toBe("unknown")
  })

  it("reports 'unknown' on a network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    expect(await probeCellAudioPresent(args)).toBe("unknown")
  })

  it("reports 'unknown' without fetching when there is no token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    expect(await probeCellAudioPresent({ ...args, getSyncToken: async () => null })).toBe("unknown")
    expect(fetchSpy).not.toHaveBeenCalled()
  })
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

  it("sends immutable provenance headers for imported media", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await uploadCellAudio({
      projectId: "p1",
      fileId: "f1",
      audioId: "audio-import",
      ext: "wav",
      blob: new Blob([new Uint8Array([1])], { type: "audio/wav" }),
      artifactId: "01900000-0000-7000-8000-000000000001",
      artifactName: "Interview 1.wav",
      getSyncToken: async () => "tok",
    })

    const [, init] = fetchSpy.mock.calls[0]
    expect(init?.headers).toMatchObject({
      "X-Artifact-Id": "01900000-0000-7000-8000-000000000001",
      "X-Artifact-Name": "Interview%201.wav",
    })
  })

  it("retries the same immutable upload after a dropped response", async () => {
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new TypeError("network reset"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const token = vi.fn(async () => "tok")
    const blob = new Blob([new Uint8Array([1, 2])], { type: "audio/wav" })

    await expect(uploadCellAudio({
      projectId: "p1",
      fileId: "f1",
      audioId: "audio-import",
      ext: "wav",
      blob,
      artifactId: "01900000-0000-7000-8000-000000000001",
      getSyncToken: token,
      fetchFn,
      retryDelaysMs: [0, 0],
    })).resolves.toMatchObject({ audioId: "audio-import", ext: "wav", sizeBytes: 2 })

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ body: blob })
    expect(fetchFn.mock.calls[1][1]).toMatchObject({ body: blob })
  })
})
