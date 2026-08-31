// Bible Swap in the export dialog — WHY: the swap rewrites scripture inside a
// customer's Study Bible, so two things must not regress. (a) Gating: the panel
// may only appear for files imported by the Biblica Study Notes importer, since
// the engine keys off Biblica's marker conventions and would corrupt any other
// IDML. (b) The failure contract: a swap that throws must still download the
// valid notes-only IDML rather than losing the user's export.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import JSZip from "jszip"
import { ExportDialog } from "./ExportDialog"
import { BIBLICA_NOTES_PROFILE_ID } from "@/lib/import"
import type { CellData } from "@/hooks/useCells"

vi.mock("@/lib/export/export-service", () => ({ downloadBlob: vi.fn() }))
vi.mock("@/hooks/useProjectCells", () => ({ useProjectCells: vi.fn() }))
vi.mock("@/lib/sync/source-export", () => ({
  fetchSourceSidecar: vi.fn(),
  downloadSourceFile: vi.fn(),
  downloadProjectZip: vi.fn(),
}))
vi.mock("@/lib/export/exporters/idml", () => ({ exportIdml: vi.fn() }))

import { downloadBlob } from "@/lib/export/export-service"
import { useProjectCells } from "@/hooks/useProjectCells"
import { fetchSourceSidecar } from "@/lib/sync/source-export"
import { exportIdml } from "@/lib/export/exporters/idml"

const mockDownload = vi.mocked(downloadBlob)
const mockProjectCells = vi.mocked(useProjectCells)
const mockFetchSidecar = vi.mocked(fetchSourceSidecar)
const mockExportIdml = vi.mocked(exportIdml)

const NO_STYLE = "CharacterStyle/$ID/[No character style]"

function verse(chapter: string, verseNo: string, text: string): string {
  const chapterMarker =
    verseNo === "1"
      ? `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/meta%3ac"><Content>${chapter}:</Content></CharacterStyleRange>`
      : ""
  return `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/text%3ap">
  ${chapterMarker}
  <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/cv%3av"><Content>${verseNo}</Content></CharacterStyleRange>
  <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/meta%3av"><Content>${verseNo}</Content></CharacterStyleRange>
  <CharacterStyleRange AppliedCharacterStyle="${NO_STYLE}"><Content>${text}</Content></CharacterStyleRange>
  <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/meta%3av"><Content>${verseNo}</Content></CharacterStyleRange>
</ParagraphStyleRange>`
}

function story(book: string, body: string): string {
  return `<?xml version="1.0"?><Story>
<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/meta%3abk">
  <CharacterStyleRange AppliedCharacterStyle="${NO_STYLE}"><Content>${book}</Content></CharacterStyleRange>
</ParagraphStyleRange>${body}</Story>`
}

async function idmlBytes(storyXml: string): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file("mimetype", "application/vnd.adobe.indesign-idml-package")
  zip.file("Stories/Story_u1.xml", storyXml)
  return zip.generateAsync({ type: "uint8array" })
}

const STUDY_STORY = story("JOS", verse("1", "1", "English Joshua one one."))
const BIBLE_STORY = story("JOS", verse("1", "1", "Translated Joshua one one."))

function biblicaCell(id: string): CellData {
  return {
    id,
    fileId: "f-jos",
    original: "src",
    translated: "translated note",
    context: "",
    group: "JOS 1",
    metadata: { aquillaImport: { profileId: BIBLICA_NOTES_PROFILE_ID } },
  } as unknown as CellData
}

function plainIdmlCell(id: string): CellData {
  return {
    id,
    fileId: "f-jos",
    original: "src",
    translated: "translated para",
    context: "",
    group: "doc",
    metadata: { aquillaImport: { profileId: "builtin:idml" } },
  } as unknown as CellData
}

const BASE_PROPS = {
  open: true,
  onOpenChange: vi.fn(),
  cells: [biblicaCell("c1")],
  projectId: "biblica-pt",
  projectName: "Biblica PT",
  activeFileId: "f-jos",
  activeFileName: "JOS-EST.idml",
  activeFileType: "idml",
  projectFiles: [{ id: "f-jos", name: "JOS-EST.idml", type: "idml" }],
  targetLanguage: "pt",
  getToken: async () => "token",
}

/** Open the collapsed "Export to another format" section if it is present. */
function openConversionSection() {
  const toggle = screen.queryByText(/Export to another format/i)
  if (toggle) fireEvent.click(toggle)
}

