// AQU-2560: Audio by line names a Bible file's takes by verse. The exporter
// decides whether a file is scripture from its cells; this pins that the dialog
// hands it the project name for a book and withholds the choice for a dubbing
// file, whose takes are named by line and character.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import { ExportDialog } from "./ExportDialog"
import type { CellData } from "@/hooks/useCells"
import type { TimelineTrack } from "@/lib/timeline/tracks"

vi.mock("@/lib/export/export-service", () => ({ downloadBlob: vi.fn() }))
vi.mock("@/hooks/useProjectCells", () => ({ useProjectCells: vi.fn() }))
vi.mock("@/lib/export/audio-per-line", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/export/audio-per-line")>()
  return { ...actual, exportAudioPerLine: vi.fn() }
})
vi.mock("@/lib/audio/decode-mono", () => ({
  decodeToMono48k: vi.fn(async () => new Float32Array([0])),
  TARGET_RATE: 48000,
  concatPcm: (clips: Float32Array[]) => clips[0] ?? new Float32Array(),
}))
vi.mock("@/lib/audio/upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audio/upload")>()
  return { ...actual, fetchCellAudio: vi.fn() }
})

import { useProjectCells } from "@/hooks/useProjectCells"
import { exportAudioPerLine } from "@/lib/export/audio-per-line"
import { writeExportMemory, DEFAULT_EXPORT_MEMORY } from "@/lib/export/export-dialog-memory"

const mockProjectCells = vi.mocked(useProjectCells)
const mockByLine = vi.mocked(exportAudioPerLine)

function line(id: string, at: number, group = ""): CellData {
  return {
    id,
    fileId: "f1",
    original: "source",
    translated: "translated",
    context: "",
    group,
    startTime: at,
    endTime: at + 1,
    selectedAudioId: `take-${id}`,
    attachments: { [`take-${id}`]: { url: `frontier-audio://take-${id}.wav`, type: "audio" } },
  } as CellData
}

const track = (id: string, name: string, kind: TimelineTrack["kind"]) =>
  ({ id, kind, name, order: 0 }) as unknown as TimelineTrack

const BOOK = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "p1",
  projectName: "Pattani Malay Bible",
  activeFileId: "f1",
  activeFileName: "LUK.usfm",
  activeFileType: "usfm",
  projectFiles: [{ id: "f1", name: "LUK.usfm", type: "usfm" }],
  targetLanguage: "Pattani Malay",
  getToken: async () => null,
  cells: [line("a", 1, "LUK 1:1"), line("b", 2, "LUK 1:2")],
}

const DUBBING = {
  ...BOOK,
  activeFileName: "episode.vtt",
  activeFileType: "vtt",
  projectFiles: [{ id: "f1", name: "episode.vtt", type: "vtt" }],
  cells: [line("a", 1), line("b", 2)],
  timelineTracks: [
    track("source-subtitles", "Source text", "source-subtitles"),
    track("target-subtitles", "Target text", "target-subtitles"),
    track("source-audio", "Source audio", "source-audio"),
    track("target-audio", "Target audio", "target-audio"),
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  try { localStorage.removeItem("aq.exportdlg.v1") } catch { /* ignore */ }
  mockProjectCells.mockReturnValue({
    files: [], isLoading: false, isTruncated: false,
  } as unknown as ReturnType<typeof useProjectCells>)
  mockByLine.mockResolvedValue({
    blob: new Blob([new Uint8Array([1])], { type: "application/zip" }),
    files: 2, clips: 2, skipped: 0, untimed: 0, untrimmed: 0,
  })
})

describe("scripture names on Audio by line (AQU-2560)", () => {
  it("hands the exporter the project name for a book", async () => {
    render(<ExportDialog {...BOOK} />)
    fireEvent.click(screen.getByText("Export to another format"))
    fireEvent.click(screen.getByText("Audio by line"))
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockByLine).toHaveBeenCalledTimes(1))
    expect(mockByLine).toHaveBeenCalledWith(
      expect.objectContaining({
        scriptureNaming: { projectName: "Pattani Malay Bible" },
        langCode: "Pattani Malay",
      }),
    )
  })

  it("does not offer scripture names to a dubbing file", async () => {
    writeExportMemory("local", "p1", {
      ...DEFAULT_EXPORT_MEMORY,
      section: "audio",
      audioMode: "audio-by-line",
    })
    render(<ExportDialog {...DUBBING} />)
    const card = screen.getByTestId("export-audio-card") as HTMLDetailsElement
    if (!card.open) fireEvent.click(card.querySelector("summary")!)
    fireEvent.click(screen.getByRole("button", { name: /Export audio/i }))
    await waitFor(() => expect(mockByLine).toHaveBeenCalledTimes(1))
    expect(mockByLine.mock.calls[0]![0].scriptureNaming).toBeUndefined()
  })
})
