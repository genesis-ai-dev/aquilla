// AQU-910 — deletion-by-absence reconciliation. AQU-673/AQU-747 only handle a
// cell Codex kept in the notebook with `metadata.data.deleted`; a cell removed
// from the array outright produced no event at all and survived every re-run.
import { describe, it, expect } from "vitest"
import type { CodexNotebookFile } from "../codex-editor/types"
import { mapFilePairToEvents, type FilePairInput, type MapOptions } from "./map"
import {
  liveCellIdsByFile,
  liveSourceAnchorsByFile,
  mapAnchorRepairs,
  mapOrphanRetractions,
  type ProjectionCell,
} from "./orphans"
import {
  fileIdFor,
  sourceCellCreateEventId,
  sourceCellDeleteEventId,
  sourceCellReanchorEventId,
  targetCellDeleteEventId,
} from "./ids"

const OPTS: MapOptions = {
  projectId: "proj-1",
  projectKey: "legacykey",
  fallbackAuthor: "migrate",
  fallbackTs: 1000,
}

const FILE_ID = fileIdFor(OPTS.projectKey, "GEN")

/** A Codex notebook holding exactly `ids` — i.e. everything else was deleted. */
function notebook(ids: string[]): CodexNotebookFile {
  return {
    metadata: { id: "f", originalName: "f" },
    cells: ids.map((id) => ({
      kind: 2 as const,
      languageId: "html",
      value: `<p>${id}</p>`,
      metadata: { id, type: "text" },
    })),
  }
}

function pairOf(ids: string[]): FilePairInput {
  return { relPath: "GEN", name: "GEN", source: notebook(ids), target: notebook(ids) }
}

/** The event log a prior migration of `ids` left behind. */
function migratedEventIds(ids: string[]): Set<string> {
  return new Set(ids.map((id) => sourceCellCreateEventId(OPTS.projectId, FILE_ID, id)))
}

const bothSides = (cellId: string): ProjectionCell => ({ cellId, hasSource: true, hasTarget: true })

describe("liveCellIdsByFile", () => {
  it("keys live cells by file and keeps a file whose every cell was deleted", () => {
    // Every heading in the file is deleted in Codex (the Algerian case): the
    // file still needs reconciling, so it must appear with an EMPTY live set —
    // otherwise its orphans are silently out of scope.
    const allDeleted: FilePairInput = {
      relPath: "GEN",
      name: "GEN",
      target: {
        metadata: { id: "f", originalName: "f" },
        cells: [
          { kind: 2, languageId: "html", value: "<p>h</p>", metadata: { id: "h1", type: "paratext", data: { deleted: true } } },
        ],
      },
    }
    const byFile = liveCellIdsByFile(mapFilePairToEvents(allDeleted, OPTS))
    expect(byFile.has(FILE_ID)).toBe(true)
    expect([...byFile.get(FILE_ID)!]).toEqual([])
  })

  it("collects the cells the current parse produced", () => {
    const byFile = liveCellIdsByFile(mapFilePairToEvents(pairOf(["c1", "c2"]), OPTS))
    expect([...byFile.get(FILE_ID)!].sort()).toEqual(["c1", "c2"])
  })
})

