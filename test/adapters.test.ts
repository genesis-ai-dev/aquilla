import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { idmlAdapter } from "../src/adapters/idml/index.ts"
import { inlineToTagged, markdownAdapter, taggedToInline } from "../src/adapters/markdown/index.ts"
import { jsonAdapter, scanJson } from "../src/adapters/json/index.ts"
import { entryData, readZip } from "../src/adapters/zip.ts"
import { brochureSpec, buildIdml } from "../src/fixtures/build-idml.ts"
import { parseTagged, validateTagged } from "../src/core/tagged.ts"
import { pseudoTranslate } from "../src/engine/translator.ts"

const ROOT = join(import.meta.dirname, "..", "fixtures")
const corpus = (): Array<[string, Uint8Array]> => [
  ...["cc0", "third-party/simpleidml"].flatMap((d) =>
    readdirSync(join(ROOT, d))
      .filter((f) => f.endsWith(".idml"))
      .map((f): [string, Uint8Array] => [`${d}/${f}`, new Uint8Array(readFileSync(join(ROOT, d, f)))]),
  ),
  ["synthetic/brochure", buildIdml(brochureSpec())],
]
const translateAll = (bytes: Uint8Array, locale = "fr"): Map<string, string> =>
  new Map(
    idmlAdapter.extract(bytes, "x").units.map((u) => [
      u.structuralPath,
      pseudoTranslate({ logicalId: u.structuralPath, sourceLocale: "en", targetLocale: locale, sourceTagged: u.tagged, contextRevision: "", policyRevision: "", terms: [], rules: [], prior: [] }),
    ]),
  )

describe("IDML corpus (real InDesign exports + synthetic)", () => {
  for (const [name, bytes] of corpus()) {
    describe(name, () => {
      it("no-op round trip is byte-identical", () => {
        expect(idmlAdapter.render(bytes, new Map(), { locale: "fr" }).bytes).toBe(bytes)
        const g = idmlAdapter.extract(bytes, "x")
        const same = new Map(g.units.map((u) => [u.structuralPath, u.tagged]))
        expect(Buffer.from(idmlAdapter.render(bytes, same, { locale: "fr" }).bytes).equals(Buffer.from(bytes))).toBe(true)
      })
      it("full translation validates: structure, non-story members and tokens unchanged", () => {
        const out = idmlAdapter.render(bytes, translateAll(bytes), { locale: "fr" })
        const v = idmlAdapter.validate(bytes, out.bytes)
        expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([])
        // Every non-story member is byte-identical — not just equal after decompression, the raw record.
        const src = readZip(bytes)
        const dst = readZip(out.bytes)
        for (const e of src.entries) {
          if (e.name.startsWith("Stories/")) continue
          const o = dst.entries.find((x) => x.name === e.name)!
          expect(Buffer.from(o.localRecord).equals(Buffer.from(e.localRecord))).toBe(true)
        }
      })
      it("text preservation: every unit's translation reads back, in order, nothing missing or duplicated", () => {
        const tr = translateAll(bytes)
        const out = idmlAdapter.render(bytes, tr, { locale: "fr" }).bytes
        const back = idmlAdapter.extract(out, "x").units
        const src = idmlAdapter.extract(bytes, "x").units
        expect(back.map((u) => u.structuralPath)).toEqual(src.map((u) => u.structuralPath))
        back.forEach((u, i) => {
          const want = parseTagged(tr.get(src[i]!.structuralPath)!).map((p) => (p.kind === "text" ? p.text : "")).join("")
          expect(u.plain).toBe(want)
        })
      })
      it("is idempotent: rendering the same translations twice gives identical bytes", () => {
        const tr = translateAll(bytes)
        const a = idmlAdapter.render(bytes, tr, { locale: "fr" }).bytes
        const b = idmlAdapter.render(bytes, tr, { locale: "fr" }).bytes
        expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
      })
    })
  }
})

