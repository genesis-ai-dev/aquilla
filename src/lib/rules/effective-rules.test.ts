import { describe, expect, it } from "vitest"

import type { TranslationRule } from "@/lib/parsers/types"
import { bookGenre } from "@/lib/scripture/book-genres"

import {
  buildLibraryLintResolver,
  NO_LIBRARY_LINT_SIGNATURE,
  type LintCellRef,
} from "./effective-rules"
import { cellCoordinates } from "./applicability"
import type { RuleApplicability, StyleRule } from "./style-rule-types"

// ── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0

function makeRule(overrides: Partial<StyleRule> = {}): StyleRule {
  seq += 1
  return {
    id: `rule-${seq}`,
    orgId: null,
    projectId: "proj-1",
    instruction: "Never write the word banned.",
    category: "style",
    scope: "global",
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
    ...overrides,
  }
}

function makeRow(
  ruleId: string,
  targetType: RuleApplicability["targetType"],
  targetId: string,
  relationship: RuleApplicability["relationship"],
  overrides: Partial<RuleApplicability> = {},
): RuleApplicability {
  seq += 1
  return {
    id: `row-${seq}`,
    ruleId,
    targetType,
    targetId,
    relationship,
    confidence: null,
    reason: null,
    assignedBy: "human",
    createdBy: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

const PROJECT_RULES: TranslationRule[] = [
  {
    id: "term:concept-1:approved",
    name: "Grace",
    description: "Render χάρις as grace.",
    severity: "major",
    source: "user",
    scope: "project",
    check: { type: "source-requires-target", sourcePattern: "grace", targetPattern: "grâce" },
    enabled: true,
    createdAt: "2026-01-01T00:00:00Z",
  },
]

/** file → USFM book, the metadata the caller owns and the composer never sees. */
const BOOK_OF_FILE: Record<string, string> = { "file-psa": "PSA", "file-rom": "ROM" }

function coordsFor(cell: LintCellRef) {
  const bookCode = BOOK_OF_FILE[cell.fileId]
  return cellCoordinates(
    { id: cell.id, group: cell.group, globalReferences: cell.globalReferences },
    { fileId: cell.fileId, ...(bookCode ? { bookCode } : {}) },
    bookGenre,
  )
}

/** PSA → poetry, ROM → epistle: two cells with genuinely different genres. */
const PSALM_CELL = { id: "psa-1", globalReferences: ["PSA 23:1"] }
const PSALM_SIBLING = { id: "psa-2", globalReferences: ["PSA 23:2"] }
const EPISTLE_CELL = { id: "rom-1", globalReferences: ["ROM 1:1"] }

function resolverFor(rules: StyleRule[], rows: RuleApplicability[] = []) {
  return buildLibraryLintResolver({ styleRules: rules, applicability: rows, coordsFor })
}

// ── Composition ─────────────────────────────────────────────────────────────

describe("buildLibraryLintResolver — composition", () => {
  it("hands back the caller's array by reference when the library lints nothing", () => {
    const resolver = resolverFor([])

    expect(resolver.signature).toBe(NO_LIBRARY_LINT_SIGNATURE)
    expect(resolver.rulesForCell(PSALM_CELL, "file-psa", PROJECT_RULES)).toBe(PROJECT_RULES)
    expect(resolverFor([]).signature).toBe(resolver.signature)
  })

  it("keeps the caller's array by reference for a cell no library rule reaches", () => {
    const scoped = makeRule({ scope: "genre" })
    const resolver = resolverFor([scoped], [makeRow(scoped.id, "genre", "poetry", "applies")])

    expect(resolver.rulesForCell(EPISTLE_CELL, "file-rom", PROJECT_RULES)).toBe(PROJECT_RULES)
  })

  it("lints every cell with a global rule that carries no applicability rows", () => {
    const global = makeRule({ scope: "global" })
    const resolver = resolverFor([global])

    for (const [cell, fileId] of [
      [PSALM_CELL, "file-psa"],
      [EPISTLE_CELL, "file-rom"],
    ] as const) {
      const composed = resolver.rulesForCell(cell, fileId, PROJECT_RULES)
      expect(composed.map((r) => r.id)).toEqual(["term:concept-1:approved", `lib:${global.id}`])
    }
  })

  it("lints only the matching genre when the rule is genre-scoped", () => {
    const poetryOnly = makeRule({ scope: "genre" })
    const resolver = resolverFor(
      [poetryOnly],
      [makeRow(poetryOnly.id, "genre", "poetry", "applies")],
    )

    expect(resolver.rulesForCell(PSALM_CELL, "file-psa", PROJECT_RULES).map((r) => r.id)).toContain(
      `lib:${poetryOnly.id}`,
    )
    expect(resolver.rulesForCell(EPISTLE_CELL, "file-rom", PROJECT_RULES).map((r) => r.id)).not.toContain(
      `lib:${poetryOnly.id}`,
    )
  })

  it("counts likely_applies as applying, matching the prompt path", () => {
    const guessed = makeRule({ scope: "genre" })
    const resolver = resolverFor(
      [guessed],
      [makeRow(guessed.id, "genre", "poetry", "likely_applies")],
    )

    expect(resolver.rulesForCell(PSALM_CELL, "file-psa", PROJECT_RULES).map((r) => r.id)).toContain(
      `lib:${guessed.id}`,
    )
  })

  it("drops the rule for one cell when a segment row excludes it", () => {
    const global = makeRule({ scope: "global" })
    const resolver = resolverFor(
      [global],
      [makeRow(global.id, "segment", PSALM_SIBLING.id, "excluded")],
    )

    expect(resolver.rulesForCell(PSALM_CELL, "file-psa", PROJECT_RULES).map((r) => r.id)).toContain(
      `lib:${global.id}`,
    )
    expect(resolver.rulesForCell(PSALM_SIBLING, "file-psa", PROJECT_RULES)).toBe(PROJECT_RULES)
  })

  it("never lints on behalf of proposed, disabled or instruction-only rules", () => {
    const resolver = resolverFor([
      makeRule({ status: "proposed" }),
      makeRule({ status: "rejected" }),
      makeRule({ status: "archived" }),
      makeRule({ enabled: false }),
      makeRule({ checkSpec: null }),
    ])

    expect(resolver.signature).toBe(NO_LIBRARY_LINT_SIGNATURE)
    expect(resolver.rulesForCell(PSALM_CELL, "file-psa", PROJECT_RULES)).toBe(PROJECT_RULES)
  })

  it("composes project rules first, then the library checks in library order", () => {
    const first = makeRule({ scope: "global" })
    const second = makeRule({
      scope: "global",
      checkSpec: { type: "target-forbids", targetPattern: "\\bother\\b" },
    })
    const resolver = resolverFor([first, second])

    expect(
      resolver.rulesForCell(PSALM_CELL, "file-psa", PROJECT_RULES).map((r) => r.id),
    ).toEqual(["term:concept-1:approved", `lib:${first.id}`, `lib:${second.id}`])
  })

  it("recomposes when the caller passes a different project rule set", () => {
    const global = makeRule({ scope: "global" })
    const resolver = resolverFor([global])
    resolver.rulesForCell(PSALM_CELL, "file-psa", PROJECT_RULES)

    const composed = resolver.rulesForCell(PSALM_CELL, "file-psa", [])
    expect(composed.map((r) => r.id)).toEqual([`lib:${global.id}`])
  })

  it("stays correct once the coordinate cache is dropped", () => {
    const global = makeRule({ scope: "global" })
    const resolver = resolverFor(
      [global],
      [makeRow(global.id, "segment", PSALM_SIBLING.id, "excluded")],
    )

    // Segment rows make every cell its own cache key; walk past the bound.
    for (let i = 0; i < 600; i++) {
      resolver.rulesForCell({ id: `filler-${i}` }, "file-psa", PROJECT_RULES)
    }

    expect(resolver.rulesForCell(PSALM_SIBLING, "file-psa", PROJECT_RULES)).toBe(PROJECT_RULES)
    expect(resolver.rulesForCell(PSALM_CELL, "file-psa", PROJECT_RULES).map((r) => r.id)).toContain(
      `lib:${global.id}`,
    )
  })

  it("carries the compiled check through so the rule engine can run it", () => {
    const global = makeRule({ scope: "global" })
    const [, compiled] = resolverFor([global]).rulesForCell(PSALM_CELL, "file-psa", PROJECT_RULES)

    expect(compiled.check).toEqual({ type: "target-forbids", targetPattern: "\\bbanned\\b" })
    expect(compiled.enabled).toBe(true)
  })
})

// ── Signature ───────────────────────────────────────────────────────────────

describe("buildLibraryLintResolver — signature", () => {
  it("changes when a rule's check changes", () => {
    const before = resolverFor([makeRule({ id: "r1" })])
    const after = resolverFor([
      makeRule({ id: "r1", checkSpec: { type: "target-forbids", targetPattern: "\\bdifferent\\b" } }),
    ])

    expect(after.signature).not.toBe(before.signature)
  })

  it("changes when a rule is approved", () => {
    const proposed = resolverFor([makeRule({ id: "r1", status: "proposed" })])
    const approved = resolverFor([makeRule({ id: "r1", status: "approved" })])

    expect(proposed.signature).toBe(NO_LIBRARY_LINT_SIGNATURE)
    expect(approved.signature).not.toBe(proposed.signature)
  })

  it("changes when a rule is disabled", () => {
    const enabled = resolverFor([makeRule({ id: "r1" })])
    const disabled = resolverFor([makeRule({ id: "r1", enabled: false })])

    expect(disabled.signature).not.toBe(enabled.signature)
  })

  it("changes when an applicability row is added, retargeted or flipped", () => {
    const rule = makeRule({ id: "r1", scope: "genre" })
    const none = resolverFor([rule]).signature
    const applies = resolverFor([rule], [makeRow("r1", "genre", "poetry", "applies")]).signature
    const retargeted = resolverFor([rule], [makeRow("r1", "genre", "gospel", "applies")]).signature
    const excluded = resolverFor([rule], [makeRow("r1", "genre", "poetry", "excluded")]).signature

    expect(new Set([none, applies, retargeted, excluded]).size).toBe(4)
  })

  it("does not change on edits that cannot move a lint outcome", () => {
    const rows = [makeRow("r1", "genre", "poetry", "applies")]
    const base = resolverFor([makeRule({ id: "r1", scope: "genre" })], rows).signature

    const reworded = resolverFor(
      [
        makeRule({
          id: "r1",
          scope: "genre",
          conditions: "only in direct speech",
          examples: [{ before: "a", after: "b" }],
          exceptions: "except in titles",
          humanEdited: true,
          version: 9,
          updatedAt: "2026-02-02T00:00:00Z",
        }),
      ],
      rows,
    ).signature
    const rowRestated = resolverFor(
      [makeRule({ id: "r1", scope: "genre" })],
      [
        makeRow("r1", "genre", "poetry", "applies", {
          id: "row-reissued",
          confidence: 0.5,
          reason: "model guess",
          assignedBy: "model",
          updatedAt: "2026-02-02T00:00:00Z",
        }),
      ],
    ).signature

    expect(reworded).toBe(base)
    expect(rowRestated).toBe(base)
  })

  it("ignores row order but not rule order", () => {
    const a = makeRule({ id: "r1", scope: "genre" })
    const b = makeRule({
      id: "r2",
      scope: "genre",
      checkSpec: { type: "target-forbids", targetPattern: "\\bother\\b" },
    })
    const rows = [makeRow("r1", "genre", "poetry", "applies"), makeRow("r2", "book", "PSA", "applies")]

    expect(resolverFor([a, b], [...rows].reverse()).signature).toBe(
      resolverFor([a, b], rows).signature,
    )
    expect(resolverFor([b, a], rows).signature).not.toBe(resolverFor([a, b], rows).signature)
  })

  it("ignores rows belonging to rules that cannot lint", () => {
    const lintable = makeRule({ id: "r1", scope: "genre" })
    const instructionOnly = makeRule({ id: "r2", checkSpec: null })
    const rows = [makeRow("r1", "genre", "poetry", "applies")]

    expect(
      resolverFor(
        [lintable, instructionOnly],
        [...rows, makeRow("r2", "genre", "gospel", "applies")],
      ).signature,
    ).toBe(resolverFor([lintable], rows).signature)
  })
})
