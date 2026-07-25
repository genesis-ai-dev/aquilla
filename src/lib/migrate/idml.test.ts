import { describe, expect, it } from "vitest"
import { buildEventProjectionStmts } from "../../../sync-worker/src/events/event-projection"
import type { CodexCell, CodexNotebookFile } from "../codex-editor/types"
import {
  buildIdmlMetadataPatchEvents,
  classifyIdmlPair,
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

describe("IDML migration readiness", () => {
  it("returns only the exact rollout categories", () => {
    expect(classifyIdmlPair({
      source: notebook({ ...legacyCell(), metadata: { id: "plain", type: "text" } }, "plain.codex"),
    }, false)).toBe("not-idml")

    const valid = { source: notebook(legacyCell()), target: notebook(legacyCell()) }
    expect(classifyIdmlPair(valid, false)).toBe("needs-artifact")
    expect(classifyIdmlPair(valid, true)).toBe("native-ready")
    expect(classifyIdmlPair({
      source: notebook({ ...legacyCell(), metadata: { id: "plain", type: "text" } }),
    }, true)).toBe("unsupported-legacy-html")

    const ambiguous = legacyCell()
    delete ambiguous.metadata.paragraphId
    delete ambiguous.metadata.data!.relationships
    delete ambiguous.metadata.data!.idmlStructure!.paragraphId
    expect(classifyIdmlPair({ source: notebook(ambiguous) }, true)).toBe("ambiguous-locator")

    const unsupportedTarget = legacyCell(
      sourceHtml.replace('data-segment-index="0"', 'data-segment-index="9"'),
    )
    expect(classifyIdmlPair({
      source: notebook(legacyCell()),
      target: notebook(unsupportedTarget),
    }, true)).toBe("unsupported-legacy-html")
  })

  it("fails a future IDML major version closed", () => {
    const future = legacyCell()
    future.metadata.idml = { version: 3, slotCount: 1 }
    delete future.metadata.data!.idmlStructure
    expect(classifyIdmlPair({ source: notebook(future) }, true))
      .toBe("unsupported-legacy-html")
  })
})

describe("IDML metadata backfill events", () => {
  it("emits deterministic schema-v2 patches for source metadata and both canonical HTML sides", () => {
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
    const first = buildIdmlMetadataPatchEvents(pair, options)
    const second = buildIdmlMetadataPatchEvents(pair, options)
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
        },
      },
    })
    expect(first.events[0]!.payload.valueHtml).toContain('data-idml-slot="0"')
    expect(first.events[0]!.payload.targetHtml).toContain("Bonjour")
  })

  it("passes the real migration producer event through the worker projector contract", () => {
    const produced = buildIdmlMetadataPatchEvents(
      { source: notebook(legacyCell()), target: notebook(legacyCell()) },
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
})
