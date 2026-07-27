// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { downloadSourceFile } from "./source-export"

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
})
