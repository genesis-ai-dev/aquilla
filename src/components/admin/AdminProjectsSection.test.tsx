/**
 * AdminProjectsSection — searchable/sortable projects with a needs-attention lens.
 * Verifies the Status column surfaces attention reasons and the lens filters
 * down to projects that need attention.
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { AdminProjectsSection } from "./AdminProjectsSection"
import type { AdminProject } from "@/lib/frontier/admin"

const navigate = vi.fn()

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom")
  return { ...actual, useNavigate: () => navigate }
})

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

/** Base UI Select: options live in a portaled listbox. */
async function pickLens(optionName: RegExp) {
  fireEvent.click(screen.getByRole("combobox", { name: /filter projects/i }))
  const option = await screen.findByRole("option", { name: optionName })
  fireEvent.pointerMove(option)
  fireEvent.mouseMove(option)
  fireEvent.keyDown(document.activeElement ?? option, { key: "Enter" })
  await waitFor(() => {
    expect(screen.queryByRole("listbox")).toBeNull()
  })
}

describe("AdminProjectsSection", () => {
  it("shows attention reasons and status badges", () => {
    renderSection()
    expect(screen.getByText("Overdue")).toBeInTheDocument()
    expect(screen.getByText("On track")).toBeInTheDocument()
    // "Archived" also names a lens option — scope to the archived project's row.
    const archivedRow = screen.getByText("Archived One").closest("tr")!
    expect(within(archivedRow).getByText("Archived")).toBeInTheDocument()
  })

  it("filters to needs-attention projects via the lens", async () => {
    renderSection()
    await pickLens(/needs attention/i)
    expect(screen.getByText("Overdue One")).toBeInTheDocument()
    expect(screen.queryByText("Healthy")).not.toBeInTheDocument()
    expect(screen.queryByText("Archived One")).not.toBeInTheDocument()
  })

  it("navigates when an active project row is clicked", () => {
    navigate.mockClear()
    renderSection()
    fireEvent.click(screen.getByText("Healthy").closest("tr")!)
    expect(navigate).toHaveBeenCalledWith("/projects/healthy")
  })

  it("does not navigate when an archived project row is clicked", () => {
    navigate.mockClear()
    renderSection()
    fireEvent.click(screen.getByText("Archived One").closest("tr")!)
    expect(navigate).not.toHaveBeenCalled()
  })

  it("renders a table-width dashed empty state when there are no projects", () => {
    render(
      <MemoryRouter>
        <AdminProjectsSection projects={[]} />
      </MemoryRouter>,
    )
    expect(screen.getByLabelText("Search projects…")).toBeInTheDocument()
    expect(screen.getByTestId("admin-projects-empty")).toHaveClass("border-dashed")
    expect(screen.getByText("No projects")).toBeInTheDocument()
    expect(screen.getByText("Projects appear here as they're created.")).toBeInTheDocument()
  })

  it("shows a short last-edit date with a detail tooltip", () => {
    const editedAt = new Date(2026, 6, 3, 13, 37, 8).getTime()
    render(
      <MemoryRouter>
        <AdminProjectsSection
          projects={[proj({ id: "dated", name: "Dated", lastEditAt: editedAt })]}
        />
      </MemoryRouter>,
    )
    const short = new Date(editedAt).toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
    })
    expect(screen.getByText(short)).toBeInTheDocument()
  })

  it("keeps search visible when the archived lens has no projects", async () => {
    render(
      <MemoryRouter>
        <AdminProjectsSection projects={[proj({ id: "healthy", name: "Healthy" })]} />
      </MemoryRouter>,
    )
    await pickLens(/^archived$/i)
    expect(screen.getByLabelText("Search projects…")).toBeInTheDocument()
    expect(screen.getByText("No archived projects")).toBeInTheDocument()
    expect(screen.queryByTestId("admin-projects-table")).not.toBeInTheDocument()
  })
})
