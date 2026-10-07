// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  downloadOriginalFile,
  originalDownloadLabel,
  originalsZipDownloadName,
  safeDownloadFilename,
} from "./original-download"

describe("downloadOriginalFile (AQU-656)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("mints a token, fetches with Bearer, and saves via a.download on a blob URL", async () => {
    const getToken = vi.fn(async () => "fresh-tok")
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([35, 32, 104, 105]), { status: 200 }),
    )
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test")
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})

    await downloadOriginalFile({
      projectId: "proj",
      fileId: "file-1",
      downloadName: "Berean Standard Bible (BSB).json",
      getToken,
    })

    expect(getToken).toHaveBeenCalledTimes(1)
    expect(getToken).toHaveBeenCalledWith("file-1")
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toContain("/files/file-1/original")
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("t=")
    expect(fetchMock.mock.calls[0][1]).toEqual({
      method: "GET",
      headers: { Authorization: "Bearer fresh-tok" },
    })
    expect(URL.createObjectURL).toHaveBeenCalledOnce()
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce()
  })

  it("surfaces a 404 instead of saving a blob", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("missing", { status: 404 }))
    await expect(downloadOriginalFile({
      projectId: "proj",
      fileId: "file-1",
      downloadName: "sample.md",
      getToken: async () => "tok",
    })).rejects.toMatchObject({ status: 404, name: "OriginalDownloadError" })
  })
})

describe("originalDownloadLabel (AQU-656)", () => {
  it("appends the artifact extension when the display name has none", () => {
    expect(originalDownloadLabel("Berean Standard Bible (BSB)", "usfm"))
      .toBe("Berean Standard Bible (BSB).usfm")
  })

  it("keeps a display name that already has an extension", () => {
    expect(originalDownloadLabel("sample.md", "md")).toBe("sample.md")
  })

  it("does not save a file-id UUID", () => {
    const id = "01a045cf-1131-7158-8150-03ae69b8c1c0"
    expect(originalDownloadLabel(id, "json", "Berean Standard Bible (BSB)"))
      .toBe("Berean Standard Bible (BSB).json")
    expect(originalDownloadLabel(id, "usfm")).toBe("original.usfm")
  })
})

describe("safeDownloadFilename (AQU-656)", () => {
  it("keeps a human name and extension Chrome can honor on a.download", () => {
    expect(safeDownloadFilename("Berean Standard Bible (BSB).json"))
      .toBe("Berean Standard Bible (BSB).json")
    expect(safeDownloadFilename("folder/Matthew.docx")).toBe("folder-Matthew.docx")
  })
})

describe("originalsZipDownloadName (AQU-656)", () => {
  it("names the archive {project}-originals.zip", () => {
    expect(originalsZipDownloadName("My Project")).toBe("My-Project-originals.zip")
  })
})
