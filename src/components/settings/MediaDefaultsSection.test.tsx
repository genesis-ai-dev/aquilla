// AQU-1768: the org's defaults for the timeline and recording settings, on
// the Project defaults page.
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MediaDefaultsSection } from "./MediaDefaultsSection"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

function orgSettings(over: Partial<UseOrgSettings> = {}): UseOrgSettings {
  return {
    patch: vi.fn().mockResolvedValue({ kind: "ok" }),
    resetMediaDefaultOverrides: vi.fn().mockResolvedValue({ ok: true, cleared: 1 }),
    mediaDefaults: {},
    mediaDefaultOverrides: {},
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
    expect(isOn(trackSwitch())).toBe(false)
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
    await userEvent.click(trackSwitch())
    expect(settings.patch).toHaveBeenCalledExactlyOnceWith({ allowTrackEditing: true })
  })

  it("saves a picked tier as the org default", async () => {
    const settings = orgSettings()
    render(<MediaDefaultsSection orgSettings={settings} canEdit />)
    await userEvent.click(tierPicker())
    await userEvent.click(await screen.findByRole("option", { name: "Contributor (400)" }))
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
})
