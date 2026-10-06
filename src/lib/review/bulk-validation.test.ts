// AQU-490: the predicate both bulk text-validation paths now share.
//
// It exists because they had DRIFTED — the selection toolbar applied two
// guards the three-dot "Validate all" did not. These tests pin both guards so
// the two cannot separate again.
import { describe, it, expect } from "vitest"
import { isBulkValidatableByMe } from "./bulk-validation"
import type { MemberScope } from "@/lib/sync/member-scopes"

const cell = (over: Record<string, unknown> = {}) => ({
  fileId: "f1",
  translated: "hola",
  activeValidators: [] as string[],
  targetEventId: "evt-1",
  ...over,
}) as Parameters<typeof isBulkValidatableByMe>[0]

const unscoped: MemberScope[] = []

describe("isBulkValidatableByMe", () => {
  it("takes an ordinary translated cell", () => {
    expect(isBulkValidatableByMe(cell(), "ana", unscoped, "")).toBe(true)
  })

  it("skips a cell with no translation", () => {
    expect(isBulkValidatableByMe(cell({ translated: "" }), "ana", unscoped, "")).toBe(false)
  })

  // THE FIRST GUARD the menu path was missing. A scoped member's validate on
  // an out-of-scope cell is a guaranteed 403; the server stays authoritative,
  // this only keeps the doomed event out of the outbox.
  it("skips a cell outside the caller's assignment", () => {
    const scopes = [{ kind: "file", value: "other" }] as unknown as MemberScope[]
    expect(isBulkValidatableByMe(cell(), "ana", scopes, "")).toBe(false)
  })

  // THE SECOND. A repeat vote is not wrong — the projection is keyed on
  // (cell, user) and folds it away — but it wastes a round trip and makes the
  // count the UI promised disagree with the work actually done.
  it("skips a cell this user has already validated", () => {
    expect(isBulkValidatableByMe(cell({ activeValidators: ["ana"] }), "ana", unscoped, "")).toBe(false)
    expect(isBulkValidatableByMe(cell({ activeValidators: ["bo"] }), "ana", unscoped, "")).toBe(true)
  })

  // AQU-1703: a machine-drafted line is ordinary work to review — but the
  // guards that say WHO may validate still apply, so a run never fires a
  // guaranteed 403 or a repeat vote.
  it("takes a machine-drafted line, and keeps the scope and already-mine guards", () => {
    expect(isBulkValidatableByMe(cell(), "ana", unscoped, "")).toBe(true)
    const scopes = [{ kind: "file", value: "other" }] as unknown as MemberScope[]
    expect(isBulkValidatableByMe(cell(), "ana", scopes, "")).toBe(false)
    expect(isBulkValidatableByMe(cell({ activeValidators: ["ana"] }), "ana", unscoped, "")).toBe(false)
  })
})

// AQU-1571: the server refuses a vote on the caller's own latest change when
// the project switched self-validation off. Each one used to come back as a
// line in the red "failed" banner after a bulk run.
describe("isBulkValidatableByMe — own latest change", () => {
  const off = { allowSelfValidation: false }

  it("skips the caller's own latest change when self-validation is off", () => {
    expect(isBulkValidatableByMe(cell({ lastEditor: "ana" }), "ana", unscoped, "", off)).toBe(false)
    expect(isBulkValidatableByMe(cell({ lastEditor: "bo" }), "ana", unscoped, "", off)).toBe(true)
  })

  it("takes it when the setting is on or unset", () => {
    expect(isBulkValidatableByMe(cell({ lastEditor: "ana" }), "ana", unscoped, "", { allowSelfValidation: true })).toBe(true)
    expect(isBulkValidatableByMe(cell({ lastEditor: "ana" }), "ana", unscoped, "")).toBe(true)
  })

  it("never treats an unknown editor as the caller", () => {
    expect(isBulkValidatableByMe(cell({ lastEditor: null }), "ana", unscoped, "", off)).toBe(true)
    expect(isBulkValidatableByMe(cell(), "ana", unscoped, "", off)).toBe(true)
  })

  // AQU-1703: dropping the AI-draft exclusion widened what one gesture covers,
  // not who may validate — the caller's own latest change is still theirs.
  it("still skips the caller's own latest change on a machine-drafted line", () => {
    expect(isBulkValidatableByMe(cell({ lastEditor: "ana" }), "ana", unscoped, "", off)).toBe(false)
  })
})
