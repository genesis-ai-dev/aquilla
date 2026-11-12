/**
 * AQU-1135 — key terms in a FORMATTED source cell.
 *
 * The plain-text source path highlights managed terms and opens a lookup
 * popover on click. A cell carrying inline markup rendered through
 * `SanitizedRichHtml` instead and got neither, so on any project whose import
 * produced formatting the key terms were simply not there to click.
 */

import { describe, expect, it } from "vitest"
import type { Concept } from "@/lib/terminology/types"
import { decorateTermsInHtml } from "./terminology-html"

function concept(sourceTerm: string, overrides: Partial<Concept> = {}): Concept {
  return {
    id: sourceTerm,
    sourceTerm,
    renderings: [],
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

function parse(html: string): HTMLElement {
  const host = document.createElement("div")
  host.innerHTML = html
  return host
}

describe("decorateTermsInHtml", () => {
  it("marks a term inside formatted source so it can be clicked", () => {
    const out = decorateTermsInHtml("The <b>Spirit</b> came.", [concept("Spirit")])
    const marks = parse(out).querySelectorAll(".term-chip-host[data-source-term]")

    expect(marks).toHaveLength(1)
    expect(marks[0]).toHaveTextContent("Spirit")
    expect(marks[0].getAttribute("data-source-term")).toBe("Spirit")
    // The formatting the cell was rendered for survives the decoration.
    expect(parse(out).querySelector("b")).not.toBeNull()
  })

  it("keeps the source text byte-for-byte intact", () => {
    const out = decorateTermsInHtml("The <b>Spirit</b> came.", [concept("Spirit")])
    expect(parse(out).textContent).toBe("The Spirit came.")
  })

  it("matches a multi-word term split across markup", () => {
    // "<b>Holy</b> Spirit" is one term to a translator and two text nodes to
    // the DOM. Matching per text node would silently miss exactly the phrase
    // terms most at risk, so the matcher runs over the flattened text.
    const out = decorateTermsInHtml("The <b>Holy</b> Spirit came.", [concept("Holy Spirit")])
    const marks = parse(out).querySelectorAll("[data-source-term]")

    expect(marks.length).toBeGreaterThan(0)
    expect([...marks].every((m) => m.getAttribute("data-source-term") === "Holy Spirit")).toBe(true)
    expect([...marks].map((m) => m.textContent).join("")).toBe("Holy Spirit")
    expect(parse(out).textContent).toBe("The Holy Spirit came.")
  })

  it("does not match a term across a paragraph boundary", () => {
    // Two separate lines, not the phrase. A block edge ends a run of text.
    const out = decorateTermsInHtml("<p>Holy</p><p>Spirit came.</p>", [concept("Holy Spirit")])
    expect(parse(out).querySelector("[data-source-term]")).toBeNull()
  })

  it("prefers the longer term when two concepts overlap", () => {
    const out = decorateTermsInHtml("The <i>Holy Spirit</i> came.", [
      concept("Spirit"),
      concept("Holy Spirit"),
    ])
    const marks = parse(out).querySelectorAll("[data-source-term]")

    expect(marks).toHaveLength(1)
    expect(marks[0]).toHaveTextContent("Holy Spirit")
  })

  it("honours the wildcard the rest of the terminology stack honours", () => {
    const out = decorateTermsInHtml("<b>grace</b> and graced", [concept("grac*")])
    const marks = parse(out).querySelectorAll("[data-source-term]")

    expect(marks).toHaveLength(2)
    // The CONCEPT is the lookup key, not the inflection that matched it.
    expect(marks[1].getAttribute("data-source-term")).toBe("grac*")
    expect(marks[1]).toHaveTextContent("graced")
  })

  it("ignores concepts that are not active", () => {
    const out = decorateTermsInHtml("The <b>Spirit</b> came.", [
      concept("Spirit", { status: "draft" }),
    ])
    expect(parse(out).querySelector("[data-source-term]")).toBeNull()
  })

  it("returns the html untouched when nothing matches", () => {
    const html = "The <b>Spirit</b> came."
    expect(decorateTermsInHtml(html, [concept("Wisdom")])).toBe(html)
    expect(decorateTermsInHtml(html, [])).toBe(html)
    expect(decorateTermsInHtml(html, undefined)).toBe(html)
  })

  it("does not re-escape markup-significant characters in the source text", () => {
    // The decorated string goes back through dangerouslySetInnerHTML, so a
    // literal `<` in the text must stay escaped exactly once.
    const out = decorateTermsInHtml("a &lt;b&gt; Spirit", [concept("Spirit")])
    expect(parse(out).textContent).toBe("a <b> Spirit")
    expect(parse(out).querySelectorAll("[data-source-term]")).toHaveLength(1)
  })

  it("names the highlight for a screen reader only when the caller supplies a label", () => {
    const labelled = parse(
      decorateTermsInHtml("The <b>Spirit</b> came.", [concept("Spirit")], {
        label: (term) => `Managed term: ${term}`,
      }),
    ).querySelector("[data-source-term]")!
    expect(labelled.getAttribute("role")).toBe("button")
    expect(labelled.getAttribute("tabindex")).toBe("0")
    expect(labelled.getAttribute("aria-label")).toBe("Managed term: Spirit")

    // An unnamed button is worse than none — stay a plain span without a label.
    const plain = parse(
      decorateTermsInHtml("The <b>Spirit</b> came.", [concept("Spirit")]),
    ).querySelector("[data-source-term]")!
    expect(plain.getAttribute("role")).toBeNull()
  })

  // AQU-1272: this path matched the concept's headword STRING, so it disagreed
  // with enforcement and the stats on affixed / differently-pointed occurrences
  // and on alternate forms — the plain-text path had the same gap.
  it("marks a prefixed occurrence of a pointed term with the project's affix inventory", () => {
    const out = decorateTermsInHtml(
      "בְּרֵאשִׁית <b>וְהָאָ֗רֶץ</b> הָיְתָה",
      [concept("הָאָ֗רֶץ")],
      { termMatching: { prefixes: ["ו", "ה", "ב", "ל"], suffixes: ["ים"] } },
    )
    const marks = parse(out).querySelectorAll("[data-source-term]")

    expect(marks).toHaveLength(1)
    expect(marks[0]).toHaveTextContent("וְהָאָ֗רֶץ")
    // The entry looks itself up, not the inflection that matched.
    expect(marks[0].getAttribute("data-source-term")).toBe("הָאָ֗רֶץ")
  })

  it("marks an alternate form and leaves an excluded one alone", () => {
    const out = decorateTermsInHtml(
      "<b>shalom</b> in Graceland",
      [concept("peace", { match: { forms: ["shalom"], excludedForms: ["Graceland"] } })],
    )
    const marks = parse(out).querySelectorAll("[data-source-term]")

    expect(marks).toHaveLength(1)
    expect(marks[0]).toHaveTextContent("shalom")
  })
})
