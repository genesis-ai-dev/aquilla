/**
 * AQU-983: the file modal is where a reviewer chooses to include untouched
 * AI drafts, and where a contributor is told they cannot.
 *
 * AQU-2507: and where they choose to overrule open check flags, and are told
 * the one click finishes the file rather than a batch of it.
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { WHOLE_BOOK } from "@/lib/review/batch-scope"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import type { BatchValidateCandidate } from "@/lib/review/batch-validate-summary"
import { BatchFileModal } from "./BatchFileModal"

const baseOptions = {
  username: "me",
  myScopes: [],
  activeLane: "fr",
  hasTarget: true,
  canValidate: true,
}

function cell(over: Partial<BatchValidateCandidate> = {}): BatchValidateCandidate {
  return {
    id: "c1",
    fileId: "f1",
    translated: "bonjour",
    targetEventId: "e1",
    ...over,
  }
}

function renderModal(overrides: Partial<Parameters<typeof BatchFileModal>[0]> = {}) {
  const onConfirmValidate = vi.fn()
  const onConfirmDraft = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <I18nProvider>
      <BatchFileModal
        open
        onOpenChange={onOpenChange}
        request={{ kind: "validate" }}
        batchSize={10}
        chunkSize={500}
        canIncludeUntouchedAi
        validateCandidates={[
          cell({ id: "human" }),
          cell({ id: "ai", aiDrafted: true }),
          cell({ id: "second", aiDrafted: true, activeValidators: ["joy"] }),
        ]}
        validateOptions={baseOptions}
        draftCells={[]}
        onConfirmValidate={onConfirmValidate}
        onConfirmDraft={onConfirmDraft}
        {...overrides}
      />
    </I18nProvider>,
  )
  return { onConfirmValidate, onConfirmDraft, onOpenChange }
}

describe("BatchFileModal — validation", () => {
  it("leaves untouched AI drafts out until a reviewer includes them, and keeps a second pass in the ready set", async () => {
    const user = userEvent.setup()
    const { onConfirmValidate } = renderModal()
    expect(screen.getByRole("checkbox", { name: "Include unvalidated cells" })).toBeChecked()
    expect(screen.getByText("2 cells you have not signed off.")).toBeInTheDocument()
    const ai = screen.getByRole("checkbox", { name: /1 unvalidated AI draft/ })
    expect(ai).not.toBeChecked()
    expect(screen.getByText("Validate 2 cells?")).toBeInTheDocument()
    expect(screen.queryByText(/can be batch-validated/)).toBeNull()
    expect(screen.queryByText(/left for individual review/)).toBeNull()
    expect(screen.queryByText(/Skipped \d+ cells/)).toBeNull()
    await user.click(screen.getByRole("button", { name: "Validate text cells" }))
    expect(onConfirmValidate).toHaveBeenCalledWith({
      includeReadyCells: true,
      includeUntouchedAiDrafts: false,
      includeFlaggedCells: false,
      chapter: WHOLE_BOOK,
    })
  })

  it("sends the AI drafts when a reviewer turns that option on", async () => {
    const user = userEvent.setup()
    const { onConfirmValidate } = renderModal()
    await user.click(screen.getByRole("checkbox", { name: /1 unvalidated AI draft/ }))
    await user.click(screen.getByRole("button", { name: "Validate text cells" }))
    expect(onConfirmValidate).toHaveBeenCalledWith({
      includeReadyCells: true,
      includeUntouchedAiDrafts: true,
      includeFlaggedCells: false,
      chapter: WHOLE_BOOK,
    })
  })

  it("keeps a contributor from bulk-validating untouched AI drafts", async () => {
    const user = userEvent.setup()
    const { onConfirmValidate } = renderModal({ canIncludeUntouchedAi: false })
    const ai = screen.getByRole("checkbox", { name: /1 unvalidated AI draft/ })
    expect(ai).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByText(/one at a time/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Validate text cells" }))
    expect(onConfirmValidate).toHaveBeenCalledWith({
      includeReadyCells: true,
      includeUntouchedAiDrafts: false,
      includeFlaggedCells: false,
      chapter: WHOLE_BOOK,
    })
  })
})

/**
 * AQU-2507. Anita Beniston imported five pretranslated books whose text was
 * approved outside Aquilla; the point of validating them wholesale is to let
 * Living Memory learn from them. Two things had to be true of this dialog:
 * mechanical check flags must be overrulable in bulk BY CHOICE, and the dialog
 * must not imply a second click.
 */
