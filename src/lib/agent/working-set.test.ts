/**
 * working-set tests — the derivation the workbench panel trusts: tool rows
 * merge by cell in first-seen order, staged commits overlay as pending
 * proposals, and a local accept/reject decision removes the overlay.
 */

import { describe, it, expect } from "vitest"
import type { AgentRunUi } from "./run-state"
import { deriveWorkingSet, pendingRows, proposalRowKey } from "./working-set"

function run(items: AgentRunUi["items"]): AgentRunUi {
  return { localId: "r1", prompt: "p", runId: "run-1", items, status: "ok" }
}

const readItem = (cells: { cellId: string; ref?: string; source?: string; target?: string; status?: "untranslated" }[]): AgentRunUi["items"][number] => ({
  id: "i0",
  kind: "tool",
  step: 1,
  tool: "read",
  summary: "MRK 4",
  ok: true,
  data: { cells: cells.map((c) => ({ source: "", target: "", ...c })) },
})

const proposalItem = (proposalId: string, cellId: string, after: string): AgentRunUi["items"][number] => ({
  id: "i1",
  kind: "proposal",
  proposal: {
    proposalId,
    runId: "run-1",
    summary: "Draft 1 cell",
    events: [
      {
        kind: "target.cell.commit",
        fileId: "f1",
        cellId,
        payload: { value: after },
        display: { canonicalRef: "MRK 4:3", before: "", after },
      },
    ],
  },
})

describe("deriveWorkingSet", () => {
  it("merges tool rows by cell and overlays staged commits as pending", () => {
    const rows = deriveWorkingSet([
      run([
        readItem([
          { cellId: "c1", ref: "MRK 4:1", source: "s1", target: "t1" },
          { cellId: "c3", ref: "MRK 4:3", source: "s3", target: "", status: "untranslated" },
        ]),
        proposalItem("p1", "c3", "borrador"),
      ]),
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ cellId: "c1", target: "t1" })
    expect(rows[0].proposed).toBeUndefined()
    expect(rows[1]).toMatchObject({
      cellId: "c3",
      source: "s3",
      proposed: "borrador",
      proposalId: "p1",
      ref: "MRK 4:3",
    })
    expect(pendingRows(rows).map((r) => r.cellId)).toEqual(["c3"])
  })

  it("a proposal for an unseen cell creates its row from display context", () => {
    const rows = deriveWorkingSet([run([proposalItem("p1", "c9", "nuevo")])])
    expect(rows[0]).toMatchObject({ cellId: "c9", ref: "MRK 4:3", proposed: "nuevo", fileId: "f1" })
  })

  it("decided rows lose their pending overlay", () => {
    const runs = [run([readItem([{ cellId: "c3", source: "s3", target: "" }]), proposalItem("p1", "c3", "borrador")])]
    const decided = new Set([proposalRowKey("p1", "c3")])
    const rows = deriveWorkingSet(runs, decided)
    expect(rows[0].proposed).toBeUndefined()
    expect(pendingRows(rows)).toHaveLength(0)
  })

  it("later runs update earlier rows (revalidated read after apply)", () => {
    const rows = deriveWorkingSet([
      run([readItem([{ cellId: "c3", source: "s3", target: "" }])]),
      run([readItem([{ cellId: "c3", source: "s3", target: "borrador aplicado" }])]),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].target).toBe("borrador aplicado")
  })
})
