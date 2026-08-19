import { describe, it, expect, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useHealth } from "./useHealth"
import type { CellData } from "./useCells"
import { buildLibraryLintResolver } from "@/lib/rules/effective-rules"
import type {
  CellCoordinates,
  RuleApplicability,
  StyleRule,
} from "@/lib/rules/style-rule-types"
import type { TranslationRule } from "@/lib/parsers/types"

function cell(id: string, translated: string, endorsementCount = 0): CellData {
  return {
    id, cellLabel: id, original: "hi", originalHtml: undefined, translated,
    context: "", group: "", type: "text",
    status: translated ? "unvalidated" : "empty",
    validationStatus: translated ? "none" : "empty",
    endorsementCount,
    activeValidators: [], history: [], threads: [], validationHistory: [],
  } as unknown as CellData
}

describe("useHealth — AD-14 decay", () => {
  it("derives per-cell health from endorsement_count (decay), not the four-sub-score", async () => {
    const fileCells = new Map([
      ["f", [cell("a", "bonjour", 5), cell("b", "salut", 0)]],
    ])
    const { result } = renderHook(() => useHealth(fileCells, []))
    await waitFor(() => expect(result.current.healthMap.size).toBe(2))
    // endorsement >= target → decay 0 → health 100; 0 → decay 1 → health 0.
    expect(result.current.healthMap.get("a")).toBe(100)
    expect(result.current.healthMap.get("b")).toBe(0)
  })

  it("reaches full health at the required-validations gate (default), not a hard-coded 5", async () => {
    // The regression: a cell validated once must read 100 when the project
    // requires a single validation — not stick at 20% against a phantom 5.
    const fileCells = new Map([["f", [cell("a", "bonjour", 1)]]])
    const { result } = renderHook(() =>
      useHealth(fileCells, [], { requiredValidations: 1 }),
    )
    await waitFor(() => expect(result.current.healthMap.size).toBe(1))
    expect(result.current.healthMap.get("a")).toBe(100)
  })

  it("interpolates against the required-validations gate", async () => {
    const fileCells = new Map([["f", [cell("a", "bonjour", 3)]]])
    const { result } = renderHook(() =>
      useHealth(fileCells, [], { requiredValidations: 5 }),
    )
    await waitFor(() => expect(result.current.healthMap.size).toBe(1))
    expect(result.current.healthMap.get("a")).toBe(60) // 3/5 endorsed → decay .4 → health 60
  })

  it("lets an explicit decaySettings.endorsementTarget override the gate", async () => {
    const fileCells = new Map([["f", [cell("a", "bonjour", 1)]]])
    const { result } = renderHook(() =>
      useHealth(fileCells, [], {
        requiredValidations: 1,
        decaySettings: { endorsementTarget: 4 },
      }),
    )
    await waitFor(() => expect(result.current.healthMap.size).toBe(1))
    expect(result.current.healthMap.get("a")).toBe(25) // 1/4 endorsed → decay .75 → health 25
  })

  it("carries rule infractions as a separate surface (not folded into health)", async () => {
    const fileCells = new Map([["f", [cell("a", "bonjour", 3)]]])
    const { result } = renderHook(() => useHealth(fileCells, []))
    await waitFor(() => expect(result.current.healthMap.size).toBe(1))
    expect(result.current.infractions instanceof Map).toBe(true)
  })
})

