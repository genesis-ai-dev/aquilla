import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { layoutGlyphRects, MediaAreaStrip, MediaLayoutGlyph, PanelControlButtons, TimelineMenu } from "./MediaPanelChrome"
import { filmLabelFor, MediaFilmButton } from "./MediaTopBar"
import { dockView, foldRegion, movePanel, startDockLayout, type DockLayout } from "./media-dock-layout"
import type { MediaDock } from "./useMediaDock"

function fakeDock(layout: DockLayout, extra: Partial<MediaDock> = {}): MediaDock {
  return {
    layout,
    view: dockView(layout, { film: true }),
    fullRegion: null,
    canRestore: false,
    leftOpen: true,
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

  it("its ⋯ says where the panel is and moves it to the other area", () => {
    const dock = fakeDock(startDockLayout())
    render(<MediaAreaStrip dock={dock} area="lr" />)
    fireEvent.click(screen.getByTestId("dock-more-lr"))
    expect(screen.getByText("Text · in Bottom right")).toBeInTheDocument()
    expect(screen.getByText(/You can also drag the tab to another area/)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("dock-move-lr"))
    expect(dock.move).toHaveBeenCalledWith("text", "ll")
  })
})

describe("the timeline's corner controls", () => {
  it("the narrow track names leave room for Full screen and ⋯ only", () => {
    const controls = { isFull: false, canFold: true, onToggleFull: vi.fn(), onFold: vi.fn() }
    render(<PanelControlButtons region="tl" controls={controls} foldTip="Fold" compact menu={<TimelineMenu controls={controls} />} />)
    expect(screen.queryByTestId("dock-fold-tl")).toBeNull()
    fireEvent.click(screen.getByTestId("dock-more-tl"))
    fireEvent.click(screen.getByTestId("dock-menu-fold-tl"))
    expect(controls.onFold).toHaveBeenCalled()
  })
})

describe("the top bar's Film button", () => {
  it("names the film by its file, the folder over a playlist, or the file it belongs to", () => {
    expect(filmLabelFor("https://cdn.test/films/Episode%20207.mp4", "ep")).toBe("Episode 207.mp4")
    expect(filmLabelFor("https://cdn.test/the-chosen-207/master.m3u8", "ep")).toBe("the-chosen-207")
    expect(filmLabelFor("https://cdn.test/cmkaom6vg0000bca7bhq1x2y3/master.m3u8", "TheChosen_101")).toBe("TheChosen_101")
    expect(filmLabelFor("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "ep")).toBe("YouTube dQw4w9WgXcQ")
  })

  it("is Link video while there is none, and folds or shows the film from its menu", () => {
    const onLink = vi.fn()
    const { rerender } = render(
      <MediaFilmButton url={null} fallbackName="ep" hiddenByTiming={false} showing={false} onHide={vi.fn()} onShow={vi.fn()} onLink={onLink} />,
    )
    fireEvent.click(screen.getByTestId("top-film"))
    expect(onLink).toHaveBeenCalled()
    const onHide = vi.fn()
    rerender(
      <MediaFilmButton url="https://cdn.test/a.mp4" fallbackName="ep" hiddenByTiming={false} showing onHide={onHide} onShow={vi.fn()} onLink={onLink} />,
    )
    expect(screen.getByTestId("top-film")).toHaveTextContent("Film: a.mp4")
    fireEvent.click(screen.getByTestId("top-film"))
    fireEvent.click(screen.getByTestId("top-film-hide"))
    expect(onHide).toHaveBeenCalled()
  })
})

describe("the layout glyph on Move to <area>", () => {
  const FILM = { film: true }
  const roles = (rects: ReturnType<typeof layoutGlyphRects>) => Object.fromEntries(rects.map((r) => [r.region, r.role]))

  it("draws the left panel, the timeline and both areas, the destination filled, the panel's own area dotted", () => {
    render(<MediaLayoutGlyph view={dockView(startDockLayout(), FILM)} leftOpen target="ll" current="lr" />)
    const glyph = screen.getByTestId("layout-glyph")
    const rect = (region: string) => glyph.querySelector(`[data-region="${region}"]`)!
    expect(Array.from(glyph.querySelectorAll("rect")).map((r) => r.getAttribute("data-region"))).toEqual(["left", "tl", "ll", "lr"])
    expect(rect("ll")).toHaveAttribute("fill", "currentColor")
    expect(rect("lr")).toHaveAttribute("fill", "none")
    expect(rect("lr")).toHaveAttribute("stroke-dasharray")
    expect(rect("tl")).not.toHaveAttribute("stroke-dasharray")
    // Bottom left sits left of bottom right, both under the timeline.
    expect(Number(rect("ll").getAttribute("x"))).toBeLessThan(Number(rect("lr").getAttribute("x")))
    expect(Number(rect("ll").getAttribute("y"))).toBeGreaterThan(Number(rect("tl").getAttribute("y")))
    expect(glyph).toHaveAttribute("aria-hidden", "true")
  })

  it("leaves out a folded timeline: the areas take its height", () => {
    const rects = layoutGlyphRects(dockView(foldRegion(startDockLayout(), FILM, "tl"), FILM), true, "ll", "lr")
    expect(rects.map((r) => r.region)).toEqual(["left", "ll", "lr"])
    expect(rects.find((r) => r.region === "ll")!.y).toBe(3)
  })

  it("still draws a destination that is folded or empty now, since moving there opens it", () => {
    // Both panels as tabs bottom left: bottom right does not exist yet.
    const tabs = dockView(movePanel(startDockLayout(), "text", "ll"), FILM)
    expect(roles(layoutGlyphRects(tabs, true, "lr", "ll"))).toEqual({ left: "plain", tl: "plain", ll: "current", lr: "target" })
    // The film folded: moving the text there draws it, filled.
    const folded = dockView(foldRegion(startDockLayout(), FILM, "ll"), FILM)
    expect(roles(layoutGlyphRects(folded, true, "ll", "lr")).ll).toBe("target")
  })

  it("narrows the left strip while the left panel is folded to its icons", () => {
    const v = dockView(startDockLayout(), FILM)
    expect(layoutGlyphRects(v, true, "ll", "lr")[0].w).toBeGreaterThan(layoutGlyphRects(v, false, "ll", "lr")[0].w)
  })

  it("the menu item's name stays its text", () => {
    render(<MediaAreaStrip dock={fakeDock(startDockLayout())} area="lr" />)
    fireEvent.click(screen.getByTestId("dock-more-lr"))
    const item = screen.getByTestId("dock-move-lr")
    expect(item).toHaveAccessibleName("Move to Bottom left")
    expect(item.querySelector('[data-testid="layout-glyph"] [data-region="ll"]')).toHaveAttribute("data-role", "target")
  })
})
