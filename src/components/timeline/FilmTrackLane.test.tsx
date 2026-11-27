import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { FilmTrackLane } from "./FilmTrackLane"
import { TimelineOrigin } from "./timeline-origin"
import { captureSeekSec, FilmFramesContext, type FilmFrameSource } from "./useFilmFrames"
import { getVideoDurationSec, resetVideoDurationsForTests } from "@/lib/timeline/video-duration"

// AQU-2253 (board 56): the film as one strip on its own clock.
describe("FilmTrackLane", () => {
  const draw = (over: Partial<React.ComponentProps<typeof FilmTrackLane>> = {}) =>
    render(
      <FilmTrackLane
        src="http://127.0.0.1:5540/showcase-film.webm" fileId="ep1" filmSec={27.08} pxPerSec={38}
        viewStartSec={0} viewEndSec={30} name="showcase-film.webm" frameFor={() => null} {...over}
      />,
    )

  it("one strip from 0:00 to the film's end, at the timeline's zoom", () => {
    draw()
    const strip = screen.getByTestId("tl-film-strip")
    expect(strip.style.left).toBe("0px")
    // Like every chip, 2 px short of its end (board 56).
    expect(parseFloat(strip.style.width)).toBeCloseTo(27.08 * 38 - 2)
    expect(strip).toHaveAccessibleName("The film, showcase-film.webm")
  })

  it("a 10 px sprocket band along the top, and no other border", () => {
    draw()
    const bands = screen.getAllByTestId("tl-film-sprockets")
    expect(bands).toHaveLength(1)
    expect(bands[0].style.height).toBe("10px")
    expect(screen.getByTestId("tl-film-strip").firstElementChild).toBe(bands[0])
    expect(bands[0].style.backgroundImage).toContain("data:image/svg+xml")
  })

  it("the row is there before the film's length is known; the strip is not", () => {
    draw({ filmSec: null })
    expect(screen.getByTestId("tl-film-lane")).toBeInTheDocument()
    expect(screen.queryByTestId("tl-film-strip")).toBeNull()
  })

  it("frames tile along the strip; without one a tile is the strip's own black", () => {
    const frameFor = (sec: number) => (sec < 3 ? `data:image/jpeg;base64,${sec}` : null)
    draw({ viewEndSec: 6, frameFor })
    const frames = screen.getAllByTestId("tl-film-frame")
    expect(frames.map((f) => f.getAttribute("data-frame-sec"))).toEqual(["1", "2"])
    expect(screen.getAllByTestId("tl-film-frame-empty").length).toBeGreaterThan(0)
  })

  it("draws no frames past the film's end", () => {
    draw({ viewStartSec: 20, viewEndSec: 60 })
    const tiles = screen.getAllByTestId(/tl-film-frame/)
    const ends = tiles.map((tile) => parseFloat(tile.style.left) + parseFloat(tile.style.width))
    expect(Math.max(...ends)).toBeCloseTo(27.08 * 38)
  })

  it("reads its frames from a hidden, muted copy of the film, never the Film panel's", () => {
    draw({ frameFor: undefined })
    const grabber = screen.getByTestId("tl-film-grabber") as HTMLVideoElement
    expect(grabber.muted).toBe(true)
    expect(grabber.getAttribute("src")).toBe("http://127.0.0.1:5540/showcase-film.webm")
    expect(grabber).toHaveAttribute("aria-hidden")
  })

  // The film bundle's browser pass (Nov 27): metadata in before React listens
  // (a cached film) fires no `loadedmetadata` the copy hears; its length is
  // taken all the same.
  it("its hidden copy tells the film's length it already knows when it comes on screen", () => {
    resetVideoDurationsForTests()
    const proto = HTMLMediaElement.prototype
    const ready = Object.getOwnPropertyDescriptor(proto, "readyState")
    const dur = Object.getOwnPropertyDescriptor(proto, "duration")
    Object.defineProperty(proto, "readyState", { get: () => 1, configurable: true })
    Object.defineProperty(proto, "duration", { get: () => 60, configurable: true })
    try {
      draw({ frameFor: undefined })
      expect(getVideoDurationSec("http://127.0.0.1:5540/showcase-film.webm")).toBe(60)
    } finally {
      if (ready) Object.defineProperty(proto, "readyState", ready)
      else delete (proto as { readyState?: number }).readyState
      if (dur) Object.defineProperty(proto, "duration", dur)
      else delete (proto as { duration?: number }).duration
      resetVideoDurationsForTests()
    }
  })

  it("a YouTube film has no frames to read: the plain strip, with its sprockets", () => {
    draw({ frameFor: undefined, src: "https://www.youtube.com/watch?v=aqbHRKZ1bVs" })
    expect(screen.queryByTestId("tl-film-grabber")).toBeNull()
    expect(screen.getByTestId("tl-film-sprockets")).toBeInTheDocument()
    expect(screen.queryAllByTestId("tl-film-frame")).toHaveLength(0)
  })

  it("a click on the strip moves the playhead to that moment", () => {
    const onSeekSec = vi.fn()
    draw({ onSeekSec })
    const strip = screen.getByTestId("tl-film-strip")
    strip.getBoundingClientRect = () => ({ left: 100, top: 0, width: 1027, height: 46, right: 1127, bottom: 46, x: 100, y: 0, toJSON: () => ({}) })
    fireEvent.click(strip, { clientX: 100 + 12 * 38 })
    expect(onSeekSec).toHaveBeenCalledWith(12)
  })
})

