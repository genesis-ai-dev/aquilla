/**
 * AQU-365 — Tests that SelectionBar (the multi-select "dynamic island")
 * doesn't appear at all for a viewer / any role below every action it offers
 * (translate = contributor 400, validate = reviewer 300). Mirrors the
 * CommentsDrawer AQU-427 role-gating test pattern.
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { renderWithTooltips, expectTooltip } from "@/test-utils/tooltip"
import { SelectionBar } from "./SelectionBar"
import { emitCellValidate, emitCellUnvalidate, emitCellAudioValidate, emitCellAudioUnvalidate } from "@/lib/sync/events-emit"
import type { ProjectRecord } from "@/lib/parsers/types"
import { CellStore } from "@/hooks/useActiveCellStore"
import type { CellData } from "@/hooks/useCells"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { CellAuditStats } from "@/hooks/useCellsAuditStats"
import { ROLE } from "@/lib/frontier/roles"
import type { MemberScope } from "@/lib/sync/member-scopes"
import * as selectionModule from "@/lib/audio/selection"
import { toast } from "@/components/ui/toast"
import posthog from "@/lib/posthog"
import { BATCH_VALIDATE_ATTEMPTED } from "@/lib/event-names"

// AQU-1503: posthog-js is never init'd under happy-dom, so the real module's
// `capture` is not a spyable property. Stub the app's wrapper instead — these
// tests care that the batch-validate event FIRES, which is precisely what the
// surface could not previously prove.
vi.mock("@/lib/posthog", () => ({
  default: { capture: vi.fn(), opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn() },
}))
import { MAX_SELECTED } from "@/lib/audio/selection"
import type { AudioAttachmentOut, CellAudioEntry } from "@/lib/sync/cell-audio-read-types"

// AQU-616: mock the emit helpers so bulk validate/unvalidate clicks don't hit
// the real outbox/IDB, and so we can assert they fired alongside the new
// immediate-flush callback. Real exports are spread through for anything else.
vi.mock("@/lib/sync/events-emit", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/events-emit")>()),
  emitCellValidate: vi.fn(() => Promise.resolve("validate-event")),
  emitCellUnvalidate: vi.fn(() => Promise.resolve("unvalidate-event")),
  emitCellAudioValidate: vi.fn(() => Promise.resolve("audio-validate-event")),
  emitCellAudioUnvalidate: vi.fn(() => Promise.resolve("audio-unvalidate-event")),
}))

function makeProject(roleLevel: number | null): ProjectRecord {
  const base: ProjectRecord = {
    id: "proj-1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
  }
  if (roleLevel !== null) {
    return {
      ...base,
      syncRole: { level: roleLevel, name: "test", source: "server", fetchedAt: new Date().toISOString() },
    }
  }
  return base
}

function makeCell(over: Partial<CellData> = {}): CellData {
  return {
    id: "cell-1",
    fileId: "file-1",
    original: "Hello",
    translated: "",
    context: "GEN 1:1",
    group: "g1",
    type: "text",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    ...over,
  }
}

const CELLS = [makeCell({ id: "cell-1" }), makeCell({ id: "cell-2" })]

function makeRows(cells: CellData[]): CellRow[] {
  return cells.flatMap((cell, index) => {
    const canonicalRef = cell.context || cell.group || null
    const anchorCellId = index > 0 ? cells[index - 1].id : null
    return [
      {
        cellId: cell.id,
        side: "source",
        value: cell.original,
        valueHtml: cell.originalHtml ?? null,
        type: cell.type,
        canonicalRef,
        anchorCellId,
        eventId: `${cell.id}-source`,
        sourceEventId: null,
        lastEditor: null,
        lastEditAt: 1,
        validated: false,
        wordCount: cell.original.trim().split(/\s+/).filter(Boolean).length,
      },
      {
        cellId: cell.id,
        side: "target",
        value: cell.translated,
        valueHtml: cell.translatedHtml ?? null,
        type: cell.type,
        canonicalRef,
        anchorCellId,
        eventId: `${cell.id}-target`,
        sourceEventId: `${cell.id}-source`,
        // The viewer, unless a test says otherwise. Inert while the project
        // allows self-validation (the default); AQU-1571 tests switch it off.
        lastEditor: cell.lastEditor !== undefined ? cell.lastEditor : "alice",
        lastEditAt: 2,
        validated: false,
        aiDrafted: cell.aiDrafted ?? false,
        wordCount: cell.translated.trim().split(/\s+/).filter(Boolean).length,
      },
    ]
  })
}

// activeValidators reach the store through the auditStats map, keyed by cellId
// (see CellStore.getCellView). Mirror each cell's activeValidators there so a
// makeCell({ activeValidators: [...] }) override actually surfaces on the
// rendered CellData.
function makeAuditStats(cells: CellData[]): Map<string, CellAuditStats> {
  const stats = new Map<string, CellAuditStats>()
  for (const cell of cells) {
    if (cell.activeValidators.length === 0) continue
    stats.set(cell.id, {
      cellId: cell.id,
      editCount: 1,
      contentHash: "",
      lastEditAt: 2,
      lastEditEventId: `${cell.id}-target`,
      activeValidators: cell.activeValidators,
      waivers: [],
    })
  }
  return stats
}

function makeStore(cells: CellData[]): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: "proj-1",
    fileId: "file-1",
    username: "alice",
    requiredValidations: 1,
    auditStats: makeAuditStats(cells),
  })
  store.replaceRows(makeRows(cells), { full: true, maxServerSeq: 1 })
  return store
}

function renderBar(
  project: ProjectRecord,
  cells: CellData[] = CELLS,
  myScopes: MemberScope[] = [],
  activeLane = "",
  extra: Partial<React.ComponentProps<typeof SelectionBar>> = {},
) {
  return renderWithTooltips(
    <SelectionBar
      project={project}
      cellStore={makeStore(cells)}
      session={null}
      username="alice"
      activeLane={activeLane}
      myScopes={myScopes}
      completeBatch={vi.fn()}
      {...extra}
    />,
  )
}

// AQU-490: the file's audio, in the shape the workspace hands down. Until
// 2026-09-21 no test here passed it at all, which is why a suite of 30 stayed
// green over a button that could never appear.
function audioMap(over: Partial<AudioAttachmentOut> = {}): Map<string, CellAudioEntry> {
  const take: AudioAttachmentOut = {
    audioId: "take-1",
    url: "frontier-audio://take-1.webm",
    slot: "recording",
    mimeType: "audio/webm",
    voiceId: null,
    referenceAudioId: null,
    durationMs: 1000,
    label: null,
    trimStartMs: null,
    trimEndMs: null,
    role: "dub",
    validatorCount: 0,
    validators: [],
    recordedBy: "bob",
    ...over,
  }
  return new Map([["cell-1", {
    attachments: { [take.audioId]: take },
    selectedBySlot: { [take.slot]: take.audioId },
    selectedAudioId: take.audioId,
    selectedGeneratedVoiceAudioId: null,
    audioTimings: {},
  }]])
}

describe("SelectionBar — viewer suppression (AQU-365)", () => {
  it("renders nothing for VIEWER (100), even with a live selection", () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1", "cell-2"]))
    const { container } = renderBar(makeProject(ROLE.VIEWER))
    expect(container.firstChild).toBeNull()
    vi.restoreAllMocks()
  })

  it("renders nothing for a low unknown role (50)", () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1"]))
    const { container } = renderBar(makeProject(50))
    expect(container.firstChild).toBeNull()
    vi.restoreAllMocks()
  })

  it("renders the toolbar for REVIEWER (300) with a selection (can validate, not translate)", () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1", "cell-2"]))
    renderBar(makeProject(ROLE.REVIEWER))
    expect(screen.getByRole("toolbar", { name: "Selection actions" })).toBeInTheDocument()
    vi.restoreAllMocks()
  })

  it("renders the toolbar for CONTRIBUTOR (400) with a selection", () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1", "cell-2"]))
    renderBar(makeProject(ROLE.CONTRIBUTOR))
    expect(screen.getByRole("toolbar", { name: "Selection actions" })).toBeInTheDocument()
    vi.restoreAllMocks()
  })

  it("fails open (renders) for a local project with no syncRole", () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1", "cell-2"]))
    renderBar(makeProject(null))
    expect(screen.getByRole("toolbar", { name: "Selection actions" })).toBeInTheDocument()
    vi.restoreAllMocks()
  })

  it("renders nothing when there is no selection, regardless of role", () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set())
    const { container } = renderBar(makeProject(ROLE.CONTRIBUTOR))
    expect(container.firstChild).toBeNull()
    vi.restoreAllMocks()
  })
})

/**
 * Bulk Validate button state + disabled tooltip. The button is enabled only for
 * cells that are eligible AND not already validated by me; when nothing is
 * validatable the tooltip must name the *actual* reason (already validated /
 * untouched AI draft / no translation) rather than always blaming AI drafts.
 */
