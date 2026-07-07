// Acceptance tests for the P1/P2 format rows: HTML, JSON, properties, SBV, PPTX.
// (PO has its own file once the parser lands.)
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import type { CellData } from "@/hooks/useCells"
import type { TranslatableString } from "@/lib/parsers/types"
import { extractHtmlStrings, exportHtml } from "@/lib/parsers/html"
import { extractJsonStrings, exportJson } from "@/lib/parsers/json-i18n"
import { extractPropertiesStrings, exportProperties } from "@/lib/parsers/properties"
import { extractSbvStrings } from "@/lib/parsers/sbv"
import { extractPptxStrings } from "@/lib/parsers/pptx"
import { exportPptx } from "@/lib/export/exporters/pptx"
import { validateOoxml, validateHtml } from "../roundtrip/checks"

const toCells = (strings: TranslatableString[], translate?: (s: string) => string): CellData[] =>
  strings.map(
    (s, i) =>
      ({
        id: s.id || `c${i}`,
        fileId: "f",
        original: s.original,
        translated: translate ? translate(s.original) : s.translated,
        group: s.group || s.id,
        context: s.context ?? "",
        type: s.type,
        status: "unvalidated",
        validationStatus: "unvalidated",
        activeValidators: [],
        validationHistory: [],
        history: [],
        threads: [],
      }) as unknown as CellData,
  )

const tr = (s: string): string => `«${s}»`

describe("HTML", () => {
  it("[fmt.html.roundtrip] extracts block text, skips script/style, exports with markup skeleton preserved", async () => {
    const html = `<!DOCTYPE html>\n<html><head><title>Page title</title><style>p{color:red}</style></head><body><h1>Main heading</h1><p>First paragraph &amp; entity.</p><ul><li>Item one</li><li>Item two</li></ul><script>var x = "no translate";</script><blockquote>Quoted text</blockquote></body></html>`
    const strings = extractHtmlStrings(html)
    const texts = strings.map((s) => s.original)
    expect(texts).toContain("Page title")
    expect(texts).toContain("Main heading")
    expect(texts).toContain("First paragraph & entity.")
    expect(texts).toContain("Item one")
    expect(texts).toContain("Quoted text")
    expect(texts.join(" ")).not.toContain("no translate")
    expect(texts.join(" ")).not.toContain("color:red")

    const out = await exportHtml(html, toCells(strings, tr)).text()
    expect(out).toContain("<ul>")
    expect(out).toContain("<h1>")
    expect(out).toContain("«Main heading»")
    expect(out).toContain("«Item one»")
    expect(out).toContain(`var x = "no translate";`) // script untouched
    expect(out.toLowerCase()).toContain("<!doctype html>")
    // external parse check + re-import symmetry
    expect(validateHtml(new TextEncoder().encode(out))).toBeNull()
    const reparsed = extractHtmlStrings(out)
    expect(reparsed.length).toBe(strings.length)
    expect(reparsed.map((s) => s.original)).toEqual(strings.map((s) => tr(s.original)))
  })
})

describe("JSON", () => {
  it("[fmt.json.roundtrip] leaf strings translate by JSON path; structure, key order and non-strings untouched", async () => {
    const src = JSON.stringify(
      {
        app: { title: "Hello", nested: { deep: "Value" } },
        list: ["one", "two"],
        "weird key!": "kept",
        meta: { count: 3, on: true, none: null },
      },
      null,
      2,
    )
    const strings = extractJsonStrings(src)
    expect(strings.map((s) => s.context)).toEqual([
      "app.title",
      "app.nested.deep",
      "list[0]",
      "list[1]",
      '["weird key!"]',
    ])
    const out = await exportJson(src, toCells(strings, tr)).text()
    const parsed = JSON.parse(out) as { app: { title: string }; list: string[]; meta: { count: number; on: boolean; none: null } }
    expect(parsed.app.title).toBe("«Hello»")
    expect(parsed.list).toEqual(["«one»", "«two»"])
    expect(parsed.meta).toEqual({ count: 3, on: true, none: null })
    expect(Object.keys(parsed)).toEqual(["app", "list", "weird key!", "meta"])
    // 2-space indentation preserved
    expect(out).toContain('\n  "app"')
  })
})

describe("properties", () => {
  it("[fmt.properties.roundtrip] keys, comments and escapes survive; values translate", async () => {
    const src = "# UI labels\napp.save=Save changes\napp.cancel = Cancel\npath.win=C\\:\\\\Users\n! alt comment\napp.multi=line one \\\n  continued\n"
    const strings = extractPropertiesStrings(src)
    expect(strings.map((s) => s.context)).toEqual(["app.save", "app.cancel", "path.win", "app.multi"])
    expect(strings[2].original).toBe("C:\\Users")
    const out = await exportProperties(src, toCells(strings, tr)).text()
    expect(out).toContain("# UI labels")
    expect(out).toContain("! alt comment")
    expect(out).toContain("app.save=«Save changes»")
    expect(out).toContain("app.cancel = «Cancel»") // separator style kept
    const reparsed = extractPropertiesStrings(out)
    expect(reparsed.map((s) => s.original)).toEqual(strings.map((s) => tr(s.original)))
  })
})

describe("SBV", () => {
  it("[fmt.srt.sbv] parses YouTube SBV cues with timecodes into timed segments", () => {
    const src = "0:00:01.500,0:00:04.000\nFirst caption\n\n1:02:03.450,1:02:06.000\nSecond caption\nwith two lines\n\nmalformed block without timecode\n"
    const strings = extractSbvStrings(src)
    expect(strings).toHaveLength(2)
    expect(strings[0].start).toBeCloseTo(1.5)
    expect(strings[0].end).toBeCloseTo(4)
    expect(strings[1].start).toBeCloseTo(3723.45)
    expect(strings[1].original).toBe("Second caption\nwith two lines")
    expect(strings.every((s) => s.type === "cue")).toBe(true)
  })
})

describe("PPTX", () => {
  it("[fmt.pptx.roundtrip] translated export rebuilds the original deck skeleton (independent structural diff)", async () => {
    // fixture deck: 2 slides, multi-run paragraph, empty paragraph
    const zip = new JSZip()
    const slide = (shapes: string[]): string =>
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${shapes.join("")}</p:spTree></p:cSld></p:sld>`
    zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`)
    zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`)
    zip.file("ppt/presentation.xml", `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`)
    zip.file("ppt/slides/slide1.xml", slide([`<p:sp><p:txBody><a:p><a:r><a:rPr b="1"/><a:t>Bold intro </a:t></a:r><a:r><a:t>plus plain tail</a:t></a:r></a:p></p:txBody></p:sp>`]))
    zip.file("ppt/slides/slide2.xml", slide([`<p:sp><p:txBody><a:p><a:r><a:t>Second slide text</a:t></a:r></a:p><a:p></a:p></p:txBody></p:sp>`]))
    const u8 = await zip.generateAsync({ type: "uint8array" })
    const original = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer

    const strings = await extractPptxStrings(original)
    expect(strings.length).toBeGreaterThan(0)
    const result = await exportPptx(original, toCells(strings, tr))
    expect(result.injected).toBeGreaterThan(0)
    const out = new Uint8Array(await result.blob.arrayBuffer())
    // independent python-stdlib validator: part list, XML well-formed, a:t counts per slide
    expect(validateOoxml(new Uint8Array(original), out, "pptx")).toBeNull()
    const reparsed = await extractPptxStrings(out.buffer.slice(0) as ArrayBuffer)
    expect(reparsed.map((s) => s.original)).toEqual(strings.map((s) => tr(s.original)))
  })
})
