// MondaySetupWizard — three short steps, one decision each:
//   1. Which board? (the AI's pick, changeable)
//   2. What should your board show? (sensible ticks already made)
//   3. Confirm (one button that says what happens).
// Nothing is written to Monday before step 3, the AI is asked for everything a
// scan can answer, and "set up" is only claimed after a real push has landed.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { pickSelectOption as selectOption } from "@/test-utils/select"
import { MondaySetupWizard } from "./MondaySetupWizard"
import * as api from "@/lib/monday/api"

vi.mock("@/lib/monday/api", () => ({
  // Mirrors the real (message, status) signature — the typecheck holds it there.
  MondayApiError: class MondayApiError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  },
  addMondayColumns: vi.fn(),
  analyzeMondayMapping: vi.fn(),
  deleteMondayLink: vi.fn(),
  fetchMondayBoards: vi.fn(),
  fetchMondayBoardStructure: vi.fn(),
  putMondayLink: vi.fn(),
  startMondayConnect: vi.fn(),
  syncMondayNow: vi.fn(),
}))

const mocked = vi.mocked(api)

const PROPOSAL = {
  version: 1 as const,
  itemGranularity: "project" as const,
  columns: [{ columnId: "numbers_1", columnType: "numbers", metric: "completion_pct" as const }],
  notes: "Maps completion to Progress.",
}

function analysis(overrides: Partial<api.MondayAnalysis> = {}): api.MondayAnalysis {
  return {
    proposal: PROPOSAL,
    summary: "Pushes completion to the Progress column.",
    warnings: [],
    boardId: "b1",
    boardName: "Translation Tracker",
    boardReason: "Its name matches the project.",
    ...overrides,
  }
}

function makeLink(): api.MondayBoardLink {
  return {
    id: "l1",
    boardId: "b1",
    boardName: "Translation Tracker",
    enabled: true,
    config: PROPOSAL,
    structureStale: false,
    lastPushedAt: null,
    lastPushStatus: null,
    lastPushError: null,
    orgConnected: true,
  }
}

const NO_FAILURES = { failed: [] as api.MondayAddColumnsResult["failed"], structure: { columns: [], groups: [] } }

function renderWizard(props: Partial<Parameters<typeof MondaySetupWizard>[0]> = {}) {
  const onLinked = vi.fn()
  const onUnlinked = vi.fn()
  const onConnected = vi.fn()
  render(
    <MondaySetupWizard
      open
      onOpenChange={vi.fn()}
      projectId="p1"
      orgId={7}
      jwt="tok"
      orgConnected
      onLinked={onLinked}
      onUnlinked={onUnlinked}
      onConnected={onConnected}
      {...props}
    />,
  )
  return { onLinked, onUnlinked, onConnected }
}

const box = (name: RegExp) => screen.getByRole("checkbox", { name })
const checked = (name: RegExp) => box(name).getAttribute("aria-checked") === "true"
const next = () => fireEvent.click(screen.getByRole("button", { name: /^next$/i }))

async function toBoard() {
  fireEvent.click(screen.getByRole("button", { name: /scan and propose/i }))
  await waitFor(() => expect(screen.getByTestId("monday-wizard-board")).toBeTruthy())
}
async function toColumns() {
  await toBoard()
  next()
  await waitFor(() => expect(screen.getByTestId("monday-wizard-columns")).toBeTruthy())
}
async function toConfirm() {
  await toColumns()
  next()
  await waitFor(() => expect(screen.getByTestId("monday-wizard-confirm")).toBeTruthy())
}
async function confirmAndFinish() {
  await toConfirm()
  fireEvent.click(screen.getByRole("button", { name: /add columns and connect|^connect$/i }))
  await waitFor(() => expect(screen.getByTestId("monday-wizard-done")).toBeTruthy())
}

beforeEach(() => {
  vi.clearAllMocks()
  mocked.analyzeMondayMapping.mockResolvedValue(analysis())
  mocked.fetchMondayBoardStructure.mockResolvedValue({
    url: "https://actual-account.monday.com/boards/b1",
    columns: [{ id: "numbers_1", title: "Progress", type: "numbers" }],
    groups: [],
  })
  mocked.addMondayColumns.mockImplementation(async (_jwt, _p, body) => ({
    created: body.metrics.map((metric, i) => ({ metric, columnId: `new_${i}`, columnType: "text", title: metric })),
    reused: [],
    ...NO_FAILURES,
  }))
  mocked.putMondayLink.mockResolvedValue({ link: makeLink(), warnings: [] })
  mocked.syncMondayNow.mockResolvedValue({ ok: true, pushed: true, itemsUpserted: 3 })
})

