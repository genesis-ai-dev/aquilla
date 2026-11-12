/**
 * AQU-1864 — the sliced project scan must agree exactly with the eager scan it
 * replaced, and must not re-evaluate cells it has already seen.
 */
import { describe, it, expect, vi } from "vitest"
import { InfractionScan, scanAllCells, rulesFingerprint } from "./incremental-infractions"
import { checkRulesForCell } from "./rule-engine"
import type { TranslationRule, RuleInfraction } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"

function makeCell(overrides: Partial<CellData> & { id: string }): CellData {
  return {
    original: "source text", translated: "", fileId: "f1", context: "", group: "", type: "text",
    status: "unvalidated", validationStatus: "none", activeValidators: [],
    validationHistory: [], history: [], threads: [],
    ...overrides,
  }
}

function makeRule(overrides: Partial<TranslationRule> & { id: string; check: TranslationRule["check"] }): TranslationRule {
  return {
    name: "Test Rule", description: "", severity: "major", source: "user",
    scope: "project", enabled: true, createdAt: "2026-10-10T00:00:00.000Z",
    ...overrides,
  }
}

const forbidsBad = makeRule({ id: "r1", check: { type: "target-forbids", targetPattern: "bad" } })
const forbidsWorse = makeRule({ id: "r2", check: { type: "target-forbids", targetPattern: "worse" } })

/** The scan the render-time memo used to run, verbatim, as the parity oracle. */
function eagerScan(cells: CellData[], enabledRules: TranslationRule[]): Map<string, RuleInfraction[]> {
  const out = new Map<string, RuleInfraction[]>()
  if (enabledRules.length === 0 || cells.length === 0) return out
  for (const cell of cells) {
    const cellInf = checkRulesForCell(cell, cell.fileId, enabledRules)
    if (cellInf.length > 0) out.set(cell.id, cellInf)
  }
  return out
}

function corpus(size: number): CellData[] {
  return Array.from({ length: size }, (_, i) =>
    makeCell({
      id: `c${i}`,
      fileId: `f${i % 4}`,
      translated: i % 3 === 0 ? `this is bad ${i}` : `clean ${i}`,
    }),
  )
}

describe("InfractionScan parity with the eager memo", () => {
  it("produces the identical map, slice size notwithstanding", () => {
    const cells = corpus(50)
    const rules = [forbidsBad, forbidsWorse]
    const expected = eagerScan(cells, rules)

    for (const slice of [1, 7, 50, 500]) {
      const scan = new InfractionScan()
      scan.plan(cells, rules)
      while (!scan.step(slice)) { /* drain */ }
      expect(scan.snapshot()).toEqual(expected)
    }
    expect(scanAllCells(cells, rules)).toEqual(expected)
  })

  it("keeps the eager map's key semantics for a cell id repeated across files", () => {
    // The map is keyed by cell id alone, and the eager memo only wrote cells
    // that HAD infractions — so a clean namesake in another file does not
    // shadow a hit, and a later hit overwrites an earlier one. Both halves of
    // that have to survive, or counts move on projects with repeated ids.
    const cleanAfterHit = [
      makeCell({ id: "shared", fileId: "fA", translated: "bad in A" }),
      makeCell({ id: "shared", fileId: "fB", translated: "clean in B" }),
    ]
    const hitAfterHit = [
      makeCell({ id: "shared", fileId: "fA", translated: "bad in A" }),
      makeCell({ id: "shared", fileId: "fB", translated: "bad in B" }),
    ]
    for (const cells of [cleanAfterHit, hitAfterHit]) {
      const expected = eagerScan(cells, [forbidsBad])
      expect(expected.size).toBe(1)
      expect(scanAllCells(cells, [forbidsBad])).toEqual(expected)
    }
    expect(eagerScan(hitAfterHit, [forbidsBad]).get("shared")?.[0].fileId).toBe("fB")
    expect(scanAllCells(hitAfterHit, [forbidsBad]).get("shared")?.[0].fileId).toBe("fB")
  })

  it("is empty with no rules and with no cells", () => {
    expect(scanAllCells(corpus(10), []).size).toBe(0)
    expect(scanAllCells([], [forbidsBad]).size).toBe(0)
  })
})

describe("InfractionScan slicing", () => {
  it("evaluates no more than the requested number of cells per step", () => {
    const checkCell = vi.fn(checkRulesForCell)
    const scan = new InfractionScan(checkCell)
    scan.plan(corpus(10), [forbidsBad])

    expect(scan.step(4)).toBe(false)
    expect(checkCell).toHaveBeenCalledTimes(4)
    expect(scan.pending).toBe(6)
    expect(scan.step(4)).toBe(false)
    expect(checkCell).toHaveBeenCalledTimes(8)
    expect(scan.step(4)).toBe(true)
    expect(checkCell).toHaveBeenCalledTimes(10)
    expect(scan.done).toBe(true)
  })

  it("publishes a partial map mid-scan, never a wrong one", () => {
    const cells = corpus(30)
    const scan = new InfractionScan()
    scan.plan(cells, [forbidsBad])
    scan.step(10)

    const partial = scan.snapshot()
    const full = eagerScan(cells, [forbidsBad])
    expect(partial.size).toBeGreaterThan(0)
    expect(partial.size).toBeLessThan(full.size)
    // Everything published so far is also in the final answer, unchanged.
    for (const [cellId, infractions] of partial) {
      expect(full.get(cellId)).toEqual(infractions)
    }
  })

  it("evaluates cells in corpus order so the partial map reads top-down", () => {
    const seen: string[] = []
    const scan = new InfractionScan((cell, fileId, rules) => {
      seen.push(cell.id)
      return checkRulesForCell(cell, fileId, rules)
    })
    scan.plan(corpus(6), [forbidsBad])
    while (!scan.step(2)) { /* drain */ }
    expect(seen).toEqual(["c0", "c1", "c2", "c3", "c4", "c5"])
  })
})

