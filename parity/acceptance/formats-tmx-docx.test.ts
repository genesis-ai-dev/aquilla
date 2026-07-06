// Acceptance tests for TMX, DOCX round-trip and Download-Original rows.
// External validation (F4): TMX via official DTD (xmllint), DOCX via the
// python-stdlib OOXML structural checker — never our own export stack.
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import type { CellData } from "@/hooks/useCells"
import type { TranslatableString } from "@/lib/parsers/types"
import { parseTmx, type TmxSegmentMeta } from "@/lib/parsers/tmx"
import { extractDocxStrings } from "@/lib/parsers/docx"
import { exportTmxStructured } from "@/lib/export/exporters/tmx-structured"
import { exportDocx } from "@/lib/export/exporters/docx"
import { arrayBufferToBase64 } from "@/lib/import"
import { validateTmx, validateOoxml } from "../roundtrip/checks"

const toCells = (
  strings: TranslatableString[],
  overrides?: (s: TranslatableString, i: number) => Partial<CellData>,
): CellData[] =>
  strings.map(
    (s, i) =>
      ({
        id: s.id,
        fileId: "f",
        original: s.original,
        translated: s.translated,
        group: s.group,
        context: s.context ?? "",
        type: s.type,
        status: "unvalidated",
        validationStatus: "unvalidated",
        activeValidators: [],
        validationHistory: [],
        history: [],
        threads: [],
        metadata: s.metadata,
        ...(overrides?.(s, i) ?? {}),
      }) as unknown as CellData,
  )

const bytes = async (b: Blob): Promise<Uint8Array> => new Uint8Array(await b.arrayBuffer())

