import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { FilmTrackLane } from "./FilmTrackLane"

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
