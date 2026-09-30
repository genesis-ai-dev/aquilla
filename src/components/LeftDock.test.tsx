import { useState } from "react"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useDockTabs } from "@/hooks/useDockTabs"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { LeftDock, type DockTab } from "./LeftDock"

const preferences = vi.hoisted(() => ({ position: "top" as "top" | "left" }))
vi.mock("@/hooks/useDockRailPosition", () => ({
  useDockRailPosition: () => preferences,
}))
vi.mock("@/components/AccountSwitcher", () => ({
  AccountSwitcher: () => null,
}))

const panels = {
  filesPanel: <div>Files panel</div>,
  agentPanel: <div>Conversations panel</div>,
  searchPanel: <div>Search panel</div>,
}

function ControlledDock({ mounted = true }: { mounted?: boolean }) {
  const { activeTab, setActiveTab, lastOpenTab } = useDockTabs("files")
  return (
    <>
      <button type="button" onClick={() => setActiveTab(null)}>Hide panel externally</button>
      {mounted && (
        <LeftDock
          {...panels}
          activeTab={activeTab}
          restoreTab={lastOpenTab}
          onActiveTabChange={setActiveTab}
        />
      )}
    </>
  )
}

beforeAll(() => {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  })
})
beforeEach(() => { preferences.position = "top" })

describe("LeftDock visibility", () => {
  it.each(["top", "left"] as const)("restores conversations in the %s rail layout", (position) => {
    preferences.position = position
    render(<LeftDock {...panels} />)
    fireEvent.click(screen.getByRole("button", { name: "Agent" }))
    expect(screen.getByText("Conversations panel")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Agent" }))
    expect(screen.queryByText("Conversations panel")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }))
    expect(screen.getByText("Conversations panel")).toBeInTheDocument()
    expect(screen.queryByText("Files panel")).not.toBeInTheDocument()
  })

  it("preserves the controlled panel across a responsive dock unmount", () => {
    const view = render(<ControlledDock />)
    fireEvent.click(screen.getByRole("button", { name: "Agent" }))
    fireEvent.click(screen.getByRole("button", { name: "Hide panel externally" }))
    view.rerender(<ControlledDock mounted={false} />)
    view.rerender(<ControlledDock />)
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }))
    expect(screen.getByText("Conversations panel")).toBeInTheDocument()
  })

  it("honors the initial panel and falls back when a remembered panel is unavailable", () => {
    const view = render(<LeftDock {...panels} defaultTab="voices" voicesPanel={<div>Voices panel</div>} />)
    expect(screen.getByText("Voices panel")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Voices" }))
    view.rerender(<LeftDock {...panels} defaultTab="voices" />)
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }))
    expect(screen.getByText("Files panel")).toBeInTheDocument()
  })
})

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
