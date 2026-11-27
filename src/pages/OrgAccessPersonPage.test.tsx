/**
 * AQU-2323: the person inspector page.
 *
 * Why these matter: the tree is the one place a viewer reads where someone
 * can go and why. A solid pill where the role is inherited, or a missing
 * "adds nothing" line, sends them to remove the wrong grant. The No access
 * row must open Give access already aimed at that person and place, and
 * after the grant the place must leave the bucket without a reload, or the
 * page contradicts what was just done. Remove all must name every grant.
 *
 * Only the network is mocked; the real Give access, Remove and role
 * dropdown components run.
 */
import type { ReactNode } from "react"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createMemoryRouter, RouterProvider } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { OrgAccessPayload } from "@/components/org/access/org-access-data"
import type { PersonAccessPayload } from "@/components/org/access/person-access-data"
import type { RemovalPreview } from "@/components/org/access/edit-access-data"

const org = { type: "org" as const, id: "1", name: "Biblica" }
const desk = { type: "team" as const, id: "3", name: "Review desk" }
const translators = { type: "team" as const, id: "1", name: "Translators" }
const ruth = { type: "project" as const, id: "r1", name: "Ruth" }
const ezra = { type: "project" as const, id: "r2", name: "Ezra" }
const alpha = { type: "project" as const, id: "p1", name: "Alpha" }
const beta = { type: "project" as const, id: "p2", name: "Beta" }
const alphaEs = { type: "lane" as const, id: "alpha-es", name: "Spanish" }

const node = (scope: OrgAccessPayload["tree"][number]["scope"], children: OrgAccessPayload["tree"] = []) => ({ scope, children, directGrantees: [], inherited: [] })
const lensPayload: OrgAccessPayload = {
  tree: [node(org, [node(desk, [node(ruth), node(ezra)]), node(translators, [node(alpha, [node(alphaEs)]), node(beta)])])],
  people: [{ userId: "30", displayName: "pedro", username: "pedro", email: "pedro@example.com", isGuest: false, grants: [] }],
  grantable: Object.fromEntries(["org:1", "team:3", "team:1", "project:r1", "project:r2", "project:p1", "project:p2", "lane:alpha-es"].map((k) => [k, { ok: true as const, cap: 700 }])),
}

const role = (roleLevel: number, kind: "direct" | "inherited", via: typeof desk | null = null, alsoVia: (typeof desk)[] = [], redundantDirect = false) =>
  ({ roleLevel, kind, via, alsoVia, redundantDirect })
const counts = (o: Partial<Record<"org" | "team" | "project" | "lane", number>>) => ({ org: 0, team: 0, project: 0, lane: 0, ...o })

/** AC1: Reviewer on Review desk, plus a direct Reviewer on Ruth that adds nothing. */
function pedro(withAlpha = false): PersonAccessPayload {
  const bucket = [
    { scope: translators, path: [org, translators] },
    ...(withAlpha ? [] : [{ scope: alpha, path: [org, translators, alpha] }]),
    { scope: alphaEs, path: [org, translators, alpha, alphaEs] },
    { scope: beta, path: [org, translators, beta] },
  ]
  return {
    person: { userId: "30", displayName: "pedro", username: "pedro", email: "pedro@example.com", isGuest: false, lastActiveAt: null },
    counts: { grants: 3, projects: withAlpha ? 3 : 2 },
    tree: [{
      scope: org,
      role: role(300, "direct"),
      children: [
        { scope: desk, role: role(300, "direct"), children: [
          { scope: ruth, role: role(300, "direct", null, [desk], true), children: [] },
          { scope: ezra, role: role(300, "inherited", desk), children: [] },
        ] },
        ...(withAlpha ? [{ scope: alpha, role: role(300, "direct"), children: [] }] : []),
      ],
    }],
    noAccess: { places: bucket, counts: counts({ team: 1, project: withAlpha ? 1 : 2, lane: 1 }) },
    grants: [
      { grant: { type: "org", id: "1" }, path: [org], roleLevel: 300, source: "direct", grantedBy: "owner", grantedByUserId: "1", grantedAt: "2026-04-01T00:00:00.000Z", gives: counts({ org: 1, team: 1, project: 1 }), redundant: false },
      { grant: { type: "team", id: "3" }, path: [org, desk], roleLevel: 300, source: "direct", grantedBy: "maintainer", grantedByUserId: "2", grantedAt: "2026-05-01T00:00:00.000Z", gives: counts({ team: 1, project: 1 }), redundant: false },
      { grant: { type: "project", id: "r1" }, path: [org, ruth], roleLevel: 300, source: "direct", grantedBy: "owner", grantedByUserId: "1", grantedAt: "2026-06-02T00:00:00.000Z", gives: counts({}), redundant: true },
    ],
    history: [
      { kind: "granted", at: "2026-06-02T00:00:00.000Z", by: "owner", path: [org, ruth], roleBefore: null, roleAfter: 300 },
      { kind: "granted", at: "2026-05-01T00:00:00.000Z", by: "maintainer", path: [org, desk], roleBefore: null, roleAfter: 300 },
    ],
  }
}

