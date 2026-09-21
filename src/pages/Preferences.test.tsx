import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { ThemeModeProvider } from "@/branding/ThemeMode"
import { FontSizeProvider, FONT_SIZE_STORAGE_KEY } from "@/branding/FontSize"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { Preferences, PreferencesDialog } from "./Preferences"

// AQU-1277: OrgProvider loads the project directory via
// fetchAccessibleProjectsResult, which catches its own network errors. Unmocked
// it reached production identity for real while the tests stayed green.
vi.mock("@/lib/sync/cloud-projects", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/cloud-projects")>()),
  fetchAccessibleProjectsResult: vi.fn(async () => ({ ok: true as const, projects: [] })),
}))

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
  document.documentElement.style.removeProperty("font-size")
})

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider>
        <ThemeModeProvider>
          <FontSizeProvider>
            <OrgProvider>
              <Routes>
                <Route path="/preferences" element={<Preferences />} />
                <Route path="/preferences/:section" element={<Preferences />} />
              </Routes>
            </OrgProvider>
          </FontSizeProvider>
        </ThemeModeProvider>
      </I18nProvider>
    </MemoryRouter>,
  )
}

describe("Preferences", () => {
  it("index shows General controls inline, then nav rows for nested sections", () => {
    renderAt("/preferences")
    expect(screen.getByRole("heading", { name: "Preferences" })).toBeInTheDocument()
    expect(screen.getByText("General")).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Theme" })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "App font size" })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "UI language" })).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "Share usage data" })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /Appearance/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /^Language$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /Privacy/ })).not.toBeInTheDocument()

    const rows: [RegExp, string][] = [
      [/Workspace/, "/preferences/workspace"],
      [/Translator profile/, "/preferences/profile"],
      [/AI provider keys/, "/preferences/provider-keys"],
      [/Local models/, "/preferences/local-models"],
      [/Usage/, "/preferences/usage"],
    ]
    for (const [name, href] of rows) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", href)
    }
  })

  it("redirects the retired Appearance detail route to the index", () => {
    renderAt("/preferences/appearance")
    expect(screen.getByRole("heading", { name: "Preferences" })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Theme" })).toBeInTheDocument()
  })

  it("redirects the retired Language detail route to the index", () => {
    renderAt("/preferences/language")
    expect(screen.getByRole("heading", { name: "Preferences" })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "UI language" })).toBeInTheDocument()
  })

  it("redirects the retired Privacy detail route to the index", () => {
    renderAt("/preferences/privacy")
    expect(screen.getByRole("heading", { name: "Preferences" })).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "Share usage data" })).toBeInTheDocument()
  })

  it("workspace settings use a right-side layout select and confirm switch", () => {
    renderAt("/preferences/workspace")
    expect(screen.getByRole("heading", { name: "Workspace" })).toBeInTheDocument()
    expect(screen.getByLabelText("Editor sidebar tab layout")).toBeInTheDocument()
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

  it("renders Appearance controls inline on the preferences index", async () => {
    renderAt("/preferences")
    const trigger = screen.getByRole("combobox", { name: "Theme" })
    expect(trigger).toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "System" })).not.toBeInTheDocument()
    expect(screen.queryByText("Accent color")).not.toBeInTheDocument()

    await userEvent.click(trigger)
    await userEvent.click(await screen.findByRole("option", { name: "Dark" }))
    expect(window.localStorage.getItem("aquilla-theme")).toBe("dark")
    expect(document.documentElement).toHaveClass("dark")
  })

  it("offers a UI-language select with an accessible name distinct from the chrome switcher", async () => {
    renderAt("/preferences")
    // AppShell also mounts a global chrome switcher (finding 8), so this page
    // has TWO language controls on screen at once. A screen reader announcing
    // the same name twice with nothing to tell them apart is the bug — so each
    // control must have its own accessible name. Settings uses a Select
    // (combobox); chrome keeps the globe button.
    const trigger = await screen.findByRole("combobox", { name: "UI language" })
    expect(trigger).toBeInTheDocument()

    expect(screen.queryAllByRole("button", { name: "Language" })).toHaveLength(0)
    expect(screen.queryAllByRole("combobox", { name: "Language" })).toHaveLength(0)
    expect(screen.getAllByRole("combobox", { name: "UI language" })).toHaveLength(1)
    expect(screen.getAllByRole("button", { name: "Quick language switch" })).toHaveLength(1)

    // The picker must list endonyms, not English names — a Burmese speaker
    // looking for their language will not scan for the word "Burmese".
    await userEvent.click(trigger)
    expect(await screen.findByRole("option", { name: /မြန်မာ/ })).toBeInTheDocument()
  })

  it("shows Default app font size for a fresh user and scales the root immediately", async () => {
    renderAt("/preferences")
    const trigger = screen.getByRole("combobox", { name: "App font size" })
    expect(trigger).toHaveTextContent("Default")
    expect(document.documentElement.style.fontSize).toBe("")

    await userEvent.click(trigger)
    await userEvent.click(await screen.findByRole("option", { name: "Large" }))
    expect(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBe("large")
    expect(document.documentElement.style.fontSize).toBe("18px")

    await userEvent.click(screen.getByRole("combobox", { name: "App font size" }))
    await userEvent.click(await screen.findByRole("option", { name: "Default" }))
    expect(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBe("default")
    expect(document.documentElement.style.fontSize).toBe("")
  })

  it("applies Small and Extra Large root sizes from the General card", async () => {
    renderAt("/preferences")
    const trigger = screen.getByRole("combobox", { name: "App font size" })

    await userEvent.click(trigger)
    await userEvent.click(await screen.findByRole("option", { name: "Small" }))
    expect(document.documentElement.style.fontSize).toBe("14px")

    await userEvent.click(screen.getByRole("combobox", { name: "App font size" }))
    await userEvent.click(await screen.findByRole("option", { name: "Extra Large" }))
    expect(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBe("extra-large")
    expect(document.documentElement.style.fontSize).toBe("20px")
  })
})

describe("PreferencesDialog", () => {
  it("renders the shared preferences UI in a route-backed modal and closes to its origin", async () => {
    const backgroundLocation = {
      pathname: "/project/p1/editor",
      search: "",
      hash: "",
      state: null,
      key: "editor",
    }
    render(
      <MemoryRouter
        initialIndex={1}
        initialEntries={[
          backgroundLocation,
          {
            pathname: "/preferences",
            state: { backgroundLocation, preferencesModalDepth: 1 },
          },
        ]}
      >
        <I18nProvider>
          <ThemeModeProvider>
            <FontSizeProvider>
              <OrgProvider>
                <Routes>
                  <Route path="/project/:id/editor" element={<div data-testid="editor-background" />} />
                  <Route path="/preferences" element={<PreferencesDialog />} />
                  <Route path="/preferences/:section" element={<PreferencesDialog />} />
                </Routes>
              </OrgProvider>
            </FontSizeProvider>
          </ThemeModeProvider>
        </I18nProvider>
      </MemoryRouter>,
    )

    const dialog = screen.getByTestId("preferences-dialog")
    expect(dialog).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 1, name: "Preferences" })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Theme" })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "App font size" })).toHaveTextContent("Default")

    await userEvent.click(screen.getByRole("button", { name: /close/i }))
    expect(screen.getByTestId("editor-background")).toBeInTheDocument()
    expect(screen.queryByTestId("preferences-dialog")).not.toBeInTheDocument()
  })
})
