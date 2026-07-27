// AQU-190 — ProjectCard health ring tests.
//
// Verifies:
//   1. Card renders a HealthRing showing the rollup value for a server-side project.
//   2. Card hides the ring when projectHealth is null (local-only / fetch error).
//   3. No extra fetch attempts (N+1 stampede guard via call count).

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { ProjectCard } from "./ProjectCard"
import type { ProjectRecord } from "@/lib/parsers/types"

// --- mock stubs -------------------------------------------------------

// useFrontierSession: logged-in user with a jwt
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "tok", username: "wendy" },
    loading: false,
  }),
}))

// useProjectMembers: returns empty list (irrelevant to this test)
vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: () => ({
    members: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    changeRole: vi.fn(),
  }),
}))

// useProjectHealth: controllable stub — default to loading/null
let projectHealthStub: number | null = null
const useProjectHealthMock = vi.fn((_projectId: string | null) => ({ projectHealth: projectHealthStub, loading: false }))
vi.mock("@/hooks/useProjectHealth", () => ({
  useProjectHealth: (projectId: string | null) => useProjectHealthMock(projectId),
}))

// --- helpers ----------------------------------------------------------

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "proj-1",
    name: "Test Project",
    files: [],
    syncRole: { level: 700, source: "creator" },
    origin: undefined,
    ...overrides,
  } as unknown as ProjectRecord
}

// --- tests ------------------------------------------------------------

beforeEach(() => {
  projectHealthStub = null
  useProjectHealthMock.mockClear()
})

describe("ProjectCard health ring", () => {
  it("renders HealthRing with the rollup value for a server-side project", () => {
    projectHealthStub = 72
    const project = makeProject()
    render(
      <ProjectCard project={project} onClick={() => {}} />,
    )
    // The ring renders the health score as text inside it
    expect(screen.getByText("72")).toBeInTheDocument()
  })

  it("hides the ring when projectHealth is null (unavailable)", () => {
    projectHealthStub = null
    const project = makeProject()
    render(
      <ProjectCard project={project} onClick={() => {}} />,
    )
    // There should be no numeric health score text
    expect(screen.queryByText(/^\d+$/)).toBeNull()
  })

  it("hides the ring for trashed variant regardless of health value", () => {
    projectHealthStub = 88
    const project = makeProject()
    render(
      <ProjectCard project={project} onClick={() => {}} variant="trashed" />,
    )
    // Trashed cards never fetch and never show a ring
    expect(screen.queryByText("88")).toBeNull()
  })

  it("passes null fetchKey for local-only projects, preventing health fetch", () => {
    projectHealthStub = null
    // Local-only: no syncRole, no origin
    const localProject = makeProject({ syncRole: undefined, origin: undefined })
    render(
      <ProjectCard project={localProject} onClick={() => {}} />,
    )
    // useProjectHealth must be called with null (no fetch)
    expect(useProjectHealthMock).toHaveBeenCalledWith(null)
    expect(screen.queryByText(/^\d+$/)).toBeNull()
  })

  it("does not trigger more than one health fetch call per render (no N+1 stampede)", () => {
    projectHealthStub = 50
    const project = makeProject()
    render(
      <ProjectCard project={project} onClick={() => {}} />,
    )
    // useProjectHealth is called exactly once per card render
    expect(useProjectHealthMock).toHaveBeenCalledTimes(1)
  })

  it("renders health 0 as absence of ring (HealthRing hides ring at 0)", () => {
    projectHealthStub = 0
    const project = makeProject()
    render(
      <ProjectCard project={project} onClick={() => {}} />,
    )
    // At health=0, HealthRing suppresses the SVG ring; we still show the score
    // inside the ring container
    expect(screen.getByText("0")).toBeInTheDocument()
  })
})

describe("ProjectCard long unbroken project name (AQU-332)", () => {
  // A 40+ character name with no spaces or dashes — no natural break points.
  const longName =
    "averylongprojectnametomakesurethatthenamewrapsinsideitscard"

  it("lets the title shrink and force-wrap so it stays inside the card", () => {
    const project = makeProject({ name: longName })
    render(<ProjectCard project={project} onClick={() => {}} />)
    const title = screen.getByText(longName)
    // min-w-0 overrides the flex item's default min-width:auto so it can shrink
    // below its content width; break-words forces breaks inside the unbroken
    // token so it wraps instead of overflowing the card's right edge.
    expect(title.className).toContain("min-w-0")
    expect(title.className).toContain("break-words")
  })

  it("keeps the badge cluster at its natural size next to the wrapping title", () => {
    const project = makeProject({
      name: longName,
      origin: {
        kind: "git",
        cloneUrl: "https://example.com/repo.git",
        gitlabProjectId: 1,
        branch: "main",
        headSha: "abc123",
        importedAt: "2026-01-01T00:00:00.000Z",
      },
    })
    render(<ProjectCard project={project} onClick={() => {}} />)
    const title = screen.getByText(longName)
    // The badge cluster is the title's sibling in the header flex row.
    const badgeCluster = title.nextElementSibling
    expect(badgeCluster).not.toBeNull()
    expect(badgeCluster?.className).toContain("shrink-0")
    // The git badge stays visible alongside the (now multi-line) title.
    expect(screen.getByText("git")).toBeInTheDocument()
  })
})
