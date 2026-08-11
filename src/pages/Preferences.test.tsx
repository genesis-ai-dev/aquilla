import { describe, it, expect, afterEach, vi } from "vitest"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { ThemeModeProvider } from "@/branding/ThemeMode"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
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

afterEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  document.documentElement.classList.remove("dark")
})

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider>
        <ThemeModeProvider>
          <OrgProvider>
            <Routes>
              <Route path="/preferences" element={<Preferences />} />
              <Route path="/preferences/:section" element={<Preferences />} />
            </Routes>
          </OrgProvider>
        </ThemeModeProvider>
      </I18nProvider>
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
    expect(screen.getByRole("heading", { name: "Privacy" })).toBeInTheDocument()
    expect(screen.getByText("Share usage data")).toBeInTheDocument()
    // Both the breadcrumb's parent crumb and the dedicated BackLink render a
    // "Preferences" link back to the index, so more than one match is expected —
    // assert at least one of them points at /preferences rather than picking a
    // single one via getByRole (which throws on ambiguous matches).
    const preferencesLinks = screen.getAllByRole("link", { name: /Preferences/ })
    expect(preferencesLinks.some((link) => link.getAttribute("href") === "/preferences")).toBe(true)
  })

  it("renders the personal provider section on its detail route", () => {
    renderAt("/preferences/provider-keys")
    expect(screen.getByText("provider section")).toBeInTheDocument()
  })

  it("renders the Appearance controls on their detail route", () => {
    renderAt("/preferences/appearance")
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "System" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tab", { name: "Light" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Dark" })).toBeInTheDocument()
    expect(screen.queryByText("Accent color")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("tab", { name: "Dark" }))
    expect(window.localStorage.getItem("codex-theme")).toBe("dark")
    expect(document.documentElement).toHaveClass("dark")
  })

  it("offers a UI-language control", async () => {
    renderAt("/preferences/language")
    // AppShell also mounts a global chrome switcher (Task 6), so on this page
    // there are two elements labelled "Language" — the persistent chrome one
    // and this page's dedicated row. Scope to <main> for the row under test.
    const main = screen.getByRole("main")
    const select = await within(main).findByLabelText("Language")
    expect(select).toBeInTheDocument()
    // The switcher must list endonyms, not English names — a Burmese speaker
    // looking for their language will not scan for the word "Burmese".
    expect(within(main).getByRole("option", { name: "မြန်မာ" })).toBeInTheDocument()
  })
})