// AQU-181: serverRollup override — AD-14 amendment 2026-06-04.
describe("useHealth — serverRollup override (AQU-181)", () => {
  it("uses server projectHealth when serverRollup is provided", async () => {
    const fileCells = new Map([["f", [cell("a", "bonjour", 0)]]])
    // endorsement-count path gives 0; server says 75.
    const serverRollup = { projectHealth: 75, fileHealth: new Map([["f", 75]]) }
    const { result } = renderHook(() =>
      useHealth(fileCells, [], { serverRollup }),
    )
    await waitFor(() => expect(result.current.healthMap.size).toBe(1))
    expect(result.current.projectHealth).toBe(75)
  })

  it("uses server fileHealth when serverRollup is provided", async () => {
    const fileCells = new Map([
      ["f1", [cell("a", "hello", 0)]],
      ["f2", [cell("b", "world", 0)]],
    ])
    const serverRollup = {
      projectHealth: 60,
      fileHealth: new Map([["f1", 80], ["f2", 40]]),
    }
    const { result } = renderHook(() =>
      useHealth(fileCells, [], { serverRollup }),
    )
    await waitFor(() => expect(result.current.healthMap.size).toBe(2))
    expect(result.current.fileHealth.get("f1")).toBe(80)
    expect(result.current.fileHealth.get("f2")).toBe(40)
  })

  it("falls back to endorsement-count health when serverRollup is null", async () => {
    // cell with 5 endorsements at gate 5 → health 100.
    const fileCells = new Map([["f", [cell("a", "bonjour", 5)]]])
    const { result } = renderHook(() =>
      useHealth(fileCells, [], { requiredValidations: 5, serverRollup: null }),
    )
    await waitFor(() => expect(result.current.healthMap.size).toBe(1))
    expect(result.current.projectHealth).toBe(100)
  })

  it("falls back to endorsement-count health when serverRollup.projectHealth is null", async () => {
    const fileCells = new Map([["f", [cell("a", "bonjour", 5)]]])
    const { result } = renderHook(() =>
      useHealth(fileCells, [], {
        requiredValidations: 5,
        serverRollup: { projectHealth: null, fileHealth: new Map() },
      }),
    )
    await waitFor(() => expect(result.current.healthMap.size).toBe(1))
    expect(result.current.projectHealth).toBe(100) // endorsement-count path: 5/5 → 100
  })
})

