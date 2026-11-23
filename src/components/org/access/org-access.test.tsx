/**
 * AQU-1352 §3.6 (AQU-1072): the People & access page renders one server
 * payload two ways (tree by scope, one row per person) and exports it. Spec
 * §3.9 says a scope reads identically everywhere, so the CSV scope column must
 * be byte-identical to formatScopePath — the same string the chips show.
 */
import type { ReactNode } from "react"
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
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
    { userId: "1", displayName: "Ruth", isGuest: false, email: "ruth@example.com", lastActiveAt: recent, grants: [
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
vi.mock("@/components/AppShell", () => ({ AppShell: ({ main }: { main: ReactNode }) => <>{main}</> }))
vi.mock("@/components/org/OrgSidebar", () => ({ OrgSidebar: () => null }))
vi.mock("@/components/org/OrgBreadcrumb", () => ({ OrgBreadcrumb: () => null }))
vi.mock("@/context/OrgContext", () => ({ useActiveOrg: () => ({ activeOrg: { id: 1, name: "Biblica ETT" }, activeOrgId: 1 }) }))
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

function placeButton(name: string) {
  return screen.getByRole("button", { name: (accessible) => accessible.includes(name) })
}

function peopleFilter(label: string) {
  return screen.getByRole("button", { name: (accessible) => accessible.replace(/\s+/g, " ").trim().startsWith(`${label} `) })
}

function personRow(name: string) {
  const row = screen.getAllByTestId("people-row").find((item) => item.getAttribute("data-person") === name)
  if (!row) throw new Error(`no people row for ${name}`)
  return row
}

describe("OrgAccessPage Give access (AQU-2320)", () => {
  it("is disabled where the viewer may grant nowhere", async () => {
    renderPage()
    await screen.findByTestId("access-tree")
    // No grantable map (or nothing grantable): the server would refuse every grant.
    expect(screen.getByTestId("give-access-open")).toBeDisabled()
  })

  it("opens pre-filled with the place selected in the lens", async () => {
    payload.grantable = { "org:1": { ok: true, cap: 700 }, "project:p1": { ok: true, cap: 700 } }
    try {
      renderPage()
      await screen.findByTestId("access-tree")
      fireEvent.click(placeButton("Pattani"))
      fireEvent.click(screen.getByTestId("give-access-open"))
      const dialog = await screen.findByTestId("give-access-dialog")
      expect(within(dialog).getByTestId("give-place")).toHaveTextContent("Pattani")
    } finally {
      delete payload.grantable
    }
  })
})

describe("OrgAccessPage", () => {
  it("AQU-2323: a name on the Places lens, granted here or reaching here, opens that person's inspector", async () => {
    renderPage()
    await screen.findByTestId("access-tree")
    fireEvent.click(placeButton("Pattani"))
    expect(await screen.findByRole("link", { name: "Open Naladda" })).toHaveAttribute("href", "/orgs/1/access/people/9")
    expect(screen.getByRole("link", { name: "Open Ruth" })).toHaveAttribute("href", "/orgs/1/access/people/1")
  })

  it("lists members, guests, and invites, and a Guests CSV repeats the breadcrumbs on screen", async () => {
    renderPage()
    await screen.findByTestId("access-tree")
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
    expect(within(screen.getByTestId("access-tree")).queryByRole("button", { name: (n) => n.includes(other.name) })).toBeNull()
    expect(within(screen.getByTestId("access-tree")).getByRole("button", { name: (n) => n.includes(project.name) })).toBeTruthy()
  })

  it("shows who is granted at a place and who reaches it, and the URL remembers the place", async () => {
    const router = renderPage()
    await screen.findByTestId("access-tree")

    fireEvent.click(placeButton(project.name))
    expect(router.state.location.search).toContain("project")

    const granted = screen.getAllByTestId("granted-here-row")
    const reaches = screen.getAllByTestId("reaches-here-row")
    const summary = screen.getByTestId("place-summary").textContent ?? ""
    expect(Number(summary.match(/^(\d+)/)?.[1])).toBe(granted.length + reaches.length)
    expect(Number(summary.match(/(\d+) (?:is|are) granted here/)?.[1])).toBe(granted.length)
    expect(Number(summary.match(/(\d+) reach/)?.[1])).toBe(reaches.length)

    const reviewer = granted.find((row) => row.textContent?.includes("Naladda"))
    const member = granted.find((row) => row.textContent?.includes("Member"))
    expect(reviewer?.querySelector("[data-origin]")?.getAttribute("data-origin")).toBe("direct")
    expect(reviewer?.querySelector("[data-origin]")?.className).not.toContain("border-dashed")
    expect(reviewer?.textContent).toContain("Reviewer")
    expect(within(reviewer!).getByTestId("guest-badge")).toBeTruthy()
    expect(within(member!).queryByTestId("guest-badge")).toBeNull()

    const maintainer = reaches.find((row) => row.textContent?.includes("Ruth"))
    const teamRow = reaches.find((row) => row.textContent?.includes(team.name))
    expect(maintainer?.querySelector("[data-origin]")?.getAttribute("data-origin")).toBe("inherited")
    expect(maintainer?.querySelector("[data-origin]")?.className).toContain("border-dashed")
    expect(maintainer?.textContent).toContain("Maintainer")
    expect(within(maintainer!).getByTestId("reaches-reason").textContent).toContain(org.name)
    expect(teamRow?.querySelector("[data-origin]")?.className).toContain("border-dashed")
    expect(teamRow?.textContent).toContain("Contributor")
    expect(teamRow?.textContent).toContain("4")

    fireEvent.click(within(teamRow!).getByRole("button", { name: /show the grant/i }))
    expect(router.state.location.search).toContain("team")
    expect(placeButton(team.name).getAttribute("aria-current")).toBe("true")
    await act(async () => { await router.navigate(-1) })
    expect(router.state.location.search).toContain("project")
    expect(placeButton(project.name).getAttribute("aria-current")).toBe("true")

    fireEvent.click(placeButton(french.name))
    const laneGranted = screen.getAllByTestId("granted-here-row")
    const laneReaches = screen.getAllByTestId("reaches-here-row")
    expect(laneGranted.some((row) => row.textContent?.includes("LaneOnly"))).toBe(true)
    expect(laneGranted.some((row) => row.textContent?.includes("Naladda"))).toBe(false)
    expect(laneReaches.some((row) => row.textContent?.includes("Via project"))).toBe(true)
    fireEvent.click(placeButton(spanish.name))
    expect(screen.queryByText("LaneOnly")).toBeNull()
    expect(screen.getAllByTestId("reaches-here-row").some((row) => row.textContent?.includes("Via project"))).toBe(true)

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Naladda" } })
    expect(within(screen.getByTestId("access-tree")).queryByRole("button", { name: (n) => n.includes(other.name) })).toBeNull()
    expect(within(screen.getByTestId("access-tree")).getByRole("button", { name: (n) => n.includes(project.name) })).toBeTruthy()

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Other" } })
    const tree = within(screen.getByTestId("access-tree"))
    expect(tree.queryByRole("button", { name: (n) => n.includes(project.name) })).toBeNull()
    expect(tree.getByRole("button", { name: (n) => n.includes(other.name) })).toBeTruthy()

    const lens = screen.getByTestId("places-lens")
    expect(lens.className).toContain("flex-col")
    expect(lens.className).toContain("md:flex-row")
    expect(lens.className).toContain("overflow-x-hidden")

    // AQU-2320: this payload grants the viewer nowhere, so Give access stays
    // shut (the "Coming next" placeholder is gone; the dialog is real now).
    const give = screen.getByRole("button", { name: /give access/i })
    expect(give).toBeDisabled()
    fireEvent.click(give)
    expect(screen.queryByRole("dialog", { name: /give access/i })).toBeNull()
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
    await screen.findByTestId("access-tree")
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