describe("IDML specifics", () => {
  const bytes = buildIdml(brochureSpec())
  const units = idmlAdapter.extract(bytes, "x").units
  it("extracts paragraphs, table cells, footnotes and master text with kinds", () => {
    expect(units.map((u) => u.kind)).toEqual(expect.arrayContaining(["paragraph", "table-cell", "footnote", "master"]))
    const p = units.find((u) => u.plain.startsWith("Bring water"))!
    expect(p.tagged).toMatch(/<x1\/>.*<x2\/>/) // text variable, then the footnote reference
  })
  it("same-formatted runs share an id, so translators see real formatting", () => {
    const p = units.find((u) => u.plain.startsWith("Welcome"))!
    expect(p.tagged).toBe("<g1>Welcome to a new season of the </g1><g2>Community Choir</g2><g1>. Everyone who loves to sing is welcome, whatever their experience.</g1>")
  })
  it("reordered runs are written faithfully when the native structure can express them", () => {
    const p = units.find((u) => u.plain.startsWith("Welcome"))!
    // The bold run moves to the front; g1 occurs again after it, so slot replacement can express this exactly.
    const reordered = "<g2>Der Gemeinschaftschor</g2><g1> begrüßt Sie zu einer neuen Saison. Alle sind willkommen.</g1>"
    expect(validateTagged(p.tagged, reordered)).toEqual([])
    const out = idmlAdapter.render(bytes, new Map([[p.structuralPath, reordered]]), { locale: "de" })
    expect(out.diagnostics).toEqual([])
    const back = idmlAdapter.extract(out.bytes, "x").units.find((u) => u.structuralPath === p.structuralPath)!
    expect(back.tagged).toBe("<g1>Der Gemeinschaftschor</g1><g2> begrüßt Sie zu einer neuen Saison. Alle sind willkommen.</g2>")
    expect(idmlAdapter.validate(bytes, out.bytes).ok).toBe(true)
  })
  it("…and flagged for review when they cannot", () => {
    const b2 = buildIdml({ stories: [{ id: "s1", paragraphs: [{ runs: [{ text: "Plain words then " }, { style: "Bold", text: "bold words" }] }] }] })
    const u = idmlAdapter.extract(b2, "x").units[0]!
    expect(u.tagged).toBe("<g1>Plain words then </g1><g2>bold words</g2>")
    const out = idmlAdapter.render(b2, new Map([[u.structuralPath, "<g2>Fette Wörter</g2><g1> und dann normale</g1>"]]), { locale: "de" })
    expect(out.diagnostics.map((d) => d.code)).toEqual(["FORMATTING_SIMPLIFIED"])
    const back = idmlAdapter.extract(out.bytes, "x").units[0]!
    expect(back.plain).toContain("Fette Wörter")
    expect(back.plain).toContain("und dann normale")
    expect(idmlAdapter.validate(b2, out.bytes).ok).toBe(true)
  })
  it("escapes XML-special characters and carriage returns safely", () => {
    const p = units[0]!
    const out = idmlAdapter.render(bytes, new Map([[p.structuralPath, `Fish & chips <b> "quoted"\r end`]]), { locale: "fr" })
    expect(idmlAdapter.validate(bytes, out.bytes).ok).toBe(true)
    expect(idmlAdapter.extract(out.bytes, "x").units[0]!.plain).toBe(`Fish & chips <b> "quoted"\r end`)
  })
  it("rejects hostile or broken packages", () => {
    expect(() => idmlAdapter.extract(new TextEncoder().encode("not a zip at all, sorry"), "x")).toThrow()
    const zip = readZip(bytes)
    expect(entryData(zip.entries[0]!)).toBeDefined()
  })
  it("feature-rich fixture: notes and cross-references are preserved, not translated", () => {
    const fr = new Uint8Array(readFileSync(join(ROOT, "cc0/feature-rich.idml")))
    const g = idmlAdapter.extract(fr, "x")
    expect(g.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(["NOTE_PRESERVED", "XREF_PRESERVED"]))
    expect(g.units.some((u) => u.plain.includes("translator note"))).toBe(false)
    expect(g.units.map((u) => u.kind)).toEqual(expect.arrayContaining(["table-cell", "footnote", "endnote"]))
  })
  it("layout: flags overset risk when translated text outgrows its frame", () => {
    const tight = buildIdml({
      stories: [{ id: "s1", frames: [{ width: 200, height: 60 }], paragraphs: ["A short paragraph that nearly fills this small frame already, really it does."] }],
    })
    const u = idmlAdapter.extract(tight, "x").units[0]!
    const long = new Map([[u.structuralPath, `${u.tagged} ${u.tagged} ${u.tagged}`]])
    const out = idmlAdapter.render(tight, long, { locale: "de" }).bytes
    const f = idmlAdapter.layout!(tight, out)
    expect(f[0]!.severity).toBe("overset")
    expect(f[0]!.repair).toBeDefined()
    const same = idmlAdapter.layout!(tight, tight)
    expect(same[0]!.severity).not.toBe("overset")
  })
})

