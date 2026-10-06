// What a NEW concept keeps on its way through `emitConceptDelta` into its
// `term.create`. An import (TBX, LIFT, CSV) hands the glossary whole concepts;
// a field the create leaves out is a field the projection never stores, and
// nothing tells the user it was dropped.
import { describe, it, expect, vi, beforeEach } from "vitest"

const emitTermCreate = vi.fn(async (_input?: unknown) => "e-create")
const emitTermUpdate = vi.fn(async (_input?: unknown) => "e-update")
vi.mock("@/lib/sync/events-emit", () => ({
  emitTermCreate: (input: unknown) => emitTermCreate(input),
  emitTermUpdate: (input: unknown) => emitTermUpdate(input),
  emitTermDelete: vi.fn(async () => "e-delete"),
  emitTermApprove: vi.fn(async () => "e-approve"),
  emitTermReject: vi.fn(async () => "e-reject"),
}))

import { emitConceptDelta } from "./events-delta"
import { importConceptsTbx } from "./tbx"
import type { Concept } from "./types"

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

// AQU-1693: the Bible entity link. Voices and Who's Who name the entity with
// the linked concept's rendering, so the link must reach the server on create,
// an unlink must really clear it, and an edit that does not touch it must not
// send it (a stale snapshot would otherwise overwrite a colleague's link).
describe("a concept's Bible entity link", () => {
  const jesus = (p: Partial<Concept> = {}): Concept => ({
    id: "c1",
    sourceTerm: "Jesus",
    renderings: [{ rendering: "Yesus", status: "preferred" }],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    externalIds: { acai: "person:Jesus.2" },
    ...p,
  })

  it("a created concept carries its link", async () => {
    await emitConceptDelta({ ...base, prev: [], next: [jesus()] })
    expect(emitTermCreate.mock.calls[0][0]).toMatchObject({ externalIds: { acai: "person:Jesus.2" } })
  })

  it("linking an existing concept sends the link", async () => {
    await emitConceptDelta({ ...base, prev: [jesus({ externalIds: undefined })], next: [jesus()] })
    expect(emitTermUpdate).toHaveBeenCalledWith({ ...base, conceptId: "c1", externalIds: { acai: "person:Jesus.2" } })
  })

  it("unlinking sends `{}`, because an absent key would leave the stored link in place", async () => {
    await emitConceptDelta({ ...base, prev: [jesus()], next: [jesus({ externalIds: undefined })] })
    expect(emitTermUpdate).toHaveBeenCalledWith({ ...base, conceptId: "c1", externalIds: {} })
  })

  it("an edit that leaves the link alone does not send it", async () => {
    const renamed = jesus({ renderings: [{ rendering: "Isa", status: "preferred" }] })
    await emitConceptDelta({ ...base, prev: [jesus()], next: [renamed] })
    expect(emitTermUpdate).toHaveBeenCalledTimes(1)
    expect(emitTermUpdate.mock.calls[0][0]).not.toHaveProperty("externalIds")
  })
})
