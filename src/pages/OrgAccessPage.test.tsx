// OrgAccessPage org-switch rule (AQU-1352 review): the payload belongs to the
// org it was fetched for. After switching orgs, org A's people must never
// render (or be exportable as CSV) under org B while B loads, and losing the
// session/org must not leave stale data on screen.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, act } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgAccessPage } from "./OrgAccessPage"
import type { OrgAccessPayload } from "@/components/org/access/org-access-data"

vi.mock("@/components/org/OrgSidebar", () => ({ OrgSidebar: () => null }))
vi.mock("@/components/org/OrgBreadcrumb", () => ({ OrgBreadcrumb: () => null }))
// Every render of the tree is logged with the org active at that moment, so a
// single stale commit (invisible to post-act DOM assertions) is still caught.
let currentOrg: number | null = null
const renders: string[] = []
vi.mock("@/components/org/access/AccessTreeView", () => ({
  AccessTreeView: ({ tree }: { tree: OrgAccessPayload["tree"] }) => {
    const names = tree.map((n) => n.scope.name).join(",")
    renders.push(`${names}@${currentOrg}`)
    return <div>{names}</div>
  },
}))
vi.mock("@/components/org/access/AccessPeopleView", () => ({ AccessPeopleView: () => null }))

let jwt: string | null = "jwt"
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: jwt ? { jwt } : null, loading: false }),
}))
const useActiveOrg = vi.fn()
vi.mock("@/context/OrgContext", () => ({ useActiveOrg: () => useActiveOrg() }))

const pending = new Map<number, (p: OrgAccessPayload) => void>()
vi.mock("@/components/org/access/org-access-data", () => ({
  fetchOrgAccess: (_jwt: string, orgId: number) => new Promise<OrgAccessPayload>((res) => pending.set(orgId, res)),
  orgAccessCsv: () => "",
}))

const payload = (id: number, name: string): OrgAccessPayload => ({
  tree: [{ scope: { type: "org", id: String(id), name }, children: [], directGrantees: [] }],
  people: [],
})
const setOrg = (id: number | null) => {
  currentOrg = id
  return useActiveOrg.mockReturnValue({ activeOrg: id == null ? null : { id, name: `Org ${id}` }, activeOrgId: id })
}
const exportButton = () => screen.getByRole("button", { name: /export|csv/i })
const page = () => (
  <MemoryRouter>
    <OrgAccessPage />
  </MemoryRouter>
)

describe("OrgAccessPage org switch", () => {
  beforeEach(() => {
    pending.clear()
    renders.length = 0
    jwt = "jwt"
  })

  it("never shows org A's rows under org B; Export is disabled until B loads", async () => {
    setOrg(1)
    const { rerender } = render(page())
    await act(async () => pending.get(1)?.(payload(1, "Alpha Org")))
    expect(screen.getByText("Alpha Org")).toBeTruthy()
    expect((exportButton() as HTMLButtonElement).disabled).toBe(false)

    setOrg(2)
    rerender(page())
    expect(screen.queryByText("Alpha Org")).toBeNull()
    expect((exportButton() as HTMLButtonElement).disabled).toBe(true)

    await act(async () => pending.get(2)?.(payload(2, "Beta Org")))
    expect(screen.getByText("Beta Org")).toBeTruthy()
    expect(screen.queryByText("Alpha Org")).toBeNull()
    expect((exportButton() as HTMLButtonElement).disabled).toBe(false)
    expect(renders.filter((r) => r.startsWith("Alpha Org@") && r !== "Alpha Org@1")).toEqual([])
  })

  it("drops the old data when the session goes away", async () => {
    setOrg(1)
    const { rerender } = render(page())
    await act(async () => pending.get(1)?.(payload(1, "Alpha Org")))
    jwt = null
    rerender(page())
    expect(screen.queryByText("Alpha Org")).toBeNull()
    expect((exportButton() as HTMLButtonElement).disabled).toBe(true)
  })
})
