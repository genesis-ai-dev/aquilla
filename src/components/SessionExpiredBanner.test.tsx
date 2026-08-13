/**
 * AQU-884: the session-expired banner must survive navigation.
 *
 * The regression it guards: the banner cleared itself on every
 * `location.pathname` change, so the boot redirect (`/` → `/orgs/all`) wiped it
 * in the same tick the 401 raised it — a user reloading with a dead session saw
 * an empty dashboard and no explanation. These tests drive the real redirect,
 * not a synthetic pathname change.
 */

import { describe, it, expect, afterEach } from "vitest"
import { act, render, screen } from "@testing-library/react"
import { Link, MemoryRouter, Navigate, Route, Routes } from "react-router-dom"
import { SessionExpiredBanner } from "./SessionExpiredBanner"
import {
  clearSessionExpired,
  notifySessionExpired,
} from "@/lib/errors/session-expired-signal"

/** Mirrors App.tsx: the banner sits above the route table, inside the router. */
function renderApp(initialEntry = "/") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SessionExpiredBanner />
      <Routes>
        {/* The boot redirect that used to wipe the banner. */}
        <Route path="/" element={<Navigate to="/orgs/all" replace />} />
        <Route
          path="/orgs/all"
          element={
            <div>
              all orgs <Link to="/orgs/7">open org 7</Link>
            </div>
          }
        />
        <Route path="/orgs/7" element={<div>org 7</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

const banner = () => screen.queryByRole("alert")

afterEach(() => {
  // The flag is module-level state — reset it so tests stay independent.
  clearSessionExpired()
})

describe("SessionExpiredBanner", () => {
  it("renders nothing while the session is healthy", () => {
    renderApp("/orgs/all")
    expect(banner()).toBeNull()
  })

  it("appears when a fetch helper signals session expiry", () => {
    renderApp("/orgs/all")
    act(() => notifySessionExpired())
    expect(banner()).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /sign in again/i })).toHaveAttribute(
      "href",
      "/login?next=%2Forgs%2Fall",
    )
  })

  it("survives the boot redirect from / to /orgs/all", () => {
    renderApp("/")
    // The 401 lands as the app is redirecting — the case that regressed.
    act(() => notifySessionExpired())
    expect(screen.getByText("all orgs")).toBeInTheDocument()
    expect(banner()).toBeInTheDocument()
  })

  it("is visible at mount when the 401 fired before the banner mounted", () => {
    // Boot ordering: OrgContext's first fetch rejects with 401 during module
    // init, well before React renders this component.
    notifySessionExpired()
    renderApp("/")
    expect(banner()).toBeInTheDocument()
  })

  it("stays visible while the user navigates between routes", async () => {
    renderApp("/orgs/all")
    act(() => notifySessionExpired())
    // Navigate onward the way the org switcher would.
    await act(async () => screen.getByRole("link", { name: "open org 7" }).click())
    expect(screen.getByText("org 7")).toBeInTheDocument()
    expect(banner()).toBeInTheDocument()
  })

  it("disappears only when dismissed", async () => {
    renderApp("/orgs/all")
    act(() => notifySessionExpired())
    const dismiss = screen.getByRole("button", { name: /dismiss/i })
    await act(async () => dismiss.click())
    expect(banner()).toBeNull()
  })

  it("disappears when the user re-authenticates", () => {
    renderApp("/orgs/all")
    act(() => notifySessionExpired())
    expect(banner()).toBeInTheDocument()
    // finalizeSession() calls this on every successful auth.
    act(() => clearSessionExpired())
    expect(banner()).toBeNull()
  })
})
