import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { layoutGlyphShape, MediaAreaStrip, MediaLayoutGlyph, PanelControlButtons, TimelineMenu } from "./MediaPanelChrome"
import { filmLabelFor } from "./MediaTopBar"
import { dockView, foldRegion, movePanel, startDockLayout, type DockLayout } from "./media-dock-layout"
import type { MediaDock } from "./useMediaDock"

function fakeDock(layout: DockLayout, extra: Partial<MediaDock> = {}): MediaDock {
  return {
    layout,
    view: dockView(layout, { film: true }),
    fullRegion: null,
    canRestore: false,
    activate: vi.fn(),
    toggleFull: vi.fn(),
    fold: vi.fn(),
    move: vi.fn(),
    ...extra,
  } as unknown as MediaDock
}

describe("an area's strip", () => {
  it("shows its panel as a tab, then Full screen, Fold and ⋯ — and no chevrons", () => {
    const dock = fakeDock(startDockLayout())
    render(<MediaAreaStrip dock={dock} area="ll" />)
    expect(screen.getByTestId("dock-tab-film")).toHaveTextContent("Film")
    const controls = screen.getByTestId("dock-controls-ll")
    const order = Array.from(controls.querySelectorAll("button")).map((b) => b.getAttribute("data-testid"))
    expect(order).toEqual(["dock-full-ll", "dock-fold-ll", "dock-more-ll"])
    expect(screen.getByTestId("dock-full-ll")).toHaveAccessibleName(/^Full screen: fold everything else/)
    expect(screen.getByTestId("dock-fold-ll")).toHaveAccessibleName(/Nothing is left behind; the Panels button brings it back\.$/)
    fireEvent.click(screen.getByTestId("dock-fold-ll"))
    expect(dock.fold).toHaveBeenCalledWith("ll")
  })

  it("offers no Fold while it is the only thing open, and reads Restore while full screen", () => {
    let l = foldRegion(startDockLayout(), { film: true }, "tl")
    l = foldRegion(l, { film: true }, "lr")
    render(<MediaAreaStrip dock={fakeDock(l, { fullRegion: "ll", canRestore: true })} area="ll" />)
    expect(screen.queryByTestId("dock-fold-ll")).toBeNull()
    expect(screen.getByTestId("dock-full-ll")).toHaveAccessibleName(/^Restore the other panels \(Esc\)/)
  })

  it("its tabs: a click shows, a double-click goes full screen", () => {
    const dock = fakeDock(movePanel(startDockLayout(), "text", "ll"))
    render(<MediaAreaStrip dock={dock} area="ll" />)
    fireEvent.click(screen.getByTestId("dock-tab-film"))
    expect(dock.activate).toHaveBeenCalledWith("film")
    fireEvent.doubleClick(screen.getByTestId("dock-tab-text"))
    expect(dock.toggleFull).toHaveBeenCalledWith("ll")
  })

  // AQU-2196 (Oct 29): as the timeline's ⋯ did on Oct 27, the Film and Text
  // panels' ⋯ leave Full screen and Fold to the buttons beside them.
  it.each([
    ["bottom left (the film)", "ll", null],
    ["bottom right (the text)", "lr", null],
    ["full screen, where the button reads Restore", "ll", "ll"],
  ] as const)("its ⋯ has no Full screen and no Fold — %s", (_label, area, fullRegion) => {
    const dock = fakeDock(startDockLayout(), fullRegion ? { fullRegion, canRestore: true } : {})
    render(<MediaAreaStrip dock={dock} area={area} />)
    fireEvent.click(screen.getByTestId(`dock-more-${area}`))
    const menu = screen.getByRole("menu")
    expect(within(menu).getByTestId(`dock-move-${area}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`dock-menu-full-${area}`)).toBeNull()
    expect(screen.queryByTestId(`dock-menu-fold-${area}`)).toBeNull()
    expect(within(menu).queryByText(/Full screen|Restore|Fold/)).toBeNull()
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(1)
    // The buttons beside the ⋯ stay.
    expect(screen.getByTestId(`dock-full-${area}`)).toBeInTheDocument()
    if (!fullRegion) expect(screen.getByTestId(`dock-fold-${area}`)).toBeInTheDocument()
  })

  it("its ⋯ says where the panel is and moves it to the other area", () => {
    const dock = fakeDock(startDockLayout())
    render(<MediaAreaStrip dock={dock} area="lr" />)
    fireEvent.click(screen.getByTestId("dock-more-lr"))
    expect(screen.getByText("Text · in bottom right")).toBeInTheDocument()
    expect(screen.getByText(/You can also drag the tab to another area/)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("dock-move-lr"))
    expect(dock.move).toHaveBeenCalledWith("text", "ll")
  })
})

describe("the timeline's corner controls", () => {
  it("the narrow track names leave room for Full screen and ⋯ only", () => {
    const controls = { isFull: false, canFold: true, onToggleFull: vi.fn(), onFold: vi.fn() }
    render(<PanelControlButtons region="tl" controls={controls} foldTip="Fold" compact menu={<TimelineMenu controls={controls} compact />} />)
    expect(screen.queryByTestId("dock-fold-tl")).toBeNull()
    fireEvent.click(screen.getByTestId("dock-more-tl"))
    fireEvent.click(screen.getByTestId("dock-menu-fold-tl"))
    expect(controls.onFold).toHaveBeenCalled()
  })

  it("takes the timeline's + first, before Full screen (board 55)", () => {
    const controls = { isFull: false, canFold: true, onToggleFull: vi.fn(), onFold: vi.fn() }
    render(
      <PanelControlButtons region="tl" controls={controls} foldTip="Fold" leading={<button type="button" data-testid="plus">+</button>} menu={<TimelineMenu controls={controls} />} />,
    )
    const order = [...screen.getByTestId("dock-controls-tl").querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid"))
    expect(order.slice(0, 4)).toEqual(["plus", "dock-full-tl", "dock-fold-tl", "dock-more-tl"])
  })

  it("its ⋯ leaves Full screen and Fold to the buttons beside it (Sam, Oct 27)", () => {
    const controls = { isFull: false, canFold: true, onToggleFull: vi.fn(), onFold: vi.fn() }
    render(<TimelineMenu controls={controls} settings={<span data-testid="settings">settings</span>} />)
    fireEvent.click(screen.getByTestId("dock-more-tl"))
    expect(screen.getByText("Timeline")).toBeInTheDocument()
    expect(screen.queryByTestId("dock-menu-full-tl")).toBeNull()
    expect(screen.queryByTestId("dock-menu-fold-tl")).toBeNull()
    expect(screen.getByTestId("settings")).toBeInTheDocument()
  })
})

describe("the film's name (the Sources menu heads with it, board 55)", () => {
  it("names the film by its file, the folder over a playlist, or the file it belongs to", () => {
    expect(filmLabelFor("https://cdn.test/films/Episode%20207.mp4", "ep")).toBe("Episode 207.mp4")
    expect(filmLabelFor("https://cdn.test/the-chosen-207/master.m3u8", "ep")).toBe("the-chosen-207")
    expect(filmLabelFor("https://cdn.test/cmkaom6vg0000bca7bhq1x2y3/master.m3u8", "TheChosen_101")).toBe("TheChosen_101")
    expect(filmLabelFor("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "ep")).toBe("YouTube dQw4w9WgXcQ")
  })
})

describe("the map icon on Move to <area> (Sam, Oct 27: one frame, the target solid)", () => {
  const FILM = { film: true }
  const parts = (el: Element) => Array.from(el.querySelectorAll("[data-part]")).map((n) => n.getAttribute("data-part"))

  it("one frame, the timeline band, the split between the areas, the destination solid", () => {
    render(<MediaLayoutGlyph view={dockView(startDockLayout(), FILM)} target="ll" />)
    const glyph = screen.getByTestId("layout-glyph")
    expect(parts(glyph)).toEqual(["target", "frame", "timeline", "split"])
    const target = glyph.querySelector('[data-part="target"]')!
    expect(target).toHaveAttribute("fill", "currentColor")
    // Bottom left: under the band, the left half of the frame.
    expect([target.getAttribute("x"), target.getAttribute("y"), target.getAttribute("width")]).toEqual(["2", "10", "10"])
    expect(glyph.querySelector('[data-part="frame"]')).toHaveAttribute("rx", "2")
    expect(glyph).toHaveAttribute("stroke-width", "1.6")
    expect(glyph).toHaveAttribute("aria-hidden", "true")
  })

  it("marks nothing but the destination: no left-panel strip, no dotted current area", () => {
    render(<MediaLayoutGlyph view={dockView(startDockLayout(), FILM)} target="lr" />)
    const glyph = screen.getByTestId("layout-glyph")
    expect(glyph.querySelectorAll('[fill="currentColor"]')).toHaveLength(1)
    expect(glyph.querySelector("[stroke-dasharray]")).toBeNull()
    expect(glyph.querySelector('[data-part="target"]')).toHaveAttribute("x", "12")
  })

  it("drops the top band when the timeline is folded; the areas start at the frame's top", () => {
    const g = layoutGlyphShape(dockView(foldRegion(startDockLayout(), FILM, "tl"), FILM), "ll")
    expect(g.timelineBand).toBe(false)
    expect(g.target[1]).toBe(4)
    render(<MediaLayoutGlyph view={dockView(foldRegion(startDockLayout(), FILM, "tl"), FILM)} target="ll" />)
    expect(parts(screen.getByTestId("layout-glyph"))).toEqual(["target", "frame", "split"])
  })

  it("draws a destination that doesn't exist yet, and leaves out an area that doesn't exist", () => {
    // Both panels as tabs bottom left: bottom right does not exist, but it is
    // where the panel would go, so it is drawn.
    const tabs = dockView(movePanel(startDockLayout(), "text", "ll"), FILM)
    expect(layoutGlyphShape(tabs, "lr")).toMatchObject({ split: 12, target: [12, 10, 10, 10] })
    // No film on this file: bottom left holds nothing and is folded too, so a
    // map with only bottom right open spans the whole width when it is the target.
    const textOnly = dockView(foldRegion(startDockLayout(), { film: false }, "ll"), { film: false })
    expect(layoutGlyphShape(textOnly, "lr")).toMatchObject({ split: null, target: [2, 10, 20, 10] })
  })

  it("reads in sentence case, and the item's name stays its text", () => {
    render(<MediaAreaStrip dock={fakeDock(startDockLayout())} area="lr" />)
    fireEvent.click(screen.getByTestId("dock-more-lr"))
    const item = screen.getByTestId("dock-move-lr")
    expect(item).toHaveAccessibleName("Move to bottom left")
    expect(item.querySelector('[data-testid="layout-glyph"]')).toBeInTheDocument()
  })
})
