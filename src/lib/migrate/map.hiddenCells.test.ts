// AQU-1425 — cells Codex parked with the Source Editing Mode eye icon
// (`metadata.data.hidden`) must migrate HIDDEN, not retracted: the pair, its
// translation history and its position all survive, and one
// `source.cell.visibility.set` event (AQU-1422) parks it.
import { describe, it, expect } from "vitest"
import type { CodexNotebookFile, CodexCell, EditHistory } from "../codex-editor/types"
import { mapFilePairToEvents, collectSpeakers, type FilePairInput, type MapOptions } from "./map"
import { fileIdFor, sourceCellVisibilityEventId } from "./ids"

const OPTS: MapOptions = {
  projectId: "proj-1",
  projectKey: "legacykey",
  fallbackAuthor: "migrate",
  fallbackTs: 1000,
}

const FILE_ID = fileIdFor(OPTS.projectKey, "F")

const hiddenEdit = (ts: number, value: boolean): EditHistory => ({
  author: "a",
  timestamp: ts,
  type: "user-edit",
  editMap: ["metadata", "data", "hidden"],
  value,
})

const valueEdit = (ts: number, value: string): EditHistory => ({
  author: "translator",
  timestamp: ts,
  type: "user-edit",
  editMap: ["value"],
  value,
})

function cell(id: string, value: string, metadata: Partial<CodexCell["metadata"]> = {}): CodexCell {
  return { kind: 2, languageId: "html", value, metadata: { id, type: "text", ...metadata } }
}

function notebook(cells: CodexCell[]): CodexNotebookFile {
  return { metadata: { id: "f", originalName: "f" }, cells }
}

/** v1 → h → v2, where `h` carries whatever hidden state the test sets on both
 *  notebook copies (Codex writes the flag on the `.source` and the `.codex`). */
function pairWith(
  sourceMeta: Partial<CodexCell["metadata"]>,
  targetMeta: Partial<CodexCell["metadata"]>,
): FilePairInput {
  return {
    relPath: "F",
    name: "F",
    source: notebook([cell("v1", "<p>one</p>"), cell("h", "<p>parked</p>", sourceMeta), cell("v2", "<p>two</p>")]),
    target: notebook([
      cell("v1", "<p>un</p>"),
      cell("h", "<p>garé</p>", { edits: [valueEdit(200, "<p>garé</p>")], ...targetMeta }),
      cell("v2", "<p>deux</p>"),
    ]),
  }
}

const visibilityEvents = (events: ReturnType<typeof mapFilePairToEvents>) =>
  events.filter((e) => e.kind === "source.cell.visibility.set")

