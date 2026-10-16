// AQU-804: Project settings → Airtable. The states a member can see (not
// connected, unlinked, linked) and who may change what, as Monday's section;
// the linked view is Monday's, in Airtable's words.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { AirtableIntegrationSection } from "./AirtableIntegrationSection"
import * as api from "@/lib/airtable/api"

vi.mock("@/lib/airtable/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/airtable/api")>()),
  fetchAirtableConnection: vi.fn(),
  fetchAirtableLink: vi.fn(),
  fetchAirtableTableChanges: vi.fn(),
  dismissAirtableTableChanges: vi.fn(),
  patchAirtableLink: vi.fn(),
  syncAirtableNow: vi.fn(),
  deleteAirtableLink: vi.fn(),
  analyzeAirtableMapping: vi.fn(),
  addAirtableFields: vi.fn(),
}))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "tok", username: "tester" }, loading: false }),
}))
// The setup steps are their own component with their own tests.
vi.mock("./AirtableSetupWizard", () => ({
  AirtableSetupWizard: ({ open, mode }: { open: boolean; mode: string }) =>
    open ? <div data-testid="airtable-wizard">{mode}</div> : null,
}))

const mocked = vi.mocked(api)

function makeLink(overrides: Partial<api.AirtableTableLink> = {}): api.AirtableTableLink {
  return {
    id: "l1",
    baseId: "appCS",
    baseName: "Come & See",
    tableId: "tblTRACK",
    tableName: "Translation tracker",
    tableUrl: "https://airtable.com/appCS/tblTRACK",
    enabled: true,
    config: {
      version: 1,
      tableId: "tblTRACK",
      itemGranularity: "project_and_files",
      columns: [{ columnId: "fldProgress", columnType: "percent", metric: "completion_pct" }],
    },
    structureStale: false,
    lastPushedAt: "2026-10-15T10:00:00Z",
    lastPushStatus: "ok",
    lastPushError: null,
    orgConnected: true,
    ...overrides,
  }
}

const TABLE_CHANGES: api.AirtableTableChanges = {
  structureStale: false,
  newFields: [],
  structure: {
    baseId: "appCS",
    baseName: "Come & See",
    tableId: "tblTRACK",
    tableName: "Translation tracker",
    primaryFieldId: "fldName",
    url: "https://airtable.com/appCS/tblTRACK",
    fields: [
      { id: "fldName", name: "Name", type: "singleLineText" },
      { id: "fldProgress", name: "Progress", type: "percent" },
    ],
  },
}

function renderSection(roleLevel = 600) {
  return render(
    <MemoryRouter>
      <AirtableIntegrationSection projectId="p1" orgId={7} roleLevel={roleLevel} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocked.fetchAirtableConnection.mockResolvedValue({ connected: true })
  mocked.fetchAirtableTableChanges.mockResolvedValue(TABLE_CHANGES)
})

describe("AirtableIntegrationSection", () => {
  it("org not connected, below maintainer: points at Org settings → Airtable", async () => {
    mocked.fetchAirtableConnection.mockResolvedValue({ connected: false })
    mocked.fetchAirtableLink.mockResolvedValue({ linked: false, orgConnected: false, orgId: 7 })
    renderSection(400)
    expect(await screen.findByText("Your organization hasn't connected Airtable yet.")).toBeTruthy()
    expect(screen.getByRole("link", { name: "organization settings" }).getAttribute("href")).toBe("/orgs/7/settings/airtable")
  })

  it("unlinked maintainer: Set up with AI first, the manual path under it", async () => {
    mocked.fetchAirtableLink.mockResolvedValue({ linked: false, orgConnected: true, orgId: 7 })
    renderSection()
    fireEvent.click(await screen.findByTestId("airtable-setup-with-ai"))
    expect(screen.getByTestId("airtable-wizard").textContent).toBe("ai")
  })

  it("linked: the table, its records line, last push and the mapping in Airtable's words", async () => {
    mocked.fetchAirtableLink.mockResolvedValue({ linked: true, orgConnected: true, orgId: 7, link: makeLink() })
    renderSection()
    expect(await screen.findByText("Translation tracker")).toBeTruthy()
    expect(screen.getByText("Linked table:")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Open table in Airtable" }).getAttribute("href")).toBe(
      "https://airtable.com/appCS/tblTRACK",
    )
    expect(screen.getByText(/One record for the project and one per file\./)).toBeTruthy()
    expect(screen.getByText("Field mapping")).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId("airtable-mapping-editor")).toBeTruthy())
    expect(screen.getAllByText("Airtable field").length).toBeGreaterThan(0)
    expect(screen.getByTestId("airtable-add-fields")).toBeTruthy()
  })

  it("Sync now pushes and says how many records it wrote", async () => {
    mocked.fetchAirtableLink.mockResolvedValue({ linked: true, orgConnected: true, orgId: 7, link: makeLink() })
    mocked.syncAirtableNow.mockResolvedValue({ ok: true, pushed: true, itemsUpserted: 13 })
    renderSection()
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }))
    expect(await screen.findByText("Pushed to Airtable (13 records).")).toBeTruthy()
  })

  it("a field added in Airtable since linking is named, and can be mapped", async () => {
    mocked.fetchAirtableLink.mockResolvedValue({
      linked: true,
      orgConnected: true,
      orgId: 7,
      link: makeLink({ structureStale: true }),
    })
    mocked.fetchAirtableTableChanges.mockResolvedValue({
      ...TABLE_CHANGES,
      structureStale: true,
      newFields: [{ id: "fldReviewed", name: "Reviewed %", type: "percent" }],
    })
    renderSection()
    const banner = await screen.findByTestId("airtable-board-changes")
    await waitFor(() => expect(banner.textContent).toContain("Reviewed %"))
    expect(banner.textContent).toMatch(/New in your Airtable table/)
  })

  it("linked, below maintainer: read-only mapping, no sync controls", async () => {
    mocked.fetchAirtableLink.mockResolvedValue({ linked: true, orgConnected: true, orgId: 7, link: makeLink() })
    renderSection(400)
    expect(await screen.findByText("Translation tracker")).toBeTruthy()
    expect(screen.queryByTestId("airtable-mapping-editor")).toBeNull()
    expect(screen.queryByTestId("airtable-add-fields")).toBeNull()
    expect(screen.getByRole("button", { name: "Sync now" }).hasAttribute("disabled")).toBe(true)
    expect(mocked.fetchAirtableTableChanges).not.toHaveBeenCalled()
  })
})
