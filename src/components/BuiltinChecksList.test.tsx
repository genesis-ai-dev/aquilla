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
