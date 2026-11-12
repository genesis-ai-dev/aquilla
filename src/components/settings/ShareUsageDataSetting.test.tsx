// AQU-2263: "Share usage data" is one switch with one description, the same
// in Preferences. Its default is not this ticket's to
// change (AQU-2242).
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { ShareUsageDataSetting } from "./ShareUsageDataSetting"

const ONE_DESCRIPTION =
  "Usage events, like creating a project or exporting, and session recordings that help us diagnose problems. " +
  "Never the contents of your translations or files."

describe("Share usage data, one switch in every door", () => {
  it("the setting reads the same wherever it is", () => {
    render(<I18nProvider><ShareUsageDataSetting enabled onEnabledChange={vi.fn()} /></I18nProvider>)
    expect(screen.getByRole("switch", { name: "Share usage data" })).toBeInTheDocument()
    expect(screen.getByText(ONE_DESCRIPTION)).toBeInTheDocument()
  })

  it("lets users change the setting in Preferences", async () => {
    const change = vi.fn()
    render(<I18nProvider><ShareUsageDataSetting enabled onEnabledChange={change} /></I18nProvider>)
    await userEvent.click(screen.getByRole("switch", { name: "Share usage data" }))
    expect(change).toHaveBeenCalledWith(false)
  })

  it("says what is lost when it is off", () => {
    render(<I18nProvider><ShareUsageDataSetting enabled={false} onEnabledChange={vi.fn()} /></I18nProvider>)
    expect(screen.getByText(/we may not be able to help diagnose problems/)).toBeInTheDocument()
  })
})
