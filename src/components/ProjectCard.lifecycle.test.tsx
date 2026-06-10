// FRO-214: ProjectCard inactive badge + lifecycle toggle tests.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ProjectCard } from "./ProjectCard"
import type { ProjectRecord } from "@/lib/parsers/types"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "wendi" }, loading: false }),
}))
vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: () => ({ members: [], isLoading: false }),
}))
vi.mock("@/hooks/useProjectHealth", () => ({
  useProjectHealth: () => ({ projectHealth: null, loading: false }),
}))

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "proj-1",
    name: "Bambara NT",
    files: [],
    members: [],
    sourceLanguage: "",
    targetLanguage: "",
    createdAt: new Date().toISOString(),
    syncRole: { level: 700, name: "owner", source: "creator", fetchedAt: new Date().toISOString() },
    ...overrides,
  } as unknown as ProjectRecord
}

describe("ProjectCard — Inactive badge", () => {
  it("does NOT show the Inactive badge for an active project", () => {
    render(
      <ProjectCard project={makeProject({ isActive: true })} onClick={() => {}} />,
    )
    expect(screen.queryByTestId("inactive-badge")).toBeNull()
  })

  it("does NOT show the Inactive badge when isActive is absent", () => {
    render(
      <ProjectCard project={makeProject()} onClick={() => {}} />,
    )
    expect(screen.queryByTestId("inactive-badge")).toBeNull()
  })

  it("shows the Inactive badge for an inactive project", () => {
    render(
      <ProjectCard project={makeProject({ isActive: false })} onClick={() => {}} />,
    )
    expect(screen.getByTestId("inactive-badge")).toBeDefined()
    expect(screen.getByTestId("inactive-badge").textContent).toContain("Inactive")
  })

  it("dims the card for an inactive project", () => {
    render(
      <ProjectCard project={makeProject({ isActive: false })} onClick={() => {}} />,
    )
    expect(screen.getByTestId("inactive-project-card")).toBeDefined()
  })
})

describe("ProjectCard — lifecycle toggle overflow item", () => {
  it("shows 'Mark as Inactive' for an active project when canToggleLifecycle=true", () => {
    const onToggle = vi.fn()
    render(
      <ProjectCard
        project={makeProject({ isActive: true })}
        onClick={() => {}}
        canToggleLifecycle={true}
        onToggleLifecycle={onToggle}
      />,
    )
    // open the overflow menu
    const menuBtn = screen.getByLabelText("Project actions")
    fireEvent.click(menuBtn)
    const toggleBtn = screen.getByTestId("toggle-lifecycle-button")
    expect(toggleBtn.textContent).toContain("Mark as Inactive")
    fireEvent.click(toggleBtn)
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it("shows 'Mark as Active' for an inactive project when canToggleLifecycle=true", () => {
    const onToggle = vi.fn()
    render(
      <ProjectCard
        project={makeProject({ isActive: false })}
        onClick={() => {}}
        canToggleLifecycle={true}
        onToggleLifecycle={onToggle}
      />,
    )
    const menuBtn = screen.getByLabelText("Project actions")
    fireEvent.click(menuBtn)
    const toggleBtn = screen.getByTestId("toggle-lifecycle-button")
    expect(toggleBtn.textContent).toContain("Mark as Active")
  })

  it("does NOT show lifecycle toggle when canToggleLifecycle is false", () => {
    render(
      <ProjectCard
        project={makeProject({ isActive: false })}
        onClick={() => {}}
        canToggleLifecycle={false}
        onToggleLifecycle={() => {}}
        canTrash={true}
        onTrash={() => {}}
      />,
    )
    const menuBtn = screen.getByLabelText("Project actions")
    fireEvent.click(menuBtn)
    expect(screen.queryByTestId("toggle-lifecycle-button")).toBeNull()
  })
})
