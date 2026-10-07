import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import type { Concept, TermMatchingSettings } from "@/lib/terminology/types"
import { SourceWithTermLookup } from "./EditorTable"

function concept(sourceTerm: string, id = sourceTerm): Concept {
  return {
    id,
    sourceTerm,
    renderings: [],
    status: "active",
    createdAt: "2026-09-02T00:00:00.000Z",
  }
}

function renderSource(text: string, concepts: Concept[], termMatching?: TermMatchingSettings) {
  return render(
    <I18nProvider>
      <SourceWithTermLookup
        text={text}
        highlights={[]}
        ranges={[]}
        showEvidence={false}
        concepts={concepts}
        termMatching={termMatching}
      />
    </I18nProvider>,
  )
}

describe("source key-term highlights", () => {
  it("highlights a multi-word concept as one term", () => {
    // Many of the terms a project actually manages are phrases ("Holy
    // Spirit", "son of man"). Matching token-by-token can never see them, so
    // the translator got no signal on exactly the terms most at risk.
    const { container } = renderSource("The Holy Spirit came.", [concept("Holy Spirit")])

    const marks = container.querySelectorAll(".terminology-highlight")
    expect(marks).toHaveLength(1)
    expect(marks[0]).toHaveTextContent("Holy Spirit")
  })

  it("highlights single-word concepts, punctuation and case notwithstanding", () => {
    const { container } = renderSource("god, God and GOD.", [concept("God")])

    expect(container.querySelectorAll(".terminology-highlight")).toHaveLength(3)
  })

  it("honours the wildcard the rest of the terminology stack honours", () => {
    // `grac*` matches inflections everywhere else (enforcement, target chips);
    // the source column disagreeing with them is the bug behind this test.
    const { container } = renderSource("grace and graced", [concept("grac*")])

    const marks = container.querySelectorAll(".terminology-highlight")
    expect(marks).toHaveLength(2)
    expect(marks[1]).toHaveTextContent("graced")
  })

  it("keeps the source text intact around a match", () => {
    const { container } = renderSource("The Holy Spirit came.", [concept("Holy Spirit")])
    expect(container.textContent).toBe("The Holy Spirit came.")
  })

  it("prefers the longer term when two concepts overlap", () => {
    // "Spirit" inside "Holy Spirit" must not split the phrase into two chips.
    const { container } = renderSource("The Holy Spirit came.", [
      concept("Spirit"),
      concept("Holy Spirit"),
    ])

    const marks = container.querySelectorAll(".terminology-highlight")
    expect(marks).toHaveLength(1)
    expect(marks[0]).toHaveTextContent("Holy Spirit")
  })

  // AQU-1272: the popover used to compare the source text against the concept's
  // headword STRING, so a project that had taught the matcher about prefixes and
  // pointing got silence on exactly those occurrences.
  it("highlights a prefixed occurrence of a pointed term with the project's affix inventory", () => {
    const { container } = renderSource(
      "בְּרֵאשִׁית וְהָאָ֗רֶץ הָיְתָה",
      [concept("הָאָ֗רֶץ", "haaretz")],
      { prefixes: ["ו", "ה", "ב", "ל"], suffixes: ["ים"] },
    )

    const marks = container.querySelectorAll(".terminology-highlight")
    expect(marks).toHaveLength(1)
    expect(marks[0]).toHaveTextContent("וְהָאָ֗רֶץ")
  })

  it("highlights an alternate form listed on the concept", () => {
    const { container } = renderSource("we sought shalom", [
      { ...concept("peace"), match: { forms: ["shalom"] } },
    ])

    const marks = container.querySelectorAll(".terminology-highlight")
    expect(marks).toHaveLength(1)
    expect(marks[0]).toHaveTextContent("shalom")
  })

  it("leaves an excluded surface form alone", () => {
    const { container } = renderSource("grace in Graceland", [
      { ...concept("grace"), match: { excludedForms: ["Graceland"] } },
    ])

    const marks = container.querySelectorAll(".terminology-highlight")
    expect(marks).toHaveLength(1)
    expect(marks[0]).toHaveTextContent("grace")
  })

  it("renders plain text when no concept matches", () => {
    const { container } = renderSource("Nothing to see.", [concept("Holy Spirit")])

    expect(container.querySelector(".terminology-highlight")).toBeNull()
    expect(container.textContent).toBe("Nothing to see.")
  })
})
