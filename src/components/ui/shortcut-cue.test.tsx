import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MODE_OFF_NOTE_MS, ModeCue, undoKeysLabel } from "./shortcut-cue"

afterEach(() => vi.useRealTimers())

function Cue({ active, onTurnOff = vi.fn() }: { active: boolean; onTurnOff?: () => void }) {
  return (
    <ModeCue
      active={active}
      testId="cue"
      onLabel="Mode on"
      offKeys="Esc"
      offLabel="Mode off"
      turnOffLabel="Turn it off"
      onTurnOff={onTurnOff}
    />
  )
}

describe("ModeCue", () => {
  it("shows nothing until the mode has been on, then says off for a moment and goes", () => {
    vi.useFakeTimers()
    const { rerender } = render(<Cue active={false} />)
    // Never "Mode off" on first open: the mode was never on.
    expect(screen.queryByTestId("cue")).toBeNull()

    rerender(<Cue active />)
    expect(screen.getByTestId("cue")).toHaveTextContent("Mode on")
    expect(screen.getByTestId("cue")).toHaveAttribute("role", "status")

    rerender(<Cue active={false} />)
    expect(screen.getByTestId("cue")).toHaveTextContent("Mode off")
    act(() => { vi.advanceTimersByTime(MODE_OFF_NOTE_MS - 1) })
    expect(screen.getByTestId("cue")).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.queryByTestId("cue")).toBeNull()
  })

  it("turns back on cleanly while the off note is still showing", () => {
    vi.useFakeTimers()
    const { rerender } = render(<Cue active />)
    rerender(<Cue active={false} />)
    rerender(<Cue active />)
    act(() => { vi.advanceTimersByTime(MODE_OFF_NOTE_MS * 2) })
    expect(screen.getByTestId("cue")).toHaveAttribute("data-state", "on")
  })

  it("turns the mode off from its own button", () => {
    const onTurnOff = vi.fn()
    render(<Cue active onTurnOff={onTurnOff} />)
    fireEvent.click(screen.getByRole("button", { name: "Turn it off" }))
    expect(onTurnOff).toHaveBeenCalledTimes(1)
  })

  it("names the undo keys the way the keyboard shows them", () => {
    expect(undoKeysLabel(true)).toBe("⌘Z")
    expect(undoKeysLabel(false)).toBe("Ctrl+Z")
  })
})
