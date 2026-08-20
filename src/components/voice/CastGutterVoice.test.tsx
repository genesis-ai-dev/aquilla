import { describe, it, expect, vi } from "vitest"
import { screen, fireEvent } from "@testing-library/react"
import { renderWithTooltips } from "@/test-utils/tooltip"
import { CastGutterVoice } from "./CastGutterVoice"
import type { Voice } from "@/lib/parsers/types"

const mary: Voice = { id: "v-mary", name: "Mary", color: "#dd4444" }
const john: Voice = { id: "v-john", name: "John", color: "#4444dd" }
const narrator: Voice = { id: "preset-narrator", name: "Narrator", color: "#475569", builtIn: true }
const VOICES = [narrator, mary, john]

const ui = renderWithTooltips

describe("CastGutterVoice", () => {
  it("an explicitly cast line renders solid with the character's identity", () => {
    ui(
      <CastGutterVoice voice={mary} explicit castName="Mary" editable voices={VOICES} onPick={() => {}} />,
    )
    const trigger = screen.getByTestId("gutter-voice")
    expect(trigger).toHaveAttribute("data-explicit", "true")
    expect(trigger).toHaveAttribute("aria-label", "Mary. Choose a character")
    expect(trigger.querySelector(".outline-dotted")).toBeNull()
  })

  it("a default-fallback line draws an empty ring marked NC, not a faded face", () => {
    ui(
      <CastGutterVoice voice={narrator} explicit={false} castName={null} editable voices={VOICES} onPick={() => {}} />,
    )
    const trigger = screen.getByTestId("gutter-voice")
    expect(trigger).toHaveAttribute("data-explicit", "false")
    expect(trigger).toHaveAttribute(
      "aria-label",
      "Narrator — default (no one cast yet). Choose a character",
    )
    // No orb at all: the fallback voice's initial appearing here is what made
    // "nobody cast this" read as a weak assignment.
    expect(trigger.textContent).toBe("NC")
    const ring = trigger.querySelector("circle")
    expect(ring).not.toBeNull()

    // THE DASHES MUST CLOSE. Whatever the pattern is, a whole number of them
    // has to fit the circumference — otherwise the ring ends on a half-drawn
    // dash, which is the whole reason this is an SVG and not `border-dashed`.
    const r = Number(ring!.getAttribute("r"))
    const [dash, gap] = ring!.getAttribute("stroke-dasharray")!.split(" ").map(Number)
    const segments = (2 * Math.PI * r) / (dash + gap)
    expect(Math.abs(segments - Math.round(segments))).toBeLessThan(1e-9)
    // Round caps would lengthen every dash by a stroke-width and undo that.
    expect(ring!.getAttribute("stroke-linecap")).toBe("butt")
  })

  it("picking a character fires PURE assignment with the apply-to-speaker choice", () => {
    const onPick = vi.fn()
    ui(
      <CastGutterVoice voice={narrator} explicit={false} castName="Mary" editable voices={VOICES} onPick={onPick} />,
    )
    fireEvent.click(screen.getByTestId("gutter-voice"))
    // Footer present (the cell carries a diarized name) — tick it, then pick.
    fireEvent.click(screen.getByTestId("gutter-voice-all"))
    fireEvent.click(screen.getByRole("button", { name: /Mary/ }))
    expect(onPick).toHaveBeenCalledWith("v-mary", { applyToSpeaker: true })
  })

  it("no apply-to-speaker footer without a diarized cast name", () => {
    ui(
      <CastGutterVoice voice={mary} explicit castName={null} editable voices={VOICES} onPick={() => {}} />,
    )
    fireEvent.click(screen.getByTestId("gutter-voice"))
    expect(screen.getByPlaceholderText("Search voices…")).toBeInTheDocument()
    expect(screen.queryByTestId("gutter-voice-all")).toBeNull()
  })

  it("read-only surfaces show the identity but no picker", () => {
    ui(
      <CastGutterVoice voice={mary} explicit castName="Mary" editable={false} voices={VOICES} onPick={() => {}} />,
    )
    const el = screen.getByTestId("gutter-voice")
    expect(el.tagName).not.toBe("BUTTON")
    fireEvent.click(el)
    expect(screen.queryByPlaceholderText("Search voices…")).toBeNull()
  })
})