describe("mapFilePairToEvents — Codex hidden cells (AQU-1425)", () => {
  it("migrates a hidden cell as a live pair plus one hide event, keeping its data and position", () => {
    const ev = mapFilePairToEvents(pairWith({ data: { hidden: true } }, { data: { hidden: true } }), OPTS)

    // Not the retraction branch: hidden is reversible, so nothing is deleted.
    expect(ev.some((e) => e.cellId === "h" && e.kind === "source.cell.delete")).toBe(false)
    expect(ev.some((e) => e.cellId === "h" && e.kind === "target.cell.delete")).toBe(false)
    // The pair and its translation history survive untouched.
    expect(ev.some((e) => e.cellId === "h" && e.kind === "source.cell.create")).toBe(true)
    expect(
      ev.find((e) => e.cellId === "h" && e.kind === "target.cell.commit")?.payload.valueHtml,
    ).toBe("<p>garé</p>")
    // The anchor chain advances THROUGH it, so its position is preserved for
    // when it is shown again.
    const creates = ev.filter((e) => e.kind === "source.cell.create")
    expect(creates.map((e) => e.cellId)).toEqual(["v1", "h", "v2"])
    expect(creates[2]!.payload.anchorCellId).toBe("h")

    const hide = visibilityEvents(ev)
    expect(hide).toHaveLength(1)
    expect(hide[0]!.payload).toEqual({ hidden: true })
    expect(hide[0]!.cellId).toBe("h")
    expect(hide[0]!.fileId).toBe(FILE_ID)
    // Non-chain-mutating: parent-less, or it would advance the source head and
    // make every migrated translation read as stale (AD-9).
    expect(hide[0]!.parentId).toBeNull()
    // …and it lands AFTER the create whose row it updates.
    const order = ev.filter((e) => e.cellId === "h").map((e) => e.kind)
    expect(order.indexOf("source.cell.visibility.set")).toBeGreaterThan(order.indexOf("source.cell.create"))
  })

  it("reads the flag latest-edit-wins: hide then unhide migrates as a visible pair", () => {
    const edits = [hiddenEdit(10, true), hiddenEdit(20, false)]
    // The materialized flag is deliberately left stale at `true`, the way Codex
    // leaves it when the ledger carries the newer decision.
    const ev = mapFilePairToEvents(
      pairWith({ data: { hidden: true }, edits }, { data: { hidden: true }, edits: [valueEdit(200, "<p>garé</p>"), ...edits] }),
      OPTS,
    )

    expect(ev.some((e) => e.cellId === "h" && e.kind === "source.cell.create")).toBe(true)
    expect(ev.some((e) => e.cellId === "h" && e.kind === "source.cell.delete")).toBe(false)
    const show = visibilityEvents(ev)
    expect(show).toHaveLength(1)
    expect(show[0]!.payload).toEqual({ hidden: false })
    // The show carries the unhide's own legacy timestamp.
    expect(show[0]!.clientTs).toBe(20)
  })

  it("is idempotent: re-mapping the same working copy derives the identical stream", () => {
    const build = () => pairWith({ data: { hidden: true }, edits: [hiddenEdit(10, true)] }, { edits: [valueEdit(200, "<p>garé</p>"), hiddenEdit(10, true)] })
    const a = mapFilePairToEvents(build(), OPTS)
    const b = mapFilePairToEvents(build(), OPTS)
    expect(b.map((e) => e.id)).toEqual(a.map((e) => e.id))
    expect(b).toEqual(a)
  })

  it("mints a fresh event id for every genuine flip, so a delta re-run follows Codex", () => {
    const at = (edits: EditHistory[]) =>
      visibilityEvents(
        mapFilePairToEvents(pairWith({ edits }, { edits: [valueEdit(200, "<p>garé</p>"), ...edits] }), OPTS),
      )[0]!

    const hide = at([hiddenEdit(10, true)])
    const unhide = at([hiddenEdit(10, true), hiddenEdit(20, false)])
    const rehide = at([hiddenEdit(10, true), hiddenEdit(20, false), hiddenEdit(30, true)])

    // Distinct ids, or `INSERT OR IGNORE` and the migration's delta filter would
    // swallow the second decision and strand the cell in the first one.
    expect(new Set([hide.id, unhide.id, rehide.id]).size).toBe(3)
    expect(hide.payload).toEqual({ hidden: true })
    expect(unhide.payload).toEqual({ hidden: false })
    expect(rehide.payload).toEqual({ hidden: true })
    // Deterministic, not clock-derived.
    expect(rehide.id).toBe(sourceCellVisibilityEventId(OPTS.projectId, FILE_ID, "h", true, 30))
  })

  it("emits nothing for a project Codex never parked (stream unchanged apart from the version bump)", () => {
    const ev = mapFilePairToEvents(pairWith({}, {}), OPTS)
    expect(visibilityEvents(ev)).toHaveLength(0)
    // A materialized `hidden: false` is the default, not a decision.
    expect(visibilityEvents(mapFilePairToEvents(pairWith({ data: { hidden: false } }, {}), OPTS))).toHaveLength(0)
  })

  it("falls back to the materialized flag when the ledger never recorded the hide", () => {
    const ev = mapFilePairToEvents(pairWith({}, { data: { hidden: true } }), OPTS)
    const hide = visibilityEvents(ev)
    expect(hide).toHaveLength(1)
    expect(hide[0]!.payload).toEqual({ hidden: true })
    expect(hide[0]!.clientTs).toBe(OPTS.fallbackTs)
    expect(hide[0]!.id).toBe(sourceCellVisibilityEventId(OPTS.projectId, FILE_ID, "h", true, undefined))
  })

  it("sees the flag when Codex wrote it on only one side of the pair", () => {
    expect(visibilityEvents(mapFilePairToEvents(pairWith({ edits: [hiddenEdit(10, true)] }, {}), OPTS))).toHaveLength(1)
    expect(
      visibilityEvents(
        mapFilePairToEvents(pairWith({}, { edits: [valueEdit(200, "<p>garé</p>"), hiddenEdit(10, true)] }), OPTS),
      ),
    ).toHaveLength(1)
  })

  it("leaves deleted and merged cells retracted — hidden never softens a retraction", () => {
    for (const flag of ["deleted", "merged"] as const) {
      const meta = { data: { hidden: true, [flag]: true } }
      const ev = mapFilePairToEvents(pairWith(meta, meta), OPTS)
      expect(ev.some((e) => e.cellId === "h" && e.kind === "source.cell.delete")).toBe(true)
      expect(ev.some((e) => e.cellId === "h" && e.kind === "source.cell.create")).toBe(false)
      // A row that is about to be hard-deleted must not also get a hide.
      expect(visibilityEvents(ev)).toHaveLength(0)
      // Retracted cells still do not advance the chain.
      expect(
        ev.filter((e) => e.kind === "source.cell.create").find((e) => e.cellId === "v2")!.payload.anchorCellId,
      ).toBe("v1")
    }
  })

  it("keeps a hidden cell's speaker in the cast — parking is reversible", () => {
    const pair: FilePairInput = {
      relPath: "F",
      name: "F",
      target: notebook([
        cell("c1", "x", { cellLabel: "MARY MAGDALENE" }),
        cell("c2", "y", { cellLabel: "PETER", data: { hidden: true } }),
      ]),
    }
    expect(collectSpeakers(pair)).toEqual([
      { cellId: "c1", speaker: "MARY MAGDALENE" },
      { cellId: "c2", speaker: "PETER" },
    ])
  })
})
