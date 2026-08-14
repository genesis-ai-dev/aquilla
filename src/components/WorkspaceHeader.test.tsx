import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { WorkspaceHeader } from "./WorkspaceHeader"
import type { ProjectRecord } from "@/lib/parsers/types"

const orgContext = vi.hoisted(() => ({
  activeOrgId: 7 as number | null,
  isAllOrgs: false,
  orgs: [{ id: 7, name: "Dev Org" }],
  guestOrgs: [] as { id: number; name: string | null }[],
  setActiveOrg: vi.fn(),
  setAllOrgs: vi.fn(),
}))

vi.mock("@/context/OrgContext", () => ({
  useActiveOrg: () => ({
    ...orgContext,
    activeOrg: orgContext.orgs.find((org) => org.id === orgContext.activeOrgId) ?? null,
    guestOrgs: orgContext.guestOrgs,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}))

const project = {
  id: "project-1",
  name: "Dev Project",
  orgId: 7,
} as unknown as ProjectRecord

function renderHeader(ui: ReactNode, initialEntry = "/project/project-1/comments") {
  return render(<MemoryRouter initialEntries={[initialEntry]}>{ui}</MemoryRouter>)
}

describe("WorkspaceHeader editor handoff crumb", () => {
  beforeEach(() => {
    orgContext.activeOrgId = 7
    orgContext.isAllOrgs = false
    orgContext.setActiveOrg.mockClear()
    orgContext.setAllOrgs.mockClear()
  })

  it("inserts a clickable Editor crumb when opened from the editor", () => {
    renderHeader(
      <WorkspaceHeader
        project={project}
        overviewHref="/projects/project-1"
        surfaceLabel="Comments"
        editorHref="/project/project-1/editor/file/f1"
      />,
    )

    expect(screen.getByRole("link", { name: "Editor" })).toHaveAttribute(
      "href",
      "/project/project-1/editor/file/f1",
    )
    expect(screen.getByText("Comments")).toHaveAttribute("aria-current", "page")
  })

  it("omits Editor when the overlay was not opened from the editor", () => {
    renderHeader(
      <WorkspaceHeader
        project={project}
        overviewHref="/projects/project-1"
        surfaceLabel="Comments"
      />,
    )

    expect(screen.queryByRole("link", { name: "Editor" })).not.toBeInTheDocument()
    expect(screen.getByText("Comments")).toHaveAttribute("aria-current", "page")
  })
})
