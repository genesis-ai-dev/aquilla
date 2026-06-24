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
})
