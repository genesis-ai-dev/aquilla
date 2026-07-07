import { describe, it, expect } from "vitest"
import {
  ROLE,
  ALL_ROLE_LEVELS,
  LINK_ROLE_ALLOWED,
  PROJECT_ROLE_PICKER,
  ORG_ROLE_PICKER,
  roleName,
  humanRoleName,
  roleDescription,
  PROJECT_ROLE_OPTIONS,
  ORG_ROLE_OPTIONS,
  LINK_ROLE_OPTIONS,
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

describe("humanRoleName (FRO-368)", () => {
  it("humanizes snake_case role names", () => {
    expect(humanRoleName(500)).toBe("Project lead")
    expect(humanRoleName(400)).toBe("Contributor")
    expect(humanRoleName(100)).toBe("Viewer")
  })

  it("never emits a bare numeric for unknown levels", () => {
    expect(humanRoleName(450)).toBe("Level 450")
  })
})
