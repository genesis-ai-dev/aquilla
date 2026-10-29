// AQU-1768: the org's defaults for the timeline and recording settings, on
// the Project defaults page.
import { describe, it, expect, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import userEvent from "@testing-library/user-event"
import { MediaDefaultsSection } from "./MediaDefaultsSection"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

function orgSettings(over: Partial<UseOrgSettings> = {}): UseOrgSettings {
  return {
    patch: vi.fn().mockResolvedValue({ kind: "ok" }),
    resetMediaDefaultOverrides: vi.fn().mockResolvedValue({ ok: true, cleared: 1 }),
    mediaDefaults: {},
    mediaDefaultOverrides: {},
    mediaOverrideProjects: {},
    ...over,
  } as unknown as UseOrgSettings
}

const lockSwitch = () => screen.getByRole("switch", { name: "Lock the timings against dragging" })
const trackSwitch = () => screen.getByRole("switch", { name: "Let maintainers add and edit timeline tracks" })
const tierPicker = () => screen.getByRole("combobox", { name: "Who can add and remove cells" })
const floorPicker = () => screen.getByRole("combobox", { name: "Minimum role to validate recordings" })
const isOn = (el: HTMLElement) => el.getAttribute("aria-checked") === "true" || el.hasAttribute("data-checked")
const isDisabled = (el: HTMLElement) =>
  el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true" || el.hasAttribute("data-disabled")

describe("MediaDefaultsSection", () => {
  it("shows the built-in defaults when the org set none", () => {
    render(<MediaDefaultsSection orgSettings={orgSettings()} canEdit />)
    expect(isOn(lockSwitch())).toBe(true)
    // AQU-2214: track editing's built-in default is ON. This switch is what an
    // org admin reads the built-in default off, so it has to agree with the
    // project settings page and the write perimeter.
    expect(isOn(trackSwitch())).toBe(true)
    expect(tierPicker().textContent).toContain("No one")
    expect(floorPicker().textContent).toContain("Reviewer")
  })

  it("shows the org's stored choices", () => {
    render(
      <MediaDefaultsSection
        orgSettings={orgSettings({
          mediaDefaults: { timingLocked: false, cellEditingFloor: "project_lead", validationRoleFloorAudio: "maintainer" },
        })}
        canEdit
      />,
    )
    expect(isOn(lockSwitch())).toBe(false)
    expect(tierPicker().textContent).toContain("Project lead")
    expect(floorPicker().textContent).toContain("Maintainer")
  })

  it("saves a switch as the org default", async () => {
    const settings = orgSettings()
    render(<MediaDefaultsSection orgSettings={settings} canEdit />)
    // Starts ON (AQU-2214), so the click an org admin makes here is the one
    // that turns track editing off for every project that follows the default.
    await userEvent.click(trackSwitch())
    expect(settings.patch).toHaveBeenCalledExactlyOnceWith({ allowTrackEditing: false })
  })

  it("saves the switch back on from an org that turned it off", async () => {
    const settings = orgSettings({ mediaDefaults: { allowTrackEditing: false } })
    render(<MediaDefaultsSection orgSettings={settings} canEdit />)
    expect(isOn(trackSwitch())).toBe(false)
    await userEvent.click(trackSwitch())
    expect(settings.patch).toHaveBeenCalledExactlyOnceWith({ allowTrackEditing: true })
  })

  it("saves a picked tier as the org default", async () => {
    const settings = orgSettings()
    render(<MediaDefaultsSection orgSettings={settings} canEdit />)
    await userEvent.click(tierPicker())
    await userEvent.click(await screen.findByRole("option", { name: "Contributor" }))
    expect(settings.patch).toHaveBeenCalledExactlyOnceWith({ cellEditingFloor: "contributor" })
  })

  it("offers to reset projects with their own value, and resets only that key", async () => {
    const settings = orgSettings({ mediaDefaultOverrides: { timingLocked: 3 } })
    render(<MediaDefaultsSection orgSettings={settings} canEdit />)
    await userEvent.click(lockSwitch())
    expect(await screen.findByText("3 projects have their own setting")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Reset to the default" }))
    expect(settings.resetMediaDefaultOverrides).toHaveBeenCalledExactlyOnceWith("timingLocked")
  })

  it("does not ask when no project has its own value", async () => {
    const settings = orgSettings({ mediaDefaultOverrides: { allowTrackEditing: 2 } })
    render(<MediaDefaultsSection orgSettings={settings} canEdit />)
    await userEvent.click(lockSwitch())
    expect(screen.queryByText(/have their own setting/)).toBeNull()
  })

  it("is read-only below the maintainer gate", () => {
    render(<MediaDefaultsSection orgSettings={orgSettings()} canEdit={false} />)
    expect(isDisabled(lockSwitch())).toBe(true)
    expect(isDisabled(tierPicker())).toBe(true)
  })
  it("says under each default who follows it, and the link opens the reset confirmation", async () => {
    const settings = orgSettings({ mediaDefaultOverrides: { timingLocked: 2 } })
    render(<MediaDefaultsSection orgSettings={settings} canEdit />)
    const lines = screen.getAllByTestId("override-status").map((el) => el.textContent)
    expect(lines).toHaveLength(5)
    expect(lines.filter((l) => l === "All projects follow this default.")).toHaveLength(4)
    expect(lines.some((l) => l?.startsWith("2 projects set their own setting"))).toBe(true)
    await userEvent.click(screen.getByRole("button", { name: "Reset to default" }))
    expect(await screen.findByText("2 projects have their own setting")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Reset to the default" }))
    expect(settings.resetMediaDefaultOverrides).toHaveBeenCalledExactlyOnceWith("timingLocked")
    expect(settings.patch).not.toHaveBeenCalled()
  })

  it("each count opens its projects, each linking to where that setting is set (AQU-1768)", async () => {
    const settings = orgSettings({
      mediaDefaultOverrides: { timingLocked: 2, cellEditingFloor: 1, allowSelfValidationAudio: 1 },
      mediaOverrideProjects: {
        timingLocked: { total: 2, projects: [{ id: "p-gen", name: "Genesis" }, { id: "p-exo", name: "Exodus" }] },
        cellEditingFloor: { total: 1, projects: [{ id: "p-lev", name: "Leviticus" }] },
        allowSelfValidationAudio: { total: 1, projects: [{ id: "p-num", name: "Numbers" }] },
      },
    })
    render(<MemoryRouter><MediaDefaultsSection orgSettings={settings} canEdit /></MemoryRouter>)
    const [lockLine, tierLine, selfLine] = screen.getAllByTestId("override-status").filter((el) => /set their own|sets its own/.test(el.textContent ?? ""))
    await userEvent.click(within(lockLine).getByRole("button", { name: "2 projects set their own setting" }))
    expect(within(lockLine).getByRole("link", { name: "Genesis" })).toHaveAttribute("href", "/project/p-gen/settings/audio-media")
    expect(within(lockLine).getByRole("link", { name: "Exodus" })).toHaveAttribute("href", "/project/p-exo/settings/audio-media")
    await userEvent.click(within(tierLine).getByRole("button", { name: "1 project sets its own setting" }))
    expect(within(tierLine).getByRole("link", { name: "Leviticus" })).toHaveAttribute("href", "/project/p-lev/settings/general")
    await userEvent.click(within(selfLine).getByRole("button", { name: "1 project sets its own setting" }))
    expect(within(selfLine).getByRole("link", { name: "Numbers" })).toHaveAttribute("href", "/project/p-num/settings/validation")
    // The reset still sits beside each count.
    expect(within(lockLine).getByRole("button", { name: "Reset to default" })).toBeInTheDocument()
  })
})
