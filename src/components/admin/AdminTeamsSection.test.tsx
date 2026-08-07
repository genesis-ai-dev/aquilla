/**
 * AdminTeamsSection — flat cross-tenant teams table. Verifies columns, search,
 * empty state, and row-click opens the team.
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { AdminTeamsSection } from "./AdminTeamsSection"
import type { AdminTeam } from "@/lib/frontier/admin"

const teams: AdminTeam[] = [
  {
    id: 10,
    name: "alpha/translators",
    createdAt: "2026-01-02",
    orgId: 1,
    orgName: "Alpha",
    projectLeadUsername: "al",
    memberCount: 2,
    projectCount: 1,
  },
  {
    id: 11,
    name: "beta/reviewers",
    createdAt: "2026-02-02",
    orgId: 2,
    orgName: "Beta",
    projectLeadUsername: "be",
    memberCount: 4,
    projectCount: 3,
  },
]

describe("AdminTeamsSection", () => {
  it("renders team, org, project lead, members, projects, and created", () => {
    render(<AdminTeamsSection teams={teams} onOpenTeam={vi.fn()} />)
    const table = screen.getByTestId("admin-teams-table")
    expect(screen.getByText("translators")).toBeInTheDocument()
    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("al")).toBeInTheDocument()
    expect(within(table).getByText("4")).toBeInTheDocument()
    expect(within(table).getByText("3")).toBeInTheDocument()
    const created = new Date("2026-01-02").toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
    })
    expect(screen.getByText(created)).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: /^Team$/i })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: /^Organization$/i })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: /^Project Lead$/i })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: /^Members$/i })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: /^Projects$/i })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: /^Created$/i })).toBeInTheDocument()
  })

  it("filters teams by search", () => {
    render(<AdminTeamsSection teams={teams} onOpenTeam={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/search teams/i), { target: { value: "review" } })
    expect(screen.getByText("reviewers")).toBeInTheDocument()
    expect(screen.queryByText("translators")).not.toBeInTheDocument()
  })

  it("leaves Project Lead empty when none is set", () => {
    render(
      <AdminTeamsSection
        teams={[{ ...teams[0], projectLeadUsername: null }]}
        onOpenTeam={vi.fn()}
      />,
    )
    expect(screen.queryByText("al")).not.toBeInTheDocument()
    expect(screen.queryByText("—")).not.toBeInTheDocument()
  })

  it("shows an empty panel when there are no teams", () => {
    render(<AdminTeamsSection teams={[]} onOpenTeam={vi.fn()} />)
    expect(screen.getByText("No teams yet")).toBeInTheDocument()
  })

  it("calls onOpenTeam when a row is clicked", () => {
    const onOpenTeam = vi.fn()
    render(<AdminTeamsSection teams={teams} onOpenTeam={onOpenTeam} />)
    fireEvent.click(screen.getByText("translators").closest("tr")!)
    expect(onOpenTeam).toHaveBeenCalledWith(teams[0])
  })
})
