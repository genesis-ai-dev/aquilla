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
import { resolveBuiltinRules } from "@/lib/lqa/builtin-resolver"
import { JHN_A_STRUCTURE } from "../../../db/shared/bible-checks/__fixtures__/pack-a"
import { JHN_B_PEOPLE, JHN_B_STRUCTURE, JHN_B_TEXT, JHN_B_VOICES } from "../../../db/shared/bible-checks/__fixtures__/pack-b"
import { buildNameTable } from "../../../db/shared/bible-checks/agreed-names"
import { buildCellCheckContexts } from "@/lib/bible-data/check-context"
import { checkRulesForCell } from "@/lib/rules/rule-engine"
import {
  scanTermConsistency,
  scanCapitalization,
  scanSpelling,
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
// scanCapitalization (AQU-1734)
// ---------------------------------------------------------------------------

describe("scanCapitalization", () => {
  it("flags a one-off mixed-case typo, grouped by the offending form", () => {
    const cells = [
      cell("He said the word", "Alisema tHe neno", { cellLabel: "MAT 1:1" }),
      cell("He went", "Alienda", { cellLabel: "MAT 1:2" }),
    ]
    const { findings, exceptions } = scanCapitalization(cells)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ code: "mixed-case", form: "tHe" })
    expect(findings[0].cells).toEqual([{ cellId: cells[0].id, cellLabel: "MAT 1:1" }])
    expect(exceptions).toEqual([])
  })

  it("proposes a recurring lowercase-prefix pattern as an exception instead of flagging every cell", () => {
    // The failure this guards: 40 cells using the project's own noun-class
    // prefix would otherwise be 40 findings nobody can act on.
    const cells = Array.from({ length: 40 }, (_, i) =>
      cell(`verse ${i}`, i % 2 === 0 ? `wanasema kiSwahili ${i}` : `lugha ya kiNgozi ${i}`, {
        id: `c${i}`,
      }),
    )
    const { findings, exceptions } = scanCapitalization(cells)
    expect(findings).toEqual([])
    expect(exceptions.map((e) => e.form)).toEqual(["ki-"])
    expect(exceptions[0].examples).toEqual(["kiNgozi", "kiSwahili"])
  })

  it("keeps flagging a genuine typo in a project that has learned exceptions", () => {
    const cells = [
      cell("a", "kiSwahili moja"),
      cell("b", "kiSwahili mbili"),
      cell("c", "kiNgozi tatu"),
      cell("d", "hii ni tHe typo", { cellLabel: "MAT 1:4" }),
    ]
    const { findings, exceptions } = scanCapitalization(cells)
    expect(exceptions.map((e) => e.form)).toEqual(["ki-"])
    expect(findings.map((f) => f.form)).toEqual(["tHe"])
  })

  it("excepts a form the source already writes that way", () => {
    const cells = [cell("Buy an iPhone", "Nunua iPhone")]
    expect(scanCapitalization(cells).findings).toEqual([])
  })

  it("flags a heading cell that opens with a lowercase letter, never a body cell", () => {
    const cells = [
      cell("The call of Simon", "mwito wa Simoni", { type: "heading", cellLabel: "MRK 1:16" }),
      cell("to Simon, Put out into the deep", "kwa Simoni, shusha nyavu", { cellLabel: "MRK 1:17" }),
    ]
    const { findings } = scanCapitalization(cells)
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe("lowercase-heading-start")
    expect(findings[0].cells).toEqual([{ cellId: cells[0].id, cellLabel: "MRK 1:16" }])
  })

  it("produces no findings for a caseless-script project", () => {
    const cells = [
      cell("He said to him", "وَقَالَ لَهُ", { cellLabel: "MAT 1:1" }),
      cell("The call of Simon", "دَعْوَةُ سِمْعَانَ", { type: "heading", cellLabel: "MRK 1:16" }),
      cell("He said", "他说。", { cellLabel: "MAT 1:2" }),
    ]
    const { findings, exceptions } = scanCapitalization(cells)
    expect(findings).toEqual([])
    expect(exceptions).toEqual([])
  })

  it("ignores untranslated cells", () => {
    expect(scanCapitalization([cell("He said tHe word", "")]).findings).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Rule pass helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// scanSpelling (AQU-1737)
// ---------------------------------------------------------------------------

describe("scanSpelling", () => {
  /** Writes "Yesu" four times and "Yeesu" once, with English sources. */
  function yesuCells(): CellData[] {
    return [
      cell("Jesus said", "Yesu akasema", { cellLabel: "MRK 1:1" }),
      cell("Jesus answered", "Yesu alijibu", { cellLabel: "MRK 1:2" }),
      cell("Jesus went", "Yesu akaenda", { cellLabel: "MRK 1:3" }),
      cell("Jesus called them", "Yesu akawaita", { cellLabel: "MRK 1:4" }),
      cell("Jesus said again", "Yeesu akasema tena", { cellLabel: "MRK 1:5" }),
    ]
  }

  it("flags a one-off variant of a frequent form and suggests that form", () => {
    const cells = yesuCells()
    const { findings, wordlistSize } = scanSpelling(cells, { minCommonOccurrences: 3 })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      form: "Yeesu",
      suggestion: "Yesu",
      suggestionOccurrences: 4,
      reason: "sound-alike",
    })
    expect(findings[0].cells).toEqual([{ cellId: cells[4].id, cellLabel: "MRK 1:5" }])
    expect(wordlistSize).toBeGreaterThan(0)
  })

  it("builds the wordlist from the target text, not the source", () => {
    // "Jesus" is written five times in the source and never in the target, so
    // it must not be in the project's wordlist — nor its source-only
    // neighbours be offered as corrections of target words.
    const { wordlistSize } = scanSpelling(
      [cell("Jesus Jesus Jesus", "Yesu", { cellLabel: "MRK 1:1" })],
      { minCommonOccurrences: 1 },
    )
    expect(wordlistSize).toBe(1)
  })

  it("never flags a form the source text already writes that way", () => {
    // A name carried over from the source is not the translator's spelling.
    const cells = [
      cell("Paul wrote", "Paulo aliandika"),
      cell("Paul said", "Paulo alisema"),
      cell("Paul went", "Paulo alienda"),
      cell("Paolo greeted", "Paolo alisalimu"),
    ]
    const { findings } = scanSpelling(cells, { minCommonOccurrences: 3 })
    expect(findings.map((f) => f.form)).not.toContain("Paolo")
  })

  it("reports what frequency let through instead of passing silently", () => {
    const cells = Array.from({ length: 100 }, (_, i) =>
      cell(`verse ${i}`, "Yesu", { id: `y${i}` }),
    )
    const { approved, findings } = scanSpelling(cells)
    expect(approved).toEqual([{ form: "Yesu", occurrences: 100 }])
    expect(findings).toEqual([])
  })

  it("has nothing to say about a scope with no translated cells", () => {
    expect(scanSpelling([cell("Jesus said", "")])).toEqual({
      findings: [],
      approved: [],
      wordlistSize: 0,
    })
  })

  it("stays quiet about a form the reviewer approved", () => {
    const { findings } = scanSpelling(yesuCells(), {
      minCommonOccurrences: 3,
      approved: new Set(["Yeesu"]),
    })
    expect(findings).toEqual([])
  })

  it("rides runDeterministicCheck and counts toward its total", async () => {
    const result = await runDeterministicCheck({
      fileId: "file-1",
      cells: yesuCells(),
      rules: [],
      concepts: [],
      spelling: { minCommonOccurrences: 3 },
    })
    expect(result.spellingFindings.map((f) => f.form)).toEqual(["Yeesu"])
    expect(result.wordlistSize).toBeGreaterThan(0)
    expect(result.totalFindingCount).toBe(1)
  })
})

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
      ruleId, cellId, fileId: "f", reason: "target-forbids" as const, spans: [],
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

    // Capitalization: nothing mixed-case in these targets.
    expect(result.capitalizationFindings).toEqual([])
    expect(result.caseExceptions).toEqual([])

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
    expect(result.capitalizationFindings).toEqual([])
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

// ---------------------------------------------------------------------------
// AQU-1667: Number integrity with Arabic-Indic / Persian digits, end to end
// ---------------------------------------------------------------------------

describe("Number integrity through Check file and the editor (AQU-1667)", () => {
  it("accepts native digits and still flags a wrong number, with the source underline in place", async () => {
    // The real built-in rule exactly as useRules hands it to both surfaces.
    const rules = resolveBuiltinRules(undefined).filter((r) => r.id === "builtin:number-integrity")
    expect(rules).toHaveLength(1)
    expect(rules[0].enabled).toBe(true)

    const cells = [
      cell("Isaiah 40:25", "إشعياء ٤٠:٢٥", { id: "arabic", cellLabel: "ISA 40:25" }),
      cell("Isaiah 40:25", "اشعیا ۴۰:۲۵", { id: "persian", cellLabel: "ISA 40:25" }),
      cell("Isaiah 40:25", "یسعیاہ ۴٠:25", { id: "mixed", cellLabel: "ISA 40:25" }),
      cell("Isaiah 40:25", "إشعياء ٤١:٢٥", { id: "wrong", cellLabel: "ISA 40:25" }),
      cell("Isaiah 40:25", "Isaías 40:25", { id: "western", cellLabel: "ISA 40:25" }),
    ]

    // Check file.
    const result = await runDeterministicCheck({ fileId: "file-1", cells, rules, concepts: [] })
    expect(result.ruleFindings).toHaveLength(1)
    expect(result.ruleFindings[0].rule.id).toBe("builtin:number-integrity")
    expect(result.ruleFindings[0].infractions).toEqual([
      {
        ruleId: "builtin:number-integrity",
        cellId: "wrong",
        fileId: "file-1",
        reason: "builtin:number-integrity",
        reasonParams: undefined,
        spans: [{ side: "source", start: 7, end: 9, matchedText: "40" }],
      },
    ])
    expect(result.totalFindingCount).toBe(1)

    // Editor underline (useHealth runs this same call per cell).
    const editor = Object.fromEntries(
      cells.map((c) => [c.id, checkRulesForCell(c, c.fileId, rules)]),
    )
    expect(editor.arabic).toEqual([])
    expect(editor.persian).toEqual([])
    expect(editor.mixed).toEqual([])
    expect(editor.western).toEqual([])
    expect(editor.wrong).toEqual(result.ruleFindings[0].infractions)
  })
})

// ---------------------------------------------------------------------------
// AQU-1761: Extra numbers, the other direction, end to end
// ---------------------------------------------------------------------------

describe("Extra numbers through Check file and the editor (AQU-1761)", () => {
  const cells = [
    cell("He fasted forty days.", "Il jeûna 40 jours.", { id: "added", cellLabel: "MAT 4:2" }),
    cell("He fasted 40 days.", "Il jeûna 41 jours.", { id: "changed", cellLabel: "MAT 4:2" }),
    cell("He fasted 40 days.", "Il jeûna 40 jours.", { id: "clean", cellLabel: "MAT 4:2" }),
  ]

  it("is on by default as a minor check, and flags only what the translation added", async () => {
    const rules = resolveBuiltinRules(undefined).filter((r) => r.id === "builtin:number-integrity-extra")
    expect(rules).toHaveLength(1)
    expect(rules[0].enabled).toBe(true)
    expect(rules[0].severity).toBe("minor")

    const result = await runDeterministicCheck({ fileId: "file-1", cells, rules, concepts: [] })
    expect(result.ruleFindings).toHaveLength(1)
    expect(result.ruleFindings[0].infractions.map((i) => [i.cellId, i.reason, i.spans])).toEqual([
      ["added", "builtin:number-integrity-extra", [{ side: "target", start: 9, end: 11, matchedText: "40" }]],
      ["changed", "builtin:number-integrity-extra", [{ side: "target", start: 9, end: 11, matchedText: "41" }]],
    ])

    // The editor runs the same call per cell.
    expect(checkRulesForCell(cells[2], cells[2].fileId, rules)).toEqual([])
    expect(checkRulesForCell(cells[0], cells[0].fileId, rules)).toEqual([result.ruleFindings[0].infractions[0]])
  })

  it("has its own switch and severity, apart from Number integrity", async () => {
    const all = resolveBuiltinRules({ "number-integrity-extra": { enabled: false } })
    expect(all.find((r) => r.id === "builtin:number-integrity-extra")!.enabled).toBe(false)
    expect(all.find((r) => r.id === "builtin:number-integrity")!.enabled).toBe(true)
    const result = await runDeterministicCheck({ fileId: "file-1", cells, rules: all, concepts: [] })
    expect(result.ruleFindings.map((f) => f.rule.id)).not.toContain("builtin:number-integrity-extra")

    const major = resolveBuiltinRules({ "number-integrity-extra": { enabled: true, severity: "major" } })
    expect(major.find((r) => r.id === "builtin:number-integrity-extra")!.severity).toBe("major")
  })
})

// AQU-1697: the Bible data scans (S1 headings, S8 verse numbering) need the
// whole file in order, so they run here and nowhere else. WHY: their findings
// must reach the same drawer as every other rule, under their own built-in
// rule, and only when the project has that rule switched on.
describe("runDeterministicCheck with the Bible data scans", () => {
  const verse = (ref: string) => cell("src", "text", { id: ref, globalReferences: [ref] })
  const heading = cell("The Wedding", "La noce", { id: "h1", type: "heading", globalReferences: ["JHN 2:s1:1"] })
  const cells = [heading, ...Array.from({ length: 25 }, (_, i) => verse(`JHN 2:${i + 1}`))]
  const bibleRules = resolveBuiltinRules(undefined, { bibleChecks: true })
  const bibleScan = { structure: JHN_A_STRUCTURE, profile: { headings: "pericope" as const } }

  it("reports a passage without a heading under the S1 rule", async () => {
    const result = await runDeterministicCheck({ fileId: "file-1", cells, rules: bibleRules, concepts: [], bibleScan })
    const s1 = result.ruleFindings.find((group) => group.rule.id === "builtin:bkp:S1")
    expect(s1?.infractions).toEqual([
      expect.objectContaining({
        cellId: "JHN 2:13",
        fileId: "file-1",
        reason: "builtin:bkp:S1",
        reasonParams: expect.objectContaining({ kind: "heading-missing", evidence: "pericope", refs: "JHN 2:13" }),
      }),
    ])
    expect(result.totalFindingCount).toBe(1)
  })

  it("reports nothing for a switched-off scan, a dormant one, or without the pack data", async () => {
    const off = resolveBuiltinRules({ "bkp:S1": { enabled: false } }, { bibleChecks: true })
    expect((await runDeterministicCheck({ fileId: "file-1", cells, rules: off, concepts: [], bibleScan })).totalFindingCount).toBe(0)
    const dormant = { ...bibleScan, profile: {} }
    expect((await runDeterministicCheck({ fileId: "file-1", cells, rules: bibleRules, concepts: [], bibleScan: dormant })).totalFindingCount).toBe(0)
    expect((await runDeterministicCheck({ fileId: "file-1", cells, rules: bibleRules, concepts: [] })).totalFindingCount).toBe(0)
  })
})

// AQU-1699: the pack-B scans (P2 one name across the file, X3 repeated
// quotations) take the same path. WHY: the scan input useBibleChecks.fileScan
// builds (each cell's compiled expectation, with its participants) must reach
// the rule pass, read each cell's translation, and report under P2's own rule.
describe("runDeterministicCheck with the check-pack-B scans", () => {
  const decide = (key: string, value: string) => ({ id: key, key, value, scope: {}, author: "dev", at: "2026-10-06T00:00:00.000Z" })
  const names = buildNameTable({
    people: JHN_B_PEOPLE,
    text: JHN_B_TEXT,
    facts: [decide("render.person.Peter", "Peter|Simon Peter")],
    sourceLanguage: "en",
  })
  const cells = [
    cell("src", "She ran to Simon Peter.", { id: "a", globalReferences: ["JHN 20:2"] }),
    cell("src", "She came to Simon Peter.", { id: "b", globalReferences: ["JHN 20:2"] }),
    cell("src", "She ran to Peter.", { id: "c", globalReferences: ["JHN 20:2"] }),
  ]
  const contexts = buildCellCheckContexts(cells, JHN_B_VOICES, JHN_B_STRUCTURE, {}, JHN_B_TEXT, { people: JHN_B_PEOPLE, names })
  const expectations = new Map([...contexts].flatMap(([id, context]) => (context.bible ? [[id, context.bible.expectation] as const] : [])))
  const bibleRules = resolveBuiltinRules(undefined, { bibleChecks: true })
  const bibleScan = { structure: JHN_B_STRUCTURE, profile: {}, voices: JHN_B_VOICES, text: JHN_B_TEXT, expectations, readiness: names.readiness }

  it("reports the cell out of line with the file under the P2 rule", async () => {
    const result = await runDeterministicCheck({ fileId: "file-1", cells, rules: bibleRules, concepts: [], bibleScan })
    const p2 = result.ruleFindings.find((group) => group.rule.id === "builtin:bkp:P2")
    expect(p2?.infractions).toEqual([
      expect.objectContaining({
        cellId: "c",
        reason: "builtin:bkp:P2",
        reasonParams: expect.objectContaining({ kind: "name-variant-different", found: "Peter", usual: "Simon Peter", entity: "person:Peter" }),
      }),
    ])
  })

  it("reports nothing while the names are not decided", async () => {
    const undecided = { ...bibleScan, readiness: { ...names.readiness, agreedNames: false } }
    const result = await runDeterministicCheck({ fileId: "file-1", cells, rules: bibleRules, concepts: [], bibleScan: undecided })
    expect(result.ruleFindings.find((group) => group.rule.id === "builtin:bkp:P2")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Cross-cell quotation continuity (AQU-1733)
// ---------------------------------------------------------------------------

describe("Quotation left open across cells (AQU-1733)", () => {
  const quoteRules = resolveBuiltinRules(undefined).filter((r) => r.id === "builtin:unpaired-quotes")

  it("is on by default as a minor check", () => {
    expect(quoteRules).toHaveLength(1)
    expect(quoteRules[0].enabled).toBe(true)
    expect(quoteRules[0].severity).toBe("minor")
  })

  // The case no per-cell check can reach: the SOURCE carries the same
  // imbalance (here, and always for a source that marks no quotations at all),
  // so `unpaired-quotes` deliberately goes quiet on each cell in turn.
  const opened = cell("And he said, “Follow me,", "Et il dit : « Suivez-moi,", { id: "opens" })
  const continued = cell("and I will make you fishers of men.", "et je vous ferai pêcheurs d’hommes.", { id: "continues" })

  it("the per-cell check alone says nothing about it", () => {
    for (const c of [opened, continued]) {
      expect(checkRulesForCell(c, "file-1", quoteRules)).toEqual([])
    }
  })

  it("Check file flags it, on the cell that opened the quotation", async () => {
    const result = await runDeterministicCheck({
      fileId: "file-1",
      cells: [opened, continued],
      rules: quoteRules,
      concepts: [],
    })
    expect(result.ruleFindings).toHaveLength(1)
    expect(result.ruleFindings[0].infractions).toEqual([
      expect.objectContaining({
        cellId: "opens",
        reason: "builtin:unpaired-quotes",
        spans: [{ side: "target", start: 12, end: 13, matchedText: "«" }],
      }),
    ])
    expect(result.totalFindingCount).toBe(1)
  })

  it("needs no configuration — nothing is passed but the project's own cells", async () => {
    // The marks are read off the text itself (`inferQuoteMarks`), so a project
    // that never filled the Language profile's quotation slot still gets the
    // check. A recorded profile overrides it: under English marks the same
    // French text has no quotation marks at all.
    const result = await runDeterministicCheck({
      fileId: "file-1",
      cells: [opened, continued],
      rules: quoteRules,
      concepts: [],
      languageProfile: { quoteMarks: { levels: [{ open: "“", close: "”" }], continuation: "reopen-each-paragraph" } },
    })
    expect(result.ruleFindings).toEqual([])
  })

  it("stays quiet once the quotation is closed, withdrawing the per-cell false alarm", async () => {
    // The closing verse holds one quotation mark and nothing in its own text
    // to pair it with, and its source marks no quotations at all, so the
    // per-cell check reports it. The file pairs it with the « two cells back,
    // so Check file must not.
    const closed = cell("and I will make you fishers of men.", "et je vous ferai pêcheurs d’hommes. »", { id: "closes" })
    expect(checkRulesForCell(closed, "file-1", quoteRules)).toEqual([
      expect.objectContaining({ cellId: "closes", reason: "builtin:unpaired-quotes" }),
    ])
    const result = await runDeterministicCheck({
      fileId: "file-1",
      cells: [opened, closed],
      rules: quoteRules,
      concepts: [],
    })
    expect(result.ruleFindings).toEqual([])
    expect(result.totalFindingCount).toBe(0)
  })

  it("stays quiet where the translation simply stops", async () => {
    // The closing mark may be in the verse nobody has translated yet; a
    // half-translated book must not report its whole quoted discourse.
    const untranslated = cell("and I will make you fishers of men.", "", { id: "untranslated" })
    const later = cell("Immediately they left their nets.", "Aussitôt ils laissèrent leurs filets.", { id: "later" })
    const result = await runDeterministicCheck({
      fileId: "file-1",
      cells: [opened, untranslated, later],
      rules: quoteRules,
      concepts: [],
    })
    expect(result.ruleFindings).toEqual([])
  })

  it("reports one row when both passes see the same missing partner", async () => {
    // Inside one cell the per-cell check fires too (the source is balanced
    // here). The reviewer gets one finding, not two.
    const inCell = cell("He said come with me.", "He said, “Come with me.", { id: "in-cell" })
    expect(checkRulesForCell(inCell, "file-1", quoteRules)).toHaveLength(1)
    const result = await runDeterministicCheck({
      fileId: "file-1",
      cells: [inCell],
      rules: quoteRules,
      concepts: [],
    })
    expect(result.ruleFindings[0].infractions).toHaveLength(1)
  })

  it("reports nothing when the project turned the check off", async () => {
    const off = quoteRules.map((r) => ({ ...r, enabled: false }))
    const result = await runDeterministicCheck({
      fileId: "file-1",
      cells: [opened, continued],
      rules: off,
      concepts: [],
    })
    expect(result.ruleFindings).toEqual([])
  })
})
