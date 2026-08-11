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

  it("styles the count itself while the number still selects the plural form", () => {
    // A counted sentence may need its NUMBER emphasised — the endorsement count
    // and the outbox counts all are. That needs the count in two roles at once:
    // it chooses the plural category AND it is rendered as markup. If it were
    // interpolated as text like any other var, the digits would land in the
    // string and there would be nothing left for the markup to wrap.
    render(
      <I18nProvider>
        <p data-testid="line">
          <RichMessage
            k="editor.expansion.endorsements"
            count={1}
            values={{
              count: <span data-testid="count">1</span>,
              percent: 40,
            }}
          />
        </p>
      </I18nProvider>,
    )
    expect(screen.getByTestId("count").tagName).toBe("SPAN")
    // Singular, because 1 reached plural selection despite not being interpolated.
    expect(screen.getByTestId("line").textContent).toBe("1 endorsement · support 40%")
  })

  it("still interpolates {count} as text when values does not render it", () => {
    render(
      <I18nProvider>
        <p data-testid="line">
          <RichMessage k="editor.expansion.endorsements" count={2} values={{ percent: 40 }} />
        </p>
      </I18nProvider>,
    )
    expect(screen.getByTestId("line").textContent).toBe("2 endorsements · support 40%")
  })
})
