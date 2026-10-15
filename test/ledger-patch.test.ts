import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { Clock, contentHashOf, effectiveTranslation, fold, formatHlc, humanConflicts, seal } from "../src/core/ledger.ts"
import type { Envelope, Fact } from "../src/core/ledger.ts"
import { applyPatches } from "../src/core/patch.ts"
import type { Authority, ContentPatch, TargetUnitState } from "../src/core/types.ts"

const proposed = (logicalId: string, content: string, sourceHash = "s1", contextRevision = "c1"): Fact => ({
  type: "translation.proposed",
  docId: "d",
  logicalId,
  locale: "fr",
  sourceHash,
  contextRevision,
  content,
  provenance: { translator: "test" },
})
const edited = (logicalId: string, content: string, basedOn: string, sourceHash = "s1"): Fact => ({
  type: "translation.edited",
  docId: "d",
  logicalId,
  locale: "fr",
  sourceHash,
  content,
  basedOn,
  via: "cli",
})

/** Comparable projection of state (Maps → sorted arrays). */
const project = (envs: Envelope[]): unknown => {
  const s = fold(envs)
  return {
    units: [...s.units.entries()].sort().map(([k, v]) => [k, v.proposals.map((p) => p.opId), v.human.map((h) => h.opId)]),
    terms: [...s.terms.entries()].sort(),
    conflicts: [...s.conflicts.entries()].sort(),
    size: s.size,
  }
}

describe("ledger", () => {
  it("human authority beats newer agent output for the same source", () => {
    const envs = [
      seal(proposed("u1", "machine v1"), "agent", formatHlc(1, 0, "n")),
      seal(edited("u1", "human text", contentHashOf("machine v1")), "ana", formatHlc(2, 0, "n")),
      seal(proposed("u1", "machine v2 (newer!)"), "agent", formatHlc(3, 0, "n")),
    ]
    const e = effectiveTranslation(fold(envs), "d", "u1", "fr", "s1", "c1")
    expect(e).toMatchObject({ content: "human text", authority: "human" })
  })
  it("agent output is only reused under the same context revision", () => {
    const s = fold([seal(proposed("u1", "old ctx"), "agent", formatHlc(1, 0, "n"))])
    expect(effectiveTranslation(s, "d", "u1", "fr", "s1", "c2")).toBeUndefined()
    expect(effectiveTranslation(s, "d", "u1", "fr", "s2", "c1")).toBeUndefined()
  })
  it("detects concurrent human edits instead of silently picking one", () => {
    const parent = contentHashOf("machine")
    const envs = [
      seal(proposed("u1", "machine"), "agent", formatHlc(1, 0, "a")),
      seal(edited("u1", "Ana's version", parent), "ana", formatHlc(2, 0, "a")),
      seal(edited("u1", "Ben's version", parent), "ben", formatHlc(2, 0, "b")),
    ]
    const c = humanConflicts(fold(envs))
    expect(c).toHaveLength(1)
    expect(c[0]!.versions.map((v) => v.actor).sort()).toEqual(["ana", "ben"])
    // A follow-up edit that builds on one side resolves the fork.
    envs.push(seal(edited("u1", "Merged version", contentHashOf("Ben's version")), "ana", formatHlc(3, 0, "a")))
    expect(humanConflicts(fold(envs))).toHaveLength(0)
  })
  it("clock is monotonic and observes remote time", () => {
    let t = 100
    const c = new Clock("n1", () => t)
    const a = c.tick()
    const b = c.tick()
    expect(a < b).toBe(true)
    c.observe(formatHlc(500, 3, "n2"))
    t = 200
    expect(c.tick() > formatHlc(500, 3, "n2")).toBe(true)
  })

  const factArb: fc.Arbitrary<Envelope> = fc
    .record({
      kind: fc.constantFrom("p", "e", "t", "c"),
      unit: fc.constantFrom("u1", "u2", "u3"),
      text: fc.constantFrom("alpha", "beta", "gamma", "delta"),
      wall: fc.integer({ min: 1, max: 50 }),
      node: fc.constantFrom("a", "b", "c"),
    })
    .map(({ kind, unit, text, wall, node }) => {
      const hlc = formatHlc(wall, 0, node)
      if (kind === "p") return seal(proposed(unit, text), "agent", hlc)
      if (kind === "e") return seal(edited(unit, text, contentHashOf("alpha")), node, hlc)
      if (kind === "t") return seal({ type: "decision.term", id: `t-${unit}`, locale: "fr", source: unit, target: text, status: "active" }, node, hlc)
      return seal({ type: "conflict.raised", id: `c-${unit}`, docId: "d", kind: "x", detail: text }, node, hlc)
    })

  it("PROPERTY: any delivery order, with duplicates, converges to the same state", () => {
    fc.assert(
      fc.property(fc.array(factArb, { maxLength: 30 }), fc.integer(), (envs, seed) => {
        const shuffled = fc.sample(fc.shuffledSubarray(envs, { minLength: envs.length, maxLength: envs.length }), { numRuns: 1, seed })[0]!
        const withDupes = [...shuffled, ...envs.slice(0, Math.floor(envs.length / 2))]
        expect(project(withDupes)).toEqual(project(envs))
      }),
      { numRuns: 300 },
    )
  })

  it("PROPERTY: merging two replicas is commutative and idempotent", () => {
    fc.assert(
      fc.property(fc.array(factArb, { maxLength: 20 }), fc.array(factArb, { maxLength: 20 }), (a, b) => {
        expect(project([...a, ...b])).toEqual(project([...b, ...a]))
        expect(project([...a, ...b, ...a])).toEqual(project([...a, ...b]))
      }),
      { numRuns: 200 },
    )
  })
})

