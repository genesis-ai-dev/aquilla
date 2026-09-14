import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { useDockTabs } from "@/hooks/useDockTabs"
import { LeftDock } from "./LeftDock"

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
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar panel" }))
    expect(screen.getByText("Conversations panel")).toBeInTheDocument()
    expect(screen.queryByText("Files panel")).not.toBeInTheDocument()
  })

  it("preserves the controlled panel across a responsive dock unmount", () => {
    const view = render(<ControlledDock />)
    fireEvent.click(screen.getByRole("button", { name: "Agent" }))
    fireEvent.click(screen.getByRole("button", { name: "Hide panel externally" }))
    view.rerender(<ControlledDock mounted={false} />)
    view.rerender(<ControlledDock />)
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar panel" }))
    expect(screen.getByText("Conversations panel")).toBeInTheDocument()
  })

  it("honors the initial panel and falls back when a remembered panel is unavailable", () => {
    const view = render(<LeftDock {...panels} defaultTab="voices" voicesPanel={<div>Voices panel</div>} />)
    expect(screen.getByText("Voices panel")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Voices" }))
    view.rerender(<LeftDock {...panels} defaultTab="voices" />)
    fireEvent.click(screen.getByRole("button", { name: "Show sidebar panel" }))
    expect(screen.getByText("Files panel")).toBeInTheDocument()
  })
})