describe("step 1: which board", () => {
  it("shows the AI's pick and why, without asking the user anything or listing boards", async () => {
    renderWizard()
    await toBoard()
    expect(mocked.analyzeMondayMapping).toHaveBeenCalledWith("tok", "p1", {})
    expect(mocked.fetchMondayBoards).not.toHaveBeenCalled()
    expect(screen.getByText("Step 1 of 3")).toBeTruthy()
    expect(screen.getByText("Translation Tracker")).toBeTruthy()
    expect(screen.getByText(/its name matches the project/i)).toBeTruthy()
  })

  it("Change lists the boards; picking another re-scans for it", async () => {
    mocked.fetchMondayBoards.mockResolvedValue([
      { id: "b1", name: "Translation Tracker", workspace: null },
      { id: "b2", name: "Other board", workspace: null },
    ])
    renderWizard()
    await toBoard()
    fireEvent.click(screen.getByRole("button", { name: /^change$/i }))
    await screen.findByRole("combobox", { name: /monday board/i })
    await selectOption(/monday board/i, /other board/i)
    await waitFor(() => expect(mocked.analyzeMondayMapping).toHaveBeenLastCalledWith("tok", "p1", { boardId: "b2" }))
  })
})

describe("step 2: what the board shows", () => {
  it("ticks the recommended columns and what's on the board; Aquilla ID is ticked and locked", async () => {
    renderWizard()
    await toColumns()
    for (const name of [/^Completion %$/, /^Validated %$/, /^Audio validated %$/, /^Status$/, /^Last activity$/, /^Deadline$/, /^Schedule$/]) {
      expect(checked(name)).toBe(true)
    }
    expect(checked(/^Books done$/)).toBe(false)
    expect(checked(/^Aquilla ID$/)).toBe(true)
    expect(box(/^Aquilla ID$/).getAttribute("aria-disabled") ?? String((box(/^Aquilla ID$/) as HTMLButtonElement).disabled)).toMatch(/true/)
  })

  it("tags each column as on the board or new", async () => {
    renderWizard()
    await toColumns()
    expect(screen.getByTestId("monday-column-completion_pct").textContent).toMatch(/on your board/i)
    expect(screen.getByTestId("monday-column-deadline").textContent).toMatch(/new column/i)
  })

  it("shows what each column means under its name, with no (i) buttons", async () => {
    renderWizard()
    await toColumns()
    expect(screen.getByTestId("monday-column-deadline").textContent).toMatch(/the project's deadline/i)
    expect(box(/^Deadline$/).getAttribute("aria-describedby")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /what “.*” shows/i })).toBeNull()
  })

  it("says how many columns get added and how many are reused, live", async () => {
    renderWizard()
    await toColumns()
    // 6 recommended not on the board + Aquilla ID = 7 new; Completion % is mapped.
    expect(screen.getByTestId("monday-column-summary").textContent).toBe(
      "Adds 7 new columns to Translation Tracker and uses 1 already there.",
    )
    fireEvent.click(box(/^Deadline$/))
    await waitFor(() =>
      expect(screen.getByTestId("monday-column-summary").textContent).toMatch(/^Adds 6 new columns/),
    )
  })

  it("won't go on with nothing but Aquilla ID ticked", async () => {
    mocked.analyzeMondayMapping.mockResolvedValue(
      analysis({ proposal: { ...PROPOSAL, columns: [] } }),
    )
    renderWizard()
    await toColumns()
    for (const name of [/^Completion %$/, /^Validated %$/, /^Audio validated %$/, /^Status$/, /^Last activity$/, /^Deadline$/, /^Schedule$/]) {
      fireEvent.click(box(name))
    }
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /^next$/i }) as HTMLButtonElement).disabled).toBe(true),
    )
  })

  it("explains columns the server clamped away instead of silently dropping them", async () => {
    mocked.analyzeMondayMapping.mockResolvedValue(
      analysis({ warnings: ["column 'formula_1' is read-only (formula)"] }),
    )
    renderWizard()
    await toColumns()
    expect(screen.getByText(/some columns were skipped/i)).toBeTruthy()
    expect(screen.getByText(/formula_1.*read-only/i)).toBeTruthy()
  })

  it("Advanced reveals per-row column matching and the item granularity", async () => {
    renderWizard()
    await toColumns()
    expect(screen.queryByTestId("monday-wizard-advanced")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /advanced: match columns myself/i }))
    expect(screen.getByTestId("monday-wizard-advanced")).toBeTruthy()
    expect(screen.getByRole("combobox", { name: /board items/i })).toBeTruthy()
    expect(screen.getAllByRole("button", { name: /remove mapping row/i }).length).toBeGreaterThan(0)
  })
})

