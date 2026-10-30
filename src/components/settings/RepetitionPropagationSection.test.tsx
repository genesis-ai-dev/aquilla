// AQU-2263: "Auto-propagate repetitions" says how many projects set their own
// answer, like every other default on Project defaults, and can put them back.
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { RepetitionPropagationSection } from "./RepetitionPropagationSection"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

function orgSettings(over: Partial<UseOrgSettings> = {}): UseOrgSettings {
  return {
    autoPropagateRepetitions: true,
    patch: vi.fn().mockResolvedValue({ kind: "ok" }),
    autoPropagateRepetitionsOverrides: 0,
    resetAutoPropagateRepetitionsOverrides: vi.fn().mockResolvedValue({ ok: true, cleared: 3 }),
    overrideProjects: { countStructuralCells: null, validationCount: null, validationCountAudio: null, autoPropagateRepetitions: null },
    hasFetched: true,
    ...over,
  } as unknown as UseOrgSettings
}

describe("RepetitionPropagationSection override status", () => {
  it("says every project follows when none set their own", () => {
    render(<RepetitionPropagationSection orgSettings={orgSettings()} canEdit />)
    expect(screen.getByTestId("override-status").textContent).toBe("All projects follow this default.")
  })

  it("says how many set their own, lists them, and Reset puts them back", async () => {
    const settings = orgSettings({
      autoPropagateRepetitionsOverrides: 3,
      overrideProjects: {
        countStructuralCells: null, validationCount: null, validationCountAudio: null,
        autoPropagateRepetitions: { total: 3, projects: [{ id: "p-gen", name: "Genesis" }] },
      },
    })
    render(<MemoryRouter><RepetitionPropagationSection orgSettings={settings} canEdit /></MemoryRouter>)
    await userEvent.click(screen.getByRole("button", { name: "3 projects set their own setting" }))
    expect(screen.getByRole("link", { name: "Genesis" })).toHaveAttribute("href", "/project/p-gen/settings/validation")
    expect(screen.getByText("and 2 more")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Reset to default" }))
    expect(await screen.findByText("3 projects have their own setting")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Reset to the default" }))
    expect(settings.resetAutoPropagateRepetitionsOverrides).toHaveBeenCalledOnce()
    expect(settings.patch).not.toHaveBeenCalled()
  })

  it("after a change, asks whether the projects with their own answer should follow it", async () => {
    const settings = orgSettings({ autoPropagateRepetitionsOverrides: 2 })
    render(<RepetitionPropagationSection orgSettings={settings} canEdit />)
    await userEvent.click(screen.getByRole("switch", { name: "Auto-propagate repetitions" }))
    expect(settings.patch).toHaveBeenCalledWith({ autoPropagateRepetitions: false })
    expect(await screen.findByText("2 projects have their own setting")).toBeInTheDocument()
  })

  it("below the edit gate there is no Reset", () => {
    render(<RepetitionPropagationSection orgSettings={orgSettings({ autoPropagateRepetitionsOverrides: 1 })} canEdit={false} />)
    expect(screen.getByTestId("override-status").textContent).toContain("1 project sets its own setting")
    expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull()
  })
})
