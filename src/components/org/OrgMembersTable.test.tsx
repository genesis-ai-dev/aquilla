import { render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

import { OrgMembersTable } from "./OrgMembersTable"

// AQU-1352 §3.7 rule 1: every roster row carries its origin. The org is the
// top scope, so an org row's role is always a direct grant there — the badge
// keeps org, team and project rosters speaking the same vocabulary.
describe("OrgMembersTable origin badge (AQU-1352)", () => {
  it("badges every org member row as direct", async () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <OrgMembersTable
          orgId={1}
          orgName="CAS"
          members={[
            { userId: 2, username: "anna", role: { level: 100, name: "viewer" } },
            { userId: 3, username: "ben", role: { level: 600, name: "maintainer" } },
          ]}
          callerOrgRoleLevel={100}
          canAddToProjects={false}
          onAddToProjects={vi.fn()}
          add={vi.fn()}
          addMany={vi.fn()}
          onRequestRemove={vi.fn()}
        />
      </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText("ben")).toBeInTheDocument()
    const origins = Array.from(container.querySelectorAll("[data-origin]")).map((el) => el.getAttribute("data-origin"))
    expect(origins).toEqual(["direct", "direct"])
  })
})
