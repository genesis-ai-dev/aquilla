/**
 * AQU-1352 §3.6 (AQU-1072): the People & access page renders one server
 * payload two ways (tree by scope, one row per person) and exports it. Spec
 * §3.9 says a scope reads identically everywhere, so the CSV scope column must
 * be byte-identical to formatScopePath — the same string the chips show.
 */
import type { ReactNode } from "react"
import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { formatScopePath } from "@/lib/access/scope-path"
import { useT } from "@/lib/i18n/I18nProvider"
import { orgAccessCsv, type OrgAccessPayload } from "./org-access-data"

const org = { type: "org" as const, id: "1", name: "Biblica ETT" }
const team = { type: "team" as const, id: "7", name: "Thai, \"core\"" }
const project = { type: "project" as const, id: "p1", name: "Pattani" }

const payload: OrgAccessPayload = {
  tree: [{
    scope: org,
    directGrantees: [{ userId: "1", displayName: "Ruth", roleLevel: 700 }],
    children: [{
      scope: team,
      directGrantees: [],
      children: [{ scope: project, children: [], directGrantees: [{ userId: "9", displayName: "Naladda", roleLevel: 500 }] }],
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

describe("OrgAccessPage", () => {
  it("shows the scope tree with direct grantees, then the per-person chips", async () => {
    render(<OrgAccessPage />)
    await screen.findByTestId("access-tree")
    // Project node lists its direct grantee with a role label, never a number.
    const node = screen.getByTestId("access-node-project-p1")
    expect(node.textContent).toContain("Naladda")
    expect(node.textContent).not.toMatch(/\b500\b/)

    fireEvent.click(screen.getByRole("tab", { name: "People" }))
    await screen.findByTestId("access-people")
    const chips = screen.getAllByTestId("access-chip")
    expect(chips[0].textContent).toContain(`@ ${formatScopePath([org, team, project])}`)
    expect(chips[0].querySelector("[data-origin]")?.getAttribute("data-origin")).toBe("inherited")
  })

  it("exports a CSV blob named after the org", async () => {
    render(<OrgAccessPage />)
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
    // Team name contains a comma and quotes → RFC 4180 quoting, content unchanged.
    const quoted = `"${formatScopePath([org, team, project]).replace(/"/g, '""')}"`
    expect(lines[1].startsWith(`Naladda,${quoted},`)).toBe(true)
    expect(lines[1]).toContain(",Ruth,2026-09-01T00:00:00.000Z")
    expect(lines[2].startsWith(`Ruth,${formatScopePath([org])},`)).toBe(true)
  })
})
