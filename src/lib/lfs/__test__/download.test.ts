import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { downloadLfsBlob } from "../download"

const CLONE_URL = "https://git.genesisrnd.com/group/repo.git"
const TOKEN = "glpat-test"

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("")
}

describe("downloadLfsBlob", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("posts the batch request and GETs the returned href", async () => {
    const bytes = new TextEncoder().encode("abcdef")
    const oid = await sha256Hex(bytes)
    const size = bytes.byteLength

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        objects: [{ oid, size, actions: { download: {
          href: "https://r2.cloudflarestorage.com/lfs/obj?sig=xyz",
          header: { "X-Custom": "1" },
        } } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(bytes.buffer as ArrayBuffer, { status: 200 }))

    const got = await downloadLfsBlob({ cloneUrl: CLONE_URL, gitlabToken: TOKEN, oid, size })
    expect(got).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(got)).toBe("abcdef")

    const [batchUrl, batchInit] = fetchMock.mock.calls[0]
    expect(batchUrl).toContain("/info/lfs/objects/batch")
    expect((batchInit as RequestInit).method).toBe("POST")
    const batchBody = JSON.parse((batchInit as RequestInit).body as string)
    expect(batchBody).toMatchObject({ operation: "download", objects: [{ oid, size }] })

    const [getUrl, getInit] = fetchMock.mock.calls[1]
    expect(getUrl).toContain("r2.cloudflarestorage.com")
    expect((getInit as RequestInit).method).toBe("GET")
    expect((getInit as RequestInit).headers).toMatchObject({ "X-Custom": "1" })
  })

  it("throws batch-failed if the batch response has an error object", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      objects: [{ oid: "x", size: 1, error: { code: 404, message: "not found" } }],
    }), { status: 200 }))

    await expect(
      downloadLfsBlob({ cloneUrl: CLONE_URL, gitlabToken: TOKEN, oid: "x", size: 1 }),
    ).rejects.toMatchObject({ kind: "batch-failed" })
  })

  it("throws batch-failed on non-2xx batch response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
    await expect(
      downloadLfsBlob({ cloneUrl: CLONE_URL, gitlabToken: TOKEN, oid: "x", size: 1 }),
    ).rejects.toMatchObject({ kind: "batch-failed" })
  })

  it("throws download-failed on sha256 mismatch", async () => {
    const realBytes = new TextEncoder().encode("expected payload")
    const expectedOid = await sha256Hex(realBytes)
    const wrongBytes = new TextEncoder().encode("wrong payload")

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        objects: [{ oid: expectedOid, size: realBytes.byteLength,
                    actions: { download: { href: "https://r2/obj" } } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(wrongBytes.buffer as ArrayBuffer, { status: 200 }))

    await expect(
      downloadLfsBlob({ cloneUrl: CLONE_URL, gitlabToken: TOKEN, oid: expectedOid, size: realBytes.byteLength }),
    ).rejects.toMatchObject({ kind: "download-failed" })
  })

  it("throws download-failed on non-2xx blob GET", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        objects: [{ oid: "x", size: 1, actions: { download: { href: "https://r2/obj" } } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response("oops", { status: 500 }))

    await expect(
      downloadLfsBlob({ cloneUrl: CLONE_URL, gitlabToken: TOKEN, oid: "x", size: 1 }),
    ).rejects.toMatchObject({ kind: "download-failed" })
  })
})
