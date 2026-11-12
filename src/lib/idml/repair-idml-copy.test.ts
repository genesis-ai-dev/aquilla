import JSZip from "jszip"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { parseIdml, validateIdmlTranslation, type IdmlTranslationUnit } from "@aquilla/idml-roundtrip"
import type { TranslatableString } from "@/lib/parsers/core-types"
import type { CellRow } from "@/lib/sync/cells-read-types"
import {
  applyIdmlRepairTranslations,
  chooseIdmlRepairParse,
  repairIdmlFileAsCopy,
  repairedCopyName,
  type IdmlRepairParseCandidate,
  type IdmlRepairSourceCell,
} from "./repair-idml-copy"

vi.mock("@/lib/parsers/idml", () => ({ extractIdmlStrings: vi.fn() }))
vi.mock("@/lib/import", () => ({ emitParsedFile: vi.fn() }))
vi.mock("@/lib/sync/source-export", () => ({ fetchRawOriginalSource: vi.fn() }))
vi.mock("@/lib/sync/cells-read", () => ({ fetchFileCells: vi.fn() }))
vi.mock("@/lib/partners/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/partners/registry")>()
  return { ...actual, partnerIntegrations: vi.fn(() => []) }
})
vi.mock("./align-reimported-targets", () => ({ alignReimportedIdmlFile: vi.fn() }))

import { extractIdmlStrings } from "@/lib/parsers/idml"
import { emitParsedFile } from "@/lib/import"
import { fetchRawOriginalSource } from "@/lib/sync/source-export"
import { fetchFileCells } from "@/lib/sync/cells-read"
import { partnerIntegrations } from "@/lib/partners/registry"
import { alignReimportedIdmlFile } from "./align-reimported-targets"

