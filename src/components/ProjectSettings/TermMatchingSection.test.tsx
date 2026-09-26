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
})
