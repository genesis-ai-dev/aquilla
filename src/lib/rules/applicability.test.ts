import { describe, expect, it } from "vitest"
import { bookGenre } from "@/lib/scripture/book-genres"
import {
  buildApplicabilityIndex,
  cellCoordinates,
  parsePassageRef,
  resolveEffectiveRules,
} from "./applicability"
import type { CellCoordinates, RuleApplicability, StyleRule } from "./style-rule-types"

// ── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0

function makeRule(overrides: Partial<StyleRule> = {}): StyleRule {
  seq += 1
  return {
    id: `rule-${seq}`,
    orgId: null,
    projectId: "proj-1",
    instruction: "Do the thing.",
    category: "style",
    scope: "global",
    conditions: null,
    examples: null,
    exceptions: null,
    source: null,
    checkSpec: null,
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

/** Coordinates for a PSA 23:1 scripture cell — every ladder rung populated. */
const PSA_COORDS: CellCoordinates = {
  segment: "cell-1",
  passageRef: "PSA 23:1",
  section: "PSA 23",
  book: "PSA",
  file: "file-psa",
  genre: "poetry",
}

function resolve(rules: StyleRule[], rows: RuleApplicability[], coords: CellCoordinates) {
  return resolveEffectiveRules(rules, buildApplicabilityIndex(rows), coords)
}

// ── parsePassageRef ─────────────────────────────────────────────────────────

describe("parsePassageRef", () => {
  it("parses single-verse refs", () => {
    expect(parsePassageRef("LUK 1:1")).toEqual({ book: "LUK", chapter: 1, verseStart: 1, verseEnd: 1 })
  })

  it("parses same-chapter ranges", () => {
    expect(parsePassageRef("LUK 1:1-4")).toEqual({ book: "LUK", chapter: 1, verseStart: 1, verseEnd: 4 })
  })

  it("uppercases the book and tolerates surrounding whitespace", () => {
    expect(parsePassageRef("  luk 1:2 ")).toEqual({ book: "LUK", chapter: 1, verseStart: 2, verseEnd: 2 })
  })

  it("rejects chapter labels, prose, opaque ids, and descending ranges", () => {
    expect(parsePassageRef("LUK 1")).toBeNull()
    expect(parsePassageRef("not a ref")).toBeNull()
    expect(parsePassageRef("0198c9c2-7b7a-7abc-8def-0123456789ab")).toBeNull()
    expect(parsePassageRef("LUK 1:4-1")).toBeNull()
  })
})

// ── cellCoordinates ─────────────────────────────────────────────────────────

describe("cellCoordinates", () => {
  it("derives passage/section/book/genre from the first globalReference", () => {
    const coords = cellCoordinates(
      { id: "cell-1", globalReferences: ["PSA 23:1", "PSA 23:2"] },
      { fileId: "file-psa" },
      bookGenre,
    )
    expect(coords).toEqual(PSA_COORDS)
  })

  it("lets an explicit genre assignment beat the one derived from the book", () => {
    const coords = cellCoordinates(
      { id: "cell-1", globalReferences: ["PSA 23:1"] },
      { fileId: "file-psa", bookCode: "PSA", genre: "teaching" },
      bookGenre,
    )
    expect(coords.genre).toBe("teaching")
    // Reclassifying genre must not disturb the other coordinates.
    expect(coords.book).toBe("PSA")
    expect(coords.section).toBe("PSA 23")
  })

  it("gives a non-scripture file a genre only from an assignment", () => {
    const unassigned = cellCoordinates({ id: "c" }, { fileId: "notes" }, bookGenre)
    expect(unassigned.genre).toBeUndefined()

    const assigned = cellCoordinates(
      { id: "c" },
      { fileId: "notes", genre: "Dialogue" },
      bookGenre,
    )
    expect(assigned.genre).toBe("dialogue")
    expect(assigned.book).toBeUndefined()
  })

  it("ignores a blank assignment rather than blanking the derived genre", () => {
    const coords = cellCoordinates(
      { id: "c", globalReferences: ["PSA 23:1"] },
      { fileId: "f", bookCode: "PSA", genre: "   " },
      bookGenre,
    )
    expect(coords.genre).toBe("poetry")
  })

  it("slices section at the first colon, keeping ranges intact", () => {
    const coords = cellCoordinates(
      { id: "c", globalReferences: ["LUK 1:1-2"] },
      { fileId: "f" },
      bookGenre,
    )
    expect(coords.section).toBe("LUK 1")
    expect(coords.passageRef).toBe("LUK 1:1-2")
  })

  it("falls back to group only when it parses as a verse span", () => {
    const fromGroup = cellCoordinates(
      { id: "c", group: "LUK 1:3" },
      { fileId: "f" },
      bookGenre,
    )
    expect(fromGroup.passageRef).toBe("LUK 1:3")
    expect(fromGroup.section).toBe("LUK 1")
    expect(fromGroup.book).toBe("LUK")

    const opaque = cellCoordinates(
      { id: "c", group: "0198c9c2-7b7a-7abc-8def-0123456789ab" },
      { fileId: "f" },
      bookGenre,
    )
    expect(opaque).toEqual({ segment: "c", file: "f" })
  })

  it("prefers the file's bookCode over the ref-derived book", () => {
    const coords = cellCoordinates(
      { id: "c", globalReferences: ["PSA 23:1"] },
      { fileId: "f", bookCode: "luk" },
      bookGenre,
    )
    expect(coords.book).toBe("LUK")
    expect(coords.genre).toBe("gospel")
  })

  it("yields only segment+file for non-scripture cells", () => {
    const coords = cellCoordinates({ id: "c" }, { fileId: "f" }, bookGenre)
    expect(coords).toEqual({ segment: "c", file: "f" })
  })

  it("omits genre when the lookup has no answer", () => {
    const coords = cellCoordinates(
      { id: "c" },
      { fileId: "f", bookCode: "XYZ" },
      bookGenre,
    )
    expect(coords.book).toBe("XYZ")
    expect(coords.genre).toBeUndefined()
  })
})

// ── resolveEffectiveRules ───────────────────────────────────────────────────

describe("resolveEffectiveRules", () => {
  it("defaults global rules in (via 'global') with no rows at all", () => {
    const rule = makeRule({ scope: "global" })
    expect(resolve([rule], [], PSA_COORDS)).toEqual([{ rule, via: "global", likely: false }])
  })

  it("leaves non-global rules dormant when no row matches", () => {
    const genreRule = makeRule({ scope: "genre" })
    const bookRule = makeRule({ scope: "document" })
    // A row for a DIFFERENT genre/book still leaves the rule dormant here.
    const rows = [
      makeRow(genreRule.id, "genre", "epistle", "applies"),
      makeRow(bookRule.id, "book", "LUK", "applies"),
    ]
    expect(resolve([genreRule, bookRule], rows, PSA_COORDS)).toEqual([])
  })

  it("inherits in from a matching genre row", () => {
    const rule = makeRule({ scope: "genre" })
    const rows = [makeRow(rule.id, "genre", "poetry", "applies")]
    expect(resolve([rule], rows, PSA_COORDS)).toEqual([{ rule, via: "genre", likely: false }])
  })

  it("inherits in from a matching book row", () => {
    const rule = makeRule({ scope: "document" })
    const rows = [makeRow(rule.id, "book", "PSA", "applies")]
    expect(resolve([rule], rows, PSA_COORDS)).toEqual([{ rule, via: "book", likely: false }])
  })

  it("inherits in from a matching file row", () => {
    const rule = makeRule({ scope: "document" })
    const rows = [makeRow(rule.id, "file", "file-psa", "applies")]
    expect(resolve([rule], rows, PSA_COORDS)).toEqual([{ rule, via: "file", likely: false }])
  })

  it("normalizes genre/book/section target ids for matching", () => {
    const rule = makeRule({ scope: "genre" })
    const rows = [makeRow(rule.id, "genre", " Poetry ", "applies")]
    expect(resolve([rule], rows, PSA_COORDS)).toHaveLength(1)

    const sectionRule = makeRule({ scope: "section" })
    const sectionRows = [makeRow(sectionRule.id, "section", "psa 23", "applies")]
    expect(resolve([sectionRule], sectionRows, PSA_COORDS)).toEqual([
      { rule: sectionRule, via: "section", likely: false },
    ])
  })

  it("lets a narrower exclusion override a broader inclusion", () => {
    const rule = makeRule({ scope: "genre" })
    const rows = [
      makeRow(rule.id, "genre", "poetry", "applies"),
      makeRow(rule.id, "book", "PSA", "excluded"),
    ]
    expect(resolve([rule], rows, PSA_COORDS)).toEqual([])
    // …while a cell in another poetry book still inherits the genre row.
    const sngCoords: CellCoordinates = { ...PSA_COORDS, book: "SNG", file: "file-sng", section: undefined, passageRef: undefined }
    expect(resolve([rule], rows, sngCoords)).toEqual([{ rule, via: "genre", likely: false }])
  })

  it("lets a narrower inclusion override a broader exclusion", () => {
    const rule = makeRule({ scope: "global" })
    const rows = [
      makeRow(rule.id, "book", "PSA", "excluded"),
      makeRow(rule.id, "segment", "cell-1", "applies"),
    ]
    expect(resolve([rule], rows, PSA_COORDS)).toEqual([{ rule, via: "segment", likely: false }])
  })

  it("excludes a global rule via a segment-level exclusion", () => {
    const rule = makeRule({ scope: "global" })
    const rows = [makeRow(rule.id, "segment", "cell-1", "excluded")]
    expect(resolve([rule], rows, PSA_COORDS)).toEqual([])
    // Sibling segments keep the global default.
    const sibling: CellCoordinates = { ...PSA_COORDS, segment: "cell-2" }
    expect(resolve([rule], rows, sibling)).toEqual([{ rule, via: "global", likely: false }])
  })

  it("resolves a same-specificity tie in favor of excluded", () => {
    const rule = makeRule({ scope: "passage" })
    const rows = [
      makeRow(rule.id, "passage", "PSA 23:1-6", "applies"),
      makeRow(rule.id, "passage", "PSA 23:1-2", "excluded"),
    ]
    expect(resolve([rule], rows, PSA_COORDS)).toEqual([])
    // Outside the excluded span the applies row still decides.
    const v4: CellCoordinates = { ...PSA_COORDS, segment: "cell-4", passageRef: "PSA 23:4" }
    expect(resolve([rule], rows, v4)).toEqual([{ rule, via: "passage", likely: false }])
  })

  it("sets likely=true only when decided solely by likely_applies rows", () => {
    const likelyRule = makeRule({ scope: "genre" })
    const rows = [makeRow(likelyRule.id, "genre", "poetry", "likely_applies")]
    expect(resolve([likelyRule], rows, PSA_COORDS)).toEqual([
      { rule: likelyRule, via: "genre", likely: true },
    ])

    // An applies row at the same specificity makes the decision definite.
    const mixedRule = makeRule({ scope: "passage" })
    const mixedRows = [
      makeRow(mixedRule.id, "passage", "PSA 23:1-3", "likely_applies"),
      makeRow(mixedRule.id, "passage", "PSA 23:1-6", "applies"),
    ]
    expect(resolve([mixedRule], mixedRows, PSA_COORDS)).toEqual([
      { rule: mixedRule, via: "passage", likely: false },
    ])
  })

  it("does not let a broader likely_applies mark a decision made at a narrower level", () => {
    const rule = makeRule({ scope: "genre" })
    const rows = [
      makeRow(rule.id, "genre", "poetry", "likely_applies"),
      makeRow(rule.id, "segment", "cell-1", "applies"),
    ]
    expect(resolve([rule], rows, PSA_COORDS)).toEqual([{ rule, via: "segment", likely: false }])
  })

  it("matches passage rows by verse-span overlap", () => {
    const rule = makeRule({ scope: "passage" })
    const rows = [makeRow(rule.id, "passage", "LUK 1:1-4", "applies")]
    const inside: CellCoordinates = { segment: "c", file: "f", passageRef: "LUK 1:3" }
    const outside: CellCoordinates = { segment: "c", file: "f", passageRef: "LUK 1:5" }
    const otherChapter: CellCoordinates = { segment: "c", file: "f", passageRef: "LUK 2:2" }
    const otherBook: CellCoordinates = { segment: "c", file: "f", passageRef: "JHN 1:2" }
    expect(resolve([rule], rows, inside)).toEqual([{ rule, via: "passage", likely: false }])
    expect(resolve([rule], rows, outside)).toEqual([])
    expect(resolve([rule], rows, otherChapter)).toEqual([])
    expect(resolve([rule], rows, otherBook)).toEqual([])
  })

  it("matches cell refs that are themselves ranges on overlap", () => {
    const rule = makeRule({ scope: "passage" })
    const rows = [makeRow(rule.id, "passage", "LUK 1:5-7", "applies")]
    const overlapping: CellCoordinates = { segment: "c", file: "f", passageRef: "LUK 1:3-6" }
    const disjoint: CellCoordinates = { segment: "c", file: "f", passageRef: "LUK 1:1-4" }
    expect(resolve([rule], rows, overlapping)).toEqual([{ rule, via: "passage", likely: false }])
    expect(resolve([rule], rows, disjoint)).toEqual([])
  })

  it("ignores passage rows for cells without a parseable ref", () => {
    const rule = makeRule({ scope: "passage" })
    const rows = [makeRow(rule.id, "passage", "LUK 1:1-4", "applies")]
    const noRef: CellCoordinates = { segment: "c", file: "f" }
    expect(resolve([rule], rows, noRef)).toEqual([])
  })

  it("drops unparseable passage target ids at index build", () => {
    const rule = makeRule({ scope: "global" })
    const index = buildApplicabilityIndex([makeRow(rule.id, "passage", "LUK 1", "excluded")])
    // The malformed exclusion can never match, so the global default stands.
    expect(resolveEffectiveRules([rule], index, PSA_COORDS)).toEqual([
      { rule, via: "global", likely: false },
    ])
  })

  it("never resolves proposed, rejected, archived, or disabled rules", () => {
    const proposed = makeRule({ status: "proposed" })
    const rejected = makeRule({ status: "rejected" })
    const archived = makeRule({ status: "archived" })
    const disabled = makeRule({ enabled: false })
    const rows = [
      makeRow(proposed.id, "genre", "poetry", "applies"),
      makeRow(rejected.id, "genre", "poetry", "applies"),
      makeRow(archived.id, "genre", "poetry", "applies"),
      makeRow(disabled.id, "genre", "poetry", "applies"),
    ]
    expect(resolve([proposed, rejected, archived, disabled], rows, PSA_COORDS)).toEqual([])
  })

  it("preserves input rule order and resolves rules independently", () => {
    const a = makeRule({ scope: "global" })
    const b = makeRule({ scope: "genre" })
    const c = makeRule({ scope: "global" })
    const rows = [
      makeRow(b.id, "genre", "poetry", "likely_applies"),
      makeRow(c.id, "book", "PSA", "excluded"),
    ]
    expect(resolve([a, b, c], rows, PSA_COORDS)).toEqual([
      { rule: a, via: "global", likely: false },
      { rule: b, via: "genre", likely: true },
    ])
  })
})