describe("SelectionBar — bulk Validate eligibility messaging", () => {
  function validateButton() {
    return screen.getByRole("button", { name: /^Validate text/i })
  }

  it("enables Validate for a translated, human-touched, not-yet-validated cell", async () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1"]))
    renderBar(makeProject(ROLE.CONTRIBUTOR), [makeCell({ id: "cell-1", translated: "bonjour" })])
    const btn = validateButton()
    expect(btn).toBeEnabled()
    await expectTooltip(btn, "Validate 1 cell")
    vi.restoreAllMocks()
  })

  it("AQU-633: disables Validate with an out-of-scope reason when the cell's file is not in the user's scope", async () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1"]))
    renderBar(
      makeProject(ROLE.CONTRIBUTOR),
      [makeCell({ id: "cell-1", fileId: "file-1", translated: "bonjour" })],
      [{ kind: "file", value: "some-other-file" }],
    )
    const btn = validateButton()
    expect(btn).toBeDisabled()
    await expectTooltip(btn, "Some selected cells are outside your assigned files or lanes")
    vi.restoreAllMocks()
  })

  it("AQU-633: still enables Validate when the cell's file IS in the user's scope", () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1"]))
    renderBar(
      makeProject(ROLE.CONTRIBUTOR),
      [makeCell({ id: "cell-1", fileId: "file-1", translated: "bonjour" })],
      [{ kind: "file", value: "file-1" }],
    )
    expect(validateButton()).toBeEnabled()
    vi.restoreAllMocks()
  })

  it("AQU-633: validates an in-scope non-default lane and carries that lane on the event", () => {
    vi.mocked(emitCellValidate).mockClear()
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1"]))
    renderBar(
      makeProject(ROLE.CONTRIBUTOR),
      [makeCell({ id: "cell-1", fileId: "file-1", translated: "bonjour" })],
      [{ kind: "lane", value: "fr" }],
      "fr",
    )

    fireEvent.click(validateButton())

    expect(emitCellValidate).toHaveBeenCalledWith(
      expect.objectContaining({ cellId: "cell-1", targetLang: "fr" }),
    )
    vi.restoreAllMocks()
  })

  it("disables with an 'already validated by you' reason when all selected are self-validated", async () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1"]))
    renderBar(makeProject(ROLE.CONTRIBUTOR), [
      makeCell({ id: "cell-1", translated: "bonjour", activeValidators: ["alice"] }),
    ])
    const btn = validateButton()
    expect(btn).toBeDisabled()
    await expectTooltip(btn, "All selected cells are already validated by you")
    vi.restoreAllMocks()
  })

  it("disables with the AI-draft reason for an untouched machine draft", async () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1"]))
    renderBar(makeProject(ROLE.CONTRIBUTOR), [
      makeCell({ id: "cell-1", translated: "auto draft", aiDrafted: true }),
    ])
    const btn = validateButton()
    expect(btn).toBeDisabled()
    await expectTooltip(btn, "Nothing eligible — untouched AI drafts require individual review")
    vi.restoreAllMocks()
  })

  it("says where an org can allow bulk validation of AI drafts", async () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1"]))
    renderBar(makeProject(ROLE.CONTRIBUTOR), [
      makeCell({ id: "cell-1", translated: "auto draft", aiDrafted: true }),
    ])
    await expectTooltip(validateButton(), "An organization maintainer can allow this under Settings → Project defaults.")
    vi.restoreAllMocks()
  })

  // Sam, 2026-10-01: an org may let bulk validation take untouched AI drafts.
  // Off is the test above; on, the same five drafts are offered and validated.
  it("offers and validates untouched AI drafts when the org allows it", async () => {
    vi.mocked(emitCellValidate).mockClear()
    const ids = ["d1", "d2", "d3", "d4", "d5"]
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(ids))
    const drafts = ids.map((id) => makeCell({ id, translated: `auto ${id}`, aiDrafted: true }))

    const off = renderBar(makeProject(ROLE.CONTRIBUTOR), drafts)
    expect(validateButton()).toBeDisabled()
    off.unmount()

    renderBar(makeProject(ROLE.CONTRIBUTOR), drafts, [], "", { allowBulkValidateAiDrafts: true })
    const btn = validateButton()
    expect(btn).toBeEnabled()
    expect(btn).toHaveTextContent(/Validate text\s*5/)
    await expectTooltip(btn, "Validate 5 cells")
    fireEvent.click(btn)
    expect(emitCellValidate).toHaveBeenCalledTimes(5)
    vi.restoreAllMocks()
  })

  it("keeps the other guards when the org allows AI drafts", async () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1"]))
    renderBar(
      makeProject(ROLE.CONTRIBUTOR),
      [makeCell({ id: "cell-1", translated: "auto draft", aiDrafted: true, activeValidators: ["alice"] })],
      [],
      "",
      { allowBulkValidateAiDrafts: true },
    )
    const btn = validateButton()
    expect(btn).toBeDisabled()
    await expectTooltip(btn, "All selected cells are already validated by you")
    vi.restoreAllMocks()
  })

  it("disables with a 'need a translation' reason for an untranslated cell", async () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1"]))
    renderBar(makeProject(ROLE.CONTRIBUTOR), [makeCell({ id: "cell-1", translated: "" })])
    const btn = validateButton()
    expect(btn).toBeDisabled()
    await expectTooltip(btn, "Selected cells need a translation first")
    vi.restoreAllMocks()
  })
})

