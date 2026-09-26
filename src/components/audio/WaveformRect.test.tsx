import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { WaveformRect } from "./WaveformRect"
import { envelopePathD } from "@/lib/audio/waveform-shape"

const peaks = new Float32Array([0.2, 1, 0.5, 0.1])

function box(el: HTMLElement, width = 400) {
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: 56, width, height: 56, x: 0, y: 0, toJSON: () => ({}) })
}

describe("WaveformRect", () => {
  it("draws the timeline chip's own figure inside the border", () => {
    render(<WaveformRect peaks={peaks} height={56} testId="w" />)
    const svg = screen.getByTestId("w-shape")
    expect(svg.getAttribute("viewBox")).toBe("0 0 4 54")
    expect(svg.querySelector("path")?.getAttribute("d")).toBe(envelopePathD(peaks, 54))
    expect(svg.getAttribute("class")).toContain("opacity-40")
  })

  it("wears the chip's body on a neutral ladder", () => {
    render(<WaveformRect peaks={peaks} height={56} testId="w" />)
    const root = screen.getByTestId("w")
    expect(root.className).toContain("bg-[color:var(--tl-track-take)]")
    expect(root.className).toContain("rounded-[6px]")
    expect(root.style.getPropertyValue("--tl-track-take")).toContain("color-mix")
  })

  it("wears the track colour it is given instead of grey", () => {
    render(<WaveformRect peaks={peaks} height={56} testId="w" trackVars={{ "--tl-track-hue": "#da2b84", "--tl-track-take": "rgba(218, 43, 132, 0.67)" }} />)
    const root = screen.getByTestId("w")
    expect(root.style.getPropertyValue("--tl-track-hue")).toBe("#da2b84")
    expect(root.style.getPropertyValue("--tl-track-take")).toBe("rgba(218, 43, 132, 0.67)")
  })

  it("draws the body alone with no peaks yet", () => {
    render(<WaveformRect peaks={[]} height={56} testId="w" />)
    expect(screen.queryByTestId("w-shape")).toBeNull()
  })

  it("fades the trimmed-off ends", () => {
    render(<WaveformRect peaks={peaks} height={56} keep={{ start: 0.1, end: 0.8 }} testId="w" />)
    expect(screen.getByTestId("w-fade-start").style.width).toBe("10%")
    expect(screen.getByTestId("w-fade-end").style.width).toBe("20%")
  })

  it("draws nothing faded for an untrimmed take", () => {
    render(<WaveformRect peaks={peaks} height={56} keep={{ start: 0, end: 1 }} testId="w" />)
    expect(screen.queryByTestId("w-fade-start")).toBeNull()
    expect(screen.queryByTestId("w-fade-end")).toBeNull()
  })

  it("shows progress the chip's way while playing: split body and a hairline", () => {
    const { rerender } = render(<WaveformRect peaks={peaks} height={56} progress={0.25} testId="w" />)
    expect(screen.queryByTestId("w-playline")).toBeNull()
    rerender(<WaveformRect peaks={peaks} height={56} progress={0.25} playing testId="w" />)
    const root = screen.getByTestId("w")
    expect(root.className).toContain("var(--tl-play-x")
    expect(root.style.getPropertyValue("--tl-play-x")).toBe("25%")
    expect(screen.getByTestId("w-playline").style.left).toBe("25%")
  })

  it("plays and records from its corners without triggering a seek", () => {
    const onTogglePlay = vi.fn()
    const onRecord = vi.fn()
    const onSeek = vi.fn()
    render(
      <WaveformRect peaks={peaks} height={56} onTogglePlay={onTogglePlay} playLabel="Play" stopLabel="Stop"
        onRecord={onRecord} recordLabel="Record" onSeek={onSeek} seekLabel="Seek" testId="w" />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Play" }))
    fireEvent.click(screen.getByRole("button", { name: "Record" }))
    expect(onTogglePlay).toHaveBeenCalledTimes(1)
    expect(onRecord).toHaveBeenCalledTimes(1)
    expect(onSeek).not.toHaveBeenCalled()
  })

  it("labels the corner button Stop while playing", () => {
    render(<WaveformRect peaks={peaks} height={56} playing onTogglePlay={() => {}} playLabel="Play" stopLabel="Stop" />)
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument()
  })

  it("seeks to the fraction under the pointer", () => {
    const onSeek = vi.fn()
    render(<WaveformRect peaks={peaks} height={56} onSeek={onSeek} seekLabel="Seek" testId="w" />)
    box(screen.getByTestId("w"))
    fireEvent.pointerDown(screen.getByRole("slider", { name: "Seek" }), { clientX: 100, buttons: 1 })
    expect(onSeek).toHaveBeenCalledWith(0.25)
  })

  // Found on the live walk (2026-09-25): the message overlay spans the body,
  // and while it took the pointer a take showing "missing" or "Load waveform"
  // could not be played from its corner at all.
  it("lets the corner buttons through a status message; only the message takes the pointer", () => {
    render(
      <WaveformRect
        peaks={null} height={56} testId="w" onTogglePlay={() => {}} playLabel="Play"
        status={<button type="button">Load waveform</button>}
      />,
    )
    const message = screen.getByRole("button", { name: "Load waveform" })
    const overlay = message.parentElement!.parentElement!
    expect(overlay.className).toContain("pointer-events-none")
    expect(message.parentElement!.className).toContain("pointer-events-auto")
  })

  it("shows the validated tick", () => {
    render(<WaveformRect peaks={peaks} height={56} validation="full" validationLabel="Validated" testId="w" />)
    expect(screen.getByTestId("w-validated")).toHaveAttribute("aria-label", "Validated")
  })

  describe("edges", () => {
    it("drags an editable line and commits on release", () => {
      const onDrag = vi.fn()
      const onCommit = vi.fn()
      render(
        <WaveformRect peaks={peaks} height={56} testId="w"
          edges={[{ key: "start", at: 0.1, label: "Trim start", editable: true, onDrag, onCommit }]} />,
      )
      box(screen.getByTestId("w"))
      const line = screen.getByRole("slider", { name: "Trim start" })
      expect(line.className).toContain("cursor-ew-resize")
      fireEvent.pointerDown(line, { clientX: 80, buttons: 1 })
      fireEvent.pointerMove(line, { clientX: 120, buttons: 1 })
      fireEvent.pointerUp(line, { clientX: 120 })
      expect(onDrag).toHaveBeenNthCalledWith(1, 0.2)
      expect(onDrag).toHaveBeenNthCalledWith(2, 0.3)
      expect(onCommit).toHaveBeenCalledTimes(1)
    })

    it("nudges with bare arrow keys, coarse with Shift, and leaves Alt+Arrow alone", () => {
      const onNudge = vi.fn()
      render(
        <WaveformRect peaks={peaks} height={56}
          edges={[{ key: "end", at: 0.9, label: "Trim end", editable: true, onNudge }]} />,
      )
      const line = screen.getByRole("slider", { name: "Trim end" })
      fireEvent.keyDown(line, { key: "ArrowLeft" })
      fireEvent.keyDown(line, { key: "ArrowRight", shiftKey: true })
      fireEvent.keyDown(line, { key: "ArrowRight", altKey: true })
      fireEvent.keyDown(line, { key: " " })
      expect(onNudge.mock.calls).toEqual([[-1, false], [1, true]])
    })

    it("draws a read-only line in grey that takes no input", () => {
      const onDrag = vi.fn()
      render(
        <WaveformRect peaks={peaks} height={56}
          edges={[{ key: "start", at: 0.1, label: "Trim start", editable: false, onDrag }]} />,
      )
      const line = screen.getByRole("slider", { name: "Trim start" })
      expect(line).toHaveAttribute("aria-readonly", "true")
      expect(line.className).not.toContain("cursor-ew-resize")
      expect(line.firstElementChild?.className).toContain("bg-muted-foreground")
      fireEvent.pointerDown(line, { clientX: 80, buttons: 1 })
      expect(onDrag).not.toHaveBeenCalled()
    })
  })
})
