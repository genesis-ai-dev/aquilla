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
  mapCellResurrections,
  mapOrphanRetractions,
  type ProjectionCell,
} from "./orphans"
import {
  escalatedEventId,
  fileIdFor,
  sourceCellCreateEventId,
  sourceCellDeleteEventId,
  sourceCellReanchorEventId,
  targetCellDeleteEventId,
  targetCommitEventId,
  validateEventId,
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

  it("preserves a human reorder: logged repair + stored anchor on a LIVE cell → skipped", () => {
    // v1 was repaired once (gen-1 logged), then a contributor deliberately
    // moved it behind v2 in the app. The stored anchor targets a live cell —
    // no damage shape can produce that — so the divergence is intent.
    const events = mapFilePairToEvents(pairOf(["v1", "v2"]), OPTS)
    const live = liveSourceAnchorsByFile(events).get(FILE_ID)!
    const repairs = mapAnchorRepairs({
      projectId: OPTS.projectId,
      fileId: FILE_ID,
      intendedAnchors: live,
      projectionCells: [anchored("v1", "v2"), anchored("v2", "v1")],
      existingEventIds: new Set([
        ...migratedEventIds(["v1", "v2"]),
        sourceCellReanchorEventId(OPTS.projectId, FILE_ID, "v1", null),
        sourceCellReanchorEventId(OPTS.projectId, FILE_ID, "v2", "v1"),
      ]),
      resurrectedCellIds: new Set(),
      liveCellIds: new Set(live.keys()),
      fallbackAuthor: OPTS.fallbackAuthor,
      fallbackTs: OPTS.fallbackTs,
    })
    expect(repairs).toEqual([])
  })

  it("escalates a logged-but-undone repair when the stored anchor is dead (the poisoned-run shape)", () => {
    // The Burmese prod damage: a stale-checkout run re-anchored v1 back to a
    // long-retracted composite cell AFTER the correct gen-1 repair had landed,
    // so the gen-1 id suppresses every re-emission while the projection stays
    // broken. A dead stored anchor is provably not a human reorder → escalate.
    const events = mapFilePairToEvents(pairOf(["v1", "v2"]), OPTS)
    const live = liveSourceAnchorsByFile(events).get(FILE_ID)!
    const gen1 = sourceCellReanchorEventId(OPTS.projectId, FILE_ID, "v1", null)
    const repairs = mapAnchorRepairs({
      projectId: OPTS.projectId,
      fileId: FILE_ID,
      intendedAnchors: live,
      projectionCells: [anchored("v1", "m1:paratext-legacy"), anchored("v2", "v1")],
      existingEventIds: new Set([...migratedEventIds(["v1", "v2"]), gen1]),
      resurrectedCellIds: new Set(),
      liveCellIds: new Set(live.keys()),
      fallbackAuthor: OPTS.fallbackAuthor,
      fallbackTs: OPTS.fallbackTs,
    })
    expect(repairs.map((e) => `${e.id}:${(e.payload as { anchorCellId: string | null }).anchorCellId}`))
      .toEqual([`${escalatedEventId(gen1, 2)}:null`])
    // Escalates past every logged generation.
    const gen3 = mapAnchorRepairs({
      projectId: OPTS.projectId,
      fileId: FILE_ID,
      intendedAnchors: live,
      projectionCells: [anchored("v1", "m1:paratext-legacy"), anchored("v2", "v1")],
      existingEventIds: new Set([
        ...migratedEventIds(["v1", "v2"]),
        gen1,
        escalatedEventId(gen1, 2),
      ]),
      resurrectedCellIds: new Set(),
      liveCellIds: new Set(live.keys()),
      fallbackAuthor: OPTS.fallbackAuthor,
      fallbackTs: OPTS.fallbackTs,
    })
    expect(gen3.map((e) => e.id)).toEqual([escalatedEventId(gen1, 3)])
  })

  it("escalates a suppressed repair whose intended anchor is being resurrected this run", () => {
    // v2 follows p1, a cell this pass is resurrecting. Its stored anchor was
    // re-pointed (by the poisoned run) at v1 — a LIVE cell, so the dead-anchor
    // rule alone would read it as a human reorder. The resurrection set breaks
    // the tie: a follower of a row being restored belongs behind it.
    const events = mapFilePairToEvents(pairOf(["v1", "p1", "v2"]), OPTS)
    const live = liveSourceAnchorsByFile(events).get(FILE_ID)!
    const gen1 = sourceCellReanchorEventId(OPTS.projectId, FILE_ID, "v2", "p1")
    const repairs = mapAnchorRepairs({
      projectId: OPTS.projectId,
      fileId: FILE_ID,
      intendedAnchors: live,
      projectionCells: [anchored("v1", null), anchored("v2", "v1")], // p1's row is gone
      existingEventIds: new Set([...migratedEventIds(["v1", "p1", "v2"]), gen1]),
      resurrectedCellIds: new Set(["p1"]),
      liveCellIds: new Set(live.keys()),
      fallbackAuthor: OPTS.fallbackAuthor,
      fallbackTs: OPTS.fallbackTs,
    })
    expect(repairs.map((e) => `${e.cellId}:${e.id}`)).toEqual([`v2:${escalatedEventId(gen1, 2)}`])
  })

  it("escalates when the stored anchor was written by the migration itself (Pattani Malay MAT)", () => {
    // The second poison footprint: the stale run re-anchored v3 to v1 — a LIVE
    // cell, so the dead-anchor rule reads it as a possible human reorder, and
    // nothing is being resurrected (no cells were deleted). But reanchor ids
    // are deterministic in (cell, anchor): the poison reanchor's own id
    // (v3→v1) sits in the log, proving the stored value is migration-written —
    // in-app reorders mint server-side ids, never this seed. Escalate.
    const events = mapFilePairToEvents(pairOf(["v1", "v2", "v3"]), OPTS)
    const live = liveSourceAnchorsByFile(events).get(FILE_ID)!
    const intendedGen1 = sourceCellReanchorEventId(OPTS.projectId, FILE_ID, "v3", "v2")
    const poisonReanchor = sourceCellReanchorEventId(OPTS.projectId, FILE_ID, "v3", "v1")
    const repairs = mapAnchorRepairs({
      projectId: OPTS.projectId,
      fileId: FILE_ID,
      intendedAnchors: live,
      projectionCells: [anchored("v1", null), anchored("v2", "v1"), anchored("v3", "v1")],
      existingEventIds: new Set([
        ...migratedEventIds(["v1", "v2", "v3"]),
        intendedGen1, // the correct repair, logged earlier — suppressed
        poisonReanchor, // the stale run's reanchor — proves migration wrote the stored anchor
      ]),
      resurrectedCellIds: new Set(),
      liveCellIds: new Set(live.keys()),
      fallbackAuthor: OPTS.fallbackAuthor,
      fallbackTs: OPTS.fallbackTs,
    })
    expect(repairs.map((e) => `${e.cellId}:${e.id}`)).toEqual([`v3:${escalatedEventId(intendedGen1, 2)}`])
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

// Resurrection — the mirror image of the AQU-933 zombie: a LIVE cell whose
// projection rows a poisoned run deleted, while its create/commits sit in the
// log and delta-filter every re-emission (the Burmese prod incident: a stale
// checkout mapped months-old notebooks and retracted 145 current cells).
describe("mapCellResurrections", () => {
  // p1 (a paratext heading with real translator history) is live in today's
  // parse; v1 follows it. The prior log holds p1's full slice.
  function pairWithHistory(): FilePairInput {
    const source: CodexNotebookFile = {
      metadata: { id: "f", originalName: "f" },
      cells: [
        { kind: 2, languageId: "html", value: "<p>heading</p>", metadata: { id: "p1", type: "paratext" } },
        { kind: 2, languageId: "html", value: "<p>verse</p>", metadata: { id: "v1", type: "text" } },
      ],
    }
    const target: CodexNotebookFile = {
      metadata: { id: "f", originalName: "f" },
      cells: [
        {
          kind: 2,
          languageId: "html",
          value: "<p>final</p>",
          metadata: {
            id: "p1",
            type: "paratext",
            edits: [
              { author: "amy", timestamp: 100, type: "user-edit", editMap: ["value"], value: "<p>draft</p>" },
              { author: "amy", timestamp: 150, type: "user-edit", editMap: ["metadata", "cellLabel"], value: "x" },
              {
                author: "bo",
                timestamp: 200,
                type: "user-edit",
                editMap: ["value"],
                value: "<p>final</p>",
                validatedBy: [
                  { username: "rev", creationTimestamp: 250, updatedTimestamp: 250, isDeleted: false },
                ],
              },
            ],
          },
        },
        { kind: 2, languageId: "html", value: "", metadata: { id: "v1", type: "text" } },
      ],
    }
    return { relPath: "GEN", name: "GEN", source, target }
  }

  const createId = () => sourceCellCreateEventId(OPTS.projectId, FILE_ID, "p1")
  // Value edits sit at ORIGINAL edits[] indices 0 and 2 (index 1 is a label edit).
  const commit0 = () => targetCommitEventId(OPTS.projectId, FILE_ID, "p1", 0)
  const commit2 = () => targetCommitEventId(OPTS.projectId, FILE_ID, "p1", 2)
  const validate = () => validateEventId(OPTS.projectId, FILE_ID, "p1", "rev")

  it("re-emits the cell's full slice under escalated ids with every reference rewired", () => {
    const events = mapFilePairToEvents(pairWithHistory(), OPTS)
    const { events: out, cellIds } = mapCellResurrections({
      fileId: FILE_ID,
      events,
      projectionCells: [bothSides("v1")], // p1's rows are gone; v1 intact
      existingEventIds: new Set(events.map((e) => e.id)), // a prior identical run logged everything
    })
    expect([...cellIds]).toEqual(["p1"])
    expect(out.map((e) => e.kind)).toEqual([
      "source.cell.create",
      "target.cell.commit",
      "target.cell.commit",
      "cell.validate",
    ])
    const [rc, k0, k2, rv] = out
    expect(rc.id).toBe(escalatedEventId(createId(), 2))
    expect(rc.payload.anchorCellId).toBe(null) // p1 heads the file
    expect(k0.id).toBe(escalatedEventId(commit0(), 2))
    expect(k0.parentId).toBe(escalatedEventId(createId(), 2))
    expect(k0.payload.sourceEventId).toBe(escalatedEventId(createId(), 2))
    expect(k2.id).toBe(escalatedEventId(commit2(), 2))
    expect(k2.parentId).toBe(escalatedEventId(commit0(), 2)) // chained on its rewritten sibling
    expect(rv.id).toBe(escalatedEventId(validate(), 2))
    expect(rv.payload.editEventId).toBe(escalatedEventId(commit2(), 2)) // pins the rewritten head
    // Original authorship and legacy timestamps ride along untouched.
    expect(k0.author).toBe("amy")
    expect(k2.author).toBe("bo")
    expect(rv.author).toBe("rev")
    expect(k2.clientTs).toBe(200)
  })

  it("never resurrects a cell the migration did not create, or one whose row survived", () => {
    const events = mapFilePairToEvents(pairWithHistory(), OPTS)
    // p1's create is NOT in the log: a fresh cell — its create lands normally
    // this run, so re-emitting it would double-project.
    const fresh = mapCellResurrections({
      fileId: FILE_ID,
      events,
      projectionCells: [bothSides("v1")],
      existingEventIds: new Set([sourceCellCreateEventId(OPTS.projectId, FILE_ID, "v1")]),
    })
    expect(fresh.events).toEqual([])
    // p1's row is present: nothing to do (anchors are mapAnchorRepairs' job).
    const intact = mapCellResurrections({
      fileId: FILE_ID,
      events,
      projectionCells: [bothSides("p1"), bothSides("v1")],
      existingEventIds: new Set(events.map((e) => e.id)),
    })
    expect(intact.events).toEqual([])
  })

  it("leaves a live target row untouched when only the source side was deleted", () => {
    const events = mapFilePairToEvents(pairWithHistory(), OPTS)
    const { events: out } = mapCellResurrections({
      fileId: FILE_ID,
      events,
      projectionCells: [{ cellId: "p1", hasSource: false, hasTarget: true }, bothSides("v1")],
      existingEventIds: new Set(events.map((e) => e.id)),
    })
    // Source create only — no commit replay (would move the live head and
    // reset validation), no validation churn.
    expect(out.map((e) => e.kind)).toEqual(["source.cell.create"])
    expect(out[0].id).toBe(escalatedEventId(createId(), 2))
  })

  it("escalates past a logged generation that did not stick, and stops at the cap", () => {
    const events = mapFilePairToEvents(pairWithHistory(), OPTS)
    const logged = new Set(events.map((e) => e.id))
    const gen3 = mapCellResurrections({
      fileId: FILE_ID,
      events,
      projectionCells: [bothSides("v1")],
      existingEventIds: new Set([...logged, escalatedEventId(createId(), 2)]),
    })
    expect(gen3.events[0]?.id).toBe(escalatedEventId(createId(), 3))
    const exhausted = mapCellResurrections({
      fileId: FILE_ID,
      events,
      projectionCells: [bothSides("v1")],
      existingEventIds: new Set([
        ...logged,
        ...Array.from({ length: 7 }, (_, i) => escalatedEventId(createId(), i + 2)),
      ]),
    })
    expect(exhausted.events).toEqual([])
    expect([...exhausted.cellIds]).toEqual([])
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
