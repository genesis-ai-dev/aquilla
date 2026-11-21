import { describe, it, expect } from "vitest"
import {
  selectTermRules,
  selectSourceApplicableTermRules,
  computeLiveTermInfractions,
  mergeBlotInfractions,
  termRulesOf,
} from "./live-term-check"
import { checkRulesForCell, ruleSourceGateMatches } from "./rule-engine"
import { compiledPatternCount } from "@/lib/terminology/match"
import { compileConceptsToRulesCore } from "@/lib/terminology/compile-core"
import type { RuleInfraction, TranslationRule } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"

// A terminology rule (id prefixed `term:`) that forbids the rendering "verboten"
// in the target — the shape compileConceptsToRules emits for a forbidden
// rendering. `u` flag is applied by rule-engine for term: rules.
const termRule: TranslationRule = {
  id: "term:concept-1:forbidden:verboten",
  name: "sample → verboten (forbidden)",
  description: "Forbidden rendering of 'sample'",
  severity: "major",
  source: "algorithmic",
  scope: "project",
  check: { type: "target-forbids", targetPattern: "verboten" },
  enabled: true,
  createdAt: "2026-01-01T00:00:00Z",
}

const disabledTermRule: TranslationRule = { ...termRule, id: "term:concept-2", enabled: false }

// A non-terminology (user-authored) rule — must never be treated as a term rule.
const userRule: TranslationRule = {
  id: "user:no-tabs",
  name: "No tabs",
  description: "Target must not contain tabs",
  severity: "minor",
  source: "user",
  scope: "project",
  check: { type: "target-forbids", targetPattern: "\\t" },
  enabled: true,
  createdAt: "2026-01-01T00:00:00Z",
}

function makeCell(overrides: Partial<CellData> = {}): CellData {
  return {
    id: "cell-1",
    fileId: "file-1",
    original: "This is a sample.",
    translated: "",
    context: "GEN 1:1",
    group: "GEN 1",
    type: "text",
    status: "empty",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    ...overrides,
  }
}

describe("selectTermRules", () => {
  it("keeps only enabled rules whose id starts with `term:`", () => {
    const picked = selectTermRules([termRule, disabledTermRule, userRule])
    expect(picked.map((r) => r.id)).toEqual(["term:concept-1:forbidden:verboten"])
  })

  it("returns empty when there are no terminology rules", () => {
    expect(selectTermRules([userRule])).toEqual([])
  })
})

describe("computeLiveTermInfractions", () => {
  it("flags a forbidden rendering typed into an as-yet-empty (status:empty) cell", () => {
    // The regression this guards: checkRulesForCell short-circuits on an
    // `empty` status, so without the status promotion a just-typed forbidden
    // term would produce no blot until the commit landed.
    const cell = makeCell({ status: "empty", translated: "" })
    const infractions = computeLiveTermInfractions(cell, "verboten", [termRule])
    expect(infractions).toHaveLength(1)
    expect(infractions[0].ruleId).toBe("term:concept-1:forbidden:verboten")
    expect(infractions[0].spans[0]).toMatchObject({ side: "target", start: 0, end: 8 })
  })

  it("returns no infractions when the live buffer is clean", () => {
    const cell = makeCell()
    expect(computeLiveTermInfractions(cell, "bonjour", [termRule])).toEqual([])
  })

  it("returns [] when there are no term rules (skips the check entirely)", () => {
    const cell = makeCell()
    expect(computeLiveTermInfractions(cell, "verboten", [])).toEqual([])
  })
})

describe("mergeBlotInfractions", () => {
  const committedTerm: RuleInfraction = {
    ruleId: "term:concept-1:forbidden:verboten",
    cellId: "cell-1",
    fileId: "file-1",
    reason: "target-forbids",
    spans: [{ side: "target", start: 99, end: 107, matchedText: "verboten" }],
  }
  const committedUser: RuleInfraction = {
    ruleId: "user:no-tabs",
    cellId: "cell-1",
    fileId: "file-1",
    reason: "target-forbids",
    spans: [{ side: "target", start: 3, end: 4, matchedText: "\t" }],
  }
  const liveTerm: RuleInfraction = {
    ruleId: "term:concept-1:forbidden:verboten",
    cellId: "cell-1",
    fileId: "file-1",
    reason: "target-forbids",
    spans: [{ side: "target", start: 0, end: 8, matchedText: "verboten" }],
  }

  it("replaces committed term infractions with the live ones, keeping non-term ones", () => {
    const merged = mergeBlotInfractions([committedTerm, committedUser], [liveTerm])
    // The stale committed term infraction is gone; the fresh live one is in.
    expect(merged).toHaveLength(2)
    expect(merged).toContain(committedUser)
    expect(merged).toContain(liveTerm)
    expect(merged).not.toContain(committedTerm)
  })

  it("drops committed term infractions when the live buffer has none left", () => {
    // User fixed the term while typing → blot must clear immediately, not wait
    // for the next commit.
    const merged = mergeBlotInfractions([committedTerm, committedUser], [])
    expect(merged).toEqual([committedUser])
  })
})

