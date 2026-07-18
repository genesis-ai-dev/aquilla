/**
 * Tests for the Phase 0.5 deterministic check (spec §4 `check-chapter`,
 * deterministic pass).
 *
 * WHY these matter: findings are shown to consultants as exact facts with
 * evidence ("14 of 18 occurrences use 'Kristo'") — a wrong denominator, a
 * double-counted concept, or an ASCII-only word boundary would burn the very
 * trust the deterministic floor exists to earn. So the tests pin:
 *   - the occurrence denominator counts only translated source-matching cells
 *   - "consistent" means ≥1 approved rendering (multi-rendering concepts)
 *   - unicode boundaries (Greek source terms, accented renderings)
 *   - term-compiled rules are excluded from the rule pass (no double report)
 *   - findings assembly: counts, grouping, and the summary numbers agree
 */

import { describe, it, expect } from "vitest"
import type { TranslationRule } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import type { Concept } from "@/lib/terminology/types"
import {
  scanTermConsistency,
  checkableRules,
  groupInfractionsByRule,
  runDeterministicCheck,
  type CheckableCell,
} from "./deterministic-check"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let cellSeq = 0
function cell(
  original: string,
  translated: string,
  overrides: Partial<CellData> = {},
): CellData {
  cellSeq++
  return {
    id: overrides.id ?? `cell-${cellSeq}`,
    fileId: "file-1",
    cellLabel: overrides.cellLabel,
    original,
    translated,
    context: "",
    group: "g",
    type: "text",
    status: translated.trim() ? "unvalidated" : "empty",
    validationStatus: { validated: false },
    ...overrides,
  } as CellData
}

