// AQU-2265: the temporary note left where a setting used to live.
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { SettingMovedNote } from "./SettingMovedNote"
import { SETTING_MOVED_NOTES_UNTIL, settingMovedNotesShowing } from "@/lib/settings/setting-moved"
import { SettingHighlighter } from "@/hooks/useSettingHighlight"

afterEach(() => vi.useRealTimers())

function Where() {
  const location = useLocation()
  return <div data-testid="where">{location.pathname + location.search}</div>
}

function renderNote(onNavigate?: (href: string) => void) {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/old"]}>
        <SettingHighlighter />
        <Routes>
          <Route
            path="/old"
            element={<SettingMovedNote to="/preferences" target="pref-x" where={["Preferences", "General"]} onNavigate={onNavigate} />}
          />
          <Route path="/preferences" element={<><Where /><div id="pref-x">the setting</div></>} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  )
}

describe("SettingMovedNote", () => {
  it("says where the setting went and links there", () => {
    renderNote()
    expect(screen.getByText("This setting moved to Preferences → General.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("link", { name: /go to it/i }))
    expect(screen.getByTestId("where").textContent).toBe("/preferences?highlight=pref-x")
  })

  it("highlights the setting on arrival", () => {
    renderNote()
    fireEvent.click(screen.getByRole("link", { name: /go to it/i }))
    expect(document.getElementById("pref-x")?.hasAttribute("data-setting-highlight")).toBe(true)
  })

  it("lets a page that guards unsaved changes do the navigating", () => {
    const onNavigate = vi.fn()
    renderNote(onNavigate)
    fireEvent.click(screen.getByRole("link", { name: /go to it/i }))
    expect(onNavigate).toHaveBeenCalledWith("/preferences?highlight=pref-x")
    expect(screen.queryByTestId("where")).toBeNull()
  })

  it("has no dismissal: the one date ends every note", () => {
    renderNote()
    expect(screen.queryByRole("button")).toBeNull()
    const [y, m, d] = SETTING_MOVED_NOTES_UNTIL.split("-").map(Number)
    expect(settingMovedNotesShowing(new Date(y, m - 1, d, 23, 59))).toBe(true)
    expect(settingMovedNotesShowing(new Date(y, m - 1, d + 1, 0, 0))).toBe(false)
  })

  it("shows nothing after the date", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(2026, 11, 1, 9))
    renderNote()
    expect(screen.queryByTestId("setting-moved-note")).toBeNull()
  })
})
