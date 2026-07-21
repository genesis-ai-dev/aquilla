#!/usr/bin/env node
// Generates e2e/fixtures/agent/legacy-export.xlsx — a hand-built, dependency-free
// minimal OOXML spreadsheet standing in for a "legacy TMS export" a translation
// org might hand an agent. See AQU-AGENT-CONTRACTS.md / TRACES.md (aqu-agent
// swarm): neither `exceljs` nor `xlsx` was in the repo lockfile at build time,
// and the swarm-contract rule is "use a dep ONLY if already in the lockfile" —
// so this writes a real, valid .xlsx by constructing the ZIP container and the
// OOXML parts (Content_Types, workbook, worksheet, styles) by hand, using only
// Node's built-in `zlib` for DEFLATE. No third-party dependency added.
//
// Run: node e2e/fixtures/agent/generate-xlsx.mjs
// Regenerates e2e/fixtures/agent/legacy-export.xlsx deterministically.

import { deflateRawSync } from "node:zlib"
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_PATH = path.join(__dirname, "legacy-export.xlsx")

// --- minimal ZIP writer (store or deflate, standard local/central/EOCD records) ---

/** CRC-32 (ISO-3309 / zlib polynomial), implemented by hand — Node's zlib
 * module doesn't expose crc32() directly and this file intentionally adds no
 * dependency. Table-driven, computed once at module load. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date) {
  // Fixed timestamp so the fixture is byte-identical across regenerations.
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f)
  const dosDate =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f)
  return { time, dosDate }
}

function buildZip(entries) {
  // entries: [{ name: string, data: Buffer }]
  const FIXED_DATE = new Date(Date.UTC(2019, 2, 11, 12, 0, 0)) // 2019-03-11, matches fixture content
  const { time, dosDate } = dosDateTime(FIXED_DATE)

  const localChunks = []
  const centralChunks = []
  let offset = 0

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8")
    const crc = crc32(data)
    const compressed = deflateRawSync(data)
    const useDeflate = compressed.length < data.length
    const payload = useDeflate ? compressed : data
    const method = useDeflate ? 8 : 0

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4) // version needed
    localHeader.writeUInt16LE(0, 6) // flags
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt16LE(time, 10)
    localHeader.writeUInt16LE(dosDate, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(payload.length, 18)
    localHeader.writeUInt32LE(data.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28)

    localChunks.push(localHeader, nameBuf, payload)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4) // version made by
    centralHeader.writeUInt16LE(20, 6) // version needed
    centralHeader.writeUInt16LE(0, 8) // flags
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(time, 12)
    centralHeader.writeUInt16LE(dosDate, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(payload.length, 20)
    centralHeader.writeUInt32LE(data.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30) // extra len
    centralHeader.writeUInt16LE(0, 32) // comment len
    centralHeader.writeUInt16LE(0, 34) // disk number
    centralHeader.writeUInt16LE(0, 36) // internal attrs
    centralHeader.writeUInt32LE(0, 38) // external attrs
    centralHeader.writeUInt32LE(offset, 42)

    centralChunks.push(centralHeader, nameBuf)

    offset += localHeader.length + nameBuf.length + payload.length
  }

  const centralDirStart = offset
  const centralDir = Buffer.concat(centralChunks)
  const centralDirSize = centralDir.length

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirSize, 12)
  eocd.writeUInt32LE(centralDirStart, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localChunks, centralDir, eocd])
}

// --- OOXML parts ---

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Export" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

const COLS = ["A", "B", "C", "D", "E", "F"]

/**
 * Mirrors legacy-export.csv's shape but exercises xlsx-specific traps a
 * naive CSV-style parser would choke on:
 *  - a merged title cell over the header row (A1:F1) — legacy Excel exports
 *    from a "Save As" of a formatted report commonly carry these; the real
 *    column headers are on row 2, not row 1.
 *  - a fully blank row (row 5) inside the data range — trailing/interior
 *    blank rows are common when exported from a filtered view.
 *  - a numeric-looking cell forced to text ("Status" column values are all
 *    caps codes, not formulas, but GEN.1.1-style refs LOOK like they could
 *    be parsed as dates/numbers by an over-eager importer).
 *  - non-ASCII text in a cell (French diacritics) to exercise inline-string
 *    UTF-8 handling.
 */
const ROWS = [
  ["Legacy Export — do not edit — generated 2019-03-11", "", "", "", "", ""], // row1: merged title
  ["Ref", "EN", "FR", "Status", "Reviewer", "LastTouched"], // row2: real headers
  [
    "GEN.1.1",
    "In the beginning God created the heavens and the earth.",
    "Au commencement, Dieu créa les cieux et la terre.",
    "APPROVED",
    "jsmith",
    "2019-03-11",
  ],
  [
    "GEN.1.2",
    "Now the earth was formless and empty, darkness was over the surface of the deep.",
    "La terre était informe et vide; il y avait des ténèbres à la surface de l'abîme.",
    "APPROVED",
    "jsmith",
    "2019-03-11",
  ],
  ["", "", "", "", "", ""], // row5: fully blank interior row
  [
    "GEN.1.3",
    'And God said, "Let there be light," and there was light.',
    "Dieu dit: Que la lumière soit! Et la lumière fut.",
    "DRAFT",
    "",
    "",
  ],
  [
    "GEN.1.4",
    "God saw that the light was good and separated the light from the darkness.",
    "",
    "DRAFT",
    "",
    "2019-03-12",
  ],
  ["GEN.1.5", "", "Dieu appela la lumière jour, et il appela les ténèbres nuit.", "NEEDS_REVIEW", "mlee", "2019-03-12"],
  ["GEN.1.6", "", "", "PENDING", "", ""],
]

function cellXml(colLetter, rowIndex, value) {
  const ref = `${colLetter}${rowIndex}`
  if (value === "" || value == null) return `<c r="${ref}"/>`
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`
}

const sheetRows = ROWS.map((row, i) => {
  const rowIndex = i + 1
  const cells = row.map((val, colIdx) => cellXml(COLS[colIdx], rowIndex, val)).join("")
  return `<row r="${rowIndex}">${cells}</row>`
}).join("\n    ")

const WORKSHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:F${ROWS.length}"/>
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>
    <col min="1" max="1" width="10" customWidth="1"/>
    <col min="2" max="3" width="45" customWidth="1"/>
    <col min="4" max="6" width="14" customWidth="1"/>
  </cols>
  <sheetData>
    ${sheetRows}
  </sheetData>
  <mergeCells count="1">
    <mergeCell ref="A1:F1"/>
  </mergeCells>
</worksheet>`

const entries = [
  { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf8") },
  { name: "_rels/.rels", data: Buffer.from(ROOT_RELS, "utf8") },
  { name: "xl/workbook.xml", data: Buffer.from(WORKBOOK, "utf8") },
  { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(WORKBOOK_RELS, "utf8") },
  { name: "xl/styles.xml", data: Buffer.from(STYLES, "utf8") },
  { name: "xl/worksheets/sheet1.xml", data: Buffer.from(WORKSHEET, "utf8") },
]

const zipBuf = buildZip(entries)
writeFileSync(OUT_PATH, zipBuf)
console.log(`wrote ${OUT_PATH} (${zipBuf.length} bytes, ${entries.length} parts)`)
