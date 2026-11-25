/**
 * AQU-1352 §3.6 (AQU-1072): the People & access page renders one server
 * payload two ways (tree by scope, one row per person) and exports it. Spec
 * §3.9 says a scope reads identically everywhere, so the CSV scope column must
 * be byte-identical to formatScopePath — the same string the chips show.
 */
import type { ReactNode } from "react"
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import { createMemoryRouter, RouterProvider } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

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
    { userId: "9", displayName: "Naladda", isGuest: true, grants: [
      { scopePath: [org, team, project], roleLevel: 500, origin: { kind: "inherited", from: [org, team] }, grantedBy: "Ruth", grantedAt: "2026-09-01T00:00:00.000Z" },
    ] },
    { userId: "1", displayName: "Ruth", isGuest: false, grants: [{ scopePath: [org], roleLevel: 700, origin: { kind: "direct" } }] },
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
vi.mock("@/context/OrgContext", () => ({ useActiveOrg: () => ({ activeOrg: { name: "Biblica ETT" }, activeOrgId: 1 }) }))
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

describe("OrgAccessPage", () => {
  it("keeps the person view's grant chips linked to the place they come from", async () => {
    renderPage()
    await screen.findByTestId("access-tree")
    // AQU-2317: the node carries the id an inherited pill's link lands on.
    expect(screen.getByTestId(accessNodeId(team)).id).toBe(accessNodeId(team))

    fireEvent.click(screen.getByRole("tab", { name: "People" }))
    await screen.findByTestId("access-people")
    const chips = screen.getAllByTestId("access-chip")
    // AQU-2317: the chip is a role pill plus the place, both from the shared
    // helpers — the place still reads byte-identical to the CSV column.
    expect(chips[0].textContent).toContain(formatScopePath([org, team, project]))
    const pill = chips[0].querySelector("[data-origin]")
    expect(pill?.getAttribute("data-origin")).toBe("inherited")
    // Inherited, so the pill names where the grant is set and links to that node.
    expect(pill?.textContent).toContain(`via team ${team.name}`)
    expect(pill?.getAttribute("href")).toBe(`#${accessNodeId(team)}`)
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

    const give = screen.getByRole("button", { name: /give access/i })
    expect(give).toBeDisabled()
    fireEvent.click(give.closest("[data-slot=tooltip-disabled-trigger]")!)
    expect(screen.getByText("Coming next")).toBeTruthy()
    expect(screen.queryByRole("dialog", { name: /give access/i })).toBeNull()
  })

  it("exports a CSV blob named after the org", async () => {
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
    expect(lines).toHaveLength(3)
    // The team is a "via team" chip, so it leaves the scope column. A comma in
    // that team name quotes the origin cell instead (csvCell).
    const scope = formatScopePath([org, team, project])
    expect(lines[1].startsWith(`Naladda,${scope},`)).toBe(true)
    expect(lines[1]).toContain("via team")
    expect(lines[1]).toContain(",Ruth,2026-09-01T00:00:00.000Z")
    expect(lines[2].startsWith(`Ruth,${formatScopePath([org])},`)).toBe(true)
  })
})
