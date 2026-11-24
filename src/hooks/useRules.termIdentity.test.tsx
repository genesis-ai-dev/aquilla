// AQU-2654: a re-read of the project or its concepts that changes nothing must
// not hand the editor a new `rules` array. Everything downstream is memoized
// on it — the health pass's rule signature over the whole glossary, the rule
// map every row receives — and "the app went blank when I came back to the
// tab" was, in part, all of that restarting for an identical answer.

import { describe, it, expect } from "vitest"
import { renderHook } from "@testing-library/react"
import { sameTerminologyRules, useRules } from "./useRules"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { Concept } from "@/lib/terminology/types"
import { compileConceptsToRules } from "@/lib/terminology/compile"

function concept(id: string, sourceTerm: string, more: Partial<Concept> = {}): Concept {
  return {
    id,
    sourceTerm,
    renderings: [
      { rendering: `r-${id}`, status: "preferred" },
      { rendering: `bad-${id}`, status: "forbidden" },
    ],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...more,
  }
}

function project(more: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "p1",
    name: "P",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: "2026-01-01T00:00:00.000Z",
    files: [],
    members: [],
    termMatching: { prefixes: ["un"], suffixes: ["s"] },
    ...more,
  }
}

const noop = () => {}

/** A deep copy: what a second read of the same server state deserializes to. */
function reread<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe("useRules — terminology rule identity", () => {
  const concepts = [concept("a", "grace", { match: { forms: ["mercy"] } }), concept("b", "spirit", { notes: "a note" })]

  it("keeps the same rules array when the project and the concepts are re-read unchanged", () => {
    let props = { project: project(), concepts }
    const { result, rerender } = renderHook(() =>
      useRules(props.project, noop, undefined, undefined, undefined, "", props.concepts),
    )
    const first = result.current.rules
    expect(first.filter((r) => r.id.startsWith("term:")).map((r) => r.id)).toEqual([
      "term:a:approved", "term:a:forbidden:bad-a", "term:b:approved", "term:b:forbidden:bad-b",
    ])

    // New objects all the way down, same content.
    props = { project: reread(props.project), concepts: reread(concepts) }
    rerender()
    expect(result.current.rules).toBe(first)
  })

  it.each<[string, (c: Concept[]) => Concept[], Partial<ProjectRecord>]>([
    ["a rendering changes", (c) => [{ ...c[0], renderings: [{ rendering: "gracia", status: "preferred" }] }, c[1]], {}],
    ["a forbidden rendering is added", (c) => [c[0], { ...c[1], renderings: [...c[1].renderings, { rendering: "spook", status: "forbidden" }] }], {}],
    ["a form is added", (c) => [{ ...c[0], match: { forms: ["mercy", "favour"] } }, c[1]], {}],
    ["a note changes", (c) => [c[0], { ...c[1], notes: "another note" }], {}],
    ["a term becomes case-sensitive", (c) => [{ ...c[0], caseSensitive: true }, c[1]], {}],
    ["a term is deactivated", (c) => [c[0], { ...c[1], status: "draft" }], {}],
    ["the order changes", (c) => [c[1], c[0]], {}],
    ["the affix inventory changes", (c) => c, { termMatching: { prefixes: ["un", "re"], suffixes: ["s"] } }],
  ])("publishes a new array when %s", (_name, change, projectChange) => {
    let props = { project: project(), concepts }
    const { result, rerender } = renderHook(() =>
      useRules(props.project, noop, undefined, undefined, undefined, "", props.concepts),
    )
    const first = result.current.rules
    props = { project: project(projectChange), concepts: change(reread(concepts)) }
    rerender()
    expect(result.current.rules).not.toBe(first)
    // … and it is what compiling the changed terminology gives.
    const expected = compileConceptsToRules(props.concepts, props.project.termMatching)
    expect(sameTerminologyRules(result.current.rules.filter((r) => r.id.startsWith("term:")), expected)).toBe(true)
    expect(sameTerminologyRules(first.filter((r) => r.id.startsWith("term:")), expected)).toBe(false)
  })
})