// AQU-2253 (Sam, Oct 30): an imported film following the recordings is cut
// along its source cues, each line's piece in that line's slot.
describe("FilmTrackLane — an imported film, cut into its lines' pieces", () => {
  const pieces = [
    // An exact fit, a recording 1.8 s longer than its original, and one cut.
    { cellId: "a", atSec: 0, lenSec: 3.5, filmStartSec: 0.5, filmEndSec: 4.0 },
    { cellId: "b", atSec: 3.5, lenSec: 6, filmStartSec: 4.6, filmEndSec: 8.8 },
    { cellId: "c", atSec: 9.5, lenSec: 2, filmStartSec: 9.2, filmEndSec: 11.2, cutSec: 2.3 },
  ]
  const draw = (over: Partial<React.ComponentProps<typeof FilmTrackLane>> = {}) =>
    render(
      <FilmTrackLane
        src="frontier-audio://f1/audio-f1-1-film.webm" fileId="f1" filmSec={27.08} pxPerSec={40}
        viewStartSec={0} viewEndSec={30} name="Imported film.webm" frameFor={(sec) => `data:image/jpeg;base64,${sec}`}
        pieces={pieces} {...over}
      />,
    )

  it("one chip per line, at its line's slot, never the one strip on the film's clock", () => {
    draw()
    expect(screen.getByTestId("tl-film-lane")).toHaveAttribute("data-film-kind", "imported-pieces")
    const chips = screen.getAllByTestId("tl-film-piece")
    expect(chips.map((c) => [c.getAttribute("data-cell-id"), c.style.left, c.style.width])).toEqual([
      ["a", "0px", "138px"],
      ["b", "140px", "238px"],
      ["c", "380px", "78px"],
    ])
    // Each its own chip with the film's sprocket band.
    expect(screen.getAllByTestId("tl-film-sprockets")).toHaveLength(3)
    expect(screen.getByTestId("tl-film-strip")).toHaveAccessibleName("The film, Imported film.webm")
  })

  it("each piece's frames come from its own stretch of the film", () => {
    draw()
    for (const chip of screen.getAllByTestId("tl-film-piece")) {
      const start = Number(chip.getAttribute("data-film-start"))
      const end = Number(chip.getAttribute("data-film-end"))
      for (const frame of chip.querySelectorAll("[data-testid='tl-film-frame']")) {
        const sec = Number(frame.getAttribute("data-frame-sec"))
        expect(sec).toBeGreaterThanOrEqual(start)
        expect(sec).toBeLessThanOrEqual(end)
      }
    }
  })

  it("a recording longer than its original: the piece holds its last frame, faded and hatched, to the line's end", () => {
    draw()
    const [a, b, c] = screen.getAllByTestId("tl-film-piece")
    expect(a.querySelector("[data-testid='tl-film-held']")).toBeNull()
    expect(c.querySelector("[data-testid='tl-film-held']")).toBeNull()
    const held = b.querySelector("[data-testid='tl-film-held']") as HTMLElement
    expect(held).not.toBeNull()
    expect(parseFloat(held.style.left)).toBeCloseTo(4.2 * 40, 1)
    const heldFrames = [...b.querySelectorAll("[data-testid='tl-film-frame'][data-held]")] as HTMLElement[]
    expect(heldFrames.length).toBeGreaterThan(0)
    expect(new Set(heldFrames.map((f) => f.getAttribute("data-frame-sec")))).toEqual(new Set(["8.76"]))
    expect(heldFrames.every((f) => f.style.opacity === "0.45")).toBe(true)
    // Board 56 (chopped): the hold says how long it is.
    expect(held).toHaveTextContent("held 1.8 s")
  })

  it("a recording shorter than its original: the piece is cut, with a white edge that says by how much", () => {
    draw()
    const [a, , c] = screen.getAllByTestId("tl-film-piece")
    expect(a.querySelector("[data-testid='tl-film-cut']")).toBeNull()
    expect(c.querySelector("[data-testid='tl-film-cut']")).toHaveTextContent("cut 2.3 s")
  })

  it("a click moves the playhead to that moment of the timeline", () => {
    const onSeekSec = vi.fn()
    draw({ onSeekSec })
    const strip = screen.getByTestId("tl-film-strip")
    strip.getBoundingClientRect = () => ({ left: 100, top: 0, width: 460, height: 46, right: 560, bottom: 46, x: 100, y: 0, toJSON: () => ({}) })
    fireEvent.click(strip, { clientX: 100 + 5 * 40 })
    expect(onSeekSec).toHaveBeenCalledWith(5)
  })

  it("no pieces given: the one strip, as for a linked film", () => {
    draw({ pieces: null })
    expect(screen.getByTestId("tl-film-lane")).toHaveAttribute("data-film-kind", "one-strip")
    expect(screen.queryAllByTestId("tl-film-piece")).toHaveLength(0)
    expect(parseFloat(screen.getByTestId("tl-film-strip").style.width)).toBeCloseTo(27.08 * 40 - 2)
  })
})

