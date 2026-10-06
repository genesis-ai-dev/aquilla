import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react"

vi.mock("@/lib/import/youtube-caption-commit", () => ({
  createYouTubeCaptionCommit: vi.fn(),
}))
vi.mock("@/lib/import", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/import")>(),
  createMediaFileCommit: vi.fn(),
  probeMediaDurationMs: vi.fn(async () => 4000),
}))

import { YouTubeImportPanel } from "./YouTubeImportPanel"
import { createYouTubeCaptionCommit } from "@/lib/import/youtube-caption-commit"
import { createMediaFileCommit } from "@/lib/import"
import { embeddedSubtitleFixture } from "@/lib/parsers/__fixtures__/embedded-subtitles"

const SRT_CONTENT = `1
00:00:01,000 --> 00:00:02,000
Hello world`

function makeFile(content: string, name = "Captions.srt"): File {
  return new File([content], name, { type: "text/plain" })
}

async function selectFile(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file], configurable: true })
    fireEvent.change(input)
  })
}

function fillYouTubeLink(url: string) {
  const input = screen.getByLabelText(/youtube video link/i) as HTMLInputElement
  fireEvent.change(input, { target: { value: url } })
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof YouTubeImportPanel>> = {}) {
  const defaults: React.ComponentProps<typeof YouTubeImportPanel> = {
    ctx: {
      projectId: "p1",
      author: "dev",
      getToken: vi.fn(async () => "token"),
    },
    onImported: vi.fn(),
  }
  return render(<YouTubeImportPanel {...defaults} {...overrides} />)
}

describe("YouTubeImportPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createYouTubeCaptionCommit).mockReturnValue(async () => ({
      ref: {
        id: "f1",
        name: "Captions",
        type: "srt",
        createdAt: "2026-09-30",
        cellCount: 1,
        orderedBy: "time",
        coreMediaUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      },
      speakerPairs: [],
    }))
  })

  it("imports YouTube captions with preview and commit flow", async () => {
    const onImported = vi.fn()
    renderPanel({ onImported })

    fillYouTubeLink("https://youtu.be/dQw4w9WgXcQ")
    fireEvent.click(screen.getByLabelText("Import a caption export"))

    await selectFile(makeFile(SRT_CONTENT, "Captions.srt"))

    const previewBtn = await screen.findByRole("button", { name: /preview captions/i })
    await act(async () => {
      fireEvent.click(previewBtn)
    })

    await waitFor(() => {
      expect(screen.getByText(/hello world/i)).toBeInTheDocument()
    })

    const importBtn = screen.getByRole("button", { name: /import captions/i })
    expect(importBtn).toBeEnabled()
    expect(onImported).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(importBtn)
    })

    await waitFor(() => {
      expect(onImported).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: "f1",
            coreMediaUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          }),
        ]),
      )
    })

    const prepared = vi.mocked(createYouTubeCaptionCommit).mock.calls[0][0]
    expect(prepared.strings[0].original).toBe("Hello world")
    expect("rawBytes" in prepared).toBe(true)
    if (!("rawBytes" in prepared)) throw new Error("Caption artifact is missing")
    expect(new TextDecoder().decode(prepared.rawBytes)).toBe(SRT_CONTENT)
  })
  it("keeps the preview when publication fails and retries its commit", async () => {
    const onImported = vi.fn()
    const publish = vi.fn()
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce({
        ref: { id: "f1", name: "Captions", type: "srt",
          createdAt: "2026-09-30", cellCount: 1, orderedBy: "time" },
        speakerPairs: [],
      })
    vi.mocked(createYouTubeCaptionCommit).mockReturnValue(publish)
    renderPanel({ onImported })
    fillYouTubeLink("https://youtu.be/dQw4w9WgXcQ")
    fireEvent.click(screen.getByLabelText("Import a caption export"))
    await selectFile(makeFile(SRT_CONTENT))
    fireEvent.click(screen.getByRole("button", { name: "Preview captions" }))
    await screen.findByText("Hello world")
    fireEvent.click(screen.getByRole("button", { name: "Import captions" }))
    expect(await screen.findByRole("alert"))
      .toHaveTextContent("Connection interrupted")
    expect(onImported).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Import captions" }))
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce())
    expect(createYouTubeCaptionCommit).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it("links a picture without requiring captions", async () => {
    const onImported = vi.fn()
    renderPanel({ onImported })
    fillYouTubeLink("https://youtu.be/dQw4w9WgXcQ")
    fireEvent.change(screen.getByLabelText("Video name"), {
      target: { value: "My video" },
    })
    expect(screen.queryByLabelText("Your caption export")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }))
    await screen.findByText("My video")
    expect(createYouTubeCaptionCommit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "My video", strings: [],
        videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
      expect.anything(),
    )
    fireEvent.click(screen.getByRole("button", { name: "Link video" }))
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce())
  })
  it("offers automatic captions from original media with the YouTube picture", async () => {
    const onImported = vi.fn()
    vi.mocked(createMediaFileCommit).mockReturnValue(async () => ({
      id: "media1", name: "clip.mp3", type: "audio", createdAt: "2026-10-01",
      orderedBy: "time", cellCount: 1,
    }))
    renderPanel({ onImported })
    fillYouTubeLink("https://youtu.be/dQw4w9WgXcQ")
    fireEvent.click(screen.getByLabelText("Use original audio or video"))
    await selectFile(new File(["audio"], "clip.mp3", { type: "audio/mpeg" }))
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }))
    await screen.findByRole("dialog")
    fireEvent.click(screen.getByRole("button", { name: "Import media and link video" }))
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce())
    expect(createMediaFileCommit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "clip.mp3" }), "audio",
      expect.objectContaining({
        mediaPictureUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        mediaTextSource: undefined,
      }),
    )
  })
  it("reviews and edits embedded captions in original media", async () => {
    const onImported = vi.fn()
    vi.mocked(createMediaFileCommit).mockReturnValue(async () => ({
      id: "media1", name: "clip.m4a", type: "audio", createdAt: "2026-10-01",
      orderedBy: "time", cellCount: 2,
    }))
    renderPanel({ onImported })
    fillYouTubeLink("https://youtu.be/dQw4w9WgXcQ")
    fireEvent.click(screen.getByLabelText("Use original audio or video"))
    await selectFile(new File([embeddedSubtitleFixture()], "clip.m4a"))
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }))
    const wording = await screen.findByLabelText("Segment 1 wording")
    expect(wording).toHaveValue("First phrase")
    fireEvent.change(wording, { target: { value: "Reviewed phrase" } })
    fireEvent.click(screen.getByRole("button", { name: "Import media and link video" }))
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce())
    expect(createMediaFileCommit).toHaveBeenCalledWith(
      expect.any(File), "audio", expect.objectContaining({
        mediaTextSource: expect.objectContaining({ cues: [
          expect.objectContaining({ original: "Reviewed phrase", start: 0, end: 1 }),
          expect.objectContaining({ original: "Second phrase", start: 1, end: 3 }),
        ] }),
      }),
    )
  })

  it("invalidates a prepared picture when the caption source changes", async () => {
    renderPanel()
    fillYouTubeLink("https://youtu.be/dQw4w9WgXcQ")
    fireEvent.change(screen.getByLabelText("Video name"), { target: { value: "My picture" } })
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }))
    await screen.findByRole("button", { name: "Link video" })
    fireEvent.click(screen.getByLabelText("Import a caption export"))
    expect(screen.queryByRole("button", { name: "Link video" }))
      .not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Preview captions" })).toBeDisabled()
  })
})
