/**
 * FRO-186: FixReviewPanel typed-confirmation gate tests.
 *
 * Verifies:
 *  1. Apply is disabled until the user types the exact confirmPhrase.
 *  2. Apply is enabled (and fires) when the phrase matches.
 *  3. Without confirmPhrase, Apply works as before (no confirmation needed).
 *  4. Typing the wrong phrase keeps Apply disabled.
 *  5. BuiltinChecksList renders "Harmonize all (N)" when onHarmonize + violations present.
 *  6. BuiltinChecksList button is disabled when canHarmonize=false.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { FixReviewPanel } from "./FixReviewPanel"
import { BuiltinChecksList } from "./BuiltinChecksList"
import type { FixProposal } from "@/lib/rules/autofix"
import type { TranslationRule, RuleInfraction } from "@/lib/parsers/types"

const rule: TranslationRule = {
  id: "r1", name: "No double spaces", description: "", severity: "minor", source: "llm", scope: "project",
  check: { type: "target-forbids", targetPattern: "  " }, enabled: true, createdAt: "",
}

function twoPreviewProposal(): FixProposal {
  return {
    kind: "regex-replace", pattern: "  ", replacement: " ", flags: "g",
    previews: [
      { cellId: "c1", fileId: "f1", before: "foo  bar", after: "foo bar", source: "llm" },
      { cellId: "c2", fileId: "f1", before: "baz  qux", after: "baz qux", source: "llm" },
    ],
  }
}

// ── Typed confirmation gate ────────────────────────────────────────────────

describe("FixReviewPanel — typed confirmation gate (FRO-186)", () => {
  it("Apply is disabled until the correct phrase is typed", () => {
    render(
      <FixReviewPanel
        open={true}
        rule={rule}
        proposal={twoPreviewProposal()}
        onClose={() => {}}
        onApply={vi.fn()}
        onAmendRule={() => {}}
        confirmPhrase="No double spaces"
      />
    )
    // Apply button should be disabled before any input.
    const applyBtn = screen.getByRole("button", { name: /apply 2 selected/i })
    expect(applyBtn).toBeDisabled()
  })

  it("Apply remains disabled when the phrase is partially typed", () => {
    render(
      <FixReviewPanel
        open={true}
        rule={rule}
        proposal={twoPreviewProposal()}
        onClose={() => {}}
        onApply={vi.fn()}
        onAmendRule={() => {}}
        confirmPhrase="No double spaces"
      />
    )
    const input = screen.getByRole("textbox", { name: /type the rule name to confirm/i })
    fireEvent.change(input, { target: { value: "No double" } })
    expect(screen.getByRole("button", { name: /apply 2 selected/i })).toBeDisabled()
  })

  it("Apply is enabled when the exact phrase is typed", () => {
    const onApply = vi.fn()
    render(
      <FixReviewPanel
        open={true}
        rule={rule}
        proposal={twoPreviewProposal()}
        onClose={() => {}}
        onApply={onApply}
        onAmendRule={() => {}}
        confirmPhrase="No double spaces"
      />
    )
    const input = screen.getByRole("textbox", { name: /type the rule name to confirm/i })
    fireEvent.change(input, { target: { value: "No double spaces" } })
    const applyBtn = screen.getByRole("button", { name: /apply 2 selected/i })
    expect(applyBtn).not.toBeDisabled()
    fireEvent.click(applyBtn)
    expect(onApply).toHaveBeenCalledWith(new Set(["c1", "c2"]))
  })

  it("Apply fires immediately (no confirm gate) when confirmPhrase is absent", () => {
    const onApply = vi.fn()
    render(
      <FixReviewPanel
        open={true}
        rule={rule}
        proposal={twoPreviewProposal()}
        onClose={() => {}}
        onApply={onApply}
        onAmendRule={() => {}}
        // No confirmPhrase prop.
      />
    )
    // No confirm input should be rendered.
    expect(screen.queryByRole("textbox")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /apply 2 selected/i }))
    expect(onApply).toHaveBeenCalledWith(new Set(["c1", "c2"]))
  })

  it("Wrong phrase (case-sensitive mismatch) keeps Apply disabled", () => {
    render(
      <FixReviewPanel
        open={true}
        rule={rule}
        proposal={twoPreviewProposal()}
        onClose={() => {}}
        onApply={vi.fn()}
        onAmendRule={() => {}}
        confirmPhrase="No double spaces"
      />
    )
    const input = screen.getByRole("textbox", { name: /type the rule name to confirm/i })
    // Lowercase mismatch.
    fireEvent.change(input, { target: { value: "no double spaces" } })
    expect(screen.getByRole("button", { name: /apply 2 selected/i })).toBeDisabled()
  })
})

// ── BuiltinChecksList harmonize trigger ───────────────────────────────────

const builtinRule: TranslationRule = {
  id: "br1", name: "Double space check", description: "Flags double spaces", severity: "minor",
  source: "algorithmic", scope: "project",
  check: { type: "builtin", checkId: "double-space" as any }, enabled: true, createdAt: "",
}

function makeInfractions(ruleId: string, count: number): Map<string, RuleInfraction[]> {
  const m = new Map<string, RuleInfraction[]>()
  for (let i = 0; i < count; i++) {
    m.set(`cell-${i}`, [{ ruleId, cellId: `cell-${i}`, fileId: "f1", message: "double space", spans: [] }])
  }
  return m
}

describe("BuiltinChecksList — harmonize trigger (FRO-186)", () => {
  it("renders 'Harmonize all (N)' button when onHarmonize is provided and violations > 0", () => {
    render(
      <BuiltinChecksList
        builtinRules={[builtinRule]}
        infractions={makeInfractions("br1", 3)}
        onSetOverride={() => {}}
        onHarmonize={vi.fn()}
      />
    )
    expect(screen.getByTestId("harmonize-all-btn")).toBeInTheDocument()
    expect(screen.getByTestId("harmonize-all-btn")).toHaveTextContent("Harmonize all (3)")
  })

  it("does not render the button when there are no violations", () => {
    render(
      <BuiltinChecksList
        builtinRules={[builtinRule]}
        infractions={new Map()}
        onSetOverride={() => {}}
        onHarmonize={vi.fn()}
      />
    )
    expect(screen.queryByTestId("harmonize-all-btn")).toBeNull()
  })

  it("does not render the button when onHarmonize is absent", () => {
    render(
      <BuiltinChecksList
        builtinRules={[builtinRule]}
        infractions={makeInfractions("br1", 2)}
        onSetOverride={() => {}}
        // No onHarmonize.
      />
    )
    expect(screen.queryByTestId("harmonize-all-btn")).toBeNull()
  })

  it("button is disabled when canHarmonize=false", () => {
    render(
      <BuiltinChecksList
        builtinRules={[builtinRule]}
        infractions={makeInfractions("br1", 2)}
        onSetOverride={() => {}}
        onHarmonize={vi.fn()}
        canHarmonize={false}
      />
    )
    expect(screen.getByTestId("harmonize-all-btn")).toBeDisabled()
  })

  it("calls onHarmonize with the rule and violation count on click", () => {
    const onHarmonize = vi.fn()
    render(
      <BuiltinChecksList
        builtinRules={[builtinRule]}
        infractions={makeInfractions("br1", 5)}
        onSetOverride={() => {}}
        onHarmonize={onHarmonize}
        canHarmonize={true}
      />
    )
    fireEvent.click(screen.getByTestId("harmonize-all-btn"))
    expect(onHarmonize).toHaveBeenCalledWith(builtinRule, 5)
  })
})
