// AQU-191: target-column eBible import — unit tests
//
// Tests cover:
//  1. matchEBibleToSourceCells — ref matching, orphan classification, conflict detection
//  2. applyEBibleTargetImport — commit payload shape, parentId selection, empty selection

import { describe, it, expect, vi, beforeEach } from "vitest"
import "fake-indexeddb/auto"
import {
  matchEBibleToSourceCells,
  applyEBibleTargetImport,
  type SourceCellRef,
  type EBibleMatchResult,
} from "./import"
import { peekOutboxBatch, resetOutboxConnectionForTests } from "./sync/outbox"

// ---------------------------------------------------------------------------
// matchEBibleToSourceCells
// ---------------------------------------------------------------------------

describe("matchEBibleToSourceCells — ref matching", () => {
  const sourceCells: SourceCellRef[] = [
    { cellId: "cell-gen-1-1", fileId: "file-a", translated: "", canonicalRef: "GEN 1:1", sourceEventId: "src-evt-1" },
    { cellId: "cell-gen-1-2", fileId: "file-a", translated: "", canonicalRef: "GEN 1:2", sourceEventId: "src-evt-2" },
    { cellId: "cell-mat-1-1", fileId: "file-b", translated: "existing target", canonicalRef: "MAT 1:1", sourceEventId: "src-evt-3", targetEventId: "tgt-evt-3" },
  ]

  it("matches incoming verses to source cells by canonicalRef", () => {
    const result = matchEBibleToSourceCells(
      [
        { ref: "GEN 1:1", text: "In the beginning" },
        { ref: "GEN 1:2", text: "The earth was formless" },
      ],
      sourceCells,
    )
    expect(result.matched).toHaveLength(2)
    expect(result.matched[0].cellId).toBe("cell-gen-1-1")
    expect(result.matched[0].incomingText).toBe("In the beginning")
    expect(result.matched[1].cellId).toBe("cell-gen-1-2")
  })

  it("classifies orphans: verses with no matching source cell", () => {
    const result = matchEBibleToSourceCells(
      [
        { ref: "GEN 1:1", text: "In the beginning" },
        { ref: "REV 22:21", text: "The grace of the Lord Jesus" },
      ],
      sourceCells,
    )
    expect(result.orphans).toHaveLength(1)
    expect(result.orphans[0].ref).toBe("REV 22:21")
  })

  it("detects conflicts: hasConflict=true when translated is non-empty", () => {
    const result = matchEBibleToSourceCells(
      [{ ref: "MAT 1:1", text: "The book of the genealogy" }],
      sourceCells,
    )
    expect(result.matched).toHaveLength(1)
    expect(result.matched[0].hasConflict).toBe(true)
    expect(result.matched[0].currentText).toBe("existing target")
  })

  it("detects no conflict when translated is empty", () => {
    const result = matchEBibleToSourceCells(
      [{ ref: "GEN 1:1", text: "In the beginning" }],
      sourceCells,
    )
    expect(result.matched[0].hasConflict).toBe(false)
    expect(result.matched[0].currentText).toBe("")
  })

  it("counts unmatchedSourceCount: source cells whose ref was never matched", () => {
    const result = matchEBibleToSourceCells(
      [{ ref: "GEN 1:1", text: "In the beginning" }],
      sourceCells,
    )
    // GEN 1:2 and MAT 1:1 were not in the incoming verses
    expect(result.unmatchedSourceCount).toBe(2)
  })

  it("uses targetEventId as parentId when present (chain continuation)", () => {
    const result = matchEBibleToSourceCells(
      [{ ref: "MAT 1:1", text: "The book of the genealogy" }],
      sourceCells,
    )
    expect(result.matched[0].parentId).toBe("tgt-evt-3")
  })

  it("falls back to sourceEventId as parentId for genesis target commits", () => {
    const result = matchEBibleToSourceCells(
      [{ ref: "GEN 1:1", text: "In the beginning" }],
      sourceCells,
    )
    expect(result.matched[0].parentId).toBe("src-evt-1")
  })

  it("skips source cells with no canonicalRef from the index", () => {
    const cells: SourceCellRef[] = [
      { cellId: "no-ref", fileId: "f", translated: "", canonicalRef: null, sourceEventId: "e1" },
      { cellId: "has-ref", fileId: "f", translated: "", canonicalRef: "GEN 1:1", sourceEventId: "e2" },
    ]
    const result = matchEBibleToSourceCells(
      [{ ref: "GEN 1:1", text: "In the beginning" }],
      cells,
    )
    expect(result.matched).toHaveLength(1)
    expect(result.matched[0].cellId).toBe("has-ref")
  })

  it("first source cell wins when multiple cells share the same canonicalRef", () => {
    const cells: SourceCellRef[] = [
      { cellId: "first", fileId: "f", translated: "", canonicalRef: "GEN 1:1", sourceEventId: "e1" },
      { cellId: "second", fileId: "f", translated: "", canonicalRef: "GEN 1:1", sourceEventId: "e2" },
    ]
    const result = matchEBibleToSourceCells(
      [{ ref: "GEN 1:1", text: "In the beginning" }],
      cells,
    )
    expect(result.matched).toHaveLength(1)
    expect(result.matched[0].cellId).toBe("first")
  })

  it("returns empty matched + all orphans when sourceCells is empty", () => {
    const result = matchEBibleToSourceCells(
      [{ ref: "GEN 1:1", text: "In the beginning" }],
      [],
    )
    expect(result.matched).toHaveLength(0)
    expect(result.orphans).toHaveLength(1)
    expect(result.unmatchedSourceCount).toBe(0)
  })

  it("returns empty arrays when incoming verses is empty", () => {
    const result = matchEBibleToSourceCells([], sourceCells)
    expect(result.matched).toHaveLength(0)
    expect(result.orphans).toHaveLength(0)
    expect(result.unmatchedSourceCount).toBe(sourceCells.filter((c) => c.canonicalRef).length)
  })
})

