import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { WorkspaceHeaderActions } from "./WorkspaceHeaderActions"

describe("WorkspaceHeaderActions", () => {
  it("renders Settings as a cog beside Import and calls onSettings", () => {
    const onImport = vi.fn()
    const onSettings = vi.fn()
    render(
      <WorkspaceHeaderActions
        onImport={onImport}
        onSettings={onSettings}
        menuItems={[]}
      />,
    )

    const importBtn = screen.getByRole("button", { name: /^Import$/i })
    const settingsBtn = screen.getByRole("button", { name: /^Settings$/i })
    expect(importBtn.compareDocumentPosition(settingsBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(settingsBtn)
    expect(onSettings).toHaveBeenCalledTimes(1)
    expect(onImport).not.toHaveBeenCalled()
  })

  it("omits the Settings cog when onSettings is not provided", () => {
    render(<WorkspaceHeaderActions onImport={vi.fn()} menuItems={[]} />)
    expect(screen.queryByRole("button", { name: /^Settings$/i })).toBeNull()
  })
})