/**
 * AQU-616 — bulk validate/unvalidate must flush the outbox immediately so the
 * confirmed/synced state lands promptly instead of waiting for the ~5s periodic
 * flusher. The SelectionBar signals this to the parent via onValidationCommitted
 * right after it enqueues its events.
 */
describe("SelectionBar — AQU-616 immediate flush on bulk validate", () => {
  function renderWithCommitted(
    onValidationCommitted: () => void,
    cells: CellData[],
    activeLane = "",
  ) {
    return render(
      <SelectionBar
        project={makeProject(ROLE.CONTRIBUTOR)}
        cellStore={makeStore(cells)}
        session={null}
        username="alice"
        activeLane={activeLane}
        myScopes={[]}
        completeBatch={vi.fn()}
        onValidationCommitted={onValidationCommitted}
      />,
    )
  }

  it("enqueues the validate AND fires onValidationCommitted so the parent flushes now", () => {
    vi.mocked(emitCellValidate).mockClear()
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1"]))
    const onValidationCommitted = vi.fn()
    renderWithCommitted(onValidationCommitted, [makeCell({ id: "cell-1", translated: "bonjour" })])

    fireEvent.click(screen.getByRole("button", { name: /^Validate text/i }))

    expect(emitCellValidate).toHaveBeenCalledTimes(1)
    expect(onValidationCommitted).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it("fires onValidationCommitted after a bulk 'Remove my text validations'", () => {
    vi.mocked(emitCellUnvalidate).mockClear()
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1"]))
    const onValidationCommitted = vi.fn()
    renderWithCommitted(
      onValidationCommitted,
      [makeCell({ id: "cell-1", translated: "bonjour", activeValidators: ["alice"] })],
      "fr",
    )

    fireEvent.click(screen.getByRole("button", { name: /Remove my text validations/i }))

    expect(emitCellUnvalidate).toHaveBeenCalledTimes(1)
    expect(emitCellUnvalidate).toHaveBeenCalledWith(
      expect.objectContaining({ cellId: "cell-1", targetLang: "fr" }),
    )
    expect(onValidationCommitted).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it("does NOT flush when nothing was eligible (button disabled, no emit)", () => {
    vi.mocked(emitCellValidate).mockClear()
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1"]))
    const onValidationCommitted = vi.fn()
    // Already self-validated → validatableCount 0 → Validate disabled.
    renderWithCommitted(onValidationCommitted, [
      makeCell({ id: "cell-1", translated: "bonjour", activeValidators: ["alice"] }),
    ])

    const btn = screen.getByRole("button", { name: /^Validate text/i })
    expect(btn).toBeDisabled()
    fireEvent.click(btn)

    expect(emitCellValidate).not.toHaveBeenCalled()
    expect(onValidationCommitted).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})

/**
 * AQU-1503 — the bulk validate must SAY what it did, including what it left
 * alone. The old loop reported exactly one class of skip ("already
 * validated"); an untouched AI draft, an out-of-scope cell or an unsaved edit
 * dropped out of the count with nothing said, so a user who selected five
 * cells and watched two change had no way to learn why.
 */
describe("SelectionBar — bulk Validate reports what it skipped (AQU-1503)", () => {
  function renderFor(cells: CellData[], myScopes: MemberScope[] = []) {
    return renderBar(makeProject(ROLE.CONTRIBUTOR), cells, myScopes, "", {
      onValidationCommitted: vi.fn(),
    })
  }

  it("validates the eligible cells and names EVERY reason the rest were skipped", () => {
    vi.mocked(emitCellValidate).mockClear()
    const added = vi.spyOn(toast, "add")
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(
      new Set(["ok-1", "ok-2", "draft", "empty", "mine"]),
    )
    renderFor([
      makeCell({ id: "ok-1", translated: "bonjour" }),
      makeCell({ id: "ok-2", translated: "salut" }),
      makeCell({ id: "draft", translated: "auto", aiDrafted: true }),
      makeCell({ id: "empty", translated: "" }),
      makeCell({ id: "mine", translated: "deja", activeValidators: ["alice"] }),
    ])

    fireEvent.click(screen.getByRole("button", { name: /^Validate text/i }))

    expect(emitCellValidate).toHaveBeenCalledTimes(2)
    const description = String(added.mock.calls.at(-1)?.[0].description ?? "")
    expect(description).toMatch(/untouched AI draft/i)
    expect(description).toMatch(/still needs? a translation/i)
    expect(description).toMatch(/already validated/i)
    added.mockRestore()
    vi.restoreAllMocks()
  })

  it("says nothing extra when every selected cell was validated", () => {
    vi.mocked(emitCellValidate).mockClear()
    const added = vi.spyOn(toast, "add")
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["ok-1"]))
    renderFor([makeCell({ id: "ok-1", translated: "bonjour" })])

    fireEvent.click(screen.getByRole("button", { name: /^Validate text/i }))

    const call = added.mock.calls.at(-1)?.[0]
    expect(call?.type).toBe("success")
    expect(call?.description).toBeUndefined()
    added.mockRestore()
    vi.restoreAllMocks()
  })

  it("reports every attempt to PostHog with its cell count and outcome", () => {
    vi.mocked(emitCellValidate).mockClear()
    const captured = vi.mocked(posthog.capture)
    captured.mockClear()
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["ok-1", "draft"]))
    renderFor([
      makeCell({ id: "ok-1", translated: "bonjour" }),
      makeCell({ id: "draft", translated: "auto", aiDrafted: true }),
    ])

    fireEvent.click(screen.getByRole("button", { name: /^Validate text/i }))

    // The surface used to emit NOTHING of its own, which is why the original
    // repro could only be argued from an absence of events.
    const batch = captured.mock.calls.find(([name]) => name === BATCH_VALIDATE_ATTEMPTED)
    expect(batch?.[1]).toMatchObject({
      source: "selection",
      outcome: "partial",
      validated_count: 1,
      skipped_ai_draft: 1,
    })
    vi.restoreAllMocks()
  })
})

/**
 * AQU-1572 — a bulk action is ONE `cell validated` / `cell unvalidated` event
 * carrying how many lines it changed, not one per line.
 */
describe("SelectionBar — validation telemetry (AQU-1572)", () => {
  const events = (name: string) => vi.mocked(posthog.capture).mock.calls.filter(([n]) => n === name)

  it("reports a bulk text validation once, counting only what it validated", async () => {
    vi.mocked(posthog.capture).mockClear()
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["ok-1", "ok-2", "draft"]))
    renderBar(makeProject(ROLE.CONTRIBUTOR), [
      makeCell({ id: "ok-1", translated: "bonjour" }),
      makeCell({ id: "ok-2", translated: "salut" }),
      makeCell({ id: "draft", translated: "auto", aiDrafted: true }),
    ], [], "fr", { onValidationCommitted: vi.fn() })

    fireEvent.click(screen.getByRole("button", { name: /^Validate text/i }))

    // Reported once the writes reach the outbox, not at the click.
    await vi.waitFor(() => expect(events("cell validated")).toHaveLength(1))
    expect(events("cell validated")[0][1]).toMatchObject({
      medium: "text", source: "ui", surface: "selection", cell_count: 2, lane: "fr",
    })
    vi.restoreAllMocks()
  })

  it("reports a bulk removal as one cell unvalidated", async () => {
    vi.mocked(posthog.capture).mockClear()
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1"]))
    renderBar(makeProject(ROLE.CONTRIBUTOR), [
      makeCell({ id: "cell-1", translated: "bonjour", activeValidators: ["alice"] }),
    ], [], "", { onValidationCommitted: vi.fn() })

    fireEvent.click(screen.getByRole("button", { name: /Remove my text validations/i }))

    await vi.waitFor(() => expect(events("cell unvalidated")).toHaveLength(1))
    expect(events("cell unvalidated")[0][1]).toMatchObject({ medium: "text", cell_count: 1, lane: "default" })
    vi.restoreAllMocks()
  })

  it("reports a bulk audio vote as one event with the audio medium", async () => {
    vi.mocked(posthog.capture).mockClear()
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1", "cell-2"]))
    renderBar(makeProject(ROLE.REVIEWER), CELLS, [], "", { audioByCellId: audioMap() })

    fireEvent.click(screen.getByRole("button", { name: /^validate audio/i }))

    await vi.waitFor(() => expect(events("cell validated")).toHaveLength(1))
    expect(events("cell validated")[0][1]).toMatchObject({ medium: "audio", surface: "selection" })
    vi.restoreAllMocks()
  })
})

