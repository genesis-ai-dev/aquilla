import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { Scale } from "lucide-react"
import { TabStrip } from "./TabStrip"

describe("TabStrip surface tabs", () => {
  it("keeps an inactive Agent tab visible beside open files", () => {
    render(
      <TabStrip
        tabs={[{ id: "t1", fileId: "f1" }]}
        activeTabId="t1"
        files={[{ id: "f1", name: "GEN.usfm" }]}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        surfaceTabs={[
          {
            id: "agent",
            label: "Agent",
            active: false,
            onActivate: vi.fn(),
            onClose: vi.fn(),
          },
        ]}
      />,
    )

    expect(screen.getByRole("tab", { name: /GEN\.usfm/i })).toHaveAttribute("aria-selected", "true")
    const agentTab = screen.getByRole("tab", { name: /^Agent/ })
    expect(agentTab).toHaveAttribute("aria-selected", "false")
    expect(agentTab.querySelectorAll("svg")).toHaveLength(1)
  })

  it("activates a surface tab on click", () => {
    const onActivate = vi.fn()
    render(
      <TabStrip
        tabs={[{ id: "t1", fileId: "f1" }]}
        activeTabId="t1"
        files={[{ id: "f1", name: "GEN.usfm" }]}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        surfaceTabs={[
          {
            id: "agent",
            label: "Agent",
            active: false,
            onActivate,
            onClose: vi.fn(),
          },
        ]}
      />,
    )

    fireEvent.click(within(screen.getByRole("tab", { name: /^Agent/ })).getByRole("button", { name: "Agent" }))
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it("closes the Agent surface tab via its close control", () => {
    const onClose = vi.fn()
    render(
      <TabStrip
        tabs={[]}
        activeTabId={null}
        files={[]}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        surfaceTabs={[
          {
            id: "agent",
            label: "Agent",
            active: true,
            onActivate: vi.fn(),
            onClose,
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Close Agent" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("can show Rules and Agent surface tabs together", () => {
    render(
      <TabStrip
        tabs={[]}
        activeTabId={null}
        files={[]}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        surfaceTabs={[
          {
            id: "rules",
            label: "Rules",
            icon: Scale,
            active: true,
            onActivate: vi.fn(),
            onClose: vi.fn(),
          },
          {
            id: "agent",
            label: "Agent",
            active: false,
            onActivate: vi.fn(),
            onClose: vi.fn(),
          },
        ]}
      />,
    )

    expect(screen.getByRole("tab", { name: /^Rules/ })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tab", { name: /^Agent/ })).toHaveAttribute("aria-selected", "false")
  })
})

/** AQU-2138: the active tab's fill must be distinct from the inactive tabs'
 *  (and from the bg-sidebar header behind the strip — the tokens in index.css
 *  carry that half). These guard the class wiring: the fill tokens, the hover
 *  fill staying off the active token, and the three label-fade/close overlays
 *  tracking whichever fill their own tab paints, so no seam shows at the
 *  trailing edge. */
describe("TabStrip active-tab fill", () => {
  const ACTIVE_FILL = "bg-[color:var(--tab-active)]"
  const INACTIVE_FILL = "bg-[color:var(--tab-inactive)]"
  const HOVER_FILL = "hover:bg-[color:var(--tab-hover)]"

  function renderThreeFiles(activeTabId: string) {
    return render(
      <TabStrip
        tabs={[
          { id: "t1", fileId: "f1" },
          { id: "t2", fileId: "f2" },
          { id: "t3", fileId: "f3" },
        ]}
        activeTabId={activeTabId}
        files={[
          { id: "f1", name: "MRK.usfm" },
          { id: "f2", name: "1TH.usfm" },
          { id: "f3", name: "43LUKkgwETPv0.SFM" },
        ]}
        onActivate={vi.fn()}
        onClose={vi.fn()}
      />,
    )
  }

  it("gives the active file tab a different fill from every inactive tab", () => {
    renderThreeFiles("t2")

    const active = screen.getByRole("tab", { name: /1TH\.usfm/ })
    expect(active).toHaveClass(ACTIVE_FILL)
    expect(active).not.toHaveClass(INACTIVE_FILL)

    for (const name of [/MRK\.usfm/, /43LUKkgwETPv0\.SFM/]) {
      const inactive = screen.getByRole("tab", { name })
      expect(inactive).toHaveClass(INACTIVE_FILL)
      expect(inactive).not.toHaveClass(ACTIVE_FILL)
    }
  })

  it("moves the fill when a different tab becomes active", () => {
    const { unmount } = renderThreeFiles("t1")
    expect(screen.getByRole("tab", { name: /MRK\.usfm/ })).toHaveClass(ACTIVE_FILL)
    unmount()

    renderThreeFiles("t3")
    expect(screen.getByRole("tab", { name: /MRK\.usfm/ })).not.toHaveClass(ACTIVE_FILL)
    expect(screen.getByRole("tab", { name: /43LUKkgwETPv0\.SFM/ })).toHaveClass(ACTIVE_FILL)
  })

  it("keeps the inactive hover fill off the active token", () => {
    renderThreeFiles("t2")

    const inactive = screen.getByRole("tab", { name: /MRK\.usfm/ })
    expect(inactive).toHaveClass(HOVER_FILL)
    expect(inactive.className).not.toContain("hover:bg-[color:var(--tab-active)]")
    expect(screen.getByRole("tab", { name: /1TH\.usfm/ })).not.toHaveClass(HOVER_FILL)
  })

  it("paints the label-fade and close overlays in the tab's own fill", () => {
    renderThreeFiles("t2")

    const overlayFills = (tab: HTMLElement) =>
      [...tab.querySelectorAll("span[aria-hidden]")].map((el) => el.className)

    const activeOverlays = overlayFills(screen.getByRole("tab", { name: /1TH\.usfm/ }))
    expect(activeOverlays).toHaveLength(3)
    for (const className of activeOverlays) {
      expect(className).toContain("var(--tab-active)")
      expect(className).not.toContain("var(--tab-inactive)")
    }

    const inactiveOverlays = overlayFills(screen.getByRole("tab", { name: /MRK\.usfm/ }))
    expect(inactiveOverlays).toHaveLength(3)
    for (const className of inactiveOverlays) {
      expect(className).toContain("var(--tab-inactive)")
      expect(className).toContain("var(--tab-hover)")
      expect(className).not.toContain("var(--tab-active)")
    }
  })

  it("gives the Agent surface tab the active fill and leaves file tabs plain", () => {
    render(
      <TabStrip
        tabs={[{ id: "t1", fileId: "f1" }]}
        activeTabId={null}
        files={[{ id: "f1", name: "GEN.usfm" }]}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        surfaceTabs={[
          {
            id: "agent",
            label: "Agent",
            active: true,
            onActivate: vi.fn(),
            onClose: vi.fn(),
          },
        ]}
      />,
    )

    expect(screen.getByRole("tab", { name: /^Agent/ })).toHaveClass(ACTIVE_FILL)
    expect(screen.getByRole("tab", { name: /GEN\.usfm/ })).not.toHaveClass(ACTIVE_FILL)
  })
})
