// AQU-2655: a first screen that mentions many glossary terms for the first time
// would compile a regex per term inside render before any row painted (~1.4 s
// at 1x for 200 terms). The source highlights compile a bounded number in
// render and the rest in idle slices, and every row gets its highlights.

import { describe, it, expect } from "vitest"
import { render, renderHook, waitFor } from "@testing-library/react"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { SourceWithTermLookup } from "@/components/EditorTable"
import { conceptPatternsCompiled } from "@/lib/terminology/match"
import type { Concept } from "@/lib/terminology/types"
import { useSourceTermMatches } from "./useSourceTermMatches"

/** `count` concepts, each named by a word no other test has compiled. */
function glossary(prefix: string, count: number): Concept[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    sourceTerm: `${prefix}word${i}`,
    renderings: [],
    status: "active",
    createdAt: "2026-11-20T00:00:00.000Z",
  }))
}

describe("useSourceTermMatches", () => {
  it("matches synchronously when the text needs few new patterns", () => {
    // Every edit and every ordinary file: nothing about the first paint changes.
    const concepts = glossary("few", 3)
    const text = `the ${concepts[0].sourceTerm} and the ${concepts[2].sourceTerm}`
    const { result } = renderHook(() => useSourceTermMatches(text, concepts, undefined))

    expect(result.current?.map((m) => text.slice(m.start, m.end))).toEqual([
      concepts[0].sourceTerm,
      concepts[2].sourceTerm,
    ])
  })

  it("defers a row whose new patterns exceed the render budget, then answers it in full", async () => {
    const concepts = glossary("one", 40)
    const text = concepts.map((c) => c.sourceTerm).join(" ")

    const before = conceptPatternsCompiled()
    const { result } = renderHook(() => useSourceTermMatches(text, concepts, undefined))
    // Nothing compiled in render: the row asked for more than one pass may spend.
    expect(conceptPatternsCompiled() - before).toBe(0)
    expect(result.current).toBeNull()

    await waitFor(() => expect(result.current).not.toBeNull())
    expect(result.current).toHaveLength(40)
    expect(conceptPatternsCompiled() - before).toBe(40)
  })
})

describe("source highlights on a dense first screen", () => {
  it("compiles a bounded number of patterns in render, marks the rest busy, and highlights every row", async () => {
    // 30 rows, each mentioning 2 terms of its own: 60 patterns to compile.
    const concepts = glossary("screen", 60)
    const rows = Array.from({ length: 30 }, (_, i) =>
      `In the ${concepts[2 * i].sourceTerm} was the ${concepts[2 * i + 1].sourceTerm}.`,
    )

    const before = conceptPatternsCompiled()
    const { container } = render(
      <I18nProvider>
        {rows.map((text) => (
          <SourceWithTermLookup
            key={text}
            text={text}
            highlights={[]}
            ranges={[]}
            showEvidence={false}
            concepts={concepts}
          />
        ))}
      </I18nProvider>,
    )

    // Render compiled a bounded number, the top rows first …
    const compiledInRender = conceptPatternsCompiled() - before
    expect(compiledInRender).toBeGreaterThan(0)
    expect(compiledInRender).toBeLessThanOrEqual(16)
    // … and the rows still waiting say so instead of looking finished.
    expect(container.querySelectorAll("[aria-busy='true']").length).toBeGreaterThan(0)
    expect(container.textContent).toBe(rows.join(""))

    // Nothing is dropped: every row ends with both of its terms highlighted.
    await waitFor(() => expect(container.querySelectorAll(".terminology-highlight")).toHaveLength(60))
    expect(container.querySelectorAll("[aria-busy='true']")).toHaveLength(0)
    expect(container.textContent).toBe(rows.join(""))
  })
})
