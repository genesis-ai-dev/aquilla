// AQU-2401: the gutter's Play button, on its own.
//
// Its row-level placement (after the audio check, drawn only where that check
// is, absent from the `⋯`, and the emerald dot it retired) is pinned in
// EditorTable.audioValidation.test.tsx, where the real table decides those.
// What is left here is the button's own four states, which the row's audio
// controller supplies and a table test cannot drive: playing, paused, still
// loading, and nothing to play.
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { CellAudioPlayControl } from "./CellAudioPlayControl"
import { expectClickNote } from "@/test-utils/tooltip"

function draw(over: Partial<React.ComponentProps<typeof CellAudioPlayControl>> = {}) {
  const onToggle = vi.fn()
  render(
    <I18nProvider>
      <CellAudioPlayControl
        cellRef="GEN 1:1"
        checking={false}
        hasTake
        playing={false}
        loading={false}
        onToggle={onToggle}
        {...over}
      />
    </I18nProvider>,
  )
  return { onToggle }
}

const button = () => screen.queryByTestId("cell-audio-play-button")

describe("the gutter's Play button", () => {
  it("plays the line's take on a press", () => {
    const { onToggle } = draw()
    expect(button()).toHaveAccessibleName("Play audio")
    fireEvent.click(button()!)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  // Enter and Space reach it as the browser's own activation of a <button>,
  // which is why this is a real button and not a span with a click handler:
  // the whole point of the move is that the listen-then-validate loop can be
  // walked from the keyboard without leaving the strip.
  it("is reachable by Tab and toggles on Enter or Space", () => {
    const { onToggle } = draw()
    expect(button()!.getAttribute("tabindex")).toBeNull()
    button()!.focus()
    expect(document.activeElement).toBe(button())
    fireEvent.keyDown(button()!, { key: "Enter" })
    fireEvent.click(button()!) // what the browser dispatches for Enter/Space
    expect(onToggle).toHaveBeenCalled()
  })

  it("shows Pause, tinted primary, while that take is playing", () => {
    draw({ playing: true })
    expect(button()).toHaveAccessibleName("Pause")
    expect(button()!.className).toContain("text-primary")
    expect(button()!.querySelector("svg.lucide-pause")).not.toBeNull()
  })

  it("returns to Play when playback stops", () => {
    draw({ playing: false })
    expect(button()).toHaveAccessibleName("Play audio")
    expect(button()!.querySelector("svg.lucide-play")).not.toBeNull()
    expect(button()!.className).not.toContain("text-primary")
  })

  // Unchanged from the button's life inside the `⋯`: a press before the clip
  // has loaded would do nothing, so it says so rather than swallowing it.
  it("is disabled while the take is still loading, and presses nothing", () => {
    const { onToggle } = draw({ loading: true })
    expect(button()).toBeDisabled()
    fireEvent.click(button()!)
    expect(onToggle).not.toHaveBeenCalled()
  })

  // Sam's rule for an empty line (2026-09-23), the same one the audio check
  // beside it follows: the gutter reads full on every row, so the target
  // text's left edge never shifts between rows.
  it("fades to a non-focusable mark with nothing to play, and says why on a click", async () => {
    const { onToggle } = draw({ hasTake: false })
    expect(button()).toBeNull()
    const faded = screen.getByTestId("cell-audio-play-unavailable")
    expect(faded.tagName).toBe("SPAN")
    expect(faded).toHaveAccessibleName("GEN 1:1: nothing recorded to play")
    expect(faded.className).toContain("opacity-40")
    await expectClickNote(faded, "Nothing recorded on this line to play")
    expect(onToggle).not.toHaveBeenCalled()
  })

  // AQU-2260 (Oct 29): why a mark is faded opens on a CLICK, never a hover —
  // hover does nothing on touch. A hover may only name a button, which is
  // what the live Play's tooltip does.
  it("holds the slot's width and offers nothing while the recordings are read", () => {
    draw({ checking: true, hasTake: false })
    expect(button()).toBeNull()
    expect(screen.queryByTestId("cell-audio-play-unavailable")).toBeNull()
    const slot = screen.getByTestId("cell-audio-play-gutter")
    expect(slot.className).toContain("w-6")
    expect(slot.querySelector("button")).toBeNull()
  })

  // The slot stays reserved even over a take it already knows, so no button
  // appears and then changes under the pointer once the read lands.
  it("reserves the slot even over a take it already knows", () => {
    draw({ checking: true, hasTake: true })
    expect(button()).toBeNull()
    expect(screen.getByTestId("cell-audio-play-gutter")).toBeInTheDocument()
  })
})
