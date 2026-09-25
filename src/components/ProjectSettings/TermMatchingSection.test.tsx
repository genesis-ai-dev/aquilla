import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { TermMatchingSection } from "./TermMatchingSection"

describe("TermMatchingSection", () => {
  // WHY: the inventory is plain data the admin owns. Adding, removing, and
  // preset-loading must all flow through onChange with the whole object so
  // the settings form can diff it against the baseline.
  it("adds and removes affixes and loads a preset", () => {
    const onChange = vi.fn()
    render(
      <I18nProvider>
        <TermMatchingSection value={{ prefixes: [], suffixes: [] }} onChange={onChange} disabled={false} />
      </I18nProvider>,
    )
    const prefixInput = screen.getByRole("textbox", { name: "Prefixes" })
    fireEvent.change(prefixInput, { target: { value: "ו" } })
    fireEvent.keyDown(prefixInput, { key: "Enter" })
    expect(onChange).toHaveBeenLastCalledWith({ prefixes: ["ו"], suffixes: [] })
    fireEvent.click(screen.getByRole("button", { name: "Load preset" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Hebrew" }))
    expect(onChange.mock.calls.at(-1)?.[0].prefixes).toContain("ל")
  })

  // WHY (AQU-1272): a saved inventory shows as chips, and the text box above
  // them stays empty because it is the ADD field, not the value. That is easy
  // to misread as "the setting did not load" — the QA walk on PR #819 read the
  // empty box that way while the API was returning ו/ה/ב. Nothing pinned the
  // chips, so the misreading could not be checked against a test. Now it can.
  it("renders a saved inventory as chips while the add field stays empty", () => {
    render(
      <I18nProvider>
        <TermMatchingSection
          value={{ prefixes: ["ו", "ה", "ב"], suffixes: ["ים"] }}
          onChange={vi.fn()}
          disabled={false}
        />
      </I18nProvider>,
    )

    for (const affix of ["ו", "ה", "ב", "ים"]) {
      expect(screen.getByRole("button", { name: `Remove ${affix}` })).toBeInTheDocument()
    }
    expect((screen.getByRole("textbox", { name: "Prefixes" }) as HTMLInputElement).value).toBe("")
    expect((screen.getByRole("textbox", { name: "Suffixes" }) as HTMLInputElement).value).toBe("")
  })
})
