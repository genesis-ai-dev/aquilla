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

  it("a default-fallback line draws an empty rounded mark labelled NC, not a faded face", () => {
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
    expect(trigger.querySelector("circle")).toBeNull()
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

  // Matt's QA (2026-08-21): a character could be replaced but never removed.
  describe("the way out of a casting", () => {
    it("a cast line offers 'No character', and choosing it fires onClear", () => {
      const onClear = vi.fn()
      const onPick = vi.fn()
      ui(
        <CastGutterVoice voice={mary} explicit castName="Mary" editable voices={VOICES} onPick={onPick} onClear={onClear} />,
      )
      fireEvent.click(screen.getByTestId("gutter-voice"))
      const clear = screen.getByTestId("gutter-voice-clear")
      // The row shows what the line becomes: the NC mark, not an icon-of-delete.
      expect(clear.textContent).toContain("NC")
      fireEvent.click(clear)
      expect(onClear).toHaveBeenCalledWith({ applyToSpeaker: false })
      expect(onPick).not.toHaveBeenCalled()
    })

    it("the apply-to-all checkbox rides the clear too, not only the pick", () => {
      // Sam, 2026-08-21: the footer promises "all «name» lines" — ticked, the
      // clear must take the character off every line sharing the name, not
      // silently ignore the box for one of the two actions above it.
      const onClear = vi.fn()
      ui(
        <CastGutterVoice voice={mary} explicit castName="Mary" editable voices={VOICES} onPick={() => {}} onClear={onClear} />,
      )
      fireEvent.click(screen.getByTestId("gutter-voice"))
      fireEvent.click(screen.getByTestId("gutter-voice-all"))
      fireEvent.click(screen.getByTestId("gutter-voice-clear"))
      expect(onClear).toHaveBeenCalledWith({ applyToSpeaker: true })
    })

    it("a lingering name behind an NC ring is still clearable", () => {
      // Not explicit, but the cell carries a diarized/imported name — that
      // name still groups the exports, so the way out must be offered.
      ui(
        <CastGutterVoice voice={narrator} explicit={false} castName="Mary" editable voices={VOICES} onPick={() => {}} onClear={() => {}} />,
      )
      fireEvent.click(screen.getByTestId("gutter-voice"))
      expect(screen.getByTestId("gutter-voice-clear")).toBeInTheDocument()
    })

    it("an uncast line is not offered an unassign row", () => {
      ui(
        <CastGutterVoice voice={narrator} explicit={false} castName={null} editable voices={VOICES} onPick={() => {}} onClear={() => {}} />,
      )
      fireEvent.click(screen.getByTestId("gutter-voice"))
      expect(screen.getByPlaceholderText("Search voices…")).toBeInTheDocument()
      expect(screen.queryByTestId("gutter-voice-clear")).toBeNull()
    })
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
