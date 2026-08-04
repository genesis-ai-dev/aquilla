import { describe, it, expect } from "vitest"
import { makeIdml } from "../../../packages/idml-roundtrip/src/test-helpers/idml-fixture"
import type { CodexNotebookFile } from "../codex-editor/types"
import { assessIdmlPair } from "./idml"
import { mapFilePairToEvents, collectSpeakers, type FilePairInput, type MapOptions } from "./map"
import { fileIdFor, sourceCellCreateEventId, targetCommitEventId } from "./ids"

const OPTS: MapOptions = {
  projectId: "proj-1",
  projectKey: "legacykey",
  sourceLanguage: "eng",
  targetLanguage: "bod",
  fallbackAuthor: "migrate",
  fallbackTs: 1000,
}

// One subtitle cell (source + 2 value-edits = translation history) and one
// milestone (target-only, structural, no edits).
function fixture(): FilePairInput {
  const source: CodexNotebookFile = {
    metadata: { id: "f", originalName: "f" },
    cells: [
      { kind: 2, languageId: "html", value: "<p>Hello</p>", metadata: { id: "cue1", type: "text" } },
    ],
  }
  const target: CodexNotebookFile = {
    metadata: { id: "f", originalName: "f" },
    cells: [
      { kind: 2, languageId: "html", value: "1", metadata: { id: "ms1", type: "milestone" } },
      {
        kind: 2,
        languageId: "html",
        value: "<p>བཀྲ་ཤིས།</p>",
        metadata: {
          id: "cue1",
          type: "text",
          edits: [
            { author: "wendilord", timestamp: 200, type: "user-edit", editMap: ["value"], value: "<p>draft</p>" },
            { author: "wendilord", timestamp: 100, type: "user-edit", editMap: ["metadata", "cellLabel"], value: "1:1" },
            {
              author: "randall",
              timestamp: 300,
              type: "user-edit",
              editMap: ["value"],
              value: "<p>བཀྲ་ཤིས།</p>",
              validatedBy: [
                { username: "reviewer1", creationTimestamp: 350, updatedTimestamp: 350, isDeleted: false },
                { username: "gone", creationTimestamp: 360, updatedTimestamp: 360, isDeleted: true },
              ],
            },
          ],
        },
      },
    ],
  }
  return { relPath: "TheChosen_101", name: "TheChosen_101", source, target }
}

