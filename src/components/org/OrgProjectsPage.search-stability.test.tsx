// AQU-2654: typing in the project search box must not redraw every row of the
// table. The rows are drawn through callbacks the table derives from
// `onLanesChanged`, so the page has to hand it the SAME function on every
// render — it used to hand a new one, and each letter redrew every visible row
// (menus, tooltips and all) for nothing.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProjectsPage } from "./OrgProjectsPage"

const bumpRefresh = vi.fn()
const directoryCalls = vi.hoisted(() => [] as Array<{ query: string; refreshKey?: number }>)
const tableProps = vi.hoisted(() => [] as Array<{ onLanesChanged?: () => void; searchValue?: string }>)

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna" }, loading: false }),
}))
vi.mock("@/components/AppShell", () => ({
  AppShell: ({ main }: { main: React.ReactNode }) => <div>{main}</div>,
}))
vi.mock("./OrgSidebar", () => ({ OrgSidebar: () => null }))
vi.mock("./OrgBreadcrumb", () => ({ OrgBreadcrumb: () => null }))
vi.mock("./ProjectSortMenu", () => ({ ProjectSortMenu: () => null }))
vi.mock("@/components/ProjectCreateDialog", () => ({ ProjectCreateDialog: () => null }))
vi.mock("@/hooks/useOrgSettings", () => ({
  useOrgSettings: () => ({ allowSelfAssignment: false, version: 1 }),
}))
const org = { id: 1, name: "Dev Org", role: { level: 700, name: "owner" } }
const orgContext = {
  activeOrg: org,
  activeOrgId: 1,
  activeGuestOrg: null,
  orgs: [org],
  accessibleProjects: [],
  isLoading: false,
  accessibleProjectsLoading: false,
}
vi.mock("@/context/OrgContext", () => ({ useActiveOrg: () => orgContext }))
// Like the real hook: a NEW object on every render, with a stable bumpRefresh.
vi.mock("@/hooks/useOrgPortfolio", () => ({
  useOrgPortfolio: () => ({
    bumpRefresh,
    refreshAccessibleProjects: vi.fn(),
    filterByStatus: (_status: string, list: unknown[]) => list,
    roleByProjectId: new Map(),
    filesByProjectId: new Map(),
    now: 0,
    error: null,
  }),
}))
vi.mock("@/hooks/useProjectDirectory", () => ({
  useProjectDirectory: (opts: { query: string; refreshKey?: number }) => {
    directoryCalls.push({ query: opts.query, refreshKey: opts.refreshKey })
    return { projects: [], loading: false, searching: false, loadingMore: false, error: null, hasMore: false, loadMore: () => {} }
  },
}))
vi.mock("./OrgProjectsDataTable", () => ({
  OrgProjectsDataTable: (props: {
    onLanesChanged?: () => void
    searchValue?: string
    onSearchChange?: (value: string) => void
  }) => {
    tableProps.push({ onLanesChanged: props.onLanesChanged, searchValue: props.searchValue })
    return (
      <input
        aria-label="Search projects"
        value={props.searchValue ?? ""}
        onChange={(event) => props.onSearchChange?.(event.target.value)}
      />
    )
  },
}))

describe("OrgProjectsPage — the table's callbacks survive a keystroke (AQU-2654)", () => {
  beforeEach(() => {
    bumpRefresh.mockClear()
    directoryCalls.length = 0
    tableProps.length = 0
  })

  it("hands the table the same onLanesChanged before and after typing", () => {
    render(
      <MemoryRouter>
        <OrgProjectsPage />
      </MemoryRouter>,
    )
    const first = tableProps[0].onLanesChanged
    expect(first).toBeTypeOf("function")

    const box = screen.getByLabelText("Search projects")
    for (const value of ["p", "pe", "per", "perf"]) fireEvent.change(box, { target: { value } })

    expect(tableProps.at(-1)?.searchValue).toBe("perf")
    expect(tableProps.length).toBeGreaterThan(1)
    expect(tableProps.every((props) => props.onLanesChanged === first)).toBe(true)
  })

  it("the stable callback still refreshes the portfolio and the directory", () => {
    render(
      <MemoryRouter>
        <OrgProjectsPage />
      </MemoryRouter>,
    )
    const before = directoryCalls.at(-1)?.refreshKey ?? 0
    fireEvent.change(screen.getByLabelText("Search projects"), { target: { value: "p" } })
    const onLanesChanged = tableProps.at(-1)?.onLanesChanged
    expect(onLanesChanged).toBeDefined()

    act(() => onLanesChanged!())
    expect(bumpRefresh).toHaveBeenCalledTimes(1)
    expect(directoryCalls.at(-1)?.refreshKey).toBe(before + 1)
  })
})