describe("InfractionScan incrementality", () => {
  it("re-evaluates only the edited cell when the corpus is republished", () => {
    const cells = corpus(40)
    const checkCell = vi.fn(checkRulesForCell)
    const scan = new InfractionScan(checkCell)
    scan.plan(cells, [forbidsBad])
    while (!scan.step(40)) { /* drain */ }
    expect(checkCell).toHaveBeenCalledTimes(40)
    checkCell.mockClear()

    // What an outbox change looks like from here: brand-new cell objects, one
    // of which carries a new target value.
    const republished = cells.map((cell) =>
      cell.id === "c7" ? { ...cell, translated: "now bad" } : { ...cell },
    )
    const progress = scan.plan(republished, [forbidsBad])
    expect(progress).toEqual({ pending: 1, total: 40 })
    expect(scan.step(40)).toBe(true)
    expect(checkCell).toHaveBeenCalledTimes(1)
    expect(checkCell.mock.calls[0][0].id).toBe("c7")
    expect(scan.snapshot()).toEqual(eagerScan(republished, [forbidsBad]))
  })

  it("re-evaluates a cell whose source, status or take changed", () => {
    const base = makeCell({ id: "c1", translated: "clean", original: "source" })
    const fields: Partial<CellData>[] = [
      { original: "other source" },
      { translated: "bad" },
      { status: "empty" },
      { hasOwnTake: true },
      { medium: "media" },
      { transcription: "spoken" },
    ]
    for (const patch of fields) {
      const scan = new InfractionScan()
      scan.plan([base], [forbidsBad])
      scan.step(1)
      expect(scan.plan([{ ...base, ...patch }], [forbidsBad]).pending).toBe(1)
    }
  })

  it("ignores changes to fields no rule can see", () => {
    const base = makeCell({ id: "c1", translated: "bad" })
    const scan = new InfractionScan()
    scan.plan([base], [forbidsBad])
    scan.step(1)
    // hasPendingEdit flips on every outbox enqueue/flush of this cell, and
    // lastEditAt (epoch ms) moves on every commit anywhere in the chain.
    expect(scan.plan([{ ...base, hasPendingEdit: true, lastEditAt: 1_760_000_000_000 }], [forbidsBad]).pending).toBe(0)
  })

  it("re-evaluates everything when a rule body changes", () => {
    const cells = corpus(10)
    const scan = new InfractionScan()
    scan.plan(cells, [forbidsBad])
    while (!scan.step(10)) { /* drain */ }

    const edited = makeRule({ id: "r1", check: { type: "target-forbids", targetPattern: "clean" } })
    expect(scan.plan(cells, [edited]).pending).toBe(10)
    while (!scan.step(10)) { /* drain */ }
    expect(scan.snapshot()).toEqual(eagerScan(cells, [edited]))
  })

  it("serves no stale results after rules are disabled and re-enabled", () => {
    const cells = corpus(10)
    const scan = new InfractionScan()
    scan.plan(cells, [forbidsBad])
    while (!scan.step(10)) { /* drain */ }
    expect(scan.snapshot().size).toBeGreaterThan(0)

    expect(scan.plan(cells, []).pending).toBe(0)
    expect(scan.snapshot().size).toBe(0)

    expect(scan.plan(cells, [forbidsBad]).pending).toBe(10)
    expect(scan.snapshot().size).toBe(0)
    while (!scan.step(10)) { /* drain */ }
    expect(scan.snapshot()).toEqual(eagerScan(cells, [forbidsBad]))
  })

  it("forgets cells that left the corpus", () => {
    const cells = corpus(10)
    const scan = new InfractionScan()
    scan.plan(cells, [forbidsBad])
    while (!scan.step(10)) { /* drain */ }

    const shrunk = cells.slice(0, 5)
    expect(scan.plan(shrunk, [forbidsBad]).pending).toBe(0)
    expect(scan.snapshot()).toEqual(eagerScan(shrunk, [forbidsBad]))

    // The dropped cells are gone from the cache, not merely hidden: bringing
    // them back costs real work again.
    expect(scan.plan(cells, [forbidsBad]).pending).toBe(5)
  })
})

describe("rulesFingerprint", () => {
  it("separates rule sets that differ only in a pattern", () => {
    const a = [makeRule({ id: "r1", check: { type: "target-forbids", targetPattern: "x" } })]
    const b = [makeRule({ id: "r1", check: { type: "target-forbids", targetPattern: "y" } })]
    expect(rulesFingerprint(a)).not.toBe(rulesFingerprint(b))
    expect(rulesFingerprint(a)).toBe(rulesFingerprint([...a]))
  })
})
