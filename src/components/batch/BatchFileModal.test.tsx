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
    expect(screen.getByRole("checkbox", { name: /2 cells ready for your check/ })).toBeChecked()
    const ai = screen.getByRole("checkbox", { name: /1 AI draft nobody has checked/ })
    expect(ai).not.toBeChecked()
    expect(screen.getByText(/left for individual review/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Validate text" }))
    expect(onConfirmValidate).toHaveBeenCalledWith({
      includeReadyCells: true,
      includeUntouchedAiDrafts: false,
      includeFlaggedCells: false,
    })
  })

  it("sends the AI drafts when a reviewer turns that option on", async () => {
    const user = userEvent.setup()
    const { onConfirmValidate } = renderModal()
    await user.click(screen.getByRole("checkbox", { name: /1 AI draft nobody has checked/ }))
    await user.click(screen.getByRole("button", { name: "Validate text" }))
    expect(onConfirmValidate).toHaveBeenCalledWith({
      includeReadyCells: true,
      includeUntouchedAiDrafts: true,
      includeFlaggedCells: false,
    })
  })

  it("keeps a contributor from bulk-validating untouched AI drafts", async () => {
    const user = userEvent.setup()
    const { onConfirmValidate } = renderModal({ canIncludeUntouchedAi: false })
    const ai = screen.getByRole("checkbox", { name: /1 AI draft nobody has checked/ })
    expect(ai).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByText(/one at a time/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Validate text" }))
    expect(onConfirmValidate).toHaveBeenCalledWith({
      includeReadyCells: true,
      includeUntouchedAiDrafts: false,
      includeFlaggedCells: false,
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

  it("counts flagged cells in their own box, leaves it off, and keeps them out of the promise", () => {
    renderModal({ validateOptions: flagged(["human"]) })
    const box = screen.getByRole("checkbox", { name: /1 cell with an open check flag/ })
    expect(box).not.toBeChecked()
    // The flagged cell is still counted as "ready for your check" — the boxes
    // describe the file, and ticking the flag box is what adds it to the run.
    expect(screen.getByRole("checkbox", { name: /2 cells ready for your check/ })).toBeChecked()
    expect(screen.getByText(/This validates 1 eligible cell/)).toBeInTheDocument()
    expect(screen.getByText(/has an open check flag/)).toBeInTheDocument()
  })

  it("adds them to the run, and records the choice, when the reader ticks the box", async () => {
    const user = userEvent.setup()
    const { onConfirmValidate } = renderModal({ validateOptions: flagged(["human"]) })
    await user.click(screen.getByRole("checkbox", { name: /1 cell with an open check flag/ }))
    expect(screen.getByText(/This validates 2 eligible cells/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Validate text" }))
    expect(onConfirmValidate).toHaveBeenCalledWith({
      includeReadyCells: true,
      includeUntouchedAiDrafts: false,
      includeFlaggedCells: true,
    })
  })

  it("shows no flag box on a file nothing has flagged", () => {
    renderModal()
    expect(screen.queryByRole("checkbox", { name: /check flag/ })).toBeNull()
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
    expect(screen.getByText(/This validates 2 eligible cells/)).toBeInTheDocument()
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
