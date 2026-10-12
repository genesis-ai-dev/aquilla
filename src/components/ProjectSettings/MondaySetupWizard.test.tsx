// MondaySetupWizard — the guarantees that make this a wizard rather than a
// chat: the AI is asked for everything (including the board) so the user is
// never asked a question a scan could answer; a clamped proposal explains
// itself; and "set up" is only claimed after a real push has landed.

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

// The shared helper drives the pointer sequence Base UI requires to commit a
// choice (see src/test-utils/select.tsx); here we additionally hold it to
// rendering the chosen label on the trigger.
async function pickSelectOption(triggerName: RegExp, optionName: RegExp) {
  const trigger = await selectOption(triggerName, optionName)
  await waitFor(() => {
    expect(trigger.textContent).toMatch(optionName)
  })
}

/** Drive intro → review. */
async function scanToReview() {
  fireEvent.click(screen.getByRole("button", { name: /scan and propose/i }))
  await waitFor(() => expect(screen.getByTestId("monday-wizard-review")).toBeTruthy())
}

beforeEach(() => {
  vi.clearAllMocks()
  mocked.analyzeMondayMapping.mockResolvedValue(analysis())
  mocked.fetchMondayBoardStructure.mockResolvedValue({
    url: "https://actual-account.monday.com/boards/b1",
    columns: [{ id: "numbers_1", title: "Progress", type: "numbers" }],
    groups: [],
  })
  mocked.putMondayLink.mockResolvedValue({ link: makeLink(), warnings: [] })
  mocked.syncMondayNow.mockResolvedValue({ ok: true, pushed: true, itemsUpserted: 3 })
})

