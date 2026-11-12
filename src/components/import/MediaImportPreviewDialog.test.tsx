import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { MediaImportPreviewDialog } from "./MediaImportPreviewDialog"
import { extractSrtStrings, extractVttStrings } from "@/lib/parsers/subtitle"

describe("media import preview", () => {
  it("lets you review and edit wording and timing before committing", () => {
    const onConfirm = vi.fn()
    const source = {
      cues: extractSrtStrings("1\n00:00:00,500 --> 00:00:01,500\nOriginal wording"),
      artifact: { name: "clip.srt", format: "srt" as const, bytes: new ArrayBuffer(1) },
    }
    render(<MediaImportPreviewDialog
      mediaName="clip.mp3"
      sources={[{ id: "sidecar", label: "clip.srt", source }]}
      onConfirm={onConfirm} onCancel={() => {}}
    />)
    expect(screen.getByRole("listitem")).toHaveTextContent("Original wording")
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Edit caption 1" }))
    expect(screen.getByRole("textbox", { name: "Caption 1 wording" })).toHaveValue("Original wording")
    fireEvent.change(screen.getByRole("textbox", { name: "Caption 1 wording" }), {
      target: { value: "Edited wording" },
    })
    expect(screen.getByRole("textbox", { name: "Caption 1 end" })).toHaveValue("00:01.500")
    fireEvent.change(screen.getByRole("textbox", { name: "Caption 1 end" }), {
      target: { value: "1.8" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Continue import" }))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      artifact: source.artifact,
      cues: [expect.objectContaining({ original: "Edited wording", start: 0.5, end: 1.8 })],
    }))
    expect(source.cues[0].original).toBe("Original wording")
  })

  it("flags sub-millisecond headings and lets you fix their timing", () => {
    const onConfirm = vi.fn()
    const [cue] = extractSrtStrings("1\n00:00:01,000 --> 00:00:01,001\nHeading")
    render(<MediaImportPreviewDialog mediaName="clip.m4a"
      sources={[{ id: "embedded", label: "Embedded English", source: {
        cues: [{ ...cue, end: 1.000001, metadata: { alignmentConfidence: 0.2 } }],
      } }]}
      onConfirm={onConfirm} onCancel={() => {}} />)
    expect(screen.getByRole("button", { name: "Continue import" })).toBeDisabled()
    expect(screen.getByRole("alert")).toHaveTextContent("This caption is shorter than the timeline's millisecond precision.")
    expect(screen.getByRole("status")).toHaveTextContent("1 caption · 0:01–0:01 · 1 needs attention")
    expect(screen.getByText("Alignment confidence: 20%")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Edit caption 1" }))
    // Typed the way the list reads it.
    fireEvent.change(screen.getByRole("textbox", { name: "Caption 1 end" }), {
      target: { value: "0:01.5" },
    })
    expect(screen.getByRole("button", { name: "Continue import" })).toBeEnabled()
    fireEvent.click(screen.getByRole("button", { name: "Continue import" }))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      cues: [expect.objectContaining({ start: 1, end: 1.5 })],
    }))
  })

  it("keeps the import disabled while a typed time is unreadable", () => {
    render(<MediaImportPreviewDialog mediaName="clip.mp3"
      sources={[{ id: "captions", label: "clip.srt", source: {
        cues: extractSrtStrings("1\n00:00:00,000 --> 00:00:01,000\nCaptions"),
      } }]}
      onConfirm={() => {}} onCancel={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit caption 1" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Caption 1 start" }), { target: { value: "soon" } })
    expect(screen.getByRole("button", { name: "Continue import" })).toBeDisabled()
    expect(screen.getByRole("alert")).toHaveTextContent("needs valid start and end times")
    expect(screen.getByRole("textbox", { name: "Caption 1 start" })).toHaveValue("soon")
  })

  it("allows an explicit choice to transcribe instead of using supplied wording", () => {
    const onConfirm = vi.fn()
    render(<MediaImportPreviewDialog mediaName="clip.mp3"
      sources={[{ id: "captions", label: "clip.srt", source: {
        cues: extractSrtStrings("1\n00:00:00,000 --> 00:00:01,000\nCaptions"),
      } }]}
      onConfirm={onConfirm} onCancel={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Transcribe audio" }))
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Continue import" }))
    expect(onConfirm).toHaveBeenCalledWith(undefined)
  })

  it("requires a remaining segment after removing the last cue", () => {
    render(<MediaImportPreviewDialog mediaName="clip.mp3"
      sources={[{ id: "captions", label: "clip.srt", source: {
        cues: extractSrtStrings("1\n00:00:00,000 --> 00:00:01,000\nCaptions"),
      } }]}
      onConfirm={() => {}} onCancel={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Remove caption 1" }))
    expect(screen.getByRole("button", { name: "Continue import" })).toBeDisabled()
    expect(screen.getByRole("alert")).toHaveTextContent("at least one segment")
  })

  // Sam's D2 (2026-10-05): one line per caption, so 300 captions stay usable.
  it("shows each caption as one line with a readable time range, and a summary", () => {
    // 00:00:02.712 parses to 2.7119999999999997, which the old seconds field
    // printed verbatim.
    const cues = extractVttStrings("WEBVTT\n\n00:00:01.000 --> 00:00:02.712\nOne\n\n" +
      "00:00:02.712 --> 00:00:04.000\nTwo\n\n00:00:20.000 --> 00:00:24.000\nThree\n")
    expect(cues[1].start).not.toBe(2.712)
    render(<MediaImportPreviewDialog mediaName="clip.mp3"
      sources={[{ id: "captions", label: "clip.vtt", source: { cues } }]}
      onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByRole("status")).toHaveTextContent("3 captions · 0:01–0:24")
    const lines = within(screen.getByRole("list", { name: "Captions to import" })).getAllByRole("listitem")
    expect(lines.map(line => line.textContent)).toEqual([
      expect.stringContaining("0:01 – 0:02.7One"),
      expect.stringContaining("0:02.7 – 0:04Two"),
      expect.stringContaining("0:20 – 0:24Three"),
    ])
    // Nothing is open at rest: no text boxes until a line is opened.
    expect(screen.queryAllByRole("textbox")).toHaveLength(0)
    expect(document.body.textContent).not.toContain("2.7119999999999997")
  })

  it("opens one line at a time, by its pencil or a click on its wording, and keeps edits after a removal", () => {
    const onConfirm = vi.fn()
    const cues = extractSrtStrings("1\n00:00:00,000 --> 00:00:01,000\nFirst\n\n" +
      "2\n00:00:01,000 --> 00:00:02,000\nSecond\n\n3\n00:00:02,000 --> 00:00:03,000\nThird")
    render(<MediaImportPreviewDialog mediaName="clip.mp3"
      sources={[{ id: "captions", label: "clip.srt", source: { cues } }]}
      onConfirm={onConfirm} onCancel={() => {}} />)
    fireEvent.click(screen.getByText("Third"))
    expect(screen.getByRole("textbox", { name: "Caption 3 wording" })).toHaveFocus()
    fireEvent.click(screen.getByRole("button", { name: "Edit caption 2" }))
    expect(screen.queryByRole("textbox", { name: "Caption 3 wording" })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole("textbox", { name: "Caption 2 wording" }), { target: { value: "Second, edited" } })
    // Removing a line above the open one keeps the same caption open.
    fireEvent.click(screen.getByRole("button", { name: "Remove caption 1" }))
    expect(screen.getByRole("textbox", { name: "Caption 1 wording" })).toHaveValue("Second, edited")
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(screen.queryAllByRole("textbox")).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: "Continue import" }))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ cues: [
      expect.objectContaining({ original: "Second, edited", start: 1, end: 2 }),
      expect.objectContaining({ original: "Third", start: 2, end: 3 }),
    ] }))
  })

  // Walk r3 (2026-10-05): the caret sat at 0, so " (edited)" typed after the
  // wording landed in front of it.
  it("opens a line with the caret at the end of its wording, or where the wording was clicked", () => {
    const cues = extractSrtStrings("1\n00:00:00,000 --> 00:00:01,000\nThe boat left at dawn.\n\n" +
      "2\n00:00:01,000 --> 00:00:02,000\nSecond")
    render(<MediaImportPreviewDialog mediaName="clip.mp3"
      sources={[{ id: "captions", label: "clip.srt", source: { cues } }]}
      onConfirm={() => {}} onCancel={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit caption 1" }))
    const first = screen.getByRole("textbox", { name: "Caption 1 wording" }) as HTMLTextAreaElement
    expect(first).toHaveFocus()
    expect([first.selectionStart, first.selectionEnd]).toEqual([22, 22])

    // A click on the wording puts the caret where it landed.
    const wording = screen.getByText("Second")
    const doc = document as unknown as { caretRangeFromPoint?: unknown }
    const original = doc.caretRangeFromPoint
    doc.caretRangeFromPoint = () => ({ startContainer: wording.firstChild, startOffset: 3 })
    try {
      fireEvent.click(wording, { clientX: 40, clientY: 10 })
    } finally {
      doc.caretRangeFromPoint = original
    }
    const second = screen.getByRole("textbox", { name: "Caption 2 wording" }) as HTMLTextAreaElement
    expect(second).toHaveFocus()
    expect([second.selectionStart, second.selectionEnd]).toEqual([3, 3])
  })

  // Walk r3 (2026-10-05): Escape on an open line closed the whole review and
  // threw every edit away.
  it("closes only the open line on Escape, and keeps the review open once anything changed", () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    const cues = extractSrtStrings("1\n00:00:00,000 --> 00:00:01,000\nFirst\n\n" +
      "2\n00:00:01,000 --> 00:00:02,000\nSecond")
    render(<MediaImportPreviewDialog mediaName="clip.mp3"
      sources={[{ id: "captions", label: "clip.srt", source: { cues } }]}
      onConfirm={onConfirm} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit caption 1" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Caption 1 wording" }), { target: { value: "First, edited" } })
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Caption 1 wording" }), { key: "Escape" })
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.queryAllByRole("textbox")).toHaveLength(0)
    expect(screen.getByRole("button", { name: "Edit caption 1" })).toHaveFocus()

    // Nothing open, but an edit is held: Escape leaves the review alone.
    fireEvent.keyDown(screen.getByRole("button", { name: "Edit caption 1" }), { key: "Escape" })
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole("dialog")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Continue import" }))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ cues: [
      expect.objectContaining({ original: "First, edited" }),
      expect.objectContaining({ original: "Second" }),
    ] }))
    // Cancel still discards on purpose.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("still closes on Escape when nothing has been changed", () => {
    const onCancel = vi.fn()
    render(<MediaImportPreviewDialog mediaName="clip.mp3"
      sources={[{ id: "captions", label: "clip.srt", source: {
        cues: extractSrtStrings("1\n00:00:00,000 --> 00:00:01,000\nFirst"),
      } }]}
      onConfirm={() => {}} onCancel={onCancel} />)
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it("renders hundreds of captions as plain lines", () => {
    const vtt = "WEBVTT\n\n" + Array.from({ length: 300 }, (_, i) =>
      `00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000 --> ` +
      `00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.900\nLine ${i + 1}`,
    ).join("\n\n")
    render(<MediaImportPreviewDialog mediaName="clip.mp3"
      sources={[{ id: "captions", label: "clip.vtt", source: { cues: extractVttStrings(vtt) } }]}
      onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getAllByTestId("media-preview-row")).toHaveLength(300)
    expect(screen.queryAllByRole("textbox")).toHaveLength(0)
    expect(screen.queryAllByRole("spinbutton")).toHaveLength(0)
    expect(screen.getByRole("status")).toHaveTextContent("300 captions · 0:00–4:59.9")
  })
})
