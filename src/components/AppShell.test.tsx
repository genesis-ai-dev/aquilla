/**
 * A render throw in `main` used to take down the entire app (single boundary
 * at the app root, see ErrorBoundary.tsx) — that's what turned the invite
 * createdBy bug into a full white screen instead of a contained crash.
 * AppShell now wraps its `main` slot in a route-keyed ErrorBoundary so chrome
 * (sidebar/header/status bar) survives and the user can navigate away.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AppShell } from "./AppShell"
import { I18nProvider } from "@/lib/i18n/I18nProvider"

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

function AlwaysThrows(): never {
  throw new Error("main content crash")
}

// Mirrors ProjectWorkspace: ONE AppShell instance stays mounted while an
// internal navigation swaps its `main` content based on the current path —
// AppShell itself is never unmounted by the router, only useLocation()
// changes. Only a route-keyed boundary (not a plain, non-keyed one) resets
// in this scenario.
function StaysMountedAcrossNavigation() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <button onClick={() => navigate("/b")}>Go to /b</button>
      <AppShell
        header={<div data-testid="header">header</div>}
        statusBar={<div data-testid="status-bar">status</div>}
        sidebar={<div data-testid="sidebar">sidebar</div>}
        main={location.pathname === "/a" ? <AlwaysThrows /> : <div data-testid="content">recovered</div>}
      />
    </>
  )
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

describe("AppShell main-content error containment", () => {
  it("renders main content normally when nothing throws", () => {
    renderShell(<div data-testid="content">hello</div>)
    expect(screen.getByTestId("content")).toBeInTheDocument()
    expect(screen.getByTestId("sidebar")).toBeInTheDocument()
  })

  it("shows a compact fallback in place of main content when it throws, without losing chrome", () => {
    renderShell(<AlwaysThrows />)
    expect(screen.getByText("Something went wrong")).toBeInTheDocument()
    // Chrome outside the boundary is unaffected by the crash.
    expect(screen.getByTestId("sidebar")).toBeInTheDocument()
    expect(screen.getByTestId("header")).toBeInTheDocument()
    expect(screen.getByTestId("status-bar")).toBeInTheDocument()
  })

  it("resets the crashed boundary when the route changes without unmounting AppShell", () => {
    render(
      <MemoryRouter initialEntries={["/a"]}>
        <StaysMountedAcrossNavigation />
      </MemoryRouter>,
    )
    expect(screen.getByText("Something went wrong")).toBeInTheDocument()

    // A route change (new page, safe content this time) must clear the
    // stuck error state — a component-level boundary alone stays tripped
    // forever once caught, since getDerivedStateFromError never resets itself.
    fireEvent.click(screen.getByText("Go to /b"))
    expect(screen.getByTestId("content")).toBeInTheDocument()
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument()
  })

  it("keeps the header in the same fixed-height band with or without tabs", () => {
    const { container, rerender } = render(
      <MemoryRouter>
        <AppShell
          header={<div>header</div>}
          statusBar={null}
          sidebar={<div>sidebar</div>}
          main={<div>main</div>}
        />
      </MemoryRouter>,
    )

    const header = container.querySelector('[data-slot="app-shell-header"]')
    expect(header).toHaveClass("h-[52px]", "min-h-[52px]", "items-center")

    rerender(
      <MemoryRouter>
        <AppShell
          header={<div>header</div>}
          statusBar={null}
          sidebar={<div>sidebar</div>}
          aboveCard={<div>tabs</div>}
          main={<div>main</div>}
        />
      </MemoryRouter>,
    )

    expect(container.querySelector('[data-slot="app-shell-header"]')).toHaveClass("h-[52px]", "min-h-[52px]", "items-center")
  })

  it("stacks sidebar chrome in a 40px column when the dock rail is collapsed", () => {
    const { container } = render(
      <MemoryRouter>
        <AppShell
          header={<div>header</div>}
          statusBar={null}
          leftDock={<div data-testid="left-dock">dock</div>}
          logoSlot={<span>logo</span>}
          railCollapsed
          main={<div>main</div>}
        />
      </MemoryRouter>,
    )

    const chrome = container.querySelector('[data-slot="app-shell-sidebar-chrome"]')
    expect(chrome).toHaveClass("flex-col", "w-10")
    expect(chrome).not.toHaveClass("px-2")
  })

  it("sits the floating content card flush under the header (no top margin)", () => {
    const { container } = render(
      <MemoryRouter>
        <AppShell
          header={<div>header</div>}
          statusBar={null}
          sidebar={<div>sidebar</div>}
          main={<div>main</div>}
        />
      </MemoryRouter>,
    )

    const card = container.querySelector(".rounded-xl.border.border-border.bg-background")
    expect(card).toHaveClass("mx-2", "mb-2")
    expect(card).not.toHaveClass("m-2")
    expect(card).not.toHaveClass("mt-2")
  })

  it("lays out aside children without a shared width shell", () => {
    const { container, rerender } = render(
      <MemoryRouter>
        <AppShell
          header={<div>header</div>}
          statusBar={null}
          sidebar={<div>sidebar</div>}
          main={<div>main</div>}
          aside={<div data-testid="right-aside">comments</div>}
        />
      </MemoryRouter>,
    )

    expect(screen.getByTestId("right-aside")).toBeInTheDocument()
    expect(container.querySelector('[data-slot="app-shell-aside"]')).not.toBeInTheDocument()

    rerender(
      <MemoryRouter>
        <AppShell
          header={<div>header</div>}
          statusBar={null}
          sidebar={<div>sidebar</div>}
          main={<div>main</div>}
          asideEdge={<div data-testid="aside-edge">tab</div>}
        />
      </MemoryRouter>,
    )

    expect(screen.getByTestId("aside-edge")).toBeInTheDocument()
    expect(screen.queryByTestId("right-aside")).not.toBeInTheDocument()
  })

  it("offers a UI-language control in the chrome when an I18nProvider is present", async () => {
    render(
      <MemoryRouter>
        <I18nProvider>
          <AppShell
            header={<div data-testid="header">header</div>}
            statusBar={<div data-testid="status-bar">status</div>}
            sidebar={<div data-testid="sidebar">sidebar</div>}
            main={<div data-testid="content">content</div>}
          />
        </I18nProvider>
      </MemoryRouter>,
    )
    // Distinct from the Preferences page's own switcher (finding 8) so a
    // screen reader never announces the same name twice with nothing to tell
    // the two apart.
    const trigger = await screen.findByRole("button", { name: "Quick language switch" })
    expect(trigger).toBeInTheDocument()
    const footer = trigger.closest('[data-slot="app-shell-sidebar-footer"]')
    expect(footer).toHaveClass("justify-between", "px-2", "pb-2")
    const version = screen.getByRole("button", { name: "Copy build info" })
    expect(version.parentElement).not.toHaveClass("flex-1")
    expect(version.closest('[data-slot="app-shell-sidebar-footer"]')).toBe(footer)
    const help = screen.getByRole("button", { name: /help & community/i })
    expect(footer).toContainElement(help)
    expect(help.nextElementSibling).toBe(trigger)
    expect(trigger).toHaveClass("size-8", "text-muted-foreground")
    expect(trigger).not.toHaveClass("border")
    // The picker must list endonyms, not English names — a Burmese speaker
    // looking for their language will not scan for the word "Burmese".
    await userEvent.click(trigger)
    const burmese = await screen.findByRole("menuitemradio", { name: /မြန်မာ/ })
    expect(burmese).toBeInTheDocument()
    expect(burmese.closest("[data-side]")).toHaveAttribute("data-side", "top")
    expect(burmese.closest("[data-align]")).toHaveAttribute("data-align", "start")
  })

  it("keeps version and language controls on one row in the project workspace", async () => {
    render(
      <MemoryRouter>
        <I18nProvider>
          <AppShell
            header={<div data-testid="header">header</div>}
            statusBar={<div data-testid="status-bar">status</div>}
            leftDock={<div data-testid="left-dock">dock</div>}
            main={<div data-testid="content">content</div>}
          />
        </I18nProvider>
      </MemoryRouter>,
    )
    // ProjectWorkspace is the only caller that passes leftDock, and it is the
    // screen a translator works in all day. If the switcher only rendered in the
    // org-chrome layout, changing UI language would mean leaving your work.
    const language = await screen.findByRole("button", { name: "Quick language switch" })
    const version = screen.getByRole("button", { name: "Copy build info" })
    const footer = language.closest('[data-slot="app-shell-sidebar-footer"]')
    expect(footer).toHaveClass("justify-between")
    expect(version.closest('[data-slot="app-shell-sidebar-footer"]')).toBe(footer)
    const help = screen.getByRole("button", { name: /help & community/i })
    expect(footer).toContainElement(help)
    expect(help).toHaveClass("size-8")
    expect(language).toHaveClass("size-8", "text-muted-foreground")
    expect(language).not.toHaveClass("border")

    await userEvent.click(help)
    const homepage = await screen.findByRole("menuitem", { name: /homepage/i })
    expect(homepage.closest("[data-side]")).toHaveAttribute("data-side", "top")
    expect(homepage.closest("[data-align]")).toHaveAttribute("data-align", "start")
    expect(screen.queryByRole("menuitem", { name: /take the tour/i })).not.toBeInTheDocument()
  })
})

describe("AppShell mobile sidebar sheet", () => {
  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  it("keeps the in-flow sidebar and hides the sheet trigger at lg and up", () => {
    stubLgUp(true)
    renderShell(<div data-testid="content">hello</div>)
    expect(screen.getByTestId("sidebar")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Open sidebar" })).not.toBeInTheDocument()
    expect(document.querySelector('[data-slot="app-shell-header-body"]')).not.toHaveClass("-ml-2")
  })

  it("opens the org sidebar in a left sheet from a PanelLeft control beside the header", async () => {
    stubLgUp(false)
    renderShell(<div data-testid="content">hello</div>)

    const trigger = screen.getByRole("button", { name: "Open sidebar" })
    expect(trigger).toBeInTheDocument()
    expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument()

    const header = trigger.closest('[data-slot="app-shell-header"]')
    expect(header).not.toBeNull()
    expect(header?.querySelector('[data-slot="app-shell-sidebar-trigger"]')).toContainElement(trigger)
    expect(header?.querySelector('[data-slot="app-shell-header-body"]')).toHaveClass("-ml-2")
    expect(header?.textContent).toMatch(/header/)

    await userEvent.click(trigger)
    const sheet = await screen.findByRole("dialog", { name: "Navigation" })
    expect(sheet).toBeInTheDocument()
    expect(sheet.querySelector('[data-testid="sidebar"]')).toHaveTextContent("sidebar")
  })

  it("opens the editor leftDock in a left sheet from a PanelLeft control beside the header", async () => {
    stubLgUp(false)
    render(
      <MemoryRouter>
        <AppShell
          header={<div data-testid="header">header</div>}
          statusBar={null}
          leftDock={<div data-testid="left-dock">dock</div>}
          logoSlot={<span>logo</span>}
          logoAccessory={<button type="button">Collapse sidebar</button>}
          railCollapsed
          main={<div data-testid="content">content</div>}
        />
      </MemoryRouter>,
    )

    const trigger = screen.getByRole("button", { name: "Open sidebar" })
    expect(trigger).toBeInTheDocument()
    expect(screen.queryByTestId("left-dock")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Collapse sidebar" })).not.toBeInTheDocument()

    await userEvent.click(trigger)
    const sheet = await screen.findByRole("dialog", { name: "Navigation" })
    expect(sheet.querySelector('[data-testid="left-dock"]')).toHaveTextContent("dock")
    const chrome = sheet.querySelector('[data-slot="app-shell-sidebar-chrome"]')
    expect(chrome).not.toHaveClass("w-10", "flex-col")
    expect(sheet.querySelector('[data-testid="left-dock"]')).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Collapse sidebar" })).not.toBeInTheDocument()
  })
})
