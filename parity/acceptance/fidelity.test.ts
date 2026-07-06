// Acceptance tests for the appended rows (principal directive 2026-07-04):
// fmt.blockstyle.fidelity and qa.inline-warnings.
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import type { CellData } from "@/hooks/useCells"
import type { TranslatableString } from "@/lib/parsers/types"
import { extractMarkdownStrings } from "@/lib/parsers/markdown"
import { extractHtmlStrings, exportHtml } from "@/lib/parsers/html"
import { extractDocxStrings } from "@/lib/parsers/docx"
import { parseXliff } from "@/lib/parsers/xliff"
import { parseTmx } from "@/lib/parsers/tmx"
import { exportMarkdownStructured } from "@/lib/export/exporters/markdown"
import { exportDocx } from "@/lib/export/exporters/docx"
import { exportPptx } from "@/lib/export/exporters/pptx"
import { extractPptxStrings } from "@/lib/parsers/pptx"
import {
  compareBlockStyles,
  collectInlineStyleWarnings,
  blockStyleOf,
} from "@/lib/export/fidelity"

const toCells = (
  strings: TranslatableString[],
  translate?: (s: string, i: number) => string,
): CellData[] =>
  strings.map(
    (s, i) =>
      ({
        id: s.id || `c${i}`,
        fileId: "f",
        original: s.original,
        originalHtml: s.originalHtml,
        translated: translate ? translate(s.original, i) : s.translated,
        group: s.group || s.id,
        context: s.context ?? "",
        type: s.type,
        status: "unvalidated",
        validationStatus: "unvalidated",
        activeValidators: [],
        validationHistory: [],
        history: [],
        threads: [],
        metadata: s.metadata,
      }) as unknown as CellData,
  )

const tr = (s: string): string => `«${s}»`