describe("mapOrphanRetractions", () => {
  it("retracts a cell Codex removed from the notebook entirely (AQU-910)", () => {
    // Prior migration created c1..c3; Codex has since hard-deleted c2 (it is not
    // in the array at all, so the mapper emits nothing for it).
    const events = mapFilePairToEvents(pairOf(["c1", "c3"]), OPTS)
    expect(events.some((e) => e.cellId === "c2")).toBe(false) // nothing to skip or retract

    const orphans = mapOrphanRetractions({
      projectId: OPTS.projectId,
      fileId: FILE_ID,
      liveCellIds: liveCellIdsByFile(events).get(FILE_ID)!,
      projectionCells: [bothSides("c1"), bothSides("c2"), bothSides("c3")],
      existingEventIds: migratedEventIds(["c1", "c2", "c3"]),
      fallbackAuthor: OPTS.fallbackAuthor,
      fallbackTs: OPTS.fallbackTs,
    })

    expect(orphans.map((e) => `${e.kind}:${e.cellId}`)).toEqual([
      "source.cell.delete:c2",
      "target.cell.delete:c2",
    ])
    expect(orphans[0].id).toBe(sourceCellDeleteEventId(OPTS.projectId, FILE_ID, "c2"))
    expect(orphans[1].id).toBe(targetCellDeleteEventId(OPTS.projectId, FILE_ID, "c2"))
  })

  it("retracts only the sides the projection actually holds", () => {
    const orphans = mapOrphanRetractions({
      projectId: OPTS.projectId,
      fileId: FILE_ID,
      liveCellIds: new Set(),
      projectionCells: [{ cellId: "c2", hasSource: true, hasTarget: false }],
      existingEventIds: migratedEventIds(["c2"]),
      fallbackAuthor: OPTS.fallbackAuthor,
      fallbackTs: OPTS.fallbackTs,
    })
    expect(orphans.map((e) => e.kind)).toEqual(["source.cell.delete"])
  })

  it("never retracts a cell the migration did not create (no legitimate cells lost)", () => {
    // c9 exists in the projection but has no migration `source.cell.create` —
    // it was added inside Aquilla (import / agent / contributor).
    const orphans = mapOrphanRetractions({
      projectId: OPTS.projectId,
      fileId: FILE_ID,
      liveCellIds: new Set(["c1"]),
      projectionCells: [bothSides("c1"), bothSides("c9")],
      existingEventIds: migratedEventIds(["c1"]),
      fallbackAuthor: OPTS.fallbackAuthor,
      fallbackTs: OPTS.fallbackTs,
    })
    expect(orphans).toEqual([])
  })

  it("is a no-op once the retraction stuck (row gone → cell never enters the pass)", () => {
    // The true idempotent case: the tombstone applied, so /migrate/cell-ids no
    // longer returns the cell at all. (A logged tombstone with the row STILL
    // present is the AQU-933 zombie — covered below.)
    const orphans = mapOrphanRetractions({
      projectId: OPTS.projectId,
      fileId: FILE_ID,
      liveCellIds: new Set(),
      projectionCells: [],
      existingEventIds: new Set([
        ...migratedEventIds(["c2"]),
        sourceCellDeleteEventId(OPTS.projectId, FILE_ID, "c2"),
        targetCellDeleteEventId(OPTS.projectId, FILE_ID, "c2"),
      ]),
      fallbackAuthor: OPTS.fallbackAuthor,
      fallbackTs: OPTS.fallbackTs,
    })
    expect(orphans).toEqual([])
  })

  it("re-kills a zombie: tombstone in the log but the row survived a pre-AQU-931 rebuild (AQU-933)", () => {
    // The Burmese duplicate-heading case: c2's gen-1 retractions landed in an
    // earlier run, a rebuild under the old arbitration rule resurrected the
    // rows, and the logged ids delta-filter every re-emission. The pass must
    // escalate to generation 2 — deterministic, so a re-run dedupes it too.
    const existing = new Set([
      ...migratedEventIds(["c2"]),
      sourceCellDeleteEventId(OPTS.projectId, FILE_ID, "c2"),
      targetCellDeleteEventId(OPTS.projectId, FILE_ID, "c2"),
    ])
    const orphans = mapOrphanRetractions({
      projectId: OPTS.projectId,
      fileId: FILE_ID,
      liveCellIds: new Set(),
      projectionCells: [bothSides("c2")],
      existingEventIds: existing,
      fallbackAuthor: OPTS.fallbackAuthor,
      fallbackTs: OPTS.fallbackTs,
    })
    expect(orphans.map((e) => `${e.kind}:${e.id}`)).toEqual([
      `source.cell.delete:${sourceCellDeleteEventId(OPTS.projectId, FILE_ID, "c2", 2)}`,
      `target.cell.delete:${targetCellDeleteEventId(OPTS.projectId, FILE_ID, "c2", 2)}`,
    ])
    // Generation 2 is a genuinely different id (gen 1 is the exact legacy seed).
    expect(sourceCellDeleteEventId(OPTS.projectId, FILE_ID, "c2", 2))
      .not.toBe(sourceCellDeleteEventId(OPTS.projectId, FILE_ID, "c2"))
    expect(sourceCellDeleteEventId(OPTS.projectId, FILE_ID, "c2", 1))
      .toBe(sourceCellDeleteEventId(OPTS.projectId, FILE_ID, "c2"))
  })

  it("escalates past every logged generation, and stops at the cap", () => {
    const genIds = (upTo: number) =>
      Array.from({ length: upTo }, (_, i) => [
        sourceCellDeleteEventId(OPTS.projectId, FILE_ID, "c2", i + 1),
        targetCellDeleteEventId(OPTS.projectId, FILE_ID, "c2", i + 1),
      ]).flat()
    const twoGens = mapOrphanRetractions({
      projectId: OPTS.projectId,
      fileId: FILE_ID,
      liveCellIds: new Set(),
      projectionCells: [bothSides("c2")],
      existingEventIds: new Set([...migratedEventIds(["c2"]), ...genIds(2)]),
      fallbackAuthor: OPTS.fallbackAuthor,
      fallbackTs: OPTS.fallbackTs,
    })
    expect(twoGens.map((e) => e.id)).toEqual([
      sourceCellDeleteEventId(OPTS.projectId, FILE_ID, "c2", 3),
      targetCellDeleteEventId(OPTS.projectId, FILE_ID, "c2", 3),
    ])
    const exhausted = mapOrphanRetractions({
      projectId: OPTS.projectId,
      fileId: FILE_ID,
      liveCellIds: new Set(),
      projectionCells: [bothSides("c2")],
      existingEventIds: new Set([...migratedEventIds(["c2"]), ...genIds(8)]),
      fallbackAuthor: OPTS.fallbackAuthor,
      fallbackTs: OPTS.fallbackTs,
    })
    expect(exhausted).toEqual([])
  })

  it("re-kills a soft-deleted cell's zombie even though the mapper re-emits gen 1 this run (AQU-933)", () => {
    // c2 is still IN the notebook, soft-deleted: the mapper emits the gen-1
    // retraction every run — but that id is already in the log, so the CLI
    // delta-filters it and it never re-projects. The pass must see through the
    // skip set and mint gen 2.
    const pair: FilePairInput = {
      relPath: "GEN",
      name: "GEN",
      target: {
        metadata: { id: "f", originalName: "f" },
        cells: [
          { kind: 2, languageId: "html", value: "<p>b</p>", metadata: { id: "c2", type: "text", data: { deleted: true } } },
        ],
      },
    }
    const events = mapFilePairToEvents(pair, OPTS)
    const orphans = mapOrphanRetractions({
      projectId: OPTS.projectId,
      fileId: FILE_ID,
      liveCellIds: liveCellIdsByFile(events).get(FILE_ID)!,
      projectionCells: [bothSides("c2")],
      existingEventIds: new Set([
        ...migratedEventIds(["c2"]),
        sourceCellDeleteEventId(OPTS.projectId, FILE_ID, "c2"),
        targetCellDeleteEventId(OPTS.projectId, FILE_ID, "c2"),
      ]),
      skipEventIds: new Set(events.map((e) => e.id)),
      fallbackAuthor: OPTS.fallbackAuthor,
      fallbackTs: OPTS.fallbackTs,
    })
    expect(orphans.map((e) => e.id)).toEqual([
      sourceCellDeleteEventId(OPTS.projectId, FILE_ID, "c2", 2),
      targetCellDeleteEventId(OPTS.projectId, FILE_ID, "c2", 2),
    ])
  })

  it("does not double-emit the retraction the mapper already produced for a soft-deleted cell", () => {
    // c2 is soft-deleted in Codex: the mapper retracts it (AQU-747) AND it is
    // absent from the live set, so both paths would mint the same id.
    const pair: FilePairInput = {
      relPath: "GEN",
      name: "GEN",
      target: {
        metadata: { id: "f", originalName: "f" },
        cells: [
          { kind: 2, languageId: "html", value: "<p>a</p>", metadata: { id: "c1", type: "text" } },
          { kind: 2, languageId: "html", value: "<p>b</p>", metadata: { id: "c2", type: "text", data: { deleted: true } } },
        ],
      },
    }
    const events = mapFilePairToEvents(pair, OPTS)
    const orphans = mapOrphanRetractions({
      projectId: OPTS.projectId,
      fileId: FILE_ID,
      liveCellIds: liveCellIdsByFile(events).get(FILE_ID)!,
      projectionCells: [bothSides("c1"), bothSides("c2")],
      existingEventIds: migratedEventIds(["c1", "c2"]),
      skipEventIds: new Set(events.map((e) => e.id)),
      fallbackAuthor: OPTS.fallbackAuthor,
      fallbackTs: OPTS.fallbackTs,
    })
    expect(orphans).toEqual([])
  })

  it("leaves live cells alone", () => {
    const events = mapFilePairToEvents(pairOf(["c1", "c2"]), OPTS)
    const orphans = mapOrphanRetractions({
      projectId: OPTS.projectId,
      fileId: FILE_ID,
      liveCellIds: liveCellIdsByFile(events).get(FILE_ID)!,
      projectionCells: [bothSides("c1"), bothSides("c2")],
      existingEventIds: migratedEventIds(["c1", "c2"]),
      fallbackAuthor: OPTS.fallbackAuthor,
      fallbackTs: OPTS.fallbackTs,
    })
    expect(orphans).toEqual([])
  })
})

