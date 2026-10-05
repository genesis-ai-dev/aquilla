// @vitest-environment node
// AQU-1573: the reference Bible demo project shows, row by row, exactly what
// its QA notes promise. Every built-in check that is on by default runs here
// the way the editor runs it (the lane's Bible in the check context, verses
// from the committed texts), so a seeded row can never surprise a tester with
// a warning the notes do not mention, or miss the one they do.
import { describe, expect, it } from "vitest"
import { BUILTIN_CHECKS, BUILTIN_CHECK_IDS, type BuiltinCheckContext } from "@/lib/lqa/builtin-registry"
import { findScriptureReferences, parseCanonicalRef } from "@/lib/reference-bible/reference-finder"
import { referenceBibleForLane } from "@/lib/reference-bible/lane-setting"
import { readManifest, readVerses } from "./reference-bibles"
import {
  DEMO_SETTINGS,
  ENGLISH_LANE,
  DEMO_PROJECT_ID,
  buildDemoRows,
  committedVerseReader,
  demoFileEventId,
  demoFileId,
  demoLanes,
  seededTargetEventId,
  withoutVowelMarks,
  type DemoExpectation,
} from "./reference-bible-demo"

const texts = new Map(
  readManifest().map((entry) => [entry.id, new Map(readVerses(entry).map((r) => [`${r.book} ${r.chapter}:${r.verse}`, r.text]))]),
)

function lookupIn(versionId: string) {
  const verses = texts.get(versionId)!
  return (canonical: string) => {
    const ref = parseCanonicalRef(canonical)
    if (!ref || ref.endChapter !== ref.chapter) return undefined
    const out: string[] = []
    for (let v = ref.verseStart; v <= ref.verseEnd; v++) {
      const text = verses.get(`${ref.book} ${ref.chapter}:${v}`)
      if (text) out.push(text)
    }
    return out.length ? out : undefined
  }
}

const rows = buildDemoRows()

/**
 * The built-in checks a fresh project runs, dispatched as checkRulesForCell
 * (src/lib/rules/rule-engine.ts) does: on a blank target only the checks that
 * run on empty targets, otherwise all of them. (The engine itself reaches
 * React modules through its CellData type, which this scripts tsconfig cannot
 * compile; its context handling has its own tests.)
 */
function shown(source: string, target: string, lane: string): { reasons: string[]; quoteKind?: string } {
  const versionId = referenceBibleForLane(DEMO_SETTINGS, lane)!
  const ctx: BuiltinCheckContext = { referenceBible: { versionName: versionId, lookup: lookupIn(versionId) } }
  const reasons: string[] = []
  let quoteKind: string | undefined
  for (const id of BUILTIN_CHECK_IDS) {
    const def = BUILTIN_CHECKS[id]
    if (!def.defaultEnabled) continue
    if (!target.trim() && !def.runsOnEmptyTarget) continue
    const result = def.run(source, target, ctx)
    const spans = !result ? [] : Array.isArray(result) ? result : result.spans
    if (spans.length === 0) continue
    reasons.push(`builtin:${id}`)
    if (id === "reference-quote" && result && !Array.isArray(result)) quoteKind = result.params.kind
  }
  return { reasons, quoteKind }
}

const EXPECTED_REASONS: Record<DemoExpectation, string[]> = {
  clean: [],
  differs: ["builtin:reference-quote"],
  missing: ["builtin:reference-quote"],
  empty: ["builtin:empty-target"],
}

