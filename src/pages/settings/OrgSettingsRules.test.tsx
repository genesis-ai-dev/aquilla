/**
 * AQU-1131 regression guard — org rules are a top-level Settings section.
 *
 * Before this, the org rule library rendered ONLY inside RulesSurface, which
 * mounts on a project's Living Memory → Translation quality pane. An org
 * maintainer with no project open had no route to their own org-wide rules.
 * These tests pin the two halves of the fix: the Settings index offers the
 * row, and `/orgs/:orgId/settings/rules` renders the library standalone —
 * including for a read-only viewer, who must see the empty state rather than
 * a blank page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { OrgSettingsIndex } from "./OrgSettingsIndex"
import { OrgSettingsRules } from "./OrgSettingsRules"
import { fetchOrgSettings } from "@/lib/sync/org-settings"
import type { OrgSettingsResponse } from "@/lib/sync/org-settings"
import type { TranslationRule } from "@/lib/parsers/types"
import { ROLE } from "@/lib/frontier/roles"
import { listMyOrgs } from "@/lib/frontier/orgs"

vi.mock("@/lib/sync/cloud-projects", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/cloud-projects")>()),
  fetchAccessibleProjectsResult: vi.fn(async () => ({ ok: true as const, projects: [] })),
}))

vi.mock("@/lib/sync/org-settings", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/org-settings")>()),
  fetchOrgSettings: vi.fn(async () => null),
}))

vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }),
}))
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: vi.fn(async () => [{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }]),
  renameOrg: vi.fn(async () => {}),
}))

const mockFetchOrgSettings = vi.mocked(fetchOrgSettings)
const mockListMyOrgs = vi.mocked(listMyOrgs)

const orgRule: TranslationRule = {
  id: "rule-1",
  name: "No straight quotes",
  description: "Use typographic quotation marks",
  scope: "org",
  source: "user",
  severity: "major",
  enabled: true,
  check: { type: "target-forbids", targetPattern: "\"" },
  createdAt: "2026-09-01T00:00:00.000Z",
}

function settingsResponse(rules: TranslationRule[]): OrgSettingsResponse {
  return { orgId: 1, settings: { rules }, version: 3, updatedAt: null, updatedBy: null }
}

/** Swap the signed-in org role for the read-only case. */
function signInAs(level: number) {
  mockListMyOrgs.mockResolvedValue([
    { id: 1, name: "Come and See", role: { level, name: level >= ROLE.MAINTAINER ? "maintainer" : "viewer" } },
  ] as Awaited<ReturnType<typeof listMyOrgs>>)
}

beforeEach(() => {
  localStorage.clear()
  signInAs(ROLE.OWNER)
})
afterEach(() => vi.clearAllMocks())

function renderAt(path: string, element: React.ReactNode, routePath: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <OrgProvider>
        <Routes>
          <Route path={routePath} element={element} />
        </Routes>
      </OrgProvider>
    </MemoryRouter>,
  )
}

describe("AQU-1131 — org rules as a top-level Settings section", () => {
  it("offers a Rules row on the org Settings index, linking to settings/rules", async () => {
    renderAt("/orgs/1/settings", <OrgSettingsIndex />, "/orgs/:orgId/settings")

    const row = await screen.findByRole("link", { name: /Rules/ })
    expect(row.getAttribute("href")).toBe("/orgs/1/settings/rules")
  })

  it("renders the org rule library standalone, with no project mounted", async () => {
    mockFetchOrgSettings.mockResolvedValue(settingsResponse([orgRule]))

    renderAt("/orgs/1/settings/rules", <OrgSettingsRules />, "/orgs/:orgId/settings/rules")

    expect(await screen.findByText("No straight quotes")).toBeDefined()
    // The card counts what it holds — proves it read real org settings, not a stub.
    expect(await screen.findByText(/Org Rules \(1\)/)).toBeDefined()
  })

  it("shows a read-only viewer the empty state rather than a blank page", async () => {
    signInAs(ROLE.VIEWER)
    mockFetchOrgSettings.mockResolvedValue(settingsResponse([]))

    renderAt("/orgs/1/settings/rules", <OrgSettingsRules />, "/orgs/:orgId/settings/rules")

    expect(await screen.findByText(/No org-level rules yet/)).toBeDefined()
    expect(screen.queryByRole("button", { name: /Add Org Rule/ })).toBeNull()
  })
})
