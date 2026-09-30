// @vitest-environment happy-dom

// AQU-1449: the File menu's "Export source (.SFM)" downloads the CURATED
// SOURCE, not the active lane's translation. That distinction lives entirely in
// the request this module builds — the server decides everything else — so it is
// the one thing worth pinning down here: ask for the wrong side and the menu
// item silently becomes a second copy of the Export dialog's download again,
// which is exactly the bug the issue was filed about.

import { describe, expect, it, vi, beforeEach } from "vitest"
import type { FileReference } from "@/lib/parsers/types"

const downloadSourceFile = vi.fn(
  async (_args: Record<string, unknown>) => ({ lossyVerseCount: null }),
)

vi.mock("@/lib/sync/source-export", () => ({
  downloadSourceFile,
  SourceExportError: class extends Error {},
}))
vi.mock("@/components/ui/toast", () => ({ toast: { add: vi.fn() } }))

const { exportSourceFile, canExportSourceFile } = await import("./file-source-export")

const usfmFile = { id: "f1", name: "01-GEN.usfm", type: "usfm" } as FileReference

beforeEach(() => {
  downloadSourceFile.mockClear()
})

describe("exportSourceFile (AQU-1449)", () => {
  it("requests the source side", async () => {
    await exportSourceFile({
      projectId: "p1",
      file: usfmFile,
      getToken: async () => "token",
    })

    expect(downloadSourceFile).toHaveBeenCalledOnce()
    expect(downloadSourceFile.mock.calls[0][0]).toMatchObject({
      projectId: "p1",
      fileId: "f1",
      side: "source",
    })
  })

  it("sends no lane and no validation filter — neither applies to the source side", async () => {
    await exportSourceFile({
      projectId: "p1",
      file: usfmFile,
      getToken: async () => "token",
    })

    const args = downloadSourceFile.mock.calls[0][0]
    expect(args.targetLang).toBeUndefined()
    expect(args.validatedOnly).toBeUndefined()
  })

  it("stays gated on the org export floor", () => {
    expect(canExportSourceFile(usfmFile, true)).toBe(true)
    expect(canExportSourceFile(usfmFile, false)).toBe(false)
    expect(canExportSourceFile({ ...usfmFile, type: "docx" } as FileReference, true)).toBe(false)
  })
})
