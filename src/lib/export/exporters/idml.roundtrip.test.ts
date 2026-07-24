import { it, expect, describe } from "vitest"
import JSZip from "jszip"
import type { CellData } from "@/hooks/useCells"
import { exportIdml } from "./idml"

const IDPKG = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"'

function storyXml(inner: string, self = "u100"): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Story ${IDPKG} DOMVersion="18.0"><Story Self="${self}">${inner}</Story></idPkg:Story>`
}

function psr(inner: string, style = "ParagraphStyle/$ID/NormalParagraphStyle"): string {
  return `<ParagraphStyleRange AppliedParagraphStyle="${style}">${inner}</ParagraphStyleRange>`
}

function csr(inner: string, attrs = ""): string {
  return `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"${attrs ? ` ${attrs}` : ""}>${inner}</CharacterStyleRange>`
}

/** Minimal CellData carrying the normalized package-block locator the import
 *  path persists (metadata.aquillaImport.sourceLocator). */
function locatedCell(
  file: string,
  blockPath: string,
  translated: string,
  segment = 0,
  physicalOrder = 0,
): CellData {
  return {
    id: `cell-${blockPath}-${segment}`,
    group: `g-${blockPath}`,
    translated,
    metadata: {
      aquillaImport: {
        physicalOrder,
        sourceLocator: { kind: "package-block", memberPath: file, blockPath, segment },
      },
    },
  } as unknown as CellData
}

const STORY = "Stories/Story_u100.xml"

async function buildFixture(): Promise<ArrayBuffer> {
  const footnote = `<Footnote>${psr(csr("<Content>Footnote text</Content>"))}</Footnote>`
  const body =
    psr(csr("<Content>Chapter One</Content>"), "ParagraphStyle/Heading 1")                    // [1] heading
    + psr(csr("<Content>Keep me untranslated</Content><Br/>"))                                 // [2] untouched
    + psr(csr("<Content>the </Content>") + csr("<Content>LORD</Content>", 'FontStyle="Bold"') + csr("<Br/>")) // [3] mixed
    + psr(csr(`<Content>Body with note</Content>${footnote}<Br/>`))                            // [4] footnote carrier
  const zip = new JSZip()
  zip.file("mimetype", "application/vnd.adobe.indesign-idml-package")
  zip.file(
    "designmap.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Document ${IDPKG} Self="d"><idPkg:Story src="${STORY}"/></Document>`,
  )
  zip.file("Resources/Styles.xml", `<?xml version="1.0"?><idPkg:Styles ${IDPKG}></idPkg:Styles>`)
  zip.file(STORY, storyXml(body))
  return zip.generateAsync({ type: "arraybuffer" })
}

describe("exportIdml", () => {
  it("injects by locator, preserves untouched paragraphs/parts byte-identically", async () => {
    const raw = await buildFixture()
    const original = await JSZip.loadAsync(raw)
    const originalXml = await original.file(STORY)!.async("string")

    const cells = [
      locatedCell(STORY, "ParagraphStyleRange[1]", "Chapitre Un", 0, 0),
      locatedCell(STORY, "ParagraphStyleRange[2]", "", 0, 1),
      locatedCell(STORY, "ParagraphStyleRange[3]", "le SEIGNEUR", 0, 2),
      locatedCell(STORY, "ParagraphStyleRange[4]", "Corps avec note", 0, 3),
    ]

    const { blob, injected, untouched, warnings } = await exportIdml(raw, cells)
    expect(injected).toBe(3)
    expect(untouched).toBe(1)

    const out = await JSZip.loadAsync(await blob.arrayBuffer())
    const xml = await out.file(STORY)!.async("string")

    // (a) every non-story part byte-identical
    for (const name of Object.keys(original.files)) {
      if (name === STORY || original.files[name].dir) continue
      expect(await out.file(name)!.async("string")).toBe(await original.file(name)!.async("string"))
    }
    // (b) translations landed
    expect(xml).toContain("<Content>Chapitre Un</Content>")
    expect(xml).toContain("<Content>Corps avec note</Content>")
    // (c) untranslated paragraph is verbatim, trailing <Br/> intact
    expect(xml).toContain(psr(csr("<Content>Keep me untranslated</Content><Br/>")))
    // (d) mixed-format paragraph: translation in first run, second run blanked
    //     but its element (and bold attribute) still present
    expect(xml).toContain("<Content>le SEIGNEUR</Content>")
    expect(xml).toMatch(/FontStyle="Bold"><Content><\/Content>/)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].detail).toMatch(/mixed inline formatting/)
    // (e) footnote text untouched
    expect(xml).toContain("<Content>Footnote text</Content>")
    // (f) paragraph terminators survive: same <Br/> count as the original
    expect(xml.match(/<Br\/>/g)?.length).toBe(originalXml.match(/<Br\/>/g)?.length)
    // (g) XML declaration unchanged (no whole-doc reserialize)
    expect(xml.slice(0, 60)).toBe(originalXml.slice(0, 60))
  })

  it("splits translation newlines into <Br/>-separated content runs", async () => {
    const raw = await buildFixture()
    const cells = [locatedCell(STORY, "ParagraphStyleRange[1]", "ligne un\nligne deux")]
    const { blob } = await exportIdml(raw, cells)
    const out = await JSZip.loadAsync(await blob.arrayBuffer())
    const xml = await out.file(STORY)!.async("string")
    expect(xml).toContain("<Content>ligne un</Content><Br/><Content>ligne deux</Content>")
  })

  it("escapes XML special characters in translations", async () => {
    const raw = await buildFixture()
    const cells = [locatedCell(STORY, "ParagraphStyleRange[1]", 'A & B < C')]
    const { blob } = await exportIdml(raw, cells)
    const out = await JSZip.loadAsync(await blob.arrayBuffer())
    const xml = await out.file(STORY)!.async("string")
    expect(xml).toContain("<Content>A &amp; B &lt; C</Content>")
  })

  it("joins multi-segment cells of one paragraph with a space", async () => {
    const raw = await buildFixture()
    const cells = [
      locatedCell(STORY, "ParagraphStyleRange[1]", "Première partie.", 0, 0),
      locatedCell(STORY, "ParagraphStyleRange[1]", "Deuxième partie.", 1, 1),
    ]
    const { blob, injected } = await exportIdml(raw, cells)
    expect(injected).toBe(1)
    const out = await JSZip.loadAsync(await blob.arrayBuffer())
    const xml = await out.file(STORY)!.async("string")
    expect(xml).toContain("<Content>Première partie. Deuxième partie.</Content>")
  })

  it("throws on an archive without stories", async () => {
    const zip = new JSZip()
    zip.file("designmap.xml", "<Document/>")
    const raw = await zip.generateAsync({ type: "arraybuffer" })
    await expect(exportIdml(raw, [])).rejects.toThrow(/no Stories/)
  })
})