describe("reference Bible demo project (AQU-1573)", () => {
  it("has twelve rows, an Arabic target for each, and lanes for both Bibles", () => {
    expect(rows).toHaveLength(12)
    expect(demoLanes(rows)).toEqual(["", ENGLISH_LANE.tag])
    for (const row of rows) expect(row.targets[""]).toBeDefined()
    expect(referenceBibleForLane(DEMO_SETTINGS, "")).toBe("arb-vandyck")
    expect(referenceBibleForLane(DEMO_SETTINGS, ENGLISH_LANE.tag)).toBe("eng-kjv")
  })

  it("uses distinct, stable ids so a re-seed lands on the same rows", () => {
    const again = buildDemoRows()
    expect(again.map((r) => r.cellId)).toEqual(rows.map((r) => r.cellId))
    const ids = rows.flatMap((r) => [r.cellId, r.sourceEventId, seededTargetEventId(r, ""), seededTargetEventId(r, "en")])
    expect(new Set(ids).size).toBe(ids.length)
    for (const v of [...ids, DEMO_PROJECT_ID, demoFileId(), demoFileEventId()]) {
      expect(v).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
    }
  })

  it("gives a re-seed after the demo file was deleted ids of its own", () => {
    const next = buildDemoRows(committedVerseReader(), 1)
    const used = new Set([
      demoFileId(0), demoFileEventId(0),
      ...rows.flatMap((r) => [r.sourceEventId, seededTargetEventId(r, ""), seededTargetEventId(r, "en")]),
    ])
    for (const v of [demoFileId(1), demoFileEventId(1), ...next.flatMap((r) => [r.sourceEventId, seededTargetEventId(r, ""), seededTargetEventId(r, "en")])]) {
      expect(used.has(v), v).toBe(false)
    }
    expect(next.map((r) => r.source)).toEqual(rows.map((r) => r.source))
    expect(() => demoFileId(32)).toThrow(/out of range/)
  })

  for (const row of rows) {
    for (const [lane, expectation] of Object.entries(row.expect)) {
      it(`row ${row.n} (${lane || "Arabic"}) shows ${expectation}: ${row.source.slice(0, 40)}`, () => {
        const { reasons, quoteKind } = shown(row.source, row.targets[lane] ?? "", lane)
        expect(reasons).toEqual(EXPECTED_REASONS[expectation])
        if (expectation === "differs" || expectation === "missing") expect(quoteKind).toBe(expectation)
      })
    }
  }

  it("cites the verses the QA notes name, so drafting has them to inject", () => {
    const canonicals = (n: number) => findScriptureReferences(rows[n - 1].source).map((f) => f.canonical)
    expect(canonicals(3)).toEqual(["ISA 40:25"])
    expect(canonicals(10)).toEqual(["ROM 5:8", "JHN 15:13"])
    expect(canonicals(11)).toEqual([])
    expect(canonicals(12)).toEqual(["JHN 3:16"])
    expect(canonicals(9)).toEqual([])
  })

  it("derives every quoted draft from the committed Bible text", () => {
    const vd = texts.get("arb-vandyck")!
    expect(rows[3].targets[""]).toContain(vd.get("JHN 3:16"))
    expect(rows[4].targets[""]).toContain(withoutVowelMarks(vd.get("1CO 13:4")!.split(".")[0]))
    expect(rows[5].targets[""]).not.toContain(vd.get("ROM 8:28"))
    expect(rows[3].targets[ENGLISH_LANE.tag]).toContain(texts.get("eng-kjv")!.get("JHN 3:16"))
  })

  it("is still clean once someone undoes the changed word (the live-edit QA step in reverse)", () => {
    const fixed = rows[5].targets[""].replace("لِلصَّلَاحِ", "لِلْخَيْرِ")
    expect(shown(rows[5].source, fixed, "").reasons).toEqual([])
  })

  it("passes once a blank row is drafted the way the dev mock AI drafts it (source plus the cited verses)", () => {
    const vd = lookupIn("arb-vandyck")
    for (const n of [3, 10, 12]) {
      const source = rows[n - 1].source
      const verses = findScriptureReferences(source).flatMap((f) => vd(f.canonical) ?? [])
      expect(verses.length, `row ${n}`).toBeGreaterThan(0)
      expect(shown(source, [`[mock] ${source}`, ...verses].join(" "), "").reasons, `row ${n}`).toEqual([])
    }
  })
})
