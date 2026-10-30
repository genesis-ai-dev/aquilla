// AQU-804: Airtable setup — Monday's three steps for a table. The AI picks
// the table and proposes the fields; the user sees which fields are already in
// the table, with names (Translators, Project manager) left unticked as on
// Monday; nothing is written before the last step; and "set up" is claimed
// only after a real push.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { pickSelectOption as selectOption } from "@/test-utils/select"
import { AirtableSetupWizard } from "./AirtableSetupWizard"
import * as api from "@/lib/airtable/api"

vi.mock("@/lib/airtable/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/airtable/api")>()),
  addAirtableFields: vi.fn(),
  analyzeAirtableMapping: vi.fn(),
  connectAirtable: vi.fn(),
  deleteAirtableLink: vi.fn(),
  fetchAirtableBases: vi.fn(),
  fetchAirtableTables: vi.fn(),
  putAirtableLink: vi.fn(),
  syncAirtableNow: vi.fn(),
}))

const mocked = vi.mocked(api)

const STRUCTURE: api.AirtableTableStructure = {
  baseId: "appCS",
  baseName: "Come & See",
  tableId: "tblTRACK",
  tableName: "Translation tracker",
  primaryFieldId: "fldName",
  url: "https://airtable.com/appCS/tblTRACK",
  fields: [
    { id: "fldName", name: "Name", type: "singleLineText" },
    { id: "fldProgress", name: "Progress", type: "percent" },
    { id: "fldStatus", name: "Status", type: "singleSelect" },
  ],
}

function analysis(): api.AirtableAnalysis {
  return {
    proposal: {
      version: 1,
      tableId: "tblTRACK",
      itemGranularity: "file",
      columns: [
        { columnId: "fldProgress", columnType: "percent", metric: "completion_pct" },
        { columnId: "fldStatus", columnType: "singleSelect", metric: "status_auto" },
        { columnId: "fldName", columnType: "singleLineText", metric: "project_name" },
      ],
      notes: "Episode rows.",
    },
    summary: "One record per episode.",
    warnings: [],
    tableReason: "It tracks translation.",
    structure: STRUCTURE,
  }
}

function makeLink(): api.AirtableTableLink {
  return {
    id: "l1",
    baseId: "appCS",
    baseName: "Come & See",
    tableId: "tblTRACK",
    tableName: "Translation tracker",
    tableUrl: "https://airtable.com/appCS/tblTRACK",
    enabled: true,
    config: analysis().proposal,
    structureStale: false,
    lastPushedAt: null,
    lastPushStatus: null,
    lastPushError: null,
    orgConnected: true,
  }
}

function renderWizard(props: Partial<Parameters<typeof AirtableSetupWizard>[0]> = {}) {
  const onLinked = vi.fn()
  const onConnected = vi.fn()
  render(
    <AirtableSetupWizard
      open
      onOpenChange={vi.fn()}
      projectId="p1"
      orgId={7}
      jwt="tok"
      orgConnected
      onLinked={onLinked}
      onUnlinked={vi.fn()}
      onConnected={onConnected}
      {...props}
    />,
  )
  return { onLinked, onConnected }
}

const box = (name: RegExp) => screen.getByRole("checkbox", { name })
const checked = (name: RegExp) => box(name).getAttribute("aria-checked") === "true"
const next = () => fireEvent.click(screen.getByRole("button", { name: /^next$/i }))

beforeEach(() => {
  vi.clearAllMocks()
  mocked.analyzeAirtableMapping.mockResolvedValue(analysis())
  mocked.addAirtableFields.mockImplementation(async (_jwt, _p, body) => ({
    created: body.metrics.map((metric, i) => ({ metric, columnId: `fldNew${i}`, columnType: "singleLineText", title: metric })),
    reused: [],
    failed: [],
    structure: { columns: [], groups: [] },
  }))
  mocked.putAirtableLink.mockResolvedValue({ link: makeLink(), warnings: [] })
  mocked.syncAirtableNow.mockResolvedValue({ ok: true, pushed: true, itemsUpserted: 13 })
})