// ---------------------------------------------------------------------------
// AQU-490 — bulk validating recordings
// ---------------------------------------------------------------------------

describe("SelectionBar — Validate recordings", () => {
  const selectBoth = () =>
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1", "cell-2"]))

  it("offers the action, with a count, when the selection holds a validatable take", () => {
    selectBoth()
    renderBar(makeProject(ROLE.REVIEWER), CELLS, [], "", { audioByCellId: audioMap() })
    const button = screen.getByRole("button", { name: /^validate audio/i })
    expect(button).toBeEnabled()
    expect(button).toHaveTextContent("1")
    vi.restoreAllMocks()
  })

  // Sam's call, 2026-09-21: the Audio view is where recordings are worked on,
  // so this is the one validation that view offers. It used to sit inside the
  // text-only branch, which made it unreachable there.
  it("offers it in the Audio view too, where the text actions do not appear", () => {
    selectBoth()
    renderBar(makeProject(ROLE.REVIEWER), CELLS, [], "", { audioByCellId: audioMap(), audioMode: true })
    expect(screen.getByRole("button", { name: /^validate audio/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^validate$/i })).toBeNull()
    vi.restoreAllMocks()
  })

  // A FILE with no audio shows no audio buttons at all, so a text-only project
  // never grows two controls it can do nothing with. This is the only case
  // where they are absent.
  it("shows neither audio button on a file with no recordings", () => {
    selectBoth()
    renderBar(makeProject(ROLE.REVIEWER), CELLS, [], "", { audioByCellId: new Map() })
    expect(screen.queryByRole("button", { name: /^validate audio/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /remove my audio validations/i })).toBeNull()
    vi.restoreAllMocks()
  })

  // THE REPORTED BUG. Validating everything used to make the button vanish —
  // the very click that emptied it also hid the way back. It now stays put and
  // goes dark, with its opposite lighting up (Sam, 2026-09-22).
  it("stays visible but disabled once every take already carries my vote", () => {
    selectBoth()
    renderBar(makeProject(ROLE.REVIEWER), CELLS, [], "", {
      audioByCellId: audioMap({ validatorCount: 1, validators: ["alice"] }),
    })
    const validate = screen.getByRole("button", { name: /^validate audio/i })
    expect(validate).toBeDisabled()
    expect(validate).not.toHaveTextContent("1")
    const remove = screen.getByRole("button", { name: /remove my audio validations/i })
    expect(remove).toBeEnabled()
    expect(remove).toHaveTextContent("1")
    vi.restoreAllMocks()
  })

  it("offers the opposite action only when I have a vote to take back", () => {
    selectBoth()
    renderBar(makeProject(ROLE.REVIEWER), CELLS, [], "", { audioByCellId: audioMap() })
    expect(screen.getByRole("button", { name: /remove my audio validations/i })).toBeDisabled()
    vi.restoreAllMocks()
  })

  // Somebody else's vote is not mine to withdraw.
  it("will not offer to remove a validation that is not mine", () => {
    selectBoth()
    renderBar(makeProject(ROLE.REVIEWER), CELLS, [], "", {
      audioByCellId: audioMap({ validatorCount: 1, validators: ["bob"] }),
    })
    expect(screen.getByRole("button", { name: /remove my audio validations/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /^validate audio/i })).toBeEnabled()
    vi.restoreAllMocks()
  })

  // Sam, 2026-09-30: in a dubbing file the selected lines' takes live on the
  // heard lines performing them, so a selection of subtitle lines found none
  // and the audio buttons never appeared.
  it("finds the takes on the heard lines performing the selected lines, once each", async () => {
    selectBoth()
    vi.mocked(emitCellAudioValidate).mockClear()
    const heard = {
      ...makeCell({ id: "cue-a" }),
      fileId: "cue-file",
      attachments: {
        "take-c": { slot: "recording", role: "dub", validatorCount: 0, validators: [], recordedBy: "bob" },
      },
      selectedAudioId: "take-c",
    } as unknown as CellData
    // One heard line performing BOTH selected lines: one take, one vote.
    const linked = new Map([
      ["cell-1", [{ cell: heard, sharedWith: 2, hasTake: true, performs: ["cell-1", "cell-2"], partOfSplit: false }]],
      ["cell-2", [{ cell: heard, sharedWith: 2, hasTake: true, performs: ["cell-1", "cell-2"], partOfSplit: false }]],
    ])
    renderBar(makeProject(ROLE.REVIEWER), CELLS, [], "", { audioByCellId: new Map(), linkedTakesByCell: linked })
    const button = screen.getByRole("button", { name: /^validate audio/i })
    expect(button).toHaveTextContent("1")
    fireEvent.click(button)
    await vi.waitFor(() => expect(emitCellAudioValidate).toHaveBeenCalledTimes(1))
    expect(emitCellAudioValidate).toHaveBeenCalledWith(expect.objectContaining({
      fileId: "cue-file", cellId: "cue-a", audioId: "take-c",
    }))
    vi.restoreAllMocks()
  })

  it("withdraws my vote and says how many it took back", async () => {
    selectBoth()
    renderBar(makeProject(ROLE.REVIEWER), CELLS, [], "", {
      audioByCellId: audioMap({ validatorCount: 1, validators: ["alice"] }),
    })
    fireEvent.click(screen.getByRole("button", { name: /remove my audio validations/i }))
    await vi.waitFor(() => expect(emitCellAudioUnvalidate).toHaveBeenCalledTimes(1))
    expect(emitCellAudioUnvalidate).toHaveBeenCalledWith(expect.objectContaining({
      cellId: "cell-1", audioId: "take-1", author: "alice",
    }))
    // No lane and no target user: a recording is shared by every language, and
    // an absent target means "my own vote".
    const arg = vi.mocked(emitCellAudioUnvalidate).mock.calls[0][0] as unknown as Record<string, unknown>
    expect(arg).not.toHaveProperty("targetLang")
    expect(arg).not.toHaveProperty("targetUsername")
    vi.restoreAllMocks()
  })
})

