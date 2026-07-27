import { describe, it, expect } from "vitest"
import { planUserImport, type SourceUser, type ExistingUser } from "./users"

const src: SourceUser[] = [
  { username: "annanajarian", email: "anna@x.com", password_hash: "h1" },
  { username: "keithmiller", email: "keith@x.com", password_hash: "h2" },
]

describe("planUserImport", () => {
  it("inserts users absent from the target", () => {
    const plan = planUserImport(src, [])
    expect(plan.toInsert.map((u) => u.username)).toEqual(["annanajarian", "keithmiller"])
    expect(plan.alreadyPresent).toBe(0)
  })

  it("is idempotent — a second pass (now present) inserts nothing", () => {
    const existing: ExistingUser[] = src.map((u) => ({ username: u.username, email: u.email }))
    const plan = planUserImport(src, existing)
    expect(plan.toInsert).toHaveLength(0)
    expect(plan.alreadyPresent).toBe(2)
  })

  it("matches case-insensitively on username and email", () => {
    const plan = planUserImport(src, [{ username: "AnnaNajarian", email: "ANNA@x.com" }])
    expect(plan.alreadyPresent).toBe(1)
    expect(plan.toInsert.map((u) => u.username)).toEqual(["keithmiller"])
  })

  it("flags a username collision with a different email as a conflict, not an insert", () => {
    const plan = planUserImport(src, [{ username: "annanajarian", email: "someone-else@y.com" }])
    expect(plan.toInsert.map((u) => u.username)).toEqual(["keithmiller"])
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0].reason).toMatch(/username taken/)
  })

  it("flags an email collision with a different username", () => {
    const plan = planUserImport(src, [{ username: "different", email: "anna@x.com" }])
    expect(plan.conflicts[0].reason).toMatch(/email taken/)
    expect(plan.toInsert.map((u) => u.username)).toEqual(["keithmiller"])
  })

  it("skips rows missing a username or email", () => {
    const plan = planUserImport([{ username: "", email: "x@x.com", password_hash: "h" }], [])
    expect(plan.toInsert).toHaveLength(0)
    expect(plan.conflicts[0].reason).toMatch(/missing/)
  })

  it("quarantines every source row sharing a case-insensitive username or email", () => {
    const plan = planUserImport([
      { username: "Cleiton", email: "one@example.com", password_hash: "h1" },
      { username: "cleiton", email: "two@example.com", password_hash: "h2" },
      { username: "third", email: "TWO@example.com", password_hash: "h3" },
    ], [])

    expect(plan.toInsert).toEqual([])
    expect(plan.conflicts).toHaveLength(3)
    expect(plan.conflicts.every((conflict) =>
      conflict.reason.includes("duplicate case-insensitive identity"),
    )).toBe(true)
  })
})