// ---------------------------------------------------------------------------
// applyEBibleTargetImport — commit payload shape
// ---------------------------------------------------------------------------

describe("applyEBibleTargetImport — commit shape", () => {
  const matchResult: EBibleMatchResult = {
    matched: [
      {
        cellId: "cell-1",
        fileId: "file-a",
        incomingText: "In the beginning",
        currentText: "",
        hasConflict: false,
        parentId: "src-evt-1",
        ref: "GEN 1:1",
      },
      {
        cellId: "cell-2",
        fileId: "file-a",
        incomingText: "The earth was formless",
        currentText: "old content",
        hasConflict: true,
        parentId: "tgt-evt-2",
        ref: "GEN 1:2",
      },
      {
        cellId: "cell-3",
        fileId: "file-b",
        incomingText: "The book of the genealogy",
        currentText: "",
        hasConflict: false,
        parentId: "src-evt-3",
        ref: "MAT 1:1",
      },
    ],
    orphans: [],
    unmatchedSourceCount: 0,
  }

  // Target import now ENQUEUES to the CQRS outbox instead of POSTing. `fetch`
  // is stubbed only to PROVE no network happens in the apply path — the
  // flusher owns the network. Assertions read the outbox.
  let fetchCalls = 0

  beforeEach(async () => {
    fetchCalls = 0
    vi.stubGlobal("fetch", async () => {
      fetchCalls += 1
      return { ok: true, text: async () => "" } as Response
    })
    await resetOutboxConnectionForTests()
    await new Promise<void>((resolve, reject) => {
      const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
      d.onblocked = () => resolve()
      d.onsuccess = () => resolve()
      d.onerror = () => reject(d.error)
    })
  })

  const ctx = {
    projectId: "proj-1",
    author: "test-user",
    getToken: async () => "tok",
  }

  it("only commits cells in selectedCellIds", async () => {
    const selected = new Set(["cell-1"])
    const { committedCount, skippedCount } = await applyEBibleTargetImport(matchResult, selected, ctx)
    expect(committedCount).toBe(1)
    expect(skippedCount).toBe(2)
  })

  it("commits all selected cells including conflict ones", async () => {
    const selected = new Set(["cell-1", "cell-2"])
    const { committedCount } = await applyEBibleTargetImport(matchResult, selected, ctx)
    expect(committedCount).toBe(2)
  })

  it("enqueues target.cell.commit events with correct shape (no network)", async () => {
    const selected = new Set(["cell-1"])
    await applyEBibleTargetImport(matchResult, selected, ctx)

    expect(fetchCalls).toBe(0) // the flusher owns the network, not the apply path
    const rows = await peekOutboxBatch(100)
    const mine = rows.find((r) => r.event.cellId === "cell-1")!
    expect(mine).toBeDefined()
    expect(mine.event.kind).toBe("target.cell.commit")
    expect(mine.event.cellId).toBe("cell-1")
    expect(mine.event.parentId).toBe("src-evt-1")
    const payload = mine.event.payload as { value: string; sourceEventId: string }
    expect(payload.value).toBe("In the beginning")
    // sourceEventId is echoed in the payload for AD-9 staleness pin
    expect(payload.sourceEventId).toBe("src-evt-1")
  })

  it("returns committedCount=0 and skippedCount=total when selection is empty", async () => {
    const { committedCount, skippedCount } = await applyEBibleTargetImport(
      matchResult,
      new Set(),
      ctx,
    )
    expect(committedCount).toBe(0)
    expect(skippedCount).toBe(3)
    // Nothing enqueued, no network.
    expect(fetchCalls).toBe(0)
    expect(await peekOutboxBatch(100)).toHaveLength(0)
  })

  it("enqueues commits for every selected file (no network)", async () => {
    // cell-1 and cell-2 are in file-a; cell-3 is in file-b
    const selected = new Set(["cell-1", "cell-2", "cell-3"])
    await applyEBibleTargetImport(matchResult, selected, ctx)
    expect(fetchCalls).toBe(0)
    const rows = await peekOutboxBatch(100)
    const fileIds = new Set(rows.map((r) => r.event.fileId))
    expect(fileIds).toEqual(new Set(["file-a", "file-b"]))
    expect(rows).toHaveLength(3)
  })
})
