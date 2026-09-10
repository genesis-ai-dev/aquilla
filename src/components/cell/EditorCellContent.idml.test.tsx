import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { SanitizedRichHtml, TargetIdmlHtml } from "./EditorCellContent"

const SOURCE_HTML =
  `<p data-idml-version="2">`
  + `<span data-idml-slot="0" data-idml-character-style="CharacterStyle/Body" data-idml-protected="slot">Regular </span>`
  + `<span data-idml-slot="1" data-idml-character-style="CharacterStyle/Bold" data-idml-protected="slot">bold</span>`
  + `<span data-idml-slot="2" data-idml-character-style="CharacterStyle/Italic" data-idml-protected="slot"> italic</span>`
  + `<span data-idml-slot="3" data-idml-character-style="CharacterStyle/k" data-idml-protected="slot">Greece:</span>`
  + `</p>`

describe("IDML cell style display", () => {
  it("shows imported Bold and Italic on the source read surface", () => {
    const { container } = render(<SanitizedRichHtml html={SOURCE_HTML} />)
    const bold = container.querySelector("[data-idml-character-style=\"CharacterStyle/Bold\"]") as HTMLElement
    const italic = container.querySelector("[data-idml-character-style=\"CharacterStyle/Italic\"]") as HTMLElement
    const body = container.querySelector("[data-idml-character-style=\"CharacterStyle/Body\"]") as HTMLElement
    expect(bold?.textContent).toBe("bold")
    expect(bold.style.fontWeight).toBe("700")
    expect(italic?.textContent).toBe(" italic")
    expect(italic.style.fontStyle).toBe("italic")
    expect(body.style.fontWeight).toBe("")
    expect(body.style.fontStyle).toBe("")
    const keyword = container.querySelector("[data-idml-character-style=\"CharacterStyle/k\"]") as HTMLElement
    expect(keyword?.textContent).toBe("Greece:")
    expect(keyword.style.fontWeight).toBe("700")
  })

  it("shows the same faces on the target read surface, including catalog-named styles", () => {
    const html = SOURCE_HTML.replace("CharacterStyle/Italic", "CharacterStyle/Emphasis")
    const { container } = render(
      <TargetIdmlHtml
        html={html}
        idmlStyleCatalog={{ "CharacterStyle/Emphasis": { bold: false, italic: true } }}
      />,
    )
    const emphasis = container.querySelector("[data-idml-character-style=\"CharacterStyle/Emphasis\"]") as HTMLElement
    const bold = container.querySelector("[data-idml-character-style=\"CharacterStyle/Bold\"]") as HTMLElement
    expect(emphasis.style.fontStyle).toBe("italic")
    expect(bold.style.fontWeight).toBe("700")
  })

  it("shows Treasure Hunt heading bold from the paragraph style when the run is unstyled", () => {
    const html =
      `<p data-idml-version="2">`
      + `<span data-idml-slot="0" data-idml-character-style="CharacterStyle/$ID/[No character style]" data-idml-protected="slot">Genesis 1:1</span>`
      + `</p>`
    const { container } = render(
      <SanitizedRichHtml
        html={html}
        idmlParagraphStyleId="ParagraphStyle/!meta_hunt_head"
      />,
    )
    const slot = container.querySelector(
      "[data-idml-character-style=\"CharacterStyle/$ID/[No character style]\"]",
    ) as HTMLElement
    expect(slot?.textContent).toBe("Genesis 1:1")
    expect(slot.style.fontWeight).toBe("700")
  })
})
