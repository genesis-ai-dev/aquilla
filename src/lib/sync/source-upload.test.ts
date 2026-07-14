import { describe, it, expect, vi } from "vitest"
import { uploadSourceOriginal } from "./source-upload"

describe("uploadSourceOriginal", () => {
  it("PUTs bytes to the source endpoint with format + auth headers", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await uploadSourceOriginal({
      projectId: "p1", fileId: "f1",
      bytes: new Uint8Array([1, 2, 3]).buffer, format: "docx",
      getToken: async () => "tok", fetchFn,
      baseUrl: "https://sync.test",
    })
    expect(fetchFn).toHaveBeenCalledOnce()
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe("https://sync.test/api/v1/projects/p1/files/f1/source")
    expect(init.method).toBe("PUT")
    expect(init.headers["X-Source-Format"]).toBe("docx")
    expect(init.headers.Authorization).toBe("Bearer tok")
  })

  it("throws on non-2xx", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("nope", { status: 403 }))
    await expect(uploadSourceOriginal({
      projectId: "p1", fileId: "f1", bytes: new ArrayBuffer(3), format: "docx",
      getToken: async () => "tok", fetchFn, baseUrl: "https://sync.test",
    })).rejects.toThrow(/403/)
  })

  it("throws if getToken returns null", async () => {
    const fetchFn = vi.fn()
    await expect(uploadSourceOriginal({
      projectId: "p1", fileId: "f1", bytes: new ArrayBuffer(3), format: "docx",
      getToken: async () => null, fetchFn, baseUrl: "https://sync.test",
    })).rejects.toThrow(/token/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  // Intent: a transient R2/network hiccup during import must not abort the whole
  // import — the PUT is idempotent, so retry and finish, uploading exactly once.
  it("retries a transient 500 then succeeds without double-uploading", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await uploadSourceOriginal({
      projectId: "p1", fileId: "f1", bytes: new ArrayBuffer(3), format: "docx",
      getToken: async () => "tok", fetchFn, baseUrl: "https://sync.test",
      retryDelaysMs: [0, 0],
    })
    // One failed attempt + one success, then it stops: no double-write after the
    // 200, and it didn't give up on the transient 500.
    expect(fetchFn).toHaveBeenCalledTimes(2)
    const responses = await Promise.all(
      fetchFn.mock.results.map((r) => r.value as Promise<Response>),
    )
    expect(responses.filter((res) => res.ok)).toHaveLength(1)
  })

  it("does not retry a non-retryable 403", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("nope", { status: 403 }))
    await expect(uploadSourceOriginal({
      projectId: "p1", fileId: "f1", bytes: new ArrayBuffer(3), format: "docx",
      getToken: async () => "tok", fetchFn, baseUrl: "https://sync.test",
      retryDelaysMs: [0, 0],
    })).rejects.toThrow(/403/)
    expect(fetchFn).toHaveBeenCalledOnce()
  })
})
