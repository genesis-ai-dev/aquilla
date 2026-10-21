/**
 * AQU-965 at the dialog: what it SAYS before an audio export runs, and what it
 * hands the exporters when the content mode is "validated only".
 *
 * The live failure this pins: a dubbing project whose lines were all
 * unvalidated exported and went to the studio, and the dialog had said nothing
 * — there was no count, and no way to find the lines.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ExportDialog } from "./ExportDialog"
import { pickSelectOption } from "@/test-utils/select"
import type { CellData } from "@/hooks/useCells"

vi.mock("@/lib/export/export-service", () => ({ downloadBlob: vi.fn() }))
vi.mock("@/hooks/useProjectCells", () => ({ useProjectCells: vi.fn() }))
vi.mock("@/lib/export/audio-per-line", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/export/audio-per-line")>()
  return { ...actual, exportAudioPerLine: vi.fn() }
})
vi.mock("@/lib/audio/upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audio/upload")>()
  return { ...actual, fetchCellAudio: vi.fn() }
})
vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn() } }))

import { useProjectCells } from "@/hooks/useProjectCells"
import { exportAudioPerLine } from "@/lib/export/audio-per-line"

const mockProjectCells = vi.mocked(useProjectCells)
const mockByLine = vi.mocked(exportAudioPerLine)

/** A heard line with one recording carrying `votes` validators. */
function heardLine(id: string, votes: number, startTime: number): CellData {
  return {
    id,
    fileId: "cues",
    original: "source",
    translated: "translated",
    context: "",
    group: "",
    startTime,
    endTime: startTime + 1,
    selectedAudioId: `take-${id}`,
    attachments: {
      [`take-${id}`]: {
        url: `frontier-audio://take-${id}.wav`,
        type: "audio/wav",
        slot: "recording",
        validatorCount: votes,
      },
    },
  } as CellData
}

const CUES = [heardLine("c1", 1, 0), heardLine("c2", 0, 1), heardLine("c3", 0, 2)]

const BASE = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "p1",
  projectName: "Come and See",
  activeFileId: "f1",
  activeFileName: "ep1.vtt",
  activeFileType: "vtt",
  projectFiles: [{ id: "f1", name: "ep1.vtt", type: "vtt" }],
  targetLanguage: "swh",
  getToken: async () => "tok",
  // A dubbing file: the subtitle rows carry no audio, the cue sibling does.
  cells: [{ id: "t1", fileId: "f1", original: "s", translated: "t", context: "", group: "" } as CellData],
  audioCells: CUES,
  audioSiblingName: "ep1 (audio).vtt",
}

beforeEach(() => {
  vi.clearAllMocks()
  try { localStorage.removeItem("aq.exportdlg.v1") } catch { /* ignore */ }
  mockProjectCells.mockReturnValue({
    files: [], isLoading: false, isTruncated: false,
  } as unknown as ReturnType<typeof useProjectCells>)
  mockByLine.mockResolvedValue({
    blob: new Blob([new Uint8Array([1])], { type: "application/zip" }),
    files: 1, clips: 1, skipped: 0, untimed: 0, untrimmed: 0,
  })
})

const note = () => screen.queryByTestId("export-audio-unvalidated-note")

/** The per-line shape, so these tests exercise one exporter. */
async function chooseByLine() {
  await userEvent.click(screen.getByText("By line"))
}

/** Switch the Content list to "Validated translations only". */
async function chooseValidatedOnly() {
  await pickSelectOption(
    /what the exported file contains/i,
    /^Validated translations only$/,
  )
}

