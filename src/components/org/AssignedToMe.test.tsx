import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { fmtDeadlineDate } from "@/lib/format-date"
import { AssignedToMe } from "./AssignedToMe"

const navigate = vi.fn()
// AQU-1277: OrgSidebar's useOrgSettings fetches /api/v2/orgs/:id/settings.
// fetchOrgSettings swallows its own failures and returns null, so unmocked it
// silently hit production identity while the tests still passed. null is what
// these tests already observed, so behaviour here is unchanged.
// AQU-1277: OrgProvider loads the project directory via
// fetchAccessibleProjectsResult, which catches its own network errors. Unmocked
// it reached production identity for real while the tests stayed green.
vi.mock("@/lib/sync/cloud-projects", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/cloud-projects")>()),
  fetchAccessibleProjectsResult: vi.fn(async () => ({ ok: true as const, projects: [] })),
}))

vi.mock("@/lib/sync/org-settings", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/org-settings")>()),
  fetchOrgSettings: vi.fn(async () => null),
}))

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom")
  return { ...actual, useNavigate: () => navigate }
})

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }),
}))
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: vi.fn(async () => [{ id: 1, name: "Come and See", role: { level: 400, name: "contributor" } }]),
}))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
vi.mock("@/lib/frontier/portfolio", () => ({
  getPortfolio: vi.fn(async () => [
    { id: "pa", name: "John", targetLanguage: "Bambara" },
    { id: "pb", name: "Mark", targetLanguage: "French" },
  ]),
}))
vi.mock("@/lib/sync/assignments", () => ({ getMyAssignmentsForOrg: vi.fn() }))
// AQU-1493: a section assignment reads its chapters' cells on the click.
vi.mock("@/lib/sync/sync-token", () => ({
  fetchSyncToken: vi.fn(async () => ({ token: "sync-token", expiresIn: 600 })),
}))
vi.mock("@/lib/progress/file-progress-resource", () => ({ getFileSectionProgress: vi.fn() }))

// AQU-1173: record the `loading` the inbox hands the table on EVERY render.
// The flake was a one-render window, not a lasting state, so it has to be
// observed per render — a DOM probe after `waitFor` samples one moment and
// only lands inside the window on a slow enough machine. The wrapper
// delegates, so the other specs in this file see the real table.
const { tableRenders, committedDom } = vi.hoisted(() => ({
  tableRenders: [] as { loading: boolean; rows: number }[],
  committedDom: [] as { skeleton: boolean; noAssignmentsCopy: boolean }[],
}))

vi.mock("@/components/ui/data-table", async (importActual) => {
  const actual = await importActual<typeof import("@/components/ui/data-table")>()
  const { useLayoutEffect } = await import("react")
  const Real = actual.DataTable
  return {
    ...actual,
    DataTable: (props: Parameters<typeof Real>[0]) => {
      tableRenders.push({ loading: Boolean(props.loading), rows: props.data.length })
      // AQU-1257: sample the COMMITTED DOM after every commit of this table
      // rather than once, after an `await`. A layout effect runs synchronously
      // after each commit, so no one-render window can slip between samples —
      // whereas a `getBy…` placed after `await findBy…`/`waitFor` observes
      // whichever commit happens to be current when the microtask queue drains,
      // which is what let scheduling and machine speed decide the result.
      useLayoutEffect(() => {
        committedDom.push({
          skeleton:
            document.querySelector('[role="status"][aria-label="Loading assignments"]') != null,
          noAssignmentsCopy: (document.body.textContent ?? "").includes(
            "You have no open assignments.",
          ),
        })
      })
      return <Real {...props} />
    },
  }
})

import { getMyAssignmentsForOrg } from "@/lib/sync/assignments"
const mockGetMy = vi.mocked(getMyAssignmentsForOrg)
import { getFileSectionProgress } from "@/lib/progress/file-progress-resource"
const mockSection = vi.mocked(getFileSectionProgress)

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  navigate.mockClear()
  tableRenders.length = 0
  committedDom.length = 0
})
afterEach(() => vi.restoreAllMocks())

function renderInbox() {
  return render(
    <MemoryRouter>
      <OrgProvider>
        <AssignedToMe />
      </OrgProvider>
    </MemoryRouter>,
  )
}

