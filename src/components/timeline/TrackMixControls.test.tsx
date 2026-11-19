// AQU-2664 (board 74): the track header's controls — M | S, the fader and ≈.
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { EvenOutButton, MuteSoloPair, TrackFader } from "./TrackMixControls"

afterEach(() => vi.useRealTimers())

describe("M | S", () => {
  it("is one group of two joined 20×18 buttons, M first", () => {
    render(<MuteSoloPair name="Jesus" testKey="t1" muted={false} soloed={false} onMute={() => {}} onSolo={() => {}} />)
    const group = screen.getByRole("group", { name: "Mute and solo" })
    const [m, s] = Array.from(group.querySelectorAll("button"))
    expect(m.textContent).toBe("M")
    expect(s.textContent).toBe("S")
    expect(m.className).toContain("h-[18px]")
    expect(m.className).toContain("w-5")
    expect(m.className).toContain("rounded-l-[4px]")
    expect(s.className).toContain("rounded-r-[4px]")
    expect(s.className).toContain("-ml-px")
  })

  it("lights M teal when muted and S yellow when soloed, and says so", () => {
    render(<MuteSoloPair name="Jesus" testKey="t1" muted soloed onMute={() => {}} onSolo={() => {}} />)
    const m = screen.getByTestId("tl-mute-t1")
    const s = screen.getByTestId("tl-solo-t1")
    expect(m).toHaveAttribute("aria-pressed", "true")
    expect(s).toHaveAttribute("aria-pressed", "true")
    expect(m.className).toContain("bg-[var(--lg-m)]")
    expect(s.className).toContain("bg-[var(--lg-s)]")
    expect(m).toHaveAttribute("aria-label", "Mute Jesus")
    expect(s).toHaveAttribute("aria-label", "Solo Jesus")
  })

  it("is grey at rest", () => {
    render(<MuteSoloPair name="Jesus" testKey="t1" muted={false} soloed={false} onMute={() => {}} onSolo={() => {}} />)
    expect(screen.getByTestId("tl-mute-t1")).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByTestId("tl-mute-t1").className).toContain("bg-[var(--lg-btn)]")
  })

  it("mutes and solos on click, and the click never reaches the row", () => {
    const onMute = vi.fn()
    const onSolo = vi.fn()
    const onRow = vi.fn()
    render(
      <div onClick={onRow}>
        <MuteSoloPair name="Jesus" testKey="t1" muted={false} soloed={false} onMute={onMute} onSolo={onSolo} />
      </div>,
    )
    fireEvent.click(screen.getByTestId("tl-mute-t1"))
    fireEvent.click(screen.getByTestId("tl-solo-t1"))
    expect(onMute).toHaveBeenCalledTimes(1)
    expect(onSolo).toHaveBeenCalledTimes(1)
    expect(onRow).not.toHaveBeenCalled()
  })

  it("can show M alone (the collapsed strip)", () => {
    render(<MuteSoloPair name="Jesus" testKey="t1" muted={false} soloed={false} onMute={() => {}} onSolo={() => {}} muteOnly />)
    expect(screen.getByTestId("tl-mute-t1")).toBeInTheDocument()
    expect(screen.queryByTestId("tl-solo-t1")).toBeNull()
  })
})

