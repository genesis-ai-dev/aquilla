// Canvas board 55, option E, in every view's bar (Sam, Oct 28): the views are
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
  it("only the open view keeps its label; the others are named on hover", async () => {
    renderWithTooltips(<EditorModeToggle lens="audio" onChange={vi.fn()} timeOrdered onAgentSelect={vi.fn()} />)
    expect(screen.getByRole("tab", { name: "Media" })).toHaveTextContent("Media")
    for (const name of ["Text", "Transcribe", "Agent"]) {
      expect(screen.getByRole("tab", { name }).textContent, name).toBe("")
    }
    await expectTooltip(screen.getByRole("tab", { name: "Transcribe" }), /^Transcribe$/)
  })

  it("leaves 2 px between the views (Sam, Oct 28)", () => {
    renderWithTooltips(<EditorModeToggle lens="text" onChange={vi.fn()} timeOrdered onAgentSelect={vi.fn()} />)
    expect(screen.getByRole("tablist").className).toContain("gap-0.5")
  })

  it("the same in the Text, Transcribe and Agent views", () => {
    const { rerender } = renderWithTooltips(<EditorModeToggle lens="text" onChange={vi.fn()} timeOrdered onAgentSelect={vi.fn()} />)
    const labelled = () => screen.getAllByRole("tab").filter((tab) => tab.textContent !== "").map((tab) => tab.textContent)
    expect(labelled()).toEqual(["Text"])
    rerender(<EditorModeToggle lens="transcribe" onChange={vi.fn()} timeOrdered onAgentSelect={vi.fn()} />)
    expect(labelled()).toEqual(["Transcribe"])
    rerender(<EditorModeToggle lens="text" onChange={vi.fn()} timeOrdered agentActive />)
    expect(labelled()).toEqual(["Agent"])
  })
})
