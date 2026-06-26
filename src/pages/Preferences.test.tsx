import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { ThemeModeProvider } from "@/branding/ThemeMode"
import { ColorThemeProvider } from "@/branding/ColorTheme"
import { Preferences } from "./Preferences"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }),
}))
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: vi.fn(async () => []) }))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
vi.mock("@/hooks/useAnalyticsConsent", () => ({
  useAnalyticsConsent: () => ({ enabled: true, setEnabled: vi.fn() }),
}))
vi.mock("@/hooks/useDockRailPosition", () => ({
  useDockRailPosition: () => ({ position: "left", setPosition: vi.fn() }),
}))
vi.mock("@/components/settings/PersonalProviderSection", () => ({
  PersonalProviderSection: () => <div>provider section</div>,
}))

afterEach(() => vi.clearAllMocks())

describe("Preferences", () => {
  it("renders personal preference sections", () => {
    render(
      <MemoryRouter>
        <ThemeModeProvider>
          <ColorThemeProvider>
            <OrgProvider><Preferences /></OrgProvider>
          </ColorThemeProvider>
        </ThemeModeProvider>
      </MemoryRouter>,
    )
    expect(screen.getByRole("heading", { name: "Preferences" })).toBeInTheDocument()
    expect(screen.getByText("Sidebar tab layout")).toBeInTheDocument()
    expect(screen.getByText("Share usage data")).toBeInTheDocument()
    expect(screen.getByText("provider section")).toBeInTheDocument()
    // Appearance controls surfaced via the existing branding components.
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument()
  })
})
