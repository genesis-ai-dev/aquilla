/**
 * AdminProjectsSection — searchable/sortable projects with a needs-attention lens.
 * Verifies the Status column surfaces attention reasons and the lens filters
 * down to projects that need attention.
 */
import { afterEach, describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { pickSelectOption } from "@/test-utils/select"
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
    shared: false,
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
  await pickSelectOption(/filter projects/i, optionName)
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

  it("sorts needs-attention by status urgency (most urgent first)", async () => {
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
    render(
      <MemoryRouter>
        <AdminProjectsSection
          projects={[
            proj({ id: "soon", name: "Due Soon", deadlineAt: soon }),
            proj({ id: "overdue", name: "Overdue One", deadlineAt: "2020-01-01" }),
            proj({ id: "healthy", name: "Healthy" }),
          ]}
        />
      </MemoryRouter>,
    )
    await pickLens(/needs attention/i)
    const rows = screen.getAllByRole("row").slice(1)
    const names = rows.map((tr) => within(tr).getAllByRole("cell")[0]?.textContent)
    expect(names).toEqual(["Overdue One", "Due Soon"])
    const statusHeader = screen.getByRole("button", { name: /Status/i })
    expect(statusHeader).toHaveAttribute("aria-sort", "descending")
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

  it("renders a table-width card empty state when there are no projects", () => {
    render(
      <MemoryRouter>
        <AdminProjectsSection projects={[]} />
      </MemoryRouter>,
    )
    expect(screen.getByLabelText("Search projects…")).toBeInTheDocument()
    const panel = screen.getByTestId("admin-projects-table")
    expect(panel).toHaveClass("border", "bg-card")
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

  it("sorts missing last-edit dashes below real dates when descending", () => {
    const older = Date.now() - 7 * 24 * 60 * 60 * 1000
    const newer = Date.now()
    render(
      <MemoryRouter>
        <AdminProjectsSection
          projects={[
            proj({ id: "none", name: "No Edit", lastEditAt: null }),
            proj({ id: "old", name: "Older", lastEditAt: older }),
            proj({ id: "new", name: "Newer", lastEditAt: newer }),
          ]}
        />
      </MemoryRouter>,
    )
    const header = screen.getByRole("button", { name: /Last edit/i })
    fireEvent.click(header) // numeric → desc first (newest first)
    const names = screen
      .getAllByRole("row")
      .slice(1)
      .map((tr) => within(tr).getAllByRole("cell")[0]?.textContent)
    expect(names).toEqual(["Newer", "Older", "No Edit"])
  })

  it("sorts missing creator dashes below real names when descending", () => {
    render(
      <MemoryRouter>
        <AdminProjectsSection
          projects={[
            // Lead with a real username so auto first-dir is asc (string), then
            // a second click reaches desc with missing still last.
            proj({ id: "c", name: "Gamma", creatorUsername: "anna" }),
            proj({ id: "b", name: "Beta", creatorUsername: "zoe" }),
            proj({ id: "a", name: "Alpha", creatorUsername: null }),
          ]}
        />
      </MemoryRouter>,
    )
    const header = screen.getByRole("button", { name: /Creator/i })
    fireEvent.click(header) // asc
    fireEvent.click(header) // desc
    const names = screen
      .getAllByRole("row")
      .slice(1)
      .map((tr) => within(tr).getAllByRole("cell")[0]?.textContent)
    expect(names).toEqual(["Beta", "Gamma", "Alpha"])
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
    expect(screen.getByTestId("admin-projects-table")).toBeInTheDocument()
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })

  it("shows a Shared badge only on guest-granted projects", () => {
    render(
      <MemoryRouter>
        <AdminProjectsSection
          projects={[
            proj({ id: "own", name: "In Org" }),
            proj({ id: "guest", name: "Guest Gospel", shared: true }),
          ]}
        />
      </MemoryRouter>,
    )
    const sharedRow = screen.getByText("Guest Gospel").closest("tr")!
    expect(within(sharedRow).getByTestId("project-shared-badge")).toHaveTextContent("Shared")
    expect(within(sharedRow).getByTestId("project-shared-badge")).toHaveClass("bg-foreground/10")
    expect(within(sharedRow).getByTestId("project-shared-badge")).toHaveClass("text-muted-foreground")
    const ownRow = screen.getByText("In Org").closest("tr")!
    expect(within(ownRow).queryByTestId("project-shared-badge")).not.toBeInTheDocument()
  })

  it("finds shared projects by the Shared label", () => {
    render(
      <MemoryRouter>
        <AdminProjectsSection
          projects={[
            proj({ id: "own", name: "In Org" }),
            proj({ id: "guest", name: "Guest Gospel", shared: true }),
          ]}
        />
      </MemoryRouter>,
    )
    fireEvent.change(screen.getByLabelText("Search projects…"), { target: { value: "shared" } })
    expect(screen.getByText("Guest Gospel")).toBeInTheDocument()
    expect(screen.queryByText("In Org")).not.toBeInTheDocument()
  })
  // AQU-2708: the admin project list has no page cap, so its body is windowed
  // with TanStack Virtual. Everything an operator does with the table reads
  // the whole list, not the mounted window.
  describe("a long list in a scrolling pane", () => {
    const SCROLLPORT_PX = 400
    const ROW_PX = 40
    const many = Array.from({ length: 200 }, (_, i) =>
      proj({
        id: `p${i}`,
        name: `Project ${String(i + 1).padStart(3, "0")}`,
        deadlineAt: i === 150 ? "2020-01-01" : null,
      }),
    )

    /** happy-dom has no layout: size the scrollport and the rows. */
    const stubLayout = () => {
      const isScrollport = (el: HTMLElement) => el.dataset.scrollport != null
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
        function (this: HTMLElement) {
          return isScrollport(this) ? SCROLLPORT_PX : 0
        },
      )
      // A pane only counts as a scrollport once its content overflows it.
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
        function (this: HTMLElement) {
          return isScrollport(this) ? SCROLLPORT_PX * 20 : 0
        },
      )
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
        function (this: HTMLElement) {
          const height = isScrollport(this)
            ? SCROLLPORT_PX
            : this.tagName === "TR"
              ? ROW_PX
              : 0
          return {
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 600,
            bottom: height,
            width: 600,
            height,
            toJSON: () => ({}),
          } as DOMRect
        },
      )
    }

    const renderLong = () => {
      stubLayout()
      return render(
        <MemoryRouter>
          <div data-scrollport="" style={{ overflowY: "auto", height: SCROLLPORT_PX }}>
            <AdminProjectsSection projects={many} />
          </div>
        </MemoryRouter>,
      )
    }

    const rowNames = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((tr) => within(tr).getAllByRole("cell")[0]?.textContent)

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it("mounts a window of rows whose names are still readable", () => {
      renderLong()
      const names = rowNames()
      expect(names.length).toBeLessThan(many.length / 2)
      expect(names[0]).toBe("Project 001")
      expect(screen.getByText("Project 001")).toBeInTheDocument()
    })

    it("searches the whole list, not the mounted window", () => {
      renderLong()
      expect(screen.queryByText("Project 151")).not.toBeInTheDocument()
      fireEvent.change(screen.getByLabelText("Search projects…"), {
        target: { value: "Project 151" },
      })
      expect(screen.getByText("Project 151")).toBeInTheDocument()
      expect(rowNames()).toEqual(["Project 151"])
    })

    it("filters the whole list through the lens", async () => {
      renderLong()
      await pickLens(/needs attention/i)
      // Only the one overdue project needs attention, 150 rows down the list.
      expect(rowNames()).toEqual(["Project 151"])
    })

    it("opens a project from a windowed row", () => {
      navigate.mockClear()
      renderLong()
      fireEvent.click(screen.getByText("Project 002").closest("tr")!)
      expect(navigate).toHaveBeenCalledWith("/projects/p1")
    })
  })
})
