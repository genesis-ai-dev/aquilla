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
    expect(settingsBtn.closest("[data-slot=button-group]")).toBeNull()
    expect(importBtn.closest("[data-slot=button-group]")).not.toBeNull()

    fireEvent.click(settingsBtn)
    expect(onSettings).toHaveBeenCalledTimes(1)
    expect(onImport).not.toHaveBeenCalled()
  })

  it("omits the Settings cog when onSettings is not provided", () => {
    render(<WorkspaceHeaderActions onImport={vi.fn()} menuItems={[]} />)
    expect(screen.queryByRole("button", { name: /^Settings$/i })).toBeNull()
  })

  // AQU-481: a viewer could open the full Import type-picker — every importer
  // clickable — because this button had no role gate at all. It must stay
  // VISIBLE (so the user can learn why it's unavailable) but be inert.
  describe("AQU-481: import gated for below-floor roles", () => {
    it("disables Import and keeps it visible when a denial reason is given", () => {
      const onImport = vi.fn()
      render(
        <WorkspaceHeaderActions
          onImport={onImport}
          menuItems={[]}
          importDisabledReason="Viewers cannot perform this action — you need at least Project lead access."
        />,
      )

      const importBtn = screen.getByRole("button", { name: /^Import$/i })
      expect(importBtn).toBeDisabled()
      fireEvent.click(importBtn)
      expect(onImport).not.toHaveBeenCalled()
    })

    it("leaves Import enabled when no denial reason is given", () => {
      const onImport = vi.fn()
      render(<WorkspaceHeaderActions onImport={onImport} menuItems={[]} />)

      const importBtn = screen.getByRole("button", { name: /^Import$/i })
      expect(importBtn).not.toBeDisabled()
      fireEvent.click(importBtn)
      expect(onImport).toHaveBeenCalledTimes(1)
    })

    it("treats an explicit null reason as allowed (the fail-open role case)", () => {
      // A local/unsynced project resolves no role, so canPerform fails open and
      // ProjectWorkspace passes null — that must not disable the button.
      const onImport = vi.fn()
      render(
        <WorkspaceHeaderActions onImport={onImport} menuItems={[]} importDisabledReason={null} />,
      )
      const importBtn = screen.getByRole("button", { name: /^Import$/i })
      expect(importBtn).not.toBeDisabled()
      fireEvent.click(importBtn)
      expect(onImport).toHaveBeenCalledTimes(1)
    })
  })
})
