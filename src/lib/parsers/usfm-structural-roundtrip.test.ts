import { describe, it, expect } from "vitest"
import { parseUsfmLossless, serializeUsfmLossless, serializeUsfmPerRun } from "./usfm-lossless"
import { usfmSpanToHtml, htmlSpanToUsfm } from "./usfm-html"

// End-to-end structural-fidelity round-trip (the codex-editor-parity path):
//   import  → verse span becomes structured HTML (what the editor edits)
//   edit    → translator rewrites the PROSE; the structure (footnotes, breaks,
//             inline markers) rides along in the HTML
//   export  → HTML → USFM, spliced back into the side-car
// This is the regression guard for the loss demonstrated before the change:
// editing a verse with a footnote or poetry used to destroy that structure.

const RAW = `\\id GEN Genesis
\\c 1
\\s The Creation
\\p
\\v 1 In the beginning God created the heavens and the earth.\\f + \\fr 1:1 \\ft Some manuscripts read differently.\\f*
\\v 2 Now the earth was formless and empty,
\\q1 darkness was over the surface of the deep,
\\q2 and the Spirit of God was hovering over the waters.
\\v 3 And God said, "Let there be light."\\x + \\xo 1:3 \\xt John 1:5\\x*
`

/** Simulate the editor: the translator replaces the prose words but the
 *  structural elements (<sup> notes, <br> breaks, inline spans) are preserved
 *  by the rich-text editor — which is the whole premise of the HTML approach. */
function translateProse(html: string, replacements: Record<string, string>): string {
  let out = html
  for (const [from, to] of Object.entries(replacements)) out = out.replace(from, to)
  return out
}

describe("structural round-trip (import → edit → export)", () => {
  const doc = parseUsfmLossless(RAW)
  const byRef = new Map(doc.verses.map((v) => [v.ref, v]))

  it("preserves a footnote when its verse is translated", () => {
    const v = byRef.get("GEN 1:1")!
    const html = usfmSpanToHtml(v.text.trim())
    // Footnote survives as a <sup> token carrying its body.
    expect(html).toContain('<sup data-usfm="f"')

    const editedHtml = translateProse(html, {
      "In the beginning God created the heavens and the earth.":
        "Au commencement, Dieu créa les cieux et la terre.",
    })
    const override = htmlSpanToUsfm(editedHtml)
    const out = serializeUsfmLossless(doc, { "GEN 1:1": override })

    expect(out).toContain("Au commencement, Dieu créa les cieux et la terre.")
    // The footnote is preserved verbatim — the old plain-text path dropped it.
    expect(out).toContain("\\f + \\fr 1:1 \\ft Some manuscripts read differently.\\f*")
  })

  it("preserves poetry line structure when its verse is translated", () => {
    const v = byRef.get("GEN 1:2")!
    const html = usfmSpanToHtml(v.text.trim())
    expect(html).toContain('<br data-usfm="q1">')
    expect(html).toContain('<br data-usfm="q2">')

    const editedHtml = translateProse(html, {
      "Now the earth was formless and empty,": "Or la terre était informe et vide,",
      "darkness was over the surface of the deep,": "les ténèbres couvraient l'abîme,",
      "and the Spirit of God was hovering over the waters.":
        "et l'Esprit de Dieu planait sur les eaux.",
    })
    const override = htmlSpanToUsfm(editedHtml)
    const out = serializeUsfmLossless(doc, { "GEN 1:2": override })

    expect(out).toContain("Or la terre était informe et vide,")
    // Both poetry markers survive — the old path collapsed them to one line.
    expect(out).toContain("\\q1 les ténèbres couvraient l'abîme,")
    expect(out).toContain("\\q2 et l'Esprit de Dieu planait sur les eaux.")
  })

  it("preserves a cross-reference when its verse is translated", () => {
    const v = byRef.get("GEN 1:3")!
    const html = usfmSpanToHtml(v.text.trim())
    // The verse's prose contains a double-quote, which the mapper escapes to
    // &quot; in HTML — target a quote-free substring so the simulated edit hits.
    const editedHtml = translateProse(html, {
      "Let there be light.": "Que la lumière soit.",
    })
    const out = serializeUsfmLossless(doc, { "GEN 1:3": htmlSpanToUsfm(editedHtml) })
    expect(out).toContain("Que la lumière soit.")
    expect(out).toContain("\\x + \\xo 1:3 \\xt John 1:5\\x*")
  })

  it("leaves untranslated verses byte-identical to the source", () => {
    // Only GEN 1:1 edited; everything else must pass through unchanged.
    const v = byRef.get("GEN 1:1")!
    const override = htmlSpanToUsfm(usfmSpanToHtml(v.text.trim()))
    const out = serializeUsfmLossless(doc, { "GEN 1:1": override })
    // \v 2/\v 3 and their structure are untouched (came from the side-car).
    expect(out).toContain("\\v 2 Now the earth was formless and empty,")
    expect(out).toContain("\\q1 darkness was over the surface of the deep,")
    expect(out).toContain("\\v 3 And God said, \"Let there be light.\"\\x + \\xo 1:3 \\xt John 1:5\\x*")
  })

  it("is byte-identical with no edits at all", () => {
    expect(serializeUsfmLossless(doc)).toBe(RAW)
  })
})

