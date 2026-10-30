// AQU-2263: "Share usage data" is one switch with one description, the same
// in Preferences and in onboarding. Its default is not this ticket's to
// change (AQU-2242).
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { PrivacyStep } from "@/components/onboarding/steps/PrivacyStep"
import { ShareUsageDataSetting } from "./ShareUsageDataSetting"

const consent = vi.hoisted(() => ({ enabled: true, setEnabled: vi.fn() }))
vi.mock("@/hooks/useAnalyticsConsent", () => ({ useAnalyticsConsent: () => consent }))

const ONE_DESCRIPTION =
  "Usage events, like creating a project or exporting, and session recordings that help us diagnose problems. " +
  "Never the contents of your translations or files."

describe("Share usage data, one switch in every door", () => {
  it("the setting reads the same wherever it is", () => {
    render(<I18nProvider><ShareUsageDataSetting enabled onEnabledChange={vi.fn()} /></I18nProvider>)
    expect(screen.getByRole("switch", { name: "Share usage data" })).toBeInTheDocument()
    expect(screen.getByText(ONE_DESCRIPTION)).toBeInTheDocument()
  })

  it("onboarding uses the same switch and the same description", async () => {
    render(<I18nProvider><PrivacyStep onNext={vi.fn()} onBack={vi.fn()} /></I18nProvider>)
    expect(screen.getByTestId("share-usage-data")).toBeInTheDocument()
    expect(screen.getByText(ONE_DESCRIPTION)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("switch", { name: "Share usage data" }))
    expect(consent.setEnabled).toHaveBeenCalledWith(false)
  })

  it("says what is lost when it is off", () => {
    render(<I18nProvider><ShareUsageDataSetting enabled={false} onEnabledChange={vi.fn()} /></I18nProvider>)
    expect(screen.getByText(/we may not be able to help diagnose problems/)).toBeInTheDocument()
  })
})
