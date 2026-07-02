/**
 * AdminProjectsSection — searchable/sortable projects with an at-risk lens.
 * Verifies the Status column surfaces attention reasons and the lens filters
 * down to at-risk projects.
 */
import { describe, it, expect } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { AdminProjectsSection } from "./AdminProjectsSection"
import type { AdminProject } from "@/lib/frontier/admin"

function proj(over: Partial<AdminProject>): AdminProject {
  return {
    id: "p",
    name: "Project",
    orgId: 1,
    orgName: "Org",
    archived: false,
    createdAt: "2026-01-01",
    deadlineAt: null,
    creatorUsername: "al",
    totalCells: 100,
    validatedCells: 100,
    wordCount: 1000,
    lastEditAt: Date.now(),
    ...over,
  }
}

const projects: AdminProject[] = [
  proj({ id: "healthy", name: "Healthy" }),
  proj({ id: "overdue", name: "Overdue One", deadlineAt: "2020-01-01" }),
  proj({ id: "archived", name: "Archived One", archived: true }),
]

const renderSection = () =>
  render(
    <MemoryRouter>
      <AdminProjectsSection projects={projects} />
    </MemoryRouter>,
  )

describe("AdminProjectsSection", () => {
  it("shows attention reasons and status badges", () => {
    renderSection()
    expect(screen.getByText("Overdue")).toBeInTheDocument()
    expect(screen.getByText("On track")).toBeInTheDocument()
    // "Archived" also names a lens button — scope to the archived project's row.
    const archivedRow = screen.getByText("Archived One").closest("tr")!
    expect(within(archivedRow).getByText("Archived")).toBeInTheDocument()
  })

  it("filters to at-risk projects via the lens", () => {
    renderSection()
    fireEvent.click(screen.getByRole("button", { name: /at risk/i }))
    expect(screen.getByText("Overdue One")).toBeInTheDocument()
    expect(screen.queryByText("Healthy")).not.toBeInTheDocument()
    expect(screen.queryByText("Archived One")).not.toBeInTheDocument()
  })
})
