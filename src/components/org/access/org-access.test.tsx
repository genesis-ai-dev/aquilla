/**
 * AQU-1352 §3.6 (AQU-1072): the People & access page renders one server
 * payload two ways (a folder tree, one row per person) and exports it. Spec
 * §3.9 says a scope reads identically everywhere, so the CSV scope column must
 * be byte-identical to formatScopePath — the same string the chips show.
 *
 * The folder tree is the only place people are added to the organization,
 * a folder, a project or a language, so it must offer exactly the places and
 * roles the server would accept, and show both who was added at a place and
 * who reaches it from a folder above.
 */
import type { ReactNode } from "react"
import { fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import { createMemoryRouter, Outlet, RouterProvider, Navigate } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

import { ACCESS_AUDIT_REDIRECT } from "@/lib/access/people-lens"
import { formatScopePath } from "@/lib/access/scope-path"
import { useT } from "@/lib/i18n/I18nProvider"
import { accessNodeId } from "./access-anchors"
import { orgAccessCsv, type OrgAccessPayload } from "./org-access-data"

const org = { type: "org" as const, id: "1", name: "Biblica ETT" }
const team = { type: "team" as const, id: "7", name: "Thai, \"core\"" }
const project = { type: "project" as const, id: "p1", name: "Pattani" }
const french = { type: "lane" as const, id: "fr", name: "French" }
const spanish = { type: "lane" as const, id: "es", name: "Spanish" }
const other = { type: "project" as const, id: "p2", name: "Other" }
const now = Date.now()
const recent = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString()
const staleAt = new Date(now - 100 * 24 * 60 * 60 * 1000).toISOString()
const inviteExpiry = new Date(now + (3 * 24 + 6) * 60 * 60 * 1000).toISOString()

const payload: OrgAccessPayload = {
  tree: [{
    scope: org,
    directGrantees: [{ userId: "1", displayName: "Ruth", roleLevel: 600, email: "ruth@example.com", isGuest: false, source: "direct" }],
    inherited: [],
    children: [{
      scope: team,
      directGrantees: [],
      inherited: [],
      children: [{
        scope: project,
        directGrantees: [
          { userId: "9", displayName: "Naladda", roleLevel: 300, email: "naladda@example.com", isGuest: true, source: "direct" },
          { userId: "2", displayName: "Member", roleLevel: 400, email: "member@example.com", isGuest: false, source: "direct" },
        ],
        inherited: [
          { kind: "person", userId: "1", displayName: "Ruth", email: "ruth@example.com", isGuest: false, roleLevel: 600, from: org },
          { kind: "team", roleLevel: 400, memberCount: 4, from: team },
        ],
        children: [
          {
            scope: french,
            directGrantees: [{ userId: "6", displayName: "LaneOnly", roleLevel: 200, isGuest: false, source: "direct" }],
            inherited: [{ kind: "person", userId: "9", displayName: "Naladda", roleLevel: 300, isGuest: true, from: project }],
            children: [],
          },
          {
            scope: spanish,
            directGrantees: [],
            inherited: [{ kind: "person", userId: "9", displayName: "Naladda", roleLevel: 300, isGuest: true, from: project }],
            children: [],
          },
        ],
      }],
    }, {
      scope: other,
      directGrantees: [],
      inherited: [],
      children: [],
    }],
  }],
  people: [
    {
      userId: "9", displayName: "Naladda", isGuest: true, email: "naladda@example.com", lastActiveAt: recent,
      grants: [
        { scopePath: [org, project], roleLevel: 300, origin: { kind: "direct" } },
        { scopePath: [org, other], roleLevel: 200, origin: { kind: "direct" } },
      ],
    },
    { userId: "1", displayName: "Ruth", username: "ruth", isGuest: false, email: "ruth@example.com", lastActiveAt: recent, grants: [
      { scopePath: [org], roleLevel: 700, origin: { kind: "direct" } },
    ] },
    { userId: "4", displayName: "Bare", isGuest: false, lastActiveAt: null, grants: [
      { scopePath: [org], roleLevel: 100, origin: { kind: "direct" } },
    ] },
    {
      userId: "invite:project:p1:tok", displayName: "soon@example.com", email: "soon@example.com", isGuest: false,
      pendingInvite: { roleLevel: 300, expiresAt: inviteExpiry },
      grants: [{ scopePath: [org, project], roleLevel: 300, origin: { kind: "direct" } }],
    },
    { userId: "keeper", displayName: "Keeper", isGuest: false, lastActiveAt: recent, grants: [
      { scopePath: [org, project], roleLevel: 600, origin: { kind: "direct" } },
    ] },
    { userId: "6", displayName: "LaneOnly", isGuest: false, lastActiveAt: recent, grants: [
      { scopePath: [org, project, french], roleLevel: 200, origin: { kind: "direct" } },
    ] },
    { userId: "heir", displayName: "Heir", isGuest: false, lastActiveAt: recent, grants: [
      { scopePath: [org, team, project], roleLevel: 500, origin: { kind: "inherited", from: [org, team] }, grantedBy: "Ruth", grantedAt: "2026-09-01T00:00:00.000Z" },
    ] },
    { userId: "stale", displayName: "Stale", isGuest: false, lastActiveAt: staleAt, grants: [
      { scopePath: [org, project], roleLevel: 400, origin: { kind: "direct" } },
    ] },
  ],
}

const downloadBlob = vi.fn()
vi.mock("@/lib/export/export-service", () => ({ downloadBlob: (...a: unknown[]) => downloadBlob(...a) }))
vi.mock("./org-access-data", async (orig) => ({
  ...(await orig<typeof import("./org-access-data")>()),
  fetchOrgAccess: () => Promise.resolve(payload),
}))
const submitGrant = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve())
vi.mock("./give-access-data", async (orig) => ({
  ...(await orig<typeof import("./give-access-data")>()),
  submitGrant: (...a: unknown[]) => submitGrant(...a),
}))
vi.mock("@/components/AppShell", () => ({ AppShell: ({ main }: { main: ReactNode }) => <>{main}</> }))
vi.mock("@/components/org/OrgSidebar", () => ({ OrgSidebar: () => null }))
vi.mock("@/components/org/OrgBreadcrumb", () => ({ OrgBreadcrumb: () => null }))
vi.mock("@/context/OrgContext", () => ({ useActiveOrg: () => ({ activeOrg: { id: 1, name: "Biblica ETT", role: { level: 700 } }, activeOrgId: 1, activeGuestOrg: null }) }))
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "ruth" } }) }))