describe("Airtable setup with AI", () => {
  it("shows the AI's table and why, then the fields, then links and pushes", async () => {
    const { onLinked } = renderWizard()
    fireEvent.click(screen.getByRole("button", { name: "Scan and propose" }))
    await waitFor(() => expect(screen.getByTestId("airtable-wizard-table")).toBeTruthy())
    expect(mocked.analyzeAirtableMapping).toHaveBeenCalledWith("tok", "p1", {})
    expect(screen.getByText("Step 1 of 3")).toBeTruthy()
    expect(screen.getByText("Translation tracker")).toBeTruthy()
    expect(screen.getByText("In the Come & See base")).toBeTruthy()
    expect(screen.getByText("It tracks translation.")).toBeTruthy()

    next()
    await waitFor(() => expect(screen.getByTestId("airtable-wizard-columns")).toBeTruthy())
    // Mapped by the AI, so in the table already.
    expect(checked(/^completion %$/i)).toBe(true)
    expect(screen.getByTestId("airtable-column-completion_pct").textContent).toMatch(/in your table/i)
    // Recommended, new.
    expect(checked(/^validated %$/i)).toBe(true)
    expect(screen.getByTestId("airtable-column-validated_pct").textContent).toMatch(/new field/i)
    // Names stay opt-in.
    expect(checked(/^translators$/i)).toBe(false)
    expect(checked(/^project manager$/i)).toBe(false)
    // Nothing written yet.
    expect(mocked.addAirtableFields).not.toHaveBeenCalled()
    expect(mocked.putAirtableLink).not.toHaveBeenCalled()

    next()
    await waitFor(() => expect(screen.getByTestId("airtable-wizard-confirm")).toBeTruthy())
    expect(screen.getByTestId("airtable-wizard-confirm").textContent).toMatch(
      /add \d+ fields to Translation tracker\. It keeps one record per file up to date there\./,
    )
    fireEvent.click(screen.getByRole("button", { name: "Add fields and connect" }))
    await waitFor(() => expect(screen.getByTestId("airtable-wizard-done")).toBeTruthy())

    const added = mocked.addAirtableFields.mock.calls[0]![2]
    expect(added).toMatchObject({ baseId: "appCS", tableId: "tblTRACK" })
    expect(added.metrics).toContain("validated_pct")
    expect(added.metrics).toContain("external_id")
    expect(added.metrics).not.toContain("translators")
    expect(added.metrics).not.toContain("completion_pct")

    const put = mocked.putAirtableLink.mock.calls[0]![2]
    expect(put).toMatchObject({ baseId: "appCS", tableId: "tblTRACK", baseName: "Come & See" })
    expect(put.config.itemGranularity).toBe("file")
    expect(put.config.tableId).toBe("tblTRACK")
    // The record name stays mapped even though it isn't in the picker.
    expect(put.config.columns).toContainEqual({ columnId: "fldName", columnType: "singleLineText", metric: "project_name" })
    expect(onLinked).toHaveBeenCalled()
    expect(screen.getByText("Airtable is set up")).toBeTruthy()
    expect(screen.getByTestId("airtable-wizard-push").textContent).toMatch("Pushed 13 records.")
  })

  it("lets the user ask for a record for the project and one per episode", async () => {
    renderWizard()
    fireEvent.click(screen.getByRole("button", { name: "Scan and propose" }))
    await waitFor(() => expect(screen.getByTestId("airtable-wizard-table")).toBeTruthy())
    next()
    await waitFor(() => expect(screen.getByTestId("airtable-wizard-columns")).toBeTruthy())
    await selectOption(/table records/i, /one record for the project and one per file/i)
    next()
    await waitFor(() => expect(screen.getByTestId("airtable-wizard-confirm")).toBeTruthy())
    expect(screen.getByTestId("airtable-wizard-confirm").textContent).toMatch(/one record for this project and one per file/)
    fireEvent.click(screen.getByRole("button", { name: "Add fields and connect" }))
    await waitFor(() => expect(screen.getByTestId("airtable-wizard-done")).toBeTruthy())
    expect(mocked.putAirtableLink.mock.calls[0]![2].config.itemGranularity).toBe("project_and_files")
  })

  it("an org without a connection pastes its token in the wizard, then the scan runs", async () => {
    mocked.connectAirtable.mockResolvedValue({ connected: true, baseCount: 1 })
    const { onConnected } = renderWizard({ orgConnected: false })
    fireEvent.click(screen.getByRole("button", { name: "Connect and scan" }))
    await waitFor(() => expect(screen.getByTestId("airtable-wizard-connect")).toBeTruthy())
    expect(mocked.analyzeAirtableMapping).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText("Personal access token"), { target: { value: "patXYZ.secret" } })
    fireEvent.click(screen.getByRole("button", { name: "Connect Airtable" }))
    await waitFor(() => expect(screen.getByTestId("airtable-wizard-table")).toBeTruthy())
    expect(mocked.connectAirtable).toHaveBeenCalledWith("tok", 7, "patXYZ.secret")
    expect(onConnected).toHaveBeenCalled()
  })

  it("a failed first push is said plainly, with what to do", async () => {
    mocked.syncAirtableNow.mockResolvedValue({ ok: false, pushed: false, error: "Rate limit exceeded." })
    renderWizard()
    fireEvent.click(screen.getByRole("button", { name: "Scan and propose" }))
    await waitFor(() => expect(screen.getByTestId("airtable-wizard-table")).toBeTruthy())
    next()
    await waitFor(() => expect(screen.getByTestId("airtable-wizard-columns")).toBeTruthy())
    next()
    await waitFor(() => expect(screen.getByTestId("airtable-wizard-confirm")).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: "Add fields and connect" }))
    await waitFor(() => expect(screen.getByTestId("airtable-wizard-done")).toBeTruthy())
    expect(screen.getByText("Table linked — sync needs attention")).toBeTruthy()
    expect(screen.getByTestId("airtable-wizard-push").textContent).toMatch(
      "Linked, but the first push failed: Rate limit exceeded. You can retry with Sync now.",
    )
  })
})

