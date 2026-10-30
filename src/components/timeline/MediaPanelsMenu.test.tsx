import { describe, expect, it, vi } from "vitest"
import { fireEvent, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MediaPanelsMenu, type MediaPanelsMenuProps } from "./MediaPanelsMenu"
import { dockView, startDockLayout, type DockLayout, type DockPresence } from "./media-dock-layout"
import type { MediaDock } from "./useMediaDock"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"

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
    hide: vi.fn(),
    fold: vi.fn(),
    restore: vi.fn(),
    resetLayout: vi.fn(),
    ...extra,
  } as unknown as MediaDock
}

function draw(dock: MediaDock, over: Partial<MediaPanelsMenuProps> = {}) {
  return renderWithTooltips(
    <MediaPanelsMenu dock={dock} fileName="Episode 101" kind="dub" filmHiddenByTiming={false} {...over} />,
  )
}

// Sam, Oct 28: PANELS — Timeline, Film and Text, each ✓ while it shows, with
// its key — then Reset layout and its (i). The status line is the status
// ring's.
describe("MediaPanelsMenu", () => {
  it("lists the timeline, the film and the text as rows to show or hide, with their keys — no status line", () => {
    // A status handed in (as the workspace used to) is not drawn any more.
    draw(fakeDock(startDockLayout()), { ...({ status: <span>Live · Synced · 5 lines · 0 done</span> } as object) })
    expect(screen.getByTestId("panels-heading")).toHaveTextContent(/^Panels$/)
    expect(screen.queryByText("Panels on this file")).toBeNull()
    expect(screen.queryByText(/Live|Synced|lines · 0 done/)).toBeNull()
    const rows = screen.getAllByRole("button").filter((b) => b.dataset.testid?.startsWith("panels-row-"))
    expect(rows.map((b) => b.dataset.testid)).toEqual(["panels-row-timeline", "panels-row-film", "panels-row-text"])
    const timeline = screen.getByTestId("panels-row-timeline")
    expect(timeline).toHaveAttribute("aria-pressed", "true")
    expect(timeline).toHaveTextContent(/^Timeline(⌥1|Alt\+1)$/)
    const film = screen.getByTestId("panels-row-film")
    expect(film).toHaveAttribute("aria-pressed", "true")
    expect(film).toHaveTextContent(/^Film(⌥2|Alt\+2)$/)
    expect(screen.getByTestId("panels-row-text")).toHaveTextContent(/^Text(⌥3|Alt\+3)$/)
    // Where a panel sits is in its tooltip; nothing says "showing".
    expect(screen.queryByText(/showing/)).toBeNull()
    expect(screen.queryByTestId("panels-where-film")).toBeNull()
  })

  // Sam, Oct 28: "Why does the timeline not show up in panels?" Its corner's
  // Fold folds it to nothing, and this row is the way back.
  it("folds the timeline from its row, and brings a folded timeline back", async () => {
    const open = fakeDock(startDockLayout())
    const { unmount } = draw(open)
    await expectTooltip(screen.getByTestId("panels-row-timeline"), /^Across the top$/)
    fireEvent.click(screen.getByTestId("panels-row-timeline"))
    expect(open.fold).toHaveBeenCalledWith("tl")
    unmount()
    const folded = fakeDock({ ...startDockLayout(), folded: { tl: true, ll: false, lr: false } })
    draw(folded)
    const row = screen.getByTestId("panels-row-timeline")
    expect(row).toHaveAttribute("aria-pressed", "false")
    await expectTooltip(row, /^Across the top · folded$/)
    fireEvent.click(row)
    expect(folded.show).toHaveBeenCalledWith("timeline")
  })

  it("says where each panel sits in the row's tooltip", async () => {
    draw(fakeDock(startDockLayout()))
    await expectTooltip(screen.getByTestId("panels-row-film"), /^Bottom left$/)
  })

  it("hides a showing panel, shows one out of sight, and names a tab behind another", async () => {
    const layout: DockLayout = {
      ...startDockLayout(),
      areas: { ll: ["film", "text"], lr: [] },
      active: { ll: "film", lr: null },
    }
    const dock = fakeDock(layout)
    draw(dock)
    const text = screen.getByTestId("panels-row-text")
    expect(text).toHaveAttribute("aria-pressed", "false")
    await expectTooltip(text, "Bottom left · a tab behind Film")
    fireEvent.click(text)
    expect(dock.show).toHaveBeenCalledWith("text")
    // Review, Oct 29: unticking the film used to fold the area the two
    // share, and the text went with it. Hiding is the dock's (useMediaDock).
    fireEvent.click(screen.getByTestId("panels-row-film"))
    expect(dock.hide).toHaveBeenCalledWith("film")
    expect(dock.fold).not.toHaveBeenCalled()
  })

  it("while full screen: one short line, its (i) opening what full screen folded, and Restore", async () => {
    const layout: DockLayout = {
      ...startDockLayout(),
      folded: { tl: false, ll: true, lr: true },
      fullUndo: ["ll", "lr", "left:files"],
    }
    const dock = fakeDock(layout, { film: true }, { fullRegion: "tl", canRestore: true })
    draw(dock)
    const note = screen.getByTestId("panels-full-note")
    expect(note).toHaveTextContent(/^Full screen is onRestore\s*Esc$/)
    // Hovering the line or its (i) opens nothing: an (i) is a click (Sam, Oct 28).
    const info = screen.getByRole("button", { name: "About full screen" })
    const folded = screen.getByTestId("panels-full-info")
    const hover = userEvent.setup()
    await hover.hover(note)
    await hover.hover(info)
    expect(screen.queryByRole("tooltip")).toBeNull()
    expect(folded).toHaveAttribute("data-open", "false")
    expect(folded).toHaveAttribute("aria-hidden", "true")
    expect(info).toHaveAttribute("aria-controls", "panels-full-info")
    // A click opens the folded list in place, under the line; a second shuts it.
    fireEvent.click(info)
    expect(info).toHaveAttribute("aria-expanded", "true")
    expect(folded).toHaveAttribute("data-open", "true")
    expect(folded).toHaveTextContent("Full screen folded the bottom left, the bottom right, the left panel. Restoring unfolds just those.")
    expect(dock.restore).not.toHaveBeenCalled()
    fireEvent.click(info)
    expect(info).toHaveAttribute("aria-expanded", "false")
    expect(folded).toHaveAttribute("data-open", "false")
    fireEvent.click(screen.getByTestId("panels-restore"))
    expect(dock.restore).toHaveBeenCalled()
  })

  it("leaves the film out on a file without one, and says why under Free timing", async () => {
    const { rerender } = draw(fakeDock(startDockLayout(), { film: false }), { kind: "scripture", fileName: "Ruth" })
    expect(screen.queryByTestId("panels-row-film")).toBeNull()
    rerender(
      <MediaPanelsMenu dock={fakeDock(startDockLayout(), { film: false })} fileName="Ruth" kind="plain" filmHiddenByTiming />,
    )
    const film = screen.getByTestId("panels-row-film")
    expect(film).toBeDisabled()
    expect(film).toHaveAttribute("aria-pressed", "false")
    expect(film).toHaveAttribute("aria-description", "Hidden in Free timing")
  })

  it("resets the layout; its (i) opens what Reset does and the keys beneath it, and closes them (Sam, Oct 28)", () => {
    const dock = fakeDock(startDockLayout())
    draw(dock)
    fireEvent.click(screen.getByTestId("panels-reset"))
    expect(dock.resetLayout).toHaveBeenCalledTimes(1)
    // Shut at first: nothing to read, nothing to Tab to.
    const note = screen.getByTestId("panels-reset-info")
    expect(note).toHaveAttribute("data-open", "false")
    expect(note).toHaveAttribute("aria-hidden", "true")
    const info = screen.getByRole("button", { name: "About your layout" })
    expect(info).toHaveAttribute("aria-expanded", "false")
    expect(info).toHaveAttribute("aria-controls", "panels-reset-info")
    // A click opens it in place, under Reset layout — not a hover card.
    fireEvent.click(info)
    expect(info).toHaveAttribute("aria-expanded", "true")
    expect(note).toHaveAttribute("data-open", "true")
    expect(note).not.toHaveAttribute("aria-hidden", "true")
    expect(note).toHaveTextContent(/^Remembered for you, for this file\..*Episode 101/)
    expect(screen.getByTestId("panels-keys")).toHaveTextContent(/Panels .+ · Full screen .+ · Fold .+ · Restore Esc/)
    expect(screen.queryByRole("tooltip")).toBeNull()
    // The (i) never resets the layout, and a second click shuts it.
    expect(dock.resetLayout).toHaveBeenCalledTimes(1)
    fireEvent.click(info)
    expect(info).toHaveAttribute("aria-expanded", "false")
    expect(note).toHaveAttribute("data-open", "false")
  })

  it("is its icon alone in the bar, with 'Panels' and its key on hover (board 55)", async () => {
    draw(fakeDock(startDockLayout(), { film: true }, { panelsOpen: false }))
    const button = screen.getByTestId("panels-button")
    expect(button.textContent).toBe("")
    expect(button).toHaveAttribute("aria-label", "Panels")
    await expectTooltip(button, /^Panels · (⌘|Ctrl\+)\\$/)
  })
})
