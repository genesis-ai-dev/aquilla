import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { AssignedToMe } from "./AssignedToMe"

/**
 * AQU-1251 — the deterministic regression guard for the "Assigned to me"
 * loading race.
 *
 * `loading` used to be a `useState` that the fetch effect flipped. That made it
 * a claim about a request rather than a fact derived from one, and the claim
 * went stale for one render whenever `activeOrgId` changed: React renders with
 * the new org before the effect for that org runs, so the table painted the
 * PREVIOUS org's rows (or, at startup, an authoritative "You have no open
 * assignments.") as though the new org's read had already come back.
 *
 * That one render is why AssignedToMe.test.tsx's skeleton assertion was flaky in
 * the full suite and not in isolation: whether the bad frame was still on screen
 * when the assertion ran came down to how fast React flushed the effect, which
 * is the machine-speed dependency AGENTS.md rule 15 forbids. Asserting it from
 * the startup path can't pin it down — `act` flushes the effect before RTL gets
 * to look, which is exactly why the bug escaped as a flake instead of a failure.
 *
 * An org SWITCH pins it deterministically. The component is driven through a
 * controlled `activeOrgId` so the switch happens on a plain re-render, with no
 * effect in between: the render right after the switch either shows the
 * skeleton (loading derived from `result.orgId !== activeOrgId`) or still shows
 * org 1's row (the stale flag). No timing involved — the fix is a pure-render
 * property, so this test fails without it.
 */

let activeOrgId: number | null = 1

vi.mock("@/context/OrgContext", () => ({
  useActiveOrg: () => ({ activeOrgId }),
}))

// Chrome that only exists to host the page, and that would otherwise pull the
// real org context back in through the side door.
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ main }: { main: React.ReactNode }) => <>{main}</>,
}))
vi.mock("./OrgSidebar", () => ({ OrgSidebar: () => null }))
vi.mock("./OrgBreadcrumb", () => ({ OrgBreadcrumb: () => null }))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "jwt", username: "anna", createdAt: "x" },
    loading: false,
  }),
}))
vi.mock("@/lib/frontier/portfolio", () => ({
  getPortfolio: vi.fn(async () => [{ id: "pa", name: "John", targetLanguage: "Bambara" }]),
}))
vi.mock("@/lib/sync/assignments", () => ({ getMyAssignmentsForOrg: vi.fn() }))

import { getMyAssignmentsForOrg } from "@/lib/sync/assignments"
const mockGetMy = vi.mocked(getMyAssignmentsForOrg)

function assignmentIn(orgLabel: string) {
  return [
    {
      assignmentId: `a-${orgLabel}`,
      projectId: "pa",
      projectName: "John",
      fileId: "f1",
      fileName: "01-JHN.usfm",
      scopeKind: "books",
      scopeLabel: `${orgLabel} scope`,
      targetLang: "",
      deadline: null,
      note: null,
      cellsTotal: 10,
      cellsDone: 4,
      createdAt: 200,
    },
  ]
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  activeOrgId = 1
})
afterEach(() => vi.restoreAllMocks())

function renderInbox() {
  return render(
    <MemoryRouter>
      <AssignedToMe />
    </MemoryRouter>,
  )
}

describe("AssignedToMe — org switch", () => {
  it("shows the skeleton, not the previous org's rows, the moment the active org changes", async () => {
    mockGetMy.mockResolvedValue(assignmentIn("Org one"))
    const { rerender } = renderInbox()

    await waitFor(() => expect(screen.getByText("Org one scope")).toBeInTheDocument())
    expect(screen.queryByRole("status", { name: "Loading assignments" })).not.toBeInTheDocument()

    // Org 2's read never settles, so from this point "loading" is the only
    // truthful state — anything else is org 1's answer wearing org 2's label.
    mockGetMy.mockImplementation(() => new Promise(() => {}))
    activeOrgId = 2
    rerender(
      <MemoryRouter>
        <AssignedToMe />
      </MemoryRouter>,
    )

    expect(screen.queryByText("Org one scope")).not.toBeInTheDocument()
    expect(screen.getByRole("status", { name: "Loading assignments" })).toBeInTheDocument()
  })

  it("keeps showing the skeleton until the new org's own rows arrive", async () => {
    mockGetMy.mockResolvedValue(assignmentIn("Org one"))
    const { rerender } = renderInbox()
    await waitFor(() => expect(screen.getByText("Org one scope")).toBeInTheDocument())

    let releaseOrgTwo: (rows: ReturnType<typeof assignmentIn>) => void = () => {}
    mockGetMy.mockImplementation(
      () => new Promise((resolve) => { releaseOrgTwo = resolve }),
    )
    activeOrgId = 2
    rerender(
      <MemoryRouter>
        <AssignedToMe />
      </MemoryRouter>,
    )

    await waitFor(() => expect(mockGetMy).toHaveBeenCalledWith("jwt", 2))
    expect(screen.getByRole("status", { name: "Loading assignments" })).toBeInTheDocument()

    releaseOrgTwo(assignmentIn("Org two"))

    await waitFor(() => expect(screen.getByText("Org two scope")).toBeInTheDocument())
    expect(screen.queryByText("Org one scope")).not.toBeInTheDocument()
    expect(screen.queryByRole("status", { name: "Loading assignments" })).not.toBeInTheDocument()
  })
})