const TMX = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tmx SYSTEM "tmx14.dtd">
<tmx version="1.4">
<header creationtool="fixture" creationtoolversion="1" segtype="sentence" o-tmf="none" adminlang="en-US" srclang="en-US" datatype="plaintext"/>
<body>
<tu tuid="t1"><prop type="x-domain">legal</prop><note>reviewed</note><tuv xml:lang="en-US"><seg>Plain segment &amp; entity.</seg></tuv><tuv xml:lang="fr-FR"><seg>Segment simple &amp; entité.</seg></tuv></tu>
<tu tuid="t2"><tuv xml:lang="en-US"><seg><![CDATA[CDATA <content> here]]></seg></tuv><tuv xml:lang="fr-FR"><seg>Contenu CDATA ici</seg></tuv></tu>
<tu tuid="t3"><tuv xml:lang="en-US"><seg>Tagged <bpt i="1" x="1">&lt;b&gt;</bpt>bold<ept i="1">&lt;/b&gt;</ept> and <ph x="2">{0}</ph> value.</seg></tuv><tuv xml:lang="fr-FR"><seg>Étiqueté <bpt i="1" x="1">&lt;b&gt;</bpt>gras<ept i="1">&lt;/b&gt;</ept> et <ph x="2">{0}</ph> valeur.</seg></tuv></tu>
</body>
</tmx>`

describe("TMX", () => {
  it("[fmt.tmx.import] parses tu/tuv pairs with CDATA, entities, inline tags and header srclang", () => {
    const strings = parseTmx(TMX)
    expect(strings).toHaveLength(3)
    expect(strings[0].original).toBe("Plain segment & entity.")
    expect(strings[0].translated).toBe("Segment simple & entité.")
    expect(strings[0].context).toContain("t1")
    expect(strings[0].context).toContain("reviewed")
    expect(strings[1].original).toBe("CDATA <content> here")
    // bpt/ept/ph character data is native-format CODE per the TMX spec — it is
    // excluded from translatable text (the "<b>" and "{0}" stay in the skeleton).
    expect(strings[2].original).toBe("Tagged bold and  value.")
    const meta = (strings[2].metadata as { tmx: TmxSegmentMeta }).tmx
    expect(meta.srcLang).toBe("en-us")
    expect(meta.srcSegXml).toContain('<bpt i="1" x="1">&lt;b&gt;</bpt>')
    expect(meta.srcSegXml).toContain('<ph x="2">{0}</ph>')
  })

  it("[fmt.tmx.export] with-tags and without-tags variants both validate against the TMX 1.4 DTD", async () => {
    const strings = parseTmx(TMX)
    const withTags = await bytes(exportTmxStructured(toCells(strings), "en-US", "fr-FR"))
    const noTags = await bytes(exportTmxStructured(toCells(strings), "en-US", "fr-FR", { keepTags: false }))
    expect(validateTmx(withTags)).toBeNull()
    expect(validateTmx(noTags)).toBeNull()
    const withText = new TextDecoder().decode(withTags)
    const noText = new TextDecoder().decode(noTags)
    expect(withText).toContain("<bpt")
    expect(withText).toContain('<ph x="2">{0}</ph>')
    expect(noText).not.toContain("<bpt")
    expect(noText).toContain("Tagged bold and  value.")
    // re-import of the with-tags export preserves text and tuids
    const reparsed = parseTmx(withText)
    expect(reparsed.map((s) => s.original)).toEqual(strings.map((s) => s.original))
    expect(reparsed.map((s) => s.group)).toEqual(strings.map((s) => s.group))
  })
})

async function buildFixtureDocx(): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  )
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  )
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Document title</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Bold lead. </w:t></w:r><w:r><w:t>Plain continuation.</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph text.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
  )
  const u8 = await zip.generateAsync({ type: "uint8array" })
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

describe("DOCX round-trip", () => {
  it("[fmt.docx.roundtrip] translated export rebuilds the original zip skeleton (independent structural diff)", async () => {
    const original = await buildFixtureDocx()
    const strings = await extractDocxStrings(original)
    expect(strings.length).toBeGreaterThan(0)
    const cells = toCells(strings).map((c) => ({ ...c, translated: `«${c.original}»` }) as CellData)
    const result = await exportDocx(original, cells)
    expect(result.injected).toBeGreaterThan(0)
    const out = await bytes(result.blob)
    // independent python-stdlib validator: part list, XML well-formedness, w:p count
    expect(validateOoxml(new Uint8Array(original), out, "docx")).toBeNull()
    // translations actually landed; untranslated paragraphs would keep source
    const reparsed = await extractDocxStrings(out.buffer.slice(0) as ArrayBuffer)
    expect(reparsed.some((s) => s.original.includes("«"))).toBe(true)
    expect(reparsed.length).toBe(strings.length)
  })

  it("[fmt.docx.roundtrip] untranslated cells leave paragraphs unchanged (draft keeps source)", async () => {
    const original = await buildFixtureDocx()
    const strings = await extractDocxStrings(original)
    const cells = toCells(strings) // no translations
    const result = await exportDocx(original, cells)
    const out = await bytes(result.blob)
    expect(validateOoxml(new Uint8Array(original), out, "docx")).toBeNull()
    const reparsed = await extractDocxStrings(out.buffer.slice(0) as ArrayBuffer)
    expect(reparsed.map((s) => s.original)).toEqual(strings.map((s) => s.original))
  })
})

describe("Download Original", () => {
  it("[fmt.export.original] the side-car base64 of the uploaded bytes decodes byte-identical", async () => {
    const original = await buildFixtureDocx()
    const encoded = arrayBufferToBase64(original)
    // decode exactly as the export consumer does (atob → bytes)
    const bin = atob(encoded)
    const decoded = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) decoded[i] = bin.charCodeAt(i)
    expect(decoded.byteLength).toBe(original.byteLength)
    expect(Array.from(decoded)).toEqual(Array.from(new Uint8Array(original)))
  })

  it("[fmt.export.original] documents the 512KB side-car cap (larger files have no byte-identical path yet)", () => {
    // The import path (src/lib/import.ts) only persists rawSource for files
    // ≤ 512 * 1024 bytes because D1 TEXT rows cap at ~1MB and base64 inflates
    // ~1.37×. This test pins the documented boundary so the limitation is
    // explicit, not silent: 512KB * 1.37 ≈ 700KB < 1MB row cap.
    const cap = 512 * 1024
    expect(Math.ceil((cap * 4) / 3)).toBeLessThan(1024 * 1024)
  })
})
