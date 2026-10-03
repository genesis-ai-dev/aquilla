/**
 * use-transcript-select-all tests (AQU-1652) — Cmd/Ctrl+A inside the chat must
 * select the transcript and nothing else, and must leave the shortcut alone
 * everywhere it already belongs (the composer, the page outside the chat).
 */

import { useRef } from "react"
import { describe, expect, it } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { useTranscriptSelectAll } from "./use-transcript-select-all"

function Harness() {
  const ref = useRef<HTMLDivElement>(null)
  useTranscriptSelectAll(ref)
  return (
    <div>
      <div ref={ref} data-testid="transcript">
        <p>Here is a draft.</p>
        <button type="button">Expand</button>
      </div>
      <textarea aria-label="composer" defaultValue="unsent draft" />
      <p data-testid="outside">Workspace chrome</p>
    </div>
  )
}

function selectAll(target: Element, init: Partial<KeyboardEventInit> = {}) {
  return fireEvent.keyDown(target, { key: "a", metaKey: true, ...init })
}

function selectedRoot(): Node | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  return selection.getRangeAt(0).commonAncestorContainer
}

describe("useTranscriptSelectAll", () => {
  it("selects the transcript when the key lands on a node inside it", () => {
    render(<Harness />)
    const transcript = screen.getByTestId("transcript")
    const notDefaultPrevented = selectAll(screen.getByRole("button", { name: "Expand" }))
    expect(notDefaultPrevented).toBe(false) // preventDefault() was called
    expect(selectedRoot()).toBe(transcript)
    expect(window.getSelection()?.toString()).toContain("Here is a draft.")
  })

  it("selects the transcript when the reader has only clicked message text", () => {
    render(<Harness />)
    const transcript = screen.getByTestId("transcript")
    const selection = window.getSelection()!
    const clicked = document.createRange()
    clicked.selectNodeContents(transcript.querySelector("p")!)
    selection.removeAllRanges()
    selection.addRange(clicked)

    selectAll(document.body)
    expect(selectedRoot()).toBe(transcript)
  })

  it("leaves the browser's Select All alone in the composer", () => {
    render(<Harness />)
    const composer = screen.getByLabelText("composer")
    expect(selectAll(composer)).toBe(true) // default not prevented
    expect(selectedRoot()).not.toBe(screen.getByTestId("transcript"))
  })

  it("ignores a plain 'a' and Alt+Cmd+A, and keys outside the chat", () => {
    render(<Harness />)
    const transcript = screen.getByTestId("transcript")
    expect(fireEvent.keyDown(transcript, { key: "a" })).toBe(true)
    expect(selectAll(transcript, { altKey: true })).toBe(true)
    expect(selectAll(screen.getByTestId("outside"))).toBe(true)
    expect(selectedRoot()).not.toBe(transcript)
  })
})