describe("step 3: confirm", () => {
  it("creates nothing until the user confirms, then adds, links and pushes", async () => {
    const { onLinked } = renderWizard()
    await toConfirm()
    expect(mocked.addMondayColumns).not.toHaveBeenCalled()
    expect(screen.getByText(/aquilla will add 7 columns to your monday board and keep one row for this project up to date/i)).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /add columns and connect/i }))
    await waitFor(() => expect(screen.getByTestId("monday-wizard-done")).toBeTruthy())

    expect(mocked.addMondayColumns).toHaveBeenCalledTimes(1)
    expect(mocked.addMondayColumns.mock.calls[0][2]).toEqual({
      boardId: "b1",
      metrics: ["validated_pct", "audio_validated_pct", "status_auto", "deadline", "last_activity", "schedule_status", "external_id"],
    })
    const config = mocked.putMondayLink.mock.calls[0][2].config
    expect(config.columns[0]).toEqual({ columnId: "numbers_1", columnType: "numbers", metric: "completion_pct" })
    expect(config.columns.map((c) => c.metric)).toContain("external_id")
    expect(config.columns).toHaveLength(8)
    // A link that pushes nothing is not "set up" — the push is part of confirm.
    expect(mocked.syncMondayNow).toHaveBeenCalledWith("tok", "p1")
    expect(onLinked).toHaveBeenCalled()
    expect(screen.getByText(/pushed 3 items/i)).toBeTruthy()
    expect(screen.getByRole("link", { name: /view board/i }).getAttribute("href")).toBe("https://actual-account.monday.com/boards/b1")
  })

  it("just says Connect when the board already has every ticked column", async () => {
    const metrics = ["completion_pct", "validated_pct", "audio_validated_pct", "status_auto", "last_activity", "deadline", "schedule_status", "external_id"] as const
    mocked.analyzeMondayMapping.mockResolvedValue(
      analysis({
        proposal: { ...PROPOSAL, columns: metrics.map((metric, i) => ({ columnId: `c${i}`, columnType: "text", metric })) },
      }),
    )
    renderWizard()
    await toConfirm()
    expect(screen.getByText(/keep one row for this project up to date on translation tracker/i)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }))
    await waitFor(() => expect(screen.getByTestId("monday-wizard-done")).toBeTruthy())
    expect(mocked.addMondayColumns).not.toHaveBeenCalled()
  })

  it("names the columns Monday refused and still connects the rest", async () => {
    mocked.addMondayColumns.mockResolvedValue({
      created: [{ metric: "external_id", columnId: "x1", columnType: "text", title: "Aquilla ID" }],
      reused: [],
      failed: [{ metric: "status_auto", title: "Status", error: "Complexity budget exhausted" }],
      structure: { columns: [], groups: [] },
    })
    renderWizard()
    await confirmAndFinish()
    expect(screen.getByTestId("monday-wizard-not-added").textContent).toMatch(
      /monday didn't add: status \(complexity budget exhausted\)/i,
    )
    expect(mocked.putMondayLink).toHaveBeenCalled()
  })

  it("connects nothing when adding the columns fails outright", async () => {
    mocked.addMondayColumns.mockRejectedValue(new Error("Monday is down"))
    renderWizard()
    await toConfirm()
    fireEvent.click(screen.getByRole("button", { name: /add columns and connect/i }))
    expect(await screen.findByText(/couldn't add the columns: monday is down\. nothing was connected yet/i)).toBeTruthy()
    expect(mocked.putMondayLink).not.toHaveBeenCalled()
  })

  it("Back walks the steps without losing the ticks", async () => {
    renderWizard()
    await toConfirm()
    fireEvent.click(screen.getByRole("button", { name: /^back$/i }))
    await waitFor(() => expect(screen.getByTestId("monday-wizard-columns")).toBeTruthy())
    expect(checked(/^Deadline$/)).toBe(true)
  })
})

