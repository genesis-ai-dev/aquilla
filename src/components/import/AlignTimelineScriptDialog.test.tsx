import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { CellData } from "@/hooks/useCells"
import { alignChunks } from "@/lib/audio/timings"
import { AlignTimelineScriptDialog } from "./AlignTimelineScriptDialog"

const { createTimelineTextTrackImporter } = vi.hoisted(() => ({
  createTimelineTextTrackImporter: vi.fn(),
}))

vi.mock("@/lib/import/timeline-text", () => ({
  createTimelineTextTrackImporter: createTimelineTextTrackImporter,
}))

vi.mock("@/lib/audio/clip-preview", () => ({
  playClip: vi.fn(() => ({ stop: vi.fn() })),
}))

describe("align timeline script", () => {
  it("imports aligned segments with source evidence and handles refresh retry", async () => {
    const audioId = "audio-file-9-1700000000-src1.mp3"
    const clipUrl = "frontier-audio://audio-file-9-1700000000-src1.mp3"
    const cells: CellData[] = [{
      id: "sec-1",
      fileId: "file-9",
      medium: "media",
      selectedAudioId: audioId,
      original: "Hello world.",
      translated: "",
      context: "",
      group: "",
      type: "text",
      status: "unvalidated",
      validationStatus: "none",
      activeValidators: [],
      validationHistory: [],
      history: [],
      threads: [],
      attachments: {
        [audioId]: {
          type: "audio",
          url: clipUrl,
          trimStartMs: 5000,
        },
      },
      audioTimings: {
        [audioId]: alignChunks([
          { text: "Hello", start: 0.1, end: 0.5 },
          { text: "world", start: 0.6, end: 1 },
        ], "Hello world."),
      },
    }]

    const commitSpy = vi.fn(async () => ({
      fileId: "new-content",
      trackId: "new-track",
      cellCount: 1,
    }))

    createTimelineTextTrackImporter.mockReturnValue(commitSpy)

    const onSaved = vi.fn()
      .mockRejectedValueOnce(new Error("Refresh failed"))
      .mockResolvedValue(undefined)
    const onCancel = vi.fn()
    const getToken = vi.fn(async () => "token")

    render(
      <AlignTimelineScriptDialog
        projectId="p1"
        fileId="file-9"
        mediaName="clip.mp3"
        clipUrl={clipUrl}
        language="en"
        durationMs={10000}
        canEditTracks={true}
        tracks={[]}
        cells={cells}
        getToken={getToken}
        onSaved={onSaved}
        onCancel={onCancel}
      />
    )

    fireEvent.change(screen.getByLabelText("Script"), {
      target: { value: "Hello world." },
    })
    fireEvent.click(screen.getByRole("button", { name: "Align script" }))

    await screen.findByLabelText("Segment 1 wording")
    expect(screen.getByLabelText("Segment 1 start (seconds)")).toHaveValue(5.1)
    expect(screen.getByLabelText("Segment 1 end (seconds)")).toHaveValue(6)
    expect(screen.getByLabelText("Destination track")).toHaveValue("$new-track")

    fireEvent.click(screen.getByRole("button", { name: "Use aligned segments" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Refresh failed")

    fireEvent.click(screen.getByRole("button", { name: "Use aligned segments" }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2))

    expect(createTimelineTextTrackImporter).toHaveBeenCalledTimes(1)
    expect(commitSpy).toHaveBeenCalledTimes(1)

    const importerCall = createTimelineTextTrackImporter.mock.calls[0][0]
    expect(importerCall).toMatchObject({
      projectId: "p1",
      anchorFileId: "file-9",
    })

    expect(importerCall.source.artifact.name).toBe("Aligned script.txt")
    expect(importerCall.source.artifact.format).toBe("txt")
    expect(importerCall.source.artifact.bytes).toEqual(
      new TextEncoder().encode("Hello world.").buffer
    )
    expect(importerCall.source.cues).toHaveLength(1)
    expect(importerCall.source.cues[0]).toMatchObject({
      original: "Hello world.",
      start: 5.1,
      end: 6,
    })
  })
})