const fetchPersonAccess = vi.fn<(...a: unknown[]) => Promise<PersonAccessPayload>>()
const fetchGrantPreview = vi.fn<(...a: unknown[]) => Promise<unknown>>()
const submitGrant = vi.fn<(...a: unknown[]) => Promise<void>>()
const fetchRemovalPreview = vi.fn<(...a: unknown[]) => Promise<unknown>>()
const removeGrants = vi.fn<(...a: unknown[]) => Promise<unknown>>()
const changeGrantRole = vi.fn<(...a: unknown[]) => Promise<void>>()

vi.mock("@/components/org/access/person-access-data", () => ({ fetchPersonAccess: (...a: unknown[]) => fetchPersonAccess(...a) }))
vi.mock("@/components/org/access/org-access-data", async (orig) => ({
  ...(await orig<typeof import("@/components/org/access/org-access-data")>()),
  fetchOrgAccess: () => Promise.resolve(lensPayload),
}))
vi.mock("@/components/org/access/give-access-data", () => ({
  fetchGrantPreview: (...a: unknown[]) => fetchGrantPreview(...a),
  submitGrant: (...a: unknown[]) => submitGrant(...a),
}))
vi.mock("@/components/org/access/edit-access-data", async (orig) => ({
  ...(await orig<typeof import("@/components/org/access/edit-access-data")>()),
  fetchRemovalPreview: (...a: unknown[]) => fetchRemovalPreview(...a),
  removeGrants: (...a: unknown[]) => removeGrants(...a),
  changeGrantRole: (...a: unknown[]) => changeGrantRole(...a),
}))
vi.mock("@/components/AppShell", () => ({ AppShell: ({ main }: { main: ReactNode }) => <>{main}</> }))
vi.mock("@/components/org/OrgSidebar", () => ({ OrgSidebar: () => null }))
vi.mock("@/components/org/OrgBreadcrumb", () => ({ OrgBreadcrumb: () => null }))
vi.mock("@/context/OrgContext", () => ({ useActiveOrg: () => ({ activeOrg: { id: 1, name: "Biblica" }, activeOrgId: 1 }) }))
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "owner" } }) }))
vi.mock("@/components/ui/toast", () => ({ toast: { add: vi.fn() } }))

const { OrgAccessPersonPage } = await import("./OrgAccessPersonPage")

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: "/orgs/:orgId/access/people/:userId", element: <OrgAccessPersonPage /> },
      { path: "/orgs/:orgId/access", element: <p>People lens</p> },
    ],
    { initialEntries: ["/orgs/1/access/people/30"] },
  )
  render(<RouterProvider router={router} />)
  return router
}

const place = (key: string) => {
  const row = screen.getAllByTestId("person-place").find((el) => el.getAttribute("data-place") === key)
  if (!row) throw new Error(`no tree row ${key}`)
  return row
}
const card = (key: string) => {
  const found = screen.getAllByTestId("grant-card").find((el) => el.getAttribute("data-grant") === key)
  if (!found) throw new Error(`no card ${key}`)
  return found
}

const removal = (grants: { type: string; id: string }[]): RemovalPreview => ({
  person: { userId: "30", displayName: "pedro" },
  invite: false,
  removes: grants.map((g) => ({ grant: g as RemovalPreview["removes"][number]["grant"], path: [org], roleLevel: 300 })),
  loses: [],
  keeps: [],
  leavesTeams: [],
  guest: { before: false, after: true },
})

beforeEach(() => {
  for (const fn of [fetchPersonAccess, fetchGrantPreview, submitGrant, fetchRemovalPreview, removeGrants, changeGrantRole]) fn.mockReset()
  fetchPersonAccess.mockResolvedValue(pedro())
})

