import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { SharedProjectsPage } from "./SharedProjectsPage"

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
}

function renderPage(initialEntry = "/shared") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/shared" element={<SharedProjectsPage />} />
        <Route path="/orgs/all" element={<div>ALL ORGS</div>} />
        <Route path="/orgs/:orgId" element={<div>GUEST ORG</div>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  )
}

describe("SharedProjectsPage redirect", () => {
  it("sends the unscoped /shared bookmark to /orgs/all", () => {
    renderPage("/shared")
    expect(screen.getByTestId("location")).toHaveTextContent("/orgs/all")
    expect(screen.getByText("ALL ORGS")).toBeInTheDocument()
  })

  it("sends a scoped /shared?org= bookmark to that guest org", () => {
    renderPage("/shared?org=503")
    expect(screen.getByTestId("location")).toHaveTextContent("/orgs/503")
    expect(screen.getByText("GUEST ORG")).toBeInTheDocument()
  })
})
