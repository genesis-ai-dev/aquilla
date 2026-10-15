// AQU-1575: Audio by line can write every take as 16-bit / 48 kHz / mono WAV.
// LOTE's broadcast vendor needs exactly that file. This pins that the choice is
// offered wherever Audio by line is, reaches the exporter with a decoder, and is
// remembered per person and project like the dialog's other choices.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

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
import { decodeToMono48k } from "@/lib/audio/decode-mono"
import { writeExportMemory, DEFAULT_EXPORT_MEMORY } from "@/lib/export/export-dialog-memory"

const mockProjectCells = vi.mocked(useProjectCells)
const mockByLine = vi.mocked(exportAudioPerLine)

function line(id: string, at: number): CellData {
  return {
    id,
    fileId: "f1",
    original: "source",
    translated: "translated",
    context: "",
    group: "",
    startTime: at,
    endTime: at + 1,
    selectedAudioId: `take-${id}`,
    attachments: { [`take-${id}`]: { url: `frontier-audio://take-${id}.wav`, type: "audio" } },
  } as CellData
}

const track = (id: string, name: string, kind: TimelineTrack["kind"]) =>
  ({ id, kind, name, order: 0 }) as unknown as TimelineTrack

const FOLD = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "p1",
  projectName: "Journey Arabic",
  activeFileId: "f1",
  activeFileName: "MAT.usfm",
  activeFileType: "usfm",
  projectFiles: [{ id: "f1", name: "MAT.usfm", type: "usfm" }],
  targetLanguage: "ar",
  getToken: async () => null,
  cells: [line("a", 1), line("b", 2)],
}

const DUBBING = {
  ...FOLD,
  activeFileName: "episode.vtt",
  activeFileType: "vtt",
  projectFiles: [{ id: "f1", name: "episode.vtt", type: "vtt" }],
  timelineTracks: [
    track("source-subtitles", "Source text", "source-subtitles"),
    track("target-subtitles", "Target text", "target-subtitles"),
    track("source-audio", "Source audio", "source-audio"),
    track("target-audio", "Target audio", "target-audio"),
  ],
}

const openAudioCard = () => {
  const card = screen.getByTestId("export-audio-card") as HTMLDetailsElement
  if (!card.open) fireEvent.click(card.querySelector("summary")!)
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

describe("the WAV choice on Audio by line (AQU-1575)", () => {
  it("keeps the stored files unless WAV is chosen", async () => {
    render(<ExportDialog {...FOLD} />)
    fireEvent.click(screen.getByText("Export to another format"))
    fireEvent.click(screen.getByText("Audio by line"))
    expect(screen.getByTestId("export-line-audio-wav")).toHaveAttribute("aria-checked", "false")
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockByLine).toHaveBeenCalledTimes(1))
    expect(mockByLine).toHaveBeenCalledWith(expect.objectContaining({ format: "original", decode: undefined }))
  })

  it("sends a ticked WAV box to the exporter with the decoder, and remembers it", async () => {
    render(<ExportDialog {...FOLD} />)
    fireEvent.click(screen.getByText("Export to another format"))
    fireEvent.click(screen.getByText("Audio by line"))
    const box = screen.getByTestId("export-line-audio-wav")
    await userEvent.click(box)
    expect(box).toHaveAttribute("aria-checked", "true")
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("aq.exportdlg.v1")!) as {
        state: { lineAudioFormat: string }
      }[]
      expect(stored[0]!.state.lineAudioFormat).toBe("wav")
    })
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockByLine).toHaveBeenCalledTimes(1))
    expect(mockByLine).toHaveBeenCalledWith(
      expect.objectContaining({ format: "wav", decode: vi.mocked(decodeToMono48k) }),
    )
  })

  it("offers the choice on the dubbing audio card's By line, ticked when remembered", async () => {
    writeExportMemory("local", "p1", {
      ...DEFAULT_EXPORT_MEMORY,
      section: "audio",
      audioMode: "audio-by-line",
      lineAudioFormat: "wav",
    })
    render(<ExportDialog {...DUBBING} />)
    openAudioCard()
    expect(screen.getByTestId("export-line-audio-wav")).toHaveAttribute("aria-checked", "true")
    fireEvent.click(screen.getByRole("button", { name: /Export audio/i }))
    await waitFor(() => expect(mockByLine).toHaveBeenCalledTimes(1))
    expect(mockByLine).toHaveBeenCalledWith(expect.objectContaining({ format: "wav" }))
  })

  it("does not show the choice for the other audio shapes", () => {
    render(<ExportDialog {...DUBBING} />)
    openAudioCard()
    fireEvent.click(screen.getByRole("radio", { name: /^By character/ }))
    expect(screen.queryByTestId("export-line-audio-wav")).toBeNull()
    fireEvent.click(screen.getByRole("radio", { name: /^By line/ }))
    expect(screen.getByTestId("export-line-audio-wav")).toBeInTheDocument()
  })
})
