import { describe, it, expect } from "vitest"
import { ROLE, REQUIRED_ROLE, requiredRoleFor } from "../events/role-policy"
import type { EventKind } from "../events/types"

describe("requiredRoleFor — target.* (translator)", () => {
  it("returns CONTRIBUTOR for target.cell.create", () => {
    expect(requiredRoleFor('target.cell.create')).toBe(ROLE.CONTRIBUTOR)
  })

  it("returns CONTRIBUTOR for target.cell.commit", () => {
    expect(requiredRoleFor('target.cell.commit')).toBe(ROLE.CONTRIBUTOR)
  })

  it("returns CONTRIBUTOR for target.cell.delete", () => {
    expect(requiredRoleFor('target.cell.delete')).toBe(ROLE.CONTRIBUTOR)
  })

  it("returns CONTRIBUTOR for target.cell.reorder", () => {
    expect(requiredRoleFor('target.cell.reorder')).toBe(ROLE.CONTRIBUTOR)
  })
})

describe("requiredRoleFor — source.* (importer / admin)", () => {
  it("returns PROJECT_LEAD for source.cell.create", () => {
    expect(requiredRoleFor('source.cell.create')).toBe(ROLE.PROJECT_LEAD)
  })

  it("returns PROJECT_LEAD for source.cell.commit", () => {
    expect(requiredRoleFor('source.cell.commit')).toBe(ROLE.PROJECT_LEAD)
  })

  it("returns PROJECT_LEAD for source.cell.delete", () => {
    expect(requiredRoleFor('source.cell.delete')).toBe(ROLE.PROJECT_LEAD)
  })

  it("returns PROJECT_LEAD for source.cell.reorder", () => {
    expect(requiredRoleFor('source.cell.reorder')).toBe(ROLE.PROJECT_LEAD)
  })
})

describe("requiredRoleFor — validation", () => {
  it("returns REVIEWER for cell.validate", () => {
    expect(requiredRoleFor('cell.validate')).toBe(ROLE.REVIEWER)
  })

  it("returns REVIEWER for cell.unvalidate", () => {
    expect(requiredRoleFor('cell.unvalidate')).toBe(ROLE.REVIEWER)
  })
})

describe("requiredRoleFor — file.create", () => {
  it("returns PROJECT_LEAD for file.create", () => {
    expect(requiredRoleFor('file.create')).toBe(ROLE.PROJECT_LEAD)
  })
})

describe("REQUIRED_ROLE table completeness", () => {
  it("has an entry for every EventKind", () => {
    const keys = Object.keys(REQUIRED_ROLE) as EventKind[]
    expect(keys.length).toBeGreaterThan(0)
    for (const kind of keys) {
      expect(typeof REQUIRED_ROLE[kind]).toBe("number")
      expect(REQUIRED_ROLE[kind]).toBeGreaterThanOrEqual(100)
      expect(REQUIRED_ROLE[kind]).toBeLessThanOrEqual(700)
    }
  })

  it("covers all current EventKind values explicitly (no implicit ROLE)", () => {
    const expected: EventKind[] = [
      'source.cell.create',
      'source.cell.commit',
      'source.cell.delete',
      'source.cell.reorder',
      'target.cell.create',
      'target.cell.commit',
      'target.cell.delete',
      'target.cell.reorder',
      'cell.validate',
      'cell.unvalidate',
      'file.create',
    ]
    for (const kind of expected) {
      expect(REQUIRED_ROLE).toHaveProperty(kind)
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