const { OrgAccessPage } = await import("@/pages/OrgAccessPage")

function renderPage() {
  const router = createMemoryRouter(
    [{ path: "/orgs/:orgId/access", element: <OrgAccessPage /> }],
    { initialEntries: ["/orgs/1/access"] },
  )
  render(<RouterProvider router={router} />)
  return router
}

/** The row of the folder tree for one place. */
function folderRow(scope: { type: "org" | "team" | "project" | "lane"; id: string }) {
  return screen.getByTestId(accessNodeId(scope))
}

/** Opens the list behind a row's avatars and returns it. */
async function openPeople(scope: { type: "org" | "team" | "project" | "lane"; id: string }) {
  fireEvent.click(within(folderRow(scope)).getByTestId("folder-people"))
  return screen.findByTestId("folder-people-list")
}

function peopleFilter(label: string) {
  return screen.getByRole("button", { name: (accessible) => accessible.replace(/\s+/g, " ").trim().startsWith(`${label} `) })
}

function personRow(name: string) {
  const row = screen.getAllByTestId("people-row").find((item) => item.getAttribute("data-person") === name)
  if (!row) throw new Error(`no people row for ${name}`)
  return row
}

describe("OrgAccessPage folder tree", () => {
  it("is organization → folder → project → languages, with each kind labelled", async () => {
    renderPage()
    const tree = await screen.findByTestId("access-folder-tree")
    const order = within(tree).getAllByRole("treeitem").map((item) => item.querySelector("[data-testid^='access-node-']")?.getAttribute("data-testid"))
    expect(order).toEqual([org, team, project, french, spanish, other].map((scope) => accessNodeId(scope)))
    expect(folderRow(team)).toHaveTextContent("folder")
    expect(folderRow(french)).toHaveTextContent(/language/i)
    expect(folderRow(project)).toHaveTextContent("project")
  })

  it("stacks up to three avatars of the people added at a place, then +n", async () => {
    const extra = [3, 5, 8].map((n) => ({ userId: `x${n}`, displayName: `Extra ${n}`, roleLevel: 100, isGuest: false, source: "direct" as const }))
    const projectNode = payload.tree[0].children[0].children[0]
    const before = projectNode.directGrantees
    projectNode.directGrantees = [...before, ...extra]
    try {
      renderPage()
      await screen.findByTestId("access-folder-tree")
      expect(within(folderRow(project)).getByTestId("folder-people-more")).toHaveTextContent("+2")
      expect(within(folderRow(org)).queryByTestId("folder-people-more")).toBeNull()
    } finally {
      projectNode.directGrantees = before
    }
  })

  it("lists the people added here, then everyone who reaches it from above with where it comes from, and marks you", async () => {
    renderPage()
    await screen.findByTestId("access-folder-tree")
    const list = await openPeople(project)
    const direct = within(list).getAllByTestId("direct-person").map((row) => row.textContent ?? "")
    expect(direct.some((text) => text.includes("Naladda") && text.includes("Reviewer"))).toBe(true)
    expect(direct.some((text) => text.includes("Member") && text.includes("Contributor"))).toBe(true)
    const ruth = within(list).getAllByTestId("inherited-person").find((row) => row.textContent?.includes("Ruth"))
    expect(ruth?.textContent).toContain(`from ${org.name}`)
    expect(ruth?.textContent).toContain("Maintainer")
    expect(within(ruth!).getByTestId("you-tag")).toBeTruthy()
    expect(within(list).queryAllByTestId("you-tag")).toHaveLength(1)
    const teamRow = within(list).getByTestId("inherited-team")
    expect(teamRow.textContent).toContain(team.name)
    expect(teamRow.textContent).toContain("Contributor")
    // AQU-2323: a name opens that person's page.
    expect(within(list).getByRole("link", { name: "Open Naladda" })).toHaveAttribute("href", "/orgs/1/access/people/9")
    expect(within(list).getByRole("link", { name: "Open Ruth" })).toHaveAttribute("href", "/orgs/1/access/people/1")
  })

  it("does not list someone added here again among those reaching it from above", async () => {
    renderPage()
    await screen.findByTestId("access-folder-tree")
    const list = await openPeople(french)
    expect(within(list).getAllByTestId("direct-person").map((row) => row.textContent)).toEqual([expect.stringContaining("LaneOnly")])
    expect(within(list).getAllByTestId("inherited-person").some((row) => row.textContent?.includes("Naladda"))).toBe(true)
  })

  it("offers no add-person button where the viewer may grant nowhere", async () => {
    renderPage()
    await screen.findByTestId("access-folder-tree")
    expect(screen.queryAllByTestId("folder-add-person")).toHaveLength(0)
  })

  it("offers a Project lead their project's roles up to Project lead, and adds the person there", async () => {
    payload.grantable = { "org:1": { ok: false, denial: "owner_only" }, "project:p1": { ok: true, cap: 500 } }
    submitGrant.mockClear()
    try {
      renderPage()
      await screen.findByTestId("access-folder-tree")
      expect(within(folderRow(org)).queryByTestId("folder-add-person")).toBeNull()
      fireEvent.click(within(folderRow(project)).getByTestId("folder-add-person"))
      const popover = await screen.findByTestId("add-person-popover")
      const levels = Array.from(popover.querySelectorAll("[data-role-level]")).map((el) => Number(el.getAttribute("data-role-level")))
      expect(levels).toEqual([500, 400, 300, 200, 100])
      fireEvent.click(within(popover).getByRole("option", { name: (n) => n.includes("Stale") }))
      expect(within(popover).getByTestId("add-person-chosen")).toHaveTextContent("Stale")
      fireEvent.click(within(popover).getByTestId("add-person-submit"))
      await waitFor(() => expect(submitGrant).toHaveBeenCalledOnce())
      const [, orgId, grant] = submitGrant.mock.calls[0] as [string, number, { person: { userId: string }; roleLevel: number; place: { key: string } }]
      expect(orgId).toBe(1)
      expect(grant.person.userId).toBe("stale")
      expect(grant.roleLevel).toBe(400)
      expect(grant.place.key).toBe("project:p1")
    } finally {
      delete payload.grantable
    }
  })

  it("offers a new folder or a new project on the organization, and a new project in a folder", async () => {
    renderPage()
    await screen.findByTestId("access-folder-tree")
    fireEvent.click(within(folderRow(org)).getByTestId("folder-new"))
    expect(await screen.findByTestId("folder-new-team")).toBeTruthy()
    expect(screen.getByTestId("folder-new-project")).toBeTruthy()
    fireEvent.click(screen.getByTestId("folder-new-team"))
    expect(await screen.findByTestId("new-folder-row")).toBeTruthy()
    expect(within(folderRow(team)).getByRole("button", { name: "New project" })).toBeTruthy()
    // A language is a leaf; nothing goes inside it.
    expect(within(folderRow(french)).queryByTestId("folder-new")).toBeNull()
  })
})

