// AQU-538 §3.2 — org "Language Grid" on the project table: lane chips and
// expandable per-lane sub-rows.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProjectsDataTable } from "./OrgProjectsDataTable"
import type { PortfolioProject } from "@/lib/frontier/portfolio"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"

// StaffLanePopover pulls org/project members over the network on mount — stub
// it (it's covered by its own wave-A suite). We only assert it's wired here.
vi.mock("@/components/StaffLanePopover", () => ({
  StaffLanePopover: (props: { projectId: string; lane: string }) => (
    <button data-testid={`staff-${props.projectId}-${props.lane}`}>Staff…</button>
  ),
}))

// AssignModal host fetches the roster — stub so the "Assign…" click is
// observable without a network round-trip.
vi.mock("./OrgLaneAssignModal", () => ({
  OrgLaneAssignModal: (props: { projectId: string; lane: string }) => (
    <div data-testid={`assign-open-${props.projectId}-${props.lane}`} />
  ),
}))

function baseProject(overrides: Partial<PortfolioProject>): PortfolioProject {
  return {
    id: "p",
    name: "Project",
    totalCells: 100,
    validatedCells: 0,
    filledCells: 0,
    aiDraftedCells: 0,
    lastEditAt: null,
    audioCells: 0,
    validatedAudioCells: 0,
    recordedMs: 0,
    deadlineAt: null,
    ...overrides,
  }
}

const now = Date.now()

function renderTable(
  projects: PortfolioProject[],
  opts: {
    role?: number
    defaultLabels?: Record<string, string>
    jwt?: string | null
    viewerUsername?: string | null
    layout?: "page" | "embedded"
    searchValue?: string
    onSearchChange?: (value: string) => void
    searching?: boolean
    hasMore?: boolean
    onLoadMore?: () => void
  } = {},
) {
  const roleByProjectId = new Map<string, CloudProjectSummary["role"]>(
    projects.map((p) => [p.id, { level: opts.role ?? 600, name: "maintainer", source: "direct" }]),
  )
  const defaultLaneLabelByProjectId = new Map(Object.entries(opts.defaultLabels ?? {}))
  return render(
    <MemoryRouter>
      <OrgProjectsDataTable
        projects={projects}
        now={now}
        roleByProjectId={roleByProjectId}
        defaultLaneLabelByProjectId={defaultLaneLabelByProjectId}
        filesByProjectId={new Map()}
        orgId={1}
        jwt={opts.jwt === undefined ? "jwt" : opts.jwt}
        author="anna"
        viewerUsername={opts.viewerUsername ?? null}
        layout={opts.layout ?? "page"}
        searchValue={opts.searchValue}
        onSearchChange={opts.onSearchChange}
        searching={opts.searching}
        hasMore={opts.hasMore}
        onLoadMore={opts.onLoadMore}
      />
    </MemoryRouter>,
  )
}

