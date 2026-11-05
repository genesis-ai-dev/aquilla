import { useEffect } from "react"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { __setUpdateAvailableForTests, isEditorPath, isTypingSomewhere } from "@/hooks/useUpdateCheck"
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

// A navigation that does NOT move focus — what a keyboard shortcut, a
// redirect, or the agent's "take me to this cell" does while the dock
// composer still holds the caret (AQU-2335).
let navigateWithoutFocusChange: ((to: string) => void) | null = null
function NavHandle() {
  const navigate = useNavigate()
  useEffect(() => {
    navigateWithoutFocusChange = navigate
  }, [navigate])
  return null
}

function mount(initial: string) {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[initial]}>
        <UpdateOnNavigate />
        <UpdateIndicator />
        <NavHandle />
        {/* stands in for the agent composer / a cell editor: the dock is
            outside the routed pane, so it keeps focus across a route change */}
        <div contentEditable data-testid="composer" suppressContentEditableWarning />
        <input data-testid="field" />
        <input type="checkbox" data-testid="tickbox" />
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

describe("UpdateOnNavigate — input in flight (AQU-2335)", () => {
  it("does not reload on a navigation that lands while the caret is in the agent composer", () => {
    mount("/project/p1/agent")
    act(() => __setUpdateAvailableForTests(true))
    screen.getByTestId("composer").focus()
    act(() => navigateWithoutFocusChange?.("/project/p1/settings"))
    expect(reload).not.toHaveBeenCalled()
  })

  it("does not reload on a navigation that lands while the caret is in a text field", () => {
    mount("/orgs")
    act(() => __setUpdateAvailableForTests(true))
    screen.getByTestId("field").focus()
    act(() => navigateWithoutFocusChange?.("/project/p1/settings"))
    expect(reload).not.toHaveBeenCalled()
  })

  it("takes the build on the next navigation once the caret has left the field", () => {
    mount("/orgs")
    act(() => __setUpdateAvailableForTests(true))
    screen.getByTestId("field").focus()
    act(() => navigateWithoutFocusChange?.("/project/p1/settings"))
    expect(reload).not.toHaveBeenCalled()
    act(() => screen.getByTestId("field").blur())
    act(() => navigateWithoutFocusChange?.("/orgs"))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("still reloads when the focused element is not typable", () => {
    mount("/orgs")
    act(() => __setUpdateAvailableForTests(true))
    screen.getByTestId("tickbox").focus()
    act(() => navigateWithoutFocusChange?.("/project/p1/settings"))
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe("isTypingSomewhere", () => {
  it("is true for text inputs, textareas, contenteditable and role=textbox", () => {
    const cases: Array<[string, boolean]> = [
      ['<input />', true],
      ['<input type="EMAIL" />', true],
      ['<input type="checkbox" />', false],
      ['<input type="submit" />', false],
      ['<textarea></textarea>', true],
      ['<div contenteditable="true"></div>', true],
      ['<div role="textbox" tabindex="0"></div>', true],
      ['<button></button>', false],
    ]
    for (const [html, expected] of cases) {
      const host = document.createElement("div")
      host.innerHTML = html
      document.body.append(host)
      const el = host.firstElementChild as HTMLElement
      el.focus()
      expect(isTypingSomewhere(), html).toBe(expected)
      host.remove()
    }
  })

  it("is false with nothing focused", () => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(isTypingSomewhere()).toBe(false)
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
