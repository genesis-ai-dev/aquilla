// Tests for the client side of direct-to-R2 multipart upload (AQU-1853).
//
// The point of this path is that a file too big for one request body still
// uploads, and that a network drop mid-transfer costs one part rather than the
// whole upload. Both are asserted here against an injected fetch.

import { describe, it, expect, vi } from "vitest"
import { uploadCellAudioMultipart } from "./multipart-upload"
import { uploadCellAudio, MAX_AUDIO_OBJECT_BYTES, MAX_AUDIO_UPLOAD_BYTES } from "./upload"

const getSyncToken = async () => "tok"
const NO_DELAYS = [0, 0, 0] as const

interface Call {
  phase: string | null
  partNumber: string | null
  uploadId: string | null
  method: string
  headers: Record<string, string>
  body: unknown
}

/** A fetch stand-in that implements the four phases and records every call. */
function makeServer(opts: { failOnce?: Set<number>; failHard?: number } = {}) {
  const calls: Call[] = []
  const failedOnce = new Set<number>()
  const fetchFn = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input)
    const phase = url.searchParams.get("multipart")
    const partNumber = url.searchParams.get("partNumber")
    calls.push({
      phase,
      partNumber,
      uploadId: url.searchParams.get("uploadId"),
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body,
    })
    if (phase === "create") {
      return Response.json({ uploadId: "up-1", key: "k", partSizeBytes: 4 })
    }
    if (phase === "part") {
      const n = Number(partNumber)
      if (opts.failHard === n) return new Response("forbidden", { status: 403 })
      if (opts.failOnce?.has(n) && !failedOnce.has(n)) {
        failedOnce.add(n)
        return new Response("flaky", { status: 503 })
      }
      return Response.json({ partNumber: n, etag: `etag-${n}` })
    }
    if (phase === "complete") return Response.json({ ok: true, key: "k", bytes: 10 })
    if (phase === "abort") return Response.json({ ok: true })
    return new Response("unexpected", { status: 500 })
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

const baseArgs = (blob: Blob) => ({
  projectId: "p1",
  fileId: "f1",
  audioId: "audio-c1-1-abc",
  ext: "mp4",
  blob,
  getSyncToken,
  retryDelaysMs: NO_DELAYS,
})

/** 10 bytes, part size 4 => parts of 4, 4, 2. */
const tenBytes = () => new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])])