// ---------------------------------------------------------------------------
// AQU-2654: the per-cell source gate on the live keystroke path.
// ---------------------------------------------------------------------------

const BENCH_LABELS = {
  approvedName: (t: string) => `Term: ${t}`,
  approvedDescription: (t: string, r: string) => `${t} → ${r}`,
  forbiddenName: (t: string) => `Forbidden: ${t}`,
  forbiddenDescription: (r: string, t: string) => `${r} for ${t}`,
}

/** A French-ish affix inventory with affix matching on, as the BibleProject
 *  French project carries (`match: { forms, excludedForms, affixes, foldMarks }`). */
const TERM_MATCHING = {
  prefixes: ["re", "de", "in", "pre", "sur", "sous"],
  suffixes: ["s", "es", "ent", "ait", "aient", "ons", "ez", "er", "ée", "ées"],
  maxAffixes: 2,
}

/** `n` active concepts, each compiling to an approved + a forbidden rule. */
function compileTermbase(n: number, stem = "covenant"): TranslationRule[] {
  const concepts = []
  for (let i = 0; i < n; i++) {
    concepts.push({
      id: `c${i}`,
      sourceTerm: `${stem}${i}`,
      status: "active",
      match: {
        affixes: true,
        foldMarks: true,
        forms: [`testament${i}`, `pact${i}`],
        excludedForms: [`covenanting${i}`],
      },
      renderings: [
        { rendering: `alliance${i}`, status: "preferred" },
        { rendering: `pacte${i}`, status: "admitted" },
        { rendering: `contrat${i}`, status: "forbidden" },
      ],
    })
  }
  return selectTermRules(
    compileConceptsToRulesCore(concepts, BENCH_LABELS, TERM_MATCHING) as unknown as TranslationRule[],
  )
}

