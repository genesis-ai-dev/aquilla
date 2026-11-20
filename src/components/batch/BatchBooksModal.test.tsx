import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { BatchBooksModal } from "./BatchBooksModal"

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
    await user.click(screen.getByText("Cells ready for your check"))
    expect(screen.getByRole("checkbox", { name: "Cells ready for your check" })).not.toBeChecked()
    await user.click(screen.getByRole("button", { name: "Validate books" }))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      fileIds: ["gen", "exo"],
      includeReadyCells: false,
      includeUntouchedAiDrafts: false,
      includeFlaggedCells: false,
    }))
  })
})
