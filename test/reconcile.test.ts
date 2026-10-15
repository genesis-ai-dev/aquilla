import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { reconcile } from "../src/core/reconcile.ts"
import { sentence, unit, units } from "./helpers.ts"
import { applyScript, opArb } from "./edit-scripts.ts"

const ids = ["a", "b", "c", "d", "e"]
const base = ids.map((_, i) => sentence(i + 1))

describe("reconcile — classified scenarios", () => {
  it("keeps identities when nothing changed", () => {
    const m = reconcile(units(base, ids), units(base))
    expect(m.matches.map((x) => x.logicalId)).toEqual(ids)
    expect(m.matches.every((x) => x.status === "unchanged")).toBe(true)
    expect(m.deleted).toEqual([])
  })
  it("modified: an edited paragraph keeps its identity", () => {
    const cur = [...base]
    cur[2] = cur[2]!.replace(/^\w+/, "Golden")
    const m = reconcile(units(base, ids), units(cur))
    expect(m.matches[2]).toMatchObject({ logicalId: "c", status: "modified", via: "fuzzy" })
  })
  it("inserted and deleted", () => {
    const cur = [base[0]!, sentence(77), base[1]!, base[3]!, base[4]!]
    const m = reconcile(units(base, ids), units(cur))
    expect(m.matches[1]!.status).toBe("inserted")
    expect(m.matches[1]!.logicalId).not.toMatch(/^[abcde]$/)
    expect(m.deleted).toEqual(["c"])
  })
  it("moved: exact text found elsewhere", () => {
    const cur = [base[4]!, base[0]!, base[1]!, base[2]!, base[3]!]
    const m = reconcile(units(base, ids), units(cur))
    expect(m.matches[0]).toMatchObject({ logicalId: "e", status: "moved" })
    expect(m.matches.slice(1).every((x) => x.status === "unchanged")).toBe(true)
  })
  it("moved across scopes (e.g. into another story)", () => {
    const prev = [unit(base[0]!, 0, { id: "a", scope: "s1" }), unit(base[1]!, 0, { id: "b", scope: "s2" })]
    const cur = [unit(base[1]!, 0, { scope: "s1" }), unit(base[0]!, 0, { scope: "s2" })]
    const m = reconcile(prev, cur)
    expect(m.matches.map((x) => [x.logicalId, x.status])).toEqual([
      ["b", "moved"],
      ["a", "moved"],
    ])
  })
  it("split: one paragraph becomes two", () => {
    const w = base[2]!.split(" ")
    const cur = [base[0]!, base[1]!, w.slice(0, 7).join(" "), w.slice(7).join(" "), base[3]!, base[4]!]
    const m = reconcile(units(base, ids), units(cur))
    expect(m.matches[2]).toMatchObject({ status: "split", predecessors: ["c"] })
    expect(m.matches[3]).toMatchObject({ status: "split", predecessors: ["c"] })
    expect(m.deleted).toEqual([])
  })
  it("merged: two paragraphs become one", () => {
    const cur = [base[0]!, `${base[1]} ${base[2]}`, base[3]!, base[4]!]
    const m = reconcile(units(base, ids), units(cur))
    expect(m.matches[1]).toMatchObject({ status: "merged", predecessors: ["b", "c"] })
    expect(m.deleted).toEqual([])
  })
  it("native anchors win over text", () => {
    const prev = [unit("Title", 0, { id: "k1", anchor: "key:title" }), unit("Subtitle", 1, { id: "k2", anchor: "key:sub" })]
    const cur = [unit("Completely different", 0, { anchor: "key:title" }), unit("Subtitle", 1, { anchor: "key:sub" })]
    const m = reconcile(prev, cur)
    expect(m.matches.map((x) => [x.logicalId, x.status, x.via])).toEqual([
      ["k1", "modified", "native-anchor"],
      ["k2", "unchanged", "native-anchor"],
    ])
  })
  it("ambiguous: duplicate text with human decisions is escalated, not guessed", () => {
    const prev = units(["Amen.", "Glory to God.", "Amen."], ["x", "y", "z"])
    const cur = units(["Glory to God.", "Amen."])
    const m = reconcile(prev, cur, { protectedIds: new Set(["x"]) })
    expect(m.matches[1]).toMatchObject({ status: "ambiguous" })
    expect(m.matches[1]!.predecessors).toEqual(expect.arrayContaining(["x", "z"]))
    expect(m.deleted).not.toContain("x")
    expect(m.deleted).not.toContain("z")
  })
  it("ambiguous: an edit equally close to two former paragraphs", () => {
    const p1 = "The meeting starts at seven in the main hall tonight."
    const p2 = "The meeting starts at seven in the side hall tonight."
    const prev = units([sentence(1), p1, p2, sentence(2)], ["a", "b", "c", "d"])
    const cur = units([sentence(1), "The meeting starts at seven in the hall tonight.", sentence(2)])
    const m = reconcile(prev, cur)
    expect(m.matches[1]!.status).toBe("ambiguous")
  })
  it("assertions override everything", () => {
    const prev = units(base, ids)
    const cur = units([sentence(99), ...base.slice(1)])
    const m = reconcile(prev, cur, { assertions: new Map([["p#s#0", "a"]]) })
    expect(m.matches[0]).toMatchObject({ logicalId: "a", via: "asserted" })
  })
})

