import { useState } from "react"
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { LeftDock, type DockTab } from "./LeftDock"

vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))

function Harness({ initialTab, showAgent = true }: { initialTab: DockTab; showAgent?: boolean }) {
  const [tab, setTab] = useState<DockTab | null>(initialTab)
  return (
    <I18nProvider>
      <LeftDock
        activeTab={tab}
        onActiveTabChange={setTab}
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
})