describe("MondaySetupWizard", () => {
  it("asks the AI to choose the board too — the user answers no questions to get a proposal", async () => {
    renderWizard()
    await scanToReview()

    // No boardId in the request is the whole point: the most ambiguous setup
    // decision is delegated rather than handed back to the user.
    expect(mocked.analyzeMondayMapping).toHaveBeenCalledWith("tok", "p1", {})
    expect(mocked.fetchMondayBoards).not.toHaveBeenCalled()
    expect(screen.getByText("Translation Tracker")).toBeTruthy()
    expect(screen.getByText(/its name matches the project/i)).toBeTruthy()
  })

  it("explains columns the server clamped away instead of silently dropping them", async () => {
    mocked.analyzeMondayMapping.mockResolvedValue(
      analysis({ warnings: ["column 'formula_1' is read-only (formula)"] }),
    )
    renderWizard()
    await scanToReview()

    // Without this the mapping looks arbitrary — the user can see a suitable
    // column on their board and no reason it went unused.
    expect(screen.getByText(/some columns were skipped/i)).toBeTruthy()
    expect(screen.getByText(/formula_1.*read-only/i)).toBeTruthy()
  })

  it("proves setup worked by pushing, and reports what landed", async () => {
    const { onLinked } = renderWizard()
    await scanToReview()

    fireEvent.click(screen.getByRole("button", { name: /apply and push/i }))
    await waitFor(() => expect(screen.getByTestId("monday-wizard-done")).toBeTruthy())

    expect(mocked.putMondayLink).toHaveBeenCalledWith("tok", "p1", {
      boardId: "b1",
      boardName: "Translation Tracker",
      config: { ...PROPOSAL, itemGranularity: "project", columns: PROPOSAL.columns },
    })
    // A link that pushes nothing is not "set up" — the push is part of Apply.
    expect(mocked.syncMondayNow).toHaveBeenCalledWith("tok", "p1")
    expect(onLinked).toHaveBeenCalled()
    expect(screen.getByText(/pushed 3 items/i)).toBeTruthy()
    expect(screen.getByRole("link", { name: /view board/i }).getAttribute("href")).toBe("https://actual-account.monday.com/boards/b1")
  })

  it("says so when the link saved but the first push failed", async () => {
    mocked.syncMondayNow.mockResolvedValue({
      ok: false,
      pushed: false,
      error: "board column was deleted",
    })
    renderWizard()
    await scanToReview()
    fireEvent.click(screen.getByRole("button", { name: /apply and push/i }))

    // Fail loud: reaching "done" with a silent failure would be a lie, and the
    // user would find out only when Monday stayed empty.
    await waitFor(() => expect(screen.getByText(/first push failed/i)).toBeTruthy())
    expect(screen.getByText(/board column was deleted/i)).toBeTruthy()
  })

  it("shows the server's link warnings, like the manual path, and hands them to the parent", async () => {
    const webhookWarning =
      "could not create Monday webhooks; board-structure changes will not be detected automatically"
    mocked.putMondayLink.mockResolvedValue({ link: makeLink(), warnings: [webhookWarning] })
    const { onLinked } = renderWizard()
    await scanToReview()
    fireEvent.click(screen.getByRole("button", { name: /apply and push/i }))

    // The push itself succeeded, so without the warning the dialog would say
    // "set up" while board changes are never detected.
    await waitFor(() => expect(screen.getByTestId("monday-wizard-link-warnings")).toBeTruthy())
    expect(screen.getByTestId("monday-wizard-link-warnings").textContent).toContain(webhookWarning)
    expect(screen.queryByText("Monday.com is set up")).toBeNull()
    expect(onLinked).toHaveBeenCalledWith(expect.objectContaining({ id: "l1" }), [webhookWarning])
  })

  it("claims nothing went wrong when the link route returned no warnings", async () => {
    renderWizard()
    await scanToReview()
    fireEvent.click(screen.getByRole("button", { name: /apply and push/i }))
    await waitFor(() => expect(screen.getByText("Monday.com is set up")).toBeTruthy())
    expect(screen.queryByTestId("monday-wizard-link-warnings")).toBeNull()
  })

  it("says on the review screen that items already on the board are reused, by the Aquilla ID column", async () => {
    mocked.analyzeMondayMapping.mockResolvedValue(
      analysis({ proposal: { ...PROPOSAL, matchExisting: { columnId: "text_aq" } } }),
    )
    mocked.fetchMondayBoardStructure.mockResolvedValue({
      columns: [
        { id: "numbers_1", title: "Progress", type: "numbers" },
        { id: "text_aq", title: "Aquilla ID", type: "text" },
      ],
      groups: [],
    })
    renderWizard()
    await scanToReview()
    expect(screen.getByTestId("monday-wizard-match-existing").textContent).toMatch(
      /reused, found by their Aquilla ID column/,
    )
    fireEvent.click(screen.getByRole("button", { name: /apply and push/i }))
    await waitFor(() => expect(mocked.putMondayLink).toHaveBeenCalled())
    expect(mocked.putMondayLink.mock.calls[0][2].config.matchExisting).toEqual({ columnId: "text_aq" })
  })

  it("warns on the review screen when a later setup would add copies", async () => {
    renderWizard()
    await scanToReview()
    expect(screen.getByTestId("monday-wizard-match-existing").textContent).toMatch(/Aquilla ID/)
    expect(screen.getByTestId("monday-wizard-match-existing").textContent).toMatch(/adds new items/)
  })

  it("undo removes the link the wizard just created", async () => {
    mocked.deleteMondayLink.mockResolvedValue(undefined)
    const { onUnlinked } = renderWizard()
    await scanToReview()
    fireEvent.click(screen.getByRole("button", { name: /apply and push/i }))
    await waitFor(() => expect(screen.getByTestId("monday-wizard-done")).toBeTruthy())

    fireEvent.click(screen.getByRole("button", { name: /undo/i }))
    await waitFor(() => expect(mocked.deleteMondayLink).toHaveBeenCalledWith("tok", "p1"))
    expect(onUnlinked).toHaveBeenCalled()
  })

  it("with no org connection it drives OAuth first rather than failing the scan", async () => {
    renderWizard({ orgConnected: false })

    expect(screen.getByRole("button", { name: /connect and scan/i })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /connect and scan/i }))

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^connect monday\.com$/i })).toBeTruthy(),
    )
    // No pointless analyze against an org that has no token.
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
    mocked.analyzeMondayMapping.mockRejectedValue(
      new api.MondayApiError("no boards found in this Monday account", 409),
    )
    renderWizard()

    fireEvent.click(screen.getByRole("button", { name: /scan and propose/i }))
    // Retrying can't conjure a board — the message has to name the fix.
    await waitFor(() => expect(screen.getByText(/create one in monday/i)).toBeTruthy())
  })

  it("drops a granularity-mismatched item-name template rather than shipping it", async () => {
    mocked.analyzeMondayMapping.mockResolvedValue(
      analysis({ proposal: { ...PROPOSAL, itemNameTemplate: "{projectName}" } }),
    )
    renderWizard()
    await scanToReview()

    fireEvent.click(screen.getByRole("button", { name: /customize data and columns/i }))
    await pickSelectOption(/board items/i, /one item per file/i)
    fireEvent.click(screen.getByRole("button", { name: /apply and push/i }))

    await waitFor(() => expect(mocked.putMondayLink).toHaveBeenCalled())
    const config = mocked.putMondayLink.mock.calls[0][2].config
    // Keeping "{projectName}" under file granularity would name every file item
    // identically — and matchExisting byName would fold them onto one board row.
    expect(config.itemGranularity).toBe("file")
    expect(config.itemNameTemplate).toBeUndefined()
  })

  it("keeps the user's row edits instead of applying the raw proposal", async () => {
    renderWizard()
    await scanToReview()

    fireEvent.click(screen.getByRole("button", { name: /customize data and columns/i }))
    fireEvent.click(screen.getByRole("button", { name: /remove mapping row/i }))
    // Nothing mapped means nothing to push — Apply must not be offered.
    await waitFor(() => {
      const apply = screen.getByRole("button", { name: /apply and push/i }) as HTMLButtonElement
      expect(apply.disabled).toBe(true)
    })
  })
})

