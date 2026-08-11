import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { I18nProvider } from "./I18nProvider"
import { RichMessage, renderRichMessage } from "./RichMessage"

describe("renderRichMessage", () => {
  it("substitutes a node for its placeholder and keeps the surrounding text", () => {
    const parts = renderRichMessage("Attached to {ref}.", { ref: <em>Gen 1:1</em> })
    expect(parts).toHaveLength(3)
    expect(parts[0]).toBe("Attached to ")
    expect(parts[2]).toBe(".")
  })

  it("substitutes in the translation's order, not the call site's", () => {
    // The whole point: Burmese and Arabic reorder the sentence, and the component
    // must follow the translated string rather than assuming English order.
    const values = { a: <em>A</em>, b: <strong>B</strong> }
    const english = renderRichMessage("{a} before {b}", values)
    const reordered = renderRichMessage("{b} ကို {a}", values)
    expect(english[0]).toBe(values.a)
    expect(reordered[0]).toBe(values.b)
  })

  it("leaves an unsupplied placeholder literal rather than rendering undefined", () => {
    // A missing value should be obvious in review. "undefined" mid-sentence reads
    // like a crash to a user; "{ref}" reads like the bug it is to a developer.
    expect(renderRichMessage("Attached to {ref}.", {})).toContain("{ref}")
  })

  it("drops a placeholder the translation omits", () => {
    // A translator legitimately may not need every placeholder. That must not
    // leave a stray node floating at the end of the sentence.
    const parts = renderRichMessage("No notes here.", { ref: <em>Gen 1:1</em> })
    expect(parts).toEqual(["No notes here."])
  })

  it("handles a string that is only a placeholder", () => {
    const ref = <em>Gen 1:1</em>
    expect(renderRichMessage("{ref}", { ref })).toEqual([ref])
  })
})

describe("RichMessage", () => {
  it("renders the markup around the placeholder, not flattened text", () => {
    render(
      <I18nProvider>
        <p>
          <RichMessage
            k="language.switchTo"
            values={{ language: <strong data-testid="emph">ไทย</strong> }}
          />
        </p>
      </I18nProvider>,
    )
    // The styled node survives translation — this is the regression the wave-3
    // review found seven times, where emphasis carrying meaning was flattened
    // into plain text when the sentence became a single key.
    const emphasised = screen.getByTestId("emph")
    expect(emphasised.tagName).toBe("STRONG")
    expect(emphasised).toHaveTextContent("ไทย")
    expect(screen.getByText(/Switch language to/)).toBeInTheDocument()
  })

  it("renders a count as a node while the number still selects the plural form", () => {
    // The count is frequently the part that carries markup (a bold, tabular
    // numeral in an otherwise muted line). Both of the number's jobs must
    // survive: selecting the plural form, AND being drawn by the caller's
    // element. Handing it to `t()` as a var did only the first — interpolation
    // replaced `{count}` with bare digits, so the styled node was silently
    // dropped even though the docblock promises `values` overrides `{count}`.
    const { rerender } = render(
      <I18nProvider>
        <p data-testid="line">
          <RichMessage
            k="nav.outbox.summaryEdits"
            count={3}
            values={{ count: <b data-testid="n">3</b> }}
          />
        </p>
      </I18nProvider>,
    )
    expect(screen.getByTestId("n").tagName).toBe("B")
    expect(screen.getByTestId("line").textContent).toBe("3 edits")

    rerender(
      <I18nProvider>
        <p data-testid="line">
          <RichMessage
            k="nav.outbox.summaryEdits"
            count={1}
            values={{ count: <b data-testid="n">1</b> }}
          />
        </p>
      </I18nProvider>,
    )
    // Selection still sees the real number: a `count === 1` branch at the call
    // site cannot serve Arabic's six categories, which is why `count` exists.
    expect(screen.getByTestId("line").textContent).toBe("1 edit")
  })

  it("interpolates scalar values as plain text in the same sentence", () => {
    render(
      <I18nProvider>
        <p data-testid="line">
          <RichMessage k="language.switchTo" values={{ language: "Burmese" }} />
        </p>
      </I18nProvider>,
    )
    expect(screen.getByTestId("line").textContent).toBe("Switch language to Burmese")
  })
})
