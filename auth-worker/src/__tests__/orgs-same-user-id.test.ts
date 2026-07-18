import { describe, it, expect } from "vitest"
import { isSameUserId } from "../routes/orgs"

/**
 * AQU-347 regression: the org invite-preview still-member check compares
 * org_invites.used_by (a Postgres BIGINT, which deserializes as a *string* in
 * production) against caller.id (a *number*). A raw `===` across those types is
 * always false, so a still-member redeemer re-clicking a used invite would get
 * a 410 instead of the continue-preview. isSameUserId must normalize both sides.
 */
describe("isSameUserId", () => {
  it("treats a BIGINT string and a number for the same id as equal", () => {
    // This is the exact production mismatch the bug is about.
    expect(isSameUserId("3", 3)).toBe(true)
    expect(isSameUserId(3, "3")).toBe(true)
  })

  it("matches same-typed ids", () => {
    expect(isSameUserId(3, 3)).toBe(true)
    expect(isSameUserId("3", "3")).toBe(true)
  })

  it("distinguishes different ids regardless of type", () => {
    expect(isSameUserId("3", 4)).toBe(false)
    expect(isSameUserId(3, "4")).toBe(false)
  })

  it("never matches when either side is null/undefined", () => {
    expect(isSameUserId(null, 3)).toBe(false)
    expect(isSameUserId(3, null)).toBe(false)
    expect(isSameUserId(undefined, undefined)).toBe(false)
    // Guards against the null-vs-null "both absent" false positive.
    expect(isSameUserId(null, null)).toBe(false)
  })
})
