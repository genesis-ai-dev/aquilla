import { createRef } from "react"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import type { BookBatchCounts } from "@/lib/review/batch-book-counts"
import { BatchBooksDialog, BatchBooksModal, type BatchBooksDialogHandle } from "./BatchBooksModal"

const books = [
  { id: "gen", bookCode: "GEN", name: "Genesis" },
  { id: "exo", bookCode: "EXO", name: "Exodus" },
]

function renderModal() {
  const onConfirm = vi.fn()
  render(
    <I18nProvider>
      <BatchBooksModal
        open
        onOpenChange={vi.fn()}
        request="validate"
        books={books}
        initialFileId="gen"
        canIncludeUntouchedAi
        onConfirm={onConfirm}
      />
    </I18nProvider>,
  )
  return { onConfirm }
}

describe("BatchBooksModal", () => {
  it("checks and clears every book from the checkbox beside Books", async () => {
    const user = userEvent.setup()
    renderModal()
    const all = screen.getByRole("checkbox", { name: "Books" })
    expect(all).toHaveAttribute("aria-checked", "mixed")
    await user.click(screen.getByText("Books"))
    expect(screen.getByRole("checkbox", { name: "Genesis" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Exodus" })).toBeChecked()
    expect(all).toBeChecked()
    await user.click(screen.getByText("Books"))
    expect(screen.getByRole("checkbox", { name: "Genesis" })).not.toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Exodus" })).not.toBeChecked()
  })

  it("starts with the open book checked and confirms the books the reader adds", async () => {
    const user = userEvent.setup()
    const { onConfirm } = renderModal()
    expect(screen.getByTestId("legend-list-mock")).toBeInTheDocument()
    expect(screen.getByRole("checkbox", { name: "Genesis" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Exodus" })).not.toBeChecked()
    await user.click(screen.getByText("Exodus"))
    expect(screen.getByRole("checkbox", { name: "Exodus" })).toBeChecked()
    expect(screen.queryByText("What this run includes")).toBeNull()
    await user.click(screen.getByText("Include unvalidated cells"))
    expect(screen.getByRole("checkbox", { name: "Include unvalidated cells" })).not.toBeChecked()
    await user.click(screen.getByRole("button", { name: "Validate books" }))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      fileIds: ["gen", "exo"],
      includeReadyCells: false,
      includeUntouchedAiDrafts: false,
      includeFlaggedCells: false,
    }))
  })

  it("opens from the header's handle and reports which run was asked for", async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const ref = createRef<BatchBooksDialogHandle>()
    render(
      <I18nProvider>
        <BatchBooksDialog
          ref={ref}
          books={books}
          initialFileId="gen"
          canIncludeUntouchedAi
          onConfirm={onConfirm}
        />
      </I18nProvider>,
    )
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    act(() => { ref.current?.open("draft") })
    await user.click(screen.getByRole("button", { name: "Draft books" }))
    expect(onConfirm).toHaveBeenCalledWith("draft", expect.objectContaining({
      fileIds: ["gen"],
      includeEmpty: true,
      refreshAiDrafts: false,
    }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("states the checked books' cell totals under each choice, and grows them as books are added", async () => {
    const user = userEvent.setup()
    const counts = new Map<string, BookBatchCounts>([
      ["gen", { empty: 10000, untouchedAi: 5000, unsigned: 80 }],
      ["exo", { empty: 20, untouchedAi: 4, unsigned: 15 }],
    ])
    const { rerender } = render(
      <I18nProvider>
        <BatchBooksModal
          open
          onOpenChange={vi.fn()}
          request="draft"
          books={books}
          initialFileId="gen"
          counts={counts}
          canIncludeUntouchedAi
          onConfirm={vi.fn()}
        />
      </I18nProvider>,
    )
    expect(screen.getByText("10000 empty cells")).toBeInTheDocument()
    expect(screen.getByText("5000 untouched AI drafts to refresh")).toBeInTheDocument()
    await user.click(screen.getByText("Exodus"))
    expect(screen.getByText("10020 empty cells")).toBeInTheDocument()
    expect(screen.getByText("5004 untouched AI drafts to refresh")).toBeInTheDocument()

    rerender(
      <I18nProvider>
        <BatchBooksModal
          open
          onOpenChange={vi.fn()}
          request="validate"
          books={books}
          initialFileId="gen"
          counts={counts}
          canIncludeUntouchedAi
          onConfirm={vi.fn()}
        />
      </I18nProvider>,
    )
    expect(screen.getByText("95 saved cells you have not signed off.")).toBeInTheDocument()
    expect(screen.getByText("5004 AI drafts nobody has checked")).toBeInTheDocument()
  })
})
