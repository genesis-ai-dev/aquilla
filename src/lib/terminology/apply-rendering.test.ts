import { describe, it, expect } from "vitest"
import { applyRenderingToTarget } from "./apply-rendering"

// AQU-1102 regression guard. The defect: Apply appended the rendering to the
// target cell whenever no selection had been captured, so a click on a
// read-only source-side term popover rewrote the translation. "No selection"
// must produce no commit payload at all.

describe("applyRenderingToTarget", () => {
  describe("no selection → no write (AQU-1102)", () => {
    it("returns null when nothing was selected", () => {
      expect(
        applyRenderingToTarget({
          selectedText: "",
          plain: "En el principio",
          html: "<p>En el principio</p>",
          rendering: "Dios",
        }),
      ).toBeNull()
    })

    it("returns null when the selection is only whitespace", () => {
      expect(
        applyRenderingToTarget({
          selectedText: "   ",
          plain: "En el principio",
          rendering: "Dios",
        }),
      ).toBeNull()
    })

    it("never appends to an empty target", () => {
      expect(
        applyRenderingToTarget({ selectedText: "", plain: "", rendering: "Dios" }),
      ).toBeNull()
    })

    it("returns null when the selection is no longer present in the target", () => {
      expect(
        applyRenderingToTarget({
          selectedText: "Senor",
          plain: "En el principio",
          rendering: "Dios",
        }),
      ).toBeNull()
    })
  })

  describe("selection → replace only the selection", () => {
    it("replaces the selected plain text and leaves the rest alone", () => {
      expect(
        applyRenderingToTarget({
          selectedText: "Senor",
          plain: "El Senor es mi pastor",
          rendering: "Dios",
        }),
      ).toEqual({ value: "El Dios es mi pastor", valueHtml: "El Dios es mi pastor" })
    })

    it("replaces only the first occurrence", () => {
      expect(
        applyRenderingToTarget({
          selectedText: "Senor",
          plain: "Senor, Senor",
          rendering: "Dios",
        })?.value,
      ).toBe("Dios, Senor")
    })
  })

  describe("rich formatting survives (AQU-1102)", () => {
    it("keeps surrounding markup instead of flattening to plain text", () => {
      const result = applyRenderingToTarget({
        selectedText: "Senor",
        plain: "El Senor es mi pastor",
        html: "<p>El <em>Senor</em> es mi <strong>pastor</strong></p>",
        rendering: "Dios",
      })
      expect(result).toEqual({
        value: "El Dios es mi pastor",
        valueHtml: "<p>El <em>Dios</em> es mi <strong>pastor</strong></p>",
      })
    })

    it("handles a selection that spans a markup boundary", () => {
      const result = applyRenderingToTarget({
        selectedText: "Senor es",
        plain: "El Senor es mi pastor",
        html: "<p>El <em>Senor</em> es mi pastor</p>",
        rendering: "Dios",
      })
      expect(result?.value).toBe("El Dios mi pastor")
      expect(result?.valueHtml).toBe("<p>El <em>Dios</em> mi pastor</p>")
    })

    it("declines rather than flattening when the selection doesn't line up with the HTML", () => {
      expect(
        applyRenderingToTarget({
          selectedText: "Senor",
          plain: "El Senor es mi pastor",
          // The markup's text carries a non-breaking space the plain text
          // doesn't, so the selection has no home in the HTML. Committing the
          // plain text here would wipe the translator's formatting.
          html: "<p>El <em>Se&nbsp;nor</em> es mi pastor</p>",
          rendering: "Dios",
        }),
      ).toBeNull()
    })

    it("splits the replacement across nodes without leaving matched text behind", () => {
      const result = applyRenderingToTarget({
        selectedText: "Senor es mi",
        plain: "El Senor es mi pastor",
        html: "<p>El <em>Senor</em> <strong>es mi</strong> pastor</p>",
        rendering: "Dios",
      })
      expect(result?.value).toBe("El Dios pastor")
      expect(result?.valueHtml).toBe("<p>El <em>Dios</em><strong></strong> pastor</p>")
    })
  })
})
