// AQU-2682: an audio or video upload stores the file's source audio, which
// the server takes only from someone whose access covers every language. With
// `mediaDisabledReason` set, the Upload files panel says why and refuses a
// media file before anything is read or uploaded; text files still import.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

vi.mock("@/lib/import", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/import")>(),
  probeMediaDurationMs: vi.fn(async () => 3000),
  importFile: vi.fn(async (file: File) => ({
    refs: [{ id: "imported", name: file.name, type: "audio", cellCount: 1,
      createdAt: "2026-11-20T00:00:00Z", orderedBy: "time" }],
    speakerPairs: [],
  })),
}))

import { ImportDialog } from "./ImportDialog"
import { importFile } from "@/lib/import"

const REASON = "Importing audio or video needs access to every language."

beforeEach(() => { vi.clearAllMocks() })

function open(mediaDisabledReason: string | null) {
  render(<ImportDialog open onOpenChange={() => {}}
    projectId="p1" username="dev" sourceLanguage="en" targetLanguage="es"
    getToken={async () => "token"} onImported={() => {}}
    mediaDisabledReason={mediaDisabledReason} />)
  fireEvent.click(screen.getByRole("button", { name: /^Upload files/ }))
  return document.querySelector('input[type="file"][multiple]')!
}

describe("Upload files: audio and video need every language", () => {
  it("says why on the panel and refuses an audio file before any import", async () => {
    const input = open(REASON)
    expect(screen.getByTestId("upload-media-disabled")).toHaveTextContent(REASON)
    fireEvent.change(input, { target: { files: [new File(["audio"], "sermon.mp3", { type: "audio/mpeg" })] } })
    expect(await screen.findByText(REASON, { selector: ".text-destructive" })).toBeVisible()
    expect(importFile).not.toHaveBeenCalled()
  })

  it("refuses a video dropped with its captions, too", async () => {
    const input = open(REASON)
    fireEvent.change(input, { target: { files: [
      new File(["video"], "clip.mp4", { type: "video/mp4" }),
      new File(["1\n00:00:00,500 --> 00:00:01,500\nHello"], "clip.srt"),
    ] } })
    expect(await screen.findByText(REASON, { selector: ".text-destructive" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Continue import" })).toBeNull()
    expect(importFile).not.toHaveBeenCalled()
  })

  it("imports audio as before with no reason", async () => {
    const input = open(null)
    expect(screen.queryByTestId("upload-media-disabled")).toBeNull()
    fireEvent.change(input, { target: { files: [new File(["audio"], "sermon.mp3", { type: "audio/mpeg" })] } })
    await waitFor(() => expect(importFile).toHaveBeenCalledTimes(1))
  })

  it("passes the reason to the YouTube panel's original-media option", () => {
    render(<ImportDialog open onOpenChange={() => {}}
      projectId="p1" username="dev" sourceLanguage="en" targetLanguage="es"
      getToken={async () => "token"} onImported={() => {}}
      mediaDisabledReason={REASON} />)
    fireEvent.click(screen.getByRole("button", { name: /^YouTube video/ }))
    fireEvent.click(screen.getByLabelText("Use original audio or video"))
    expect(screen.getByTestId("youtube-media-disabled")).toHaveTextContent(REASON)
  })

  it("imports a video with no reason (a Maintainer once the answer is in)", async () => {
    const input = open(null)
    fireEvent.change(input, { target: { files: [new File(["video"], "clip.mp4", { type: "video/mp4" })] } })
    await waitFor(() => expect(importFile).toHaveBeenCalledTimes(1))
  })
})
