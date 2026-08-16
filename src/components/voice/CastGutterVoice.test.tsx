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

  it("a default-fallback line is unmistakably 'not chosen': dotted + heavy fade", () => {
    ui(
      <CastGutterVoice voice={narrator} explicit={false} castName={null} editable voices={VOICES} onPick={() => {}} />,
    )
    const trigger = screen.getByTestId("gutter-voice")
    expect(trigger).toHaveAttribute("data-explicit", "false")
    expect(trigger).toHaveAttribute(
      "aria-label",
      "Narrator — default (no one cast yet). Choose a character",
    )
    const faded = trigger.querySelector(".outline-dotted")
    expect(faded).not.toBeNull()
    expect(faded!.className).toContain("opacity-35")
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
