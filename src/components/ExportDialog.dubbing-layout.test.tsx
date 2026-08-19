// What the export dialog leads with, for a file that is being dubbed.
// (AQU-646, 2026-08-19)
//
// The featured export used to be keyed purely to file identity — a VTT went in,
// so a VTT was offered back — which gave a dubbing episode exactly the same top
// billing for its subtitles that a Bible project gives USFM, while the exports
// this workflow actually delivers sat in the fold beside TMX and plaintext.
//
// Sam's rule, stated in one sentence on purpose: if the file was imported as a
// VTT or an SRT, it is an episode being dubbed. Its audio and its subtitles are
// the deliverables, so they get the top of the dialog.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"

import { ExportDialog } from "./ExportDialog"
import type { CellData } from "@/hooks/useCells"

vi.mock("@/lib/export/export-service", () => ({ downloadBlob: vi.fn() }))
vi.mock("@/hooks/useProjectCells", () => ({ useProjectCells: vi.fn() }))

import { useProjectCells } from "@/hooks/useProjectCells"

const mockProjectCells = vi.mocked(useProjectCells)

function plain(id: string, startTime = 1): CellData {
  return {
    id, fileId: "f1", original: "source", translated: "translated",
    context: "", group: "", startTime, endTime: startTime + 1,
  } as CellData
}

function recorded(id: string, startTime: number): CellData {
  return {
    ...plain(id, startTime),
    selectedAudioId: `take-${id}`,
    attachments: { [`take-${id}`]: { url: `frontier-audio://take-${id}.wav`, type: "audio" } },
  } as CellData
}

const BASE = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "p1",
  projectName: "The Chosen",
  activeFileId: "f1",
  activeFileName: "episode.vtt",
  projectFiles: [{ id: "f1", name: "episode.vtt", type: "vtt" }],
  targetLanguage: "es",
  getToken: async () => null,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProjectCells.mockReturnValue({
    files: [], isLoading: false, isTruncated: false,
  } as ReturnType<typeof useProjectCells>)
})

const dubbing = (over: Record<string, unknown> = {}) =>
  render(
    <ExportDialog
      {...BASE}
      activeFileType="vtt"
      cells={[plain("s1"), plain("s2")]}
      audioCells={[recorded("q1", 10)]}
      resolveCharacterName={() => "JESUS"}
      {...over}
    />,
  )