/**
 * AQU-1459 — the selection bar's Translate must ask the SAME permission the
 * commit asks, and ask it BEFORE the model is called.
 *
 * A validator (Reviewer 300) passes the `cell.validate` check that keeps the
 * whole bar on screen, so the bar stayed up and Translate stayed live for
 * them. Clicking it called `completeBatch` — real tokens — and only then did
 * `commitCompletedCells` refuse every draft with "You do not have permission
 * to commit target cells". This suite is the guard: for a role below the
 * `target.cell.commit` floor the button is disabled, the tooltip names the
 * permission rather than a post-hoc commit failure, and `completeBatch` is
 * never called; the reviewer actions on the same bar are untouched.
 */
describe("SelectionBar — Translate is gated on target.cell.commit (AQU-1459)", () => {
  function translateButton() {
    return screen.getByRole("button", { name: /^Translate/i })
  }

  /** Untranslated cells: Translate would otherwise be enabled with a count. */
  const UNTRANSLATED = [
    makeCell({ id: "cell-1", translated: "" }),
    makeCell({ id: "cell-2", translated: "" }),
  ]

  it("disables Translate for a REVIEWER (300) who cannot commit target cells", async () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1", "cell-2"]))
    renderBar(makeProject(ROLE.REVIEWER), UNTRANSLATED)
    const btn = translateButton()
    expect(btn).toBeDisabled()
    await expectTooltip(btn, "You need contributor role to draft translations")
    vi.restoreAllMocks()
  })

  it("never calls the model for a REVIEWER, even on a full 20-cell selection", () => {
    const cells = Array.from({ length: MAX_SELECTED }, (_, i) =>
      makeCell({ id: `cell-${i + 1}`, translated: "" }),
    )
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(
      new Set(cells.map((c) => c.id)),
    )
    const completeBatch = vi.fn()
    renderBar(makeProject(ROLE.REVIEWER), cells, [], "", { completeBatch })

    fireEvent.click(translateButton())

    expect(completeBatch).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it("leaves the reviewer's own validate actions alone", () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1"]))
    renderBar(makeProject(ROLE.REVIEWER), [makeCell({ id: "cell-1", translated: "bonjour" })])
    expect(screen.getByRole("button", { name: /^Validate text/i })).toBeEnabled()
    expect(screen.getByRole("button", { name: /remove my text validations/i })).toBeDisabled()
    vi.restoreAllMocks()
  })

  it("still runs Translate for a CONTRIBUTOR (400), who can commit", () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1", "cell-2"]))
    const completeBatch = vi.fn()
    renderBar(makeProject(ROLE.CONTRIBUTOR), UNTRANSLATED, [], "", { completeBatch })
    const btn = translateButton()
    expect(btn).toBeEnabled()

    fireEvent.click(btn)

    expect(completeBatch).toHaveBeenCalledTimes(1)
    expect(completeBatch.mock.calls[0][0]).toHaveLength(2)
    vi.restoreAllMocks()
  })

  it("fails open for a local project with no syncRole", () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["cell-1", "cell-2"]))
    const completeBatch = vi.fn()
    renderBar(makeProject(null), UNTRANSLATED, [], "", { completeBatch })
    expect(translateButton()).toBeEnabled()

    fireEvent.click(translateButton())

    expect(completeBatch).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })
})

