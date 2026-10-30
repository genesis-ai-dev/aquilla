import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { __setUpdateAvailableForTests, isEditorPath } from "@/hooks/useUpdateCheck"
import { UpdateIndicator, UpdateOnNavigate } from "./UpdateIndicator"

// Hourly production deploys mean a tab routinely outlives its build. The
// rule from the 2026-10-30 release decision: never reload under an editor
// session, tell the user quietly, and pick the build up on the next page
// change that is not into the editor.

const reload = vi.fn()

beforeEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } })
  __setUpdateAvailableForTests(false)
})
afterEach(() => {
  reload.mockReset()
  __setUpdateAvailableForTests(false)
})

function Go({ to }: { to: string }) {
  const navigate = useNavigate()
  return <button onClick={() => navigate(to)}>go {to}</button>
}

function mount(initial: string) {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[initial]}>
        <UpdateOnNavigate />
        <UpdateIndicator />
        <Routes>
          <Route path="*" element={<><Go to="/project/p1/editor/file/f1" /><Go to="/project/p1/settings" /><Go to="/orgs" /></>} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  )
}

describe("UpdateIndicator", () => {
  it("shows nothing until a newer build is seen, then a mark that reloads on click", async () => {
    mount("/orgs")
    expect(screen.queryByRole("button", { name: "Update available" })).toBeNull()
    act(() => __setUpdateAvailableForTests(true))
    await userEvent.setup().click(screen.getByRole("button", { name: "Update available" }))
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe("UpdateOnNavigate", () => {
  it("does not reload just because a build appeared while the user sits in the editor", () => {
    mount("/project/p1/editor/file/f1")
    act(() => __setUpdateAvailableForTests(true))
    expect(reload).not.toHaveBeenCalled()
  })

  it("does not reload on a navigation into the editor", async () => {
    mount("/orgs")
    act(() => __setUpdateAvailableForTests(true))
    expect(reload).not.toHaveBeenCalled()
    await userEvent.setup().click(screen.getByText("go /project/p1/editor/file/f1"))
    expect(reload).not.toHaveBeenCalled()
  })

  it("reloads once the user leaves the editor for another page", async () => {
    mount("/project/p1/editor/file/f1")
    act(() => __setUpdateAvailableForTests(true))
    await userEvent.setup().click(screen.getByText("go /project/p1/settings"))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("does nothing on navigation while no update is known", async () => {
    mount("/project/p1/editor/file/f1")
    await userEvent.setup().click(screen.getByText("go /orgs"))
    expect(reload).not.toHaveBeenCalled()
  })
})

describe("isEditorPath", () => {
  it("is the editor route with or without a file, and nothing else under a project", () => {
    expect(isEditorPath("/project/p1/editor")).toBe(true)
    expect(isEditorPath("/project/p1/editor/file/f1")).toBe(true)
    expect(isEditorPath("/project/p1/settings")).toBe(false)
    expect(isEditorPath("/project/p1/editors")).toBe(false)
    expect(isEditorPath("/orgs")).toBe(false)
  })
})
