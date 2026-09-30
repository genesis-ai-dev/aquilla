/**
 * AQU-1451 at the dialog: the Source / Target choice on every export it offers.
 *
 * Matthew's requirement (2026-09-29) has two halves, and the second is the one
 * a test has to hold: exporting always ASKS which side, and never writes the
 * source together with the target in one action. So these cases check the
 * control is there and defaults to Target, that choosing Source changes the
 * bytes that reach `downloadBlob` — not merely the array handed to an exporter
 * — and that the target path is untouched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { ExportDialog } from "./ExportDialog"
import type { CellData } from "@/hooks/useCells"

vi.mock("@/lib/export/export-service", () => ({ downloadBlob: vi.fn() }))
vi.mock("@/hooks/useProjectCells", () => ({ useProjectCells: vi.fn() }))
vi.mock("@/lib/sync/source-export", () => ({
  downloadSourceFile: vi.fn(async () => ({ lossyVerseCount: null })),
  downloadProjectZip: vi.fn(async () => ({ exported: 1, skipped: [] })),
  fetchSourceSidecar: vi.fn(async () => new Uint8Array([1, 2, 3])),
  fetchRemovedCells: vi.fn(async () => []),
}))
vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn() } }))

import { downloadBlob } from "@/lib/export/export-service"
import { useProjectCells } from "@/hooks/useProjectCells"

const mockDownload = vi.mocked(downloadBlob)
const mockProjectCells = vi.mocked(useProjectCells)

type Cell = CellData & { hidden?: boolean }

function cell(over: Partial<Cell>): Cell {
  return {
    id: "c",
    fileId: "f1",
    original: "",
    translated: "",
    context: "",
    group: "",
    type: "text",
    status: "validated",
    ...over,
  } as Cell
}

/** A subtitle file with an edited source cue, a parked cue, and an
 *  untranslated one — the issue's own test setup. */
const CELLS: Cell[] = [
  cell({ id: "c1", original: "Edited source cue", translated: "Traducción uno", startTime: 0, endTime: 1 }),
  cell({ id: "c2", original: "Parked cue", translated: "Traducción dos", startTime: 1, endTime: 2, hidden: true }),
  cell({ id: "c3", original: "Untranslated cue", translated: "", startTime: 2, endTime: 3 }),
]

const BASE = {
  open: true,
  onOpenChange: vi.fn(),
  cells: CELLS,
  projectId: "p1",
  projectName: "Subtitles",
  activeFileId: "f1",
  activeFileName: "episode.vtt",
  activeFileType: "vtt",
  projectFiles: [{ id: "f1", name: "episode.vtt", type: "vtt" }],
  sourceLanguage: "en",
  targetLanguage: "es",
  getToken: async () => "tok",
}

/** The last blob handed to the browser, as text. */
async function downloadedText(): Promise<string> {
  const [blob] = mockDownload.mock.calls.at(-1) as [Blob, string]
  return await blob.text()
}

function downloadedName(): string {
  return (mockDownload.mock.calls.at(-1) as [Blob, string])[1]
}

/** The Side control nearest the primary download button. */
function sideControl(): HTMLElement {
  return screen.getAllByTestId("export-side")[0]
}

function chooseSide(name: "Source" | "Target") {
  fireEvent.click(within(sideControl()).getByRole("tab", { name }))
}

