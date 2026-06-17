// src/components/brief/BriefBuilder.test.tsx
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { BriefBuilder } from "./BriefBuilder"
import { emptyBrief } from "@/lib/brief/brief"

function noopAsync() { return Promise.resolve(undefined) }

describe("BriefBuilder", () => {
  it("renders the first interview field and saves a draft with entered text", async () => {
    const onSave = vi.fn().mockResolvedValue(emptyBrief("a"))
    render(
      <BriefBuilder
        open
        brief={emptyBrief("a")}
        canEdit
        onSaveDraft={onSave}
        onGenerateL1={noopAsync}
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
        onSaveDraft={noopAsync} onGenerateL1={noopAsync} onClose={() => {}} />,
    )
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).readOnly).toBe(true)
  })
})
