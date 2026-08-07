import { describe, it, expect, afterEach, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { ThemeModeProvider } from "@/branding/ThemeMode"
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
      <ThemeModeProvider>
        <OrgProvider>
          <Routes>
            <Route path="/preferences" element={<Preferences />} />
            <Route path="/preferences/:section" element={<Preferences />} />
          </Routes>
        </OrgProvider>
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

  it("renders the Privacy form on its detail route", () => {
    renderAt("/preferences/privacy")
    expect(screen.getByRole("heading", { name: "Privacy" })).toBeInTheDocument()
    expect(screen.getByText("Share usage data")).toBeInTheDocument()
    // Breadcrumb parent crumb links back to the preferences index.
    expect(screen.getByRole("link", { name: /Preferences/ })).toHaveAttribute(
      "href",
      "/preferences",
    )
  })

  it("workspace settings use a right-side layout select and confirm switch", () => {
    renderAt("/preferences/workspace")
    expect(screen.getByRole("heading", { name: "Workspace" })).toBeInTheDocument()
    expect(screen.getByLabelText("Sidebar tab layout")).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: /Confirm before replacing a translation/i })).toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: /Left rail/i })).not.toBeInTheDocument()
  })

  it("translator profile renders one settings row per field", () => {
    renderAt("/preferences/profile")
    expect(screen.getByRole("heading", { name: "Translator profile" })).toBeInTheDocument()
    expect(screen.getByLabelText("Assistant language")).toBeInTheDocument()
    expect(screen.getByLabelText("Age")).toBeInTheDocument()
    expect(screen.getByLabelText("Other relevant information")).toBeInTheDocument()
    expect(screen.queryByText("Profile fields")).not.toBeInTheDocument()
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
})