function concept(
  sourceTerm: string,
  renderings: { rendering: string; status: "preferred" | "admitted" | "forbidden" }[],
  overrides: Partial<Concept> = {},
): Concept {
  return {
    id: overrides.id ?? `concept-${sourceTerm}`,
    sourceTerm,
    renderings,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function rule(id: string, check: TranslationRule["check"], enabled = true): TranslationRule {
  return {
    id,
    name: id,
    description: "",
    severity: "minor",
    source: "user",
    scope: "project",
    check,
    enabled,
    createdAt: "2026-01-01T00:00:00.000Z",
  }
}

// ---------------------------------------------------------------------------
// scanTermConsistency
// ---------------------------------------------------------------------------

describe("scanTermConsistency", () => {
  it("counts occurrences and flags cells lacking ALL approved renderings", () => {
    const cells: CheckableCell[] = [
      cell("Ἰησοῦς Χριστός ἐγένετο", "Yesu Kristo alikuja", { cellLabel: "MAT 1:1" }),
      cell("τοῦ Χριστοῦ ἡ γένεσις", "kuzaliwa kwa Kristo", { cellLabel: "MAT 1:18" }),
      cell("Χριστός erchetai", "Masihi anakuja", { cellLabel: "MAT 1:16" }),
      cell("no term here", "hakuna kitu", { cellLabel: "MAT 1:2" }),
    ]
    // Wildcard source form so inflected Χριστοῦ also matches.
    const [finding] = scanTermConsistency(cells, [
      concept("Χριστ*", [{ rendering: "Kristo", status: "preferred" }]),
    ])

    expect(finding).toBeDefined()
    expect(finding.totalOccurrences).toBe(3)
    expect(finding.consistentCount).toBe(2)
    expect(finding.flaggedCells).toEqual([
      { cellId: cells[2].id, cellLabel: "MAT 1:16" },
    ])
    expect(finding.renderingUsage).toEqual([
      { rendering: "Kristo", cellIds: [cells[0].id, cells[1].id] },
    ])
  })

  it("treats ANY approved rendering (preferred or admitted) as consistent", () => {
    const cells: CheckableCell[] = [
      cell("grace upon grace", "gracia sobre gracia"),
      cell("by grace you are saved", "por favor divino sois salvos"),
      cell("the grace of God", "el regalo de Dios"),
    ]
    const [finding] = scanTermConsistency(cells, [
      concept("grace", [
        { rendering: "gracia", status: "preferred" },
        { rendering: "favor divino", status: "admitted" },
        { rendering: "karma", status: "forbidden" }, // never counts as approved
      ]),
    ])

    expect(finding.totalOccurrences).toBe(3)
    expect(finding.consistentCount).toBe(2)
    expect(finding.flaggedCells.map((f) => f.cellId)).toEqual([cells[2].id])
    // Usage is reported per rendering.
    expect(finding.renderingUsage).toEqual([
      { rendering: "gracia", cellIds: [cells[0].id] },
      { rendering: "favor divino", cellIds: [cells[1].id] },
    ])
  })

  it("excludes untranslated cells from the occurrence denominator", () => {
    const cells: CheckableCell[] = [
      cell("Χριστός here", "Kristo hapa"),
      cell("Χριστός not translated yet", ""),
      cell("Χριστός whitespace target", "   "),
    ]
    const [finding] = scanTermConsistency(cells, [
      concept("Χριστός", [{ rendering: "Kristo", status: "preferred" }]),
    ])
    expect(finding.totalOccurrences).toBe(1)
    expect(finding.flaggedCells).toEqual([])
  })

  it("matches with unicode word boundaries, not ASCII \\b", () => {
    const cells: CheckableCell[] = [
      // "gracia" appears inside "desgracia" — must NOT count as the rendering.
      cell("the grace of God", "la desgracia de Dios"),
      // Accented form at a real boundary should match a wildcard rendering.
      cell("full of grace", "llena de gracía"),
    ]
    const [finding] = scanTermConsistency(cells, [
      concept("grace", [{ rendering: "grac*a", status: "preferred" }]),
    ])
    expect(finding.totalOccurrences).toBe(2)
    expect(finding.flaggedCells.map((f) => f.cellId)).toEqual([cells[0].id])
    expect(finding.consistentCount).toBe(1)
  })

  it("returns no finding for concepts with zero occurrences in scope", () => {
    const cells: CheckableCell[] = [cell("plain text", "texto plano")]
    const findings = scanTermConsistency(cells, [
      concept("Χριστός", [{ rendering: "Kristo", status: "preferred" }]),
    ])
    expect(findings).toEqual([])
  })

  it("skips non-active concepts and concepts without approved renderings", () => {
    const cells: CheckableCell[] = [cell("grace and Χριστός", "nothing matching")]
    const findings = scanTermConsistency(cells, [
      concept("grace", [{ rendering: "gracia", status: "preferred" }], {
        status: "draft",
      }),
      concept("Χριστός", [{ rendering: "karma", status: "forbidden" }]),
    ])
    expect(findings).toEqual([])
  })

  it("reports fully consistent concepts so the UI can say 'n of n'", () => {
    const cells: CheckableCell[] = [cell("grace", "gracia")]
    const [finding] = scanTermConsistency(cells, [
      concept("grace", [{ rendering: "gracia", status: "preferred" }]),
    ])
    expect(finding.totalOccurrences).toBe(1)
    expect(finding.consistentCount).toBe(1)
    expect(finding.flaggedCells).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Rule pass helpers
// ---------------------------------------------------------------------------

describe("checkableRules", () => {
  it("excludes disabled rules and term-compiled rules (no double report)", () => {
    const rules = [
      rule("user-1", { type: "target-forbids", targetPattern: "foo" }),
      rule("user-2", { type: "target-forbids", targetPattern: "bar" }, false),
      rule("term:abc:approved", { type: "source-requires-target", sourcePattern: "x", targetPattern: "y" }),
    ]
    expect(checkableRules(rules).map((r) => r.id)).toEqual(["user-1"])
  })
})

describe("groupInfractionsByRule", () => {
  it("groups by rule preserving rule order and dropping clean rules", () => {
    const r1 = rule("r1", { type: "target-forbids", targetPattern: "a" })
    const r2 = rule("r2", { type: "target-forbids", targetPattern: "b" })
    const inf = (ruleId: string, cellId: string) => ({
      ruleId, cellId, fileId: "f", message: "m", spans: [],
    })
    const groups = groupInfractionsByRule(
      [inf("r2", "c1"), inf("r1", "c2"), inf("r2", "c3")],
      [r1, r2],
    )
    expect(groups.map((g) => g.rule.id)).toEqual(["r1", "r2"])
    expect(groups[1].infractions.map((i) => i.cellId)).toEqual(["c1", "c3"])
  })
})

// ---------------------------------------------------------------------------
// runDeterministicCheck (findings assembly)
// ---------------------------------------------------------------------------

describe("runDeterministicCheck", () => {
  it("assembles summary counts, rule groups, and term findings coherently", async () => {
    const cells = [
      cell("Χριστός said", "Kristo alisema!!", { cellLabel: "MAT 1:1" }),
      cell("Χριστός went", "Masihi alienda", { cellLabel: "MAT 1:2" }),
      cell("plain verse", "mstari!! wa kawaida", { cellLabel: "MAT 1:3" }),
    ]
    const rules = [
      rule("no-double-bang", { type: "target-forbids", targetPattern: "!!" }),
      rule("disabled-rule", { type: "target-forbids", targetPattern: "x" }, false),
      rule("term:abc:approved", { type: "source-requires-target", sourcePattern: "Χριστός", targetPattern: "Kristo" }),
    ]
    const concepts = [
      concept("Χριστός", [{ rendering: "Kristo", status: "preferred" }], { id: "abc" }),
      concept("unused", [{ rendering: "z", status: "preferred" }], { status: "deprecated" }),
    ]

    const result = await runDeterministicCheck({ fileId: "file-1", cells, rules, concepts })

    // Summary: what was checked.
    expect(result.fileId).toBe("file-1")
    expect(result.checkedCellCount).toBe(3)
    expect(result.checkedRuleCount).toBe(1) // enabled, non-term
    expect(result.checkedTermCount).toBe(1) // active only
    expect(result.ranAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // Rule findings: "!!" appears in cells 1 and 3.
    expect(result.ruleFindings).toHaveLength(1)
    expect(result.ruleFindings[0].rule.id).toBe("no-double-bang")
    expect(result.ruleFindings[0].infractions.map((i) => i.cellId)).toEqual([
      cells[0].id, cells[2].id,
    ])

    // Term findings: 1 of 2 occurrences flagged.
    expect(result.termFindings).toHaveLength(1)
    expect(result.termFindings[0].totalOccurrences).toBe(2)
    expect(result.termFindings[0].flaggedCells).toEqual([
      { cellId: cells[1].id, cellLabel: "MAT 1:2" },
    ])

    // Total = 2 infractions + 1 flagged term cell.
    expect(result.totalFindingCount).toBe(3)
  })

  it("returns an all-clear result on a clean file (empty-state contract)", async () => {
    const cells = [cell("Χριστός said", "Kristo alisema", { cellLabel: "MAT 1:1" })]
    const result = await runDeterministicCheck({
      fileId: "file-1",
      cells,
      rules: [rule("no-double-bang", { type: "target-forbids", targetPattern: "!!" })],
      concepts: [concept("Χριστός", [{ rendering: "Kristo", status: "preferred" }])],
    })
    expect(result.totalFindingCount).toBe(0)
    expect(result.ruleFindings).toEqual([])
    // Consistent concept still reported (UI may show "1 of 1") but flags none.
    expect(result.termFindings[0].flaggedCells).toEqual([])
    expect(result.checkedCellCount).toBe(1)
  })

  it("stays responsive on large files (chunked loop completes)", async () => {
    const cells = Array.from({ length: 450 }, (_, i) =>
      cell(`Χριστός verse ${i}`, i % 2 === 0 ? "Kristo sawa" : "kitu kingine", {
        id: `c${i}`,
      }),
    )
    const result = await runDeterministicCheck({
      fileId: "file-1",
      cells,
      rules: [],
      concepts: [concept("Χριστός", [{ rendering: "Kristo", status: "preferred" }])],
    })
    expect(result.checkedCellCount).toBe(450)
    expect(result.termFindings[0].totalOccurrences).toBe(450)
    expect(result.termFindings[0].flaggedCells).toHaveLength(225)
  })
})