// AQU-931 — anchor repair. Retractions hard-delete rows that surviving cells'
// stored anchors still point at; the deterministic creates never re-project,
// so without a repair the read order scrambles (the Pattani Malay report).
describe("mapAnchorRepairs", () => {
  const anchored = (cellId: string, sourceAnchorCellId: string | null): ProjectionCell => ({
    cellId,
    hasSource: true,
    hasTarget: true,
    sourceAnchorCellId,
  })

  it("re-anchors a survivor whose stored anchor was retracted (the AQU-910/930 fallout)", () => {
    // Old chain: m1 → v1 → v2. m1 (a heading/milestone) is gone from today's
    // parse, so v1's intended anchor is now null; v2 is unchanged.
    const events = mapFilePairToEvents(pairOf(["v1", "v2"]), OPTS)
    const repairs = mapAnchorRepairs({
      projectId: OPTS.projectId,
      fileId: FILE_ID,
      intendedAnchors: liveSourceAnchorsByFile(events).get(FILE_ID)!,
      projectionCells: [anchored("v1", "m1"), anchored("v2", "v1")],
      existingEventIds: migratedEventIds(["v1", "v2", "m1"]),
      fallbackAuthor: OPTS.fallbackAuthor,
      fallbackTs: OPTS.fallbackTs,
    })
    expect(repairs).toEqual([
      {
        id: sourceCellReanchorEventId(OPTS.projectId, FILE_ID, "v1", null),
        kind: "source.cell.reanchor",
        fileId: FILE_ID,
        cellId: "v1",
        parentId: null,
        author: OPTS.fallbackAuthor,
        clientTs: OPTS.fallbackTs,
        payload: { anchorCellId: null },
      },
    ])
  })

  it("emits nothing when the projection already matches today's chain (fresh or repaired)", () => {
    const events = mapFilePairToEvents(pairOf(["v1", "v2"]), OPTS)
    const repairs = mapAnchorRepairs({
      projectId: OPTS.projectId,
      fileId: FILE_ID,
      intendedAnchors: liveSourceAnchorsByFile(events).get(FILE_ID)!,
      projectionCells: [anchored("v1", null), anchored("v2", "v1")],
      existingEventIds: migratedEventIds(["v1", "v2"]),
      fallbackAuthor: OPTS.fallbackAuthor,
      fallbackTs: OPTS.fallbackTs,
    })
    expect(repairs).toEqual([])
  })

  it("never re-anchors a cell the migration did not create, or one not in today's parse", () => {
    const events = mapFilePairToEvents(pairOf(["v1"]), OPTS)
    const repairs = mapAnchorRepairs({
      projectId: OPTS.projectId,
      fileId: FILE_ID,
      intendedAnchors: liveSourceAnchorsByFile(events).get(FILE_ID)!,
      projectionCells: [
        // v1 is mis-anchored but was NOT created by the migration (no create in
        // the log) — an Aquilla-authored cell keeps its author's anchor.
        anchored("v1", "somewhere"),
        // c9 is mis-anchored but absent from today's parse — retraction
        // territory, not repair territory.
        anchored("c9", "gone"),
      ],
      existingEventIds: new Set([sourceCellCreateEventId(OPTS.projectId, FILE_ID, "c9")]),
      fallbackAuthor: OPTS.fallbackAuthor,
      fallbackTs: OPTS.fallbackTs,
    })
    expect(repairs).toEqual([])
  })

  it("is a no-op once the repair is in the log — a later manual reorder is not re-fought", () => {
    const events = mapFilePairToEvents(pairOf(["v1", "v2"]), OPTS)
    const repairs = mapAnchorRepairs({
      projectId: OPTS.projectId,
      fileId: FILE_ID,
      intendedAnchors: liveSourceAnchorsByFile(events).get(FILE_ID)!,
      projectionCells: [anchored("v1", "m1"), anchored("v2", "v1")],
      existingEventIds: new Set([
        ...migratedEventIds(["v1", "v2"]),
        sourceCellReanchorEventId(OPTS.projectId, FILE_ID, "v1", null),
      ]),
      fallbackAuthor: OPTS.fallbackAuthor,
      fallbackTs: OPTS.fallbackTs,
    })
    expect(repairs).toEqual([])
  })

  it("treats a missing sourceAnchorCellId (pre-AQU-931 server) as a null stored anchor", () => {
    const events = mapFilePairToEvents(pairOf(["v1", "v2"]), OPTS)
    const repairs = mapAnchorRepairs({
      projectId: OPTS.projectId,
      fileId: FILE_ID,
      intendedAnchors: liveSourceAnchorsByFile(events).get(FILE_ID)!,
      projectionCells: [bothSides("v1"), bothSides("v2")], // no anchor field at all
      existingEventIds: migratedEventIds(["v1", "v2"]),
      fallbackAuthor: OPTS.fallbackAuthor,
      fallbackTs: OPTS.fallbackTs,
    })
    // v1's intended anchor is null == treated-stored null → quiet; v2 intends
    // "v1" ≠ null → repaired. Never a crash on the old response shape.
    expect(repairs.map((e) => `${e.cellId}→${(e.payload as { anchorCellId: string | null }).anchorCellId}`))
      .toEqual(["v2→v1"])
  })
})

describe("liveSourceAnchorsByFile", () => {
  it("captures each live cell's mapped anchor, skipping retracted cells in the chain", () => {
    // m2 is soft-deleted in Codex: v3 must anchor THROUGH it to v1.
    const pair: FilePairInput = {
      relPath: "GEN",
      name: "GEN",
      target: {
        metadata: { id: "f", originalName: "f" },
        cells: [
          { kind: 2, languageId: "html", value: "<p>a</p>", metadata: { id: "v1", type: "text" } },
          { kind: 2, languageId: "html", value: "<p>b</p>", metadata: { id: "m2", type: "text", data: { deleted: true } } },
          { kind: 2, languageId: "html", value: "<p>c</p>", metadata: { id: "v3", type: "text" } },
        ],
      },
    }
    const anchors = liveSourceAnchorsByFile(mapFilePairToEvents(pair, OPTS)).get(FILE_ID)!
    expect([...anchors.entries()]).toEqual([
      ["v1", null],
      ["v3", "v1"],
    ])
  })
})
