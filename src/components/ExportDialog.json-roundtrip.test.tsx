// AQU-525 — the other half of JSON support: what the user gets back. The
// importer promised that everything they did NOT pick survives untouched, so
// this drives the real exporter (not a mock) and reads the produced document:
// translations land at their own keys, and every other key, value, type and
// nesting level comes back unchanged, at the original indentation.
//
// The document is RE-SERIALIZED rather than patched, so JSON whitespace is
// normalized (an array written inline in the source comes back one element
// per line). Values, types and key order are what the round-trip guarantees —
// not the original byte stream.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ExportDialog } from "./ExportDialog"
import type { CellData } from "@/hooks/useCells"

vi.mock("@/lib/export/export-service", () => ({
  downloadBlob: vi.fn(),
}))
vi.mock("@/hooks/useProjectCells", () => ({
  useProjectCells: vi.fn(),
}))
vi.mock("@/lib/sync/source-export", () => ({
  downloadSourceFile: vi.fn(),
  downloadProjectZip: vi.fn(),
  fetchSourceSidecar: vi.fn(),
  fetchRemovedCells: vi.fn(async () => []),
}))
vi.mock("@/lib/posthog", () => ({
  default: { capture: vi.fn() },
}))

import { downloadBlob } from "@/lib/export/export-service"
import { useProjectCells } from "@/hooks/useProjectCells"
import { fetchSourceSidecar } from "@/lib/sync/source-export"

const mockDownload = vi.mocked(downloadBlob)
const mockProjectCells = vi.mocked(useProjectCells)
const mockSidecar = vi.mocked(fetchSourceSidecar)

/** The document as imported: `app.*` was picked, `legal` was not. */
const ORIGINAL = `{
  "app": {
    "title": "My App",
    "tagline": "Translate everything"
  },
  "legal": "All rights reserved",
  "version": 3,
  "flags": [
    true,
    null
  ]
}
`

/** A cell as the JSON importer emits it: `context` is the JSON path. */
function jsonCell(id: string, path: string, original: string, translated: string): CellData {
  return {
    id,
    fileId: "f1",
    original,
    translated,
    context: path,
    group: path,
  } as CellData
}

const BASE_PROPS = {
  open: true,
  onOpenChange: vi.fn(),
  cells: [
    jsonCell("c1", "app.title", "My App", "Mon application"),
    jsonCell("c2", "app.tagline", "Translate everything", "Tout traduire"),
  ],
  projectId: "p1",
  projectName: "Demo",
  activeFileId: "f1",
  activeFileName: "en.json",
  activeFileType: "json",
  projectFiles: [{ id: "f1", name: "en.json", type: "json" }],
  targetLanguage: "fr",
  getToken: async () => "token",
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProjectCells.mockReturnValue({
    files: [],
    isLoading: false,
    isTruncated: false,
    revalidate: vi.fn(),
    applyOptimisticTargetEdit: vi.fn(),
  } as ReturnType<typeof useProjectCells>)
  mockSidecar.mockResolvedValue(new TextEncoder().encode(ORIGINAL).buffer)
})

describe("ExportDialog — JSON round-trip (AQU-525)", () => {
  it("writes translations back at their own keys and preserves everything else", async () => {
    render(<ExportDialog {...BASE_PROPS} />)

    fireEvent.click(screen.getByRole("button", { name: /Download en\.json/i }))

    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))
    expect(mockSidecar).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", fileId: "f1" }),
    )
    expect(mockDownload.mock.calls[0][1]).toBe("en.json")

    const exported = await (mockDownload.mock.calls[0][0] as Blob).text()
    expect(JSON.parse(exported)).toEqual({
      app: { title: "Mon application", tagline: "Tout traduire" },
      // Never picked for translation, so returned exactly as it came in.
      legal: "All rights reserved",
      // Non-string values are not cells and must keep their JSON types.
      version: 3,
      flags: [true, null],
    })
    // Key order and the original 2-space indentation survive too, so a diff
    // against the source file shows only the translated values (the source
    // here is already in the exporter's normalized whitespace — see the file
    // header for what re-serialization does and does not preserve).
    expect(exported).toBe(ORIGINAL.replace("My App", "Mon application").replace("Translate everything", "Tout traduire"))

    const status = await screen.findByRole("status")
    expect(status).toHaveTextContent(/Downloaded en\.json \(2 values translated\)/i)
  })

  it("leaves an untranslated key at its original value instead of emptying it", async () => {
    render(
      <ExportDialog
        {...BASE_PROPS}
        cells={[
          jsonCell("c1", "app.title", "My App", "Mon application"),
          jsonCell("c2", "app.tagline", "Translate everything", ""),
        ]}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: /Download en\.json/i }))
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))

    const exported = JSON.parse(await (mockDownload.mock.calls[0][0] as Blob).text())
    expect(exported.app).toEqual({ title: "Mon application", tagline: "Translate everything" })

    const status = await screen.findByRole("status")
    expect(status).toHaveTextContent(/1 value translated/i)
  })

  it("offers the JSON round-trip only for files imported as JSON", () => {
    const { unmount } = render(<ExportDialog {...BASE_PROPS} />)
    expect(screen.getByRole("button", { name: /Download en\.json/i })).toBeInTheDocument()
    unmount()

    render(
      <ExportDialog
        {...BASE_PROPS}
        cells={[jsonCell("c1", "", "My App", "Mon application")]}
        activeFileName="notes.txt"
        activeFileType="txt"
        projectFiles={[{ id: "f1", name: "notes.txt", type: "txt" }]}
      />,
    )
    expect(screen.queryByRole("radio", { name: /^JSON/ })).not.toBeInTheDocument()
  })
})
