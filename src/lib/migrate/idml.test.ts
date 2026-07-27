import { describe, expect, it } from "vitest"
import {
  exportIdml,
  parseIdml,
  type IdmlFormatMetadataV2,
  type IdmlLocator,
  type IdmlTranslation,
} from "@aquilla/idml-roundtrip"
import { buildEventProjectionStmts } from "../../../sync-worker/src/events/event-projection"
import { makeIdml } from "../../../packages/idml-roundtrip/src/test-helpers/idml-fixture"
import type { CodexCell, CodexNotebookFile } from "../codex-editor/types"
import {
  assessIdmlPair,
  buildIdmlMetadataPatchEvents,
} from "./idml"

const sourceBlockXml = [
  '<ParagraphStyleRange Self="p1" AppliedParagraphStyle="ParagraphStyle/Body">',
  '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Bold"><Content>Hello</Content></CharacterStyleRange>',
  "</ParagraphStyleRange>",
].join("")
const sourceHtml = [
  '<p class="indesign-paragraph" data-paragraph-style="ParagraphStyle/Body" data-story-id="u1" data-segment-count="1">',
  '<span class="idml-segment" data-segment-index="0" data-character-style="CharacterStyle/Bold">Hello</span>',
  "</p>",
].join("")

function legacyCell(value = sourceHtml): CodexCell {
  return {
    kind: 2,
    languageId: "html",
    value,
    metadata: {
      id: "c1",
      type: "text",
      storyId: "u1",
      paragraphId: "p1",
      data: {
        idmlStructure: {
          storyId: "u1",
          paragraphId: "p1",
          contentSegments: ["Hello"],
          contentSegmentCount: 1,
          contentSegmentBreakBefore: [false],
          sourceBlockXml,
          paragraphStyleRange: { appliedParagraphStyle: "ParagraphStyle/Body" },
        },
        relationships: { parentStory: "u1", paragraphOrder: 0 },
      },
    },
  }
}

function notebook(cell: CodexCell, originalName = "book.idml"): CodexNotebookFile {
  return { metadata: { id: "f1", originalName }, cells: [cell] }
}

async function originalWithStory(
  blocks = sourceBlockXml,
): Promise<Uint8Array> {
  const storyXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<idPkg:Story xmlns:idPkg="urn:adobe:ns:indesign/idml/1.0/packaging">',
    '<Story Self="u1">',
    blocks,
    "</Story>",
    "</idPkg:Story>",
  ].join("")
  const designmapXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<idPkg:DesignMap xmlns:idPkg="urn:adobe:ns:indesign/idml/1.0/packaging">',
    '<idPkg:Story src="Stories/Story_u1.xml"/>',
    "</idPkg:DesignMap>",
  ].join("")
  return makeIdml({
    "designmap.xml": designmapXml,
    "Stories/Story_u1.xml": storyXml,
    "Stories/Story_u3.xml": null,
    "Stories/Story_u9.xml": null,
    "Resources/TextVariables.xml": null,
  })
}

