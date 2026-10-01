import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react"

vi.mock("@/lib/import/youtube-caption-commit", () => ({
  createYouTubeCaptionCommit: vi.fn(),
}))

import { YouTubeImportPanel } from "./YouTubeImportPanel"
import { createYouTubeCaptionCommit } from "@/lib/import/youtube-caption-commit"

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

})
