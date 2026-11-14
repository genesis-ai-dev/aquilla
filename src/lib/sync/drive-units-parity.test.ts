// Why this test: the Drive folder sync builds revision units on the server
// (sync-worker/src/drive/drive-units.ts). If they differ from what the Import
// dialog sends for the same .docx — a unit key, the stamp, the import
// envelope — then a file imported by hand and later linked to Drive would
// realign on its first sync instead of matching paragraph for paragraph.

import { describe, expect, it } from "vitest"
import JSZip from "jszip"
import { extractDocxStrings } from "@/lib/parsers/docx"
import { buildBulkCellsWithSpeakers } from "@/lib/import"
import { normalizeTranslatableStrings } from "@/lib/import/normalized-manifest"
import { revisionUnitsFromCells } from "./revision-import"
import { docxRevisionUnits } from "../../../sync-worker/src/drive/drive-units"

async function docx(paras: string[]): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`)
  return zip.generateAsync({ type: "uint8array" })
}

describe("Drive sync units match the Import dialog's", () => {
  it.each(["sentence", "paragraph"] as const)("for the same .docx (cellUnit %s)", async (cellUnit) => {
    // A repeated paragraph exercises the `#n` key suffix; two sentences in one
    // paragraph exercise the sentence split.
    const bytes = await docx(["Chapter one", "One sentence. Another sentence.", "Repeated.", "Repeated.", ""])
    const fileName = "Chapter 1.docx"

    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const strings = await extractDocxStrings(buffer, { cellUnit })
    const normalizedFile = normalizeTranslatableStrings(strings, {
      fileName,
      fileType: "docx",
      profileId: "builtin:docx",
      profileVersion: "1",
    })
    const { cells } = buildBulkCellsWithSpeakers(strings, { normalizedFile })
    const client = revisionUnitsFromCells(cells)

    const server = await docxRevisionUnits(bytes, { fileName, cellUnit })

    expect(server.stamp).toBe(`${normalizedFile.profileId}@${normalizedFile.profileVersion}`)
    expect(server.units).toEqual(client)
    expect(server.units.length).toBeGreaterThan(3)
  })
})
