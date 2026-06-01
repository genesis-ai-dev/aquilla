import { describe, it, expect } from "vitest"
import type { CodexNotebookFile } from "../codex-editor/types"
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
