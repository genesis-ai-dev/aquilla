import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { alignScriptParagraphs } from "@/lib/audio/script-alignment"
import { ScriptAlignmentDialog, type ScriptAlignmentConfirmation } from "./ScriptAlignmentDialog"

describe("script alignment review", () => {
  it.each([
    {
      name: "oversized file",
      bytes: new Uint8Array(800001),
      shouldCallArrayBuffer: false,
    },
    {
      name: "invalid UTF8 file",
      bytes: new Uint8Array([195, 40]),
      shouldCallArrayBuffer: true,
    },
  ])("rejects $name and keeps script intact", async ({ bytes, shouldCallArrayBuffer }) => {
    const confirm = vi.fn<(input: ScriptAlignmentConfirmation) => Promise<void>>(async () => {})
    const align = vi.fn(async () => ({ method: "ctc-forced-alignment" as const, segments: [] }))
    const file = new File([bytes], "script.txt", { type: "text/plain" })
    const arrayBufferSpy = vi.fn(async () => bytes.buffer)

    Object.defineProperty(file, "arrayBuffer", {
      value: arrayBufferSpy,
      configurable: true,
    })

    render(<ScriptAlignmentDialog mediaName="Film" align={align} onConfirm={confirm} onCancel={() => {}} />)

    fireEvent.change(screen.getByLabelText("Script"), { target: { value: "Existing wording." } })
    const fileInput = screen.getByLabelText("Script file") as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [file] } })

    expect(await screen.findByRole("alert")).toBeVisible()

    expect(screen.getByLabelText("Script")).toHaveValue("Existing wording.")
    expect(align).not.toHaveBeenCalled()

    if (shouldCallArrayBuffer) {
      expect(arrayBufferSpy).toHaveBeenCalledOnce()
    } else {
      expect(arrayBufferSpy).not.toHaveBeenCalled()
    }
  })
  it("uploads a BOM-prefixed UTF-8 plain text File and aligns with original script", async () => {
    const confirm = vi.fn<(input: ScriptAlignmentConfirmation) => Promise<void>>(async () => {})
    const scriptContent = "Hello.\r\n\r\nAgain."
    const utf8Bytes = new TextEncoder().encode(scriptContent)
    const bomBytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8Bytes])
    const file = new File([bomBytes], "script.txt", { type: "text/plain" })

    Object.defineProperty(file, "arrayBuffer", {
      value: async () => bomBytes.buffer.slice(bomBytes.byteOffset, bomBytes.byteOffset + bomBytes.byteLength),
      configurable: true,
    })

    const align = async (text: string) => alignScriptParagraphs(text, [
      { text: "Hello", start: 1, end: 2 },
      { text: "Again", start: 3, end: 4 },
    ])

    render(<ScriptAlignmentDialog mediaName="Film" align={align} onConfirm={confirm} onCancel={() => {}} />)

    const fileInput = screen.getByLabelText("Script file") as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => {
      expect(screen.getByLabelText("Script")).toHaveValue("Hello.\n\nAgain.")
    })

    fireEvent.click(screen.getByRole("button", { name: "Align script" }))

    await screen.findByLabelText("Segment 1 wording")
    expect(screen.getByLabelText("Segment 1 wording")).toHaveValue("Hello.")
    expect(screen.getByLabelText("Segment 2 wording")).toHaveValue("Again.")

    fireEvent.change(screen.getByLabelText("Segment 1 wording"), {
      target: { value: "Reviewed" },
    })

    fireEvent.click(screen.getByRole("button", { name: "Use aligned segments" }))

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))

    const callArg = confirm.mock.calls[0][0]
    expect(callArg.scriptArtifact?.name).toBe("script.txt")
    expect(callArg.script).toBe("Hello.\n\nAgain.")
    expect(callArg.cues[0]).toMatchObject({ original: "Reviewed" })
    expect(callArg.cues[1]).toMatchObject({ original: "Again." })

    expect(callArg.scriptArtifact?.bytes).toEqual(bomBytes.buffer)
  })
  it("creates a new track by default and requires counted consent for overwrite", async () => {
    const confirm = vi.fn<(input: ScriptAlignmentConfirmation) => Promise<void>>(async () => {})
    const tracks = [{ id: "existing", name: "Original captions",
      contentFileId: "content", segmentCount: 8 }]
    const align = async (text: string) => alignScriptParagraphs(text, [
      { text: "Hello", start: 1, end: 2 },
    ])
    const { rerender } = render(<ScriptAlignmentDialog mediaName="Film"
      tracks={tracks} align={align} onConfirm={confirm} onCancel={() => {}} />)
    fireEvent.change(screen.getByLabelText("Script"), { target: { value: "Hello." } })
    fireEvent.click(screen.getByRole("button", { name: "Align script" }))
    await screen.findByLabelText("Segment 1 wording")
    expect(screen.getByLabelText("Destination track")).toHaveValue("$new-track")
    const save = screen.getByRole("button", { name: "Use aligned segments" })
    expect(save).toBeEnabled()
    fireEvent.change(screen.getByLabelText("Destination track"), {
      target: { value: "existing" },
    })
    expect(save).toBeDisabled()
    fireEvent.click(screen.getByRole("checkbox", {
      name: "8 segments currently in this track will be overwritten.",
    }))
    expect(save).toBeEnabled()
    rerender(<ScriptAlignmentDialog mediaName="Film" tracks={[
      { ...tracks[0], segmentCount: 9 },
    ]} align={align} onConfirm={confirm} onCancel={() => {}} />)
    expect(save).toBeDisabled()
    fireEvent.click(screen.getByRole("checkbox", {
      name: "9 segments currently in this track will be overwritten.",
    }))
    fireEvent.click(save)
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(confirm.mock.calls[0][0]).toMatchObject({ trackId: "existing",
      overwrite: { contentFileId: "content", segmentCount: 9 } })
  })

  it("labels acoustic scores separately from word-match coverage", async () => {
    render(<ScriptAlignmentDialog mediaName="Film" onCancel={() => {}}
      onConfirm={async () => {}} align={async () => ({ method: "ctc-forced-alignment",
        segments: [{ text: "Known words.", start: 1, end: 2,
          confidence: 0.8, matchedWords: 2, totalWords: 2,
          needsReview: true, status: "partial" }],
      })} />)
    fireEvent.change(screen.getByLabelText("Script"), { target: { value: "Known words." } })
    fireEvent.click(screen.getByRole("button", { name: "Align script" }))
    expect(await screen.findByText("Initial acoustic match: 80%")).toBeVisible()
    expect(screen.queryByText("Initial word match: 80%")).toBeNull()
  })
  it("previews the edited range before applying it", async () => {
    const preview = vi.fn()
    render(<ScriptAlignmentDialog mediaName="Film" onCancel={() => {}}
      onConfirm={async () => {}} onPreviewRange={preview}
      align={async text => alignScriptParagraphs(text, [
        { text: "Hello", start: 1, end: 2 },
      ])} />)
    fireEvent.change(screen.getByLabelText("Script"), { target: { value: "Hello." } })
    fireEvent.click(screen.getByRole("button", { name: "Align script" }))
    await screen.findByLabelText("Segment 1 wording")
    fireEvent.change(screen.getByLabelText("Segment 1 end (seconds)"), {
      target: { value: "2.5" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Listen to segment 1" }))
    expect(preview).toHaveBeenCalledWith(1, 2.5)
  })
  it("requires missing boundaries and explicit review before accepting a segment", async () => {
    const confirm = vi.fn<(input: ScriptAlignmentConfirmation) => Promise<void>>(async () => {})
    render(<ScriptAlignmentDialog mediaName="Film" durationMs={3000}
      onCancel={() => {}} onConfirm={confirm}
      align={async text => alignScriptParagraphs(text, [])} />)
    fireEvent.change(screen.getByLabelText("Script"), { target: { value: "Unspoken." } })
    fireEvent.click(screen.getByRole("button", { name: "Align script" }))
    const start = await screen.findByLabelText("Segment 1 start (seconds)")
    expect(start).toHaveValue(null)
    const save = screen.getByRole("button", { name: "Use aligned segments" })
    expect(save).toBeDisabled()
    expect(screen.getByText("Initial word match: 0%")).toBeVisible()
    fireEvent.change(start, { target: { value: "1" } })
    fireEvent.change(screen.getByLabelText("Segment 1 end (seconds)"), {
      target: { value: "4" },
    })
    fireEvent.click(screen.getByRole("checkbox", { name: "I reviewed segment 1" }))
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByLabelText("Segment 1 end (seconds)"), {
      target: { value: "2" },
    })
    expect(save).toBeDisabled()
    expect(screen.getByRole("checkbox")).not.toBeChecked()
    fireEvent.click(screen.getByRole("checkbox", { name: "I reviewed segment 1" }))
    expect(save).toBeEnabled()
    fireEvent.click(save)
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(confirm.mock.calls[0][0].cues[0]).toMatchObject({
      start: 1, end: 2, original: "Unspoken.",
      metadata: { alignmentReviewConfirmed: true, alignmentManuallyEdited: true },
    })
  })
  it("keeps reviewed wording and timing when saving fails", async () => {
    const cancel = vi.fn()
    render(<ScriptAlignmentDialog mediaName="Film" onCancel={cancel}
      onConfirm={async () => { throw new Error("Publication failed") }}
      align={async text => alignScriptParagraphs(text, [
        { text: "Hello", start: 1, end: 2 },
      ])} />)
    fireEvent.change(screen.getByLabelText("Script"), { target: { value: "Hello." } })
    fireEvent.click(screen.getByRole("button", { name: "Align script" }))
    const wording = await screen.findByLabelText("Segment 1 wording")
    fireEvent.change(wording, { target: { value: "Reviewed." } })
    fireEvent.click(screen.getByRole("button", { name: "Use aligned segments" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Publication failed")
    expect(wording).toHaveValue("Reviewed.")
    expect(screen.getByLabelText("Segment 1 start (seconds)")).toHaveValue(1)
    expect(cancel).not.toHaveBeenCalled()
  })
  it("uses paragraphs and commits reviewed cues with the original script", async () => {
    const script = "Hello world.\n\nNext paragraph."
    const confirm = vi.fn<(input: ScriptAlignmentConfirmation) => Promise<void>>(async () => {})
    render(<ScriptAlignmentDialog mediaName="Film" onCancel={() => {}}
      onConfirm={confirm} align={async text => alignScriptParagraphs(text, [
        { text: "Hello", start: 1, end: 1.4 },
        { text: "world", start: 1.5, end: 2 },
        { text: "Next", start: 3, end: 3.5 },
        { text: "paragraph", start: 3.6, end: 4 },
      ])} />)
    fireEvent.change(screen.getByLabelText("Script"), { target: { value: script } })
    fireEvent.click(screen.getByRole("button", { name: "Align script" }))
    expect(await screen.findByLabelText("Segment 1 wording")).toHaveValue("Hello world.")
    expect(screen.getByLabelText("Segment 2 start (seconds)")).toHaveValue(3)
    fireEvent.change(screen.getByLabelText("Segment 1 wording"), {
      target: { value: "Reviewed wording" },
    })
    fireEvent.change(screen.getByLabelText("Segment 1 end (seconds)"), {
      target: { value: "2.25" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Use aligned segments" }))
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(confirm.mock.calls[0][0]).toMatchObject({
      script, cues: [
        { original: "Reviewed wording", start: 1, end: 2.25,
          metadata: { alignmentConfidence: 1, alignmentMethod: "whisper-word-match" } },
        { original: "Next paragraph.", start: 3, end: 4 },
      ],
    })
  })
})
