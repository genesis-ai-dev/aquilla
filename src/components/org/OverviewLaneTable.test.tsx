// AQU-2027 — the Languages table's People column. It lists the members who are
// limited to each lane. Since AQU-1813 a project lead (500) can be limited to
// lanes too, but the column only read the scopes of members below project
// lead, so a lane-limited lead never appeared ("—") however they were staffed.
// Maintainers (600+) see every lane and are never lane-scoped, so they are
// still not read.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OverviewLaneTable } from "./OverviewLaneTable"
import type { PortfolioLane } from "@/lib/frontier/portfolio"

type Scope = { kind: "lane" | "file"; value: string }

const { mockFetchMemberScopes } = vi.hoisted(() => ({
  mockFetchMemberScopes: vi.fn(
    async (_jwt: string, _projectId: string, _userId: number) => [] as Scope[] | null,
  ),
}))

vi.mock("@/lib/sync/member-scopes", () => ({
  fetchMemberScopes: mockFetchMemberScopes,
}))

const role = (level: number, name: string) => ({ level, name, source: "override" as const })

vi.mock("@/hooks/useProjectMembers", () => ({
  useProjectMembers: vi.fn(() => ({
    members: [
      { userId: 10, username: "maria", role: role(400, "contributor"), secondarySources: [] },
      { userId: 12, username: "wendi", role: role(500, "project_lead"), secondarySources: [] },
      { userId: 13, username: "jade", role: role(600, "maintainer"), secondarySources: [] },
    ],
    isLoading: false,
    error: null,
    rosterHidden: false,
    refresh: vi.fn(async () => {}),
  })),
}))

// The row's popovers and dialogs have their own suites; the column is the unit here.
vi.mock("@/components/StaffLanePopover", () => ({ StaffLanePopover: () => null }))
vi.mock("@/components/AssignModal", () => ({ AssignModal: () => null }))

function lane(tag: string, laneId: string): PortfolioLane {
  return {
    lane: tag,
    laneId,
    name: null,
    role: "target",
    totalCells: 10,
    filledCells: 0,
    validatedCells: 0,
    lastEditAt: null,
  }
}

function renderTable() {
  return render(
    <MemoryRouter>
      <OverviewLaneTable
        projectId="proj-1"
        projectName="Only one file"
        orgId={1}
        jwt="jwt-owner"
        lanes={[lane("French", "ln-fr"), lane("Swedish", "ln-sv")]}
        defaultLanguageLabel="English"
        extraLanes={[]}
        files={[]}
        roleLevel={700}
        author="owner"
        canManageLanes
        canAddLanguage
      />
    </MemoryRouter>,
  )
}

/** The user ids drawn in one lane's People cell. */
function peopleIn(tag: string): string[] {
  const cell = screen.getByTestId(`overview-lane-people-${tag}`)
  return [...cell.querySelectorAll("[data-user-id]")].map((el) => el.getAttribute("data-user-id") ?? "")
}

beforeEach(() => {
  mockFetchMemberScopes.mockReset()
  // Stored as lane ids, the way the Staff popover writes them (AQU-1607).
  mockFetchMemberScopes.mockImplementation(async (_jwt, _projectId, userId) => {
    if (userId === 10) return [{ kind: "lane", value: "ln-sv" }]
    if (userId === 12) return [{ kind: "lane", value: "ln-fr" }]
    return []
  })
})

describe("OverviewLaneTable People column", () => {
  it("lists a project lead limited to a lane in that lane's row", async () => {
    renderTable()

    await waitFor(() => expect(peopleIn("French")).toEqual(["12"]))
    expect(peopleIn("Swedish")).toEqual(["10"])
  })

  it("never reads a maintainer's scopes — they see every lane", async () => {
    renderTable()

    await waitFor(() => expect(mockFetchMemberScopes).toHaveBeenCalledWith("jwt-owner", "proj-1", 12))
    expect(mockFetchMemberScopes).toHaveBeenCalledWith("jwt-owner", "proj-1", 10)
    expect(mockFetchMemberScopes).not.toHaveBeenCalledWith("jwt-owner", "proj-1", 13)
  })
})