describe("uploadCellAudioMultipart", () => {
  it("runs create → parts → complete and returns the frontier-audio url", async () => {
    const { fetchFn, calls } = makeServer()
    const result = await uploadCellAudioMultipart({ ...baseArgs(tenBytes()), fetchFn })

    expect(result).toEqual({
      audioId: "audio-c1-1-abc",
      ext: "mp4",
      url: "frontier-audio://audio-c1-1-abc.mp4",
      sizeBytes: 10,
    })
    expect(calls.map((c) => c.phase)).toEqual(["create", "part", "part", "part", "complete"])
    expect(calls.map((c) => c.method)).toEqual(["POST", "PUT", "PUT", "PUT", "POST"])
    expect(calls.filter((c) => c.phase === "part").map((c) => c.partNumber)).toEqual(["1", "2", "3"])
    // Every phase carries the file-scoped token.
    for (const call of calls) expect(call.headers.Authorization).toBe("Bearer tok")
  })

  it("declares the total size and media type up front so the server can refuse early", async () => {
    const { fetchFn, calls } = makeServer()
    const blob = new Blob([new Uint8Array(10)], { type: "video/mp4" })
    await uploadCellAudioMultipart({ ...baseArgs(blob), fetchFn })
    const create = calls.find((c) => c.phase === "create")!
    expect(create.headers["X-Upload-Total-Bytes"]).toBe("10")
    expect(create.headers["X-Upload-Content-Type"]).toBe("video/mp4")
  })

  it("sends the parts and declared size on complete", async () => {
    const { fetchFn, calls } = makeServer()
    await uploadCellAudioMultipart({ ...baseArgs(tenBytes()), fetchFn })
    const complete = JSON.parse(calls.find((c) => c.phase === "complete")!.body as string)
    expect(complete.parts).toEqual([
      { partNumber: 1, etag: "etag-1" },
      { partNumber: 2, etag: "etag-2" },
      { partNumber: 3, etag: "etag-3" },
    ])
    expect(complete.sizeBytes).toBe(10)
  })

  it("re-sends only the part that failed, never the whole upload", async () => {
    // The resume guarantee: a 503 on part 2 costs part 2, and parts 1 and 3
    // are each still sent exactly once.
    const { fetchFn, calls } = makeServer({ failOnce: new Set([2]) })
    await uploadCellAudioMultipart({ ...baseArgs(tenBytes()), fetchFn })
    const sent = calls.filter((c) => c.phase === "part").map((c) => c.partNumber)
    expect(sent).toEqual(["1", "2", "2", "3"])
    expect(calls.filter((c) => c.phase === "complete")).toHaveLength(1)
  })

  it("retries a part through a network drop and completes", async () => {
    // Mirrors "toggle offline for 30 s, go online": fetch rejects outright
    // rather than returning a status.
    let thrown = false
    const inner = makeServer()
    const fetchFn = (async (input: string, init: RequestInit = {}) => {
      const phase = new URL(input).searchParams.get("multipart")
      if (phase === "part" && !thrown) {
        thrown = true
        throw new TypeError("Failed to fetch")
      }
      return (inner.fetchFn as unknown as typeof fetch)(input, init)
    }) as unknown as typeof fetch

    const result = await uploadCellAudioMultipart({ ...baseArgs(tenBytes()), fetchFn })
    expect(result.sizeBytes).toBe(10)
    expect(inner.calls.filter((c) => c.phase === "part")).toHaveLength(3)
  })

  it("aborts the upload and rethrows when a part is refused outright", async () => {
    const { fetchFn, calls } = makeServer({ failHard: 2 })
    await expect(
      uploadCellAudioMultipart({ ...baseArgs(tenBytes()), fetchFn }),
    ).rejects.toThrow(/multipart part 2 failed \(403\)/)
    // No dangling parts left behind.
    expect(calls.at(-1)).toMatchObject({ phase: "abort", method: "DELETE", uploadId: "up-1" })
    expect(calls.filter((c) => c.phase === "complete")).toHaveLength(0)
  })

  it("reports cumulative progress per acknowledged part", async () => {
    const { fetchFn } = makeServer()
    const seen: number[] = []
    await uploadCellAudioMultipart({
      ...baseArgs(tenBytes()),
      fetchFn,
      onProgress: (p) => {
        seen.push(p.uploadedBytes)
        expect(p.totalBytes).toBe(10)
        expect(p.partCount).toBe(3)
      },
    })
    expect(seen).toEqual([4, 8, 10])
  })

  it("refreshes the sync token on a 401 and carries on", async () => {
    let served401 = false
    const tokens = vi.fn(async () => (served401 ? "tok2" : "tok"))
    const calls: { phase: string | null; auth: string }[] = []
    const fetchFn = (async (input: string, init: RequestInit = {}) => {
      const url = new URL(input)
      const phase = url.searchParams.get("multipart")
      const auth = (init.headers as Record<string, string>).Authorization
      calls.push({ phase, auth })
      if (phase === "part" && !served401) {
        served401 = true
        return new Response("expired", { status: 401 })
      }
      if (phase === "create") return Response.json({ uploadId: "up-1", partSizeBytes: 16 })
      if (phase === "part") return Response.json({ partNumber: 1, etag: "e1" })
      return Response.json({ ok: true })
    }) as unknown as typeof fetch

    await uploadCellAudioMultipart({
      ...baseArgs(tenBytes()),
      getSyncToken: tokens,
      fetchFn,
    })
    expect(calls.filter((c) => c.phase === "part").map((c) => c.auth)).toEqual([
      "Bearer tok",
      "Bearer tok2",
    ])
  })

  it("computes the object's sha256 only when artifact provenance is requested", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const expected = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("")

    const withArtifact = makeServer()
    await uploadCellAudioMultipart({
      ...baseArgs(new Blob([bytes])),
      artifactId: "0198abc1-2345-7def-89ab-0123456789ab",
      artifactName: "clip.mp4",
      fetchFn: withArtifact.fetchFn,
    })
    const body = JSON.parse(withArtifact.calls.find((c) => c.phase === "complete")!.body as string)
    // Hashed in 4-byte parts, yet byte-identical to a one-shot digest of the
    // whole object — so an artifact row matches the single-shot path's value.
    expect(body.sha256).toBe(expected)
    expect(body.artifactId).toBe("0198abc1-2345-7def-89ab-0123456789ab")
    expect(body.artifactName).toBe("clip.mp4")

    const plain = makeServer()
    await uploadCellAudioMultipart({ ...baseArgs(new Blob([bytes])), fetchFn: plain.fetchFn })
    const plainBody = JSON.parse(plain.calls.find((c) => c.phase === "complete")!.body as string)
    expect(plainBody.sha256).toBeUndefined()
    expect(plainBody.artifactId).toBeUndefined()
  })

  it("refuses an object past the whole-object ceiling before any network I/O", async () => {
    const { fetchFn, calls } = makeServer()
    const blob = { size: MAX_AUDIO_OBJECT_BYTES + 1, type: "video/mp4" } as Blob
    await expect(
      uploadCellAudioMultipart({ ...baseArgs(blob), fetchFn }),
    ).rejects.toThrow(/2\.0 GB.*Split the recording/s)
    expect(calls).toHaveLength(0)
  })

  it("refuses a part size that would exceed R2's part limit, before uploading", async () => {
    // A 2 GB file at a 1 KB part size is 2 million parts. Fail here with a
    // clear message rather than on a rejected part 10 001 half-way through.
    const { fetchFn, calls } = makeServer()
    const blob = { size: 2 * 1024 * 1024 * 1024, type: "video/mp4" } as Blob
    await expect(
      uploadCellAudioMultipart({ ...baseArgs(blob), fetchFn, partSizeBytes: 1024 }),
    ).rejects.toThrow(/exceeds the 10000-part limit/)
    // `create` is allowed to have happened; no part ever is.
    expect(calls.filter((c) => c.phase === "part")).toHaveLength(0)
  })

  it("refuses an empty file", async () => {
    const { fetchFn, calls } = makeServer()
    await expect(
      uploadCellAudioMultipart({ ...baseArgs(new Blob([])), fetchFn }),
    ).rejects.toThrow(/empty/)
    expect(calls).toHaveLength(0)
  })

  it("stops without completing when the caller aborts", async () => {
    const { fetchFn, calls } = makeServer()
    const controller = new AbortController()
    controller.abort()
    await expect(
      uploadCellAudioMultipart({ ...baseArgs(tenBytes()), fetchFn, signal: controller.signal }),
    ).rejects.toThrow(/cancelled/)
    expect(calls.filter((c) => c.phase === "complete")).toHaveLength(0)
  })
})

