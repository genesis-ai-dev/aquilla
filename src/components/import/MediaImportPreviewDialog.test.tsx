import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { MediaImportPreviewDialog } from "./MediaImportPreviewDialog"
import { extractSrtStrings } from "@/lib/parsers/subtitle"

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
    expect(screen.getByRole("textbox", { name: "Segment 1 wording" }))
      .toHaveValue("Original wording")
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole("textbox", { name: "Segment 1 wording" }), {
      target: { value: "Edited wording" },
    })
    fireEvent.change(screen.getByRole("spinbutton", { name: "Segment 1 end (seconds)" }), {
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
    expect(screen.getByRole("alert")).toHaveTextContent("millisecond precision")
    expect(screen.getByText("Alignment confidence: 20%")).toBeInTheDocument()
    fireEvent.change(screen.getByRole("spinbutton", { name: "Segment 1 end (seconds)" }), {
      target: { value: "1.5" },
    })
    expect(screen.getByRole("button", { name: "Continue import" })).toBeEnabled()
    fireEvent.click(screen.getByRole("button", { name: "Continue import" }))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      cues: [expect.objectContaining({ start: 1, end: 1.5 })],
    }))
  })

  it("allows an explicit choice to transcribe instead of using supplied wording", () => {
    const onConfirm = vi.fn()
    render(<MediaImportPreviewDialog mediaName="clip.mp3"
      sources={[{ id: "captions", label: "clip.srt", source: {
        cues: extractSrtStrings("1\n00:00:00,000 --> 00:00:01,000\nCaptions"),
      } }]}
      onConfirm={onConfirm} onCancel={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Transcribe audio" }))
    expect(screen.queryByRole("textbox", { name: "Segment 1 wording" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Continue import" }))
    expect(onConfirm).toHaveBeenCalledWith(undefined)
  })

  it("requires a remaining segment after removing the last cue", () => {
    render(<MediaImportPreviewDialog mediaName="clip.mp3"
      sources={[{ id: "captions", label: "clip.srt", source: {
        cues: extractSrtStrings("1\n00:00:00,000 --> 00:00:01,000\nCaptions"),
      } }]}
      onConfirm={() => {}} onCancel={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Remove segment 1" }))
    expect(screen.getByRole("button", { name: "Continue import" })).toBeDisabled()
    expect(screen.getByRole("alert")).toHaveTextContent("at least one segment")
  })
})
