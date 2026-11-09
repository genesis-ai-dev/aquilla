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
import { framesAsHundredthsVtt, SAMPLE_CUE } from "@/lib/parsers/frame-timecode.fixtures"

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
  it("warns about times written as frame numbers in hundredths, and imports them converted (AQU-2197)", async () => {
    const onImported = vi.fn()
    renderPanel({ onImported })
    fillYouTubeLink("https://youtu.be/dQw4w9WgXcQ")
    fireEvent.click(screen.getByLabelText("Import a caption export"))
    await selectFile(makeFile(framesAsHundredthsVtt(), "ep101.vtt"))
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /preview captions/i }))
    })
    expect(await screen.findByTestId("frames-as-hundredths")).toHaveTextContent(/frame numbers written as hundredths/)
    // The preview table shows the converted time.
    expect(screen.getByText(`${SAMPLE_CUE.startAt24.toFixed(3)}–${SAMPLE_CUE.endAt24.toFixed(3)}`)).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /import captions/i }))
    })
    await waitFor(() => expect(onImported).toHaveBeenCalled())
    const prepared = vi.mocked(createYouTubeCaptionCommit).mock.calls.at(-1)![0]
    const cue = prepared.strings.find(c => c.original === SAMPLE_CUE.text)!
    expect(cue.start).toBeCloseTo(SAMPLE_CUE.startAt24, 6)
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

  // Import map X-D-silent-cue-drop (Nov 2): a cue with a typo in its time
  // vanished from the preview and the import without a word.
  it("says how many cue times it could not read, as Upload files does", async () => {
    renderPanel()
    fillYouTubeLink("https://youtu.be/dQw4w9WgXcQ")
    fireEvent.click(screen.getByLabelText("Import a caption export"))
    await selectFile(makeFile(`WEBVTT

00:00:01.000 --> 00:00:02.000
Hello world

00:00:xx.000 --> 00:00:12.000
Lost words
`, "Captions.vtt"))
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /preview captions/i }))
    })
    await waitFor(() => expect(screen.getByText(/hello world/i)).toBeInTheDocument())
    expect(screen.getByTestId("youtube-captions-unreadable")).toHaveTextContent(
      "1 cue time could not be read, so its wording is not in this import.")
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
    fireEvent.click(screen.getByRole("button", { name: "Link film" }))
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce())
  })
  // AQU-2426: original media with no captions asks whole or transcribed; the
  // recording is never cut or transcribed without that choice.
  it.each([
    ["Import whole recording", "whole"],
    ["Transcribe and import", "transcribe"],
  ] as const)("original media with no captions: %s, with the YouTube picture", async (button, mode) => {
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
    expect(screen.queryByRole("button", { name: "Transcribe audio" })).not.toBeInTheDocument()
    if (mode === "transcribe") {
      fireEvent.click(screen.getByRole("button", { name: "Import and transcribe…" }))
      expect(await screen.findByText("Requests")).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole("button", { name: button }))
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce())
    expect(createMediaFileCommit).toHaveBeenCalledWith(
      expect.objectContaining({ name: "clip.mp3" }), "audio",
      expect.objectContaining({
        mediaPictureUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        mediaTextSource: undefined,
        mediaMode: mode,
      }),
    )
  })
  // Import map D#20: the same 2 GB limit was told three ways; this one had no
  // number and lumped an empty file in with it.
  it("says an original over the limit is, the importer's way, and an empty one is empty", async () => {
    renderPanel()
    fillYouTubeLink("https://youtu.be/dQw4w9WgXcQ")
    fireEvent.click(screen.getByLabelText("Use original audio or video"))
    const huge = new File(["x"], "Episode 101.mov", { type: "video/quicktime" })
    Object.defineProperty(huge, "size", { value: 3 * 1024 * 1024 * 1024 })
    await selectFile(huge)
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }))
    expect(await screen.findByText("Episode 101.mov exceeds the 2 GB media import limit.")).toBeInTheDocument()

    await selectFile(new File([], "Empty.mov", { type: "video/quicktime" }))
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }))
    expect(await screen.findByText("Empty.mov is empty.")).toBeInTheDocument()
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
    fireEvent.click(await screen.findByRole("button", { name: "Edit caption 1" }))
    const wording = screen.getByLabelText("Caption 1 wording")
    expect(wording).toHaveValue("First phrase")
    fireEvent.change(wording, { target: { value: "Reviewed phrase" } })
    fireEvent.click(screen.getByRole("button", { name: "Import media and link the film" }))
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
    await screen.findByRole("button", { name: "Link film" })
    fireEvent.click(screen.getByLabelText("Import a caption export"))
    expect(screen.queryByRole("button", { name: "Link film" }))
      .not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Preview captions" })).toBeDisabled()
  })
})