describe("SelectionBar — a write that never queued is not counted (AQU-1572)", () => {
  it("leaves a failed enqueue out of the event", async () => {
    vi.mocked(posthog.capture).mockClear()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.mocked(emitCellValidate)
      .mockImplementationOnce(() => Promise.resolve("ok"))
      .mockImplementationOnce(() => Promise.reject(new Error("idb full")))
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["ok-1", "ok-2"]))
    renderBar(makeProject(ROLE.CONTRIBUTOR), [
      makeCell({ id: "ok-1", translated: "bonjour" }),
      makeCell({ id: "ok-2", translated: "salut" }),
    ], [], "", { onValidationCommitted: vi.fn() })

    fireEvent.click(screen.getByRole("button", { name: /^Validate text/i }))

    await vi.waitFor(() => expect(
      vi.mocked(posthog.capture).mock.calls.filter(([n]) => n === "cell validated"),
    ).toHaveLength(1))
    const [, props] = vi.mocked(posthog.capture).mock.calls.find(([n]) => n === "cell validated")!
    expect(props).toMatchObject({ cell_count: 1 })
    warn.mockRestore()
    vi.restoreAllMocks()
  })
})

/**
 * AQU-1571 — the server refuses a text vote on the caller's own latest change
 * when the project switched "Allow self-validation" off, and any vote from a
 * reader the project's minimum role or named-validator list excludes. Both
 * used to come back as a red "failed" banner after a bulk run; the bar now
 * leaves those lines alone and says so.
 */
