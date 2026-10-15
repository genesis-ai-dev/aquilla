import { describe, expect, it } from "vitest"
import { decodeEntities, encodeText, parseXml, splice, XmlError } from "../src/adapters/xml.ts"
import { buildZip, entryText, readZip, rewriteZip } from "../src/adapters/zip.ts"
import { containsTerm, replaceTerm } from "../src/core/context.ts"
import { stableStringify } from "../src/core/hash.ts"
import { mapText, parseTagged, plainOf, tagSkeleton, validateTagged } from "../src/core/tagged.ts"

describe("xml scanner", () => {
  it("keeps exact offsets and decodes entities", () => {
    const src = `<?xml version="1.0"?><a x="1&amp;2"><b>t&lt;x&#13;</b><c/><?ACE 7?></a>`
    const doc = parseXml(src)
    expect(doc.root.attrs.x).toBe("1&2")
    const b = doc.root.children[0]!
    expect(b.type).toBe("element")
    if (b.type !== "element") return
    const t = b.children[0]!
    expect(t.type === "text" && t.text).toBe("t<x\r")
    expect(src.slice(b.start, b.end)).toBe("<b>t&lt;x&#13;</b>")
    expect(doc.root.children[2]!.type).toBe("pi")
  })
  it("rejects DOCTYPE and malformed nesting", () => {
    expect(() => parseXml(`<!DOCTYPE x [<!ENTITY a "b">]><x/>`)).toThrow(XmlError)
    expect(() => parseXml(`<a><b></a></b>`)).toThrow(/unexpected/)
    expect(() => parseXml(`<a>&bogus;</a>`)).toThrow(/unknown entity/)
  })
  it("encodes text so it survives a parse", () => {
    const s = "a & b < c > d\r\u0001"
    expect(decodeEntities(encodeText(s))).toBe(s)
  })
  it("splices non-overlapping edits", () => {
    expect(splice("hello world", [{ start: 6, end: 11, text: "there" }, { start: 0, end: 5, text: "bye" }])).toBe("bye there")
  })
})

describe("zip", () => {
  const z = buildZip([
    ["mimetype", "application/vnd.adobe.indesign-idml-package"],
    ["a.xml", "<a>one</a>"],
    ["b.xml", "<b>two</b>"],
  ])
  it("round-trips byte-identically when nothing changes", () => {
    expect(rewriteZip(readZip(z), new Map())).toBe(z)
    expect(rewriteZip(readZip(z), new Map([["a.xml", new TextEncoder().encode("<a>one</a>")]]))).toBe(z)
  })
  it("replaces one member and copies the others verbatim", () => {
    const out = rewriteZip(readZip(z), new Map([["a.xml", new TextEncoder().encode("<a>uno</a>")]]))
    const r = readZip(out)
    expect(r.entries.map((e) => e.name)).toEqual(["mimetype", "a.xml", "b.xml"])
    expect(entryText(r.entries[1]!)).toBe("<a>uno</a>")
    const before = readZip(z).entries[2]!.localRecord
    expect(Buffer.from(r.entries[2]!.localRecord).equals(Buffer.from(before))).toBe(true)
    expect(r.entries[0]!.method).toBe(0)
  })
  it("rejects unsafe archives", () => {
    expect(() => readZip(new Uint8Array(10))).toThrow(/too small/)
    const evil = buildZip([["../evil", "x"]])
    expect(() => readZip(evil)).toThrow(/unsafe/)
  })
})

describe("tagged text", () => {
  it("parses runs and tokens", () => {
    const s = "<g1>Hello <x1/></g1> world<x2/>"
    expect(plainOf(s)).toBe("Hello  world")
    expect(tagSkeleton(s)).toBe("g1 x1 /g1 x2")
    expect(parseTagged(s).filter((p) => p.kind === "text").map((p) => (p.kind === "text" ? p.runs : []))).toEqual([[1], []])
  })
  it("validates translations structurally", () => {
    const src = "<g1>Hello</g1> <x1/> world"
    expect(validateTagged(src, "<x1/> <g1>Bonjour</g1> monde")).toEqual([])
    expect(validateTagged(src, "<g1>Bonjour</g1> monde").map((d) => d.code)).toEqual(["TOKEN_MISMATCH"])
    expect(validateTagged(src, "<g2>Bonjour</g2><x1/>").map((d) => d.code)).toContain("UNKNOWN_RUN")
    expect(validateTagged(src, "<g1>Bonjour<x1/>").map((d) => d.code)).toContain("UNBALANCED_RUN")
  })
  it("maps text without touching tags", () => {
    expect(mapText("<g1>church</g1><x1/>", (t) => t.toUpperCase())).toBe("<g1>CHURCH</g1><x1/>")
  })
})

describe("terms", () => {
  it("matches whole words in spaced scripts and substrings in CJK", () => {
    expect(containsTerm("The Church hall", "church")).toBe(true)
    expect(containsTerm("churches", "church")).toBe(false)
    expect(containsTerm("我们的教会很大", "教会")).toBe(true)
  })
  it("replaces preserving initial capitals", () => {
    expect(replaceTerm("Church and church", "church", "assemblée")).toBe("Assemblée and assemblée")
  })
  it("stableStringify is key-order independent", () => {
    expect(stableStringify({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(stableStringify({ a: [{ c: 2, d: 1 }], b: 1 }))
  })
})
