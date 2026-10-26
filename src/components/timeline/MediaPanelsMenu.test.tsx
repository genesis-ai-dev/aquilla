import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { MediaPanelsMenu } from "./MediaPanelsMenu"
import { dockView, startDockLayout, type DockLayout, type DockPresence } from "./media-dock-layout"
import type { MediaDock } from "./useMediaDock"

/** A dock as the menu sees it: the real view over a layout, spies for the moves. */
function fakeDock(layout: DockLayout, presence: DockPresence = { film: true }, extra: Partial<MediaDock> = {}): MediaDock {
  return {
    layout,
    view: dockView(layout, presence),
    fullRegion: null,
    canRestore: false,
    panelsOpen: true,
    setPanelsOpen: vi.fn(),
    show: vi.fn(),
    restore: vi.fn(),
    resetLayout: vi.fn(),
    ...extra,
  } as unknown as MediaDock
}

const where = (id: string) => screen.getByTestId(`panels-where-${id}`).textContent

describe("MediaPanelsMenu", () => {
  it("lists the timeline, the film and the text, where each is, with their keys", () => {
    render(<MediaPanelsMenu dock={fakeDock(startDockLayout())} fileName="Episode 101" kind="dub" filmHiddenByTiming={false} />)
    expect(screen.getByText("Panels on this file")).toBeInTheDocument()
    expect(where("timeline")).toBe("The centre, always")
    expect(where("film")).toBe("Bottom left · showing")
    expect(where("text")).toBe("Bottom right · showing")
    // Nothing is out of sight, so nothing offers Show.
    expect(screen.queryByTestId("panels-show-film")).toBeNull()
    expect(screen.getByTestId("panels-row-film")).toHaveTextContent(/⌥2|Alt\+2/)
  })

  it("offers Show for a folded panel, and a panel behind a tab says so", () => {
    const layout: DockLayout = {
      ...startDockLayout(),
      areas: { ll: ["film", "text"], lr: [] },
      active: { ll: "film", lr: null },
      folded: { tl: true, ll: false, lr: false },
    }
    const dock = fakeDock(layout)
    render(<MediaPanelsMenu dock={dock} fileName="Episode 101" kind="dub" filmHiddenByTiming={false} />)
    expect(where("timeline")).toBe("The centre, always · folded")
    expect(where("text")).toBe("Bottom left · a tab behind Film")
    fireEvent.click(screen.getByTestId("panels-show-timeline"))
    expect(dock.show).toHaveBeenCalledWith("timeline")
    fireEvent.click(screen.getByTestId("panels-show-text"))
    expect(dock.show).toHaveBeenCalledWith("text")
  })

  it("while full screen: names what it folded and restores just that", () => {
    const layout: DockLayout = {
      ...startDockLayout(),
      folded: { tl: false, ll: true, lr: true },
      fullUndo: ["ll", "lr", "left:files"],
    }
    const dock = fakeDock(layout, { film: true }, { fullRegion: "tl", canRestore: true })
    render(<MediaPanelsMenu dock={dock} fileName="Episode 101" kind="dub" filmHiddenByTiming={false} />)
    expect(screen.getByTestId("panels-full-note")).toHaveTextContent(
      "Full screen folded the bottom left, the bottom right, the left panel. Restoring unfolds just those.",
    )
    expect(where("timeline")).toBe("The centre, always · full screen")
    fireEvent.click(screen.getByTestId("panels-restore"))
    expect(dock.restore).toHaveBeenCalled()
  })

  it("leaves the film out on a file without one, and says so under Free timing", () => {
    const { rerender } = render(
      <MediaPanelsMenu dock={fakeDock(startDockLayout(), { film: false })} fileName="Ruth" kind="scripture" filmHiddenByTiming={false} />,
    )
    expect(screen.queryByTestId("panels-row-film")).toBeNull()
    rerender(
      <MediaPanelsMenu dock={fakeDock(startDockLayout(), { film: false })} fileName="Ruth" kind="plain" filmHiddenByTiming />,
    )
    expect(where("film")).toBe("Hidden in Free timing")
    expect(screen.queryByTestId("panels-show-film")).toBeNull()
  })

  it("resets the layout, and lists the keys", () => {
    const dock = fakeDock(startDockLayout())
    render(<MediaPanelsMenu dock={dock} fileName="Episode 101" kind="dub" filmHiddenByTiming={false} />)
    fireEvent.click(screen.getByTestId("panels-reset"))
    expect(dock.resetLayout).toHaveBeenCalled()
    expect(screen.getByTestId("panels-keys")).toHaveTextContent(/Panels .+ · Full screen .+ · Fold .+ · Restore Esc/)
  })
})