describe("the fader", () => {
  function setup(db = 0, disabled = false) {
    const onLive = vi.fn()
    const onCommit = vi.fn()
    render(<TrackFader name="Jesus" testKey="t1" db={db} onLive={onLive} onCommit={onCommit} disabled={disabled} />)
    const slider = screen.getByRole("slider", { name: "Volume of Jesus" })
    // happy-dom has no layout: give the 64px groove a box.
    slider.getBoundingClientRect = () => ({ left: 0, width: 64, top: 0, height: 16, right: 64, bottom: 16, x: 0, y: 0, toJSON: () => {} })
    return { onLive, onCommit, slider }
  }

  it("is a 64×16 slider over −60…+6 dB, its thumb at the level", () => {
    const { slider } = setup(0)
    expect(slider.className).toContain("w-16")
    expect(slider).toHaveAttribute("aria-valuemin", "-60")
    expect(slider).toHaveAttribute("aria-valuemax", "6")
    expect(slider).toHaveAttribute("aria-valuenow", "0")
    expect(slider).toHaveAttribute("aria-valuetext", "0.0 dB")
    // 0 dB sits at 0.82 of the 54px travel.
    expect(screen.getByTestId("tl-fader-thumb-t1").style.left).toBe(`${(0.82 * 54).toFixed(1)}px`)
    expect(slider.title).toBe("Volume · double-click to type · Option-click for 0 dB")
  })

  it("shows the readout on hover, left of the fader", () => {
    const { slider } = setup(-4.5)
    expect(screen.queryByTestId("tl-fader-readout-t1")).toBeNull()
    fireEvent.pointerEnter(slider)
    expect(screen.getByTestId("tl-fader-readout-t1").textContent).toBe("−4.5 dB")
    fireEvent.pointerLeave(slider)
    expect(screen.queryByTestId("tl-fader-readout-t1")).toBeNull()
  })

  it("follows a drag live (one frame at a time) and saves once, at the end", () => {
    vi.useFakeTimers()
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => setTimeout(() => cb(0), 0) as unknown as number)
    const { slider, onLive, onCommit } = setup(0)
    fireEvent.pointerDown(slider, { clientX: 5 + 0.5 * 54, pointerId: 1, button: 0 })
    fireEvent.pointerMove(slider, { clientX: 5 + 0.65 * 54, pointerId: 1 })
    fireEvent.pointerMove(slider, { clientX: 5 + 0.39 * 54, pointerId: 1 })
    act(() => { vi.runAllTimers() })
    // Two moves in one frame: the mixer hears the last of them, once.
    expect(onLive.mock.calls.at(-1)?.[0]).toBeCloseTo(-18, 1)
    expect(screen.getByTestId("tl-fader-readout-t1").textContent).toBe("−18.0 dB")
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.pointerUp(slider, { clientX: 5 + 0.39 * 54, pointerId: 1 })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit.mock.calls[0][0]).toBeCloseTo(-18, 1)
    raf.mockRestore()
  })

  it("goes back to 0 dB on Option-click", () => {
    const { slider, onCommit } = setup(-9)
    fireEvent.pointerDown(slider, { clientX: 10, pointerId: 1, button: 0, altKey: true })
    expect(onCommit).toHaveBeenCalledWith(0)
  })

  it("takes a typed value on double-click, clamped, and Escape keeps the old one", () => {
    const { slider, onCommit } = setup(0)
    fireEvent.doubleClick(slider)
    const field = screen.getByRole("textbox", { name: "Volume of Jesus" })
    fireEvent.change(field, { target: { value: "-4.5" } })
    fireEvent.keyDown(field, { key: "Enter" })
    expect(onCommit).toHaveBeenCalledWith(-4.5)
    fireEvent.doubleClick(screen.getByRole("slider"))
    const again = screen.getByRole("textbox", { name: "Volume of Jesus" })
    fireEvent.change(again, { target: { value: "40" } })
    fireEvent.keyDown(again, { key: "Escape" })
    expect(onCommit).toHaveBeenCalledTimes(1)
    fireEvent.doubleClick(screen.getByRole("slider"))
    const third = screen.getByRole("textbox", { name: "Volume of Jesus" })
    fireEvent.change(third, { target: { value: "40" } })
    fireEvent.keyDown(third, { key: "Enter" })
    expect(onCommit).toHaveBeenLastCalledWith(6)
  })

  it("steps with the arrow keys and saves after a pause, not on every key", () => {
    vi.useFakeTimers()
    const { slider, onLive, onCommit } = setup(0)
    fireEvent.keyDown(slider, { key: "ArrowDown" })
    fireEvent.keyDown(slider, { key: "ArrowDown" })
    fireEvent.keyDown(slider, { key: "ArrowDown", shiftKey: true })
    expect(onLive).toHaveBeenLastCalledWith(-4)
    expect(onCommit).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(400) })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(-4)
  })

  it("does nothing for someone who may not change it, and says why", () => {
    const { slider, onCommit } = setup(0, true)
    expect(slider).toHaveAttribute("aria-disabled", "true")
    fireEvent.pointerDown(slider, { clientX: 10, pointerId: 1, button: 0, altKey: true })
    fireEvent.doubleClick(slider)
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(slider.title).toBe("Only maintainers can change a track's volume")
  })
})

describe("≈", () => {
  it("is a real button the size of M and S, grey until the track is evened", () => {
    const onClick = vi.fn()
    render(<EvenOutButton testKey="t1" state="none" onClick={onClick} />)
    const b = screen.getByRole("button", { name: "Even out loudness…" })
    expect(b.className).toContain("h-[18px]")
    expect(b.className).toContain("w-5")
    expect(b).toHaveAttribute("aria-pressed", "false")
    expect(b.className).toContain("bg-[var(--lg-btn)]")
    fireEvent.click(b)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("is blue when evened and amber when some takes couldn't go all the way", () => {
    const { rerender } = render(<EvenOutButton testKey="t1" state="full" onClick={() => {}} />)
    const full = screen.getByRole("button", { name: "Evened out · click to change" })
    expect(full).toHaveAttribute("aria-pressed", "true")
    expect(full.className).toContain("bg-[var(--lg-ev)]")
    rerender(<EvenOutButton testKey="t1" state="part" onClick={() => {}} />)
    const part = screen.getByRole("button", { name: "Evened out, some takes not all the way · click to change" })
    expect(part.className).toContain("bg-[var(--lg-part)]")
  })
})