// AQU-934 phase 3a: style-library checks lint only where the applicability
// graph puts them in force.
describe("useHealth — library rules via rulesForCell", () => {
  const BANNED_RULE: StyleRule = {
    id: "lib-1",
    orgId: null,
    projectId: "p1",
    instruction: "Never write the word banned.",
    category: "style",
    scope: "segment",
    conditions: null,
    examples: null,
    exceptions: null,
    source: null,
    checkSpec: { type: "target-forbids", targetPattern: "\\bbanned\\b" },
    severity: "minor",
    enabled: true,
    status: "approved",
    humanEdited: false,
    provenance: null,
    createdBy: null,
    reviewedBy: null,
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }

  function row(cellId: string): RuleApplicability {
    return {
      id: `row-${cellId}`,
      ruleId: BANNED_RULE.id,
      targetType: "segment",
      targetId: cellId,
      relationship: "applies",
      confidence: null,
      reason: null,
      assignedBy: "human",
      createdBy: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }
  }

  /** Coordinates without file metadata — segment + file is all these cells have. */
  const coordsFor = (c: { id: string; fileId: string }): CellCoordinates => ({
    segment: c.id,
    file: c.fileId,
  })

  function resolver(rules: StyleRule[], rows: RuleApplicability[]) {
    return buildLibraryLintResolver({ styleRules: rules, applicability: rows, coordsFor })
  }

  it("lints the cell the graph selects and not its sibling, with no project rules", async () => {
    const fileCells = new Map([["f", [cell("a", "a banned word"), cell("b", "a banned word")]]])
    const { rulesForCell, signature } = resolver([BANNED_RULE], [row("a")])

    const { result } = renderHook(() =>
      useHealth(fileCells, [], { rulesForCell, rulesForCellSig: signature }),
    )

    await waitFor(() => expect(result.current.healthMap.size).toBe(2))
    expect(result.current.infractions.get("a")?.map((i) => i.ruleId)).toEqual(["lib:lib-1"])
    expect(result.current.infractions.has("b")).toBe(false)
  })

  it("re-lints every cached cell when the library signature changes", async () => {
    const fileCells = new Map([["f", [cell("a", "a banned word")]]])
    const dormant = resolver([BANNED_RULE], [row("other-cell")])
    const live = resolver([BANNED_RULE], [row("a")])

    const { result, rerender } = renderHook(
      ({ r }: { r: ReturnType<typeof resolver> }) =>
        useHealth(fileCells, [], { rulesForCell: r.rulesForCell, rulesForCellSig: r.signature }),
      { initialProps: { r: dormant } },
    )
    await waitFor(() => expect(result.current.healthMap.size).toBe(1))
    expect(result.current.infractions.has("a")).toBe(false)

    // Same cells, same content: only the graph moved.
    rerender({ r: live })
    await waitFor(() => expect(result.current.infractions.has("a")).toBe(true))
    expect(result.current.infractions.get("a")?.map((i) => i.ruleId)).toEqual(["lib:lib-1"])
  })

  it("never consults the resolver when the library signature says nothing can lint", async () => {
    const fileCells = new Map([["f", [cell("a", "a banned word")]]])
    const empty = resolver([], [])
    const spy = vi.fn(empty.rulesForCell)

    const { result } = renderHook(() =>
      useHealth(fileCells, [], { rulesForCell: spy, rulesForCellSig: empty.signature }),
    )

    await waitFor(() => expect(result.current.healthMap.size).toBe(1))
    expect(spy).not.toHaveBeenCalled()
    expect(result.current.infractions.size).toBe(0)
  })

  it("resolves each cell once per content change, not once per pass", async () => {
    const first = new Map([["f", [cell("a", "one"), cell("b", "two")]]])
    const { rulesForCell } = resolver([BANNED_RULE], [row("a")])
    const spy = vi.fn(rulesForCell)

    const { result, rerender } = renderHook(
      ({ cells }: { cells: Map<string, CellData[]> }) =>
        useHealth(cells, [], { rulesForCell: spy, rulesForCellSig: "sig-1" }),
      { initialProps: { cells: first } },
    )
    await waitFor(() => expect(result.current.healthMap.size).toBe(2))
    const afterFirstPass = spy.mock.calls.length

    // A keystroke in "a": new Map, new array, one changed cell.
    rerender({ cells: new Map([["f", [cell("a", "one more"), cell("b", "two")]]]) })
    await waitFor(() => expect(result.current.healthMap.size).toBe(2))

    expect(afterFirstPass).toBe(2)
    expect(spy.mock.calls.length - afterFirstPass).toBe(1)
    expect(spy.mock.calls[spy.mock.calls.length - 1][0].id).toBe("a")
  })

  it("keeps today's behaviour byte-identical when the new options are omitted", async () => {
    const projectRule: TranslationRule = {
      id: "user:1",
      name: "No banned word",
      description: "",
      severity: "minor",
      source: "user",
      scope: "project",
      check: { type: "target-forbids", targetPattern: "\\bbanned\\b" },
      enabled: true,
      createdAt: "2026-01-01T00:00:00Z",
    }
    const fileCells = new Map([["f", [cell("a", "a banned word"), cell("b", "fine")]]])

    const withRules = renderHook(() => useHealth(fileCells, [projectRule]))
    await waitFor(() => expect(withRules.result.current.healthMap.size).toBe(2))
    expect(withRules.result.current.infractions.get("a")?.map((i) => i.ruleId)).toEqual(["user:1"])
    expect(withRules.result.current.infractions.has("b")).toBe(false)

    // No rules at all: the early return still yields an empty surface, and the
    // structural-stability contract still hands back the same reference.
    const noRules = renderHook(() => useHealth(fileCells, []))
    await waitFor(() => expect(noRules.result.current.healthMap.size).toBe(2))
    expect(noRules.result.current.infractions.size).toBe(0)
    const before = noRules.result.current
    noRules.rerender()
    expect(noRules.result.current).toBe(before)
  })
})
