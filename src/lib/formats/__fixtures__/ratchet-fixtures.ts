// Fixtures for the one round-trip ratchet (AQU-2384).
//
// Deliberately BORING documents: one short sentence per block, no mixed
// formatting, no multi-sentence paragraphs. The ratchet is about the contract
// — does a format come back out the way it went in, and does changing one unit
// change exactly one unit — and a fixture with a comma in it would instead be
// testing the sentence splitter, which has its own tests. Per-format richness
// (tables, lists, images, mixed runs, footnotes) stays in the per-format
// round-trip tests, which this does not replace.

import JSZip from "jszip"

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const IDPKG = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"'
const IDML_MIME = "application/vnd.adobe.indesign-idml-package"
export const IDML_STORY = "Stories/Story_u100.xml"

export async function docxFixture(): Promise<ArrayBuffer> {
  const para = (text: string): string =>
    `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document ${W}><w:body>` +
    para("Alpha") + para("Bravo") + para("Charlie") +
    `</w:body></w:document>`
  const zip = new JSZip()
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  )
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  )
  zip.file("word/document.xml", documentXml)
  return zip.generateAsync({ type: "arraybuffer" })
}

export async function pptxFixture(): Promise<ArrayBuffer> {
  const para = (text: string): string => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`
  const slideXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld ${P} ${A}><p:cSld><p:spTree><p:sp><p:txBody>` +
    para("Alpha") + para("Bravo") + para("Charlie") +
    `</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
  const zip = new JSZip()
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
  )
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  )
  zip.file("ppt/slides/slide1.xml", slideXml)
  return zip.generateAsync({ type: "arraybuffer" })
}

export async function idmlFixture(): Promise<ArrayBuffer> {
  const range = (self: string, text: string): string =>
    `<ParagraphStyleRange Self="${self}" AppliedParagraphStyle="ParagraphStyle/Body">` +
    `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain"><Content>${text}</Content></CharacterStyleRange>` +
    `</ParagraphStyleRange>`
  const story = [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<idPkg:Story ${IDPKG}><Story Self="u100">`,
    range("alpha", "Alpha"),
    range("bravo", "Bravo"),
    range("charlie", "Charlie"),
    `</Story></idPkg:Story>`,
  ].join("")
  const zip = new JSZip()
  zip.file("mimetype", IDML_MIME, { compression: "STORE", createFolders: false })
  zip.file(
    "designmap.xml",
    `<?xml version="1.0" encoding="UTF-8"?><Document ${IDPKG}><idPkg:Story src="${IDML_STORY}"/></Document>`,
    { compression: "DEFLATE", createFolders: false },
  )
  zip.file(
    "Resources/Styles.xml",
    `<?xml version="1.0"?><idPkg:Styles ${IDPKG}></idPkg:Styles>`,
    { compression: "DEFLATE", createFolders: false },
  )
  zip.file(IDML_STORY, story, { compression: "DEFLATE", createFolders: false })
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" })
}

export const HTML_FIXTURE = [
  "<!DOCTYPE html>",
  '<html lang="en"><head><title>Ratchet</title></head><body>',
  "<h1>Alpha</h1>",
  "<p>Bravo</p>",
  "<p>Charlie</p>",
  "</body></html>",
].join("\n")

export const XLIFF_FIXTURE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">',
  '  <file source-language="en" target-language="fr" datatype="plaintext" original="ratchet">',
  "    <body>",
  '      <trans-unit id="u1"><source>Alpha</source><target state="new"></target></trans-unit>',
  '      <trans-unit id="u2"><source>Bravo</source><target state="new"></target></trans-unit>',
  '      <trans-unit id="u3"><source>Charlie</source><target state="new"></target></trans-unit>',
  "    </body>",
  "  </file>",
  "</xliff>",
].join("\n")

export const SRT_FIXTURE = [
  "1",
  "00:00:01,000 --> 00:00:02,000",
  "Alpha",
  "",
  "2",
  "00:00:03,000 --> 00:00:04,000",
  "Bravo",
  "",
  "3",
  "00:00:05,000 --> 00:00:06,000",
  "Charlie",
  "",
].join("\n")

export const VTT_FIXTURE = [
  "WEBVTT",
  "",
  "00:00:01.000 --> 00:00:02.000",
  "Alpha",
  "",
  "00:00:03.000 --> 00:00:04.000",
  "Bravo",
  "",
  "00:00:05.000 --> 00:00:06.000",
  "Charlie",
  "",
].join("\n")
