// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { downloadSourceFile, fetchSourceSidecar } from "./source-export"

describe("source export lane routing", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("qualifies an export request with the active target lane", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("\\id GEN\n", {
      headers: { "Content-Type": "text/plain" },
    }))
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test")
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})

    await downloadSourceFile({
      projectId: "project / one",
      fileId: "file / one",
      downloadName: "GEN.SFM",
      targetLang: "fr-CA",
      getToken: async () => "token",
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toContain(
      "/projects/project%20%2F%20one/files/file%20%2F%20one/source?lane=fr-CA",
    )
  })

  // AQU-1148: USFM is injected server-side, so a validated-only export has to
  // cross the wire — the client never assembles the file and cannot filter it.
  it("asks for validated text only when the export mode says so", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("\\id GEN\n"))
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test")
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})

    await downloadSourceFile({
      projectId: "p1",
      fileId: "f1",
      downloadName: "GEN.SFM",
      getToken: async () => "token",
      validatedOnly: true,
    })

    expect(String(fetchMock.mock.calls[0][0])).toContain("validated=1")
  })

  it("omits the validated param in the default mode, preserving today's contract", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("\\id GEN\n"))
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test")
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})

    await downloadSourceFile({
      projectId: "p1",
      fileId: "f1",
      downloadName: "GEN.SFM",
      getToken: async () => "token",
    })

    expect(String(fetchMock.mock.calls[0][0])).not.toContain("validated")
  })

  it("sidecar fetch sends no query params beyond the lane (server has no raw mode)", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(new ArrayBuffer(4)))

    await fetchSourceSidecar({
      projectId: "p1",
      fileId: "f1",
      getToken: async () => "token",
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    // The export route parses only ?lane= — an unknown param like mode=raw is
    // silently ignored server-side, which would mislabel injected USFM as the
    // byte-exact upload. Callers must not send one until the server supports it.
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/projects\/p1\/files\/f1\/source$/)
  })
})
