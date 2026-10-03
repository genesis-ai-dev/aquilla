// AQU-538 §3.4 — MembersMatrixView lane-scope chips.
//
// Pins under test:
//   - Empty states still render (pre-existing behavior, guarded here so the
//     new chip wiring doesn't regress them).
//   - Lane scopes are NOT fetched for a member's row until that row is
//     hovered/focused (the chatty-fetch-avoidance choice documented in the
//     component) — verified by asserting the scopes fetch is uncalled
//     before hover and called after.
//   - Once resolved, the fetched lane scope renders as a compact chip in
//     that member's cell for that project — AQU-1607: a lane scope is a lane
//     id, so the chip shows the lane NAME the response resolves it to, never
//     the id itself.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MembersMatrixView } from "./MembersMatrixView"
import type { MembersMatrix } from "@/hooks/useProjectsMembersMatrix"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "jwt-pm", username: "pm", createdAt: "x" },
    loading: false,
  }),
}))

vi.mock("@/hooks/useOrg", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/hooks/useOrg")>()
  return {
    ...mod,
    useOrg: vi.fn(() => ({
      state: { kind: "success", org: { id: 1, name: "Org", role: { level: 700, name: "owner" } } },
      org: { id: 1, name: "Org", role: { level: 700, name: "owner" } },
      error: null,
      refresh: vi.fn(async () => {}),
    })),
  }
})

const { mockFetchMemberScopeView, mockPutMemberScopes } = vi.hoisted(() => ({
  mockFetchMemberScopeView: vi.fn(
    async (_jwt: string, _projectId: string, _userId: number) => ({
      scopes: [] as Array<{ kind: "lane" | "file"; value: string }>,
      laneNames: {} as Record<string, string>,
    }),
  ),
  mockPutMemberScopes: vi.fn(
    async (
      _jwt: string,
      _projectId: string,
      _userId: number,
      scopes: Array<{ kind: "lane" | "file"; value: string }>,
    ) => scopes,
  ),
}))

vi.mock("@/lib/sync/member-scopes", () => ({
  fetchMemberScopeView: mockFetchMemberScopeView,
  fetchMemberScopes: vi.fn(async () => []),
  laneScopeLabel: (value: string, laneNames: Record<string, string> | undefined) =>
    laneNames?.[value] ?? value,
  putMemberScopes: mockPutMemberScopes,
}))

let mockMatrix: MembersMatrix | null = null
let mockIsLoading = false

vi.mock("@/hooks/useProjectsMembersMatrix", () => ({
  useProjectsMembersMatrix: () => ({
    matrix: mockMatrix,
    isLoading: mockIsLoading,
    error: null,
    refresh: vi.fn(async () => {}),
  }),
}))

function oneCellMatrix(): MembersMatrix {
  const cells = new Map()
  cells.set(1, new Map([["proj-1", { role: { level: 400, name: "contributor", source: "override" as const }, secondarySources: [] }]]))
  return {
    projects: [{ id: "proj-1", name: "Genesis" } as MembersMatrix["projects"][number]],
    members: [{ userId: 1, username: "alice", isOrgInherited: false }],
    cells,
    ownerCountByProject: new Map([["proj-1", 1]]),
  }
}

beforeEach(() => {
  mockMatrix = null
  mockIsLoading = false
  mockFetchMemberScopeView.mockClear()
  mockFetchMemberScopeView.mockResolvedValue({ scopes: [], laneNames: {} })
  mockPutMemberScopes.mockClear()
})

describe("MembersMatrixView", () => {
  it("renders the 'No projects yet' empty state when there are no accessible projects", () => {
    mockMatrix = { projects: [], members: [], cells: new Map(), ownerCountByProject: new Map() }
    render(<MembersMatrixView />)
    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument()
  })

  it("does not fetch lane scopes for a row until it's hovered", async () => {
    mockMatrix = oneCellMatrix()
    render(<MembersMatrixView />)

    expect(screen.getByText("alice")).toBeInTheDocument()
    expect(mockFetchMemberScopeView).not.toHaveBeenCalled()
  })

  it("fetches and renders lane-scope chips once a row is hovered", async () => {
    mockMatrix = oneCellMatrix()
    mockFetchMemberScopeView.mockResolvedValue({
      scopes: [{ kind: "lane", value: "ln-es" }],
      laneNames: { "ln-es": "Spanish" },
    })

    render(<MembersMatrixView />)

    const row = screen.getByText("alice").closest("tr")
    expect(row).not.toBeNull()
    fireEvent.mouseEnter(row!)

    await waitFor(() => expect(mockFetchMemberScopeView).toHaveBeenCalledWith("jwt-pm", "proj-1", 1))

    const trigger = await screen.findByTestId("matrix-scope-trigger-1-proj-1")
    // The lane's NAME, not its id.
    await waitFor(() => expect(trigger).toHaveTextContent("Spanish"))
  })

  it("shows a plain 'scopes' affordance before the row's scopes have loaded", () => {
    mockMatrix = oneCellMatrix()
    render(<MembersMatrixView />)

    const trigger = screen.getByTestId("matrix-scope-trigger-1-proj-1")
    expect(trigger).toHaveTextContent("scopes")
  })
})