describe("patch engine", () => {
  const st = (content: string, authority: Authority = "agent"): TargetUnitState => ({ content, contentHash: contentHashOf(content), authority })
  const patch = (id: string, unit: string, expected: string, content: string, authority: Authority = "agent", extra: Partial<ContentPatch> = {}): ContentPatch => ({
    operationId: id,
    logicalId: unit,
    expectedRevision: expected,
    targetLocale: "fr",
    operation: expected === "none" ? "insert" : "replace",
    content,
    authority,
    ...extra,
  })

  it("is idempotent: reapplying produces no additional changes", () => {
    const p = [patch("1", "u", "none", "bonjour")]
    const first = applyPatches(new Map(), p)
    const again = applyPatches(first.state, p, first.processed)
    expect(again.applied).toHaveLength(0)
    expect([...again.state]).toEqual([...first.state])
    // Even without the applied-set, a patch whose result is already in place is a no-op, not a conflict.
    const again2 = applyPatches(first.state, p)
    expect(again2.applied).toHaveLength(0)
    expect(again2.rejected).toHaveLength(0)
  })
  it("rejects stale patches", () => {
    const r = applyPatches(new Map([["u", st("current")]]), [patch("1", "u", contentHashOf("older"), "new")])
    expect(r.rejected[0]!.reason).toBe("stale")
  })
  it("never lets an agent overwrite human work unless it explicitly revises it", () => {
    const init = new Map([["u", st("human words", "human")]])
    const blocked = applyPatches(init, [patch("1", "u", contentHashOf("human words"), "model words")])
    expect(blocked.rejected[0]!.reason).toBe("unauthorized")
    expect(blocked.state.get("u")!.content).toBe("human words")
    const revised = applyPatches(init, [patch("2", "u", contentHashOf("human words"), "revised", "agent", { revisesHuman: true })])
    expect(revised.applied).toHaveLength(1)
  })
  it("a later timestamp does not beat an approval: concurrent siblings resolve by authority", () => {
    const init = new Map([["u", st("v0")]])
    const r = applyPatches(init, [patch("zzz-newest", "u", contentHashOf("v0"), "machine"), patch("aaa", "u", contentHashOf("v0"), "approved text", "approved")])
    expect(r.state.get("u")!.content).toBe("approved text")
  })

  const patchArb = fc
    .record({
      unit: fc.constantFrom("u1", "u2"),
      from: fc.constantFrom("none", "a", "b", "c"),
      to: fc.constantFrom("a", "b", "c", "d"),
      auth: fc.constantFrom<Authority>("agent", "human", "approved"),
      n: fc.integer({ min: 0, max: 9999 }),
    })
    .map(({ unit, from, to, auth, n }) => patch(`op${n}`, unit, from === "none" ? "none" : contentHashOf(from), to, auth, { revisesHuman: n % 2 === 0 }))

  it("PROPERTY: every permutation of a batch converges to the same structural result", () => {
    fc.assert(
      fc.property(fc.array(patchArb, { maxLength: 12 }), fc.integer(), (batch, seed) => {
        const perm = fc.sample(fc.shuffledSubarray(batch, { minLength: batch.length, maxLength: batch.length }), { numRuns: 1, seed })[0]!
        const a = applyPatches(new Map(), batch)
        const b = applyPatches(new Map(), perm)
        const view = (m: ReadonlyMap<string, TargetUnitState>): unknown => [...m.entries()].sort()
        expect(view(b.state)).toEqual(view(a.state))
        expect(b.applied.map((p) => p.operationId).sort()).toEqual(a.applied.map((p) => p.operationId).sort())
      }),
      { numRuns: 500 },
    )
  })

  it("PROPERTY: without memory, re-applying never overwrites a winning human/approved result with agent output", () => {
    fc.assert(
      fc.property(fc.array(patchArb, { maxLength: 12 }), (batch) => {
        const safe = batch.map((p) => ({ ...p, revisesHuman: false }))
        const a = applyPatches(new Map(), safe)
        const b = applyPatches(a.state, safe)
        for (const [id, st] of a.state) if (st.authority !== "agent") expect(b.state.get(id)!.content).toBe(st.content)
      }),
      { numRuns: 300 },
    )
  })

  it("PROPERTY: applying a batch twice is a no-op the second time", () => {
    fc.assert(
      fc.property(fc.array(patchArb, { maxLength: 12 }), (batch) => {
        const a = applyPatches(new Map(), batch)
        const b = applyPatches(a.state, batch, a.processed)
        expect([...b.state.entries()].sort()).toEqual([...a.state.entries()].sort())
        expect(b.applied).toHaveLength(0)
      }),
      { numRuns: 300 },
    )
  })
})
