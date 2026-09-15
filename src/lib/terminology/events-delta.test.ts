import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Concept } from "./types"

const emitTermCreate = vi.fn(async (_input?: unknown) => "e-create")
const emitTermUpdate = vi.fn(async (_input?: unknown) => "e-update")
const emitTermDelete = vi.fn(async (_input?: unknown) => "e-delete")
const emitTermApprove = vi.fn(async (_input?: unknown) => "e-approve")
const emitTermReject = vi.fn(async (_input?: unknown) => "e-reject")
vi.mock("@/lib/sync/events-emit", () => ({
  emitTermCreate: (input: unknown) => emitTermCreate(input),
  emitTermUpdate: (input: unknown) => emitTermUpdate(input),
  emitTermDelete: (input: unknown) => emitTermDelete(input),
  emitTermApprove: (input: unknown) => emitTermApprove(input),
  emitTermReject: (input: unknown) => emitTermReject(input),
}))

import { emitConceptDelta } from "./events-delta"

function concept(p: Partial<Concept>): Concept {
  return {
    id: "c1",
    sourceTerm: "grace",
    renderings: [{ rendering: "favor", status: "preferred" }],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...p,
  }
}
const base = { projectId: "p1", author: "ryder" }

beforeEach(() => {
  vi.clearAllMocks()
})

// WHY these tests exist: the glossary page used to PATCH the whole termbase
// array into the settings blob. Nothing reads that blob any more, so a write
// that does not become term.* events is a write nobody else will ever see.
describe("emitConceptDelta", () => {
  it("emits nothing when the termbase is unchanged", async () => {
    const prev = [concept({})]
    const ids = await emitConceptDelta({ ...base, prev, next: [concept({})] })
    expect(ids).toEqual([])
    expect(emitTermCreate).not.toHaveBeenCalled()
    expect(emitTermUpdate).not.toHaveBeenCalled()
  })

  it("a concept only in next is a term.create carrying its status and renderings", async () => {
    const added = concept({ id: "c2", sourceTerm: "mercy", status: "draft", caseSensitive: true, notes: "n" })
    await emitConceptDelta({ ...base, prev: [concept({})], next: [concept({}), added] })
    expect(emitTermCreate).toHaveBeenCalledTimes(1)
    expect(emitTermCreate).toHaveBeenCalledWith({
      projectId: "p1",
      conceptId: "c2",
      sourceTerm: "mercy",
      renderings: added.renderings,
      status: "draft",
      notes: "n",
      caseSensitive: true,
      author: "ryder",
    })
  })

  it("a concept only in prev is a term.delete", async () => {
    await emitConceptDelta({ ...base, prev: [concept({})], next: [] })
    expect(emitTermDelete).toHaveBeenCalledWith({ projectId: "p1", conceptId: "c1", author: "ryder" })
  })

  it("field edits become one term.update carrying only the changed fields", async () => {
    const next = concept({ renderings: [{ rendering: "favour", status: "preferred" }], notes: "" })
    await emitConceptDelta({ ...base, prev: [concept({ notes: "old" })], next: [next] })
    expect(emitTermUpdate).toHaveBeenCalledTimes(1)
    expect(emitTermUpdate).toHaveBeenCalledWith({
      projectId: "p1",
      conceptId: "c1",
      author: "ryder",
      renderings: next.renderings,
      // "" not undefined: the projector COALESCEs, so undefined could never clear notes.
      notes: "",
    })
    expect(emitTermApprove).not.toHaveBeenCalled()
  })

  it("status changes are lifecycle verbs: approve for → active, reject(deprecate) for → deprecated", async () => {
    await emitConceptDelta({ ...base, prev: [concept({ status: "draft" })], next: [concept({ status: "active" })] })
    expect(emitTermApprove).toHaveBeenCalledWith({ projectId: "p1", conceptId: "c1", author: "ryder" })
    expect(emitTermUpdate).not.toHaveBeenCalled()

    vi.clearAllMocks()
    await emitConceptDelta({ ...base, prev: [concept({ status: "active" })], next: [concept({ status: "deprecated" })] })
    expect(emitTermReject).toHaveBeenCalledWith({ projectId: "p1", conceptId: "c1", author: "ryder", mode: "deprecate" })

    vi.clearAllMocks()
    // Restore from the archive is the same approval verb.
    await emitConceptDelta({ ...base, prev: [concept({ status: "deprecated" })], next: [concept({ status: "active" })] })
    expect(emitTermApprove).toHaveBeenCalledTimes(1)
  })
})
