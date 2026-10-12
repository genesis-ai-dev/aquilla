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

  it("says every project follows the default when none set their own number", () => {
    render(<ValidationDefaultsSection orgSettings={orgSettings()} canEdit />)
    const lines = screen.getAllByTestId("override-status")
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line.textContent).toBe("All projects follow this default.")
    expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull()
  })

  it("names the projects with their own number and resets them from the link, any time", async () => {
    const settings = orgSettings({ validationCountOverrides: 1 })
    render(<ValidationDefaultsSection orgSettings={settings} canEdit />)
    const [text, audio] = screen.getAllByTestId("override-status")
    expect(text.textContent).toContain("1 project sets its own number")
    expect(audio.textContent).toBe("All projects follow this default.")
    // No change first: the link opens the same confirmation on its own.
    await userEvent.click(screen.getByRole("button", { name: "Reset to default" }))
    expect(await screen.findByText("1 project has its own number")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Reset to the default" }))
    expect(settings.resetValidationCountOverrides).toHaveBeenCalledExactlyOnceWith("validationCount")
    expect(settings.patch).not.toHaveBeenCalled()
  })

  it("follows the live count: once the reset lands, the line says everyone follows", () => {
    const { rerender } = render(
      <ValidationDefaultsSection orgSettings={orgSettings({ validationCountOverrides: 3 })} canEdit />,
    )
    expect(screen.getAllByTestId("override-status")[0].textContent).toContain("3 projects set their own number")
    rerender(<ValidationDefaultsSection orgSettings={orgSettings({ validationCountOverrides: 0 })} canEdit />)
    expect(screen.getAllByTestId("override-status")[0].textContent).toBe("All projects follow this default.")
  })

  it("shows the count without a Reset link below the maintainer gate", () => {
    render(<ValidationDefaultsSection orgSettings={orgSettings({ validationCountOverrides: 2 })} canEdit={false} />)
    expect(screen.getAllByTestId("override-status")[0].textContent).toBe("2 projects set their own number")
    expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull()
  })

  it("is read-only below the maintainer gate", () => {
    render(<ValidationDefaultsSection orgSettings={orgSettings()} canEdit={false} />)
    expect(textPicker()).toBeDisabled()
  })
})
