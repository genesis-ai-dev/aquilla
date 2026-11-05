/**
 * AgentMemoryTab.test.tsx — the memory tab must load its two sections,
 * flip a proposed memory's status optimistically on approve/reject (and
 * revert on a failed request), and set the human-edited badge after an edit.
 * AQU-2342: the agent's own "Project brief" tab is gone — the project
 * instructions live in Living Memory, the one place every AI draft reads.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import AgentMemoryTab from "./AgentMemoryTab"
import type { AgentMemory } from "@/lib/agent/memory-api"
import { ROLE } from "@/lib/agent/role-floors"
import type { AgentRunUi } from "@/lib/agent/run-state"

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
    reviewAgentMemory: vi.fn(),
    editAgentMemory: vi.fn(),
  }
})

// mem-M5/mem-m2: a controllable fake of the shared agent-session store, so
// tests can assert AgentMemoryTab calls markMemoryReviewed
// on review, and can push in a `runs` array with more memory-proposed items
// to prove the badge-refetch effect (real useSyncExternalStore wiring is
// session-store.test.ts's job — this fakes just the read/write surface
// AgentMemoryTab uses).
let fakeRuns: AgentRunUi[] = []
const mockMarkMemoryReviewed = vi.fn()
vi.mock("@/lib/agent/session-store", () => ({
  agentSessionStore: vi.fn(() => ({
    markMemoryReviewed: mockMarkMemoryReviewed,
  })),
  useAgentSession: vi.fn(() => ({
    state: { runs: fakeRuns, isStreaming: false, queued: [], decided: new Map(), activity: [], sessionId: "s" },
    send: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
    decide: vi.fn(),
    noteActivity: vi.fn(),
  })),
}))

import {
  listAgentMemories,
  reviewAgentMemory,
  editAgentMemory,
  SupersedesHumanEditedError,
} from "@/lib/agent/memory-api"

const mockListAgentMemories = vi.mocked(listAgentMemories)
const mockReviewAgentMemory = vi.mocked(reviewAgentMemory)
const mockEditAgentMemory = vi.mocked(editAgentMemory)

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

beforeEach(() => {
  vi.clearAllMocks()
  fakeRuns = []
  mockListAgentMemories.mockResolvedValue([PROPOSED_MEMORY, APPROVED_MEMORY])
})

describe("loading and layout", () => {
  it("loads memories and renders the proposed count badge", async () => {
    render(<AgentMemoryTab projectId="proj-1" roleLevel={ROLE.PROJECT_LEAD} />)
    await waitFor(() => expect(screen.getByText("observations/foo.md")).toBeInTheDocument())
    expect(mockListAgentMemories).toHaveBeenCalledWith("test-jwt", "proj-1")
    // Proposed tab trigger shows the pending count.
    expect(screen.getByRole("tab", { name: /Proposed/ })).toHaveTextContent("1")
  })

  it("has no Project brief tab — the instructions live in Living Memory (AQU-2342)", async () => {
    render(<AgentMemoryTab projectId="proj-1" roleLevel={ROLE.PROJECT_LEAD} />)
    await waitFor(() => expect(screen.getByText("observations/foo.md")).toBeInTheDocument())
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent?.replace(/\d+$/, ""))).toEqual([
      "Proposed",
      "Approved",
    ])
    expect(screen.queryByRole("tab", { name: "Project brief" })).toBeNull()
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

  it("races-F5: a failed review only reverts its own row, not a concurrent successful one", async () => {
    const SECOND_PROPOSED: AgentMemory = { ...PROPOSED_MEMORY, id: "mem-3", path: "observations/bar.md" }
    mockListAgentMemories.mockResolvedValue([PROPOSED_MEMORY, SECOND_PROPOSED, APPROVED_MEMORY])

    // mem-1 rejects, mem-3 resolves — both in flight at once (deferred so
    // neither settles before the other's optimistic flip has applied).
    let resolveMem3: (v: AgentMemory) => void = () => {}
    mockReviewAgentMemory.mockImplementation((_jwt, _projectId, id) => {
      if (id === "mem-1") return Promise.reject(new Error("403 forbidden"))
      return new Promise((resolve) => {
        resolveMem3 = resolve
      })
    })

    render(<AgentMemoryTab projectId="proj-1" roleLevel={ROLE.PROJECT_LEAD} />)
    await waitFor(() => expect(screen.getByText("observations/foo.md")).toBeInTheDocument())
    expect(screen.getByText("observations/bar.md")).toBeInTheDocument()

    const approveButtons = screen.getAllByRole("button", { name: /Approve/ })
    fireEvent.click(approveButtons[0]) // mem-1 — will fail
    fireEvent.click(approveButtons[1]) // mem-3 — will succeed

    resolveMem3({ ...SECOND_PROPOSED, status: "approved" })

    // mem-1 reverts back into the proposed list; mem-3 stays approved (gone
    // from Proposed) — an absolute-snapshot revert would have brought it back.
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("403 forbidden"))
    expect(screen.getByText("observations/foo.md")).toBeInTheDocument()
    expect(screen.queryByText("observations/bar.md")).not.toBeInTheDocument()
  })
})

describe("supersede-human-edited confirm (B1)", () => {
  it("shows a destructive confirm dialog on a 409 supersedes_human_edited, and reverts the row meanwhile", async () => {
    mockReviewAgentMemory.mockRejectedValueOnce(
      new SupersedesHumanEditedError("Approving will replace a human-edited memory.", {
        path: "observations/foo.md",
        existingId: "mem-old",
      }),
    )
    render(<AgentMemoryTab projectId="proj-1" roleLevel={ROLE.PROJECT_LEAD} />)
    await waitFor(() => expect(screen.getByText("observations/foo.md")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: /Approve/ }))

    await waitFor(() =>
      expect(screen.getByText(/Replace the human-edited memory/)).toBeInTheDocument(),
    )
    // Row is back in the Proposed list behind the dialog — no silent state change.
    expect(screen.getAllByText("observations/foo.md").length).toBeGreaterThan(0)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("confirm resends the review with supersedeHumanEdited: true", async () => {
    mockReviewAgentMemory
      .mockRejectedValueOnce(new SupersedesHumanEditedError("x", { path: "observations/foo.md" }))
      .mockResolvedValueOnce({ ...PROPOSED_MEMORY, status: "approved" })

    render(<AgentMemoryTab projectId="proj-1" roleLevel={ROLE.PROJECT_LEAD} />)
    await waitFor(() => expect(screen.getByText("observations/foo.md")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /Approve/ }))
    await waitFor(() => expect(screen.getByText(/Replace the human-edited memory/)).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: "Replace it" }))

    await waitFor(() =>
      expect(mockReviewAgentMemory).toHaveBeenLastCalledWith("test-jwt", "proj-1", "mem-1", "approve", true),
    )
    await waitFor(() => expect(screen.queryByText("observations/foo.md")).not.toBeInTheDocument())
  })

  it("cancel leaves the memory proposed and never resends", async () => {
    mockReviewAgentMemory.mockRejectedValueOnce(
      new SupersedesHumanEditedError("x", { path: "observations/foo.md" }),
    )
    render(<AgentMemoryTab projectId="proj-1" roleLevel={ROLE.PROJECT_LEAD} />)
    await waitFor(() => expect(screen.getByText("observations/foo.md")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /Approve/ }))
    await waitFor(() => expect(screen.getByText(/Replace the human-edited memory/)).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(screen.queryByText(/Replace the human-edited memory/)).not.toBeInTheDocument()
    expect(screen.getByText("observations/foo.md")).toBeInTheDocument()
    expect(mockReviewAgentMemory).toHaveBeenCalledTimes(1)
  })
})

describe("mem-M5 notice liveness + mem-m2 badge refetch", () => {
  it("calls markMemoryReviewed on the shared session store after a successful review", async () => {
    mockReviewAgentMemory.mockResolvedValueOnce({ ...PROPOSED_MEMORY, status: "approved" })
    render(<AgentMemoryTab projectId="proj-1" roleLevel={ROLE.PROJECT_LEAD} />)
    await waitFor(() => expect(screen.getByText("observations/foo.md")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: /Approve/ }))

    await waitFor(() => expect(mockMarkMemoryReviewed).toHaveBeenCalledWith("mem-1"))
  })

  it("refetches the memory list when a new memory-proposed run item lands (mem-m2)", async () => {
    const { rerender } = render(<AgentMemoryTab projectId="proj-1" roleLevel={ROLE.PROJECT_LEAD} />)
    await waitFor(() => expect(mockListAgentMemories).toHaveBeenCalledTimes(1))

    fakeRuns = [
      {
        localId: "run-1",
        prompt: "p",
        runId: "r1",
        items: [{ id: "i0", kind: "memory-proposed", memoryId: "mem-new", path: "x.md", preview: "x", status: "pending" }],
        status: "ok",
      },
    ]
    rerender(<AgentMemoryTab projectId="proj-1" roleLevel={ROLE.PROJECT_LEAD} />)

    await waitFor(() => expect(mockListAgentMemories).toHaveBeenCalledTimes(2))
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