describe("SelectionBar — the project's text validation rules (AQU-1571)", () => {
  const strict = (level: number = ROLE.CONTRIBUTOR, over: Partial<ProjectRecord> = {}) =>
    ({ ...makeProject(level), allowSelfValidation: false, ...over })
  const validateButton = () => screen.getByRole("button", { name: /^Validate text/i })

  it("counts and validates only the lines somebody else changed last", () => {
    vi.mocked(emitCellValidate).mockClear()
    const added = vi.spyOn(toast, "add")
    const captured = vi.mocked(posthog.capture)
    captured.mockClear()
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["theirs", "own-1", "own-2"]))
    renderBar(strict(), [
      makeCell({ id: "theirs", translated: "bonjour", lastEditor: "bob" }),
      makeCell({ id: "own-1", translated: "salut", lastEditor: "alice" }),
      makeCell({ id: "own-2", translated: "coucou", lastEditor: "alice" }),
    ], [], "", { onValidationCommitted: vi.fn() })

    expect(validateButton()).toHaveTextContent(/1$/)
    fireEvent.click(validateButton())

    expect(emitCellValidate).toHaveBeenCalledTimes(1)
    expect(emitCellValidate).toHaveBeenCalledWith(expect.objectContaining({ cellId: "theirs" }))
    const description = String(added.mock.calls.at(-1)?.[0].description ?? "")
    expect(description).toContain("2 have your latest change, so someone else must validate them")
    const batch = captured.mock.calls.find(([name]) => name === BATCH_VALIDATE_ATTEMPTED)
    expect(batch?.[1]).toMatchObject({ outcome: "partial", validated_count: 1, skipped_own_edit: 2 })
    added.mockRestore()
    vi.restoreAllMocks()
  })

  it("disables Validate with the own-change reason when every line is the reader's", async () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["own-1", "own-2"]))
    renderBar(strict(), [
      makeCell({ id: "own-1", translated: "salut", lastEditor: "alice" }),
      makeCell({ id: "own-2", translated: "coucou", lastEditor: "alice" }),
    ])
    expect(validateButton()).toBeDisabled()
    await expectTooltip(validateButton(), "You made the latest change to these cells, so someone else must validate them")
    vi.restoreAllMocks()
  })

  // The reader's own AI draft is refused one at a time too, so "review it
  // individually" would be the wrong advice.
  it("names the own change, not the AI-draft rule, for the reader's own draft", async () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["own-draft"]))
    renderBar(strict(), [makeCell({ id: "own-draft", translated: "auto", aiDrafted: true, lastEditor: "alice" })])
    expect(validateButton()).toBeDisabled()
    await expectTooltip(validateButton(), "You made the latest change to these cells, so someone else must validate them")
    vi.restoreAllMocks()
  })

  it("validates the reader's own lines when the project allows it", () => {
    vi.mocked(emitCellValidate).mockClear()
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["own-1"]))
    renderBar(strict(ROLE.CONTRIBUTOR, { allowSelfValidation: true }), [
      makeCell({ id: "own-1", translated: "salut", lastEditor: "alice" }),
    ], [], "", { onValidationCommitted: vi.fn() })
    fireEvent.click(validateButton())
    expect(emitCellValidate).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it("never treats a line with no known editor as the reader's", () => {
    vi.mocked(emitCellValidate).mockClear()
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["old"]))
    renderBar(strict(), [makeCell({ id: "old", translated: "salut", lastEditor: null })], [], "", {
      onValidationCommitted: vi.fn(),
    })
    fireEvent.click(validateButton())
    expect(emitCellValidate).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it("tells a reader below the project's minimum role that their role cannot validate here", async () => {
    vi.mocked(emitCellValidate).mockClear()
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["theirs"]))
    renderBar(strict(ROLE.CONTRIBUTOR, { validationRoleFloor: "project_lead" }), [
      makeCell({ id: "theirs", translated: "bonjour", lastEditor: "bob" }),
    ])
    expect(validateButton()).toBeDisabled()
    await expectTooltip(validateButton(), "Your role cannot validate cells in this project.")
    fireEvent.click(validateButton())
    expect(emitCellValidate).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it("does the same for a reader left off the named-validator list", async () => {
    vi.spyOn(selectionModule, "useSelectedIds").mockReturnValue(new Set(["theirs"]))
    renderBar(strict(ROLE.PROJECT_LEAD, { validationNamedUsers: ["bob"] }), [
      makeCell({ id: "theirs", translated: "bonjour", lastEditor: "bob" }),
    ])
    expect(validateButton()).toBeDisabled()
    await expectTooltip(validateButton(), "Your role cannot validate cells in this project.")
    vi.restoreAllMocks()
  })
})