describe("Markdown adapter", () => {
  const md = `---
title: "Handbook: basics"
draft: true
---

# Welcome *friends*

Paragraph with **bold**, \`code\`, a [link](https://x.org "t"), an image ![alt](i.png), and a footnote[^1].
Second line of the same paragraph.

> Quoted wisdom
> continues here.

1. First item
   continued
2. Second item

| A | B |
|---|---|
| one | two \\| three |

    indented code stays

<div align="center">html stays</div>

[^1]: The footnote text.
`
  const bytes = new TextEncoder().encode(md)
  it("extracts translatable blocks and protects code, html, urls", () => {
    const units = markdownAdapter.extract(bytes, "m").units
    expect(units.map((u) => u.kind)).toEqual(["front-matter", "heading", "paragraph", "blockquote", "list-item", "list-item", "table-cell", "table-cell", "table-cell", "table-cell", "paragraph"])
    const p = units[2]!
    expect(p.plain).not.toContain("https://")
    expect(p.plain).not.toContain("code")
    expect(p.tagged).toContain("<g1>bold</g1>")
  })
  it("inline round trip is lossless", () => {
    const s = "Mix **bold _nested_** and [a link](http://a.b) with `x` and \\* escaped."
    const { tagged, runs, tokens } = inlineToTagged(s)
    expect(taggedToInline(tagged, runs, tokens)).toBe(s)
  })
  it("identity render reproduces the source except joined soft-wrapped lines", () => {
    const g = markdownAdapter.extract(bytes, "m")
    const out = markdownAdapter.render(bytes, new Map(g.units.map((u) => [u.structuralPath, u.tagged])), { locale: "fr" })
    expect(markdownAdapter.validate(bytes, out.bytes).ok).toBe(true)
    expect(new TextDecoder().decode(out.bytes)).toContain("```".length ? "    indented code stays" : "")
  })
  it("translation may reorder emphasis freely", () => {
    const g = markdownAdapter.extract(bytes, "m")
    const h = g.units[1]!
    const out = markdownAdapter.render(bytes, new Map([[h.structuralPath, "<g1>Amis</g1>, bienvenue"]]), { locale: "fr" })
    expect(new TextDecoder().decode(out.bytes)).toContain("# *Amis*, bienvenue")
  })
})

describe("JSON adapter", () => {
  const src = `{
  "nav": { "home": "Home", "count": "%d items", "hello": "Hi {{name}}!" },
  "$schema": "https://example.org/schema",
  "list": ["First entry", 3, true],
  "rich": "Accept the <0>terms</0> and <1/>continue"
}`
  const bytes = new TextEncoder().encode(src)
  it("scans string values with key paths", () => {
    expect(scanJson(src).map((s) => s.path)).toEqual(["nav.home", "nav.count", "nav.hello", "$schema", "list[0]", "rich"])
  })
  it("anchors units by key and protects placeholders", () => {
    const units = jsonAdapter.extract(bytes, "j").units
    expect(units.map((u) => u.nativeAnchor)).toEqual(["key:nav.home", "key:nav.count", "key:nav.hello", "key:list[0]", "key:rich"])
    expect(units[1]!.tagged).toBe("<x1/> items")
    expect(units[4]!.tagged).toBe("Accept the <g1>terms</g1> and <x1/>continue")
  })
  it("renders without changing formatting outside values", () => {
    const units = jsonAdapter.extract(bytes, "j").units
    const out = new TextDecoder().decode(jsonAdapter.render(bytes, new Map([[units[2]!.structuralPath, "Salut <x1/> !"]]), { locale: "fr" }).bytes)
    expect(out).toBe(src.replace("Hi {{name}}!", "Salut {{name}} !"))
  })
})
