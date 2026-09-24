import { describe, expect, it } from "vitest"
import { verifyInvariants, type Contract, type Observed, type Snapshot } from "./invariants"

const before: Snapshot = {
  projects: [{ id: "p", name: "Project", present: true }],
  files: [{ projectId: "p", fileId: "f", name: "file.md", deleted: false }],
  cells: [
    { fileId: "f", cellId: "c1", side: "source", value: "one", validated: false, eventId: "s1" },
    { fileId: "f", cellId: "c1", side: "target", value: "moja", validated: false, eventId: "t1" },
    { fileId: "f", cellId: "c2", side: "target", value: "mbili", validated: false, eventId: "t2" },
  ],
  comments: [],
  histories: { c1: [], c2: [] },
}
const edited = (value: string, cellId = "c1"): Snapshot => ({
  ...before,
  cells: before.cells.map((cell) => cell.side === "target" && cell.cellId === cellId
    ? { ...cell, value, eventId: `${cell.eventId}x` } : cell),
})
const editC1: Contract = {
  allowed: [{ kind: "target", cellId: "c1" }],
  required: [{ kind: "target-value", cellId: "c1", oneOf: ["fixed"] }],
}
const seen: Observed = { inputObserved: true, mutatorApplied: true, serverErrors: 0, pageErrors: 0 }

describe("adversarial invariant oracle", () => {
  it("passes a real edit confined to the allowed cell", () => {
    expect(verifyInvariants(before, edited("fixed"), editC1, seen).verdict).toBe("passed")
  })

  it("fails a write that landed on an untouched cell, even when the goal was also met", () => {
    const both = { ...edited("fixed"), cells: edited("fixed").cells.map((cell) =>
      cell.cellId === "c2" ? { ...cell, value: "broken" } : cell) }
    const outcome = verifyInvariants(before, both, editC1, seen)
    expect(outcome.verdict).toBe("product_failure")
    expect(outcome.diffs).toEqual(["f/c2/target changed".replace(/^/, "cell ")])
  })

  it("catches a moved chain head with an identical value, since that rewrites history silently", () => {
    const moved = { ...before, cells: before.cells.map((cell) =>
      cell.cellId === "c2" && cell.side === "target" ? { ...cell, eventId: "t2b" } : cell) }
    expect(verifyInvariants(before, moved, { allowed: [], required: [] }, seen).checks.invariantsHeld).toBe(false)
  })

  it("fails a lost edit after the UI showed it, because that is data loss", () => {
    expect(verifyInvariants(before, before, editC1, seen).verdict).toBe("product_failure")
  })

  it("stays inconclusive when the agent never showed the input, so agent misses are not filed as bugs", () => {
    expect(verifyInvariants(before, before, editC1, { ...seen, inputObserved: false }).verdict).toBe("inconclusive")
  })

  it("stays inconclusive when the hostile condition never fired, so a calm run is not a condition pass", () => {
    const outcome = verifyInvariants(before, edited("fixed"), editC1, { ...seen, mutatorApplied: false })
    expect(outcome.verdict).toBe("inconclusive")
  })

  it("fails on a server error even when state looks right", () => {
    expect(verifyInvariants(before, edited("fixed"), editC1, { ...seen, serverErrors: 1 }).verdict).toBe("product_failure")
  })

  it("lets an allowed edit auto-validate its own cell, but not a neighbour", () => {
    const flag = (snapshot: Snapshot, cellId: string): Snapshot => ({ ...snapshot, cells: snapshot.cells.map((cell) =>
      cell.cellId === cellId && cell.side === "target" ? { ...cell, validated: true } : cell) })
    expect(verifyInvariants(before, flag(edited("fixed"), "c1"), editC1, seen).verdict).toBe("passed")
    expect(verifyInvariants(before, flag(edited("fixed"), "c2"), editC1, seen).diffs).toContain("cell f/c2/target validation changed")
  })

  it("flags files that appear or disappear", () => {
    const extra = { ...before, files: [...before.files, { projectId: "p", fileId: "g", name: "x", deleted: false }] }
    expect(verifyInvariants(before, extra, { allowed: [], required: [] }, seen).diffs).toContain("file g appeared")
  })

  it("accepts a toggle but rejects two live sign-offs by one reviewer", () => {
    const history = (kinds: string[]) => ({ ...before, histories: { ...before.histories,
      c1: kinds.map((kind) => ({ kind, author: "adv1", value: null })) } })
    const contract: Contract = { allowed: [], required: [{ kind: "no-duplicate-validation", cellId: "c1" }] }
    expect(verifyInvariants(before, history(["cell.validate", "cell.unvalidate"]), contract, seen).checks.requirementsMet).toBe(true)
    expect(verifyInvariants(before, history(["cell.validate", "cell.validate"]), contract, seen).checks.requirementsMet).toBe(false)
  })

  it("requires both concurrent edits in the audit log, so a silently dropped edit is caught", () => {
    const contract: Contract = { allowed: [{ kind: "target", cellId: "c1" }],
      required: [{ kind: "history-contains", cellId: "c1", values: ["a", "b"] }] }
    const onlyA = { ...edited("a"), histories: { c1: [{ kind: "target.cell.commit", author: "adv1", value: "a" }] } }
    expect(verifyInvariants(before, onlyA, contract, seen).verdict).toBe("product_failure")
  })

  it("rejects a renamed project the contract did not allow", () => {
    const renamed = { ...before, projects: [{ id: "p", name: "Other", present: true }] }
    expect(verifyInvariants(before, renamed, { allowed: [], required: [] }, seen).diffs).toContain("project p renamed")
  })
})
