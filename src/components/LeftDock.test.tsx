import { useState } from "react"
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { LeftDock, type DockTab } from "./LeftDock"

vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))

function Harness({
  initialTab,
  showAgent = true,
  surfaceTab = null,
  onSurfaceTabToggle,
}: {
  initialTab: DockTab
  showAgent?: boolean
  surfaceTab?: DockTab | null
  onSurfaceTabToggle?: (tab: DockTab) => void
}) {
  const [tab, setTab] = useState<DockTab | null>(initialTab)
  return (
    <I18nProvider>
      <LeftDock
        activeTab={tab}
        onActiveTabChange={setTab}
        surfaceTab={surfaceTab}
        onSurfaceTabToggle={onSurfaceTabToggle}
        filesPanel={<div>files panel</div>}
        agentPanel={showAgent ? <div>agent panel</div> : undefined}
        searchPanel={<div>search panel</div>}
        voicesPanel={<div>voices panel</div>}
      />
    </I18nProvider>
  )
}

describe("LeftDock", () => {
  it("hides the Agent dock tab when its panel is unavailable", () => {
    render(<Harness initialTab="files" showAgent={false} />)
    expect(screen.queryByRole("button", { name: "Agent" })).toBeNull()
  })

  it("expands back to the last open tab instead of always Files", async () => {
    const user = userEvent.setup()
    render(<Harness initialTab="voices" />)

    expect(screen.getByText("voices panel")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Voices" }))
    expect(screen.queryByText("voices panel")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Expand sidebar" }))
    expect(screen.getByText("voices panel")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Voices" })).toHaveAttribute("aria-pressed", "true")
  })

  // AQU-1079: the Agent workbench takes over the center pane instead of
  // opening in the dock, so the rail used to show its icon inactive and drop
  // the click on the floor — no navigation, no visible state change.
  describe("a tab whose surface is showing outside the dock (AQU-1079)", () => {
    it("marks the rail tab active even though another tab owns the dock", () => {
      render(<Harness initialTab="files" surfaceTab="agent" onSurfaceTabToggle={vi.fn()} />)

      expect(screen.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-pressed", "true")
      expect(screen.getByText("files panel")).toBeInTheDocument()
    })

    it("toggles that surface off on click instead of silently doing nothing", async () => {
      const user = userEvent.setup()
      const onSurfaceTabToggle = vi.fn()
      render(<Harness initialTab="files" surfaceTab="agent" onSurfaceTabToggle={onSurfaceTabToggle} />)

      await user.click(screen.getByRole("button", { name: "Agent" }))

      expect(onSurfaceTabToggle).toHaveBeenCalledWith("agent")
      // The dock keeps its own tab — the click acted on the center surface.
      expect(screen.getByText("files panel")).toBeInTheDocument()
      expect(screen.queryByText("agent panel")).not.toBeInTheDocument()
    })

    it("still opens the Agent panel in the dock when its surface is not showing", async () => {
      const user = userEvent.setup()
      const onSurfaceTabToggle = vi.fn()
      render(<Harness initialTab="files" surfaceTab={null} onSurfaceTabToggle={onSurfaceTabToggle} />)

      await user.click(screen.getByRole("button", { name: "Agent" }))

      expect(onSurfaceTabToggle).not.toHaveBeenCalled()
      expect(screen.getByText("agent panel")).toBeInTheDocument()
    })

    it("leaves the other rail tabs switching the dock as before", async () => {
      const user = userEvent.setup()
      const onSurfaceTabToggle = vi.fn()
      render(<Harness initialTab="files" surfaceTab="agent" onSurfaceTabToggle={onSurfaceTabToggle} />)

      await user.click(screen.getByRole("button", { name: "Search" }))

      expect(onSurfaceTabToggle).not.toHaveBeenCalled()
      expect(screen.getByText("search panel")).toBeInTheDocument()
    })
  })
})
