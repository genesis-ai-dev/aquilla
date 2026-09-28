/**
 * LIFT (FLEx) term-base import — AQU-684 regression guard.
 *
 * Covers the parser itself AND the producer→consumer seam it was added for:
 * a picked file goes through `detectTermbaseFormat` before any reader sees it,
 * so a LIFT export must not fall through to the CSV reader again.
 */

import { describe, it, expect } from "vitest"
import { importConceptsLift, looksLikeLift } from "./lift"
import { detectTermbaseFormat, importTermbaseFile } from "./import-format"

/** A FLEx 9 LIFT 0.13 export, trimmed to the elements we read. */
const FLEX_EXPORT = `<?xml version="1.0" encoding="UTF-8"?>
<lift producer="SIL.FLEx 9.1.19" version="0.13">
  <entry dateCreated="2026-01-02T10:00:00Z" guid="g1" id="trang_g1">
    <lexical-unit><form lang="pmy"><text>trang</text></form></lexical-unit>
    <citation><form lang="pmy"><text>trang</text></form></citation>
    <variant><form lang="pmy"><text>terang</text></form></variant>
    <sense id="s1">
      <grammatical-info value="Noun"/>
      <gloss lang="en"><text>light</text></gloss>
      <gloss lang="id"><text>cahaya</text></gloss>
      <definition><form lang="en"><text>the natural agent that makes things visible</text></form></definition>
    </sense>
  </entry>
  <entry guid="g2" id="sinar_g2">
    <lexical-unit><form lang="pmy"><text>sinar</text></form></lexical-unit>
    <sense id="s2">
      <gloss lang="en"><text>Light</text></gloss>
    </sense>
  </entry>
  <entry guid="g3" id="glap_g3">
    <lexical-unit><form lang="pmy"><text>glap</text></form></lexical-unit>
    <sense id="s3">
      <gloss lang="en"><text>darkness</text></gloss>
    </sense>
  </entry>
</lift>`

describe("importConceptsLift — AQU-684", () => {
  it("maps the analysis-language gloss to the source term and the vernacular headword to a preferred rendering", () => {
    const [light] = importConceptsLift(FLEX_EXPORT)
    expect(light.sourceTerm).toBe("light")
    expect(light.renderings).toContainEqual({ rendering: "trang", status: "preferred" })
    expect(light.status).toBe("active")
  })

  it("reads variant forms as admitted renderings", () => {
    const [light] = importConceptsLift(FLEX_EXPORT)
    expect(light.renderings).toContainEqual({ rendering: "terang", status: "admitted" })
  })

  it("merges senses glossed the same across entries into one concept", () => {
    const concepts = importConceptsLift(FLEX_EXPORT)
    // "light" and "Light" are one concept carrying both headwords.
    expect(concepts.map((c) => c.sourceTerm)).toEqual(["light", "darkness"])
    expect(concepts[0].renderings.map((r) => r.rendering)).toEqual(["trang", "terang", "sinar"])
  })

  it("picks the dominant gloss language rather than whichever gloss comes first", () => {
    // Indonesian outnumbers English, so `id` is the analysis language here.
    const idDominant = `<lift version="0.13">
      <entry><lexical-unit><form lang="pmy"><text>trang</text></form></lexical-unit>
        <sense><gloss lang="en"><text>light</text></gloss><gloss lang="id"><text>cahaya</text></gloss></sense></entry>
      <entry><lexical-unit><form lang="pmy"><text>glap</text></form></lexical-unit>
        <sense><gloss lang="id"><text>gelap</text></gloss></sense></entry>
      <entry><lexical-unit><form lang="pmy"><text>aer</text></form></lexical-unit>
        <sense><gloss lang="id"><text>air</text></gloss></sense></entry>
    </lift>`
    expect(importConceptsLift(idDominant).map((c) => c.sourceTerm)).toEqual([
      "cahaya",
      "gelap",
      "air",
    ])
  })

  it("honours an explicitly requested analysis language", () => {
    const concepts = importConceptsLift(FLEX_EXPORT, { analysisLang: "id" })
    expect(concepts[0].sourceTerm).toBe("cahaya")
  })

  it("keeps the sense definition as concept notes", () => {
    const [light] = importConceptsLift(FLEX_EXPORT)
    expect(light.notes).toBe("the natural agent that makes things visible")
  })

  it("falls back to the definition when a sense carries no gloss, without repeating it as a note", () => {
    const noGloss = `<lift version="0.13"><entry>
      <lexical-unit><form lang="pmy"><text>trang</text></form></lexical-unit>
      <sense><definition><form lang="en"><text>daylight</text></form></definition></sense>
    </entry></lift>`
    const [concept] = importConceptsLift(noGloss)
    expect(concept.sourceTerm).toBe("daylight")
    expect(concept.notes).toBeUndefined()
  })

  it("falls back to a sense's first gloss when the analysis language is missing from it", () => {
    const patchy = `<lift version="0.13">
      <entry><lexical-unit><form lang="pmy"><text>trang</text></form></lexical-unit>
        <sense><gloss lang="en"><text>light</text></gloss></sense></entry>
      <entry><lexical-unit><form lang="pmy"><text>glap</text></form></lexical-unit>
        <sense><gloss lang="id"><text>gelap</text></gloss></sense></entry>
    </lift>`
    expect(importConceptsLift(patchy).map((c) => c.sourceTerm)).toEqual(["light", "gelap"])
  })

  it("prefers the citation form over the lexical unit for the rendering", () => {
    const cited = `<lift version="0.13"><entry>
      <lexical-unit><form lang="pmy"><text>trang-</text></form></lexical-unit>
      <citation><form lang="pmy"><text>trang</text></form></citation>
      <sense><gloss lang="en"><text>light</text></gloss></sense>
    </entry></lift>`
    expect(importConceptsLift(cited)[0].renderings).toEqual([
      { rendering: "trang", status: "preferred" },
    ])
  })

  it("skips entries FLEx has tombstoned with dateDeleted", () => {
    const withDeleted = `<lift version="0.13">
      <entry dateDeleted="2026-02-02T10:00:00Z">
        <lexical-unit><form lang="pmy"><text>gone</text></form></lexical-unit>
        <sense><gloss lang="en"><text>removed</text></gloss></sense></entry>
      <entry><lexical-unit><form lang="pmy"><text>trang</text></form></lexical-unit>
        <sense><gloss lang="en"><text>light</text></gloss></sense></entry>
    </lift>`
    expect(importConceptsLift(withDeleted).map((c) => c.sourceTerm)).toEqual(["light"])
  })

  it("decodes XML entities in headwords and glosses", () => {
    const escaped = `<lift version="0.13"><entry>
      <lexical-unit><form lang="pmy"><text>tra&amp;ng</text></form></lexical-unit>
      <sense><gloss lang="en"><text>light &amp; heat</text></gloss></sense>
    </entry></lift>`
    const [concept] = importConceptsLift(escaped)
    expect(concept.sourceTerm).toBe("light & heat")
    expect(concept.renderings[0].rendering).toBe("tra&ng")
  })

  it("returns nothing for a LIFT file with no entries", () => {
    expect(importConceptsLift(`<lift version="0.13"></lift>`)).toEqual([])
  })

  it("throws rather than half-importing malformed XML", () => {
    expect(() => importConceptsLift(`<lift><entry><sense></entry></lift>`)).toThrow()
  })
})

