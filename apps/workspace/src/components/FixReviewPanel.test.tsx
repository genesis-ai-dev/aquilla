import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { FixReviewPanel } from "./FixReviewPanel"
import type { FixProposal } from "@/lib/rules/autofix"
import type { TranslationRule } from "@/lib/parsers/types"

const rule: TranslationRule = {
  id: "r1", name: "No 'foo'", description: "", severity: "minor", source: "llm", scope: "project",
  check: { type: "target-forbids", targetPattern: "foo" }, enabled: true, createdAt: "",
}

function proposalWithTwo(): FixProposal {
  return {
    kind: "regex-replace", pattern: "foo", replacement: "bar", flags: "g",
    previews: [
      { cellId: "c1", fileId: "f1", before: "foo here", after: "bar here", source: "llm" },
      { cellId: "c2", fileId: "f1", before: "foo again", after: "bar again", source: "llm" },
    ],
  }
}

describe("FixReviewPanel", () => {
  it("renders previews with all rows pre-checked", () => {
    render(
      <FixReviewPanel open={true} rule={rule} proposal={proposalWithTwo()}
        onClose={() => {}} onApply={vi.fn()} onAmendRule={() => {}} />
    )
    expect(screen.getByText(/2 previews ready/i)).toBeInTheDocument()
    const checkboxes = screen.getAllByRole("checkbox")
    expect(checkboxes.length).toBeGreaterThanOrEqual(2)
    for (const cb of checkboxes) expect((cb as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole("button", { name: /apply 2 selected/i })).toBeInTheDocument()
  })

  it("updates the apply count when a row is unchecked", () => {
    render(<FixReviewPanel open={true} rule={rule} proposal={proposalWithTwo()}
      onClose={() => {}} onApply={vi.fn()} onAmendRule={() => {}} />)
    const checkboxes = screen.getAllByRole("checkbox")
    fireEvent.click(checkboxes[0])
    expect(screen.getByRole("button", { name: /apply 1 selected/i })).toBeInTheDocument()
  })

  it("calls onApply with selected cellIds", () => {
    const onApply = vi.fn()
    render(<FixReviewPanel open={true} rule={rule} proposal={proposalWithTwo()}
      onClose={() => {}} onApply={onApply} onAmendRule={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /apply 2 selected/i }))
    expect(onApply).toHaveBeenCalledWith(new Set(["c1", "c2"]))
  })

  it("renders empty state with amend button for kind=none", () => {
    const onAmend = vi.fn()
    render(<FixReviewPanel open={true} rule={rule}
      proposal={{ kind: "none", reason: "too semantic" }}
      onClose={() => {}} onApply={vi.fn()} onAmendRule={onAmend} />)
    expect(screen.getByText(/too semantic/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /amend rule/i }))
    expect(onAmend).toHaveBeenCalled()
  })

  it("shows 'Cached regex' mode badge when any preview is cached", () => {
    const proposal: FixProposal = {
      kind: "regex-replace", pattern: "foo", replacement: "bar", flags: "g",
      previews: [{ cellId: "c1", fileId: "f1", before: "foo", after: "bar", source: "cached-regex" }],
    }
    render(<FixReviewPanel open={true} rule={rule} proposal={proposal}
      onClose={() => {}} onApply={vi.fn()} onAmendRule={() => {}} />)
    expect(screen.getByText(/cached regex/i)).toBeInTheDocument()
  })
})
