// AQU-1771: the "who follows this" line under the org's headings default.
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StructuralCellsSection } from "./StructuralCellsSection"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

function orgSettings(over: Partial<UseOrgSettings> = {}): UseOrgSettings {
  return {
    countStructuralCells: true,
    patch: vi.fn().mockResolvedValue({ kind: "ok" }),
    countStructuralOverrides: 0,
    resetCountStructuralOverrides: vi.fn().mockResolvedValue({ ok: true, cleared: 1 }),
    ...over,
  } as unknown as UseOrgSettings
}

describe("StructuralCellsSection override status", () => {
  it("says every project follows when none set their own", () => {
    render(<StructuralCellsSection orgSettings={orgSettings()} canEdit />)
    expect(screen.getByTestId("override-status").textContent).toBe("All projects follow this default.")
  })

  it("names projects with their own setting, and the link opens the reset confirmation", async () => {
    const settings = orgSettings({ countStructuralOverrides: 2 })
    render(<StructuralCellsSection orgSettings={settings} canEdit />)
    expect(screen.getByTestId("override-status").textContent).toContain("2 projects set their own setting")
    await userEvent.click(screen.getByRole("button", { name: "Reset to default" }))
    expect(await screen.findByText("2 projects have their own setting")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Reset to the default" }))
    expect(settings.resetCountStructuralOverrides).toHaveBeenCalledOnce()
    expect(settings.patch).not.toHaveBeenCalled()
  })
})
