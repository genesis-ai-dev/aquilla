// AQU-1688 — Bible data checks in the editor's incremental health pass.
//
// WHY: the spec's invariant is that expectation checks are pure per cell, so a
// keystroke in one cell never re-evaluates another (rule-engine.ts). The Bible
// data checks read facts about the whole passage, so this pins that they reach
// the engine as one cell's own compiled input: a cache miss for the edited
// cell looks up that cell's context alone, and every other cell keeps its
// cached result.

import { describe, it, expect, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { checkRulesForCell } from "@/lib/rules/rule-engine"
vi.mock("@/lib/rules/rule-engine", { spy: true })

import { useHealth, type HealthCell } from "./useHealth"
import { resolveBuiltinRules } from "@/lib/lqa/builtin-resolver"
import { buildCellCheckContexts } from "@/lib/bible-data/check-context"
import { JHN4_STRUCTURE, JHN4_VOICES } from "../../db/shared/bible-checks/__fixtures__/pack"

const PROFILE = {
  quoteMarks: { levels: [{ open: "“", close: "”" }, { open: "‘", close: "’" }], continuation: "reopen-each-paragraph" as const },
}
const WEB: Record<string, string> = {
  c7: "A woman of Samaria came to draw water. Jesus said to her, “Give me a drink.”",
  c8: "For his disciples had gone away into the city to buy food.",
  c9: "The Samaritan woman therefore said to him, “How is it that you, being a Jew, ask for a drink from me, a Samaritan woman?” (For Jews have no dealings with Samaritans.)",
}
const contexts = buildCellCheckContexts(
  Object.keys(WEB).map((id) => ({ id, globalReferences: [`JHN 4:${id.slice(1)}`] })),
  JHN4_VOICES,
  JHN4_STRUCTURE,
  PROFILE,
)
const rules = resolveBuiltinRules(undefined, { bibleChecks: true })

function cells(texts: Record<string, string>): Map<string, HealthCell[]> {
  return new Map([[
    "f",
    Object.entries(texts).map(([id, translated]) => ({ id, status: "unvalidated" as const, original: "src", translated })),
  ]])
}

describe("useHealth with Bible data checks", () => {
  it("re-checks only the edited cell, from that cell's own context", () => {
    const lookup = vi.fn((cell: HealthCell) => contexts.get(cell.id))
    let files = cells(WEB)
    const { result, rerender } = renderHook(() =>
      useHealth(files, rules, { cellCheckContext: lookup, cellCheckContextSig: "pack-1" }),
    )
    expect(result.current.infractions.size).toBe(0)
    expect(lookup.mock.calls.map(([cell]) => cell.id).sort()).toEqual(["c7", "c8", "c9"])

    lookup.mockClear()
    vi.mocked(checkRulesForCell).mockClear()
    // The translator drops the closing mark in 4:9.
    files = cells({ ...WEB, c9: WEB.c9.replace("woman?”", "woman?") })
    rerender()

    expect(lookup.mock.calls.map(([cell]) => cell.id)).toEqual(["c9"])
    expect(vi.mocked(checkRulesForCell).mock.calls.map(([cell]) => cell.id)).toEqual(["c9"])
    expect(vi.mocked(checkRulesForCell).mock.calls[0][3]).toBe(contexts.get("c9"))
    expect(result.current.infractions.get("c9")?.map((i) => i.ruleId)).toEqual(["builtin:bkp:V2"])
  })

  it("re-checks every cell when the pack, refs or Language profile change (a new signature)", () => {
    const lookup = vi.fn((cell: HealthCell) => contexts.get(cell.id))
    const files = cells(WEB)
    let sig = "pack-1"
    const { rerender } = renderHook(() => useHealth(files, rules, { cellCheckContext: lookup, cellCheckContextSig: sig }))
    lookup.mockClear()
    rerender()
    expect(lookup).not.toHaveBeenCalled()
    sig = "pack-2"
    rerender()
    expect(lookup.mock.calls.map(([cell]) => cell.id).sort()).toEqual(["c7", "c8", "c9"])
  })
})
