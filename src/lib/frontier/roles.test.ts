import { describe, it, expect } from "vitest"
import {
  ROLE,
  ALL_ROLE_LEVELS,
  LINK_ROLE_ALLOWED,
  PROJECT_ROLE_PICKER,
  ORG_ROLE_PICKER,
  roleName,
  formatRoleDisplay,
  roleDisplayText,
  roleDisplayLabel,
  roleDescription,
  PROJECT_ROLE_OPTIONS,
  ORG_ROLE_OPTIONS,
  LINK_ROLE_OPTIONS,
  VALIDATION_FLOOR_ROLES,
  VALIDATION_FLOOR_ROLE_OPTIONS,
} from "./roles"

// These assertions are the contract between the codex-web-app client and
// frontier-server's `ROLE_NAMES` / migration 0013. If the server's enum
// changes, the test failures here are the early-warning signal.

describe("ROLE constants", () => {
  it("has the seven canonical levels in ascending order", () => {
    expect(ALL_ROLE_LEVELS).toEqual([100, 200, 300, 400, 500, 600, 700])
  })

  it("matches the server's ROLE_NAMES mapping", () => {
    expect(roleName(100)).toBe("viewer")
    expect(roleName(200)).toBe("commenter")
    expect(roleName(300)).toBe("reviewer")
    expect(roleName(400)).toBe("contributor")
    expect(roleName(500)).toBe("project_lead")
    expect(roleName(600)).toBe("maintainer")
    expect(roleName(700)).toBe("owner")
  })

  it("returns a sentinel name for non-canonical levels", () => {
    expect(roleName(250)).toBe("level_250")
    expect(roleName(0)).toBe("level_0")
  })

  it("provides a description for every canonical level", () => {
    for (const level of ALL_ROLE_LEVELS) {
      expect(roleDescription(level)).not.toBe("")
    }
  })
})

describe("LINK_ROLE_ALLOWED", () => {
  it("never includes managerial roles (project_lead and up)", () => {
    expect(LINK_ROLE_ALLOWED).not.toContain(ROLE.PROJECT_LEAD)
    expect(LINK_ROLE_ALLOWED).not.toContain(ROLE.MAINTAINER)
    expect(LINK_ROLE_ALLOWED).not.toContain(ROLE.OWNER)
  })

  it("caps at contributor", () => {
    const max = Math.max(...LINK_ROLE_ALLOWED)
    expect(max).toBe(ROLE.CONTRIBUTOR)
  })
})

describe("picker subsets", () => {
  it("PROJECT_ROLE_PICKER excludes owner", () => {
    expect(PROJECT_ROLE_PICKER).not.toContain(ROLE.OWNER)
  })

  it("ORG_ROLE_PICKER excludes commenter, reviewer, and owner", () => {
    expect(ORG_ROLE_PICKER).not.toContain(ROLE.COMMENTER)
    expect(ORG_ROLE_PICKER).not.toContain(ROLE.REVIEWER)
    expect(ORG_ROLE_PICKER).not.toContain(ROLE.OWNER)
  })
})

describe("ROLE_OPTIONS shapes", () => {
  it("project options match the picker order", () => {
    expect(PROJECT_ROLE_OPTIONS.map((o) => o.level)).toEqual([...PROJECT_ROLE_PICKER])
  })
  it("org options match the picker order", () => {
    expect(ORG_ROLE_OPTIONS.map((o) => o.level)).toEqual([...ORG_ROLE_PICKER])
  })
  it("link options match the link-allowed list", () => {
    expect(LINK_ROLE_OPTIONS.map((o) => o.level)).toEqual([...LINK_ROLE_ALLOWED])
  })
  it("every option has a non-empty name and description", () => {
    for (const opt of [...PROJECT_ROLE_OPTIONS, ...ORG_ROLE_OPTIONS, ...LINK_ROLE_OPTIONS]) {
      expect(opt.name).not.toBe("")
      expect(opt.description).not.toBe("")
    }
  })
})

describe("VALIDATION_FLOOR_ROLE_OPTIONS (AQU-352)", () => {
  // Regression guard for AQU-352: the "Minimum validator role" dropdown must
  // draw its labels from the canonical role source, so they read identically to
  // the member / invite / share surfaces (which render `roleName`). Any future
  // re-hardcoding of prettified labels ("Project Lead", "Reviewer (default)")
  // is exactly the taxonomy drift this ticket fixed.
  it("offers reviewer and up as an intentional subset (reviewer/project_lead/maintainer)", () => {
    expect(VALIDATION_FLOOR_ROLES).toEqual([
      ROLE.REVIEWER,
      ROLE.PROJECT_LEAD,
      ROLE.MAINTAINER,
    ])
  })

  it("labels each option with the canonical role name — no renaming", () => {
    expect(VALIDATION_FLOOR_ROLE_OPTIONS.map((o) => o.name)).toEqual([
      "reviewer",
      "project_lead",
      "maintainer",
    ])
    for (const opt of VALIDATION_FLOOR_ROLE_OPTIONS) {
      expect(opt.name).toBe(roleName(opt.level))
    }
  })

  it("is a strict subset of the project role taxonomy shown on member surfaces", () => {
    const projectNames = new Set(PROJECT_ROLE_OPTIONS.map((o) => o.name))
    for (const opt of VALIDATION_FLOOR_ROLE_OPTIONS) {
      expect(projectNames.has(opt.name)).toBe(true)
    }
  })
})

describe("role display helpers", () => {
  it("formatRoleDisplay replaces underscores with spaces", () => {
    expect(formatRoleDisplay("project_lead")).toBe("project lead")
    expect(formatRoleDisplay("owner")).toBe("owner")
  })

  it("roleDisplayText title-cases each word", () => {
    expect(roleDisplayText("project_lead")).toBe("Project Lead")
    expect(roleDisplayText("owner")).toBe("Owner")
  })

  it("roleDisplayLabel maps levels to title-cased labels", () => {
    expect(roleDisplayLabel(500)).toBe("Project Lead")
    expect(roleDisplayLabel(700)).toBe("Owner")
  })
})
