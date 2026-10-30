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

  // Sam, Oct 23: how far a pick reaches is a choice of three, not a checkbox.
  it.each([
    ["line", undefined],
    ["file", "gutter-voice-scope-file"],
    ["everywhere", "gutter-voice-scope-everywhere"],
  ] as const)("picking a character fires PURE assignment with the %s scope", (scope, choice) => {
    const onPick = vi.fn()
    ui(
      <CastGutterVoice voice={narrator} explicit={false} castName="Mary" editable voices={VOICES} onPick={onPick} />,
    )
    fireEvent.click(screen.getByTestId("gutter-voice"))
    if (choice) fireEvent.click(screen.getByTestId(choice))
    fireEvent.click(screen.getByRole("button", { name: /Mary/ }))
    expect(onPick).toHaveBeenCalledWith("v-mary", { scope })
  })

  it("names the three scopes, says how many lines this file has, and starts at this line", () => {
    const countSpeakerLines = vi.fn(() => 12)
    ui(
      <CastGutterVoice voice={mary} explicit castName="Mary" editable voices={VOICES} onPick={() => {}} countSpeakerLines={countSpeakerLines} />,
    )
    expect(countSpeakerLines).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("gutter-voice"))
    expect(countSpeakerLines).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("gutter-voice-scope-line")).toBeChecked()
    expect(screen.getByTestId("gutter-voice-scope-line").closest("label")).toHaveTextContent("This line")
    expect(screen.getByTestId("gutter-voice-scope-file").closest("label")).toHaveTextContent("Every «Mary» line in this file (12)")
    expect(screen.getByTestId("gutter-voice-scope-everywhere").closest("label")).toHaveTextContent("Every «Mary» line, in every episode")
  })

  it("goes back to this line every time the picker opens", () => {
    ui(
      <CastGutterVoice voice={mary} explicit castName="Mary" editable voices={VOICES} onPick={() => {}} />,
    )
    fireEvent.click(screen.getByTestId("gutter-voice"))
    fireEvent.click(screen.getByTestId("gutter-voice-scope-everywhere"))
    expect(screen.getByTestId("gutter-voice-scope-everywhere")).toBeChecked()
    fireEvent.click(screen.getByRole("button", { name: /^John$/ }))
    fireEvent.click(screen.getByTestId("gutter-voice"))
    expect(screen.getByTestId("gutter-voice-scope-line")).toBeChecked()
  })

  it("a line without a character offers only this line, and says why", () => {
    const onPick = vi.fn()
    ui(
      <CastGutterVoice voice={mary} explicit castName={null} editable voices={VOICES} onPick={onPick} />,
    )
    fireEvent.click(screen.getByTestId("gutter-voice"))
    expect(screen.getByPlaceholderText("Search voices…")).toBeInTheDocument()
    expect(screen.queryByTestId("gutter-voice-scope-file")).toBeNull()
    expect(screen.queryByTestId("gutter-voice-scope-everywhere")).toBeNull()
    expect(screen.getByTestId("gutter-voice-scope-none")).toHaveTextContent("This line has no character, so the voice is for this line only.")
    fireEvent.click(screen.getByRole("button", { name: /^John$/ }))
    expect(onPick).toHaveBeenCalledWith("v-john", { scope: "line" })
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
      const search = screen.getByPlaceholderText("Search voices…")
      const maryRow = screen.getByRole("button", { name: /^Mary$/ })
      // Search stays above the list. "No character" is the first item in it.
      expect(search.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(clear.parentElement).toBe(maryRow.parentElement)
      // The row shows what the line becomes: the NC mark, not an icon-of-delete.
      expect(clear.textContent).toContain("NC")
      fireEvent.click(clear)
      expect(onClear).toHaveBeenCalledWith({ scope: "line" })
      expect(onPick).not.toHaveBeenCalled()
    })

    it("the file scope rides the clear too, not only the pick", () => {
      // Sam, 2026-08-21: the footer must mean it for both actions above it.
      const onClear = vi.fn()
      ui(
        <CastGutterVoice voice={mary} explicit castName="Mary" editable voices={VOICES} onPick={() => {}} onClear={onClear} />,
      )
      fireEvent.click(screen.getByTestId("gutter-voice"))
      fireEvent.click(screen.getByTestId("gutter-voice-scope-file"))
      fireEvent.click(screen.getByTestId("gutter-voice-clear"))
      expect(onClear).toHaveBeenCalledWith({ scope: "file" })
    })

    it("removing a character from every episode is not offered, and says so", () => {
      const onClear = vi.fn()
      ui(
        <CastGutterVoice voice={mary} explicit castName="Mary" editable voices={VOICES} onPick={() => {}} onClear={onClear} />,
      )
      fireEvent.click(screen.getByTestId("gutter-voice"))
      fireEvent.click(screen.getByTestId("gutter-voice-scope-everywhere"))
      const clear = screen.getByTestId("gutter-voice-clear")
      expect(clear).toBeDisabled()
      expect(clear).toHaveTextContent("Choose this line or this file to remove a character.")
      fireEvent.click(clear)
      expect(onClear).not.toHaveBeenCalled()
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

  // Sam, 2026-09-28: the Audio view opens the same picker from a field under
  // each line's waveform.
  describe("the field form, under a waveform", () => {
    it("names the voice beside its mark and opens the same picker below it", () => {
      const onPick = vi.fn()
      ui(
        <CastGutterVoice variant="field" voice={mary} explicit castName="Mary" editable voices={VOICES} onPick={onPick} countSpeakerLines={() => 3} />,
      )
      const field = screen.getByTestId("voice-field")
      expect(field.tagName).toBe("BUTTON")
      expect(field).toHaveTextContent("Mary")
      expect(field).toHaveAttribute("aria-label", "Mary. Choose a character")
      fireEvent.click(field)
      expect(screen.getByPlaceholderText("Search voices…")).toBeInTheDocument()
      expect(screen.getByTestId("gutter-voice-scope-file").closest("label")).toHaveTextContent("Every «Mary» line in this file (3)")
      fireEvent.click(screen.getByRole("button", { name: /John/ }))
      expect(onPick).toHaveBeenCalledWith("v-john", { scope: "line" })
    })

    it("reads as the default voice, with the NC mark, when nobody was cast", () => {
      ui(
        <CastGutterVoice variant="field" voice={narrator} explicit={false} castName={null} editable voices={VOICES} onPick={() => {}} />,
      )
      const field = screen.getByTestId("voice-field")
      expect(field).toHaveTextContent("NCNarrator (default)")
    })

    it("names a person's recording, not the default voice, when nobody was cast (AQU-2212)", () => {
      ui(
        <CastGutterVoice variant="field" voice={narrator} explicit={false} castName={null} editable voices={VOICES} onPick={() => {}} takeLabel="Your recording" />,
      )
      const field = screen.getByTestId("voice-field")
      expect(field).toHaveTextContent("Your recording")
      expect(field).not.toHaveTextContent("Narrator")
    })

    it("ends the list with Add a voice…", () => {
      const onAddVoice = vi.fn()
      ui(
        <CastGutterVoice variant="field" voice={mary} explicit castName={null} editable voices={VOICES} onPick={() => {}} onAddVoice={onAddVoice} />,
      )
      fireEvent.click(screen.getByTestId("voice-field"))
      fireEvent.click(screen.getByTestId("gutter-voice-add"))
      expect(onAddVoice).toHaveBeenCalledTimes(1)
      expect(screen.queryByPlaceholderText("Search voices…")).toBeNull()
    })

    it("read-only, names the voice with no picker", () => {
      ui(
        <CastGutterVoice variant="field" voice={mary} explicit castName="Mary" editable={false} voices={VOICES} onPick={() => {}} />,
      )
      const field = screen.getByTestId("voice-field")
      expect(field.tagName).not.toBe("BUTTON")
      expect(field).toHaveTextContent("Mary")
      fireEvent.click(field)
      expect(screen.queryByPlaceholderText("Search voices…")).toBeNull()
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
