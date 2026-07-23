// AQU-538 §3.2 — org "Language Grid" on the project table: lane chips,
// expandable per-lane sub-rows, "+ Language" quick action gating.

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
      />
    </MemoryRouter>,
  )
}

describe("OrgProjectsDataTable lane chips (AQU-538 §3.2)", () => {
  it("uses compact accessible metric headings and left-aligned values", () => {
    renderTable([baseProject({ id: "metrics", filledCells: 40, validatedCells: 20, audioCells: 10 })])

    expect(screen.getByTestId("project-table-translated-header")).toHaveAttribute("aria-label", "Translated")
    expect(screen.getByTestId("project-table-validated-header")).toHaveAttribute("aria-label", "Validated")
    expect(screen.getByTestId("project-table-audio-header")).toHaveAttribute("aria-label", "Has audio")
    expect(screen.getByTestId("project-table-translated-value")).toHaveClass("text-left")
    expect(screen.getByTestId("project-table-validated-value")).toHaveClass("text-left")
    expect(screen.getByTestId("project-table-audio-value")).toHaveClass("text-left")
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
    expect(defaultChip.parentElement).toHaveClass("min-w-0", "max-w-full", "flex-1")
    expect(defaultChip).toHaveClass("min-w-0", "max-w-full", "overflow-hidden")
    const esChip = screen.getByTestId("lane-chip-p1-es")
    expect(esChip).toHaveTextContent("es")
    expect(esChip).toHaveTextContent("22%")
    expect(screen.getByTestId("lane-chip-p1-fr")).toBeInTheDocument()

    // Default lane chip is rendered before the named lane chips.
    const position = esChip.compareDocumentPosition(defaultChip)
    expect(position & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
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

  it("expands into one sub-row per lane with correct translated/validated pcts", () => {
    renderTable([p], { defaultLabels: { p1: "en-target" } })
    fireEvent.click(screen.getByTestId("project-lanes-expand-p1"))

    const defaultRow = screen.getByTestId("project-lane-row-p1-")
    expect(defaultRow).toHaveTextContent("en-target")
    expect(defaultRow).toHaveTextContent("68%")
    expect(defaultRow).toHaveTextContent("40% validated")

    const esRow = screen.getByTestId("project-lane-row-p1-es")
    expect(esRow).toHaveTextContent("22%")
    expect(esRow).toHaveTextContent("8% validated")
  })

  it("Open links carry ?lane= for named lanes and no lane query for the default lane", () => {
    renderTable([p], { defaultLabels: { p1: "en-target" } })
    fireEvent.click(screen.getByTestId("project-lanes-expand-p1"))

    const defaultOpen = within(screen.getByTestId("project-lane-row-p1-")).getByRole("link", {
      name: /open/i,
    })
    expect(defaultOpen.getAttribute("href")).toBe("/project/p1")

    const esOpen = within(screen.getByTestId("project-lane-row-p1-es")).getByRole("link", {
      name: /open/i,
    })
    expect(esOpen.getAttribute("href")).toBe("/project/p1?lane=es")
  })

  it("Assign… on a lane sub-row opens the lane-scoped assign modal", () => {
    renderTable([p])
    fireEvent.click(screen.getByTestId("project-lanes-expand-p1"))
    const esRow = screen.getByTestId("project-lane-row-p1-es")
    fireEvent.click(within(esRow).getByRole("button", { name: /assign/i }))
    expect(screen.getByTestId("assign-open-p1-es")).toBeInTheDocument()
  })
})

describe("OrgProjectsDataTable '+ Language' quick action (AQU-538 §3.2)", () => {
  it("shows the + Language action for a maintainer (600+)", () => {
    renderTable([baseProject({ id: "p1" })], { role: 600 })
    expect(screen.getByTestId("org-add-lang-p1")).toBeInTheDocument()
  })

  it("hides the + Language action for a below-maintainer role", () => {
    renderTable([baseProject({ id: "p1" })], { role: 400 })
    expect(screen.queryByTestId("org-add-lang-p1")).not.toBeInTheDocument()
  })

  it("still shows the + Language action when the row's role is unknown (403 surfaces later)", () => {
    // No role entry for this project id → level is undefined.
    render(
      <MemoryRouter>
        <OrgProjectsDataTable
          projects={[baseProject({ id: "p1" })]}
          now={now}
          roleByProjectId={new Map()}
          jwt="jwt"
          author="anna"
        />
      </MemoryRouter>,
    )
    expect(screen.getByTestId("org-add-lang-p1")).toBeInTheDocument()
  })
})