describe("a dubbing file leads with its own deliverables", () => {
  it("features audio first, then the subtitles", () => {
    dubbing()
    const audio = screen.getByTestId("export-audio-card")
    const subs = screen.getByTestId("export-subtitle-card")
    expect(audio).toBeInTheDocument()
    expect(subs).toBeInTheDocument()
    // Order matters: the audio is what the work produces.
    expect(audio.compareDocumentPosition(subs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("offers the two audio shapes as one choice rather than two competing entries", () => {
    dubbing()
    const card = within(screen.getByTestId("export-audio-card"))
    expect(card.getByText("By character")).toBeInTheDocument()
    expect(card.getByText("By line")).toBeInTheDocument()
    expect(card.getByRole("button", { name: /Export audio/i })).toBeInTheDocument()
  })

  it("puts the recorded/unrecorded preview inside the card that acts on it", () => {
    dubbing()
    const card = within(screen.getByTestId("export-audio-card"))
    expect(card.getByText("JESUS")).toBeVisible()
  })

  it("says nothing is recorded and refuses to arm, rather than failing after the press", () => {
    // A button that leads to "there is nothing to export" is a worse answer
    // than a button that is plainly not available yet.
    dubbing({ audioCells: [plain("q1")] })
    const card = within(screen.getByTestId("export-audio-card"))
    expect(card.getByText(/Nothing is recorded yet/)).toBeInTheDocument()
    expect(card.getByRole("button", { name: /Export audio/i })).toBeDisabled()
  })

  it("keeps the subtitle round-trip, with its shape options on the card", () => {
    dubbing()
    const card = within(screen.getByTestId("export-subtitle-card"))
    expect(card.getByRole("button", { name: /Download .*\.vtt/i })).toBeInTheDocument()
    expect(card.getByText(/Split overlapping cues/)).toBeInTheDocument()
  })
})

describe("the fold stops repeating what is featured", () => {
  const openFold = () => fireEvent.click(screen.getByText("Export to another format"))

  it("drops the featured formats from the list", () => {
    dubbing()
    openFold()
    // Offering them twice invites the two copies to drift.
    expect(screen.queryByRole("radio", { name: /Audio by character/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("radio", { name: /Audio by line/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("radio", { name: /^WEBVTT/i })).not.toBeInTheDocument()
  })

  it("leads with the sibling subtitle format and the metadata sheet", () => {
    dubbing()
    openFold()
    const radios = screen.getAllByRole("radio").map((r) => r.getAttribute("aria-label") ?? "")
    const srt = radios.findIndex((l) => /SRT/i.test(l))
    const meta = radios.findIndex((l) => /Metadata/i.test(l))
    const tsv = radios.findIndex((l) => /TSV/i.test(l))
    expect(srt).toBeGreaterThanOrEqual(0)
    expect(srt).toBeLessThan(tsv)
    expect(meta).toBeLessThan(tsv)
  })

  it("mirrors for a file imported as SRT", () => {
    dubbing({ activeFileType: "srt", activeFileName: "episode.srt", projectFiles: [{ id: "f1", name: "episode.srt", type: "srt" }] })
    openFold()
    const radios = screen.getAllByRole("radio").map((r) => r.getAttribute("aria-label") ?? "")
    // VTT is the sibling here, and SRT is the one featured above.
    expect(radios.some((l) => /WEBVTT/i.test(l))).toBe(true)
    expect(radios.some((l) => /^SRT/i.test(l))).toBe(false)
  })
})

describe("every other kind of project is untouched", () => {
  it("keeps the plain native card and leaves the audio exports in the fold", () => {
    render(
      <ExportDialog
        {...BASE}
        activeFileType={null}
        activeFileName="gen.txt"
        projectFiles={[{ id: "f1", name: "gen.txt", type: "txt" }]}
        cells={[recorded("s1", 5)]}
      />,
    )
    expect(screen.queryByTestId("export-audio-card")).not.toBeInTheDocument()
    expect(screen.queryByTestId("export-subtitle-card")).not.toBeInTheDocument()
    // An audio-first import has no cue sibling and still needs to reach these.
    expect(screen.getByRole("radio", { name: /Audio by character/i })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /Audio by line/i })).toBeInTheDocument()
  })
})

// ── Anna's two exports (AQU-646, 2026-08-19) ─────────────────────────────
//
// She does not translate or dub. Her job is making sure the files are
// consistent — finding errors and resolving discrepancies — and until now her
// corrections lived in the app while her team kept working from the
// spreadsheets that still contained every one of them.

describe("the exports for the person who checks the files", () => {
  const openFold = () => fireEvent.click(screen.getByText("Export to another format"))

  it("offers the corrected sheets and the project report", () => {
    dubbing()
    openFold()
    expect(screen.getByRole("radio", { name: /Character sheets \(corrected\)/i })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /Project report/i })).toBeInTheDocument()
  })

  it("puts them near the top, not below the general text formats", () => {
    dubbing()
    openFold()
    const radios = screen.getAllByRole("radio").map((r) => r.getAttribute("aria-label") ?? "")
    const sheets = radios.findIndex((l) => /Character sheets/i.test(l))
    const report = radios.findIndex((l) => /Project report/i.test(l))
    const tmx = radios.findIndex((l) => /TMX/i.test(l))
    expect(sheets).toBeLessThan(tmx)
    expect(report).toBeLessThan(tmx)
  })

  it("refuses the sheets on a file with no audio cues, and says why", async () => {
    // One sheet is not a reconciliation. Better to explain that than to hand
    // over a workbook with an empty tab.
    dubbing({ audioCells: [] })
    openFold()
    fireEvent.click(screen.getByRole("radio", { name: /Character sheets/i }))
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    const status = await screen.findByRole("status")
    expect(status).toHaveTextContent(/no audio cues imported/i)
  })

  it("refuses the report when the project has no files to walk", async () => {
    dubbing({ reportFiles: [] })
    openFold()
    fireEvent.click(screen.getByRole("radio", { name: /Project report/i }))
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    const status = await screen.findByRole("status")
    expect(status).toHaveTextContent(/no subtitle files/i)
  })

  it("forces the report to project scope, since a one-file report is a lie", () => {
    // Name consistency only means anything ACROSS episodes: MARY in one and
    // MARY MAGDALENE in the next is invisible inside either file. So the scope
    // control stops offering "current file" the moment the report is chosen.
    dubbing()
    openFold()
    const wholeProject = () => screen.getByRole("tab", { name: /Whole project/i })
    expect(wholeProject()).not.toHaveAttribute("data-active")
    fireEvent.click(screen.getByRole("radio", { name: /Project report/i }))
    expect(wholeProject()).toHaveAttribute("data-active")
  })
})