describe("IDML repair copy", () => {
  beforeEach(() => {
    vi.mocked(partnerIntegrations).mockReturnValue([])
  })

  it("copies a translation onto the matching source line and drops the empty protected target", () => {
    const plan = applyIdmlRepairTranslations(
      [unit("0", "Hello world"), unit("1", "Amen")],
      [source("a", "Hello world", "Olá mundo"), source("b", "Amen", "")],
    )

    expect(plan.copied).toBe(1)
    expect(plan.unmatched).toBe(0)
    expect(plan.strings[0]?.translated).toBe("Olá mundo")
    expect(plan.strings[0]?.translatedHtml).toBeUndefined()
    expect(plan.strings[1]?.translatedHtml).toBe("<p data-idml-version=\"2\"></p>")
  })

  it("keeps repeated lines with their own translations by neighbor context", () => {
    const plan = applyIdmlRepairTranslations(
      [unit("0", "Hello"), unit("1", "Hello")],
      [
        source("a", "Hello", "One", null),
        source("b", "Hello", "Two", "a"),
      ],
    )

    expect(plan.strings.map((string) => string.translated)).toEqual(["One", "Two"])
    expect(plan.copied).toBe(2)
  })

  it("keeps bold and italic by placing the old style segments into the new slots", async () => {
    const unit = await styledUnit([
      ["CharacterStyle/Plain", "Hello "],
      ["CharacterStyle/Bold", "WORLD"],
    ])
    const plan = applyIdmlRepairTranslations(
      [parsedString(unit)],
      [source(
        "a",
        unit.sourceText,
        "Olá MUNDO",
        null,
        legacySegments([
          ["CharacterStyle/Plain", "Olá "],
          ["CharacterStyle/Bold", "MUNDO"],
        ]),
      )],
    )

    const html = plan.strings[0]?.translatedHtml ?? ""
    const checked = validateIdmlTranslation(unit.sourceHtml, html, unit.metadata)
    expect(checked.valid).toBe(true)
    expect(checked.slots[0]).toBe("Olá ")
    expect(checked.slots[1]).toBe("MUNDO")
  })

  it("keeps a dot and space that match the English source when later text is translated", async () => {
    const unit = await styledUnit([
      ["CharacterStyle/Bold", "Kingdom"],
      ["CharacterStyle/Plain", ". "],
      ["CharacterStyle/Bold", "New creation"],
    ])
    const translation = "Reino. Nova criação"
    const plan = applyIdmlRepairTranslations(
      [parsedString(unit, { biblica: { contentType: "notes" } })],
      [source(
        "a",
        unit.sourceText,
        translation,
        null,
        legacySegments([
          ["CharacterStyle/Bold", "Reino"],
          ["CharacterStyle/Plain", ". "],
          ["CharacterStyle/Bold", "Nova criação"],
        ]),
      )],
    )

    expect(plan.strings[0]?.translated).toBe(translation)
    const html = plan.strings[0]?.translatedHtml ?? ""
    const checked = validateIdmlTranslation(unit.sourceHtml, html, unit.metadata)
    expect(checked.valid).toBe(true)
    expect(checked.slots[0]).toBe("Reino")
    expect(checked.slots[1]).toBe(". ")
    expect(checked.slots[2]).toBe("Nova criação")
  })

  it("leaves English apostrophe glue empty when the old cell had no segment for it", async () => {
    const unit = await styledUnit([
      ["CharacterStyle/Plain", "Israel"],
      ["CharacterStyle/source serif", "\u02BC"],
      ["CharacterStyle/Plain", "s covenant history"],
    ])
    const plan = applyIdmlRepairTranslations(
      [parsedString(unit)],
      [source(
        "a",
        unit.sourceText,
        "A história da aliança de Israel",
        null,
        legacySegments([
          ["CharacterStyle/Plain", "A história da aliança de Israel"],
        ]),
      )],
    )

    const html = plan.strings[0]?.translatedHtml ?? ""
    const checked = validateIdmlTranslation(unit.sourceHtml, html, unit.metadata)
    expect(checked.valid).toBe(true)
    expect(checked.slots[0]).toBe("A história da aliança de Israel")
    expect(checked.slots[1]).toBe("")
    expect(checked.slots[2]).toBe("")
  })

  it("matches a heading whose apostrophe differs only by character", () => {
    const plan = applyIdmlRepairTranslations(
      [unit("0", "Israel's covenant history")],
      [source("a", "Israel\u02BCs covenant history", "História da aliança")],
    )

    expect(plan.copied).toBe(1)
    expect(plan.strings[0]?.original).toBe("Israel's covenant history")
    expect(plan.strings[0]?.translated).toBe("História da aliança")
  })

  it("copies a translation when the stored source dropped an apostrophe", () => {
    const plan = applyIdmlRepairTranslations(
      [unit("0", "The Lord\u02BCs army was a spiritual being")],
      [source("a", "The Lords army was a spiritual being", "O comandante do exército do Senhor")],
    )

    expect(plan.copied).toBe(1)
    expect(plan.unmatched).toBe(0)
    expect(plan.strings[0]?.original).toBe("The Lord\u02BCs army was a spiritual being")
    expect(plan.strings[0]?.translated).toBe("O comandante do exército do Senhor")
  })

  it("keeps each copy when every repeat dropped the same apostrophe", () => {
    const plan = applyIdmlRepairTranslations(
      [unit("0", "The Lord\u02BCs army"), unit("1", "The Lord\u02BCs army")],
      [
        source("a", "The Lords army", "Primeira", null),
        source("b", "The Lords army", "Segunda", "a"),
      ],
    )

    expect(plan.strings.map((string) => string.translated)).toEqual(["Primeira", "Segunda"])
  })

  it("does not guess which line a dropped apostrophe belongs to", () => {
    const plan = applyIdmlRepairTranslations(
      [unit("0", "The Lord\u02BCs army")],
      [
        source("a", "The Lords army", "Primeira", null),
        source("b", "The Lords army", "Segunda", "a"),
      ],
    )

    expect(plan.copied).toBe(0)
    expect(plan.strings[0]?.translated).toBe("")
    expect(plan.unmatched).toBe(2)
  })

  it("keeps the read that matches the file when the plain parse merges those cells", () => {
    const existing = [
      source("a", "The books", "Livros", null),
      source("b", "The stories", "Histórias", "a"),
    ]
    const chosen = chooseIdmlRepairParse(existing, [
      parseCandidate("generic", ["The booksThe stories"], "builtin:idml-roundtrip", "2"),
      parseCandidate("biblica:study-notes", ["The books", "The stories"], "builtin:biblica-study-notes", "1"),
    ])

    expect(chosen.id).toBe("biblica:study-notes")
  })

  it("stamps the partner read when it matches every cell the plain parse also matches", () => {
    const chosen = chooseIdmlRepairParse(
      [source("a", "Hello", "Olá")],
      [
        parseCandidate("generic", ["Hello"], "builtin:idml-roundtrip", "2"),
        parseCandidate("biblica:study-notes", ["Hello"], "builtin:biblica-study-notes", "1"),
        parseCandidate("biblica:ebl", ["Hello"], "builtin:biblica-ebl", "1"),
      ],
    )

    expect(chosen.id).toBe("biblica:study-notes")
  })

  it("keeps the plain IDML parse when its cells already match the file", () => {
    const chosen = chooseIdmlRepairParse(
      [source("a", "Hello", "Olá")],
      [
        parseCandidate("generic", ["Hello"], "builtin:idml-roundtrip", "2"),
        parseCandidate("biblica:study-notes", ["Hello", "In the beginning"], "builtin:biblica-study-notes", "1"),
      ],
    )

    expect(chosen.id).toBe("generic")
  })

  it("leaves an unmatched translation on the count, not on a different paragraph", () => {
    const plan = applyIdmlRepairTranslations(
      [unit("0", "Hello")],
      [source("a", "Hello", "Olá"), source("b", "Gone", "Foi")],
    )

    expect(plan.strings[0]?.translated).toBe("Olá")
    expect(plan.unmatched).toBe(1)
  })

  it("names the copy so it does not collide with the original or an earlier repair", () => {
    expect(repairedCopyName("Gênesis", ["Gênesis"])).toBe("Gênesis (repaired)")
    expect(repairedCopyName("Gênesis", ["Gênesis", "Gênesis (repaired)"]))
      .toBe("Gênesis (repaired 2)")
  })

  it("imports a new file and aligns that copy, never the original", async () => {
    vi.mocked(fetchRawOriginalSource).mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      rawOriginal: false,
    })
    vi.mocked(extractIdmlStrings).mockResolvedValue([unit("0", "Hello")])
    vi.mocked(fetchFileCells).mockResolvedValue({
      cells: [
        row("source", "a", "Hello", null),
        row("target", "a", "Olá", "<p>Olá</p>"),
      ],
      nextCursor: null,
      total: 2,
    })
    vi.mocked(emitParsedFile).mockImplementation(async (result) => ({
      ref: {
        id: "copy-id",
        name: result.name,
        type: "idml",
        createdAt: "2026-10-14T00:00:00.000Z",
        cellCount: result.strings.length,
        orderedBy: "sequence",
      },
      speakerPairs: [],
    }))
    vi.mocked(alignReimportedIdmlFile).mockResolvedValue({
      aligned: [],
      unchanged: 0,
      failed: 0,
      skipped: 0,
      manual: [],
    })

    const result = await repairIdmlFileAsCopy({
      projectId: "project",
      fileId: "original-id",
      fileName: "Gênesis",
      existingNames: ["Gênesis"],
      author: "dev",
      getToken: async () => "token",
      align: {
        ask: async () => "",
        author: "model",
        model: "model",
        provider: "frontier",
        flush: async () => undefined,
      },
    })

    expect(result.ref.id).toBe("copy-id")
    expect(result.ref.name).toBe("Gênesis (repaired)")
    expect(result.copied).toBe(1)
    const imported = vi.mocked(emitParsedFile).mock.calls[0]?.[0]
    expect(imported?.name).toBe("Gênesis (repaired)")
    expect(imported?.strings[0]?.translated).toBe("Olá")
    expect(imported?.strings[0]?.translatedHtml).toBeUndefined()
    expect(vi.mocked(emitParsedFile).mock.calls[0]?.[2]).not.toHaveProperty("reimportFileIds")
    expect(vi.mocked(alignReimportedIdmlFile).mock.calls.map((call) => call[0]?.fileId)).toEqual(["copy-id"])
    expect(vi.mocked(emitParsedFile).mock.calls[0]?.[3]).toMatchObject({
      profileId: "builtin:idml-roundtrip",
    })
  })

  it("copies translations onto the partner read when that is the file's cell pattern", async () => {
    vi.mocked(fetchRawOriginalSource).mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      rawOriginal: false,
    })
    vi.mocked(extractIdmlStrings).mockResolvedValue([unit("0", "The booksThe stories")])
    vi.mocked(partnerIntegrations).mockReturnValue([{
      id: "biblica",
      idmlImportEditions: async () => [{
        id: "biblica:study-notes",
        profileId: "builtin:biblica-study-notes",
        corpusMarker: "Biblica Study Notes",
        emptyImportMessage: () => "",
        parse: async () => ({
          strings: [unit("0", "The books"), unit("1", "The stories")],
          bookCodes: ["GEN"],
          skippedScriptureCount: 4,
          frontBackMatter: false,
        }),
      }],
    }])
    vi.mocked(fetchFileCells).mockResolvedValue({
      cells: [
        row("source", "a", "The books", null),
        row("target", "a", "Livros", "<p>Livros</p>"),
        row("source", "b", "The stories", null, "a"),
        row("target", "b", "Histórias", "<p>Histórias</p>"),
      ],
      nextCursor: null,
      total: 4,
    })
    vi.mocked(emitParsedFile).mockImplementation(async (result) => ({
      ref: {
        id: "copy-id",
        name: result.name,
        type: "idml",
        createdAt: "2026-10-14T00:00:00.000Z",
        cellCount: result.strings.length,
        orderedBy: "sequence",
      },
      speakerPairs: [],
    }))
    vi.mocked(alignReimportedIdmlFile).mockResolvedValue({
      aligned: [],
      unchanged: 0,
      failed: 0,
      skipped: 0,
      manual: [],
    })

    const result = await repairIdmlFileAsCopy({
      projectId: "project",
      fileId: "original-id",
      fileName: "Gênesis",
      author: "dev",
      getToken: async () => "token",
    })

    expect(result.copied).toBe(2)
    expect(result.unmatched).toBe(0)
    const imported = vi.mocked(emitParsedFile).mock.calls.at(-1)?.[0]
    expect(imported?.strings.map((string) => string.original)).toEqual(["The books", "The stories"])
    expect(imported?.strings.map((string) => string.translated)).toEqual(["Livros", "Histórias"])
    expect(imported?.corpusMarker).toBe("Biblica Study Notes")
    expect(imported?.bookCode).toBe("GEN")
    expect(vi.mocked(emitParsedFile).mock.calls.at(-1)?.[3]).toMatchObject({
      profileId: "builtin:biblica-study-notes",
      profileVersion: "1",
    })
  })
})

