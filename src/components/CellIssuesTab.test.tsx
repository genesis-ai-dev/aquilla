import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { CellIssuesTab } from "./CellIssuesTab"
import type { RuleInfraction, TranslationRule } from "@/lib/parsers/types"

function rule(id: string, name: string, severity: "major" | "minor" = "major"): TranslationRule {
  return {
    id,
    name,
    description: `${name} description`,
    severity,
    source: "user",
    scope: "project",
    check: { type: "target-forbids", targetPattern: "nope" },
    enabled: true,
    createdAt: "2026-09-01T00:00:00.000Z",
  }
}

function infraction(ruleId: string): RuleInfraction {
  return {
    ruleId,
    cellId: "cell-1",
    fileId: "file-1",
    reason: "target-forbids",
    spans: [],
  }
}

const RULE_MAP = new Map<string, TranslationRule>([
  ["rule-active", rule("rule-active", "No forbidden word")],
  ["rule-waived", rule("rule-waived", "Punctuation parity", "minor")],
])

function renderTab(overrides: Partial<Parameters<typeof CellIssuesTab>[0]> = {}) {
  const props = {
    activeInfractions: [infraction("rule-active")],
    waivedInfractions: [infraction("rule-waived")],
    ruleMap: RULE_MAP,
    editable: true,
    onOpenRule: vi.fn(),
    onWaive: vi.fn(),
    onUnwaive: vi.fn(),
    ...overrides,
  }
  render(<CellIssuesTab {...props} />)
  return props
}

function row(ruleId: string): HTMLElement {
  const el = document.querySelector(`[data-issue-row="${ruleId}"]`)
  if (!el) throw new Error(`no issue row rendered for ${ruleId}`)
  return el as HTMLElement
}

describe("CellIssuesTab — Bible data findings (AQU-1688)", () => {
  // The story: the finding reads as an explanation tied to this verse, and an
  // evidence line shows where the fact came from.
  it("shows the localized explanation and the evidence line under the check's name", () => {
    const bibleRule: TranslationRule = {
      ...rule("builtin:bkp:V2", "Quotation closes"),
      source: "algorithmic",
      check: { type: "builtin", checkId: "bkp:V2" },
    }
    const finding: RuleInfraction = {
      ruleId: "builtin:bkp:V2",
      cellId: "cell-1",
      fileId: "file-1",
      reason: "builtin:bkp:V2",
      reasonParams: {
        kind: "close-missing", level: "1", evidence: "speech", startRef: "JHN 4:9", startWord: "8",
        endRef: "JHN 4:9", endWord: "18", speakerSources: "fcbh", speakerConf: "0.97",
      },
      spans: [],
    }
    renderTab({ activeInfractions: [finding], waivedInfractions: [], ruleMap: new Map([[bibleRule.id, bibleRule]]) })
    const issue = row("builtin:bkp:V2")
    expect(issue).toHaveTextContent("Quotation closes")
    expect(issue).toHaveTextContent("A speech ends in this verse, but the translation has no closing quotation mark for it (level 1).")
    expect(within(issue).getByTestId("issue-evidence")).toHaveTextContent(
      "OpenText speech JHN 4:9 words 8–18; speaker from Clear speaker-quotations (confidence 97%)",
    )
  })
})

describe("CellIssuesTab (AQU-1133)", () => {
  it("un-waives a waived issue straight from the cell-detail row", () => {
    const props = renderTab()

    fireEvent.click(within(row("rule-waived")).getByRole("button", { name: "Unwaive" }))

    expect(props.onUnwaive).toHaveBeenCalledWith("rule-waived")
    expect(props.onWaive).not.toHaveBeenCalled()
  })

  it("waives an active issue straight from the cell-detail row", () => {
    const props = renderTab()

    fireEvent.click(within(row("rule-active")).getByRole("button", { name: "Waive" }))

    expect(props.onWaive).toHaveBeenCalledWith({ ruleId: "rule-active" })
    expect(props.onUnwaive).not.toHaveBeenCalled()
  })

  it("offers waive and un-waive symmetrically — one action per row, matching its state", () => {
    renderTab()

    const active = within(row("rule-active"))
    expect(active.getByRole("button", { name: "Waive" })).toBeTruthy()
    expect(active.queryByRole("button", { name: "Unwaive" })).toBeNull()

    const waived = within(row("rule-waived"))
    expect(waived.getByRole("button", { name: "Unwaive" })).toBeTruthy()
    expect(waived.queryByRole("button", { name: "Waive" })).toBeNull()
  })

  it("still opens the rule detail when the row body is clicked", () => {
    const props = renderTab()

    fireEvent.click(within(row("rule-waived")).getByRole("button", { name: /Punctuation parity/ }))

    expect(props.onOpenRule).toHaveBeenCalledWith("rule-waived")
  })

  it("disables both actions without write permission", () => {
    renderTab({ editable: false })

    expect(
      within(row("rule-active")).getByRole("button", { name: "Waive" }),
    ).toBeDisabled()
    expect(
      within(row("rule-waived")).getByRole("button", { name: "Unwaive" }),
    ).toBeDisabled()
  })

  it("renders the empty state when the cell has no infractions at all", () => {
    renderTab({ activeInfractions: [], waivedInfractions: [] })

    expect(screen.getByText("No translation rule issues on this cell.")).toBeTruthy()
    expect(document.querySelector("[data-issue-row]")).toBeNull()
  })
})