describe("after confirm", () => {
  it("says so when the link saved but the first push failed", async () => {
    mocked.syncMondayNow.mockResolvedValue({ ok: false, pushed: false, error: "board column was deleted" })
    renderWizard()
    await confirmAndFinish()
    expect(screen.getByText(/first push failed/i)).toBeTruthy()
    expect(screen.getByText(/board column was deleted/i)).toBeTruthy()
  })

  it("does not call a skipped push successful", async () => {
    mocked.syncMondayNow.mockResolvedValue({ ok: true, pushed: false })
    renderWizard()
    await confirmAndFinish()
    expect(await screen.findByRole("heading", { name: /sync needs attention/i })).toBeTruthy()
  })

  it("shows the server's link warnings and hands them to the parent", async () => {
    const webhookWarning =
      "could not create Monday webhooks; board-structure changes will not be detected automatically"
    mocked.putMondayLink.mockResolvedValue({ link: makeLink(), warnings: [webhookWarning] })
    const { onLinked } = renderWizard()
    await confirmAndFinish()
    expect(screen.getByTestId("monday-wizard-link-warnings").textContent).toContain(webhookWarning)
    expect(screen.queryByText("Monday.com is set up")).toBeNull()
    expect(onLinked).toHaveBeenCalledWith(expect.objectContaining({ id: "l1" }), [webhookWarning])
  })

  it("claims nothing went wrong when nothing did", async () => {
    renderWizard()
    await confirmAndFinish()
    expect(screen.getByText("Monday.com is set up")).toBeTruthy()
    expect(screen.queryByTestId("monday-wizard-link-warnings")).toBeNull()
  })

  it("undo removes the link the wizard just created", async () => {
    mocked.deleteMondayLink.mockResolvedValue(undefined)
    const { onUnlinked } = renderWizard()
    await confirmAndFinish()
    fireEvent.click(screen.getByRole("button", { name: /undo/i }))
    await waitFor(() => expect(mocked.deleteMondayLink).toHaveBeenCalledWith("tok", "p1"))
    expect(onUnlinked).toHaveBeenCalled()
  })

  it("drops a granularity-mismatched item-name template rather than shipping it", async () => {
    mocked.analyzeMondayMapping.mockResolvedValue(analysis({ proposal: { ...PROPOSAL, itemNameTemplate: "{projectName}" } }))
    renderWizard()
    await toColumns()
    fireEvent.click(screen.getByRole("button", { name: /advanced: match columns myself/i }))
    const trigger = await selectOption(/board items/i, /one item per file/i)
    await waitFor(() => expect(trigger.textContent).toMatch(/one item per file/i))
    next()
    await waitFor(() => expect(screen.getByText(/one row per file/i)).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: /add columns and connect/i }))
    await waitFor(() => expect(mocked.putMondayLink).toHaveBeenCalled())
    const config = mocked.putMondayLink.mock.calls[0][2].config
    expect(config.itemGranularity).toBe("file")
    expect(config.itemNameTemplate).toBeUndefined()
  })
})

describe("before the scan", () => {
  it("with no org connection it drives OAuth first rather than failing the scan", async () => {
    renderWizard({ orgConnected: false })
    fireEvent.click(screen.getByRole("button", { name: /connect and scan/i }))
    await waitFor(() => expect(screen.getByRole("button", { name: /^connect monday\.com$/i })).toBeTruthy())
    expect(mocked.analyzeMondayMapping).not.toHaveBeenCalled()
  })

  it("a scan failure returns to intro with the reason, not a dead end", async () => {
    mocked.analyzeMondayMapping.mockRejectedValue(new Error("AI provider unavailable"))
    renderWizard()
    fireEvent.click(screen.getByRole("button", { name: /scan and propose/i }))
    await waitFor(() => expect(screen.getByText(/ai provider unavailable/i)).toBeTruthy())
    expect(screen.getByRole("button", { name: /scan and propose/i })).toBeTruthy()
  })

  it("tells the user to make a board when the account has none, instead of echoing a 409", async () => {
    mocked.analyzeMondayMapping.mockRejectedValue(new api.MondayApiError("no boards found in this Monday account", 409))
    renderWizard()
    fireEvent.click(screen.getByRole("button", { name: /scan and propose/i }))
    await waitFor(() => expect(screen.getByText(/create one in monday/i)).toBeTruthy())
  })

  it("opens with one sentence, not a list", () => {
    renderWizard()
    expect(screen.getByText(/nothing changes in monday until you confirm/i)).toBeTruthy()
    expect(screen.queryByRole("list")).toBeNull()
  })
})

describe("manual mode", () => {
  it("lets the user pick the board, never asks the AI, and reads the board for step 2", async () => {
    mocked.fetchMondayBoards.mockResolvedValue([{ id: "b1", name: "Translation Tracker", workspace: null }])
    mocked.fetchMondayBoardStructure.mockResolvedValue({
      columns: [{ id: "t1", title: "Translators", type: "text" }],
      groups: [],
    })
    renderWizard({ mode: "manual" })
    await waitFor(() => expect(mocked.fetchMondayBoards).toHaveBeenCalledWith("tok", 7))
    expect((screen.getByRole("button", { name: /^next$/i }) as HTMLButtonElement).disabled).toBe(true)
    await selectOption(/monday board/i, /translation tracker/i)
    await waitFor(() => expect((screen.getByRole("button", { name: /^next$/i }) as HTMLButtonElement).disabled).toBe(false))
    next()
    await waitFor(() => expect(screen.getByTestId("monday-wizard-columns")).toBeTruthy())
    expect(mocked.fetchMondayBoardStructure).toHaveBeenCalledWith("tok", 7, "b1")
    expect(mocked.analyzeMondayMapping).not.toHaveBeenCalled()
    expect(screen.getByTestId("monday-column-translators").textContent).toMatch(/on your board/i)
    expect(screen.getByRole("button", { name: /advanced: match columns myself/i })).toBeTruthy()
  })
})