describe("IDML migration readiness", () => {
  it("returns only the exact rollout categories after parsing original bytes", async () => {
    expect((await assessIdmlPair({
      source: notebook({ ...legacyCell(), metadata: { id: "plain", type: "text" } }, "plain.codex"),
    })).readiness).toBe("not-idml")

    const valid = { source: notebook(legacyCell()), target: notebook(legacyCell()) }
    expect((await assessIdmlPair(valid)).readiness).toBe("needs-artifact")
    expect((await assessIdmlPair(valid, await originalWithStory())).readiness).toBe("native-ready")
    expect((await assessIdmlPair({
      source: notebook({ ...legacyCell(), metadata: { id: "plain", type: "text" } }),
    }, await originalWithStory())).readiness).toBe("unsupported-legacy-html")

    const ambiguous = legacyCell()
    delete ambiguous.metadata.paragraphId
    delete ambiguous.metadata.data!.relationships
    delete ambiguous.metadata.data!.idmlStructure!.paragraphId
    expect((await assessIdmlPair(
      { source: notebook(ambiguous) },
      await originalWithStory(),
    )).readiness).toBe("ambiguous-locator")

    const unsupportedTarget = legacyCell(
      sourceHtml.replace('data-segment-index="0"', 'data-segment-index="9"'),
    )
    expect((await assessIdmlPair(
      {
        source: notebook(legacyCell()),
        target: notebook(unsupportedTarget),
      },
      await originalWithStory(),
    )).readiness).toBe("unsupported-legacy-html")
  })

  it("rejects stale and ambiguous parsed-original locators", async () => {
    const staleBlock = sourceBlockXml.replace('Self="p1"', 'Self="p2"')
    const stale = await assessIdmlPair(
      { source: notebook(legacyCell()) },
      await originalWithStory(staleBlock),
    )
    expect(stale.readiness).toBe("ambiguous-locator")
    expect(stale.diagnostics).toContainEqual(expect.objectContaining({ code: "LOCATOR_STALE" }))

    const duplicate = await assessIdmlPair(
      { source: notebook(legacyCell()) },
      await originalWithStory(sourceBlockXml + sourceBlockXml),
    )
    expect(duplicate.readiness).toBe("ambiguous-locator")
    expect(duplicate.diagnostics).toContainEqual(
      expect.objectContaining({ code: "LOCATOR_DUPLICATED" }),
    )
  })

  it("does not claim native readiness when parsed literal units are absent or opaque", async () => {
    const extraLiteral = sourceBlockXml + sourceBlockXml
      .replace('Self="p1"', 'Self="p2"')
      .replace("<Content>Hello</Content>", "<Content>Unmigrated</Content>")
    const incomplete = await assessIdmlPair(
      { source: notebook(legacyCell()) },
      await originalWithStory(extraLiteral),
    )
    expect(incomplete.readiness).toBe("unsupported-legacy-html")
    expect(incomplete.diagnostics).toContainEqual(expect.objectContaining({
      code: "ANCHOR_MISSING",
      message: expect.stringContaining("absent from the legacy notebook"),
    }))

    const opaqueLiteral = [
      sourceBlockXml,
      '<Mystery><ParagraphStyleRange Self="p2">',
      '<CharacterStyleRange><Content>Hidden future text</Content></CharacterStyleRange>',
      "</ParagraphStyleRange></Mystery>",
    ].join("")
    const opaque = await assessIdmlPair(
      { source: notebook(legacyCell()) },
      await originalWithStory(opaqueLiteral),
    )
    expect(opaque.readiness).toBe("unsupported-legacy-html")
    expect(opaque.diagnostics).toContainEqual(expect.objectContaining({
      code: "UNSUPPORTED_CONSTRUCT",
      details: expect.objectContaining({ unsupportedDisposition: "unsupported-literal" }),
    }))
  })

  it("fails a future IDML major version closed", async () => {
    const future = legacyCell()
    future.metadata.idml = { version: 3, slotCount: 1 }
    delete future.metadata.data!.idmlStructure
    expect((await assessIdmlPair(
      { source: notebook(future) },
      await originalWithStory(),
    )).readiness).toBe("unsupported-legacy-html")
  })
})