describe("ExportDialog — unvalidated audio, before the export runs (AQU-965)", () => {
  it("counts the heard lines whose recording nobody has validated", () => {
    render(<ExportDialog {...BASE} />)
    expect(note()).toHaveTextContent("2 lines will export recordings nobody has validated")
  })

  it("counts against the PROJECT's audio threshold, not 'at least one vote'", () => {
    // At a requirement of two, the single-vote line is unvalidated too — the
    // same arithmetic the line's own audio check shows in the gutter.
    render(<ExportDialog {...BASE} audioValidationRequirement={2} />)
    expect(note()).toHaveTextContent("3 lines will export recordings nobody has validated")
  })

  it("says nothing when every shipping take is validated", () => {
    render(<ExportDialog {...BASE} audioCells={[heardLine("c1", 1, 0)]} />)
    expect(note()).toBeNull()
  })

  it("does not count a line with nothing recorded — it ships no audio", () => {
    const silent = { ...heardLine("c9", 0, 9), selectedAudioId: undefined, attachments: {} } as CellData
    render(<ExportDialog {...BASE} audioCells={[heardLine("c1", 1, 0), silent]} />)
    expect(note()).toBeNull()
  })

  // AQU-2073 (Sam, 2026-10-20): every such line, by name, one click each.
  it("names every such line as a pill, and a pill takes the viewer there and gets out of the way", async () => {
    const onJumpToAudioLine = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <ExportDialog {...BASE} onOpenChange={onOpenChange} onJumpToAudioLine={onJumpToAudioLine} />,
    )
    // c2 and c3 are the second and third lines in time order: L2, L3.
    const pills = screen.getAllByTestId("export-audio-unvalidated-line")
    expect(pills.map((b) => b.textContent)).toEqual(["L2", "L3"])
    expect(screen.queryByRole("button", { name: /show me/i })).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Show line L3" }))
    expect(onJumpToAudioLine).toHaveBeenCalledWith("c3")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("names a line by its reference when it has one", () => {
    const refd = [
      heardLine("c1", 1, 0),
      { ...heardLine("v5", 0, 1), context: "JHN 6:5" } as CellData,
    ]
    render(<ExportDialog {...BASE} audioCells={refd} onJumpToAudioLine={vi.fn()} />)
    expect(screen.getAllByTestId("export-audio-unvalidated-line").map((b) => b.textContent)).toEqual(["JHN 6:5"])
  })

  it("shows eight pills and \"+N more\", which opens the rest in place", async () => {
    const many = Array.from({ length: 11 }, (_, i) => heardLine(`m${i + 1}`, 0, i))
    render(<ExportDialog {...BASE} audioCells={many} onJumpToAudioLine={vi.fn()} />)
    expect(screen.getAllByTestId("export-audio-unvalidated-line")).toHaveLength(8)
    const more = screen.getByTestId("export-audio-unvalidated-more")
    expect(more).toHaveTextContent("+3 more")
    await userEvent.click(more)
    expect(screen.getAllByTestId("export-audio-unvalidated-line").map((b) => b.textContent))
      .toEqual(["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10", "L11"])
    expect(screen.queryByTestId("export-audio-unvalidated-more")).toBeNull()
  })

  it("lists the lines that will be left silent under \"Validated only\" too", async () => {
    render(<ExportDialog {...BASE} onJumpToAudioLine={vi.fn()} />)
    await chooseByLine()
    await chooseValidatedOnly()
    expect(note()).toHaveTextContent("2 lines have no validated recording and will be left silent")
    expect(screen.getAllByTestId("export-audio-unvalidated-line").map((b) => b.textContent)).toEqual(["L2", "L3"])
  })

  it("without a way to jump, the count stands alone", () => {
    render(<ExportDialog {...BASE} />)
    expect(note()).toHaveTextContent("2 lines will export recordings nobody has validated")
    expect(screen.queryByTestId("export-audio-unvalidated-line")).toBeNull()
  })

  it("never gates the export — the count is a warning, not a block", async () => {
    render(<ExportDialog {...BASE} />)
    await chooseByLine()
    fireEvent.click(screen.getByRole("button", { name: /^Export audio$/i }))
    await waitFor(() => expect(mockByLine).toHaveBeenCalledTimes(1))
    // Every recorded line still ships, validated or not.
    const { cells } = mockByLine.mock.calls[0][0] as { cells: CellData[] }
    expect(cells.map((c) => c.attachments?.[c.selectedAudioId!]?.silencedForExport))
      .toEqual([undefined, undefined, undefined])
  })

  it("withdraws the unvalidated takes once 'Validated only' is chosen", async () => {
    render(<ExportDialog {...BASE} />)
    await chooseByLine()
    await chooseValidatedOnly()
    expect(note()).toHaveTextContent("2 lines have no validated recording and will be left silent")

    fireEvent.click(screen.getByRole("button", { name: /^Export audio$/i }))
    await waitFor(() => expect(mockByLine).toHaveBeenCalledTimes(1))
    const { cells } = mockByLine.mock.calls[0][0] as { cells: CellData[] }
    expect(cells.map((c) => c.attachments?.[c.selectedAudioId!]?.silencedForExport))
      .toEqual([undefined, true, true])
  })
})
