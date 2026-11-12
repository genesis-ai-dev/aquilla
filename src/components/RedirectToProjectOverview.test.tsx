import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { RedirectToProjectOverview } from "./RedirectToProjectOverview"

/** Echoes where the router actually landed. */
function LocationProbe({ label }: { label: string }) {
  const { pathname, search, hash } = useLocation()
  return <div data-testid={label}>{`${pathname}${search}${hash}`}</div>
}

/** The real route shapes a bare `/project/:id` competes with in App.tsx. */
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/project/:id" element={<RedirectToProjectOverview />} />
        <Route path="/project/:id/editor" element={<div>editor</div>} />
        <Route path="/project/:id/settings" element={<div>project settings</div>} />
        <Route path="/projects/:id" element={<LocationProbe label="overview" />} />
        <Route path="*" element={<div>Page not found</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe("RedirectToProjectOverview (AQU-1535)", () => {
  it("sends a bare /project/:id to the project overview, not Page not found", () => {
    renderAt("/project/proj-1")
    expect(screen.getByTestId("overview").textContent).toBe("/projects/proj-1")
    expect(screen.queryByText("Page not found")).not.toBeInTheDocument()
  })

  it("carries the query string and hash across the redirect", () => {
    renderAt("/project/proj-1?tab=files#cell-3")
    expect(screen.getByTestId("overview").textContent).toBe("/projects/proj-1?tab=files#cell-3")
  })

  it("leaves the deeper project surfaces to their own routes", () => {
    renderAt("/project/proj-1/editor")
    expect(screen.getByText("editor")).toBeInTheDocument()
    renderAt("/project/proj-1/settings")
    expect(screen.getByText("project settings")).toBeInTheDocument()
  })
})

describe("App route table", () => {
  it("wires the bare /project/:id route to the redirect", () => {
    const app = readFileSync(join(__dirname, "..", "App.tsx"), "utf8")
    // The regression was a missing route: the catch-all swallowed
    // `/project/:id` and showed Page not found, so guard the wiring itself.
    expect(app).toContain('<Route path="/project/:id" element={<RedirectToProjectOverview />} />')
  })
})
