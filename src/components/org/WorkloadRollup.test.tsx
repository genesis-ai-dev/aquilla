import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { WorkloadRollup } from "./WorkloadRollup"

vi.mock("@/lib/sync/assignments", () => ({ getWorkload: vi.fn() }))
import { getWorkload } from "@/lib/sync/assignments"
const mockGetWorkload = vi.mocked(getWorkload)

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe("WorkloadRollup", () => {
  it("renders per-member progress (done/total + open count + %)", async () => {
    mockGetWorkload.mockResolvedValue([
      { userId: 2, username: "anna", openAssignments: 2, cellsTotal: 10, cellsDone: 4 },
      { userId: 3, username: "bob", openAssignments: 1, cellsTotal: 4, cellsDone: 4 },
    ])
    render(<WorkloadRollup jwt="jwt" orgId={1} />)

    await waitFor(() => expect(screen.getByText("Team workload")).toBeInTheDocument())
    expect(screen.getByText("anna")).toBeInTheDocument()
    expect(screen.getByText("4/10")).toBeInTheDocument()
    expect(screen.getByText("2 open · 40%")).toBeInTheDocument()
    expect(screen.getByText("bob")).toBeInTheDocument()
    expect(screen.getByText("4/4")).toBeInTheDocument()
    expect(screen.getByText("1 open · 100%")).toBeInTheDocument()
    expect(mockGetWorkload).toHaveBeenCalledWith("jwt", 1)
  })

  it("renders nothing when the caller is not a manager (403 → caught)", async () => {
    mockGetWorkload.mockRejectedValue(new Error("getWorkload failed: HTTP 403"))
    const { container } = render(<WorkloadRollup jwt="jwt" orgId={1} />)
    await waitFor(() => expect(mockGetWorkload).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText("Team workload")).not.toBeInTheDocument()
  })

  it("renders nothing when there are no open assignments", async () => {
    mockGetWorkload.mockResolvedValue([])
    const { container } = render(<WorkloadRollup jwt="jwt" orgId={1} />)
    await waitFor(() => expect(mockGetWorkload).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