describe("per-run export (serializeUsfmPerRun)", () => {
  const doc = parseUsfmLossless(RAW)

  it("is byte-identical with no targets", () => {
    expect(serializeUsfmPerRun(doc)).toBe(RAW)
  })

  it("splices translated runs in place, keeping the footnote byte-for-byte", () => {
    const v = doc.verses.find((x) => x.ref === "GEN 1:1")!
    const html = usfmSpanToHtml(v.text.trim()) // structure preserved
    const edited = html.replace(
      "In the beginning God created the heavens and the earth.",
      "Au commencement, Dieu créa les cieux et la terre.",
    )
    const out = serializeUsfmPerRun(doc, {
      "GEN 1:1": { value: "x", valueHtml: edited },
    })
    expect(out).toContain(
      "\\v 1 Au commencement, Dieu créa les cieux et la terre.\\f + \\fr 1:1 \\ft Some manuscripts read differently.\\f*",
    )
  })

  it("DROPS a footnote the translation omitted (notes are target-driven, like inline styles)", () => {
    const out = serializeUsfmPerRun(doc, {
      // Plain prose, no footnote carried — the note is the translator's call.
      "GEN 1:1": { value: "Au commencement.", valueHtml: "<p>Au commencement.</p>" },
    })
    expect(out).toContain("\\v 1 Au commencement.")
    // Source-language footnote must NOT leak into the target export.
    expect(out).not.toContain("Some manuscripts read differently")
    // Block scaffolding before the verse is still byte-preserved.
    expect(out).toContain("\\s The Creation\n\\p\n\\v 1 ")
  })

  it("keeps a footnote the translation carried (via <sup>)", () => {
    const v = doc.verses.find((x) => x.ref === "GEN 1:1")!
    const html = usfmSpanToHtml(v.text.trim()) // translator kept the <sup>
    const out = serializeUsfmPerRun(doc, { "GEN 1:1": { value: "x", valueHtml: html } })
    expect(out).toContain("\\f + \\fr 1:1 \\ft Some manuscripts read differently.\\f*")
  })

  it("keeps poetry markers byte-for-byte when each line is translated", () => {
    const v = doc.verses.find((x) => x.ref === "GEN 1:2")!
    const html = usfmSpanToHtml(v.text.trim())
    const edited = html
      .replace("Now the earth was formless and empty,", "Or la terre était informe et vide,")
      .replace("darkness was over the surface of the deep,", "les ténèbres couvraient l'abîme,")
      .replace("and the Spirit of God was hovering over the waters.", "et l'Esprit planait sur les eaux.")
    const out = serializeUsfmPerRun(doc, { "GEN 1:2": { value: "x", valueHtml: edited } })
    expect(out).toContain("\\v 2 Or la terre était informe et vide,\n\\q1 les ténèbres couvraient l'abîme,\n\\q2 et l'Esprit planait sur les eaux.")
  })

  it("falls back to whole-span reconstruction when run counts don't align", () => {
    // Translator collapsed the 3-run poetry verse into one line — can't map runs.
    const out = serializeUsfmPerRun(doc, {
      "GEN 1:2": { value: "une seule ligne", valueHtml: "<p>une seule ligne</p>" },
    })
    expect(out).toContain("\\v 2 une seule ligne")
    // The poetry markers are gone on this verse (fallback reconstruct), as expected.
    expect(out).not.toContain("\\v 2 une seule ligne\n\\q1")
  })
})
