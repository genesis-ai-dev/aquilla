// AQU-1771: the org's default number of required validators, text and audio,
// on the Project defaults page.
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ValidationDefaultsSection } from "./ValidationDefaultsSection"
import type { UseOrgSettings } from "@/hooks/useOrgSettings"

function orgSettings(over: Partial<UseOrgSettings> = {}): UseOrgSettings {
  return {
    patch: vi.fn().mockResolvedValue({ kind: "ok" }),
    resetValidationCountOverrides: vi.fn().mockResolvedValue({ ok: true, cleared: 1 }),
    validationCountDefault: null,
    validationCountAudioDefault: 3,
    validationCountOverrides: 0,
    validationCountAudioOverrides: 0,
    ...over,
  } as unknown as UseOrgSettings
}

const textPicker = () => screen.getByRole("combobox", { name: "Required validators (text)" })

describe("ValidationDefaultsSection", () => {
  it("shows 1 when the org set no default, and the stored audio default", () => {
    render(<ValidationDefaultsSection orgSettings={orgSettings()} canEdit />)
    expect(textPicker().textContent).toContain("1")
    expect(screen.getByRole("combobox", { name: "Required validators (audio)" }).textContent).toContain("3")
  })

  it("saves the picked number as the org default", async () => {
    const settings = orgSettings()
    render(<ValidationDefaultsSection orgSettings={settings} canEdit />)
    await userEvent.click(textPicker())
    await userEvent.click(await screen.findByRole("option", { name: "2" }))
    expect(settings.patch).toHaveBeenCalledExactlyOnceWith({ validationCount: 2 })
  })

  it("offers to reset projects with their own number, and resets only that key", async () => {
    const settings = orgSettings({ validationCountOverrides: 2 })
    render(<ValidationDefaultsSection orgSettings={settings} canEdit />)
    await userEvent.click(textPicker())
    await userEvent.click(await screen.findByRole("option", { name: "2" }))
    expect(await screen.findByText("2 projects have their own number")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Reset to the default" }))
    expect(settings.resetValidationCountOverrides).toHaveBeenCalledExactlyOnceWith("validationCount")
  })

  it("is read-only below the maintainer gate", () => {
    render(<ValidationDefaultsSection orgSettings={orgSettings()} canEdit={false} />)
    expect(textPicker()).toBeDisabled()
  })
})
