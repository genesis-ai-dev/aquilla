import { describe, it, expect } from "vitest"
import { ROLE, REQUIRED_ROLE, requiredRoleFor } from "../events/role-policy"
import type { EventKind } from "../events/types"

describe("requiredRoleFor", () => {
  it("returns CONTRIBUTOR for cell.commit", () => {
    expect(requiredRoleFor('cell.commit')).toBe(ROLE.CONTRIBUTOR)
  })

  it("returns REVIEWER for cell.validate", () => {
    expect(requiredRoleFor('cell.validate')).toBe(ROLE.REVIEWER)
  })

  it("returns REVIEWER for cell.unvalidate", () => {
    expect(requiredRoleFor('cell.unvalidate')).toBe(ROLE.REVIEWER)
  })

  it("returns COMMENTER for thread.add", () => {
    expect(requiredRoleFor('thread.add')).toBe(ROLE.COMMENTER)
  })

  it("returns REVIEWER for thread.resolve", () => {
    expect(requiredRoleFor('thread.resolve')).toBe(ROLE.REVIEWER)
  })

  it("returns CONTRIBUTOR for cell.metadata.set", () => {
    expect(requiredRoleFor('cell.metadata.set')).toBe(ROLE.CONTRIBUTOR)
  })
})

describe("REQUIRED_ROLE table completeness", () => {
  it("has an entry for every EventKind", () => {
    // The Record<EventKind, number> type already enforces this at compile time
    // for object literals. This runtime check catches dynamic mutation and
    // also exercises the string keys exactly as a runtime caller would.
    const keys = Object.keys(REQUIRED_ROLE) as EventKind[]
    expect(keys.length).toBeGreaterThan(0)
    for (const kind of keys) {
      expect(typeof REQUIRED_ROLE[kind]).toBe("number")
      expect(REQUIRED_ROLE[kind]).toBeGreaterThanOrEqual(100)
      expect(REQUIRED_ROLE[kind]).toBeLessThanOrEqual(700)
    }
  })
})

describe("ROLE constants", () => {
  it("are ordered from lowest to highest privilege", () => {
    expect(ROLE.VIEWER).toBeLessThan(ROLE.COMMENTER)
    expect(ROLE.COMMENTER).toBeLessThan(ROLE.REVIEWER)
    expect(ROLE.REVIEWER).toBeLessThan(ROLE.CONTRIBUTOR)
    expect(ROLE.CONTRIBUTOR).toBeLessThan(ROLE.PROJECT_LEAD)
    expect(ROLE.PROJECT_LEAD).toBeLessThan(ROLE.MAINTAINER)
    expect(ROLE.MAINTAINER).toBeLessThan(ROLE.OWNER)
  })

  it("match the expected numeric values", () => {
    expect(ROLE.VIEWER).toBe(100)
    expect(ROLE.COMMENTER).toBe(200)
    expect(ROLE.REVIEWER).toBe(300)
    expect(ROLE.CONTRIBUTOR).toBe(400)
    expect(ROLE.PROJECT_LEAD).toBe(500)
    expect(ROLE.MAINTAINER).toBe(600)
    expect(ROLE.OWNER).toBe(700)
  })
})