describe("OrgAccessPage", () => {
  it("lists members, guests, and invites, and a Guests CSV repeats the breadcrumbs on screen", async () => {
    renderPage()
    await screen.findByTestId("access-folder-tree")
    expect(screen.getByTestId(accessNodeId(team)).id).toBe(accessNodeId(team))
    expect(screen.queryByRole("button", { name: /^Print/ })).toBeNull()

    fireEvent.click(screen.getByRole("tab", { name: "People" }))
    await screen.findByTestId("people-lens")
    expect(peopleFilter("Everyone")).toHaveTextContent("8")
    expect(peopleFilter("Members")).toHaveTextContent("6")
    expect(peopleFilter("Guests")).toHaveTextContent("1")
    expect(peopleFilter("Pending invites")).toHaveTextContent("1")
    expect(peopleFilter("Can give access")).toHaveTextContent("2")
    expect(peopleFilter("Inactive 90 days")).toHaveTextContent("2")

    const guest = personRow("Naladda")
    expect(within(guest).getByTestId("guest-badge")).toBeTruthy()
    expect(within(guest).getByTestId("role-badge").getAttribute("data-origin")).toBe("direct")
    expect(within(guest).getByTestId("role-badge")).toHaveTextContent("Reviewer")
    expect(within(guest).getByTestId("role-badge").className).not.toContain("border-dashed")
    expect(within(guest).getByTestId("people-reaches")).toHaveTextContent("2 projects")
    expect(within(guest).getByRole("link", { name: "Open Naladda" })).toHaveAttribute("href", "/orgs/1/access/people/9")
    const shown = within(guest).getAllByTestId("scope-breadcrumb").map((crumb) => crumb.getAttribute("aria-label"))
    expect(shown).toEqual([formatScopePath([org, other]), formatScopePath([org, project])])

    const owner = personRow("Ruth")
    expect(within(owner).queryByTestId("guest-badge")).toBeNull()
    expect(within(owner).getByTestId("people-reaches")).toHaveTextContent("Everything · 1 team, 2 projects")
    expect(within(owner).getByTestId("people-last-active")).toHaveTextContent("2 days ago")

    const bare = personRow("Bare")
    expect(within(bare).getByTestId("role-badge")).toHaveTextContent("No access yet")
    expect(within(bare).getByTestId("people-reaches")).toHaveTextContent("Nothing. Org membership alone opens no project.")
    expect(within(bare).getByTestId("people-last-active")).toHaveTextContent("No recent activity")

    const invite = personRow("soon@example.com")
    expect(within(invite).getByTestId("invited-badge")).toBeTruthy()
    expect(within(invite).getByTestId("role-badge")).toHaveTextContent("Reviewer")
    expect(invite.textContent).toMatch(/expires in \d+ days/)
    expect(within(invite).queryByRole("link")).toBeNull()

    expect(personRow("LaneOnly").textContent).toContain("1 language lane")

    fireEvent.click(peopleFilter("Members"))
    expect(screen.getAllByTestId("people-row").some((row) => row.getAttribute("data-person") === "Naladda")).toBe(false)
    expect(personRow("Bare")).toBeTruthy()
    fireEvent.click(peopleFilter("Guests"))
    expect(screen.getAllByTestId("people-row")).toHaveLength(1)
    expect(personRow("Naladda")).toBeTruthy()
    fireEvent.click(peopleFilter("Pending invites"))
    expect(screen.getAllByTestId("people-row").map((row) => row.getAttribute("data-person"))).toEqual(["soon@example.com"])
    fireEvent.click(peopleFilter("Can give access"))
    expect(screen.getAllByTestId("people-row").map((row) => row.getAttribute("data-person")).sort()).toEqual(["Keeper", "Ruth"])
    fireEvent.click(peopleFilter("Inactive 90 days"))
    expect(screen.getAllByTestId("people-row").map((row) => row.getAttribute("data-person")).sort()).toEqual(["Bare", "Stale"])

    fireEvent.click(peopleFilter("Guests"))
    downloadBlob.mockClear()
    fireEvent.click(screen.getByRole("button", { name: /export csv/i }))
    await waitFor(() => expect(downloadBlob).toHaveBeenCalled())
    const csv = await (downloadBlob.mock.calls[0] as [Blob, string])[0].text()
    const scopes = csv.trimEnd().split("\r\n").slice(1).map((line) => line.split(",")[1])
    expect(new Set(scopes)).toEqual(new Set(shown))
    expect(scopes).toHaveLength(shown.length)
    expect(csv).not.toContain("Ruth")
    const printed = within(screen.getByTestId("people-print-report")).getAllByTestId("scope-breadcrumb").map((crumb) => crumb.getAttribute("aria-label"))
    expect(new Set(printed)).toEqual(new Set(shown))

    const print = vi.fn()
    Object.defineProperty(window, "print", { configurable: true, value: print })
    fireEvent.click(screen.getByRole("button", { name: /^Print/ }))
    expect(print).toHaveBeenCalledOnce()

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Naladda" } })
    fireEvent.click(peopleFilter("Everyone"))
    expect(screen.getAllByTestId("people-row")).toHaveLength(1)
    fireEvent.click(screen.getByRole("tab", { name: "Places" }))
    expect(screen.queryByTestId(accessNodeId(other))).toBeNull()
    expect(screen.getByTestId(accessNodeId(project))).toBeTruthy()
  })

  it("marks the place a link opens on, and a search keeps matching places and their folders", async () => {
    const router = createMemoryRouter(
      [{ path: "/orgs/:orgId/access", element: <OrgAccessPage /> }],
      { initialEntries: ["/orgs/1/access?place=project:p1"] },
    )
    render(<RouterProvider router={router} />)
    await screen.findByTestId("access-folder-tree")
    expect(folderRow(project).closest("[role=treeitem]")).toHaveAttribute("aria-selected", "true")
    expect(folderRow(other).closest("[role=treeitem]")).toHaveAttribute("aria-selected", "false")

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Other" } })
    expect(screen.queryByTestId(accessNodeId(project))).toBeNull()
    expect(screen.getByTestId(accessNodeId(other))).toBeTruthy()
    expect(screen.getByTestId(accessNodeId(org))).toBeTruthy()
  })

  it("sends the access audit here, on the People lens", async () => {
    const router = createMemoryRouter(
      [{
        path: "/orgs/:orgId",
        element: <Outlet />,
        children: [
          { path: "access", element: <OrgAccessPage /> },
          { path: "access-audit", element: <Navigate to={ACCESS_AUDIT_REDIRECT} replace relative="path" /> },
        ],
      }],
      { initialEntries: ["/orgs/1/access-audit"] },
    )
    render(<RouterProvider router={router} />)
    await screen.findByTestId("people-lens")
    expect(router.state.location.pathname).toBe("/orgs/1/access")
    expect(router.state.location.search).toBe("?lens=people")
    expect(peopleFilter("Everyone")).toHaveAttribute("aria-pressed", "true")
  })

  it("exports a CSV blob named after the org", async () => {
    downloadBlob.mockClear()
    renderPage()
    await screen.findByTestId("access-folder-tree")
    fireEvent.click(screen.getByRole("button", { name: /export csv/i }))
    await waitFor(() => expect(downloadBlob).toHaveBeenCalled())
    const [blob, name] = downloadBlob.mock.calls[0] as [Blob, string]
    expect(name).toBe("Biblica-ETT-access.csv")
    expect(await blob.text()).toContain("Naladda")
  })
})

describe("orgAccessCsv", () => {
  it("writes the scope column byte-identical to formatScopePath (spec §3.9)", () => {
    const { result } = renderHook(() => useT())
    const lines = orgAccessCsv(result.current, payload.people).trimEnd().split("\r\n")
    // The team is a "via team" chip, so it leaves the scope column. A comma in
    // that team name quotes the origin cell instead (csvCell).
    const heir = lines.find((line) => line.startsWith("Heir,"))
    const scope = formatScopePath([org, team, project])
    expect(heir?.startsWith(`Heir,${scope},`)).toBe(true)
    expect(heir).toContain("via team")
    expect(heir).toContain(",Ruth,2026-09-01T00:00:00.000Z")
    expect(lines.some((line) => line.startsWith(`Ruth,${formatScopePath([org])},`))).toBe(true)
  })
})
