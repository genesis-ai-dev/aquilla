import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { OrgHomeRoute } from "./OrgHomeRoute"

let orgValue: Record<string, unknown> = {}
vi.mock("@/context/OrgContext", () => ({ useActiveOrg: () => orgValue }))

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/orgs/:orgId">
          <Route index element={<OrgHomeRoute />} />
          <Route path="overview" element={<div>overview</div>} />
          <Route path="projects" element={<div>projects</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  orgValue = { activeOrg: { id: 3 }, activeGuestOrg: null, accessibleProjectsLoading: false, offline: false }
})

describe("OrgHomeRoute", () => {
  it("sends a member org to its overview", () => {
    renderAt("/orgs/3")
    expect(screen.getByText("overview")).toBeInTheDocument()
  })

  it("sends a guest org to its projects", () => {
    orgValue = { ...orgValue, activeOrg: null, activeGuestOrg: { id: 3, name: null } }
    renderAt("/orgs/3")
    expect(screen.getByText("projects")).toBeInTheDocument()
  })

  it("sends a member org to its downloaded projects while the desktop app is offline", () => {
    orgValue = { ...orgValue, offline: true }
    renderAt("/orgs/3")
    expect(screen.getByText("projects")).toBeInTheDocument()
  })
})
