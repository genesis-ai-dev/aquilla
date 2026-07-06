// SDBH XML export — WHY: the round-trip contract. The "SDBH XML (MARBLE)"
// format must (a) appear ONLY for projects holding SDBH lexicon files, and
// (b) reinject the project's current translations into the user-supplied
// skeleton keyed by cell id, producing a download. If either regresses, a
// localization can no longer be handed back to the MARBLE toolchain.
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

import { downloadBlob } from "@/lib/export/export-service"
import { useProjectCells } from "@/hooks/useProjectCells"

const mockDownload = vi.mocked(downloadBlob)
const mockProjectCells = vi.mocked(useProjectCells)

const SKELETON_XML = `<?xml version="1.0"?>
<Lexicon>
  <Lexicon_Entry Id="000900000000000" Lemma="זָהָב" AlphaPos="ז">
    <BaseForms>
      <BaseForm Id="000900001000000">
        <LEXMeanings>
          <LEXMeaning Id="000900001001000" IsBiblicalTerm="M" EntryCode="" Indent="0">
            <LEXSenses>
              <LEXSense LanguageCode="en" LastEdited="" LastEditedBy="">
                <DefinitionLong />
                <DefinitionShort>= precious yellow metal</DefinitionShort>
                <Glosses>
                  <Gloss>gold</Gloss>
                </Glosses>
                <Comments />
              </LEXSense>
            </LEXSenses>
          </LEXMeaning>
        </LEXMeanings>
      </BaseForm>
    </BaseForms>
  </Lexicon_Entry>
</Lexicon>`

function cell(id: string, translated: string): CellData {
  return {
    id,
    fileId: "f-zayin",
    original: "src",
    translated,
    context: "",
    group: "זָהָב 1.1",
  } as CellData
}

const BASE_PROPS = {
  open: true,
  onOpenChange: vi.fn(),
  cells: [] as CellData[],
  projectId: "sdbh-es",
  projectName: "SDBH es",
  activeFileId: "f-zayin",
  activeFileName: "SDBH ז",
  isUsfmFile: false,
  projectFiles: [{ id: "f-zayin", name: "SDBH ז", type: "sdbh" }],
  targetLanguage: "es",
  getToken: async () => null,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProjectCells.mockReturnValue({
    files: [
      {
        fileId: "f-zayin",
        fileName: "SDBH ז",
        cells: [
          cell("sdbh-000900001001000-definitionShort", "= metal amarillo precioso"),
          cell("sdbh-000900001001000-glosses", "oro"),
        ],
      },
    ],
    isLoading: false,
    isTruncated: false,
  } as ReturnType<typeof useProjectCells>)
})

describe("ExportDialog — SDBH XML round-trip", () => {
  it("offers the format only when the project has SDBH files", () => {
    const { unmount } = render(<ExportDialog {...BASE_PROPS} />)
    expect(screen.getByText("SDBH XML (MARBLE)")).toBeInTheDocument()
    unmount()

    render(
      <ExportDialog
        {...BASE_PROPS}
        projectFiles={[{ id: "f1", name: "gen.usfm", type: "usfm" }]}
      />,
    )
    expect(screen.queryByText("SDBH XML (MARBLE)")).not.toBeInTheDocument()
  })

  it("reinjects project translations into the chosen skeleton and downloads it", async () => {
    render(<ExportDialog {...BASE_PROPS} />)

    fireEvent.click(screen.getByText("SDBH XML (MARBLE)"))

    // Attach the skeleton XML via the file input (dialog renders in a portal,
    // so query the document rather than the render container).
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(fileInput).toBeTruthy()
    const skeleton = new File([SKELETON_XML], "SDBH-es.XML", { type: "application/xml" })
    fireEvent.change(fileInput, { target: { files: [skeleton] } })

    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))

    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))
    const [blob, name] = mockDownload.mock.calls[0]
    expect(name).toMatch(/\.XML$/)
    const xml = await (blob as Blob).text()
    expect(xml).toContain("<DefinitionShort>= metal amarillo precioso</DefinitionShort>")
    expect(xml).toContain("<Gloss>oro</Gloss>")
    // Language attribute rewritten to the project's target language.
    expect(xml).toContain('LanguageCode="es"')
    // Untouched structure preserved.
    expect(xml).toContain('<Lexicon_Entry Id="000900000000000"')
  })

  it("refuses to export without a skeleton file", async () => {
    render(<ExportDialog {...BASE_PROPS} />)
    fireEvent.click(screen.getByText("SDBH XML (MARBLE)"))
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() =>
      expect(screen.getByText(/Choose the original SDBH/i)).toBeInTheDocument(),
    )
    expect(mockDownload).not.toHaveBeenCalled()
  })
})