it("does not call a skipped push successful", async () => {
  mocked.syncMondayNow.mockResolvedValue({ ok: true, pushed: false })
  renderWizard()
  await scanToReview()
  expect(screen.queryByRole("combobox", { name: /board items/i })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: /apply and push/i }))
  expect(await screen.findByRole("heading", { name: /sync needs attention/i })).toBeTruthy()
})

describe("Add the missing columns for me", () => {
  it("a board with nothing to map to: lists the missing columns, adds them, maps them, and Apply sends them", async () => {
    mocked.analyzeMondayMapping.mockResolvedValue(
      analysis({ proposal: { version: 1, itemGranularity: "project", columns: [] } }),
    )
    mocked.addMondayColumns.mockResolvedValue({
      created: [
        { metric: "completion_pct", columnId: "c1", columnType: "numbers", title: "Completion %" },
        { metric: "external_id", columnId: "c7", columnType: "text", title: "Aquilla ID" },
      ],
      reused: [{ metric: "validated_pct", columnId: "v0", columnType: "numbers", title: "Validated %" }],
      failed: [],
      structure: {
        columns: [
          { id: "c1", title: "Completion %", type: "numbers" },
          { id: "v0", title: "Validated %", type: "numbers" },
          { id: "c7", title: "Aquilla ID", type: "text" },
        ],
        groups: [],
      },
    })
    renderWizard()
    await scanToReview()

    const apply = screen.getByRole("button", { name: /apply and push/i }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    const block = screen.getByTestId("monday-missing-columns")
    expect(block.textContent).toMatch(/Completion %, Validated %, Audio validated %, Status, Last activity, Translators, Aquilla ID/)

    fireEvent.click(screen.getByRole("button", { name: /add the missing columns for me/i }))
    await waitFor(() => expect(mocked.addMondayColumns).toHaveBeenCalledTimes(1))
    expect(mocked.addMondayColumns.mock.calls[0][2]).toEqual({
      boardId: "b1",
      metrics: ["completion_pct", "validated_pct", "audio_validated_pct", "status_auto", "last_activity", "translators", "external_id"],
    })
    expect(await screen.findByText(/added 2 columns to the board and matched them/i)).toBeTruthy()

    await waitFor(() => expect(apply.disabled).toBe(false))
    fireEvent.click(apply)
    await waitFor(() => expect(mocked.putMondayLink).toHaveBeenCalled())
    expect(mocked.putMondayLink.mock.calls[0][2].config.columns).toEqual([
      { columnId: "v0", columnType: "numbers", metric: "validated_pct" },
      { columnId: "c1", columnType: "numbers", metric: "completion_pct" },
      { columnId: "c7", columnType: "text", metric: "external_id" },
    ])
  })

  it("is hidden when every suggested number already has a column", async () => {
    const metrics = ["completion_pct", "validated_pct", "audio_validated_pct", "status_auto", "last_activity", "translators", "external_id"] as const
    mocked.analyzeMondayMapping.mockResolvedValue(
      analysis({
        proposal: {
          version: 1,
          itemGranularity: "project",
          columns: metrics.map((metric, i) => ({ columnId: `x${i}`, columnType: "text", metric })),
        },
      }),
    )
    renderWizard()
    await scanToReview()
    expect(screen.queryByTestId("monday-missing-columns")).toBeNull()
  })

  it("names what Monday refused and leaves the button to try again", async () => {
    mocked.analyzeMondayMapping.mockResolvedValue(
      analysis({ proposal: { version: 1, itemGranularity: "project", columns: [] } }),
    )
    mocked.addMondayColumns.mockResolvedValue({
      created: [{ metric: "completion_pct", columnId: "c1", columnType: "numbers", title: "Completion %" }],
      reused: [],
      failed: [{ metric: "status_auto", title: "Status", error: "Complexity budget exhausted" }],
      structure: { columns: [{ id: "c1", title: "Completion %", type: "numbers" }], groups: [] },
    })
    renderWizard()
    await scanToReview()
    fireEvent.click(screen.getByRole("button", { name: /add the missing columns for me/i }))
    expect(await screen.findByText(/couldn't add: status\. monday said: complexity budget exhausted/i)).toBeTruthy()
    expect(screen.getByRole("button", { name: /add the missing columns for me/i })).toBeTruthy()
  })
})