describe("mapFilePairToEvents", () => {
  it("migrates legacy Codex IDML as the canonical v2 file/cell/HTML contract", async () => {
    const sourceBlockXml = [
      '<ParagraphStyleRange Self="p1" AppliedParagraphStyle="ParagraphStyle/Body">',
      '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Bold"><Content>Hello</Content></CharacterStyleRange>',
      "</ParagraphStyleRange>",
    ].join("")
    const legacyHtml = [
      '<p class="indesign-paragraph" data-paragraph-style="ParagraphStyle/Body" data-story-id="u1" data-segment-count="1">',
      '<span class="idml-segment" data-segment-index="0" data-character-style="CharacterStyle/Bold">Hello</span>',
      "</p>",
    ].join("")
    const targetHtml = legacyHtml.replace(">Hello</span>", ">Bonjour</span>")
    const metadata = {
      id: "idml-cell",
      type: "text" as const,
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
        relationships: { parentStory: "u1", storyOrder: 0, paragraphOrder: 0 },
      },
    }
    const pair: FilePairInput = {
      relPath: "brochure",
      name: "brochure",
      source: {
        metadata: { id: "f", originalName: "brochure.idml" },
        cells: [{ kind: 2, languageId: "html", value: legacyHtml, metadata }],
      },
      target: {
        metadata: { id: "f", originalName: "brochure.idml" },
        cells: [{
          kind: 2,
          languageId: "html",
          value: targetHtml,
          metadata: {
            ...metadata,
            edits: [{
              author: "translator",
              timestamp: 123,
              type: "user-edit",
              editMap: ["value"],
              value: targetHtml,
            }],
          },
        }],
      },
    }

    const original = await makeIdml({
      "designmap.xml": [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<idPkg:DesignMap xmlns:idPkg="urn:adobe:ns:indesign/idml/1.0/packaging">',
        '<idPkg:Story src="Stories/Story_u1.xml"/>',
        "</idPkg:DesignMap>",
      ].join(""),
      "Stories/Story_u1.xml": [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<idPkg:Story xmlns:idPkg="urn:adobe:ns:indesign/idml/1.0/packaging">',
        '<Story Self="u1">',
        sourceBlockXml,
        "</Story>",
        "</idPkg:Story>",
      ].join(""),
      "Stories/Story_u3.xml": null,
      "Stories/Story_u9.xml": null,
      "Resources/TextVariables.xml": null,
    })
    const assessment = await assessIdmlPair(pair, original)
    expect(assessment.readiness).toBe("native-ready")
    const events = mapFilePairToEvents(pair, {
      ...OPTS,
      idmlAssessment: assessment,
    })
    const file = events.find((event) => event.kind === "file.create")!
    expect(file.payload).toMatchObject({
      fileType: "idml",
      kind: "idml",
      importFormat: "idml",
      parserVersion: "builtin:idml-roundtrip@2",
      importManifest: { profileVersion: "2", fidelity: "content-only" },
    })

    const source = events.find((event) => event.kind === "source.cell.create")!
    expect(source.payload.valueHtml).toContain('data-idml-version="2"')
    expect(source.payload.metadata).toMatchObject({
      idml: { version: 2, slotCount: 1 },
      aquillaImport: {
        profileId: "builtin:idml-roundtrip",
        profileVersion: "2",
        sourceLocator: {
          kind: "idml",
          memberPath: "Stories/Story_u1.xml",
          elementId: "p1",
        },
      },
      legacyCodex: { idmlStructure: { storyId: "u1", paragraphId: "p1" } },
    })

    const target = events.find((event) => event.kind === "target.cell.commit")!
    expect(target.payload.valueHtml).toContain('data-idml-slot="0"')
    expect(target.payload.valueHtml).toContain("Bonjour")
    expect(target.payload.valueHtml).not.toContain("idml-segment")

    const sourceOnlyPair = structuredClone(pair)
    sourceOnlyPair.target!.cells = []
    const sourceOnlyAssessment = await assessIdmlPair(sourceOnlyPair, original)
    expect(sourceOnlyAssessment.readiness).toBe("native-ready")
    const sourceOnlyEvents = mapFilePairToEvents(sourceOnlyPair, {
      ...OPTS,
      idmlAssessment: sourceOnlyAssessment,
    })
    expect(sourceOnlyEvents.filter((event) => event.kind === "source.cell.create")).toHaveLength(1)
    expect(sourceOnlyEvents.find((event) => event.kind === "source.cell.create")!.payload.valueHtml)
      .toContain('data-idml-version="2"')

    const invalidPair = structuredClone(pair)
    const invalidTarget = invalidPair.target!.cells[0]!
    invalidTarget.value = targetHtml.replace('data-segment-index="0"', 'data-segment-index="9"')
    invalidTarget.metadata.edits![0]!.value = invalidTarget.value
    const invalidAssessment = await assessIdmlPair(invalidPair, original)
    expect(invalidAssessment.readiness).toBe("unsupported-legacy-html")
    const invalidEvents = mapFilePairToEvents(invalidPair, {
      ...OPTS,
      idmlAssessment: invalidAssessment,
    })
    expect(invalidEvents.find((event) => event.kind === "file.create")!.payload)
      .toMatchObject({
        importManifest: {
          warningCounts: { "unsupported-legacy-html": 1 },
        },
      })
    expect(invalidEvents.find((event) => event.kind === "source.cell.create")!.payload.metadata)
      .toMatchObject({
        idmlMigration: { readiness: "unsupported-legacy-html" },
      })
    expect(invalidEvents.find((event) => event.kind === "target.cell.commit")!.payload.valueHtml)
      .toContain('data-segment-index="9"')
  })

  it("emits file.create + per-cell source.create + per-value-edit target.commit", () => {
    const ev = mapFilePairToEvents(fixture(), OPTS)
    const kinds = ev.map((e) => e.kind)
    expect(kinds.filter((k) => k === "file.create")).toHaveLength(1)
    expect(kinds.filter((k) => k === "source.cell.create")).toHaveLength(2) // ms1 + cue1
    // cue1 has 2 value-edits; the cellLabel edit is ignored; milestone gets none.
    expect(kinds.filter((k) => k === "target.cell.commit")).toHaveLength(2)
  })

  it("preserves original author + legacy timestamp per edit", () => {
    const ev = mapFilePairToEvents(fixture(), OPTS)
    const commits = ev.filter((e) => e.kind === "target.cell.commit")
    expect(commits.map((c) => ({ a: c.author, t: c.clientTs }))).toEqual([
      { a: "wendilord", t: 200 },
      { a: "randall", t: 300 },
    ])
  })

  it("chains the target history: first parent = source create, then prior commit; sourceEventId pins all", () => {
    const ev = mapFilePairToEvents(fixture(), OPTS)
    const fileId = fileIdFor(OPTS.projectKey, "TheChosen_101")
    const srcId = sourceCellCreateEventId(OPTS.projectId, fileId, "cue1")
    const c0 = targetCommitEventId(OPTS.projectId, fileId, "cue1", 0)
    const c2 = targetCommitEventId(OPTS.projectId, fileId, "cue1", 2)
    const commits = ev.filter((e) => e.cellId === "cue1" && e.kind === "target.cell.commit")
    expect(commits[0].id).toBe(c0)
    expect(commits[0].parentId).toBe(srcId)
    expect(commits[1].id).toBe(c2)
    expect(commits[1].parentId).toBe(c0)
    for (const c of commits) expect(c.payload.sourceEventId).toBe(srcId)
  })

  it("strips HTML into value and keeps the rich html in valueHtml", () => {
    const ev = mapFilePairToEvents(fixture(), OPTS)
    const lastCommit = ev.filter((e) => e.kind === "target.cell.commit").at(-1)!
    expect(lastCommit.payload.value).toBe("བཀྲ་ཤིས།")
    expect(lastCommit.payload.valueHtml).toBe("<p>བཀྲ་ཤིས།</p>")
  })

  it("decodes HTML entities into the plain-text value, keeps rich html raw (AQU-674)", () => {
    // Reproduces the Codex→Aquilla data shape that surfaced literal `&nbsp;`
    // in migrated Arabic (Algerian) target text: the HTML carries entities
    // that must NOT survive as literal ASCII in the tags-stripped `value`.
    const input = fixture()
    input.target!.cells[1].metadata.edits![2].value = "<p>فِي&nbsp;ٱلْبَدْءِ&nbsp;&amp;خَلَقَ</p>"
    const ev = mapFilePairToEvents(input, OPTS)
    const lastCommit = ev.filter((e) => e.kind === "target.cell.commit").at(-1)!
    // Plain value is entity-free (spaces separate the words, & is decoded once).
    expect(lastCommit.payload.value).toBe("فِي ٱلْبَدْءِ &خَلَقَ")
    expect(lastCommit.payload.value).not.toMatch(/&[a-z]+;/i)
    // The rich html retains the original entities for HTML rendering.
    expect(lastCommit.payload.valueHtml).toBe("<p>فِي&nbsp;ٱلْبَدْءِ&nbsp;&amp;خَلَقَ</p>")
  })

  it("is idempotent: identical input → byte-identical event stream", () => {
    expect(mapFilePairToEvents(fixture(), OPTS)).toEqual(mapFilePairToEvents(fixture(), OPTS))
  })

  it("emits cell.validate only for non-deleted validators on the head commit", () => {
    const ev = mapFilePairToEvents(fixture(), OPTS)
    const validates = ev.filter((e) => e.kind === "cell.validate")
    expect(validates).toHaveLength(1) // reviewer1; 'gone' is soft-deleted
    const fileId = fileIdFor(OPTS.projectKey, "TheChosen_101")
    const head = targetCommitEventId(OPTS.projectId, fileId, "cue1", 2)
    expect(validates[0].author).toBe("reviewer1")
    expect(validates[0].payload).toMatchObject({ editEventId: head })
  })

  it("emits startMs/endMs from legacy timecodes (seconds→ms), keeping cellLabel OUT of canonicalRef", () => {
    const pair: FilePairInput = {
      relPath: "F",
      name: "F",
      target: {
        metadata: { id: "f", originalName: "f" },
        cells: [
          {
            kind: 2,
            languageId: "html",
            value: "<p>hi</p>",
            metadata: {
              id: "cueX",
              type: "text",
              cellLabel: "MARY MAGDALENE",
              data: { startTime: 74.658, endTime: 74.908, globalReferences: [] },
              edits: [{ author: "a", timestamp: 1, type: "user-edit", editMap: ["value"], value: "<p>hi</p>" }],
            },
          },
        ],
      },
    }
    const create = mapFilePairToEvents(pair, OPTS).find((e) => e.kind === "source.cell.create")!
    expect(create.payload.startMs).toBe(74658)
    expect(create.payload.endMs).toBe(74908)
    // the character name lives in cellLabel → cast, NOT canonical_ref
    expect(create.payload.canonicalRef).toBeUndefined()
  })

  it("does not recreate cells deleted in Codex, retracts them, and does not anchor through them", () => {
    // c1 (live) → c2 (deleted in Codex) → c3 (live). c3 must anchor to c1, c2
    // must never be recreated, and c2 must carry an explicit retraction so a
    // re-migration purges a row an earlier migration already created
    // (AQU-673 no-recreate + AQU-747 retraction).
    const pair: FilePairInput = {
      relPath: "F",
      name: "F",
      target: {
        metadata: { id: "f", originalName: "f" },
        cells: [
          { kind: 2, languageId: "html", value: "<p>a</p>", metadata: { id: "c1", type: "text" } },
          { kind: 2, languageId: "html", value: "<p>b</p>", metadata: { id: "c2", type: "text", data: { deleted: true } } },
          { kind: 2, languageId: "html", value: "<p>c</p>", metadata: { id: "c3", type: "text" } },
        ],
      },
    }
    const ev = mapFilePairToEvents(pair, OPTS)
    const creates = ev.filter((e) => e.kind === "source.cell.create")
    expect(creates.map((e) => e.cellId)).toEqual(["c1", "c3"]) // c2 not recreated
    // c2 is never recreated on either lane...
    expect(ev.some((e) => e.cellId === "c2" && e.kind === "source.cell.create")).toBe(false)
    expect(ev.some((e) => e.cellId === "c2" && e.kind === "target.cell.commit")).toBe(false)
    // ...but IS explicitly retracted on both lanes so a re-run removes an
    // already-migrated row (c2 lives in the target notebook, so a target lane
    // was migrated too).
    expect(ev.some((e) => e.cellId === "c2" && e.kind === "source.cell.delete")).toBe(true)
    expect(ev.some((e) => e.cellId === "c2" && e.kind === "target.cell.delete")).toBe(true)
    // c3 anchors to the prior LIVE cell (c1), not the deleted c2.
    const c3create = creates.find((e) => e.cellId === "c3")!
    expect(c3create.payload.anchorCellId).toBe("c1")
  })

  it("retraction ids are deterministic so a re-migration dedupes (AQU-747 idempotency)", () => {
    const pair: FilePairInput = {
      relPath: "F",
      name: "F",
      target: {
        metadata: { id: "f", originalName: "f" },
        cells: [
          { kind: 2, languageId: "html", value: "<p>b</p>", metadata: { id: "c2", type: "text", data: { deleted: true } } },
        ],
      },
    }
    const a = mapFilePairToEvents(pair, OPTS)
    const b = mapFilePairToEvents(pair, OPTS)
    const idsOf = (ev: typeof a) =>
      ev.filter((e) => e.kind.endsWith("cell.delete")).map((e) => `${e.kind}:${e.id}`)
    // Same seeds → identical ids on re-run → INSERT OR IGNORE makes it a no-op.
    expect(idsOf(a)).toEqual(idsOf(b))
    expect(idsOf(a).length).toBe(2) // one source + one target retraction
  })

  it("emits no target retraction for a deleted source-only cell (AQU-747)", () => {
    // Deleted cell present only on the SOURCE side: retract the source lane, but
    // never emit a target delete for a lane that was never migrated.
    const pair: FilePairInput = {
      relPath: "F",
      name: "F",
      source: {
        metadata: { id: "f", originalName: "f" },
        cells: [
          { kind: 2, languageId: "html", value: "<p>b</p>", metadata: { id: "c2", type: "text", data: { deleted: true } } },
        ],
      },
    }
    const ev = mapFilePairToEvents(pair, OPTS)
    expect(ev.some((e) => e.cellId === "c2" && e.kind === "source.cell.delete")).toBe(true)
    expect(ev.some((e) => e.kind === "target.cell.delete")).toBe(false)
  })

  it("treats deletion recorded in the edit ledger as latest-edit-wins (delete then restore = present)", () => {
    const pair: FilePairInput = {
      relPath: "F",
      name: "F",
      target: {
        metadata: { id: "f", originalName: "f" },
        cells: [
          // deleted at ts 10, restored at ts 20 → still present.
          {
            kind: 2,
            languageId: "html",
            value: "<p>restored</p>",
            metadata: {
              id: "keep",
              type: "text",
              data: { deleted: true },
              edits: [
                { author: "a", timestamp: 10, type: "user-edit", editMap: ["metadata", "data", "deleted"], value: true },
                { author: "a", timestamp: 20, type: "user-edit", editMap: ["metadata", "data", "deleted"], value: false },
              ],
            },
          },
          // deleted at ts 30 with no later restore → dropped, even though
          // data.deleted was left false on the materialized cell.
          {
            kind: 2,
            languageId: "html",
            value: "<p>gone</p>",
            metadata: {
              id: "drop",
              type: "text",
              data: { deleted: false },
              edits: [
                { author: "a", timestamp: 30, type: "user-edit", editMap: ["metadata", "data", "deleted"], value: true },
              ],
            },
          },
        ],
      },
    }
    const ev = mapFilePairToEvents(pair, OPTS)
    const ids = ev.filter((e) => e.kind === "source.cell.create").map((e) => e.cellId)
    expect(ids).toEqual(["keep"])
    // The restored cell is created, never retracted; the still-deleted cell is
    // retracted, never created (AQU-747).
    expect(ev.some((e) => e.cellId === "keep" && e.kind === "source.cell.delete")).toBe(false)
    expect(ev.some((e) => e.cellId === "drop" && e.kind === "source.cell.delete")).toBe(true)
    expect(ev.some((e) => e.cellId === "drop" && e.kind === "source.cell.create")).toBe(false)
  })

  it("collectSpeakers skips cells deleted in Codex", () => {
    const pair: FilePairInput = {
      relPath: "F",
      name: "F",
      target: {
        metadata: { id: "f", originalName: "f" },
        cells: [
          { kind: 2, languageId: "html", value: "x", metadata: { id: "c1", type: "text", cellLabel: "MARY MAGDALENE" } },
          { kind: 2, languageId: "html", value: "y", metadata: { id: "c2", type: "text", cellLabel: "PETER", data: { deleted: true } } },
        ],
      },
    }
    expect(collectSpeakers(pair)).toEqual([{ cellId: "c1", speaker: "MARY MAGDALENE" }])
  })

  it("collectSpeakers maps each cell's cellLabel to a speaker", () => {
    const pair: FilePairInput = {
      relPath: "F",
      name: "F",
      target: {
        metadata: { id: "f", originalName: "f" },
        cells: [
          { kind: 2, languageId: "html", value: "x", metadata: { id: "c1", type: "text", cellLabel: "MARY MAGDALENE" } },
          { kind: 2, languageId: "html", value: "y", metadata: { id: "c2", type: "text" } },
        ],
      },
    }
    expect(collectSpeakers(pair)).toEqual([{ cellId: "c1", speaker: "MARY MAGDALENE" }])
  })
})
