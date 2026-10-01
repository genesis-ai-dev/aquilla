import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { extractSrtStrings } from "@/lib/parsers/subtitle"
import { ImportTimelineTextDialog } from "./ImportTimelineTextDialog"

const text = "1\n00:00:00,500 --> 00:00:01,500\nSupplied wording"
const bytes = new TextEncoder().encode(text).buffer
vi.mock("@/lib/import", () => ({ prepareImportFile: vi.fn(async () => ({
  fileType: "srt", results: [{ strings: extractSrtStrings(text), rawBytes: bytes }],
})) }))
const tracks = [{ id: "source-subtitles", name: "Existing text",
  contentFileId: undefined, segmentCount: 4 }]
async function choose() {
  fireEvent.change(screen.getByLabelText("Caption file"), { target: {
    files: [new File([text], "captions.srt", { type: "text/plain" })],
  } })
  await screen.findByLabelText("Segment 1 wording")
}

describe("attaching a caption track", () => {
  it("defaults to a new track and commits reviewed wording with original bytes", async () => {
    const confirm = vi.fn(async () => {})
    render(<ImportTimelineTextDialog projectId="p" mediaName="Film" tracks={tracks}
      onConfirm={confirm} onCancel={() => {}} />)
    await choose()
    expect(screen.getByLabelText("Destination track")).toHaveValue("$new-track")
    fireEvent.change(screen.getByLabelText("Segment 1 wording"), { target: { value: "Reviewed wording" } })
    fireEvent.click(screen.getByRole("button", { name: "Add caption track" }))
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      name: "captions", trackId: undefined, overwrite: undefined,
      source: expect.objectContaining({ artifact: { name: "captions.srt", format: "srt", bytes },
        cues: [expect.objectContaining({ original: "Reviewed wording" })] }),
    })))
  })

  it("requires explicit confirmation showing the existing segment count", async () => {
    const confirm = vi.fn(async () => {})
    render(<ImportTimelineTextDialog projectId="p" mediaName="Film" tracks={tracks}
      onConfirm={confirm} onCancel={() => {}} />)
    await choose()
    fireEvent.change(screen.getByLabelText("Destination track"), { target: { value: "source-subtitles" } })
    expect(screen.getByText("4 segments currently in this track will be overwritten.")).toBeInTheDocument()
    const submit = screen.getByRole("button", { name: "Overwrite caption track" })
    expect(submit).toBeDisabled()
    fireEvent.click(screen.getByRole("checkbox", { name: "Overwrite the existing content in this track" }))
    fireEvent.click(submit)
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      trackId: "source-subtitles", overwrite: { contentFileId: null, segmentCount: 4 },
    })))
  })

  it("keeps the reviewed captions available when saving fails", async () => {
    const cancel = vi.fn()
    render(<ImportTimelineTextDialog projectId="p" mediaName="Film" tracks={tracks}
      onConfirm={async () => { throw new Error("Track changed after preview") }} onCancel={cancel} />)
    await choose()
    fireEvent.click(screen.getByRole("button", { name: "Add caption track" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Track changed after preview")
    expect(cancel).not.toHaveBeenCalled()
    expect(screen.getByLabelText("Segment 1 wording")).toHaveValue("Supplied wording")
  })

  it("requires fresh overwrite consent when the selected track changes", async () => {
    const props = { projectId: "p", mediaName: "Film", tracks,
      onConfirm: vi.fn(async () => {}), onCancel: () => {} }
    const { rerender } = render(<ImportTimelineTextDialog {...props} />)
    await choose()
    fireEvent.change(screen.getByLabelText("Destination track"), { target: { value: "source-subtitles" } })
    fireEvent.click(screen.getByRole("checkbox", { name: "Overwrite the existing content in this track" }))
    expect(screen.getByRole("button", { name: "Overwrite caption track" })).toBeEnabled()
    rerender(<ImportTimelineTextDialog {...props} tracks={[{ ...tracks[0], segmentCount: 5 }]} />)
    expect(screen.getByRole("button", { name: "Overwrite caption track" })).toBeDisabled()
    expect(screen.getByRole("checkbox")).not.toBeChecked()
  })
})
