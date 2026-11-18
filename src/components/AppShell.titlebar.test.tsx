/**
 * AppShell under the macOS overlay title bar (desktop): the traffic-light
 * corner stays clear in every layout, and the header and sidebar chrome row
 * are the window's drag handle. Split from AppShell.test.tsx for size.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { act, render, screen, fireEvent, within, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AppShell } from "./AppShell"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { __resetMacTitlebarStoreForTests, type MacTitlebarOverlay } from "@/hooks/useMacTitlebarOverlay"

const titlebar = vi.hoisted(() => ({ value: { overlay: false, inset: false } as MacTitlebarOverlay }))
const tauriWindow = vi.hoisted(() => ({
  startDragging: vi.fn(async () => {}),
}))
const tauriInvoke = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => tauriWindow }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriInvoke }))
// Forces the shell's text direction without loading an RTL locale's catalog.
const forceRtl = vi.hoisted(() => ({ value: false }))
vi.mock("@/lib/i18n/I18nProvider", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/i18n/I18nProvider")>()
  return {
    ...actual,
    useI18nOptional: () => {
      const value = actual.useI18nOptional()
      return value && forceRtl.value ? { ...value, dir: "rtl" as const } : value
    },
  }
})
vi.mock("@/hooks/useMacTitlebarOverlay", async (importActual) => ({
  ...(await importActual<typeof import("@/hooks/useMacTitlebarOverlay")>()),
  useMacTitlebarOverlay: () => titlebar.value,
}))

const originalMatchMedia = window.matchMedia

function stubLgUp(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === "(min-width: 1024px)" ? matches : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })) as typeof window.matchMedia
}

function renderShell(main: React.ReactNode, initialEntries = ["/a"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AppShell
        header={<div data-testid="header">header</div>}
        statusBar={<div data-testid="status-bar">status</div>}
        sidebar={<div data-testid="sidebar">sidebar</div>}
        main={main}
      />
    </MemoryRouter>,
  )
}

describe("AppShell macOS overlay title bar", () => {
  afterEach(() => {
    window.matchMedia = originalMatchMedia
    titlebar.value = { overlay: false, inset: false }
    forceRtl.value = false
    tauriWindow.startDragging.mockClear()
    tauriInvoke.mockClear()
  })

  const renderOverlayShell = (props: { railCollapsed?: boolean; leftDock?: boolean; header?: React.ReactNode } = {}) =>
    render(
      <MemoryRouter initialEntries={["/project/p1/editor"]}>
        <AppShell
          logoSlot={<span data-testid="logo">Aquilla</span>}
          header={props.header ?? <div>header</div>}
          statusBar={null}
          sidebar={props.leftDock === false ? <div>org sidebar</div> : undefined}
          leftDock={props.leftDock === false ? undefined : <div>dock</div>}
          railCollapsed={props.railCollapsed}
          main={<div />}
        />
      </MemoryRouter>,
    )

  // Traffic lights float over x≈16–68, y≈19–33 of the window. Whatever layout
  // sits under them must leave that corner clear.
  it.each([
    // [layout, lgUp, railCollapsed, inset, header padding, sidebar row padding, rail top padding, logo shown]
    ["expanded sidebar", true, false, true, "", "76px", "", false],
    ["collapsed rail", true, true, true, "28px", "", "40px", true],
    ["narrow window, sidebar in sheet", false, false, true, "76px", null, null, null],
    ["native fullscreen (lights hidden)", true, false, false, "", "", "", true],
  ] as const)("keeps the traffic-light corner clear: %s", (_, lgUp, railCollapsed, inset, headerPad, rowPad, railTop, logoShown) => {
    stubLgUp(lgUp)
    titlebar.value = { overlay: true, inset }
    renderOverlayShell({ railCollapsed })
    const header = document.querySelector<HTMLElement>('[data-slot="app-shell-header"]')!
    expect(header.style.paddingLeft).toBe(headerPad)

    const row = document.querySelector<HTMLElement>('[data-slot="app-shell-sidebar-chrome"]')
    if (rowPad === null) {
      expect(row).toBeNull()
      return
    }
    expect(row!.style.paddingLeft).toBe(rowPad)
    expect(row!.style.paddingTop).toBe(railTop)
    expect(screen.queryByTestId("logo") !== null).toBe(logoShown)
  })

  // RTL flips the in-flow sidebar to the right edge, but the lights stay at
  // the physical top-left, so the header (now on the left) clears them.
  it.each([
    // [layout, railCollapsed, header padding, rail top padding]
    ["expanded sidebar", false, "76px", ""],
    ["collapsed rail", true, "76px", ""],
  ] as const)("keeps the traffic-light corner clear in an RTL locale: %s", (_, railCollapsed, headerPad, railTop) => {
    stubLgUp(true)
    titlebar.value = { overlay: true, inset: true }
    forceRtl.value = true
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/project/p1/editor"]}>
          <AppShell
            logoSlot={<span data-testid="logo">Aquilla</span>}
            header={<div>header</div>}
            statusBar={null}
            leftDock={<div>dock</div>}
            railCollapsed={railCollapsed}
            main={<div />}
          />
        </MemoryRouter>
      </I18nProvider>,
    )
    const header = document.querySelector<HTMLElement>('[data-slot="app-shell-header"]')!
    expect(header.style.paddingLeft).toBe(headerPad)
    const row = document.querySelector<HTMLElement>('[data-slot="app-shell-sidebar-chrome"]')!
    expect(row.style.paddingLeft).toBe("")
    expect(row.style.paddingRight).toBe("")
    expect(row.style.paddingTop).toBe(railTop)
    expect(screen.getByTestId("logo")).toBeInTheDocument()
  })

  it("clears the traffic lights in the left-edge sidebar sheet in an RTL locale", async () => {
    stubLgUp(false)
    titlebar.value = { overlay: true, inset: true }
    forceRtl.value = true
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/project/p1/editor"]}>
          <AppShell
            logoSlot={<span data-testid="logo">Aquilla</span>}
            header={<div>header</div>}
            statusBar={null}
            leftDock={<div>dock</div>}
            main={<div />}
          />
        </MemoryRouter>
      </I18nProvider>,
    )
    const header = document.querySelector<HTMLElement>('[data-slot="app-shell-header"]')!
    expect(header.style.paddingLeft).toBe("76px")
    await userEvent.click(screen.getByRole("button", { name: "Open sidebar" }))
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-slot="app-shell-sidebar-chrome"]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(row.style.paddingLeft).toBe("76px")
  })

  it("drops the beta chip beside the traffic lights so the row fits a 200px dock", () => {
    stubLgUp(true)
    titlebar.value = { overlay: true, inset: true }
    renderOverlayShell()
    const row = document.querySelector<HTMLElement>('[data-slot="app-shell-sidebar-chrome"]')!
    expect(within(row).queryByText(/beta/i)).toBeNull()
  })

  it("does not pad the header for a collapsed org aside, which stays full width", () => {
    stubLgUp(true)
    titlebar.value = { overlay: true, inset: true }
    renderOverlayShell({ railCollapsed: true, leftDock: false })
    const header = document.querySelector<HTMLElement>('[data-slot="app-shell-header"]')!
    expect(header.style.paddingLeft).toBe("")
  })

  it("drags the window from empty header space without swallowing the press", () => {
    stubLgUp(true)
    titlebar.value = { overlay: true, inset: true }
    renderOverlayShell()
    const onDocMouseDown = vi.fn()
    document.addEventListener("mousedown", onDocMouseDown)
    try {
      const header = document.querySelector<HTMLElement>('[data-slot="app-shell-header"]')!
      fireEvent.mouseDown(header, { button: 0, detail: 1 })
      // Outside-click closers registered on document still hear it.
      expect(onDocMouseDown).toHaveBeenCalledTimes(1)
    } finally {
      document.removeEventListener("mousedown", onDocMouseDown)
    }
    return waitFor(() => expect(tauriWindow.startDragging).toHaveBeenCalledTimes(1))
  })

  it("leaves controls in the header alone, including clickable non-buttons", async () => {
    stubLgUp(true)
    titlebar.value = { overlay: true, inset: true }
    renderOverlayShell({
      header: (
        <div>
          <button type="button">Real button</button>
          {/* The app gives clickable things the arrow cursor, so no
              `cursor: pointer` here: the handler alone must give it away. */}
          <div data-testid="clicky" onClick={() => {}}>
            <span data-testid="clicky-child">Badge</span>
          </div>
          <span data-testid="pressy" onPointerDown={() => {}}>Chip</span>
          <span data-testid="plain-text">Title</span>
        </div>
      ),
    })
    fireEvent.mouseDown(screen.getByRole("button", { name: "Real button" }), { button: 0, detail: 1 })
    fireEvent.mouseDown(screen.getByTestId("clicky-child"), { button: 0, detail: 1 })
    fireEvent.mouseDown(screen.getByTestId("pressy"), { button: 0, detail: 1 })
    await Promise.resolve()
    expect(tauriWindow.startDragging).not.toHaveBeenCalled()
    // Plain text in the band is still part of the title bar.
    fireEvent.mouseDown(screen.getByTestId("plain-text"), { button: 0, detail: 1 })
    await waitFor(() => expect(tauriWindow.startDragging).toHaveBeenCalledTimes(1))
  })

  it("starts the drag in the press's own tick once the window API is preloaded", async () => {
    __resetMacTitlebarStoreForTests()
    stubLgUp(true)
    titlebar.value = { overlay: true, inset: true }
    renderOverlayShell()
    // Mounting the drag region loads the API ahead of any press…
    await act(async () => {})
    const header = document.querySelector<HTMLElement>('[data-slot="app-shell-header"]')!
    fireEvent.mouseDown(header, { button: 0, detail: 1 })
    // …so macOS sees startDragging while the button is still down.
    expect(tauriWindow.startDragging).toHaveBeenCalledTimes(1)
  })

  it("hands a still double click to the native title-bar action", async () => {
    stubLgUp(true)
    titlebar.value = { overlay: true, inset: true }
    renderOverlayShell()
    const header = document.querySelector<HTMLElement>('[data-slot="app-shell-header"]')!
    fireEvent.mouseDown(header, { button: 0, detail: 2, clientX: 300, clientY: 20 })
    fireEvent.mouseUp(header, { button: 0, detail: 2, clientX: 300, clientY: 20 })
    await waitFor(() => expect(tauriInvoke).toHaveBeenCalledWith("titlebar_double_click"))
    // Moved between press and release: nothing.
    fireEvent.mouseDown(header, { button: 0, detail: 2, clientX: 300, clientY: 20 })
    fireEvent.mouseUp(header, { button: 0, detail: 2, clientX: 340, clientY: 20 })
    await Promise.resolve()
    expect(tauriInvoke).toHaveBeenCalledTimes(1)
  })

  it("forgets a double-click press released outside the title bar", async () => {
    stubLgUp(true)
    titlebar.value = { overlay: true, inset: true }
    renderOverlayShell()
    const header = document.querySelector<HTMLElement>('[data-slot="app-shell-header"]')!
    const row = document.querySelector<HTMLElement>('[data-slot="app-shell-sidebar-chrome"]')!
    // Press on the header, release over the page.
    fireEvent.mouseDown(header, { button: 0, detail: 2, clientX: 300, clientY: 20 })
    fireEvent.mouseUp(document.body, { button: 0, detail: 2, clientX: 300, clientY: 20 })
    // A later detail==2 release at the same spot must not zoom.
    fireEvent.mouseUp(header, { button: 0, detail: 2, clientX: 300, clientY: 20 })
    // Nor may a press on one region be completed by a release on another.
    fireEvent.mouseDown(header, { button: 0, detail: 2, clientX: 30, clientY: 20 })
    fireEvent.mouseUp(row, { button: 0, detail: 2, clientX: 30, clientY: 20 })
    await Promise.resolve()
    expect(tauriInvoke).not.toHaveBeenCalled()
  })

  it("takes focus out of an editor when empty title-bar space is pressed", () => {
    stubLgUp(true)
    titlebar.value = { overlay: true, inset: true }
    renderOverlayShell({ header: <input aria-label="Rename" /> })
    const input = screen.getByRole("textbox", { name: "Rename" })
    input.focus()
    const onBlur = vi.fn()
    input.addEventListener("blur", onBlur)
    fireEvent.mouseDown(document.querySelector<HTMLElement>('[data-slot="app-shell-header"]')!, { button: 0, detail: 1 })
    expect(onBlur).toHaveBeenCalledTimes(1)
    expect(document.activeElement).not.toBe(input)
  })

  it("clears the traffic lights in the narrow-window sidebar sheet", async () => {
    stubLgUp(false)
    titlebar.value = { overlay: true, inset: true }
    renderOverlayShell()
    await userEvent.click(screen.getByRole("button", { name: "Open sidebar" }))
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-slot="app-shell-sidebar-chrome"]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(row.style.paddingLeft).toBe("76px")
    expect(screen.queryByTestId("logo")).toBeNull()
  })

  it("is not a title bar in native fullscreen", async () => {
    stubLgUp(true)
    titlebar.value = { overlay: true, inset: false }
    renderOverlayShell({ header: <input aria-label="Rename" /> })
    const input = screen.getByRole("textbox", { name: "Rename" })
    input.focus()
    const header = document.querySelector<HTMLElement>('[data-slot="app-shell-header"]')!
    fireEvent.mouseDown(header, { button: 0, detail: 1 })
    fireEvent.mouseDown(header, { button: 0, detail: 2, clientX: 300, clientY: 20 })
    fireEvent.mouseUp(header, { button: 0, detail: 2, clientX: 300, clientY: 20 })
    await Promise.resolve()
    expect(tauriWindow.startDragging).not.toHaveBeenCalled()
    expect(tauriInvoke).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)
  })

  it("does not make anything a drag handle outside the macOS desktop app", async () => {
    stubLgUp(true)
    renderShell(<div />)
    fireEvent.mouseDown(document.querySelector<HTMLElement>('[data-slot="app-shell-header"]')!, { button: 0, detail: 1 })
    await Promise.resolve()
    expect(tauriWindow.startDragging).not.toHaveBeenCalled()
  })
})
