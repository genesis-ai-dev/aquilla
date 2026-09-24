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
  aiDrafted: false,
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
})