describe("BatchFileModal — open check flags (AQU-2507)", () => {
  const flagged = (ids: string[]) => ({
    ...baseOptions,
    hasOpenFlags: (cellId: string) => ids.includes(cellId),
  })

  const namedFlag = [
    cell({ id: "human", group: "GEN 2:5" }),
    cell({ id: "ai", aiDrafted: true }),
    cell({ id: "second", aiDrafted: true, activeValidators: ["joy"] }),
  ]

  it("lists every flagged cell under the unresolved-checks choice and leaves them out of the run", async () => {
    const user = userEvent.setup()
    renderModal({
      validateOptions: flagged(["human"]),
      validateCandidates: namedFlag,
      flagIssue: (id) => id === "human" ? "Number integrity — Number from source missing in translation" : undefined,
    })
    const box = screen.getByRole("checkbox", { name: "Include cells with unresolved checks" })
    expect(box).not.toBeChecked()
    expect(screen.getByText("These cells are flagged based on your project checks and rules.")).toBeInTheDocument()
    expect(screen.queryByRole("listitem")).toBeNull()
    await user.click(screen.getByRole("button", { name: "Show 1 flagged cell" }))
    const row = screen.getByRole("listitem")
    expect(row).toHaveTextContent("GEN 2:5")
    expect(row).toHaveTextContent("Number from source missing in translation")
    expect(screen.getByRole("checkbox", { name: "Include unvalidated cells" })).toBeChecked()
    expect(screen.getByText("Validate 1 cell?")).toBeInTheDocument()
  })

  it("adds them to the run, and records the choice, when the reader ticks the box", async () => {
    const user = userEvent.setup()
    const { onConfirmValidate } = renderModal({
      validateOptions: flagged(["human"]),
      validateCandidates: namedFlag,
    })
    await user.click(screen.getByRole("checkbox", { name: "Include cells with unresolved checks" }))
    expect(screen.getByText("Validate 2 cells?")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Validate text cells" }))
    expect(onConfirmValidate).toHaveBeenCalledWith({
      includeReadyCells: true,
      includeUntouchedAiDrafts: false,
      includeFlaggedCells: true,
      chapter: WHOLE_BOOK,
    })
  })

  it("shows no flag box on a file nothing has flagged", () => {
    renderModal()
    expect(screen.queryByRole("checkbox", { name: "Include cells with unresolved checks" })).toBeNull()
  })
})

describe("BatchFileModal — the run finishes the file (AQU-2507)", () => {
  it("says nothing about batches when one batch covers the file", () => {
    renderModal()
    expect(screen.queryByText(/keeps going until the file is done/)).toBeNull()
    expect(screen.queryByText(/left for the next run/)).toBeNull()
  })

  it("promises completion, not another click, when the run takes several batches", () => {
    renderModal({ chunkSize: 1 })
    // Two eligible cells, one per batch: the dialog states the whole count and
    // explains how it gets there. It must NEVER read "run again to continue" —
    // the reported defect was five books' worth of re-clicking.
    expect(screen.getByText("Validate 2 cells?")).toBeInTheDocument()
    expect(screen.getByText(/keeps going until the file is done/)).toBeInTheDocument()
    expect(screen.queryByText(/run again to continue/)).toBeNull()
    expect(screen.queryByText(/At most/)).toBeNull()
  })
})

describe("BatchFileModal — drafting", () => {
  it("drafts empty cells by default and can add a refresh of untouched AI drafts", async () => {
    const user = userEvent.setup()
    const { onConfirmDraft } = renderModal({
      request: { kind: "draft", scope: "all" },
      draftCells: [
        { translated: "", original: "In the beginning" },
        { translated: "", original: "God created" },
        { translated: "Au commencement", original: "In the beginning", aiDrafted: true },
        { translated: "Dieu créa", original: "God created", aiDrafted: false },
      ],
    })
    expect(screen.getByRole("checkbox", { name: /2 empty cells/ })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: /1 untouched AI draft/ })).not.toBeChecked()
    expect(screen.getByText(/1 cell a person already translated/)).toBeInTheDocument()
    expect(screen.getByText(/This drafts 2 cells/)).toBeInTheDocument()
    await user.click(screen.getByRole("checkbox", { name: /1 untouched AI draft/ }))
    expect(screen.getByText(/This drafts 3 cells/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Draft" }))
    expect(onConfirmDraft).toHaveBeenCalledWith({
      includeEmpty: true,
      refreshAiDrafts: true,
      scope: "all",
      batchSize: 10,
      chapter: WHOLE_BOOK,
    })
  })

  it("opens a next-package run on the next scope", () => {
    renderModal({
      request: { kind: "draft", scope: "next" },
      batchSize: 1,
      draftCells: [
        { translated: "", original: "a" },
        { translated: "", original: "b" },
        { translated: "", original: "c" },
      ],
    })
    expect(screen.getByRole("radio", { name: "Next 1" })).toBeChecked()
    expect(screen.getByText(/This drafts 1 cell/)).toBeInTheDocument()
  })
})

describe("BatchFileModal — nothing checked", () => {
  it("drops the empty-run sentence and keeps the plain title", async () => {
    const user = userEvent.setup()
    renderModal({
      chapters: ["GEN 1"],
      initialChapter: "GEN 1",
      validateCandidates: [
        cell({ id: "a", group: "GEN 1:1", activeValidators: ["me"] }),
        cell({ id: "b", group: "GEN 1:2" }),
      ],
    })
    expect(screen.getByText("Validate 1 cell?")).toBeInTheDocument()
    await user.click(screen.getByRole("checkbox", { name: "Include unvalidated cells" }))
    expect(screen.getByText("Batch validate this file")).toBeInTheDocument()
    expect(screen.queryByText(/can be batch-validated/)).toBeNull()
    expect(screen.queryByText(/you left unchecked/)).toBeNull()
    expect(screen.queryByText(/you had already validated/)).toBeNull()
    expect(screen.queryByRole("button", { name: "Validate text cells" })).toBeNull()
  })
})

describe("BatchFileModal — a chapter with nothing left to validate", () => {
  it("says so in the results area instead of an empty include list", () => {
    renderModal({
      bookName: "Berean Standard Bible (BSB)",
      chapters: ["GEN 1", "GEN 2"],
      initialChapter: "GEN 1",
      validateCandidates: [
        cell({ id: "a", group: "GEN 1:1", activeValidators: ["me"] }),
        cell({ id: "b", group: "GEN 1:2", activeValidators: ["me"] }),
      ],
    })
    const status = screen.getByRole("status")
    expect(status).toHaveTextContent("Nothing to validate in GEN 1")
    expect(status).toHaveTextContent("All 2 cells here are already validated.")
    expect(screen.queryByText("What this run includes")).toBeNull()
    expect(screen.queryByRole("button", { name: "Validate text cells" })).toBeNull()
  })
})

describe("BatchFileModal — chapter of the open book", () => {
  it("opens on the chapter in view and can widen to the whole book", async () => {
    const user = userEvent.setup()
    const { onConfirmValidate } = renderModal({
      bookName: "Genesis",
      chapters: ["GEN 1", "GEN 2"],
      initialChapter: "GEN 2",
      validateCandidates: [
        cell({ id: "a", group: "GEN 1:1" }),
        cell({ id: "b", group: "GEN 2:1" }),
        cell({ id: "c", group: "GEN 2:2" }),
      ],
    })
    expect(screen.getByText("Genesis")).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Chapter" })).toHaveTextContent("GEN 2")
    expect(screen.getByText("2 cells you have not signed off.")).toBeInTheDocument()
    await user.click(screen.getByRole("combobox", { name: "Chapter" }))
    await user.click(await screen.findByRole("option", { name: "Whole book" }))
    expect(screen.getByRole("combobox", { name: "Chapter" })).toHaveTextContent("Whole book")
    expect(screen.getByText("3 cells you have not signed off.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Validate text cells" }))
    expect(onConfirmValidate).toHaveBeenCalledWith(expect.objectContaining({ chapter: WHOLE_BOOK }))
  })

  it("mounts a window of a whole-Bible chapter list", async () => {
    const user = userEvent.setup()
    const chapters = Array.from({ length: 1200 }, (_, index) => `CH ${index + 1}`)
    renderModal({ chapters, initialChapter: "CH 1", validateCandidates: [] })
    await user.click(screen.getByRole("combobox", { name: "Chapter" }))
    const options = await screen.findAllByRole("option")
    expect(options.length).toBeLessThan(80)
    expect(screen.getByRole("option", { name: "CH 1" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: "CH 1200" })).toBeNull()
    expect(screen.queryByRole("option", { name: "Whole book" })).toBeNull()
  })
})
