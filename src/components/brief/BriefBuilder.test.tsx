// src/components/brief/BriefBuilder.test.tsx
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { BriefBuilder } from "./BriefBuilder"
import { emptyBrief } from "@/lib/brief/brief"
import { BRIEF_FIELDS } from "@/lib/brief/schema"
import type { TranslationBrief } from "@/lib/brief/types"

function noopAsync() { return Promise.resolve(undefined) }
function noGenerate() { return Promise.resolve(false) }

/** A brief with every interview field answered — the "complete" shape. */
function completeBrief(): TranslationBrief {
  const brief = emptyBrief("a")
  return {
    ...brief,
    parameters: Object.fromEntries(BRIEF_FIELDS.map((f) => [f.id, `answer for ${f.id}`])),
    freeformNotes: "notes",
  }
}

/** Advance the wizard to the notes step where the finish button lives. */
async function gotoGenerateStep() {
  let next = screen.queryByRole("button", { name: /next/i })
  while (next) {
    fireEvent.click(next)
    next = screen.queryByRole("button", { name: /next/i })
  }
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /add to instructions/i })).toBeTruthy(),
  )
}

describe("BriefBuilder", () => {
  it("renders the first interview field and saves a draft with entered text", async () => {
    const onSave = vi.fn().mockResolvedValue(emptyBrief("a"))
    render(
      <BriefBuilder
        open title="Help me write instructions" finishLabel="Add to instructions"
        brief={emptyBrief("a")}
        canEdit
        onSaveDraft={onSave}
        onGenerateL1={noGenerate}
        onClose={() => {}}
      />,
    )
    // First field label from the schema is "Purpose / skopos". AQU-2347 put that
    // same name in the section nav too, so assert on the labelled input.
    const textarea = screen.getByLabelText(/Purpose \/ skopos/i)
    fireEvent.change(textarea, { target: { value: "Evangelistic for youth" } })
    fireEvent.click(screen.getByRole("button", { name: /save draft/i }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0]
    expect(draft.parameters.purpose).toBe("Evangelistic for youth")
  })

  it("disables editing affordances when canEdit is false", () => {
    render(
      <BriefBuilder open title="Help me write instructions" finishLabel="Add to instructions" brief={emptyBrief("a")} canEdit={false}
        onSaveDraft={noopAsync} onGenerateL1={noGenerate} onClose={() => {}} />,
    )
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).readOnly).toBe(true)
  })

  // AQU-968: the wizard must close on a successful generation and stay open
  // otherwise (e.g. no AI provider configured, so nothing was generated).
  it("closes after the finish step succeeds", async () => {
    const onClose = vi.fn()
    const onGenerateL1 = vi.fn().mockResolvedValue(true)
    render(
      <BriefBuilder open title="Help me write instructions" finishLabel="Add to instructions" brief={emptyBrief("a")} canEdit
        onSaveDraft={noopAsync} onGenerateL1={onGenerateL1} onClose={onClose} />,
    )
    await gotoGenerateStep()
    fireEvent.click(screen.getByRole("button", { name: /add to instructions/i }))
    await waitFor(() => expect(onGenerateL1).toHaveBeenCalled())
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it("keeps the wizard open when generation did not happen", async () => {
    const onClose = vi.fn()
    const onGenerateL1 = vi.fn().mockResolvedValue(false)
    render(
      <BriefBuilder open title="Help me write instructions" finishLabel="Add to instructions" brief={emptyBrief("a")} canEdit
        onSaveDraft={noopAsync} onGenerateL1={onGenerateL1} onClose={onClose} />,
    )
    await gotoGenerateStep()
    fireEvent.click(screen.getByRole("button", { name: /add to instructions/i }))
    await waitFor(() => expect(onGenerateL1).toHaveBeenCalled())
    expect(onClose).not.toHaveBeenCalled()
  })

  // AQU-2347: a finished brief opened on its LAST step, so reviewing it meant
  // clicking Back through every field, and there was no way to jump at all.
  describe("section navigation (AQU-2347)", () => {
    it("opens a complete brief at its first section, not its last", () => {
      render(
        <BriefBuilder open title="Help me write instructions" finishLabel="Add to instructions" brief={completeBrief()} canEdit
          onSaveDraft={noopAsync} onGenerateL1={noGenerate} onClose={() => {}} />,
      )
      const nav = screen.getByRole("navigation", { name: /brief sections/i })
      const current = nav.querySelector('[aria-current="step"]')
      expect(current?.textContent).toMatch(/Purpose \/ skopos/i)
      // The last step's primary action is absent: we are not at the end.
      expect(screen.queryByRole("button", { name: /add to instructions/i })).toBeNull()
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("answer for purpose")
    })

    it("still resumes an unfinished brief at its first unanswered field", () => {
      const brief = completeBrief()
      render(
        <BriefBuilder open title="Help me write instructions" finishLabel="Add to instructions" canEdit
          brief={{ ...brief, parameters: { ...brief.parameters, useAndMedium: "  " } }}
          onSaveDraft={noopAsync} onGenerateL1={noGenerate} onClose={() => {}} />,
      )
      const nav = screen.getByRole("navigation", { name: /brief sections/i })
      expect(nav.querySelector('[aria-current="step"]')?.textContent)
        .toMatch(/Intended use & medium/i)
    })

    it("lists every section and jumps to one in a single click", () => {
      render(
        <BriefBuilder open title="Help me write instructions" finishLabel="Add to instructions" brief={completeBrief()} canEdit
          onSaveDraft={noopAsync} onGenerateL1={noGenerate} onClose={() => {}} />,
      )
      const nav = screen.getByRole("navigation", { name: /brief sections/i })
      // One nav item per interview field, plus the freeform-notes step.
      expect(nav.querySelectorAll("li").length).toBe(BRIEF_FIELDS.length + 1)

      fireEvent.click(screen.getByRole("button", { name: /^Quality bar$/i }))
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value)
        .toBe("answer for qualityBar")
      expect(nav.querySelector('[aria-current="step"]')?.textContent).toMatch(/^Quality bar$/i)

      // The notes step is reachable the same way — no Next-clicking required.
      fireEvent.click(screen.getByRole("button", { name: /^Other notes$/i }))
      expect(screen.getByRole("button", { name: /add to instructions/i })).toBeTruthy()
    })

    it("keeps the user in the section they saved", async () => {
      const onSave = vi.fn().mockResolvedValue(completeBrief())
      render(
        <BriefBuilder open title="Help me write instructions" finishLabel="Add to instructions" brief={completeBrief()} canEdit
          onSaveDraft={onSave} onGenerateL1={noGenerate} onClose={() => {}} />,
      )
      fireEvent.click(screen.getByRole("button", { name: /^Key terms & theological tradition$/i }))
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "edited key terms" } })
      fireEvent.click(screen.getByRole("button", { name: /save draft/i }))
      await waitFor(() => expect(onSave).toHaveBeenCalled())
      const nav = screen.getByRole("navigation", { name: /brief sections/i })
      expect(nav.querySelector('[aria-current="step"]')?.textContent)
        .toMatch(/^Key terms & theological tradition$/i)
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("edited key terms")
    })
  })
})
