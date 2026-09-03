/**
 * AQU-990 — an IDML story can hold a whole frontmatter section in one
 * paragraph, which used to blow the bulk-import route's per-cell ceiling and
 * fail the import with a bare HTTP 413 after the entire file had uploaded.
 *
 * The importer now partitions such a unit at the line breaks the shared engine
 * already knows, so each cell fits; a paragraph with no interior break is left
 * whole for the importer's size guard to report by name.
 */

import { describe, expect, it } from "vitest"
import JSZip from "jszip"
import {
  exportIdml,
  parseIdml,
  validateIdmlTranslation,
  type IdmlFormatMetadataV2,
  type IdmlLocator,
} from "@aquilla/idml-roundtrip"
import { MAX_CELL_TEXT_BYTES, utf8ByteLength } from "../../../shared/import-contract"
import { extractIdmlStrings } from "./idml"
import type { TranslatableString } from "./types"

const MIME = "application/vnd.adobe.indesign-idml-package"
const STORY = "Stories/Story_u1.xml"
const IDPKG = "http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"

/** Comfortably over a third of the ceiling, so three of them in one paragraph
 *  exceed it while each on its own stays well under. */
const CHUNK_BYTES = Math.ceil(MAX_CELL_TEXT_BYTES / 2)

function chunk(word: string): string {
  return `${word} `.repeat(Math.ceil(CHUNK_BYTES / (word.length + 1)))
}

async function makeIdmlStory(paragraphInner: string): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", MIME, { compression: "STORE" })
  zip.file(
    "designmap.xml",
    `<?xml version="1.0" encoding="UTF-8"?>`
      + `<Document xmlns:idPkg="${IDPKG}"><idPkg:Story src="${STORY}"/></Document>`,
  )
  // Stored, not deflated: these fixtures are hundreds of KB of repeated words,
  // which deflate past the archive reader's compression-ratio (zip-bomb) guard.
  zip.file(
    STORY,
    `<?xml version="1.0" encoding="UTF-8"?>`
      + `<idPkg:Story xmlns:idPkg="${IDPKG}"><Story Self="u1">`
      + `<ParagraphStyleRange Self="p1" AppliedParagraphStyle="ParagraphStyle/Body">`
      + `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Plain">`
      + paragraphInner
      + `</CharacterStyleRange>`
      + `</ParagraphStyleRange>`
      + `</Story></idPkg:Story>`,
    { compression: "STORE" },
  )
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" })
}

/** The IDML cells under test always carry both, so the non-null assertions
 *  below are the assertion — a missing one is a failure worth seeing. */
function idmlMetadata(cell: TranslatableString): IdmlFormatMetadataV2 {
  return cell.metadata!.idml as IdmlFormatMetadataV2
}

function idmlLocator(cell: TranslatableString): IdmlLocator {
  expect(cell.sourceLocator?.kind).toBe("idml")
  return cell.sourceLocator as IdmlLocator
}

function widestFieldBytes(cell: TranslatableString): number {
  return Math.max(
    utf8ByteLength(cell.original),
    cell.originalHtml ? utf8ByteLength(cell.originalHtml) : 0,
    utf8ByteLength(cell.translated),
    cell.translatedHtml ? utf8ByteLength(cell.translatedHtml) : 0,
  )
}

describe("oversized IDML units (AQU-990)", () => {
  it("splits a paragraph that exceeds the per-cell limit at its line breaks", async () => {
    const buffer = await makeIdmlStory(
      `<Content>${chunk("alpha")}</Content><Br/>`
        + `<Content>${chunk("beta")}</Content><Br/>`
        + `<Content>${chunk("gamma")}</Content>`,
    )
    const parsed = await parseIdml(buffer)

    // Precondition: the engine emits ONE unit, and it is too big to upload.
    expect(parsed.units).toHaveLength(1)
    expect(utf8ByteLength(parsed.units[0]!.sourceText)).toBeGreaterThan(MAX_CELL_TEXT_BYTES)

    const strings = await extractIdmlStrings(buffer, async () => parsed)

    expect(strings).toHaveLength(3)
    for (const cell of strings) {
      expect(widestFieldBytes(cell)).toBeLessThanOrEqual(MAX_CELL_TEXT_BYTES)
    }
    // Each part keeps its own identity and addresses its own slot range, so
    // export still reassembles the single paragraph it came from.
    expect(new Set(strings.map((cell) => cell.id)).size).toBe(3)
    expect(strings.map((cell) => idmlLocator(cell).part)).toEqual([0, 1, 2])
    expect(strings[0]!.original).toContain("alpha")
    expect(strings[1]!.original).toContain("beta")
    expect(strings[2]!.original).toContain("gamma")
    // Every part is a valid translation target in its own right.
    for (const cell of strings) {
      expect(validateIdmlTranslation(cell.originalHtml!, cell.originalHtml!, idmlMetadata(cell)))
        .toMatchObject({ valid: true })
    }
  })

  it("exports the split parts back into the one paragraph they came from", async () => {
    const buffer = await makeIdmlStory(
      `<Content>${chunk("alpha")}</Content><Br/><Content>${chunk("beta")}</Content>`,
    )
    const parsed = await parseIdml(buffer)
    const strings = await extractIdmlStrings(buffer, async () => parsed)
    expect(strings).toHaveLength(2)

    const exported = await exportIdml(
      buffer,
      strings.map((cell) => ({
        unitId: cell.id,
        locator: idmlLocator(cell),
        metadata: idmlMetadata(cell),
        sourceHtml: cell.originalHtml!,
        // Uppercase only the text between tags, so every protected anchor the
        // export validates is preserved verbatim.
        targetHtml: cell.originalHtml!.replace(/>[^<>]+</g, (match) => match.toUpperCase()),
      })),
      { strict: true },
    )

    // Both parts merge back into the ONE paragraph they were split out of —
    // nothing rejected, nothing lost.
    expect(exported.report).toMatchObject({ translated: 1, rejected: 0, missing: 0 })
    const story = await (await JSZip.loadAsync(exported.bytes)).file(STORY)!.async("string")
    expect(story).toContain("ALPHA")
    expect(story).toContain("BETA")
    expect(story).toContain("<Br/>")
  })

  it("leaves an oversized paragraph with no interior line break whole", async () => {
    const buffer = await makeIdmlStory(
      `<Content>${chunk("alpha")}${chunk("beta")}${chunk("gamma")}</Content>`,
    )
    const parsed = await parseIdml(buffer)
    expect(utf8ByteLength(parsed.units[0]!.sourceText)).toBeGreaterThan(MAX_CELL_TEXT_BYTES)

    // No boundary the engine recognizes ⇒ no guessed split. The cell survives
    // intact and the importer's size guard is what reports it to the user.
    const strings = await extractIdmlStrings(buffer, async () => parsed)
    expect(strings).toHaveLength(1)
    expect(widestFieldBytes(strings[0]!)).toBeGreaterThan(MAX_CELL_TEXT_BYTES)
  })

  it("leaves a paragraph that already fits untouched, breaks or not", async () => {
    const buffer = await makeIdmlStory(
      "<Content>one</Content><Br/><Content>two</Content>",
    )
    const parsed = await parseIdml(buffer)
    const strings = await extractIdmlStrings(buffer, async () => parsed)

    expect(strings).toHaveLength(1)
    expect(strings[0]!.original).toContain("one")
    expect(strings[0]!.original).toContain("two")
  })
})
