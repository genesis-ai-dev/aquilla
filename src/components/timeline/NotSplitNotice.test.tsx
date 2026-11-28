// AQU-2426, board 58 part 2: everyone sees "Not split into lines yet"; the
// buttons show only to people who can split lines; Transcribe… is greyed with
// a click (i) for those who may not transcribe, and Split at pauses stays.

import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { NotSplitNoticeText } from "./NotSplitNotice"

describe("Not split into lines yet (AQU-2426)", () => {
  it("offers Transcribe… and Split at pauses to someone who can split", () => {
    const onTranscribe = vi.fn()
    const onSplitAtPauses = vi.fn()
    render(<NotSplitNoticeText canSplit block={null} onTranscribe={onTranscribe} onSplitAtPauses={onSplitAtPauses} />)
    fireEvent.click(screen.getByRole("button", { name: "Transcribe…" }))
    fireEvent.click(screen.getByRole("button", { name: "Split at pauses" }))
    expect(onTranscribe).toHaveBeenCalledOnce()
    expect(onSplitAtPauses).toHaveBeenCalledOnce()
  })

  it("shows only the words to someone who can't split lines", () => {
    render(<NotSplitNoticeText canSplit={false} block={null} onTranscribe={vi.fn()} onSplitAtPauses={vi.fn()} />)
    expect(screen.getByText("Not split into lines yet")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("greys Transcribe… with its reason behind a click; Split at pauses stays free", () => {
    render(<NotSplitNoticeText canSplit block={{ kind: "creditsToday" }} onTranscribe={vi.fn()} onSplitAtPauses={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Transcribe…" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Split at pauses" })).toBeEnabled()
    fireEvent.click(screen.getByRole("button", { name: "Why you can't transcribe here" }))
    expect(screen.getByText(/today's AI limit.*Split at pauses is free/)).toBeVisible()
  })
})