function unit(id: string, original: string): TranslatableString {
  return {
    id,
    original,
    translated: "",
    translatedHtml: "<p data-idml-version=\"2\"></p>",
    context: "",
    group: id,
    type: "text",
  }
}

function source(
  cellId: string,
  value: string,
  translated: string,
  anchorCellId: string | null = null,
  translatedHtml: string | null = null,
): IdmlRepairSourceCell {
  return { cellId, anchorCellId, value, translated, translatedHtml }
}

const IDML_MIME = "application/vnd.adobe.indesign-idml-package"
const IDPKG = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"'

function legacySegments(runs: readonly (readonly [string, string])[]): string {
  const spans = runs.map(([style, text], index) =>
    `<span class="idml-segment" data-segment-index="${index}" data-character-style="${style}">${text}</span>`,
  ).join("")
  return `<p class="indesign-paragraph">${spans}</p>`
}

function parsedString(
  unit: IdmlTranslationUnit,
  metadata?: Record<string, unknown>,
): TranslatableString {
  return {
    id: unit.id,
    original: unit.sourceText,
    originalHtml: unit.sourceHtml,
    translated: "",
    translatedHtml: "<p data-idml-version=\"2\"></p>",
    context: "",
    group: unit.id,
    type: "text",
    metadata: {
      idml: unit.metadata as unknown as Record<string, unknown>,
      ...metadata,
    },
  }
}

