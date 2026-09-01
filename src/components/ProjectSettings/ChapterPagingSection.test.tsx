import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ChapterPagingSection } from "./ChapterPagingSection"
import type { ChapterPagingFormValue } from "./ChapterPagingSection"

const DEFAULTS: ChapterPagingFormValue = {
  chapterPagingEnabled: false,
  chapterCompletionTrigger: "allTranslated",
  chapterCompletionAction: "prompt",
}

function renderSection(overrides: Partial<Parameters<typeof ChapterPagingSection>[0]> = {}) {
  const onChange = vi.fn()
  const props = {
    value: DEFAULTS,
    onChange,
    disabled: false,
    ...overrides,
  }
  const utils = render(<ChapterPagingSection {...props} />)
  return { ...utils, onChange }
}

describe("ChapterPagingSection (AQU-1087)", () => {
  it("defaults to full-book scroll with no completion radios", () => {
    renderSection()
    const toggle = screen.getByRole("switch", { name: /one chapter at a time/i })
    expect(toggle).not.toBeChecked()
    expect(screen.queryByRole("radio")).toBeNull()
  })

  it("reveals completion trigger and action when paging is on", () => {
    renderSection({
      value: { ...DEFAULTS, chapterPagingEnabled: true },
    })
    expect(screen.getByRole("radio", { name: /all verses translated/i })).toBeChecked()
    expect(screen.getByRole("radio", { name: /offer to go to the next chapter/i })).toBeChecked()
  })

  it("hides the action radios when the trigger is manual", () => {
    renderSection({
      value: {
        ...DEFAULTS,
        chapterPagingEnabled: true,
        chapterCompletionTrigger: "manual",
      },
    })
    expect(screen.getByRole("radio", { name: /manual only/i })).toBeChecked()
    expect(screen.queryByRole("radio", { name: /offer to go to the next chapter/i })).toBeNull()
  })

  it("toggles paging on", () => {
    const { onChange } = renderSection()
    fireEvent.click(screen.getByRole("switch", { name: /one chapter at a time/i }))
    expect(onChange).toHaveBeenCalledWith({ chapterPagingEnabled: true })
  })

  it("selects a completion trigger", () => {
    const { onChange } = renderSection({
      value: { ...DEFAULTS, chapterPagingEnabled: true },
    })
    fireEvent.click(screen.getByRole("radio", { name: /all verses validated/i }))
    expect(onChange).toHaveBeenCalledWith({ chapterCompletionTrigger: "allValidated" })
  })

  it("selects a completion action", () => {
    const { onChange } = renderSection({
      value: { ...DEFAULTS, chapterPagingEnabled: true },
    })
    fireEvent.click(screen.getByRole("radio", { name: /go to the next chapter automatically/i }))
    expect(onChange).toHaveBeenCalledWith({ chapterCompletionAction: "autoAdvance" })
  })

  it("does not fire onChange when disabled", () => {
    const { onChange } = renderSection({
      value: { ...DEFAULTS, chapterPagingEnabled: true },
      disabled: true,
    })
    fireEvent.click(screen.getByRole("switch", { name: /one chapter at a time/i }))
    fireEvent.click(screen.getByRole("radio", { name: /all verses validated/i }))
    expect(onChange).not.toHaveBeenCalled()
  })
})
