// Canvas board 55, option E: in the media view's top bar the views are
// icons, the open one keeping its label, the others named on hover.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import { EditorModeToggle } from "./EditorModeToggle"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"

const realMatchMedia = window.matchMedia
beforeEach(() => {
  // Wide enough for labels (md and up).
  window.matchMedia = ((query: string) => ({
    matches: true, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})
afterEach(() => { window.matchMedia = realMatchMedia })

describe("EditorModeToggle", () => {
  it("labels every view by default", () => {
    renderWithTooltips(<EditorModeToggle lens="audio" onChange={vi.fn()} timeOrdered onAgentSelect={vi.fn()} />)
    expect(screen.getByRole("tab", { name: "Text" })).toHaveTextContent("Text")
    expect(screen.getByRole("tab", { name: "Media" })).toHaveTextContent("Media")
  })

  it("with labels='active', only the open view keeps its label; the others are named on hover", async () => {
    renderWithTooltips(<EditorModeToggle lens="audio" onChange={vi.fn()} timeOrdered onAgentSelect={vi.fn()} labels="active" />)
    expect(screen.getByRole("tab", { name: "Media" })).toHaveTextContent("Media")
    for (const name of ["Text", "Transcribe", "Agent"]) {
      expect(screen.getByRole("tab", { name }).textContent, name).toBe("")
    }
    await expectTooltip(screen.getByRole("tab", { name: "Transcribe" }), /^Transcribe$/)
  })
})