describe("OrgProjectsDataTable lane chips (AQU-538 §3.2)", () => {
  it("renders admin-style Status before Updated and keeps Updated as a date", () => {
    const stalled = baseProject({
      id: "stalled",
      name: "Stalled Gospels",
      filledCells: 10,
      lastEditAt: now - 30 * 24 * 60 * 60 * 1000,
    })
    renderTable([stalled])

    expect(screen.getByRole("button", { name: /Status/i })).toBeInTheDocument()
    expect(screen.getByText("Stalled")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Updated/i })).toBeInTheDocument()
    // Updated no longer substitutes activity labels for the date.
    const updatedHeader = screen.getByRole("button", { name: /Updated/i })
    const headerRow = updatedHeader.closest("tr")
    const headers = within(headerRow!).getAllByRole("columnheader").map((el) => el.textContent)
    expect(headers.indexOf("Status")).toBeLessThan(headers.indexOf("Updated"))
  })

  it("uses teams-style text metric headers and right-aligned muted values", () => {
    renderTable([baseProject({ id: "metrics", filledCells: 40, validatedCells: 20, audioCells: 10 })])

    expect(screen.getByRole("button", { name: /Translated/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Validated/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Audio$/i })).toBeInTheDocument()
    expect(screen.getByTestId("project-table-translated-value")).toHaveClass(
      "text-right",
      "tabular-nums",
      "text-muted-foreground",
    )
    expect(screen.getByTestId("project-table-validated-value")).toHaveClass(
      "text-right",
      "tabular-nums",
      "text-muted-foreground",
    )
    expect(screen.getByTestId("project-table-audio-value")).toHaveClass(
      "text-right",
      "tabular-nums",
      "text-muted-foreground",
    )
  })

  it("lets the embedded overview table scroll horizontally instead of clipping", () => {
    render(
      <MemoryRouter>
        <OrgProjectsDataTable
          layout="embedded"
          showOrg
          testId="project-table"
          projects={[
            {
              ...baseProject({
                id: "wide",
                name: "Retry Test for AQU-712 with a deliberately long project name",
              }),
              orgName: "Dev Org",
            },
          ]}
          now={now}
        />
      </MemoryRouter>,
    )

    const table = screen.getByTestId("project-table")
    expect(table).toHaveClass("min-w-0", "w-full", "overflow-hidden")
    expect(table.className).not.toContain("overflow-x-hidden")
    expect(screen.getByTestId("legend-list-mock")).toBeInTheDocument()
    expect(table.querySelector(".overflow-x-auto")).toBeTruthy()

    const htmlTable = table.querySelector('[data-slot="table"]')
    expect(htmlTable).toHaveClass("w-full")
    expect(htmlTable).not.toHaveClass("min-w-max")

    const nameCell = screen.getByTestId("project-table-name").closest("td")
    expect(nameCell).toHaveClass("min-w-[12rem]")
    expect(nameCell).not.toHaveClass("max-w-0")
    expect(screen.getByTestId("project-table-organization")).toHaveClass("min-w-0", "max-w-full")
    expect(screen.getByRole("button", { name: /^Status$/i })).toBeInTheDocument()
  })

  it("renders teams-style panel chrome and team-detail cell typography", () => {
    renderTable([baseProject({ id: "chrome", name: "Gospels" })])
    expect(screen.getByTestId("org-projects-table")).toHaveClass("rounded-lg!", "bg-card")
    expect(screen.getByRole("textbox", { name: /Search projects/i })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Project/i })).toBeInTheDocument()
    expect(screen.getByText("Gospels")).toHaveClass("font-medium")
    // RoleLabel resolves the localized display name (AQU-511) — "Maintainer",
    // not the raw role name with a CSS capitalize class.
    expect(screen.getByText("Maintainer")).toBeInTheDocument()
  })

  it("renders one chip per lane with the '' default lane first, labeled with the target language", () => {
    const p = baseProject({
      id: "p1",
      name: "Gospels",
      lanes: [
        { lane: "", totalCells: 100, filledCells: 68, validatedCells: 40, lastEditAt: now },
        { lane: "es", totalCells: 100, filledCells: 22, validatedCells: 8, lastEditAt: now },
        { lane: "fr", totalCells: 100, filledCells: 50, validatedCells: 30, lastEditAt: now },
      ],
    })
    renderTable([p], { defaultLabels: { p1: "en-target" } })

    const defaultChip = screen.getByTestId("lane-chip-p1-")
    expect(defaultChip).toHaveTextContent("en-target")
    expect(defaultChip).toHaveTextContent("68%")
    expect(defaultChip.parentElement).toHaveClass("min-w-0", "max-w-full")
    expect(defaultChip).toHaveClass("min-w-0", "max-w-full", "overflow-hidden")
    const esChip = screen.getByTestId("lane-chip-p1-es")
    expect(esChip).toHaveTextContent("es")
    expect(esChip).toHaveTextContent("22%")
    expect(screen.getByTestId("lane-chip-p1-fr")).toBeInTheDocument()

    // Default lane chip is rendered before the named lane chips.
    const position = esChip.compareDocumentPosition(defaultChip)
    expect(position & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })

  it("labels a migrated project's default lane from the project target language (AQU-606)", () => {
    // Post-lanes-migration shape: the target lives on project settings and no
    // per-file hint reaches the table, so the chip used to read "Default".
    const p = baseProject({ id: "p6", name: "Migrated", totalCells: 100, filledCells: 25, targetLanguage: "French" })
    renderTable([p], { defaultLabels: {} })

    const chip = screen.getByTestId("lane-chip-p6-")
    expect(chip).toHaveTextContent("French")
    expect(chip).not.toHaveTextContent("Default")
  })

  it("shows the neutral placeholder when the project has no target language (AQU-606)", () => {
    const p = baseProject({ id: "p7", name: "Untargeted", totalCells: 100, filledCells: 25 })
    renderTable([p], { defaultLabels: {} })

    expect(screen.getByTestId("lane-chip-p7-")).toHaveTextContent("Default")
  })

  it("renders a single chip for a project with no lane breakdown (single-lane, no regression)", () => {
    const p = baseProject({ id: "p2", name: "Ruth", totalCells: 200, filledCells: 100 })
    renderTable([p], { defaultLabels: { p2: "sw" } })

    const chip = screen.getByTestId("lane-chip-p2-")
    expect(chip).toHaveTextContent("sw")
    expect(chip).toHaveTextContent("50%")
    // No named-lane chips and no overflow affordance.
    expect(screen.queryByTestId("lane-chip-overflow-p2")).not.toBeInTheDocument()
  })

  it("collapses lanes beyond the cap into a '+N' overflow that expands the row", () => {
    const lanes = [
      { lane: "", totalCells: 100, filledCells: 10, validatedCells: 0, lastEditAt: now },
      { lane: "es", totalCells: 100, filledCells: 20, validatedCells: 0, lastEditAt: now },
      { lane: "fr", totalCells: 100, filledCells: 30, validatedCells: 0, lastEditAt: now },
      { lane: "de", totalCells: 100, filledCells: 40, validatedCells: 0, lastEditAt: now },
    ]
    renderTable([baseProject({ id: "p3", lanes })])

    const overflow = screen.getByTestId("lane-chip-overflow-p3")
    expect(overflow).toHaveTextContent("+1")
    expect(screen.queryByTestId("project-lanes-subrow-p3")).not.toBeInTheDocument()
    fireEvent.click(overflow)
    expect(screen.getByTestId("project-lanes-subrow-p3")).toBeInTheDocument()
  })
})