describe("reconcile — properties over random edit scripts", () => {
  const initialArb = fc.array(fc.integer({ min: 1, max: 5000 }), { minLength: 3, maxLength: 25 }).map((seeds) => [...new Set(seeds)].map((s) => sentence(s, 10 + (s % 8))))

  it("never assigns an identity to the wrong lineage (precision = 100%)", () => {
    fc.assert(
      fc.property(initialArb, fc.array(opArb, { maxLength: 8 }), (initial, ops) => {
        const { prev, truth } = applyScript(initial, ops)
        const m = reconcile(prev, units(truth.map((t) => t.text)))
        m.matches.forEach((match, i) => {
          const t = truth[i]!
          if (match.status === "ambiguous") return // escalated: not a decision
          for (const p of match.predecessors) expect(t.from).toContain(p)
        })
      }),
      { numRuns: 400 },
    )
  })

  it("unchanged text keeps its id (stability = 100%)", () => {
    fc.assert(
      fc.property(initialArb, fc.array(opArb, { maxLength: 8 }), (initial, ops) => {
        const { prev, truth } = applyScript(initial, ops)
        const m = reconcile(prev, units(truth.map((t) => t.text)))
        truth.forEach((t, i) => {
          if (t.how === "unchanged" || t.how === "moved") {
            const ok = m.matches[i]!.logicalId === t.from[0] || m.matches[i]!.status === "ambiguous"
            expect(ok).toBe(true)
          }
        })
      }),
      { numRuns: 400 },
    )
  })

  it("is deterministic", () => {
    fc.assert(
      fc.property(initialArb, fc.array(opArb, { maxLength: 8 }), (initial, ops) => {
        const { prev, truth } = applyScript(initial, ops)
        const cur = units(truth.map((t) => t.text))
        expect(reconcile(prev, cur, { salt: "x" })).toEqual(reconcile(prev, cur, { salt: "x" }))
      }),
      { numRuns: 100 },
    )
  })

  it("recovers most single-word edits and splits/merges (recall ≥ 90%)", () => {
    let expected = 0
    let found = 0
    let ambiguous = 0
    fc.assert(
      fc.property(initialArb, fc.array(opArb, { maxLength: 6 }), (initial, ops) => {
        const { prev, truth } = applyScript(initial, ops)
        const m = reconcile(prev, units(truth.map((t) => t.text)))
        truth.forEach((t, i) => {
          if (t.how === "inserted") return
          expected++
          const match = m.matches[i]!
          if (match.status === "ambiguous") ambiguous++
          else if (match.predecessors.some((p) => t.from.includes(p))) found++
        })
      }),
      { numRuns: 300, seed: 42 },
    )
    const recall = found / expected
    expect(recall).toBeGreaterThanOrEqual(0.9)
    expect(ambiguous / expected).toBeLessThan(0.05)
  })
})
