import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { CellIssuesTab } from "./CellIssuesTab"
import type { RuleInfraction, TranslationRule } from "@/lib/parsers/types"
import { matchHash } from "@/lib/rules/match-hash"

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

function infraction(ruleId: string, matchedTexts: string[] = []): RuleInfraction {
  return {
    ruleId,
    cellId: "cell-1",
    fileId: "file-1",
    reason: "target-forbids",
    spans: matchedTexts.map((text, i) => ({
      side: "target" as const,
      start: i * 50,
      end: i * 50 + text.length,
      matchedText: text,
    })),
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

function rows(ruleId: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-issue-row="${ruleId}"]`)]
}

describe("CellIssuesTab (AQU-1133)", () => {
  it("un-waives a waived issue straight from the cell-detail row", () => {
    const props = renderTab()

    fireEvent.click(within(row("rule-waived")).getByRole("button", { name: "Unwaive" }))

    // No span to name, so this is the rule-wide gesture (AQU-1740).
    expect(props.onUnwaive).toHaveBeenCalledWith("rule-waived", undefined)
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

describe("CellIssuesTab per-finding waivers (AQU-1740)", () => {
  const REPEATED = "builtin:repeated-word"
  const REPEATED_RULE_MAP = new Map<string, TranslationRule>([
    [REPEATED, rule(REPEATED, "Word repeated in translation")],
  ])

  function renderRepeated(matchedTexts: string[], waivedTexts: string[] = []) {
    const props = {
      activeInfractions: matchedTexts.length ? [infraction(REPEATED, matchedTexts)] : [],
      waivedInfractions: waivedTexts.length ? [infraction(REPEATED, waivedTexts)] : [],
      ruleMap: REPEATED_RULE_MAP,
      editable: true,
      onOpenRule: vi.fn(),
      onWaive: vi.fn(),
      onUnwaive: vi.fn(),
    }
    render(<CellIssuesTab {...props} />)
    return props
  }

  it("lists one waivable row per distinct match, not one row for the rule", () => {
    renderRepeated(["the the", "and and"])

    const listed = rows(REPEATED)
    expect(listed).toHaveLength(2)
    expect(listed.map((r) => r.getAttribute("data-issue-match"))).toEqual([
      matchHash("the the"),
      matchHash("and and"),
    ])
  })

  it("quotes the matched text so the reviewer can tell the findings apart", () => {
    renderRepeated(["the the", "and and"])

    expect(screen.getByText("“the the”")).toBeTruthy()
    expect(screen.getByText("“and and”")).toBeTruthy()
  })

  // The acceptance criterion, at the surface the reviewer actually uses.
  it("waives only the clicked finding, naming it by hash", () => {
    const props = renderRepeated(["the the", "and and"])

    const second = rows(REPEATED)[1]
    fireEvent.click(within(second).getByRole("button", { name: "Waive" }))

    expect(props.onWaive).toHaveBeenCalledTimes(1)
    expect(props.onWaive).toHaveBeenCalledWith({
      ruleId: REPEATED,
      matchHash: matchHash("and and"),
    })
  })

  it("folds identical matches into one row — one wording is one judgement", () => {
    renderRepeated(["the the", "The  The", "and and"])

    expect(rows(REPEATED)).toHaveLength(2)
  })

  it("keeps the remaining finding waivable after the other was accepted", () => {
    const props = renderRepeated(["and and"], ["the the"])

    const active = rows(REPEATED).filter((r) => !r.hasAttribute("data-issue-waived"))
    const waived = rows(REPEATED).filter((r) => r.hasAttribute("data-issue-waived"))
    expect(active).toHaveLength(1)
    expect(waived).toHaveLength(1)

    fireEvent.click(within(active[0]).getByRole("button", { name: "Waive" }))
    expect(props.onWaive).toHaveBeenCalledWith({
      ruleId: REPEATED,
      matchHash: matchHash("and and"),
    })

    fireEvent.click(within(waived[0]).getByRole("button", { name: "Unwaive" }))
    expect(props.onUnwaive).toHaveBeenCalledWith(REPEATED, matchHash("the the"))
  })

  it("falls back to one rule-level, cell-wide row when no span names a match", () => {
    const props = renderRepeated([])
    render(
      <CellIssuesTab
        activeInfractions={[infraction("rule-absence")]}
        waivedInfractions={[]}
        ruleMap={new Map([["rule-absence", rule("rule-absence", "Rendering required")]])}
        editable
        onOpenRule={props.onOpenRule}
        onWaive={props.onWaive}
        onUnwaive={props.onUnwaive}
      />,
    )

    const listed = rows("rule-absence")
    expect(listed).toHaveLength(1)
    expect(listed[0].hasAttribute("data-issue-match")).toBe(false)
    fireEvent.click(within(listed[0]).getByRole("button", { name: "Waive" }))
    expect(props.onWaive).toHaveBeenCalledWith({ ruleId: "rule-absence" })
  })
})