describe("OrgProjectsDataTable expandable lane sub-rows (AQU-538 §3.2)", () => {
  const p = baseProject({
    id: "p1",
    name: "Gospels",
    lanes: [
      { lane: "", totalCells: 100, filledCells: 68, validatedCells: 40, lastEditAt: now },
      { lane: "es", totalCells: 100, filledCells: 22, validatedCells: 8, lastEditAt: now },
    ],
  })

  it("expands via language overflow into one sub-row per lane with correct translated/validated pcts", () => {
    const lanes = [
      { lane: "", totalCells: 100, filledCells: 68, validatedCells: 40, lastEditAt: now },
      { lane: "es", totalCells: 100, filledCells: 22, validatedCells: 8, lastEditAt: now },
      { lane: "fr", totalCells: 100, filledCells: 10, validatedCells: 0, lastEditAt: now },
      { lane: "de", totalCells: 100, filledCells: 10, validatedCells: 0, lastEditAt: now },
    ]
    renderTable([baseProject({ id: "p1", name: "Gospels", lanes })], { defaultLabels: { p1: "en-target" } })
    fireEvent.click(screen.getByTestId("lane-chip-overflow-p1"))

    const defaultRow = screen.getByTestId("project-lane-row-p1-")
    expect(defaultRow).toHaveTextContent("en-target")
    expect(defaultRow).toHaveTextContent("68%")
    expect(defaultRow).toHaveTextContent("40% validated")

    const esRow = screen.getByTestId("project-lane-row-p1-es")
    expect(esRow).toHaveTextContent("22%")
    expect(esRow).toHaveTextContent("8% validated")
  })

  it("Open links carry ?lane= for named lanes and no lane query for the default lane", () => {
    const lanes = [
      { lane: "", totalCells: 100, filledCells: 68, validatedCells: 40, lastEditAt: now },
      { lane: "es", totalCells: 100, filledCells: 22, validatedCells: 8, lastEditAt: now },
      { lane: "fr", totalCells: 100, filledCells: 10, validatedCells: 0, lastEditAt: now },
      { lane: "de", totalCells: 100, filledCells: 10, validatedCells: 0, lastEditAt: now },
    ]
    renderTable([baseProject({ id: "p1", name: "Gospels", lanes })], { defaultLabels: { p1: "en-target" } })
    fireEvent.click(screen.getByTestId("lane-chip-overflow-p1"))

    const defaultOpen = within(screen.getByTestId("project-lane-row-p1-")).getByRole("link", {
      name: /open/i,
    })
    expect(defaultOpen.getAttribute("href")).toBe("/project/p1/editor")

    const esOpen = within(screen.getByTestId("project-lane-row-p1-es")).getByRole("link", {
      name: /open/i,
    })
    expect(esOpen.getAttribute("href")).toBe("/project/p1/editor?lane=es")
  })

  it("Assign… on a lane sub-row opens the lane-scoped assign modal", () => {
    const lanes = [
      { lane: "", totalCells: 100, filledCells: 68, validatedCells: 40, lastEditAt: now },
      { lane: "es", totalCells: 100, filledCells: 22, validatedCells: 8, lastEditAt: now },
      { lane: "fr", totalCells: 100, filledCells: 10, validatedCells: 0, lastEditAt: now },
      { lane: "de", totalCells: 100, filledCells: 10, validatedCells: 0, lastEditAt: now },
    ]
    renderTable([baseProject({ id: "p1", name: "Gospels", lanes })])
    fireEvent.click(screen.getByTestId("lane-chip-overflow-p1"))
    const esRow = screen.getByTestId("project-lane-row-p1-es")
    fireEvent.click(within(esRow).getByRole("button", { name: /assign/i }))
    expect(screen.getByTestId("assign-open-p1-es")).toBeInTheDocument()
  })

  it("row … menu offers Assign work and Add member", () => {
    renderTable([p])
    fireEvent.click(screen.getByTestId("project-row-actions-p1"))
    expect(screen.getByRole("menuitem", { name: /assign work/i })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /add member/i })).toBeInTheDocument()
  })

  it("Assign work from the … menu opens the assign modal for the default lane", () => {
    renderTable([p])
    fireEvent.click(screen.getByTestId("project-row-actions-p1"))
    fireEvent.click(screen.getByRole("menuitem", { name: /assign work/i }))
    expect(screen.getByTestId("assign-open-p1-")).toBeInTheDocument()
  })
})