describe("Airtable setup without the AI", () => {
  // AQU-2260 (Sam, Oct 29, option 2B): an account's bases and a base's tables
  // grow with its data, so both lists get a search box.
  it("the base and table lists each have a search box that narrows them", async () => {
    mocked.fetchAirtableBases.mockResolvedValue([
      { id: "appCS", name: "Come & See" },
      { id: "appLOTE", name: "Living on the Edge" },
    ])
    mocked.fetchAirtableTables.mockResolvedValue([
      { id: "tblTRACK", name: "Translation tracker", primaryFieldId: "fldName", fields: STRUCTURE.fields, url: STRUCTURE.url },
      { id: "tblCAST", name: "Cast list", primaryFieldId: "fldName", fields: STRUCTURE.fields, url: STRUCTURE.url },
    ])
    renderWizard({ mode: "manual" })
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Airtable base" })).toBeTruthy())
    fireEvent.click(screen.getByRole("combobox", { name: "Airtable base" }))
    const baseSearch = await screen.findByRole("combobox", { name: "Search the list" })
    fireEvent.change(baseSearch, { target: { value: "edge" } })
    expect(await screen.findByRole("option", { name: "Living on the Edge" })).toBeTruthy()
    expect(screen.queryByRole("option", { name: "Come & See" })).toBeNull()
    fireEvent.keyDown(baseSearch, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "Search the list" })).toBeNull())
    await selectOption(/airtable base/i, /come & see/i)
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Airtable table" })).toBeTruthy())
    fireEvent.click(screen.getByRole("combobox", { name: "Airtable table" }))
    const tableSearch = await screen.findByRole("combobox", { name: "Search the list" })
    fireEvent.change(tableSearch, { target: { value: "cast" } })
    expect(await screen.findByRole("option", { name: "Cast list" })).toBeTruthy()
    expect(screen.queryByRole("option", { name: "Translation tracker" })).toBeNull()
  })

  it("picks a base and a table, then shows that table's fields", async () => {
    mocked.fetchAirtableBases.mockResolvedValue([{ id: "appCS", name: "Come & See" }])
    mocked.fetchAirtableTables.mockResolvedValue([
      { id: "tblTRACK", name: "Translation tracker", primaryFieldId: "fldName", fields: STRUCTURE.fields, url: STRUCTURE.url },
    ])
    renderWizard({ mode: "manual" })
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Airtable base" })).toBeTruthy())
    await selectOption(/airtable base/i, /come & see/i)
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Airtable table" })).toBeTruthy())
    await selectOption(/airtable table/i, /translation tracker/i)
    next()
    await waitFor(() => expect(screen.getByTestId("airtable-wizard-columns")).toBeTruthy())
    expect(mocked.analyzeAirtableMapping).not.toHaveBeenCalled()
    // "Status" is already in the table, so it is used rather than added.
    expect(screen.getByTestId("airtable-column-status_auto").textContent).toMatch(/in your table/i)
    expect(checked(/^status$/i)).toBe(true)
  })
})
