// AQU-1068: what the Export dialog SAYS a native round-trip will do with
// content added or removed in the app.
//
// Sam reversed the August decision on 2026-09-09: "an added cell will 100% of
// the time be content that the client's file is missing / a restructuring of
// the content. never a note-to-self or temporary." So USFM, Word and PowerPoint
// now carry it, and the loud warning became a plain note describing what
// happens — per format, because the answer differs per format.
//
// The warning it replaced was ALSO wrong twice, which is why the scoping below
// is the point of this suite rather than a detail: it fired for every type with
// a native entry, including csv, tsv, xliff, tmx, md and txt, which render from
// scratch and have always carried added lines; and it claimed InDesign would
// omit them, when the editor refuses to add or remove a cell on an IDML file at
// all.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { ExportDialog } from "./ExportDialog"
import { userLineOrigin } from "@/lib/timeline/user-lines"
import type { CellData } from "@/hooks/useCells"

vi.mock("@/lib/export/export-service", () => ({ downloadBlob: vi.fn() }))
vi.mock("@/hooks/useProjectCells", () => ({ useProjectCells: vi.fn() }))
vi.mock("@/lib/sync/source-export", () => ({
  downloadSourceFile: vi.fn(),
  downloadProjectZip: vi.fn(),
  fetchSourceSidecar: vi.fn(),
  // AQU-1068: the docx/pptx branches ask the server what the file has LOST
  // before injecting. It fails soft to an empty list in production, so an
  // empty list is also the right default here.
  fetchRemovedCells: vi.fn(async () => []),
}))
vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn() } }))

import { useProjectCells } from "@/hooks/useProjectCells"
const mockProjectCells = vi.mocked(useProjectCells)

const imported = (id: string): CellData =>
  ({ id, fileId: "f1", original: "source", translated: "hola", context: "", group: `g-${id}` }) as CellData

/** An imported cell that carries the per-paragraph locator recorded at import.
 *  Its ABSENCE is what marks a file as legacy, so the two cases need telling
 *  apart in these tests. */
const withLocator = (cell: CellData): CellData =>
  ({
    ...cell,
    metadata: {
      aquillaImport: {
        sourceLocator: {
          kind: "package-block",
          memberPath: "word/document.xml",
          blockPath: "w:p[1]",
          segment: 0,
        },
      },
    },
  }) as unknown as CellData

const addedHere = (id: string): CellData =>
  ({
    id, fileId: "f1", original: "", translated: "a missing verse", context: "", group: "",
    metadata: { aquillaOrigin: userLineOrigin() },
  }) as unknown as CellData

const BASE = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "p1",
  projectName: "Demo",
  activeFileId: "f1",
  activeFileName: "01-GEN.usfm",
  activeFileType: "usfm",
  projectFiles: [{ id: "f1", name: "01-GEN.usfm", type: "usfm" }],
  targetLanguage: "es",
  getToken: async () => "token",
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProjectCells.mockReturnValue({
    files: [], isLoading: false, isTruncated: false,
    revalidate: vi.fn(), applyOptimisticTargetEdit: vi.fn(),
  })
})

describe("ExportDialog — what a native round-trip does with added and removed content", () => {
  it("tells a USFM export that added content rides the verse it follows, with no new number", () => {
    // The half Biblica cares about most: nothing renumbers.
    render(<ExportDialog {...BASE} cells={[imported("c1"), addedHere("new1")]} />)
    expect(screen.getByText(/written into the verse it follows, with no new verse number/i)).toBeTruthy()
    expect(screen.getByText(/removed here is left out/i)).toBeTruthy()
  })

  it("tells a Word export that added content becomes a new paragraph", () => {
    render(
      <ExportDialog
        {...BASE}
        activeFileName="doc.docx" activeFileType="docx"
        projectFiles={[{ id: "f1", name: "doc.docx", type: "docx" }]}
        cells={[withLocator(imported("c1")), addedHere("new1")]}
      />,
    )
    expect(screen.getByText(/becomes a new paragraph after the one it follows/i)).toBeTruthy()
  })

  it("warns that a PowerPoint slide may overflow", () => {
    // A text box has a fixed extent and does not reflow, so added content can
    // sit past the edge of the slide. Sam accepted that as the lesser failure:
    // the content is in the file and the box can be resized, where content that
    // never arrives cannot be recovered.
    render(
      <ExportDialog
        {...BASE}
        activeFileName="deck.pptx" activeFileType="pptx"
        projectFiles={[{ id: "f1", name: "deck.pptx", type: "pptx" }]}
        cells={[withLocator(imported("c1")), addedHere("new1")]}
      />,
    )
    expect(screen.getByText(/a slide may overflow/i)).toBeTruthy()
  })

  it("says a LEGACY Word file can carry neither", () => {
    // No locators, so cells map to paragraphs by POSITION and an inserted or
    // dropped paragraph would shift every later one onto the wrong text.
    render(
      <ExportDialog
        {...BASE}
        activeFileName="old.docx" activeFileType="docx"
        projectFiles={[{ id: "f1", name: "old.docx", type: "docx" }]}
        cells={[imported("c1"), addedHere("new1")]}
      />,
    )
    expect(screen.getByText(/imported before we recorded where each paragraph came from/i)).toBeTruthy()
  })

  it("says InDesign takes neither, because the editor refuses both there", () => {
    render(
      <ExportDialog
        {...BASE}
        activeFileName="layout.idml" activeFileType="idml"
        projectFiles={[{ id: "f1", name: "layout.idml", type: "idml" }]}
        cells={[imported("c1")]}
      />,
    )
    expect(screen.getByText(/can.t be added or removed on this kind of file/i)).toBeTruthy()
  })

  it("stays silent for a file type with no native round-trip", () => {
    // An eBible import has no original file to patch — it exports through the
    // generic formats, which carry added lines perfectly well.
    render(
      <ExportDialog
        {...BASE}
        activeFileName="bible.ebible" activeFileType="ebible"
        projectFiles={[{ id: "f1", name: "bible.ebible", type: "ebible" }]}
        cells={[imported("c1"), addedHere("new1")]}
      />,
    )
    expect(screen.queryByText(/left out|new paragraph|verse it follows/i)).toBeNull()
  })

  it("says nothing about omission on a RENDERED format that reaches the native list", () => {
    // csv/tsv/xliff/tmx/md/txt all have a native entry and all carry added
    // lines correctly. The old warning fired for them and was simply false.
    render(
      <ExportDialog
        {...BASE}
        activeFileName="strings.csv" activeFileType="csv"
        projectFiles={[{ id: "f1", name: "strings.csv", type: "csv" }]}
        cells={[imported("c1"), addedHere("new1")]}
      />,
    )
    expect(screen.queryByText(/left out|can.t be placed/i)).toBeNull()
  })
})