describe("PM column self marker (AQU-1027)", () => {
  const rows = () => [
    baseProject({ id: "gospels", name: "Gospels", pm: { id: 5, username: "anna" } }),
    baseProject({ id: "ruth", name: "Ruth", pm: { id: 6, username: "mark" } }),
    baseProject({ id: "acts", name: "Acts", pm: null }),
  ]

  it("marks only the rows the viewer manages", () => {
    renderTable(rows(), { viewerUsername: "anna" })

    const marks = screen.getAllByTestId("project-pm-you")
    expect(marks).toHaveLength(1)
    // The marker sits beside the PM's name, not on its own.
    expect(marks[0].closest("td")?.textContent).toContain("anna")
  })

  it("matches the viewer when the stored PM name differs in case", () => {
    const cased = rows().map((p) =>
      p.id === "gospels" ? { ...p, pm: { id: 5, username: "Anna" } } : p,
    )
    renderTable(cased, { viewerUsername: "anna" })
    expect(screen.getAllByTestId("project-pm-you")).toHaveLength(1)
  })

  it("marks nothing when nobody is signed in", () => {
    renderTable(rows(), { viewerUsername: null })
    expect(screen.queryAllByTestId("project-pm-you")).toHaveLength(0)
  })

  it("marks nothing when the viewer manages none of the rows", () => {
    renderTable(rows(), { viewerUsername: "zoe" })
    expect(screen.queryAllByTestId("project-pm-you")).toHaveLength(0)
  })

  // Deliberate non-goal: the embedded all-orgs table drops the PM column
  // entirely, so there is no PM cell to mark. Pinned so it is not "fixed".
  it("is absent in embedded layout, which has no PM column at all", () => {
    renderTable(rows(), { viewerUsername: "anna", layout: "embedded" })
    expect(screen.queryAllByTestId("project-pm-you")).toHaveLength(0)
  })
})

describe("OrgProjectsDataTable async directory", () => {
  it("does not locally filter rows when search is controlled by the parent", () => {
    const onSearchChange = vi.fn()
    renderTable(
      [baseProject({ id: "gospels", name: "Gospels" }), baseProject({ id: "ruth", name: "Ruth" })],
      { searchValue: "zzz", onSearchChange },
    )
    expect(screen.getByText("Gospels")).toBeInTheDocument()
    expect(screen.getByText("Ruth")).toBeInTheDocument()
    fireEvent.change(screen.getByRole("textbox", { name: /Search projects/i }), {
      target: { value: "gos" },
    })
    expect(onSearchChange).toHaveBeenCalledWith("gos")
    expect(screen.getByText("Ruth")).toBeInTheDocument()
  })

  it("shows a spinner in the search field while the directory query is in flight", () => {
    renderTable([baseProject({ id: "gospels", name: "Gospels" })], {
      searchValue: "gos",
      onSearchChange: vi.fn(),
      searching: true,
    })
    const search = screen.getByRole("textbox", { name: /Search projects/i })
    expect(search.closest("[data-slot='input-group']")).toHaveAttribute("aria-busy", "true")
    expect(screen.getByRole("status", { name: /searching/i })).toBeInTheDocument()
    expect(screen.getByText("Gospels")).toBeInTheDocument()
  })

  it("renders the load-more sentinel when another page remains", () => {
    renderTable([baseProject({ id: "gospels", name: "Gospels" })], {
      hasMore: true,
      onLoadMore: vi.fn(),
    })
    expect(screen.getByTestId("project-directory-load-more")).toBeInTheDocument()
  })
})