function clickPrimaryDownload() {
  fireEvent.click(screen.getByRole("button", { name: /^Download /i }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProjectCells.mockReturnValue({
    files: [], isLoading: false, isTruncated: false,
  } as unknown as ReturnType<typeof useProjectCells>)
})

describe("ExportDialog — Source / Target side (AQU-1451)", () => {
  it("shows the Side choice on the file's own-format download, defaulting to Target", () => {
    render(<ExportDialog {...BASE} />)
    const target = within(sideControl()).getByRole("tab", { name: "Target" })
    expect(target).toHaveAttribute("aria-selected", "true")
    expect(within(sideControl()).getByRole("tab", { name: "Source" })).toHaveAttribute("aria-selected", "false")
  })

  it("Target is today's file: the translation, with source filling the blank", async () => {
    render(<ExportDialog {...BASE} />)
    clickPrimaryDownload()
    await waitFor(() => expect(mockDownload).toHaveBeenCalled())
    const out = await downloadedText()
    expect(out).toContain("Traducción uno")
    // The existing Matecat-style fallback on an untranslated cue, unchanged.
    expect(out).toContain("Untranslated cue")
    // Hiding still applies on the target side, as it did before (AQU-1423).
    expect(out).not.toContain("Traducción dos")
  })

  it("Source writes the curated source: edits in, hidden out, no translation", async () => {
    render(<ExportDialog {...BASE} />)
    chooseSide("Source")
    clickPrimaryDownload()
    await waitFor(() => expect(mockDownload).toHaveBeenCalled())
    const out = await downloadedText()
    expect(out).toContain("Edited source cue")
    expect(out).toContain("Untranslated cue")
    expect(out).not.toContain("Parked cue")
    expect(out).not.toContain("Traducción")
    // Every remaining cue keeps its own timing.
    expect(out).toContain("00:00:00.000 --> 00:00:01.000")
    expect(out).toContain("00:00:02.000 --> 00:00:03.000")
  })

  it("never writes both sides in one action: the include-source option comes off under Source", () => {
    // The checkbox puts the source line ABOVE the translation — a bilingual
    // review file. Under Side = Source both lines would be the source, so the
    // option is not offered rather than silently doing nothing.
    render(<ExportDialog {...BASE} />)
    expect(screen.getByText("Include the source text")).toBeInTheDocument()
    chooseSide("Source")
    expect(screen.queryByText("Include the source text")).not.toBeInTheDocument()
  })

  it("names the file after the side that is actually in it", async () => {
    render(<ExportDialog {...BASE} />)
    fireEvent.click(screen.getByText("Append language tag"))
    clickPrimaryDownload()
    await waitFor(() => expect(mockDownload).toHaveBeenCalled())
    expect(downloadedName()).toContain("_es")

    chooseSide("Source")
    clickPrimaryDownload()
    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(2))
    expect(downloadedName()).toContain("_en")
  })

  it("offers no Source option on a format that holds both sides by definition", async () => {
    // TSV/CSV/XLIFF/TMX say "source + target" on the option instead — picking
    // one IS the deliberate choice, so a Side control there would be a lie.
    // Scoped to the fold: the card above is the VTT own-format download and
    // keeps its own choice, which is the point of one state and two surfaces.
    render(<ExportDialog {...BASE} />)
    const fold = screen.getByTestId("export-fold")
    expect(within(fold).getByTestId("export-side")).toBeInTheDocument()
    fireEvent.click(within(fold).getByRole("radio", { name: /TSV/i }))
    await waitFor(() => expect(within(fold).queryByTestId("export-side")).not.toBeInTheDocument())
    expect(screen.getAllByText("source + target").length).toBeGreaterThan(0)
  })

  it("shows Source disabled on a USFM file rather than hiding the question", async () => {
    // The USFM source side is a server export landing in AQU-1449; docx/pptx
    // follow in AQU-1452. "Not yet" and "not a thing" are different answers.
    render(
      <ExportDialog
        {...BASE}
        activeFileName="gen.usfm"
        activeFileType="usfm"
        projectFiles={[{ id: "f1", name: "gen.usfm", type: "usfm" }]}
      />,
    )
    // base-ui marks a disabled tab with aria-disabled + data-disabled rather
    // than the native `disabled` attribute.
    const source = within(sideControl()).getByRole("tab", { name: "Source" })
    expect(source).toHaveAttribute("aria-disabled", "true")
    expect(within(sideControl()).getByRole("tab", { name: "Target" })).toHaveAttribute("aria-selected", "true")
  })

  it("drops a Source choice when the dialog moves to another file", () => {
    const { rerender } = render(<ExportDialog {...BASE} />)
    chooseSide("Source")
    expect(within(sideControl()).getByRole("tab", { name: "Source" })).toHaveAttribute("aria-selected", "true")
    rerender(
      <ExportDialog
        {...BASE}
        activeFileId="f2"
        activeFileName="episode-2.vtt"
        projectFiles={[{ id: "f2", name: "episode-2.vtt", type: "vtt" }]}
      />,
    )
    expect(within(sideControl()).getByRole("tab", { name: "Target" })).toHaveAttribute("aria-selected", "true")
  })
})