beforeEach(async () => {
  vi.clearAllMocks()
  mockProjectCells.mockReturnValue({
    files: [],
    isLoading: false,
    isTruncated: false,
  } as unknown as ReturnType<typeof useProjectCells>)

  const studyIdml = await idmlBytes(STUDY_STORY)
  mockFetchSidecar.mockResolvedValue(
    studyIdml.buffer.slice(0) as ArrayBuffer,
  )
  mockExportIdml.mockResolvedValue({
    blob: new Blob([studyIdml as BlobPart], {
      type: "application/vnd.adobe.indesign-idml-package",
    }),
    report: { translated: 1 },
    diagnostics: [],
  } as unknown as Awaited<ReturnType<typeof exportIdml>>)
})

describe("ExportDialog — Bible Swap gating", () => {
  it("offers Bible Swap on the round-trip surface without opening another format", () => {
    render(<ExportDialog {...BASE_PROPS} />)

    expect(screen.getByText(/Bible Swap \(optional\)/i)).toBeInTheDocument()
    expect(screen.queryByText(/Export to another format/i)).not.toBeInTheDocument()
  })

  it("hides Bible Swap for an IDML from any other importer and keeps conversion", () => {
    render(<ExportDialog {...BASE_PROPS} cells={[plainIdmlCell("c1")]} />)
    openConversionSection()

    expect(screen.queryByText(/Bible Swap \(optional\)/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Export to another format/i)).toBeInTheDocument()
  })

  it("keeps the Bible picker hidden until a swap mode is chosen", () => {
    render(<ExportDialog {...BASE_PROPS} />)

    expect(screen.queryByText(/Select Bible IDML/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByText("Surgical"))

    expect(screen.getByText(/Select Bible IDML/i)).toBeInTheDocument()
  })

  it("warns when a swap mode is selected without a Bible file", () => {
    render(<ExportDialog {...BASE_PROPS} />)
    fireEvent.click(screen.getByText("Structure"))

    expect(screen.getByRole("alert")).toHaveTextContent(/Choose a Bible IDML file/i)
  })

  it("lists every shipped swap language, defaulting to Any", () => {
    render(<ExportDialog {...BASE_PROPS} />)
    fireEvent.click(screen.getByText("Surgical"))

    const trigger = screen.getByLabelText(/Bible Swap language/i)
    expect(trigger).toHaveTextContent(/Any/i)
  })
})

describe("ExportDialog — Bible Swap export", () => {
  /** Enable a mode and attach a Bible file. */
  async function armSwap(mode: "Surgical" | "Structure", bible: Uint8Array) {
    fireEvent.click(screen.getByText(mode))

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(fileInput).toBeTruthy()
    const file = new File([bible as BlobPart], "portuguese.idml")
    fireEvent.change(fileInput, { target: { files: [file] } })
    await waitFor(() => expect(screen.getByText(/portuguese\.idml/)).toBeInTheDocument())
  }

  it("downloads an IDML whose verse text came from the chosen Bible", async () => {
    render(<ExportDialog {...BASE_PROPS} />)
    await armSwap("Surgical", await idmlBytes(BIBLE_STORY))

    fireEvent.click(screen.getByRole("button", { name: /Download JOS-EST\.idml/i }))

    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))
    const [blob, name] = mockDownload.mock.calls[0]
    expect(name).toMatch(/\.idml$/)

    const zip = await JSZip.loadAsync(await (blob as Blob).arrayBuffer())
    const swapped = await zip.file("Stories/Story_u1.xml")!.async("text")
    expect(swapped).toContain("Translated Joshua one one.")
    expect(swapped).not.toContain("English Joshua one one.")
  })

  it("still downloads the notes-only IDML when the swap fails", async () => {
    render(<ExportDialog {...BASE_PROPS} />)
    // Not a zip — the swap runner rejects it.
    await armSwap("Surgical", new Uint8Array([1, 2, 3, 4]))

    fireEvent.click(screen.getByRole("button", { name: /Download JOS-EST\.idml/i }))

    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))
    const [blob] = mockDownload.mock.calls[0]
    const zip = await JSZip.loadAsync(await (blob as Blob).arrayBuffer())
    const notesOnly = await zip.file("Stories/Story_u1.xml")!.async("text")
    expect(notesOnly).toContain("English Joshua one one.")
    await waitFor(() =>
      expect(screen.getByText(/Bible Swap failed/i)).toBeInTheDocument(),
    )
  })

  it("exports notes-only when no swap mode is selected", async () => {
    render(<ExportDialog {...BASE_PROPS} />)

    fireEvent.click(screen.getByRole("button", { name: /Download JOS-EST\.idml/i }))

    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))
    const [blob] = mockDownload.mock.calls[0]
    const zip = await JSZip.loadAsync(await (blob as Blob).arrayBuffer())
    expect(await zip.file("Stories/Story_u1.xml")!.async("text")).toContain(
      "English Joshua one one.",
    )
  })
})
