// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest"
import { deleteFileProjection } from "./file-projection"

const API = "https://api.example.test"
const originalFetch = global.fetch

describe("deleteFileProjection", () => {
  afterEach(() => {
    global.fetch = originalFetch
  })

  it("returns false without firing when jwt is null", async () => {
    const fetchMock = vi.fn<typeof fetch>()
    global.fetch = fetchMock
    const ok = await deleteFileProjection({
      jwt: null,
      projectId: "p",
      fileId: "f",
      apiUrl: API,
    })
    expect(ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("DELETEs the file projection with bearer auth on success", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }))
    global.fetch = fetchMock
    const ok = await deleteFileProjection({
      jwt: "jwt-user",
      projectId: "proj-1",
      fileId: "file-a",
      apiUrl: API,
    })
    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${API}/api/v2/projects/proj-1/files/file-a`)
    expect(init!.method).toBe("DELETE")
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      "Bearer jwt-user"
    )
  })

  it("URL-encodes projectId and fileId", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }))
    global.fetch = fetchMock
    await deleteFileProjection({
      jwt: "j",
      projectId: "proj with space",
      fileId: "file/with/slash",
      apiUrl: API,
    })
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${API}/api/v2/projects/proj%20with%20space/files/file%2Fwith%2Fslash`
    )
  })

  it("returns false on non-2xx response", async () => {
    global.fetch = vi.fn(async () => new Response("nope", { status: 403 })) as unknown as typeof fetch
    const ok = await deleteFileProjection({
      jwt: "j",
      projectId: "p",
      fileId: "f",
      apiUrl: API,
    })
    expect(ok).toBe(false)
  })

  it("returns false on network error instead of throwing", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    const ok = await deleteFileProjection({
      jwt: "j",
      projectId: "p",
      fileId: "f",
      apiUrl: API,
    })
    expect(ok).toBe(false)
  })
})
