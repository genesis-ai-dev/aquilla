// compress.ts — pipe-table compression + per-run UUID aliasing (design §4).
// WHY these assertions: the agent round-trips aliases between sql() results
// and later sql()/emit() calls, so alias stability and bidirectional
// resolution are correctness requirements, not formatting niceties. Silent
// truncation would make the model trust a partial read — the overflow note
// is load-bearing.

import { describe, it, expect } from "vitest"
import { AliasMap, compressRows, ROW_CAP } from "../lib/agent/compress"

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

describe("AliasMap", () => {
  it("assigns stable aliases and resolves them back (bidirectional, per run)", () => {
    const m = new AliasMap()
    const a1 = m.alias(u(1), "c")
    expect(a1).toBe("#c1")
    // Stability across calls in one run — same UUID, same alias.
    expect(m.alias(u(1), "c")).toBe("#c1")
    expect(m.alias(u(2), "c")).toBe("#c2")
    expect(m.alias(u(3), "e")).toBe("#e1")
    expect(m.alias(u(4), "f")).toBe("#f1")
    expect(m.resolve("#c1")).toBe(u(1))
    expect(m.resolve("#e1")).toBe(u(3))
    expect(m.resolve("#zz9")).toBeUndefined()
  })
})

describe("compressRows", () => {
  it("renders a pipe table with ∅ for nulls and aliased UUIDs", () => {
    const m = new AliasMap()
    const out = compressRows(
      [
        { cell_id: u(1), value: "In the beginning", canonical_ref: null },
        { cell_id: u(2), value: "And the earth", canonical_ref: "GEN 1:2" },
      ],
      m,
    )
    const lines = out.split("\n")
    expect(lines[0]).toBe("cell_id|value|canonical_ref")
    expect(lines[1]).toBe("#c1|In the beginning|∅")
    expect(lines[2]).toBe("#c2|And the earth|GEN 1:2")
    expect(lines[3]).toBe("(2 rows)")
  })

  it("keeps aliases stable across separate compress calls in one run", () => {
    const m = new AliasMap()
    const first = compressRows([{ cell_id: u(7), value: "a" }], m)
    const second = compressRows([{ cell_id: u(7), value: "b" }], m)
    expect(first).toContain("#c1|a")
    expect(second).toContain("#c1|b")
  })

  it("renders the run's project id as :project, not an alias", () => {
    const m = new AliasMap()
    const projectId = u(99)
    const out = compressRows([{ project_id: projectId, file_id: u(5) }], m, { projectId })
    expect(out).toContain(":project|#f1")
  })

  it("flags overflow explicitly when more than ROW_CAP rows come back", () => {
    const m = new AliasMap()
    const rows = Array.from({ length: ROW_CAP + 1 }, (_, i) => ({ n: i }))
    const out = compressRows(rows, m)
    const lines = out.split("\n")
    // header + ROW_CAP rows + note
    expect(lines).toHaveLength(1 + ROW_CAP + 1)
    expect(lines[lines.length - 1]).toContain("and more exist")
  })

  it("does not flag overflow at exactly ROW_CAP rows", () => {
    const m = new AliasMap()
    const rows = Array.from({ length: ROW_CAP }, (_, i) => ({ n: i }))
    const out = compressRows(rows, m)
    expect(out).toContain(`(${ROW_CAP} rows)`)
    expect(out).not.toContain("more exist")
  })

  it("escapes pipes and newlines so values cannot break the table grammar", () => {
    const m = new AliasMap()
    const out = compressRows([{ value: "a|b\nc" }], m)
    expect(out.split("\n")[1]).toBe("a\\|b ⏎ c")
  })
})