describe("OrgAccessPersonPage", () => {
  it("AC1: solid where granted, dashed via Review desk with a link there, and names the redundant direct grant", async () => {
    renderPage()
    await screen.findByTestId("person-tree")
    const r1 = place("project:r1")
    expect(within(r1).getByTestId("role-badge").getAttribute("data-origin")).toBe("direct")
    expect(within(r1).getByTestId("person-place-reason")).toHaveTextContent("Granted here")
    expect(within(r1).getByTestId("person-place-also")).toHaveTextContent("The grant here adds nothing over Review desk")

    const r2 = place("project:r2")
    expect(within(r2).getByTestId("role-badge").getAttribute("data-origin")).toBe("inherited")
    expect(within(r2).getByTestId("person-place-reason")).toHaveTextContent("Reaches here through Review desk")
    expect(within(r2).getByRole("link")).toHaveAttribute("href", "/orgs/1/access?place=team%3A3")
    expect(screen.getByTestId("person-counts")).toHaveTextContent("3 grants · Reaches 2 projects")
  })

  it("AC2/AC3: the No access row counts by kind, lists its places, and a project opens Give access aimed there; after the grant it moves without a reload", async () => {
    const user = userEvent.setup()
    const router = renderPage()
    await screen.findByTestId("person-tree")
    expect(screen.getByTestId("no-access-counts")).toHaveTextContent("1 team · 2 projects · 1 language lane")
    expect(screen.queryByTestId("no-access-list")).toBeNull()
    await user.click(screen.getByTestId("no-access-toggle"))
    expect(screen.getAllByTestId("no-access-place").map((el) => el.getAttribute("data-place"))).toEqual(["team:1", "project:p1", "lane:alpha-es", "project:p2"])

    await user.click(screen.getByRole("button", { name: "Give pedro access at Biblica › Alpha" }))
    const dialog = await screen.findByTestId("give-access-dialog")
    expect(within(dialog).getByTestId("give-place")).toHaveTextContent("Alpha")
    expect(within(dialog).getByTestId("give-person")).toHaveTextContent("pedro")
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByTestId("give-role")))

    fetchGrantPreview.mockResolvedValue({ ok: true, preview: {
      placePath: [org, alpha], roleLevel: 300, invite: false, here: { before: null, after: { roleLevel: 300, source: "direct", via: alpha } },
      replaces: null, changes: [], redundant: false, guest: { before: false, after: false }, includesFutureProjects: false, lane: null,
    } })
    submitGrant.mockResolvedValue()
    fetchPersonAccess.mockResolvedValue(pedro(true))
    await user.click(within(dialog).getByTestId("give-role"))
    await user.click(await screen.findByRole("option", { name: "Reviewer" }))
    await waitFor(() => expect(within(dialog).getByTestId("give-access-submit")).toBeEnabled())
    await user.click(within(dialog).getByTestId("give-access-submit"))

    expect(submitGrant).toHaveBeenCalledWith("jwt", 1, expect.objectContaining({ roleLevel: 300, place: expect.objectContaining({ key: "project:p1" }) }))
    await waitFor(() => expect(place("project:p1")).toBeInTheDocument())
    expect(within(place("project:p1")).getByTestId("role-badge").getAttribute("data-origin")).toBe("direct")
    expect(screen.getByTestId("no-access-counts")).toHaveTextContent("1 team · 1 project · 1 language lane")
    expect(router.state.location.pathname).toBe("/orgs/1/access/people/30")
    expect(fetchPersonAccess).toHaveBeenCalledTimes(2)
  })

  it("AC4: the redundant card carries the amber note; its role changes in place and Remove asks about exactly that grant", async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByTestId("person-tree")
    expect(within(card("project:r1")).getByTestId("grant-card-redundant")).toHaveTextContent("Redundant, safe to remove")
    expect(within(card("team:3")).queryByTestId("grant-card-redundant")).toBeNull()
    expect(within(card("team:3")).getByTestId("grant-card-given")).toHaveTextContent(/Given by maintainer on/)

    changeGrantRole.mockResolvedValue()
    await user.click(within(card("project:r1")).getByTestId("role-dropdown"))
    await user.click(await screen.findByRole("menuitemradio", { name: "Contributor" }))
    expect(changeGrantRole).toHaveBeenCalledWith("jwt", 1, { userId: "30", displayName: "pedro", username: "pedro" }, { type: "project", id: "r1" }, 400)

    fetchRemovalPreview.mockResolvedValue({ ok: true, preview: removal([{ type: "project", id: "r1" }]) })
    fireEvent.click(within(card("project:r1")).getByTestId("grant-card-remove"))
    await screen.findByTestId("remove-access-dialog")
    expect(fetchRemovalPreview).toHaveBeenCalledWith("jwt", 1, { person: { userId: "30" }, grants: [{ type: "project", id: "r1" }] })
  })

  it("AC7: Remove all access lists every grant, removes them all, and returns to the People lens", async () => {
    renderPage()
    await screen.findByTestId("person-tree")
    const all = [{ type: "org", id: "1" }, { type: "team", id: "3" }, { type: "project", id: "r1" }]
    fetchRemovalPreview.mockResolvedValue({ ok: true, preview: removal(all) })
    removeGrants.mockResolvedValue({ done: 3, total: 3, error: null })
    fireEvent.click(screen.getByTestId("person-remove-all"))
    const dialog = await screen.findByTestId("remove-access-dialog")
    expect(fetchRemovalPreview).toHaveBeenCalledWith("jwt", 1, { person: { userId: "30" }, grants: all })
    await waitFor(() => expect(within(dialog).getAllByTestId("removal-removes")).toHaveLength(3))
    await act(async () => { fireEvent.click(within(dialog).getByTestId("remove-access-confirm")) })
    expect(removeGrants).toHaveBeenCalledWith("jwt", 1, { userId: "30" }, all)
    await screen.findByText("People lens")
  })

  it("AC5: history lists each grant with who gave it, newest first", async () => {
    renderPage()
    const entries = await screen.findAllByTestId("person-history-entry")
    expect(entries.map((el) => el.textContent)).toEqual([
      expect.stringContaining("owner gave Reviewer at Biblica › Ruth"),
      expect.stringContaining("maintainer gave Reviewer at Review desk"),
    ])
  })
})