async function styledUnit(runs: readonly (readonly [string, string])[]): Promise<IdmlTranslationUnit> {
  const storyPath = "Stories/Story_u100.xml"
  const ranges = runs.map(([style, text]) =>
    `<CharacterStyleRange AppliedCharacterStyle="${style}"><Content>${text}</Content></CharacterStyleRange>`,
  ).join("")
  const zip = new JSZip()
  zip.file("mimetype", IDML_MIME, { compression: "STORE", createFolders: false })
  zip.file(
    "designmap.xml",
    `<?xml version="1.0"?><Document ${IDPKG}><idPkg:Story src="${storyPath}"/></Document>`,
    { compression: "DEFLATE", createFolders: false },
  )
  zip.file(
    storyPath,
    `<?xml version="1.0"?><idPkg:Story ${IDPKG}><Story Self="u100"><ParagraphStyleRange Self="mixed" AppliedParagraphStyle="ParagraphStyle/Body">${ranges}</ParagraphStyleRange></Story></idPkg:Story>`,
    { compression: "DEFLATE", createFolders: false },
  )
  const parsed = await parseIdml(await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" }))
  const unit = parsed.units[0]
  if (!unit) throw new Error("Missing styled IDML fixture unit")
  return unit
}

function parseCandidate(
  id: string,
  originals: readonly string[],
  profileId: string,
  profileVersion: string,
): IdmlRepairParseCandidate {
  return {
    id,
    strings: originals.map((original, index) => unit(String(index), original)),
    profileId,
    profileVersion,
  }
}

function row(
  side: "source" | "target",
  cellId: string,
  value: string,
  valueHtml: string | null,
  anchorCellId: string | null = null,
): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml,
    type: "text",
    canonicalRef: null,
    anchorCellId,
    eventId: `${side}-event`,
    sourceEventId: null,
    lastEditor: null,
    lastEditAt: 0,
    validated: false,
    wordCount: 1,
  }
}
