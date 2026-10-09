/**
 * AQU-983: the file modal is where a reviewer chooses to include untouched
 * AI drafts, and where a contributor is told they cannot.
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
    })
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
