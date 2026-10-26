import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { MediaAreaStrip, PanelControlButtons, TimelineMenu } from "./MediaPanelChrome"
import { filmLabelFor, MediaFilmButton } from "./MediaTopBar"
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