describe("selectSourceApplicableTermRules (AQU-2654)", () => {
  it("keeps only the rules whose concept the cell's source actually bears", () => {
    const rules = compileTermbase(50)
    const cell = makeCell({ original: "The covenant7 with Abraham.", translated: "" })
    const picked = selectSourceApplicableTermRules(cell, rules)
    expect(picked.length).toBeGreaterThan(0)
    expect(picked.every((r) => r.id.startsWith("term:c7:"))).toBe(true)
    expect(picked.length).toBeLessThan(rules.length)
  })

  it("drops every rule when the source bears no concept", () => {
    const rules = compileTermbase(50)
    const cell = makeCell({ original: "A sentence with no glossary term in it.", translated: "" })
    expect(selectSourceApplicableTermRules(cell, rules)).toEqual([])
  })

  it("keeps a rule with no source gate (a hand-authored target-forbids)", () => {
    // `termRule` is a target-forbids with no sourcePattern — unconditional.
    const cell = makeCell({ original: "Nothing relevant here.", translated: "verboten" })
    expect(selectSourceApplicableTermRules(cell, [termRule]).map((r) => r.id)).toEqual([termRule.id])
  })

  it("reads a media section's TRANSCRIPT as its source, not the import filename", () => {
    const rules = compileTermbase(20)
    const filenameCell = makeCell({
      medium: "media",
      original: "covenant3-interview.mp3",
      transcription: "He spoke about the covenant9 at length.",
      translated: "",
    })
    const picked = selectSourceApplicableTermRules(filenameCell, rules)
    // c9 comes from the transcript; c3 appears only in the filename, which is
    // never legitimate source text (SUB-28 / effectiveSourceText).
    expect(picked.every((r) => r.id.startsWith("term:c9:"))).toBe(true)
    expect(picked.length).toBeGreaterThan(0)
  })

  it("narrowing changes no infraction — parity with the unfiltered check", () => {
    const rules = compileTermbase(60)
    const targets = [
      "",
      "l'alliance11 fut établie",            // approved rendering present
      "le contrat11 fut établi",             // forbidden rendering present
      "quelque chose sans terme",            // approved rendering MISSING
      "alliance11 et alliance11 partout",    // too many renderings
    ]
    for (const translated of targets) {
      const cell = makeCell({
        original: "The covenant11 was established with Abraham.",
        translated,
        status: translated.trim() ? "unvalidated" : "empty",
      })
      const narrowed = selectSourceApplicableTermRules(cell, rules)
      expect(computeLiveTermInfractions(cell, translated, narrowed))
        .toEqual(computeLiveTermInfractions(cell, translated, rules))
    }
  })

  it("never drops a rule that the committed check would report", () => {
    const rules = compileTermbase(40)
    const cell = makeCell({
      original: "The covenant5 and the covenant6 with Abraham.",
      translated: "le contrat5 sans rien",
      status: "unvalidated",
    })
    const reported = new Set(checkRulesForCell(cell, cell.fileId, rules).map((i) => i.ruleId))
    const kept = new Set(selectSourceApplicableTermRules(cell, rules).map((r) => r.id))
    expect(reported.size).toBeGreaterThan(0)
    for (const id of reported) expect(kept.has(id)).toBe(true)
  })

  it("compiles only the patterns that can occur in the source, not the termbase", () => {
    // Every editor row runs this selection when it mounts. Testing each rule's
    // gate compiled the source pattern of every glossary term on the first
    // row — seconds of main thread before a file with a large glossary could
    // paint. A stem no other test uses, so nothing here is compiled already.
    const rules = compileTermbase(300, "sanctuary")
    const cell = makeCell({ original: "They built the sanctuary7 in the wilderness.", translated: "" })
    const before = compiledPatternCount()
    const picked = selectSourceApplicableTermRules(cell, rules)
    const compiled = compiledPatternCount() - before
    expect(picked.length).toBeGreaterThan(0)
    expect(picked.every((r) => r.id.startsWith("term:c7:"))).toBe(true)
    // The index cannot tell sanctuary7 from sanctuary70…79 or sanctuary17, so
    // some neighbours are tested — never the 300 concepts.
    expect(compiled).toBeLessThanOrEqual(24)
    // And it is the same answer as testing every rule's gate.
    expect(picked).toEqual(rules.filter((rule) => ruleSourceGateMatches(rule, cell)))
  })

  it("makes the per-keystroke live check orders of magnitude cheaper than the full sweep", () => {
    // Regression guard for the reported symptom. With a BibleProject-sized
    // termbase (664 active concepts → 1328 compiled rules, affix matching on)
    // every rule carries a ~4.5 KB source pattern, and running the whole set
    // per keystroke measured ~32 ms of blocking main-thread regex — the "app
    // takes a deep breath after every letter typed". Narrowing to the cell's
    // own concepts first is what makes the live check free; this asserts the
    // gap rather than an absolute time, so it holds on any machine.
    const rules = compileTermbase(664)
    expect(rules.length).toBe(1328)
    const source = "The covenant3 was established with Abraham, who walked before the Lord."
    const cell = makeCell({ original: source, translated: "l'alliance3", status: "unvalidated" })

    const narrowed = selectSourceApplicableTermRules(cell, rules)
    // Exactly this cell's own concept — 2 rules out of 1328.
    expect(narrowed.map((r) => r.id).sort()).toEqual([
      "term:c3:approved",
      "term:c3:forbidden:contrat3",
    ])

    const time = (set: TranslationRule[], iterations: number): number => {
      computeLiveTermInfractions(cell, "l'alliance3", set) // warm the regex cache
      const started = performance.now()
      for (let i = 0; i < iterations; i++) {
        computeLiveTermInfractions(cell, `l'alliance3 ${"x".repeat(i)}`, set)
      }
      return (performance.now() - started) / iterations
    }

    const narrowedMs = time(narrowed, 50)
    const fullSweepMs = time(rules, 10)
    expect(narrowedMs * 20).toBeLessThan(fullSweepMs)
  }, 120_000)
})

describe("termRulesOf (AQU-2654)", () => {
  it("is selectTermRules of the map's rules, as one array per map", () => {
    const rule = (id: string, enabled = true): TranslationRule => ({
      id, name: id, description: "", severity: "minor", source: "user", scope: "project", enabled,
      createdAt: "2026-01-01T00:00:00Z",
      check: { type: "target-forbids", targetPattern: "x" },
    })
    const map = new Map([rule("term:a:approved"), rule("user-1"), rule("term:b:approved", false), rule("term:c:approved")].map((r) => [r.id, r]))
    const rules = termRulesOf(map)
    expect(rules).toEqual(selectTermRules(map.values()))
    expect(rules.map((r) => r.id)).toEqual(["term:a:approved", "term:c:approved"])
    // Shared by every row that holds the same rule map.
    expect(termRulesOf(map)).toBe(rules)
  })
})
