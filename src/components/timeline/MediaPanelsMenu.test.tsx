import { describe, expect, it, vi } from "vitest"
import { fireEvent, screen } from "@testing-library/react"
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

// Sam, Oct 28: PANELS — Film and Text, each ✓ while it shows, with its key —
// then Reset layout and its (i). The status line is the status ring's, and
// the timeline is always there (⌥1 still works).
describe("MediaPanelsMenu", () => {
  it("lists the film and the text as rows to show or hide, with their keys — no Timeline row, no status line", () => {
    // A status handed in (as the workspace used to) is not drawn any more.
    draw(fakeDock(startDockLayout()), { ...({ status: <span>Live · Synced · 5 lines · 0 done</span> } as object) })
    expect(screen.getByTestId("panels-heading")).toHaveTextContent(/^Panels$/)
    expect(screen.queryByText("Panels on this file")).toBeNull()
    expect(screen.queryByTestId("panels-row-timeline")).toBeNull()
    expect(screen.queryByText(/Live|Synced|lines · 0 done/)).toBeNull()
    const film = screen.getByTestId("panels-row-film")
    expect(film).toHaveAttribute("aria-pressed", "true")
    expect(film).toHaveTextContent(/^Film(⌥2|Alt\+2)$/)
    expect(screen.getByTestId("panels-row-text")).toHaveTextContent(/^Text(⌥3|Alt\+3)$/)
    // Where a panel sits is in its tooltip; nothing says "showing".
    expect(screen.queryByText(/showing/)).toBeNull()
    expect(screen.queryByTestId("panels-where-film")).toBeNull()
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
    fireEvent.click(screen.getByTestId("panels-row-film"))
    expect(dock.fold).toHaveBeenCalledWith("ll")
  })

  it("while full screen: one short line, the folded list in its tooltip, and Restore", async () => {
    const layout: DockLayout = {
      ...startDockLayout(),
      folded: { tl: false, ll: true, lr: true },
      fullUndo: ["ll", "lr", "left:files"],
    }
    const dock = fakeDock(layout, { film: true }, { fullRegion: "tl", canRestore: true })
    draw(dock)
    const note = screen.getByTestId("panels-full-note")
    expect(note).toHaveTextContent(/^Full screen is onRestore\s*Esc$/)
    await expectTooltip(note, "Full screen folded the bottom left, the bottom right, the left panel. Restoring unfolds just those.")
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
