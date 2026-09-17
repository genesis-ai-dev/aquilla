// AQU-1201: chapter stitch is a third audio shape. By-character and by-line
// stay on the card exactly as they were; this file pins that the new option
// is offered, that choosing it stitches, and that the other two still export.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

import { ExportDialog } from "./ExportDialog"
import type { CellData } from "@/hooks/useCells"
import type { TimelineTrack } from "@/lib/timeline/tracks"

vi.mock("@/lib/export/export-service", () => ({ downloadBlob: vi.fn() }))
vi.mock("@/hooks/useProjectCells", () => ({ useProjectCells: vi.fn() }))
vi.mock("@/lib/export/audio-chapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/export/audio-chapter")>()
  return {
    ...actual,
    exportAudioByChapter: vi.fn(),
  }
})
vi.mock("@/lib/export/audio-by-character", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/export/audio-by-character")>()
  return {
    ...actual,
    exportAudioByCharacter: vi.fn(),
  }
})
vi.mock("@/lib/export/audio-per-line", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/export/audio-per-line")>()
  return {
    ...actual,
    exportAudioPerLine: vi.fn(),
  }
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

import { downloadBlob } from "@/lib/export/export-service"
import { useProjectCells } from "@/hooks/useProjectCells"
import { exportAudioByChapter } from "@/lib/export/audio-chapter"
import { exportAudioByCharacter } from "@/lib/export/audio-by-character"
import { exportAudioPerLine } from "@/lib/export/audio-per-line"

const mockDownload = vi.mocked(downloadBlob)
const mockProjectCells = vi.mocked(useProjectCells)
const mockChapter = vi.mocked(exportAudioByChapter)
const mockByCharacter = vi.mocked(exportAudioByCharacter)
const mockByLine = vi.mocked(exportAudioPerLine)

function verse(id: string, ref: string): CellData {
  return {
    id,
    fileId: "f1",
    original: "source",
    translated: "translated",
    context: "",
    group: ref,
    selectedAudioId: `take-${id}`,
    attachments: { [`take-${id}`]: { url: `frontier-audio://take-${id}.wav`, type: "audio" } },
  } as CellData
}

const BASE = {
  open: true,
  onOpenChange: vi.fn(),
  projectId: "p1",
  projectName: "Pattani Malay",
  activeFileId: "f1",
  activeFileName: "MAT.usfm",
  activeFileType: "usfm",
  projectFiles: [{ id: "f1", name: "MAT.usfm", type: "usfm" }],
  targetLanguage: "mfa",
  getToken: async () => null,
  cells: [verse("v1", "MAT 1:1"), verse("v2", "MAT 1:2")],
}

const track = (id: string, name: string, kind: TimelineTrack["kind"]) =>
  ({ id, kind, name, order: 0 }) as unknown as TimelineTrack

beforeEach(() => {
  vi.clearAllMocks()
  try { localStorage.removeItem("aq.exportdlg.v1") } catch { /* ignore */ }
  mockProjectCells.mockReturnValue({
    files: [], isLoading: false, isTruncated: false,
  } as ReturnType<typeof useProjectCells>)
  mockChapter.mockResolvedValue({
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
    extension: "wav",
    downloadSuffix: "_MAT_1.wav",
    chapters: 1,
    clips: 2,
    skipped: 0,
  })
  mockByCharacter.mockResolvedValue({
    blob: new Blob([new Uint8Array([1])], { type: "application/zip" }),
    skipped: 0, clips: 2, characters: 1, untimed: 0,
  })
  mockByLine.mockResolvedValue({
    blob: new Blob([new Uint8Array([1])], { type: "application/zip" }),
    files: 2, clips: 2, skipped: 0, untimed: 0, untrimmed: 0,
  })
})

describe("chapter audio export (AQU-1201)", () => {
  it("offers Chapter audio in the format list for a scripture file", () => {
    render(<ExportDialog {...BASE} />)
    fireEvent.click(screen.getByText("Export to another format"))
    expect(screen.getByText("Chapter audio")).toBeInTheDocument()
    expect(screen.getByText("Audio by character")).toBeInTheDocument()
    expect(screen.getByText("Audio by line")).toBeInTheDocument()
  })

  it("downloads one stitched WAV when Chapter audio is exported", async () => {
    render(<ExportDialog {...BASE} />)
    fireEvent.click(screen.getByText("Export to another format"))
    fireEvent.click(screen.getByText("Chapter audio"))
    expect(screen.getByTestId("export-chapter-preview")).toHaveTextContent(/2 verses recorded · 1 chapters/i)
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockChapter).toHaveBeenCalledTimes(1))
    expect(mockByCharacter).not.toHaveBeenCalled()
    expect(mockByLine).not.toHaveBeenCalled()
    expect(mockDownload).toHaveBeenCalledWith(expect.any(Blob), expect.stringMatching(/_MAT_1\.wav$/))
  })

  it("still exports by-character without going through the stitcher", async () => {
    render(<ExportDialog {...BASE} />)
    fireEvent.click(screen.getByText("Export to another format"))
    fireEvent.click(screen.getByText("Audio by character"))
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockByCharacter).toHaveBeenCalledTimes(1))
    expect(mockChapter).not.toHaveBeenCalled()
    expect(mockDownload).toHaveBeenCalledWith(expect.any(Blob), expect.stringMatching(/audio-by-character\.zip$/))
  })

  it("still exports by-line without going through the stitcher", async () => {
    render(<ExportDialog {...BASE} />)
    fireEvent.click(screen.getByText("Export to another format"))
    fireEvent.click(screen.getByText("Audio by line"))
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockByLine).toHaveBeenCalledTimes(1))
    expect(mockChapter).not.toHaveBeenCalled()
    expect(mockDownload).toHaveBeenCalledWith(expect.any(Blob), expect.stringMatching(/audio-by-line\.zip$/))
  })
})

describe("the dubbing audio card offers the chapter stitch", () => {
  const dubbing = {
    ...BASE,
    activeFileName: "episode.vtt",
    activeFileType: "vtt",
    projectFiles: [{ id: "f1", name: "episode.vtt", type: "vtt" }],
    cells: [verse("s1", ""), verse("s2", "")].map((c, i) => ({
      ...c,
      group: "",
      startTime: i + 1,
      endTime: i + 2,
    })),
    timelineTracks: [
      track("source-subtitles", "Source text", "source-subtitles"),
      track("target-subtitles", "Target text", "target-subtitles"),
      track("source-audio", "Source audio", "source-audio"),
      track("target-audio", "Target audio", "target-audio"),
    ],
  }

  it("adds By chapter next to By character and By line", () => {
    render(<ExportDialog {...dubbing} />)
    const card = screen.getByTestId("export-audio-card") as HTMLDetailsElement
    if (!card.open) fireEvent.click(card.querySelector("summary")!)
    expect(screen.getByRole("radio", { name: /^By character/ })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /^By line/ })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /^By chapter/ })).toBeInTheDocument()
  })

  it("exports the stitched file from the audio card", async () => {
    render(<ExportDialog {...dubbing} />)
    const card = screen.getByTestId("export-audio-card") as HTMLDetailsElement
    if (!card.open) fireEvent.click(card.querySelector("summary")!)
    fireEvent.click(screen.getByRole("radio", { name: /^By chapter/ }))
    fireEvent.click(screen.getByRole("button", { name: /Export audio/i }))
    await waitFor(() => expect(mockChapter).toHaveBeenCalledTimes(1))
    expect(mockByCharacter).not.toHaveBeenCalled()
    expect(mockByLine).not.toHaveBeenCalled()
  })
})