describe("detectTermbaseFormat — AQU-684", () => {
  it("routes a FLEx export to the LIFT reader", () => {
    expect(detectTermbaseFormat("Lexicon.lift", FLEX_EXPORT)).toBe("lift")
  })

  it("routes it by content even when the extension was lost in transit", () => {
    expect(detectTermbaseFormat("Lexicon.xml", FLEX_EXPORT)).toBe("lift")
    expect(detectTermbaseFormat("lexicon", FLEX_EXPORT)).toBe("lift")
  })

  it("still routes TBX and delimited files to their own readers", () => {
    expect(detectTermbaseFormat("g.tbx", `<martif type="TBX-Basic"><text/></martif>`)).toBe("tbx")
    expect(detectTermbaseFormat("g.csv", "sourceTerm,rendering\nlight,trang")).toBe("csv")
    expect(detectTermbaseFormat("g.tsv", "sourceTerm\trendering\nlight\ttrang")).toBe("csv")
  })

  it("sends unrecognized XML to the lenient TBX reader, not the CSV one", () => {
    expect(detectTermbaseFormat("mystery.xml", `<?xml version="1.0"?><glossary/>`)).toBe("tbx")
  })

  it("keeps reading an empty .lift as LIFT so the user gets a parse error", () => {
    expect(detectTermbaseFormat("Lexicon.lift", "")).toBe("lift")
  })
})

describe("importTermbaseFile — AQU-684", () => {
  it("imports a FLEx export end to end, the way the glossary import button does", () => {
    const concepts = importTermbaseFile("Lexicon.lift", FLEX_EXPORT)
    expect(concepts.map((c) => c.sourceTerm)).toEqual(["light", "darkness"])
    expect(concepts[0].renderings[0]).toEqual({ rendering: "trang", status: "preferred" })
  })

  it("leaves the existing CSV and TBX paths working", () => {
    expect(importTermbaseFile("g.csv", "sourceTerm,rendering,status\nlight,trang,preferred")[0]).toMatchObject({
      sourceTerm: "light",
      renderings: [{ rendering: "trang", status: "preferred" }],
    })
    const tbx = `<martif type="TBX-Basic"><text><body>
      <termEntry id="t1">
        <langSet xml:lang="source"><tig><term>light</term></tig></langSet>
        <langSet xml:lang="target"><tig><term>trang</term>
          <termNote type="administrativeStatus">preferredTerm-admn-sts</termNote></tig></langSet>
      </termEntry></body></text></martif>`
    expect(importTermbaseFile("g.tbx", tbx)[0]).toMatchObject({
      sourceTerm: "light",
      renderings: [{ rendering: "trang", status: "preferred" }],
    })
  })
})

describe("looksLikeLift", () => {
  it("recognizes a LIFT root and rejects other XML", () => {
    expect(looksLikeLift(FLEX_EXPORT)).toBe(true)
    expect(looksLikeLift(`<martif type="TBX-Basic"/>`)).toBe(false)
    expect(looksLikeLift("sourceTerm,rendering")).toBe(false)
  })
})
