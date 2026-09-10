import { describe, expect, it } from "vitest"
import {
  IDML_STYLE_BOLD_CLASS,
  IDML_STYLE_ITALIC_CLASS,
  decorateIdmlStyleElement,
  idmlCharacterStyleEmphasis,
  looksLikeIdmlHtml,
  prepareIdmlDisplayHtml,
} from "./idml-style-display"

describe("idmlCharacterStyleEmphasis", () => {
  it("picks Bold and Italic from imported character-style ids", () => {
    expect(idmlCharacterStyleEmphasis("CharacterStyle/Bold")).toEqual({ bold: true, italic: false })
    expect(idmlCharacterStyleEmphasis("CharacterStyle/Italic")).toEqual({ bold: false, italic: true })
    expect(idmlCharacterStyleEmphasis("CharacterStyle/Bold Italic")).toEqual({ bold: true, italic: true })
    expect(idmlCharacterStyleEmphasis("CharacterStyle/char%3aItalic")).toEqual({ bold: false, italic: true })
    expect(idmlCharacterStyleEmphasis("CharacterStyle/bd")).toEqual({ bold: true, italic: false })
    expect(idmlCharacterStyleEmphasis("CharacterStyle/k")).toEqual({ bold: true, italic: false })
    expect(idmlCharacterStyleEmphasis("CharacterStyle/k_xt")).toEqual({ bold: true, italic: false })
    expect(idmlCharacterStyleEmphasis("CharacterStyle/it")).toEqual({ bold: false, italic: true })
    expect(idmlCharacterStyleEmphasis("CharacterStyle/em")).toEqual({ bold: false, italic: true })
    expect(idmlCharacterStyleEmphasis("CharacterStyle/bdit")).toEqual({ bold: true, italic: true })
    expect(idmlCharacterStyleEmphasis("CharacterStyle/_meta_style%3abold")).toEqual({
      bold: true,
      italic: false,
    })
    expect(idmlCharacterStyleEmphasis("CharacterStyle/_meta_style%3aitalic")).toEqual({
      bold: false,
      italic: true,
    })
    expect(idmlCharacterStyleEmphasis("ParagraphStyle/!meta_hunt_head")).toEqual({
      bold: true,
      italic: false,
    })
    expect(idmlCharacterStyleEmphasis("ParagraphStyle/_intro_head")).toEqual({
      bold: true,
      italic: false,
    })
    expect(idmlCharacterStyleEmphasis("ParagraphStyle/!meta_fact_head")).toEqual({
      bold: false,
      italic: false,
    })
  })

  it("does not treat weight aliases or underline as emphasis", () => {
    expect(idmlCharacterStyleEmphasis("CharacterStyle/Body")).toEqual({ bold: false, italic: false })
    expect(idmlCharacterStyleEmphasis("CharacterStyle/$ID/[No character style]")).toEqual({
      bold: false,
      italic: false,
    })
    expect(idmlCharacterStyleEmphasis("CharacterStyle/Black")).toEqual({ bold: false, italic: false })
    expect(idmlCharacterStyleEmphasis("CharacterStyle/Underline")).toEqual({ bold: false, italic: false })
    expect(idmlCharacterStyleEmphasis("CharacterStyle/Embolden")).toEqual({ bold: false, italic: false })
  })

  it("prefers a Styles.xml catalog over the style name", () => {
    expect(idmlCharacterStyleEmphasis("CharacterStyle/Emphasis", {
      "CharacterStyle/Emphasis": { bold: false, italic: true },
    })).toEqual({ bold: false, italic: true })
  })
})

describe("prepareIdmlDisplayHtml", () => {
  const html =
    `<p data-idml-version="2">`
    + `<span data-idml-slot="0" data-idml-character-style="CharacterStyle/Body" data-idml-protected="slot">Plain</span>`
    + `<span data-idml-slot="1" data-idml-character-style="CharacterStyle/Bold" data-idml-protected="slot">Bold</span>`
    + `<span data-idml-slot="2" data-idml-character-style="CharacterStyle/Italic" data-idml-protected="slot">Italic</span>`
    + `</p>`

  it("paints display-only bold and italic onto protected slots", () => {
    const decorated = prepareIdmlDisplayHtml(html)
    const root = document.createElement("div")
    root.innerHTML = decorated
    const [plain, bold, italic] = [...root.querySelectorAll<HTMLElement>("span[data-idml-protected=\"slot\"]")]
    expect(plain?.classList.contains(IDML_STYLE_BOLD_CLASS)).toBe(false)
    expect(plain?.style.fontWeight).toBe("")
    expect(bold?.classList.contains(IDML_STYLE_BOLD_CLASS)).toBe(true)
    expect(bold?.style.fontWeight).toBe("700")
    expect(italic?.classList.contains(IDML_STYLE_ITALIC_CLASS)).toBe(true)
    expect(italic?.style.fontStyle).toBe("italic")
    expect(bold?.getAttribute("data-idml-character-style")).toBe("CharacterStyle/Bold")
  })

  it("inherits a Treasure Hunt heading paragraph onto [No character style] slots", () => {
    const huntHtml =
      `<p data-idml-version="2">`
      + `<span data-idml-slot="0" data-idml-character-style="CharacterStyle/$ID/[No character style]" data-idml-protected="slot">Genesis 1</span>`
      + `</p>`
    const decorated = prepareIdmlDisplayHtml(
      huntHtml,
      { "ParagraphStyle/!meta_hunt_head": { bold: true, italic: false } },
      "ParagraphStyle/!meta_hunt_head",
    )
    const root = document.createElement("div")
    root.innerHTML = decorated
    const slot = root.querySelector<HTMLElement>("span[data-idml-protected=\"slot\"]")
    expect(slot?.classList.contains(IDML_STYLE_BOLD_CLASS)).toBe(true)
    expect(slot?.style.fontWeight).toBe("700")
    expect(slot?.getAttribute("data-idml-character-style")).toBe(
      "CharacterStyle/$ID/[No character style]",
    )
  })

  it("lets a named character style win over a bold heading paragraph", () => {
    const html =
      `<p data-idml-version="2">`
      + `<span data-idml-slot="0" data-idml-character-style="CharacterStyle/_meta_style%3aitalic" data-idml-protected="slot">aside</span>`
      + `</p>`
    const decorated = prepareIdmlDisplayHtml(html, undefined, "ParagraphStyle/!meta_hunt_head")
    const root = document.createElement("div")
    root.innerHTML = decorated
    const slot = root.querySelector<HTMLElement>("span[data-idml-protected=\"slot\"]")
    expect(slot?.classList.contains(IDML_STYLE_ITALIC_CLASS)).toBe(true)
    expect(slot?.style.fontStyle).toBe("italic")
    expect(slot?.style.fontWeight).toBe("")
  })

  it("keeps slot identities so a later editor remount can still resolve clicks", () => {
    expect(looksLikeIdmlHtml(html)).toBe(true)
    expect(looksLikeIdmlHtml("<p><b>plain rich text</b></p>")).toBe(false)
    const slot = document.createElement("span")
    slot.setAttribute("data-idml-character-style", "CharacterStyle/Emphasis")
    decorateIdmlStyleElement(slot, "CharacterStyle/Emphasis", {
      "CharacterStyle/Emphasis": { bold: true, italic: true },
    })
    expect(slot.style.fontWeight).toBe("700")
    expect(slot.style.fontStyle).toBe("italic")
  })
})
