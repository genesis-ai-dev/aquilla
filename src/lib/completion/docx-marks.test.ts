// AQU-2539 — a Word line's inline marks through AI translation.
import { describe, it, expect } from "vitest"
import { markedPromptSource, normalizeMarkedReply, parseMarkedHtml } from "./docx-marks"
import { idmlCompletionPromptSource, normalizeProtectedCompletion } from "@/lib/idml/completion"

const wordLocator = {
  aquillaImport: { sourceLocator: { kind: "package-block", memberPath: "word/document.xml", blockPath: "w:p[3]", segment: 1 } },
}
const wordLine = (original: string, originalHtml?: string) => ({ id: "c1", original, originalHtml, metadata: wordLocator })

describe("parseMarkedHtml", () => {
  it("accepts only b/i/u/s (and strong/em/strike), properly nested, without attributes", () => {
    expect(parseMarkedHtml("<b>Terme :</b> la <em>définition</em>")).toEqual({
      text: "Terme : la définition",
      html: "<b>Terme :</b> la <i>définition</i>",
      marked: true,
    })
    expect(parseMarkedHtml("<b><i>x</i></b>")?.marked).toBe(true)
    expect(parseMarkedHtml("<b><i>x</b></i>")).toBeNull()
    expect(parseMarkedHtml("<b>x")).toBeNull()
    expect(parseMarkedHtml('<b class="x">x</b>')).toBeNull()
    expect(parseMarkedHtml("<span>x</span>")).toBeNull()
  })

  it("decodes entities into the text and keeps them escaped in the HTML; a <br> is a line break", () => {
    expect(parseMarkedHtml("a &amp; <b>b &lt; c</b><br>d")).toEqual({
      text: "a & b < c\nd",
      html: "a &amp; <b>b &lt; c</b><br>d",
      marked: true,
    })
  })
})

describe("markedPromptSource", () => {
  it("gives a marked Word line its HTML", () => {
    expect(markedPromptSource(wordLine("Term: the definition", "<b>Term:</b> the definition"), "Term: the definition"))
      .toBe("<b>Term:</b> the definition")
  })

  it("leaves every other cell's source alone", () => {
    const plain = "Term: the definition"
    // No marks.
    expect(markedPromptSource(wordLine(plain), plain)).toBe(plain)
    // Another format with HTML.
    expect(markedPromptSource({ original: plain, originalHtml: "<b>Term:</b> the definition", metadata: null }, plain)).toBe(plain)
    // Source edited after import: the HTML no longer matches the text.
    expect(markedPromptSource(wordLine("Term: a new definition", "<b>Term:</b> the definition"), "Term: a new definition"))
      .toBe("Term: a new definition")
    // HTML with anything but marks (never imported, but never trusted either).
    expect(markedPromptSource(wordLine(plain, '<span style="x">Term:</span> the definition'), plain)).toBe(plain)
  })
})

describe("normalizeMarkedReply", () => {
  const cell = wordLine("Term: the definition", "<b>Term:</b> the definition")

  it("saves a valid marked answer as plain text plus translatedHtml", () => {
    expect(normalizeMarkedReply(cell, " <b>Terme :</b> la définition\n")).toEqual({
      value: "Terme : la définition",
      valueHtml: "<b>Terme :</b> la définition",
    })
  })

  it("falls back to the plain translation, losing no words, when the answer is not valid", () => {
    const plain = { value: "Terme : la définition", valueHtml: "Terme : la définition" }
    expect(normalizeMarkedReply(cell, "<b>Terme :</i> la définition")).toEqual(plain)
    expect(normalizeMarkedReply(cell, '<span class="x">Terme :</span> la définition')).toEqual(plain)
  })

  it("saves an answer without marks as its plain text", () => {
    expect(normalizeMarkedReply(cell, "Terme : la définition")).toEqual({ value: "Terme : la définition", valueHtml: "Terme : la définition" })
  })

  it("gives the same result when the commit runs it again on what it returned", () => {
    for (const answer of ["Utilisez la balise &lt;b&gt; ici", "<b>A &amp;amp; B</b>", "<i>x</b> &lt;y&gt;", "a\n<b>b</b>"]) {
      const once = normalizeMarkedReply(cell, answer)
      const twice = normalizeMarkedReply(cell, once.valueHtml ?? once.value)
      expect(twice).toEqual(once)
    }
    expect(normalizeMarkedReply(cell, "Utilisez la balise &lt;b&gt; ici").value).toBe("Utilisez la balise <b> ici")
  })

  it("passes every other cell's answer through untouched, tags and all", () => {
    expect(normalizeMarkedReply(wordLine("Plain line"), "<b>Ligne</b>")).toEqual({ value: "<b>Ligne</b>" })
    expect(normalizeMarkedReply({ original: "x", originalHtml: "<b>x</b>", metadata: null }, "<b>y</b>")).toEqual({ value: "<b>y</b>" })
  })
})

describe("the two hooks in the shared completion path", () => {
  it("idmlCompletionPromptSource: marked Word line → HTML; anything else → unchanged", () => {
    const marked = wordLine("Term: def", "<b>Term:</b> def")
    expect(idmlCompletionPromptSource(marked, "Term: def")).toBe("<b>Term:</b> def")
    expect(idmlCompletionPromptSource({ id: "x", metadata: null }, "plain source")).toBe("plain source")
  })

  it("normalizeProtectedCompletion: marked Word line → validated; anything else → { value } as before", () => {
    const marked = wordLine("Term: def", "<b>Term:</b> def")
    expect(normalizeProtectedCompletion(marked, "<b>Terme :</b> déf")).toEqual({ value: "Terme : déf", valueHtml: "<b>Terme :</b> déf" })
    expect(normalizeProtectedCompletion({ id: "x", metadata: null }, "<b>whatever</b>")).toEqual({ value: "<b>whatever</b>" })
  })
})
