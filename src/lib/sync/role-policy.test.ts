import { describe, it, expect } from "vitest"
import { ROLE, requiredRoleFor, canPerform } from "./role-policy"

describe("role-policy (client mirror)", () => {
  it("mirrors the server's required roles for the kinds that broke in prod", () => {
    // cell.waive is contributor-level — a translator dismissing a flag on their
    // own cell. The prod 403 was scope, not role; this locks the role in so a
    // future server change forces this mirror to update too.
    expect(requiredRoleFor("cell.waive")).toBe(ROLE.CONTRIBUTOR)
    expect(requiredRoleFor("cell.validate")).toBe(ROLE.REVIEWER)
    expect(requiredRoleFor("source.cell.commit")).toBe(ROLE.PROJECT_LEAD)
    expect(requiredRoleFor("comment.create")).toBe(ROLE.COMMENTER)
  })

  it("returns null for unknown kinds (fail-open, server stays authoritative)", () => {
    expect(requiredRoleFor("some.future.kind")).toBeNull()
  })

  describe("canPerform", () => {
    it("blocks only when role is KNOWN and provably below the requirement", () => {
      expect(canPerform("cell.validate", ROLE.COMMENTER)).toBe(false) // 200 < 300
      expect(canPerform("cell.validate", ROLE.REVIEWER)).toBe(true) // 300 >= 300
      expect(canPerform("cell.validate", ROLE.OWNER)).toBe(true)
    })

    it("fails open when the role is unknown", () => {
      expect(canPerform("cell.validate", null)).toBe(true)
      expect(canPerform("cell.validate", undefined)).toBe(true)
    })

    it("fails open for unmapped kinds even with a low role", () => {
      expect(canPerform("some.future.kind", ROLE.VIEWER)).toBe(true)
    })
  })
})