// Merged onto dev's horizontal list (Nov 14): the timeline draws its lanes in
// 2048 px columns, each placed from its own left edge (`useTimelineOriginPx`),
// and every mounted column draws its own copy of this lane.
describe("FilmTrackLane — in one column of the timeline", () => {
  const pieces = [
    { cellId: "a", atSec: 0, lenSec: 3.5, filmStartSec: 0.5, filmEndSec: 4.0 },
    { cellId: "b", atSec: 60, lenSec: 6, filmStartSec: 4.6, filmEndSec: 8.8 },
  ]
  const lane = (over: Partial<React.ComponentProps<typeof FilmTrackLane>> = {}) => (
    <FilmTrackLane
      src="http://127.0.0.1:5540/showcase-film.webm" fileId="ep1" filmSec={120} pxPerSec={40}
      viewStartSec={51.2} viewEndSec={102.4} name="showcase-film.webm" frameFor={() => null} {...over}
    />
  )

  it("the strip is placed from the column's start, as every chip is", () => {
    render(<TimelineOrigin px={2048}>{lane()}</TimelineOrigin>)
    const strip = screen.getByTestId("tl-film-strip")
    expect(strip.style.left).toBe("-2048px")
    expect(parseFloat(strip.style.width)).toBeCloseTo(120 * 40 - 2)
  })

  it("so are an imported film's pieces, and each piece keeps its slot", () => {
    render(<TimelineOrigin px={2048}>{lane({ pieces })}</TimelineOrigin>)
    expect(screen.getByTestId("tl-film-strip").style.left).toBe("-2048px")
    // Only the piece in this column's stretch is drawn, at its canvas slot
    // inside a box that starts at 0:00: 60 s in is 352 px into the column.
    const chips = screen.getAllByTestId("tl-film-piece")
    expect(chips.map((c) => c.getAttribute("data-cell-id"))).toEqual(["b"])
    expect(parseFloat(chips[0].style.left)).toBeCloseTo(60 * 40)
  })

  it("a click in a later column still seeks to the moment under it", () => {
    const onSeekSec = vi.fn()
    render(<TimelineOrigin px={2048}>{lane({ onSeekSec })}</TimelineOrigin>)
    const strip = screen.getByTestId("tl-film-strip")
    // The strip's box starts at 0:00, off the column's left edge.
    strip.getBoundingClientRect = () => ({ left: -1948, top: 0, width: 4798, height: 46, right: 2850, bottom: 46, x: -1948, y: 0, toJSON: () => ({}) })
    fireEvent.click(strip, { clientX: -1948 + 70 * 40 })
    expect(onSeekSec).toHaveBeenCalledWith(70)
  })

  it("inside the editor, the frames are the editor's: no grabber of its own, and it asks for its own tiles", () => {
    const wantFor = vi.fn()
    const source: FilmFrameSource = { frameFor: () => null, wantFor }
    const { unmount } = render(
      <FilmFramesContext.Provider value={source}>{lane({ frameFor: undefined })}</FilmFramesContext.Provider>,
    )
    expect(screen.queryByTestId("tl-film-grabber")).toBeNull()
    expect(wantFor).toHaveBeenCalled()
    const [owner, secs] = wantFor.mock.calls.at(-1)!
    expect(secs.length).toBeGreaterThan(0)
    expect(secs.every((sec: number) => sec >= 50 && sec <= 104)).toBe(true)
    unmount()
    expect(wantFor).toHaveBeenLastCalledWith(owner, [])
  })
})

describe("captureSeekSec", () => {
  it("seeks a few frames past a tile's moment, off the stream's segment boundaries", () => {
    // 1780 s is exactly where one of The Chosen 101's 4-second segments starts.
    expect(captureSeekSec(1780, 3288)).toBeCloseTo(1780.12)
  })

  it("never into the film's last moments", () => {
    expect(captureSeekSec(27.05, 27.08)).toBeCloseTo(26.98)
  })
})