describe("IDML metadata backfill events", () => {
  it("emits deterministic schema-v2 patches only from parsed-original proof", async () => {
    const target = legacyCell(sourceHtml.replace(">Hello</span>", ">Bonjour</span>"))
    const milestone: CodexCell = {
      kind: 2,
      languageId: "html",
      value: "<p>Chapter 1</p>",
      metadata: { id: "milestone", type: "milestone" },
    }
    const pair = {
      source: { ...notebook(legacyCell()), cells: [milestone, legacyCell()] },
      target: { ...notebook(target), cells: [milestone, target] },
    }
    const options = {
      projectId: "project-1",
      fileId: "file-1",
      author: "legacy-import",
      clientTs: 0,
    }
    const missing = await assessIdmlPair(pair)
    expect(buildIdmlMetadataPatchEvents(pair, missing, options)).toEqual({
      events: [],
      readiness: "needs-artifact",
    })
    const assessment = await assessIdmlPair(pair, await originalWithStory())
    const first = buildIdmlMetadataPatchEvents(pair, assessment, options)
    const second = buildIdmlMetadataPatchEvents(pair, assessment, options)
    expect(first).toEqual(second)
    expect(first.readiness).toBe("native-ready")
    expect(first.events).toHaveLength(1)
    expect(first.events[0]).toMatchObject({
      schemaVersion: 2,
      kind: "source.cell.metadata.patch",
      fileId: "file-1",
      cellId: "c1",
      payload: {
        version: 1,
        metadata: {
          idml: { version: 2, slotCount: 1 },
          aquillaImport: {
            profileId: "builtin:idml-roundtrip",
            profileVersion: "2",
          },
          idmlMigration: {
            readiness: "native-ready",
            sourceSha256: assessment.sourceSha256,
          },
        },
      },
    })
    expect(first.events[0]!.payload.valueHtml).toContain('data-idml-slot="0"')
    expect(first.events[0]!.payload.targetHtml).toContain("Bonjour")
  })

  it("passes the real migration producer event through the worker projector contract", async () => {
    const pair = { source: notebook(legacyCell()), target: notebook(legacyCell()) }
    const assessment = await assessIdmlPair(pair, await originalWithStory())
    const produced = buildIdmlMetadataPatchEvents(
      pair,
      assessment,
      {
        projectId: "project-1",
        fileId: "file-1",
        author: "legacy-import",
        clientTs: 0,
      },
    ).events[0]!
    const recorded: Array<{ sql: string; args: unknown[] }> = []
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            recorded.push({ sql, args })
            return { sql, args }
          },
        }
      },
    }
    const statements: unknown[] = []
    buildEventProjectionStmts(
      db as unknown as Parameters<typeof buildEventProjectionStmts>[0],
      {
        ...produced,
        projectId: "project-1",
        serverTs: 1,
        serverSeq: 1,
        targetLang: null,
      } as never,
      statements as Parameters<typeof buildEventProjectionStmts>[2],
    )
    expect(statements).toHaveLength(2)
    expect(recorded[0]!.args[0]).toContain('"version":2')
    expect(recorded[0]!.args[1]).toContain('data-idml-slot="0"')
    expect(recorded[1]!.args[0]).toContain('data-idml-slot="0"')
  })

  it("exports migrated Codex metadata identically to direct web import metadata", async () => {
    const original = await originalWithStory()
    const direct = await parseIdml(original)
    expect(direct.units).toHaveLength(1)
    const directUnit = direct.units[0]!
    const directTargetHtml = directUnit.sourceHtml.replace(">Hello<", ">Bonjour<")
    const directTranslation: IdmlTranslation = {
      unitId: directUnit.id,
      locator: directUnit.locator,
      metadata: directUnit.metadata,
      sourceHtml: directUnit.sourceHtml,
      targetHtml: directTargetHtml,
    }

    const target = legacyCell(sourceHtml.replace(">Hello</span>", ">Bonjour</span>"))
    const pair = { source: notebook(legacyCell()), target: notebook(target) }
    const assessment = await assessIdmlPair(pair, original)
    const produced = buildIdmlMetadataPatchEvents(
      pair,
      assessment,
      {
        projectId: "project-1",
        fileId: "file-1",
        author: "legacy-import",
        clientTs: 0,
      },
    )
    expect(produced.readiness).toBe("native-ready")
    const patch = produced.events[0]!
    const payload = patch.payload as {
      metadata: {
        idml: IdmlFormatMetadataV2
        aquillaImport: { sourceLocator: IdmlLocator }
      }
      valueHtml: string
      targetHtml: string
    }
    const migratedTranslation: IdmlTranslation = {
      unitId: directUnit.id,
      locator: payload.metadata.aquillaImport.sourceLocator,
      metadata: payload.metadata.idml,
      sourceHtml: payload.valueHtml,
      targetHtml: payload.targetHtml,
    }

    const directExport = await exportIdml(original, [directTranslation], { strict: true })
    const migratedExport = await exportIdml(original, [migratedTranslation], { strict: true })
    expect(migratedExport.report).toEqual(directExport.report)
    expect(migratedExport.bytes).toEqual(directExport.bytes)
    expect((await parseIdml(migratedExport.bytes)).units[0]!.sourceText).toBe("Bonjour")
  })
})
