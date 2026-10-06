// What a NEW concept keeps on its way through `emitConceptDelta` into its
// `term.create`. An import (TBX, LIFT, CSV) hands the glossary whole concepts;
// a field the create leaves out is a field the projection never stores, and
// nothing tells the user it was dropped.
import { describe, it, expect, vi, beforeEach } from "vitest"

const emitTermCreate = vi.fn(async (_input?: unknown) => "e-create")
vi.mock("@/lib/sync/events-emit", () => ({
  emitTermCreate: (input: unknown) => emitTermCreate(input),
  emitTermUpdate: vi.fn(async () => "e-update"),
  emitTermDelete: vi.fn(async () => "e-delete"),
  emitTermApprove: vi.fn(async () => "e-approve"),
  emitTermReject: vi.fn(async () => "e-reject"),
}))

import { emitConceptDelta } from "./events-delta"
import { importConceptsTbx } from "./tbx"

const base = { projectId: "p1", author: "ryder" }

beforeEach(() => {
  vi.clearAllMocks()
})

describe("a created concept keeps its matching options", () => {
  // The forms are what make a term match its inflections at all: without them
  // an imported "Ἰησοῦς" entry flags none of Ἰησοῦ, Ἰησοῦν.
  it("an imported TBX entry's variant forms and options reach term.create", async () => {
    const tbx = `<martif><text><body>
      <termEntry id="c-jesus">
        <langSet xml:lang="source">
          <tig><term>Ἰησοῦς</term><termNote type="aquillaMatchOptions">{"foldMarks":true}</termNote></tig>
          <tig><term>Ἰησοῦν</term><termNote type="termType">variant</termNote></tig>
        </langSet>
        <langSet xml:lang="target"><tig><term>Yesus</term></tig></langSet>
      </termEntry>
    </body></text></martif>`
    const imported = importConceptsTbx(tbx)

    await emitConceptDelta({ ...base, prev: [], next: imported })

    expect(emitTermCreate).toHaveBeenCalledTimes(1)
    expect(emitTermCreate.mock.calls[0][0]).toMatchObject({
      conceptId: "c-jesus",
      match: { foldMarks: true, forms: ["Ἰησοῦν"] },
    })
  })

  it("a concept with no options sends no match key, so the projection keeps live defaults", async () => {
    const [plain] = importConceptsTbx(
      `<termEntry id="c-1"><langSet xml:lang="source"><tig><term>grace</term></tig></langSet></termEntry>`,
    )
    await emitConceptDelta({ ...base, prev: [], next: [plain] })
    expect(emitTermCreate.mock.calls[0][0]).not.toHaveProperty("match")
  })
})
