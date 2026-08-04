/**
 * A render throw in `main` used to take down the entire app (single boundary
 * at the app root, see ErrorBoundary.tsx) — that's what turned the invite
 * createdBy bug into a full white screen instead of a contained crash.
 * AppShell now wraps its `main` slot in a route-keyed ErrorBoundary so chrome
 * (sidebar/header/status bar) survives and the user can navigate away.
 */

import { describe, it, expect } from "vitest"
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom"
import { render, screen, fireEvent } from "@testing-library/react"
import { AppShell } from "./AppShell"

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
    expect(header).toHaveClass("h-[52px]", "min-h-[52px]", "justify-center")

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

    expect(container.querySelector('[data-slot="app-shell-header"]')).toHaveClass("h-[52px]", "min-h-[52px]", "justify-center")
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
})