describe("AssignedToMe", () => {
  it("shows a loading skeleton while assignments are unresolved", async () => {
    // Every call must stay pending, not just the first: OrgProvider can
    // resolve the active org after mount, which re-runs the fetch effect,
    // and a second call falling through to the bare mock resolved to
    // undefined and dismissed the skeleton before the assertion ran.
    mockGetMy.mockImplementation(() => new Promise(() => {}))
    renderInbox()

    // AQU-1173: wait on the state actually being asserted. Waiting on the
    // search box instead and then probing the skeleton synchronously made
    // this order-dependent — the table mounts one commit before the
    // skeleton did, so a full-suite run could observe the gap.
    // AQU-1257: the search box and the pulse markup are part of that same
    // asserted state, so they are awaited with it instead of trailing it as
    // bare synchronous probes that only the awaited node was holding up.
    await waitFor(() => {
      expect(screen.getByRole("status", { name: "Loading assignments" })).toHaveAttribute("aria-busy", "true")
      expect(screen.getByPlaceholderText("Search assignments…")).toBeInTheDocument()
      expect(document.querySelector(".animate-pulse")).toBeTruthy()
    })
  })

  // AQU-1173 regression guard — the root cause behind the flake above.
  // OrgProvider resolves the active org after mount, so the inbox re-renders
  // with a real org one render BEFORE its fetch effect runs. While `loading`
  // was its own state it lagged that render, and the table was handed
  // `loading: false` with zero rows — the settled "no assignments" view — for
  // one frame before the skeleton replaced it.
  it("never hands the table a settled state while the active org's assignments are pending", async () => {
    mockGetMy.mockImplementation(() => new Promise(() => {}))
    renderInbox()

    await waitFor(() => {
      expect(screen.getByRole("status", { name: "Loading assignments" })).toBeInTheDocument()
    })
    expect(tableRenders.length).toBeGreaterThan(0)
    expect(tableRenders.filter((render) => !render.loading)).toEqual([])
  })

  // AQU-1251: the regression guard for the flake. `loading` used to be a
  // `useState` the fetch effect flipped, so between "the org directory resolved"
  // and "the effect for that org ran" the table rendered with a stale
  // `loading === false` — an authoritative "You have no open assignments." for a
  // request that had not been made yet. It is now derived from whether the held
  // result matches the current `(jwt, orgId)`, so that render cannot exist.
  //
  // The org resolves asynchronously here (listMyOrgs is a promise), which is the
  // window the bug lived in; the assignments read never settles, so the ONLY
  // correct state for the whole test is "loading".
  //
  // AQU-1257: that window is one render wide, so it used to be chased with
  // `await screen.findByPlaceholderText(…)` followed by synchronous probes of
  // the skeleton and the empty copy — a wait on one element guarding
  // assertions about others. That sampled a single moment: on an unlucky
  // schedule it read a commit the regression had not reached yet (a spurious
  // failure), and on a fast one it skipped past the bad commit entirely (a
  // spurious pass). The committed DOM is now recorded on every commit of the
  // table, so the bad render cannot hide between samples.
  it("never paints an empty state while the active org's assignments are unresolved", async () => {
    mockGetMy.mockImplementation(() => new Promise(() => {}))
    renderInbox()

    // The table only mounts once an org is active and its fetch effect runs
    // after the table's own layout effect, so the request having been issued
    // means every render up to and including the corruptible one is recorded.
    // A fixed wait would only prove the machine was slow; poll the mock instead.
    await waitFor(() => expect(mockGetMy).toHaveBeenCalledWith("jwt", 1))

    expect(committedDom.length).toBeGreaterThan(0)
    expect(
      committedDom.filter((dom) => !dom.skeleton || dom.noAssignmentsCopy),
    ).toEqual([])

    // And it stays loading — nothing resolved it, so nothing may dismiss it.
    // This last pair is a probe of a state that is now lasting rather than one
    // render wide, so reading it once is sound.
    expect(screen.getByRole("status", { name: "Loading assignments" })).toBeInTheDocument()
    expect(screen.queryByText("You have no open assignments.")).not.toBeInTheDocument()
  })

  // AQU-1257 audit of the remaining `waitFor`-then-probe pairs in this file:
  // the specs below wait on one node and then probe others, but every value
  // they probe is painted by the same commit as the awaited one — the rows,
  // the lane labels and the deadline all come from the single `setResult` the
  // inbox makes after `Promise.all([assignments, portfolio])`, and nothing is
  // pending afterwards to move them. They assert a settled state, not a
  // one-render window, so a single read of it is sound and no change is needed.
  it("aggregates the caller's open assignments across projects with progress", async () => {
    // One org-level request (GET /orgs/:orgId/assignments/mine) replaces the
    // old per-project fan-out — rows arrive with projectName attached.
    mockGetMy.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", fileName: "01-JHN.usfm", scopeKind: "books", scopeLabel: "John", targetLang: "", deadline: "2026-06-30", note: null, cellsTotal: 10, cellsDone: 4, createdAt: 200 },
      { assignmentId: "a2", projectId: "pb", projectName: "Mark", fileId: "f2", fileName: "02-MRK.usfm", scopeKind: "chapters", scopeLabel: "Mark · MRK 1", targetLang: "", deadline: null, note: null, cellsTotal: 5, cellsDone: 5, createdAt: 100 },
    ])
    renderInbox()

    await waitFor(() => expect(screen.getByText("Mark · MRK 1")).toBeInTheDocument())
    expect(screen.getByText("01-JHN.usfm")).toBeInTheDocument()
    expect(screen.getByText("02-MRK.usfm")).toBeInTheDocument()
    expect(screen.getByText("4/10 cells · 40%")).toBeInTheDocument()
    expect(screen.getByText("5/5 cells · 100%")).toBeInTheDocument()
    // Deadline DateTooltip: month + day, year only when it isn't this year.
    expect(screen.getByText(fmtDeadlineDate("2026-06-30"))).toBeInTheDocument()
    expect(mockGetMy).toHaveBeenCalledWith("jwt", 1)
  })

  // AQU-729 / AQU-538 (§3.5): every assignment shows its lane; named lanes use
  // the tag, the default lane ('') uses the project's target language label.
  // AQU-690: when fileId is present, open that file in the editor.
  it("renders lane chips and navigates with ?lane= for a lane-pinned assignment", async () => {
    mockGetMy.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", fileName: "01-JHN.usfm", scopeKind: "books", scopeLabel: "John scope", targetLang: "es", deadline: null, note: null, cellsTotal: 10, cellsDone: 4, createdAt: 200 },
      { assignmentId: "a2", projectId: "pb", projectName: "Mark", fileId: "f2", fileName: "02-MRK.usfm", scopeKind: "books", scopeLabel: "Mark scope", targetLang: "", deadline: null, note: null, cellsTotal: 5, cellsDone: 1, createdAt: 100 },
    ])
    renderInbox()

    await waitFor(() => expect(screen.getByText("John scope")).toBeInTheDocument())
    expect(screen.getByText("es")).toBeInTheDocument()
    expect(screen.getByText("French")).toBeInTheDocument()

    fireEvent.click(screen.getByText("John scope"))
    expect(navigate).toHaveBeenLastCalledWith("/project/pa/editor/file/f1?lane=es")

    // AQU-1474: the default lane is an explicit, empty `?lane=`, never a bare
    // URL. The editor reads an absent lane param as "keep the lane last used",
    // which would open this default-lane assignment in the wrong language.
    fireEvent.click(screen.getByText("Mark scope"))
    expect(navigate).toHaveBeenLastCalledWith("/project/pb/editor/file/f2?lane=")
  })

  // AQU-1493 (Sam, 2026-10-03): carol is assigned RUT 2, and her row opened
  // the editor at the top of Ruth. A section assignment now opens on its first
  // cell still needing work, by the board's own deep link (?cellId=, flashed).
  it("opens a section assignment on its first cell still to translate", async () => {
    mockGetMy.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "Ruth", fileId: "f1", fileName: "BSB", scopeKind: "chapters", scopeLabel: "RUT 2", targetLang: "de", laneId: "lane-de", deadline: null, note: null, cellsTotal: 25, cellsDone: 24, createdAt: 200 },
    ])
    mockSection.mockResolvedValue({
      verses: [
        { cellId: "h2", ref: "RUT 2:s1:1", filled: true, validated: true, structural: true },
        { cellId: "x1", ref: "", filled: false, validated: false, unnumbered: true },
        { cellId: "r21", ref: "RUT 2:1", filled: true, validated: true },
      ],
    } as never)
    renderInbox()
    await waitFor(() => expect(screen.getByText("RUT 2")).toBeInTheDocument())
    fireEvent.click(screen.getByText("RUT 2"))
    await waitFor(() => expect(navigate).toHaveBeenCalled())
    expect(mockSection).toHaveBeenCalledWith("pa", "f1", "RUT 2", expect.any(Function), "de")
    expect(navigate).toHaveBeenLastCalledWith("/project/pa/editor/file/f1?cellId=x1&lane=lane-de&flash=1")
  })

  it("opens a finished section assignment on its first cell, and falls back to the file when nothing reads", async () => {
    mockGetMy.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "Ruth", fileId: "f1", fileName: "BSB", scopeKind: "chapters", scopeLabel: "Ruth \u00b7 RUT 3, RUT 2", targetLang: "", deadline: null, note: null, cellsTotal: 2, cellsDone: 2, createdAt: 200 },
      { assignmentId: "a2", projectId: "pb", projectName: "Jonah", fileId: "f2", fileName: "JON", scopeKind: "chapters", scopeLabel: "JON 2", targetLang: "", deadline: null, note: null, cellsTotal: 2, cellsDone: 2, createdAt: 100 },
    ])
    mockSection.mockImplementation(async (projectId, _fileId, key) => {
      if (projectId === "pb") throw new Error("HTTP 500")
      return { verses: [{ cellId: `${key}:1`, ref: `${key}:1`, filled: true, validated: true }] } as never
    })
    renderInbox()
    await waitFor(() => expect(screen.getByText("JON 2")).toBeInTheDocument())
    // Chapters in reading order, whatever order they were ticked in.
    fireEvent.click(screen.getByText("Ruth \u00b7 RUT 3, RUT 2"))
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1))
    expect(navigate).toHaveBeenLastCalledWith("/project/pa/editor/file/f1?cellId=RUT%202%3A1&lane=&flash=1")
    fireEvent.click(screen.getByText("JON 2"))
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(2))
    expect(navigate).toHaveBeenLastCalledWith("/project/pb/editor/file/f2?lane=")
  })

  it("shows an empty state when there are no assignments", async () => {
    mockGetMy.mockResolvedValue([])
    renderInbox()
    await waitFor(() => expect(screen.getByText("You have no open assignments.")).toBeInTheDocument())
  })

  it("surfaces a failed org-level read as an error (no silent empty state)", async () => {
    // The single org read has no per-project fallback — a failure must be
    // visible, not rendered as "no assignments".
    // Simulate what our updated helpers now throw: a UserError with a human message.
    // (Previously helpers threw raw "HTTP 403" strings; now they throw mapped messages.)
    mockGetMy.mockRejectedValue(
      Object.assign(new Error("You don't have permission to do that for this org."), {
        name: "UserError",
        category: "forbidden",
        status: 403,
        raw: "",
      })
    )
    renderInbox()

    await waitFor(() =>
      expect(screen.getByText(/don't have permission/)).toBeInTheDocument(),
    )
    expect(screen.queryByText("You have no open assignments.")).not.toBeInTheDocument()
  })

  // AQU-366: guard against the list clipping instead of scrolling — see
  // ProjectsList.tsx for the full explanation of the flex chain this depends on.
  it("renders the list in a scrollable container (h-full + overflow-y-auto, no clipping)", async () => {
    mockGetMy.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", scopeKind: "books", scopeLabel: "John", targetLang: "", deadline: null, note: null, cellsTotal: 10, cellsDone: 4, createdAt: 200 },
    ])
    renderInbox()
    await waitFor(() => expect(screen.getByTestId("org-assigned-table")).toBeInTheDocument())

    const scrollContainer = screen.getByTestId("assigned-to-me-scroll")
    expect(scrollContainer.className).toMatch(/\bh-full\b/)
    expect(scrollContainer.className).toMatch(/\boverflow-y-auto\b/)
    expect(scrollContainer.className).not.toMatch(/overflow-hidden/)
  })

  it("search narrows the table by scope, project, or file name", async () => {
    mockGetMy.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", fileName: "01-JHN.usfm", scopeKind: "books", scopeLabel: "John scope", targetLang: "", deadline: null, note: null, cellsTotal: 10, cellsDone: 4, createdAt: 200 },
      { assignmentId: "a2", projectId: "pb", projectName: "Mark", fileId: "f2", fileName: "02-MRK.usfm", scopeKind: "chapters", scopeLabel: "Mark · MRK 1", targetLang: "", deadline: null, note: null, cellsTotal: 5, cellsDone: 1, createdAt: 100 },
    ])
    renderInbox()
    await waitFor(() => expect(screen.getByText("John scope")).toBeInTheDocument())

    fireEvent.change(screen.getByPlaceholderText("Search assignments…"), { target: { value: "MRK" } })
    await waitFor(() => expect(screen.getByText("Mark · MRK 1")).toBeInTheDocument())
    expect(screen.queryByText("John scope")).toBeNull()

    fireEvent.change(screen.getByPlaceholderText("Search assignments…"), { target: { value: "01-JHN" } })
    await waitFor(() => expect(screen.getByText("John scope")).toBeInTheDocument())
    expect(screen.queryByText("Mark · MRK 1")).toBeNull()
  })
})