describe("uploadCellAudio routing", () => {
  it("sends a blob over the single-request cap through the multipart path", async () => {
    // The regression this ticket is about: a 96 MB file used to be rejected
    // client-side. It must now upload.
    const { fetchFn, calls } = makeServer()
    const big = new Blob([new Uint8Array(32)])
    Object.defineProperty(big, "size", { value: MAX_AUDIO_UPLOAD_BYTES + 1024 * 1024 })

    const result = await uploadCellAudio({
      ...baseArgs(big),
      fetchFn,
      // Real part size, so this is 2 parts rather than 25 million 4-byte ones.
      partSizeBytes: MAX_AUDIO_UPLOAD_BYTES,
    })
    expect(result.url).toBe("frontier-audio://audio-c1-1-abc.mp4")
    expect(calls.map((c) => c.phase)).toContain("create")
    expect(calls.map((c) => c.phase)).toContain("complete")
  })

  it("keeps a small clip on the single PUT path", async () => {
    const { fetchFn, calls } = makeServer()
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) => Response.json({ ok: true, bytes: 3 }),
    )
    await uploadCellAudio({
      ...baseArgs(new Blob([new Uint8Array([1, 2, 3])])),
      fetchFn: fetchSpy as unknown as typeof fetch,
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ method: "PUT" })
    // The multipart server was never consulted.
    expect(calls).toHaveLength(0)
    expect(fetchFn).toBeTypeOf("function")
  })
})
