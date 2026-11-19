// AQU-1201: chapter stitch is a third audio shape. By-character and by-line
// stay on the card exactly as they were; this file pins that the new option
// is offered, that choosing it stitches, and that the other two still export.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ExportDialog } from "./ExportDialog"
import type { CellData } from "@/hooks/useCells"
import type { TimelineTrack } from "@/lib/timeline/tracks"

const analytics = vi.hoisted(() => ({ capture: vi.fn(), captureException: vi.fn(), enabled: () => false }))
vi.mock("@/hooks/useAccountAnalytics", () => ({ useAccountAnalytics: () => analytics }))
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

import { toast } from "@/components/ui/toast"
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
  } as unknown as ReturnType<typeof useProjectCells>)
  mockChapter.mockResolvedValue({
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
    extension: "wav",
    downloadSuffix: "_MAT_1.wav",
    chapters: 1,
    clips: 2,
    skipped: 0,
    silenced: 0,
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
    expect(mockDownload).toHaveBeenCalledWith((await mockChapter.mock.results[0].value).blob, expect.stringMatching(/_MAT_1\.wav$/), analytics)
    expect(mockChapter).toHaveBeenCalledWith(expect.objectContaining({ includeChapterHeadings: false }))
  })

  it("remembers a checked include-chapter-headings box and sends it with the export", async () => {
    const heading = verse("h1", "")
    heading.type = "heading"
    heading.group = ""
    render(<ExportDialog {...BASE} cells={[heading, ...BASE.cells]} />)
    fireEvent.click(screen.getByText("Export to another format"))
    fireEvent.click(screen.getByText("Chapter audio"))
    const box = screen.getByTestId("export-include-chapter-headings")
    expect(box).toHaveAttribute("aria-checked", "false")
    await userEvent.click(box)
    expect(box).toHaveAttribute("aria-checked", "true")
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem("aq.exportdlg.v1")!) as {
        state: { includeChapterHeadings: boolean }
      }[]
      expect(stored[0]!.state.includeChapterHeadings).toBe(true)
    })
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockChapter).toHaveBeenCalledTimes(1))
    expect(mockChapter).toHaveBeenCalledWith(expect.objectContaining({ includeChapterHeadings: true }))
  })

  it("still exports by-character without going through the stitcher", async () => {
    render(<ExportDialog {...BASE} />)
    fireEvent.click(screen.getByText("Export to another format"))
    fireEvent.click(screen.getByText("Audio by character"))
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockByCharacter).toHaveBeenCalledTimes(1))
    expect(mockChapter).not.toHaveBeenCalled()
    expect(mockDownload).toHaveBeenCalledWith((await mockByCharacter.mock.results[0].value).blob, expect.stringMatching(/audio-by-character\.zip$/), analytics)
  })

  it("still exports by-line without going through the stitcher", async () => {
    render(<ExportDialog {...BASE} />)
    fireEvent.click(screen.getByText("Export to another format"))
    fireEvent.click(screen.getByText("Audio by line"))
    fireEvent.click(screen.getByRole("button", { name: /^Export$/i }))
    await waitFor(() => expect(mockByLine).toHaveBeenCalledTimes(1))
    expect(mockChapter).not.toHaveBeenCalled()
    expect(mockDownload).toHaveBeenCalledWith((await mockByLine.mock.results[0].value).blob, expect.stringMatching(/audio-by-line\.zip$/), analytics)
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

  // Wendi, 2026-11-17: the stitched file runs every line together, so an
  // episode comes out half its length. The dubbing card has to offer the
  // other single file — the one that keeps each line at its timestamp — and
  // hand back a WAV, not a zip with one entry to dig out.
  it("offers Full episode and downloads it as one WAV with every line on one track", async () => {
    mockByCharacter.mockResolvedValue({
      blob: new Blob([new Uint8Array([1])], { type: "audio/wav" }),
      skipped: 0, clips: 2, characters: 1, untimed: 0,
    })
    render(<ExportDialog {...dubbing} />)
    const card = screen.getByTestId("export-audio-card") as HTMLDetailsElement
    if (!card.open) fireEvent.click(card.querySelector("summary")!)
    fireEvent.click(screen.getByRole("radio", { name: /^Full episode/ }))
    // What it will be is said before anything is asked for.
    expect(screen.getByTestId("export-episode-estimate")).toHaveTextContent(/One file, about 1 minute long/)
    fireEvent.click(screen.getByRole("button", { name: /Export audio/i }))
    // An hour of WAV is not something to start by a stray click: it asks first.
    const confirm = await screen.findByTestId("export-episode-confirm")
    expect(mockByCharacter).not.toHaveBeenCalled()
    expect(confirm).toHaveTextContent(/usually takes about 1 minute/)
    expect(confirm).toHaveTextContent(/You can close this window/)
    fireEvent.click(screen.getByRole("button", { name: "Start export" }))
    await waitFor(() => expect(mockByCharacter).toHaveBeenCalledTimes(1))
    expect(mockByCharacter).toHaveBeenCalledWith(
      expect.objectContaining({ singleTrack: true, signal: expect.any(AbortSignal) }),
    )
    expect(mockChapter).not.toHaveBeenCalled()
    expect(mockDownload).toHaveBeenCalledWith(
      (await mockByCharacter.mock.results[0].value).blob,
      expect.stringMatching(/_full-episode\.wav$/),
      analytics,
    )
  })

  it("exports nothing when the full-episode confirm step is cancelled", async () => {
    render(<ExportDialog {...dubbing} />)
    const card = screen.getByTestId("export-audio-card") as HTMLDetailsElement
    if (!card.open) fireEvent.click(card.querySelector("summary")!)
    fireEvent.click(screen.getByRole("radio", { name: /^Full episode/ }))
    fireEvent.click(screen.getByRole("button", { name: /Export audio/i }))
    const confirm = await screen.findByTestId("export-episode-confirm")
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByTestId("export-episode-confirm")).not.toBeInTheDocument())
    expect(mockByCharacter).not.toHaveBeenCalled()
    expect(mockDownload).not.toHaveBeenCalled()
  })

  // Cancelled on purpose is not a failure: no download, and no error shown.
  it("stops a running full-episode export without downloading or reporting an error", async () => {
    mockByCharacter.mockImplementation(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason))
        }),
    )
    const addToast = vi.spyOn(toast, "add")
    render(<ExportDialog {...dubbing} />)
    const card = screen.getByTestId("export-audio-card") as HTMLDetailsElement
    if (!card.open) fireEvent.click(card.querySelector("summary")!)
    fireEvent.click(screen.getByRole("radio", { name: /^Full episode/ }))
    fireEvent.click(screen.getByRole("button", { name: /Export audio/i }))
    fireEvent.click(await screen.findByRole("button", { name: "Start export" }))
    await waitFor(() => expect(mockByCharacter).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId("export-keeps-running")).toBeInTheDocument()
    // The notice in the corner carries the Cancel button; press it.
    const notice = addToast.mock.calls.at(-1)![0] as { actionProps: { onClick: () => void } }
    notice.actionProps.onClick()
    await waitFor(() => expect(screen.queryByTestId("export-keeps-running")).not.toBeInTheDocument())
    expect(mockDownload).not.toHaveBeenCalled()
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument()
  })

  it("keeps By character a zip of separate tracks", async () => {
    render(<ExportDialog {...dubbing} />)
    const card = screen.getByTestId("export-audio-card") as HTMLDetailsElement
    if (!card.open) fireEvent.click(card.querySelector("summary")!)
    fireEvent.click(screen.getByRole("radio", { name: /^By character/ }))
    fireEvent.click(screen.getByRole("button", { name: /Export audio/i }))
    await waitFor(() => expect(mockByCharacter).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId("export-episode-confirm")).not.toBeInTheDocument()
    expect(mockByCharacter).toHaveBeenCalledWith(expect.objectContaining({ singleTrack: false }))
    expect(mockDownload).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/audio-by-character\.zip$/), analytics)
  })
})
