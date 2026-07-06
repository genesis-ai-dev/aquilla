import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
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

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeModeProvider>
        <ColorThemeProvider>
          <OrgProvider>
            <Routes>
              <Route path="/preferences" element={<Preferences />} />
              <Route path="/preferences/:section" element={<Preferences />} />
            </Routes>
          </OrgProvider>
        </ColorThemeProvider>
      </ThemeModeProvider>
    </MemoryRouter>,
  )
}

describe("Preferences", () => {
  it("index lists a navigation row per preference section, each linking to its detail page", () => {
    renderAt("/preferences")
    expect(screen.getByRole("heading", { name: "Preferences" })).toBeInTheDocument()
    // The index is a set of nav rows — one per section — each linking to a
    // focused detail sub-page, NOT the forms themselves.
    const rows: [RegExp, string][] = [
      [/Workspace/, "/preferences/workspace"],
      [/Appearance/, "/preferences/appearance"],
      [/Privacy/, "/preferences/privacy"],
      [/Translator profile/, "/preferences/profile"],
      [/AI provider keys/, "/preferences/provider-keys"],
      [/Local models/, "/preferences/local-models"],
      [/Usage/, "/preferences/usage"],
    ]
    for (const [name, href] of rows) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", href)
    }
    // The forms live on the detail pages, so the index doesn't render them.
    expect(screen.queryByText("Share usage data")).not.toBeInTheDocument()
  })

  it("renders the Privacy form on its detail route, with a back link to the index", () => {
    renderAt("/preferences/privacy")
    expect(screen.getByText("Share usage data")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Preferences/ })).toHaveAttribute("href", "/preferences")
  })

  it("renders the personal provider section on its detail route", () => {
    renderAt("/preferences/provider-keys")
    expect(screen.getByText("provider section")).toBeInTheDocument()
  })

  it("renders the Appearance controls on their detail route", () => {
    renderAt("/preferences/appearance")
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument()
  })
})
