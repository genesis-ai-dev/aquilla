import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { BuiltinChecksList } from "./BuiltinChecksList"
import { resolveBuiltinRules } from "@/lib/lqa/builtin-resolver"

describe("BuiltinChecksList", () => {
  const builtinRules = resolveBuiltinRules(undefined)

  it("renders all built-in checks", () => {
    render(
      <BuiltinChecksList
        builtinRules={builtinRules}
        infractions={new Map()}
        onSetOverride={() => {}}
      />,
    )
    expect(screen.getByText("Empty translation")).toBeInTheDocument()
    expect(screen.getByText("Identical to source")).toBeInTheDocument()
    expect(screen.getByText("Placeholder integrity")).toBeInTheDocument()
  })

  it("calls onSetOverride when toggle clicked", () => {
    const spy = vi.fn()
    render(
      <BuiltinChecksList
        builtinRules={builtinRules}
        infractions={new Map()}
        onSetOverride={spy}
      />,
    )
    // The "Abbreviation pass-through" row's toggle starts disabled (default).
    const row = screen.getByText("Abbreviation pass-through").closest("[data-testid='builtin-row']")!
    const toggle = within(row as HTMLElement).getByRole("switch")
    fireEvent.click(toggle)
    expect(spy).toHaveBeenCalledWith(
      "abbreviation-mismatch",
      expect.objectContaining({ enabled: true }),
    )
  })

  it("displays infraction counts per check", () => {
    const infractions = new Map([
      ["c1", [{ ruleId: "builtin:empty-target", cellId: "c1", fileId: "f1", reason: "builtin:empty-target" as const, spans: [] }]],
      ["c2", [{ ruleId: "builtin:empty-target", cellId: "c2", fileId: "f1", reason: "builtin:empty-target" as const, spans: [] }]],
    ])
    render(
      <BuiltinChecksList
        builtinRules={builtinRules}
        infractions={infractions}
        onSetOverride={() => {}}
      />,
    )
    const row = screen.getByText("Empty translation").closest("[data-testid='builtin-row']")!
    expect(row.textContent).toMatch(/2/)
  })
})

// AQU-1688: Bible data checks sit in their own group, and a dormant one says
// which Language-profile slot it waits for (the spec: never dormant silently).
describe("BuiltinChecksList — Bible data checks", () => {
  const textOnly = resolveBuiltinRules(undefined)
  const withBible = resolveBuiltinRules(undefined, { bibleChecks: true })
  const quoteMarks = { levels: [{ open: "“", close: "”" }], continuation: "none" as const }

  it("groups the Bible data checks under their own heading, only when they exist", () => {
    const { unmount } = render(<BuiltinChecksList builtinRules={textOnly} infractions={new Map()} onSetOverride={() => {}} />)
    expect(screen.queryByTestId("builtin-bible-checks")).toBeNull()
    unmount()
    render(<BuiltinChecksList builtinRules={withBible} infractions={new Map()} onSetOverride={() => {}} />)
    const group = screen.getByTestId("builtin-bible-checks")
    expect(within(group).getByText("Bible data checks")).toBeInTheDocument()
    expect(within(group).getAllByTestId("builtin-row")).toHaveLength(8)
    expect(within(group).getByText("Question kept")).toBeInTheDocument()
  })

  const needsOf = (name: string) => {
    const row = screen.getByText(name).closest("[data-testid='builtin-row']") as HTMLElement
    return within(row).queryAllByTestId("builtin-row-needs").map((line) => line.textContent)
  }

  it("says which slot each check waits for while the Language profile is empty", () => {
    render(<BuiltinChecksList builtinRules={withBible} infractions={new Map()} onSetOverride={() => {}} languageProfile={{}} />)
    const needs = within(screen.getByTestId("builtin-bible-checks")).getAllByTestId("builtin-row-needs")
    expect(needs).toHaveLength(8)
    expect(needsOf("Quotation closes")).toEqual(["Needs: quotation marks in Language profile"])
    // AQU-1691: M1 has its own slot. Naming quotation marks here would send the
    // maintainer to fill in the wrong part of the profile.
    expect(needsOf("Question kept")).toEqual(["Needs: question markers in Language profile"])
  })

  it("keeps the question check dormant until question markers are saved, even with quotation marks set", () => {
    const { unmount } = render(
      <BuiltinChecksList builtinRules={withBible} infractions={new Map()} onSetOverride={() => {}} languageProfile={{ quoteMarks }} />,
    )
    expect(screen.getAllByTestId("builtin-row-needs")).toHaveLength(1)
    expect(needsOf("Question kept")).toEqual(["Needs: question markers in Language profile"])
    unmount()
    // An empty slot is a real answer: questions are marked with "?" only.
    render(
      <BuiltinChecksList
        builtinRules={withBible}
        infractions={new Map()}
        onSetOverride={() => {}}
        languageProfile={{ quoteMarks, questionMarkers: {} }}
      />,
    )
    expect(screen.queryByTestId("builtin-row-needs")).toBeNull()
  })

  it("drops the reason once the marks are set, and keeps the switch and severity", () => {
    const spy = vi.fn()
    render(
      <BuiltinChecksList builtinRules={withBible} infractions={new Map()} onSetOverride={spy} languageProfile={{ quoteMarks }} />,
    )
    expect(needsOf("Quotation closes")).toEqual([])
    const row = screen.getByText("Quotation closes").closest("[data-testid='builtin-row']") as HTMLElement
    fireEvent.click(within(row).getByRole("switch"))
    expect(spy).toHaveBeenCalledWith("bkp:V2", expect.objectContaining({ enabled: false }))
  })
})
