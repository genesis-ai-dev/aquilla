// AQU-712: project creation is retry-safe. The draft project id is minted once
// per dialog session (on open) and reused across every submit attempt within
// that session, so an error-then-retry after the server already committed —
// or a double-submit — lands on the same row via the server's
// `ON CONFLICT(id) DO NOTHING` dedup instead of creating a duplicate project.
// Closing and reopening the dialog mints a fresh id, so two same-named projects
// created in separate sessions stay distinct (no false dedup).

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ProjectCreateDialog } from "./ProjectCreateDialog"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "tok", username: "wendi" },
    loading: false,
  }),
}))

vi.mock("@/hooks/useAccessibleProjects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useAccessibleProjects")>()
  return {
    ...actual,
    useProjectsForNavigation: () => ({
      projects: [],
      isLoading: false,
      refresh: vi.fn(),
    }),
  }
})

vi.mock("@/lib/sync/cloud-projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/cloud-projects")>()
  return { ...actual, createCloudProject: vi.fn().mockResolvedValue(undefined) }
})

vi.mock("@/lib/sync/project-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/project-settings")>()
  return {
    ...actual,
    fetchProjectSettings: vi.fn(),
    patchProjectSettings: vi.fn().mockResolvedValue({
      kind: "ok",
      value: {
        version: 1,
        updatedAt: "2026-07-13T00:00:00.000Z",
        updatedBy: { id: 1, username: "wendi" },
        settings: {},
      },
    }),
  }
})

vi.mock("@/lib/store/project-index", () => ({
  createProject: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/posthog", () => ({ default: { capture: vi.fn() } }))

import { createCloudProject } from "@/lib/sync/cloud-projects"
import { createProject } from "@/lib/store/project-index"

const mockCreateCloudProject = vi.mocked(createCloudProject)
const mockCreateProject = vi.mocked(createProject)

/** The `id` passed to createCloudProject on the Nth (0-based) call. */
function createdIdAt(call: number): string {
  return (mockCreateCloudProject.mock.calls[call]![1] as { id: string }).id
}

function fillBasics(name = "Russian BSB") {
  fireEvent.change(screen.getByPlaceholderText("My Translation Project"), {
    target: { value: name },
  })
  fireEvent.change(screen.getByPlaceholderText(/English, Grade 7 English/i), {
    target: { value: "English" },
  })
  fireEvent.change(screen.getByPlaceholderText(/French, conversational Swahili/i), {
    target: { value: "Russian" },
  })
}

function clickCreate() {
  fireEvent.click(screen.getByRole("button", { name: /Create Project/i }))
}

describe("ProjectCreateDialog — retry-safe project creation (AQU-712)", () => {
  beforeEach(() => {
    mockCreateCloudProject.mockReset()
    mockCreateCloudProject.mockResolvedValue(undefined)
    mockCreateProject.mockClear()
  })

  it("error-then-retry in the same dialog session reuses the same id (server dedup lands one row)", async () => {
    // First submit errors client-side (e.g. a network drop after the server
    // committed the row); the second submit in the still-open dialog succeeds.
    mockCreateCloudProject
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(undefined)

    render(<ProjectCreateDialog onCreated={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "New project" }))
    fillBasics()

    clickCreate()
    await waitFor(() => {
      expect(mockCreateCloudProject).toHaveBeenCalledTimes(1)
    })
    // The create failed, so the dialog stays open (not the local-create path)
    // and no local project row was written yet.
    expect(screen.getByText("Create New Project")).toBeTruthy()
    expect(mockCreateProject).not.toHaveBeenCalled()

    clickCreate()
    await waitFor(() => {
      expect(mockCreateCloudProject).toHaveBeenCalledTimes(2)
    })

    // Same id across both attempts → the server's ON CONFLICT(id) DO NOTHING
    // dedup catches the retry instead of inserting a second project row.
    expect(createdIdAt(1)).toBe(createdIdAt(0))
    // The retry proceeds normally: exactly one local project write.
    await waitFor(() => {
      expect(mockCreateProject).toHaveBeenCalledTimes(1)
    })
  })

  it("closing and reopening the dialog mints a fresh id (same name → distinct projects, no false dedup)", async () => {
    render(<ProjectCreateDialog onCreated={vi.fn()} />)

    // Session 1: create "Russian BSB" successfully → dialog closes.
    fireEvent.click(screen.getByRole("button", { name: "New project" }))
    fillBasics("Russian BSB")
    clickCreate()
    await waitFor(() => {
      expect(mockCreateCloudProject).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(screen.queryByText("Create New Project")).toBeNull()
    })

    // Session 2: reopen and create a project with the SAME name.
    fireEvent.click(screen.getByRole("button", { name: "New project" }))
    fillBasics("Russian BSB")
    clickCreate()
    await waitFor(() => {
      expect(mockCreateCloudProject).toHaveBeenCalledTimes(2)
    })

    // Different ids → two genuinely distinct projects, not a false dedup.
    expect(createdIdAt(1)).not.toBe(createdIdAt(0))
  })
})
