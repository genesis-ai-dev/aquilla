import { describe, it, expect } from "vitest"
import { resolveCodexTwoWay } from "../resolveCodex"
import type { CodexCell, CodexNotebookFile, EditHistory } from "@/lib/codex-editor/types"

function cell(id: string, value: string, edits: EditHistory[] = []): CodexCell {
  return {
    kind: 2,
    languageId: "html",
    value,
    metadata: { id, type: "text", edits },
  }
}

function nb(cells: CodexCell[], meta: Partial<CodexNotebookFile["metadata"]> = {}): string {
  return JSON.stringify({
    cells,
    metadata: { id: "f1", originalName: "gen", ...meta },
  })
}

const edit = (path: string[], value: unknown, ts: number, author = "a"): EditHistory => ({
  editMap: path, value, timestamp: ts, author, type: "user-edit",
})

describe("resolveCodexTwoWay", () => {
  it("returns theirs when ours is empty", async () => {
    const out = await resolveCodexTwoWay("", nb([cell("c1", "hi")]))
    expect(JSON.parse(out).cells[0].metadata.id).toBe("c1")
  })

  it("returns ours when theirs is empty", async () => {
    const out = await resolveCodexTwoWay(nb([cell("c1", "hi")]), "")
    expect(JSON.parse(out).cells[0].metadata.id).toBe("c1")
  })

  it("unions disjoint cell edits", async () => {
    const ours = nb([cell("c1", "A", [edit(["value"], "A", 10)])])
    const theirs = nb([cell("c1", "B", [edit(["value"], "B", 20)])])
    const merged = JSON.parse(await resolveCodexTwoWay(ours, theirs))
    const edits = merged.cells[0].metadata.edits as EditHistory[]
    expect(edits.map(e => e.value).sort()).toEqual(["A", "B"])
    expect(merged.cells[0].value).toBe("B") // latest timestamp wins
  })

  it("dedupes identical edits by (timestamp, editMap, value)", async () => {
    const e = edit(["value"], "same", 15)
    const ours = nb([cell("c1", "same", [e])])
    const theirs = nb([cell("c1", "same", [e])])
    const merged = JSON.parse(await resolveCodexTwoWay(ours, theirs))
    expect(merged.cells[0].metadata.edits).toHaveLength(1)
  })

  it("keeps ours-only cells", async () => {
    const ours = nb([cell("c1", "A"), cell("c2", "mine")])
    const theirs = nb([cell("c1", "A")])
    const merged = JSON.parse(await resolveCodexTwoWay(ours, theirs))
    expect(merged.cells.map((c: CodexCell) => c.metadata.id)).toEqual(["c1", "c2"])
  })

  it("inserts theirs-only cells at position preserving neighbor order", async () => {
    const ours = nb([cell("c1", "A"), cell("c3", "C")])
    const theirs = nb([cell("c1", "A"), cell("c2", "B"), cell("c3", "C")])
    const merged = JSON.parse(await resolveCodexTwoWay(ours, theirs))
    expect(merged.cells.map((c: CodexCell) => c.metadata.id)).toEqual(["c1", "c2", "c3"])
  })

  it("appends theirs-only cells when anchor missing", async () => {
    const ours = nb([cell("c1", "A")])
    const theirs = nb([cell("c99", "new")])
    const merged = JSON.parse(await resolveCodexTwoWay(ours, theirs))
    expect(merged.cells.map((c: CodexCell) => c.metadata.id)).toEqual(["c1", "c99"])
  })

  it("keeps both-sides-soft-deleted cell (audit)", async () => {
    const deletedMark = edit(["metadata", "data", "deleted"], true, 30)
    const ours = nb([cell("c1", "", [deletedMark])])
    const theirs = nb([cell("c1", "", [deletedMark])])
    const merged = JSON.parse(await resolveCodexTwoWay(ours, theirs))
    expect(merged.cells).toHaveLength(1)
    expect(merged.cells[0].metadata.id).toBe("c1")
  })

  it("unions file-level metadata.edits", async () => {
    const ours = nb([cell("c1", "A")], { edits: [edit(["videoUrl"], "u1", 5)] })
    const theirs = nb([cell("c1", "A")], { edits: [edit(["videoUrl"], "u2", 10)] })
    const merged = JSON.parse(await resolveCodexTwoWay(ours, theirs))
    expect(merged.metadata.edits).toHaveLength(2)
  })

  it("filters invalid validatedBy entries", async () => {
    const eRaw = edit(["value"], "x", 1)
    ;(eRaw as unknown as { validatedBy: unknown[] }).validatedBy = [
      { notAValidationEntry: true },
      { username: "u", creationTimestamp: 1, updatedTimestamp: 1, isDeleted: false },
    ]
    const ours = nb([cell("c1", "x", [eRaw])])
    const theirs = nb([cell("c1", "x")])
    const merged = JSON.parse(await resolveCodexTwoWay(ours, theirs))
    expect(merged.cells[0].metadata.edits[0].validatedBy).toHaveLength(1)
  })
})
