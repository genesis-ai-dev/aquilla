// Shared DOCX import-parity fixture (AQU-1237).
//
// AQU-1237 made `extractDocxStrings` runnable server-side, so a .docx uploaded
// through the Agent API must land the SAME cells as the same file dropped into
// the in-app Import dialog. This module is the one fixture both sides compare
// against: the root suite runs it through the browser entry point
// (src/lib/parsers/docx.test.ts's neighbours) and sync-worker's
// external-import-parse suite pushes the identical bytes through the REST parse
// route. If the two ever diverge, one of those two tests fails.
//
// The archive is written here by hand with STORED (uncompressed) members rather
// than through JSZip, for two reasons: sync-worker does not depend on JSZip,
// and a stored archive exercises `zip-lite`'s method-0 path (docx.test.ts
// covers the deflate path via JSZip). Everything is plain typed arrays, so the
// module imports cleanly into both TypeScript programs.

const encoder = new TextEncoder()

/** Paragraphs covering every branch of the parser: plain text, a Heading style,
 *  the Title style, run formatting (which enables originalHtml), a footnote
 *  anchor, and a whitespace-only paragraph that must be dropped. */
const BODY_XML = `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Field Guide</w:t></w:r></w:p>` +
  `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Getting started</w:t></w:r></w:p>` +
  `<w:p><w:r><w:t xml:space="preserve">Plain sentence with an </w:t></w:r>` +
  `<w:r><w:rPr><w:b/></w:rPr><w:t>emphasised</w:t></w:r>` +
  `<w:r><w:t xml:space="preserve"> word &amp; an entity.</w:t></w:r></w:p>` +
  `<w:p><w:r><w:t xml:space="preserve">Anchored here</w:t></w:r>` +
  `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="2"/></w:r>` +
  `<w:r><w:t>.</w:t></w:r></w:p>` +
  `<w:p><w:r><w:t>   </w:t></w:r></w:p>`

const FOOTNOTES_XML =
  `<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>` +
  `<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>` +
  `<w:footnote w:id="2"><w:p><w:r><w:t xml:space="preserve">See the appendix.</w:t></w:r></w:p></w:footnote>`

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${BODY_XML}</w:body></w:document>`

const FOOTNOTES_DOC = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${FOOTNOTES_XML}</w:footnotes>`

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`

/** The fixture's file name, so both suites name the artifact identically. */
export const DOCX_PARITY_FILE_NAME = "field-guide.docx"

/**
 * The cells a correct DOCX import produces from this fixture, in order — the
 * shared expectation. Only the deterministic fields are listed; `id` is a fresh
 * UUID per run and `group` is minted by the segment splitter.
 */
export const DOCX_PARITY_EXPECTED_CELLS: {
  original: string
  context: string
  type: "text" | "heading"
  originalHtml?: string
  paragraphStart: boolean
}[] = [
  { original: "Field Guide", context: "Title", type: "heading", paragraphStart: true },
  { original: "Getting started", context: "Heading 2", type: "heading", paragraphStart: true },
  {
    original: "Plain sentence with an emphasised word & an entity.",
    context: "Paragraph",
    type: "text",
    originalHtml: "Plain sentence with an <b>emphasised</b> word & an entity.",
    paragraphStart: true,
  },
  {
    original: "Anchored here\\f + \\ft See the appendix.\\f*.",
    context: "Paragraph",
    type: "text",
    paragraphStart: true,
  },
]

/** Build the fixture's .docx bytes. Deterministic — same bytes every call. */
export function buildDocxParityFixture(): Uint8Array {
  return writeStoredZip([
    { name: "[Content_Types].xml", content: CONTENT_TYPES },
    { name: "word/document.xml", content: DOCUMENT_XML },
    { name: "word/footnotes.xml", content: FOOTNOTES_DOC },
  ])
}

// ── minimal STORED-only zip writer ───────────────────────────────────────────

interface ZipMember {
  name: string
  content: string
}

function writeStoredZip(members: ZipMember[]): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const member of members) {
    const nameBytes = encoder.encode(member.name)
    const data = encoder.encode(member.content)
    const crc = crc32(data)

    const local = new Uint8Array(30 + nameBytes.length + data.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true) // local file header signature
    localView.setUint16(4, 20, true) // version needed
    localView.setUint16(6, 0, true) // flags
    localView.setUint16(8, 0, true) // method: stored
    localView.setUint32(14, crc, true)
    localView.setUint32(18, data.length, true) // compressed size
    localView.setUint32(22, data.length, true) // uncompressed size
    localView.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(data, 30 + nameBytes.length)
    locals.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true) // central directory signature
    centralView.setUint16(4, 20, true) // version made by
    centralView.setUint16(6, 20, true) // version needed
    centralView.setUint16(10, 0, true) // method: stored
    centralView.setUint32(16, crc, true)
    centralView.setUint32(20, data.length, true)
    centralView.setUint32(24, data.length, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint32(42, offset, true) // local header offset
    central.set(nameBytes, 46)
    centrals.push(central)

    offset += local.length
  }

  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, members.length, true) // entries on this disk
  eocdView.setUint16(10, members.length, true) // total entries
  eocdView.setUint32(12, centralSize, true)
  eocdView.setUint32(16, offset, true) // central directory offset

  return concat([...locals, ...centrals, eocd])
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

let CRC_TABLE: Uint32Array | null = null

function crc32(bytes: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[i] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