describe("block-style round-trip fidelity", () => {
  it("[fmt.blockstyle.fidelity] markdown ordered lists stay ordered; heading levels and quotes survive re-import", async () => {
    const src = "## Section two\n\n1. first step\n2. second step\n\n- bullet one\n- bullet two\n\n> quoted line\n\nPlain paragraph.\n"
    const strings = extractMarkdownStrings(src)
    expect(blockStyleOf(strings[1]).listKind).toBe("ordered")
    expect(blockStyleOf(strings[3]).listKind).toBe("unordered")

    const out = await exportMarkdownStructured(toCells(strings, tr)).text()
    expect(out).toContain("1. «first step»")
    expect(out).toContain("2. «second step»")
    expect(out).toContain("- «bullet one»")
    expect(out).toContain("## «Section two»")
    expect(out).toContain("> «quoted line»")

    const reimported = extractMarkdownStrings(out)
    expect(compareBlockStyles(strings, reimported)).toEqual([])
    // and the comparator actually catches degradation: fake an ol→ul drift
    const degraded = extractMarkdownStrings(out.replace("1. «first step»", "- «first step»"))
    expect(compareBlockStyles(strings, degraded).some((w) => w.detail.includes("list kind"))).toBe(true)
  })

  it("[fmt.blockstyle.fidelity] html list kind and heading levels survive the export skeleton", async () => {
    const src = `<!DOCTYPE html><html><body><h2>Title</h2><ol><li>Step one</li><li>Step two</li></ol><ul><li>Bullet</li></ul><p>Para.</p></body></html>`
    const strings = extractHtmlStrings(src)
    expect(blockStyleOf(strings[1]).listKind).toBe("ordered")
    expect(blockStyleOf(strings[3]).listKind).toBe("unordered")
    const out = await exportHtml(src, toCells(strings, tr)).text()
    expect(out).toContain("<ol>")
    const reimported = extractHtmlStrings(out)
    expect(compareBlockStyles(strings, reimported)).toEqual([])
  })

  it("[fmt.blockstyle.fidelity] docx heading styles survive translated export (re-import shows same contexts)", async () => {
    const zip = new JSZip()
    zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
    zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
    zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Heading text</w:t></w:r></w:p><w:p><w:r><w:t>Body text.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`)
    const u8 = await zip.generateAsync({ type: "uint8array" })
    const original = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
    const strings = await extractDocxStrings(original)
    const result = await exportDocx(original, toCells(strings, tr))
    const out = await result.blob.arrayBuffer()
    const reimported = await extractDocxStrings(out)
    expect(compareBlockStyles(strings, reimported)).toEqual([])
    expect(reimported[0].context).toBe("Heading 2")
  })
})

describe("inline-style mismatch warnings", () => {
  it("[qa.inline-warnings] edited XLIFF targets that lose inline tags produce a per-segment warning; unedited/clean exports do not", () => {
    const xlf = `<?xml version="1.0"?><xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2"><file source-language="en" target-language="fr" datatype="plaintext" original="d"><body>
<trans-unit id="tagged"><source>Press <g id="1">Save</g> now</source><target state="translated">Appuyez <g id="1">Enregistrer</g> vite</target></trans-unit>
<trans-unit id="plain"><source>No tags here</source><target state="translated">Pas de balises</target></trans-unit>
</body></file></xliff>`
    const strings = parseXliff(xlf)

    // unedited (targets as imported) → zero warnings
    expect(collectInlineStyleWarnings(toCells(strings))).toEqual([])

    // edit the TAGGED segment's translation → exactly one warning, pointing at it
    const edited = toCells(strings, (s, i) => (i === 0 ? "Texte réécrit sans balises" : strings[i].translated))
    const warnings = collectInlineStyleWarnings(edited)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].kind).toBe("inline-tags-unplaced")
    expect(warnings[0].segment).toBe("tagged")
  })

  it("[qa.inline-warnings] TMX skeletons, rich originalHtml blocks and subtitle payload tags all warn on mismatch", () => {
    // TMX
    const tmx = parseTmx(`<?xml version="1.0"?><tmx version="1.4"><header srclang="en"/><body><tu tuid="t"><tuv xml:lang="en"><seg>Hi <bpt i="1">&lt;b&gt;</bpt>you<ept i="1">&lt;/b&gt;</ept></seg></tuv><tuv xml:lang="fr"><seg>Salut <bpt i="1">&lt;b&gt;</bpt>toi<ept i="1">&lt;/b&gt;</ept></seg></tuv></tu></body></tmx>`)
    expect(collectInlineStyleWarnings(toCells(tmx))).toEqual([]) // unedited
    const tmxEdited = collectInlineStyleWarnings(toCells(tmx, () => "Réécrit"))
    expect(tmxEdited.some((w) => w.kind === "inline-tags-unplaced")).toBe(true)

    // rich markdown block (originalHtml)
    const md = extractMarkdownStrings("Some **bold** phrase here\n")
    const mdWarnings = collectInlineStyleWarnings(toCells(md, () => "Traduction éditée"))
    expect(mdWarnings.some((w) => w.kind === "inline-style-simplified")).toBe(true)
    expect(collectInlineStyleWarnings(toCells(md))).toEqual([]) // untranslated → no warning

    // subtitle payload tags
    const cueCells = toCells(
      [{ id: "cue1", original: "Watch <i>this</i> now", translated: "", context: "", group: "cue1", type: "cue" } as TranslatableString],
      () => "Regarde ça maintenant",
    )
    const cueWarnings = collectInlineStyleWarnings(cueCells)
    expect(cueWarnings.some((w) => w.kind === "inline-tags-unplaced")).toBe(true)
    // tag-preserving translation → clean
    const cueOk = collectInlineStyleWarnings(
      toCells(
        [{ id: "cue1", original: "Watch <i>this</i> now", translated: "", context: "", group: "cue1", type: "cue" } as TranslatableString],
        () => "Regarde <i>ça</i> maintenant",
      ),
    )
    expect(cueOk).toEqual([])
  })

  it("[qa.inline-warnings] docx and pptx exports report mixed-run formatting simplification per paragraph", async () => {
    // docx with a mixed-format paragraph and a uniform one
    const zip = new JSZip()
    zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
    zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
    zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Bold start </w:t></w:r><w:r><w:t>plain end</w:t></w:r></w:p><w:p><w:r><w:t>Uniform paragraph.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`)
    const u8 = await zip.generateAsync({ type: "uint8array" })
    const original = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
    const strings = await extractDocxStrings(original)
    const result = await exportDocx(original, toCells(strings, tr))
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0].detail).toContain("mixed inline formatting")

    // pptx with a mixed-run paragraph
    const pz = new JSZip()
    pz.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`)
    pz.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`)
    pz.file("ppt/presentation.xml", `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`)
    pz.file("ppt/slides/slide1.xml", `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:rPr b="1"/><a:t>Bold </a:t></a:r><a:r><a:t>plain</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`)
    const pu8 = await pz.generateAsync({ type: "uint8array" })
    const pOriginal = pu8.buffer.slice(pu8.byteOffset, pu8.byteOffset + pu8.byteLength) as ArrayBuffer
    const pStrings = await extractPptxStrings(pOriginal)
    const pResult = await exportPptx(pOriginal, toCells(pStrings, tr))
    expect(pResult.warnings).toHaveLength(1)
    expect(pResult.warnings[0].detail).toContain("mixed inline formatting")
  })
})
