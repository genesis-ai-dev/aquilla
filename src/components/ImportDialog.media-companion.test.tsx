import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

vi.mock("@/lib/import", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/import")>(),
  probeMediaDurationMs: vi.fn(async () => 3000),
  importFile: vi.fn(async (file: File) => ({
    refs: [{ id: "media-import", name: file.name, type: "audio", cellCount: 1,
      createdAt: "2026-09-30T00:00:00Z", orderedBy: "time" }],
    speakerPairs: [],
  })),
}))

import { ImportDialog } from "./ImportDialog"
import { importFile } from "@/lib/import"

beforeEach(() => { vi.clearAllMocks() })

describe("companion subtitles in the upload dialog", () => {
  it("flags captions beyond the media duration before any writes", async () => {
    render(<ImportDialog open onOpenChange={() => {}}
      projectId="p1" username="dev" sourceLanguage="en" targetLanguage="es"
      getToken={async () => "token"} onImported={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /^Upload files/ }))
    const input = document.querySelector('input[type="file"][multiple]')!
    fireEvent.change(input, { target: { files: [
      new File(["audio"], "clip.mp3", { type: "audio/mpeg" }),
      new File(["1\n00:00:01,000 --> 00:00:05,000\nToo long"], "clip.srt"),
    ] } })
    await screen.findByRole("textbox", { name: "Segment 1 wording" })
    expect(screen.getByRole("button", { name: "Continue import" })).toBeDisabled()
    expect(screen.getByText("ends after the media.")).toBeVisible()
    expect(importFile).not.toHaveBeenCalled()
  })
  it("prepares real captions, waits for review, and commits only the paired media", async () => {
    const onImported = vi.fn()
    render(<ImportDialog open onOpenChange={() => {}}
      projectId="p1" username="dev" sourceLanguage="en" targetLanguage="es"
      getToken={async () => "token"} onImported={onImported} />)
    fireEvent.click(screen.getByRole("button", { name: /^Upload files/ }))
    const input = document.querySelector('input[type="file"][multiple]')!
    const text = "1\n00:00:00,500 --> 00:00:01,500\nOriginal wording"
    const media = new File(["audio"], "clip.mp3", { type: "audio/mpeg" })
    const captions = new File([text], "clip.srt", { type: "text/plain" })
    fireEvent.change(input, { target: { files: [media, captions] } })
    const wording = await screen.findByRole("textbox", { name: "Segment 1 wording" })
    expect(wording).toHaveValue("Original wording")
    expect(importFile).not.toHaveBeenCalled()
    fireEvent.change(wording, { target: { value: "Reviewed wording" } })
    fireEvent.click(screen.getByRole("button", { name: "Continue import" }))
    await waitFor(() => expect(importFile).toHaveBeenCalledTimes(1))
    const [committed, context] = vi.mocked(importFile).mock.calls[0]
    expect(committed).toBe(media)
    expect(context.mediaTextSource?.cues[0]).toMatchObject({
      original: "Reviewed wording", start: 0.5, end: 1.5,
    })
    expect(context.mediaTextSource?.artifact?.bytes).toEqual(await captions.arrayBuffer())
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1))
  })
})
