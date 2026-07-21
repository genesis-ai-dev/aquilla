/**
 * AgentMemoryTab.test.tsx — the memory tab must load all three sections,
 * flip a proposed memory's status optimistically on approve/reject (and
 * revert on a failed request), set the human-edited badge after an edit, and
 * surface the brief's 409 version-conflict path with a reload affordance
 * instead of silently discarding the edit.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import AgentMemoryTab from "./AgentMemoryTab"
import type { AgentMemory, ProjectBrief } from "@/lib/agent/memory-api"
import { ROLE } from "@/lib/agent/role-floors"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: vi.fn(() => ({
    session: { jwt: "test-jwt", username: "alice" },
    loading: false,
  })),
}))

vi.mock("@/lib/agent/memory-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent/memory-api")>("@/lib/agent/memory-api")
  return {
    ...actual,
    listAgentMemories: vi.fn(),
    getProjectBrief: vi.fn(),
    listBriefProposals: vi.fn(),
    reviewAgentMemory: vi.fn(),
    editAgentMemory: vi.fn(),
    putProjectBrief: vi.fn(),
    proposeBriefUpdate: vi.fn(),
    reviewBriefProposal: vi.fn(),
  }
})

import {
  listAgentMemories,
  getProjectBrief,
  listBriefProposals,
  reviewAgentMemory,
  editAgentMemory,
  putProjectBrief,
  VersionConflictError,
} from "@/lib/agent/memory-api"

const mockListAgentMemories = vi.mocked(listAgentMemories)
const mockGetProjectBrief = vi.mocked(getProjectBrief)
const mockListBriefProposals = vi.mocked(listBriefProposals)
const mockReviewAgentMemory = vi.mocked(reviewAgentMemory)
const mockEditAgentMemory = vi.mocked(editAgentMemory)
const mockPutProjectBrief = vi.mocked(putProjectBrief)

const PROPOSED_MEMORY: AgentMemory = {
  id: "mem-1",
  projectId: "proj-1",
  path: "observations/foo.md",
  content: "the agent noticed X",
  status: "proposed",
  humanEdited: false,
  rationale: "seen twice this run",
  provenance: { runId: "run-42" },
  createdBy: "agent",
  reviewedBy: null,
  version: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}

const APPROVED_MEMORY: AgentMemory = {
  ...PROPOSED_MEMORY,
  id: "mem-2",
  path: "conventions/style.md",
  status: "approved",
  humanEdited: false,
  version: 1,
}

const BRIEF: ProjectBrief = {
  projectId: "proj-1",
  content: "this project translates Mark",
  updatedBy: "alice",
  version: 1,
  updatedAt: "2026-01-01T00:00:00Z",
}

beforeEach(() => {
  vi.clearAllMocks()
  mockListAgentMemories.mockResolvedValue([PROPOSED_MEMORY, APPROVED_MEMORY])
  mockGetProjectBrief.mockResolvedValue(BRIEF)
  mockListBriefProposals.mockResolvedValue([])
})

describe("loading and layout", () => {
  it("loads memories + brief and renders the proposed count badge", async () => {
    render(<AgentMemoryTab projectId="proj-1" roleLevel={ROLE.PROJECT_LEAD} />)
    await waitFor(() => expect(screen.getByText("observations/foo.md")).toBeInTheDocument())
    expect(mockListAgentMemories).toHaveBeenCalledWith("test-jwt", "proj-1")
    expect(mockGetProjectBrief).toHaveBeenCalledWith("test-jwt", "proj-1")
    // Proposed tab trigger shows the pending count.
    expect(screen.getByRole("tab", { name: /Proposed/ })).toHaveTextContent("1")
  })

  it("tags proposed and approved rows with data-memory-path for e2e selectors", async () => {
    const { container } = render(<AgentMemoryTab projectId="proj-1" roleLevel={ROLE.PROJECT_LEAD} />)
    await waitFor(() => expect(screen.getByText("observations/foo.md")).toBeInTheDocument())
    expect(container.querySelector('[data-memory-path="observations/foo.md"]')).not.toBeNull()
    // Switch to the approved tab to render the approved list row.
    fireEvent.click(screen.getByRole("tab", { name: /Approved/ }))
    await waitFor(() =>
      expect(container.querySelector('[data-memory-path="conventions/style.md"]')).not.toBeNull(),
    )
  })

  it("shows an error state with a retry affordance when the initial load fails", async () => {
    mockListAgentMemories.mockRejectedValueOnce(new Error("network down"))
    render(<AgentMemoryTab projectId="proj-1" roleLevel={ROLE.PROJECT_LEAD} />)
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("network down"))
    expect(screen.getByText("Retry")).toBeInTheDocument()
  })
})

describe("proposed queue approve/reject", () => {
  it("approve flips the row out of the proposed list and calls the API", async () => {
    mockReviewAgentMemory.mockResolvedValueOnce({ ...PROPOSED_MEMORY, status: "approved" })
    render(<AgentMemoryTab projectId="proj-1" roleLevel={ROLE.PROJECT_LEAD} />)
    await waitFor(() => expect(screen.getByText("observations/foo.md")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: /Approve/ }))

    // Optimistic: the proposed-count badge drops before the request settles.
    await waitFor(() => expect(mockReviewAgentMemory).toHaveBeenCalledWith("test-jwt", "proj-1", "mem-1", "approve"))
    await waitFor(() => expect(screen.queryByText("observations/foo.md")).not.toBeInTheDocument())
  })

  it("reverts the optimistic flip when the approve request fails", async () => {
    mockReviewAgentMemory.mockRejectedValueOnce(new Error("403 forbidden"))
    render(<AgentMemoryTab projectId="proj-1" roleLevel={ROLE.PROJECT_LEAD} />)
    await waitFor(() => expect(screen.getByText("observations/foo.md")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: /Approve/ }))

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("403 forbidden"))
    // Row is back in the proposed list after the revert.
    expect(screen.getByText("observations/foo.md")).toBeInTheDocument()
  })

  it("reject requires confirmation before calling the API", async () => {
    mockReviewAgentMemory.mockResolvedValueOnce({ ...PROPOSED_MEMORY, status: "rejected" })
    render(<AgentMemoryTab projectId="proj-1" roleLevel={ROLE.PROJECT_LEAD} />)
    await waitFor(() => expect(screen.getByText("observations/foo.md")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: "Reject" }))
    expect(mockReviewAgentMemory).not.toHaveBeenCalled()

    const dialog = screen.getByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Reject" }))
    await waitFor(() => expect(mockReviewAgentMemory).toHaveBeenCalledWith("test-jwt", "proj-1", "mem-1", "reject"))
  })

  it("hides Approve/Reject and shows a role notice below the review floor", async () => {
    render(<AgentMemoryTab projectId="proj-1" roleLevel={ROLE.CONTRIBUTOR} />)
    await waitFor(() => expect(screen.getByText("observations/foo.md")).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument()
    expect(screen.getByText(/Requires project lead or higher/)).toBeInTheDocument()
  })
})

describe("approved list edit", () => {
  it("editing a memory sets the human-edited badge", async () => {
    mockEditAgentMemory.mockResolvedValueOnce({ ...APPROVED_MEMORY, content: "revised", humanEdited: true, version: 2 })
    render(<AgentMemoryTab projectId="proj-1" roleLevel={ROLE.PROJECT_LEAD} />)
    await waitFor(() => expect(screen.getByText("observations/foo.md")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("tab", { name: /Approved/ }))
    await waitFor(() => expect(screen.getByText("conventions/style.md")).toBeInTheDocument())
    expect(screen.queryByText("Human-edited")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /Edit/ }))
    const textarea = screen.getByLabelText("Memory content")
    fireEvent.change(textarea, { target: { value: "revised" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(mockEditAgentMemory).toHaveBeenCalledWith("test-jwt", "proj-1", "mem-2", "revised"))
    await waitFor(() => expect(screen.getByText("Human-edited")).toBeInTheDocument())
  })
})

describe("project brief", () => {
  it("renders the brief and saves an edit with ifMatchVersion after overwrite confirmation", async () => {
    mockPutProjectBrief.mockResolvedValueOnce({ ...BRIEF, content: "updated brief", version: 2 })
    render(<AgentMemoryTab projectId="proj-1" roleLevel={ROLE.PROJECT_LEAD} />)
    await waitFor(() => expect(screen.getByText("observations/foo.md")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("tab", { name: "Project brief" }))
    await waitFor(() => expect(screen.getByText(/this project translates Mark/)).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: /Edit/ }))
    const textarea = screen.getByLabelText("Brief content")
    fireEvent.change(textarea, { target: { value: "updated brief" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    // Overwrite confirm dialog gates the actual PUT.
    expect(mockPutProjectBrief).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }))

    await waitFor(() => expect(mockPutProjectBrief).toHaveBeenCalledWith("test-jwt", "proj-1", "updated brief", 1))
  })

  it("shows a reload prompt on a 409 version conflict instead of overwriting", async () => {
    mockPutProjectBrief.mockRejectedValueOnce(new VersionConflictError("stale", 5))
    render(<AgentMemoryTab projectId="proj-1" roleLevel={ROLE.PROJECT_LEAD} />)
    await waitFor(() => expect(screen.getByText("observations/foo.md")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("tab", { name: "Project brief" }))
    await waitFor(() => expect(screen.getByText(/this project translates Mark/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }))
    fireEvent.change(screen.getByLabelText("Brief content"), { target: { value: "conflicting edit" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }))

    await waitFor(() => expect(screen.getByText("stale")).toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Reload latest brief" })).toBeInTheDocument()
    // The failed edit must not have replaced the brief shown behind the dialog.
    expect(mockGetProjectBrief).toHaveBeenCalledTimes(1)
  })

  it("hides Edit and shows a role notice for a non-lead role", async () => {
    render(<AgentMemoryTab projectId="proj-1" roleLevel={ROLE.CONTRIBUTOR} />)
    await waitFor(() => expect(screen.getByText("observations/foo.md")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("tab", { name: "Project brief" }))
    await waitFor(() => expect(screen.getByText(/this project translates Mark/)).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: /Edit/ })).not.toBeInTheDocument()
    expect(screen.getByText("Project lead only")).toBeInTheDocument()
  })
})
