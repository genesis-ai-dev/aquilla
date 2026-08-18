// AQU-910 — deletion-by-absence reconciliation. AQU-673/AQU-747 only handle a
// cell Codex kept in the notebook with `metadata.data.deleted`; a cell removed
// from the array outright produced no event at all and survived every re-run.
import { describe, it, expect } from "vitest"
import type { CodexNotebookFile } from "../codex-editor/types"
import { mapFilePairToEvents, type FilePairInput, type MapOptions } from "./map"
import { liveCellIdsByFile, mapOrphanRetractions, type ProjectionCell } from "./orphans"
import {
  fileIdFor,
  sourceCellCreateEventId,
  sourceCellDeleteEventId,
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

  it("is a no-op once the retraction is in the log (re-run stays quiet)", () => {
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
    expect(orphans).toEqual([])
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
