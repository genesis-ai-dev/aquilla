// src/components/brief/BriefBuilder.test.tsx
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { BriefBuilder } from "./BriefBuilder"
import { emptyBrief } from "@/lib/brief/brief"

function noopAsync() { return Promise.resolve(undefined) }
function noGenerate() { return Promise.resolve(false) }

/** Advance the wizard to the notes step where "Save & generate summary" lives. */
async function gotoGenerateStep() {
  let next = screen.queryByRole("button", { name: /next/i })
  while (next) {
    fireEvent.click(next)
    next = screen.queryByRole("button", { name: /next/i })
  }
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /save & generate summary/i })).toBeTruthy(),
  )
}

describe("BriefBuilder", () => {
  it("renders the first interview field and saves a draft with entered text", async () => {
    const onSave = vi.fn().mockResolvedValue(emptyBrief("a"))
    render(
      <BriefBuilder
        open
        brief={emptyBrief("a")}
        canEdit
        onSaveDraft={onSave}
        onGenerateL1={noGenerate}
        onClose={() => {}}
      />,
    )
    // First field label from the schema is "Purpose / skopos"
    expect(screen.getByText(/Purpose \/ skopos/i)).toBeTruthy()
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "Evangelistic for youth" } })
    fireEvent.click(screen.getByRole("button", { name: /save draft/i }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0]
    expect(draft.parameters.purpose).toBe("Evangelistic for youth")
  })

  it("disables editing affordances when canEdit is false", () => {
    render(
      <BriefBuilder open brief={emptyBrief("a")} canEdit={false}
        onSaveDraft={noopAsync} onGenerateL1={noGenerate} onClose={() => {}} />,
    )
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).readOnly).toBe(true)
  })

  // AQU-968: the wizard must close on a successful generation and stay open
  // otherwise (e.g. no AI provider configured, so nothing was generated).
  it("closes after Save & generate summary succeeds", async () => {
    const onClose = vi.fn()
    const onGenerateL1 = vi.fn().mockResolvedValue(true)
    render(
      <BriefBuilder open brief={emptyBrief("a")} canEdit
        onSaveDraft={noopAsync} onGenerateL1={onGenerateL1} onClose={onClose} />,
    )
    await gotoGenerateStep()
    fireEvent.click(screen.getByRole("button", { name: /save & generate summary/i }))
    await waitFor(() => expect(onGenerateL1).toHaveBeenCalled())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it("keeps the wizard open when generation did not happen", async () => {
    const onClose = vi.fn()
    const onGenerateL1 = vi.fn().mockResolvedValue(false)
    render(
      <BriefBuilder open brief={emptyBrief("a")} canEdit
        onSaveDraft={noopAsync} onGenerateL1={onGenerateL1} onClose={onClose} />,
    )
    await gotoGenerateStep()
    fireEvent.click(screen.getByRole("button", { name: /save & generate summary/i }))
    await waitFor(() => expect(onGenerateL1).toHaveBeenCalled())
    expect(onClose).not.toHaveBeenCalled()
  })
})
