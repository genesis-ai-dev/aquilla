import { describe, it, expect } from "vitest"
import {
  ROLE,
  ALL_ROLE_LEVELS,
  LINK_ROLE_ALLOWED,
  PROJECT_ROLE_PICKER,
  ORG_ROLE_PICKER,
  roleName,
  roleNameKey,
  roleDescriptionKey,
  unknownRoleLabel,
  resolveRoleName,
  resolveRoleDescription,
  PROJECT_ROLE_OPTIONS,
  ORG_ROLE_OPTIONS,
  LINK_ROLE_OPTIONS,
  VALIDATION_FLOOR_ROLES,
  VALIDATION_FLOOR_ROLE_OPTIONS,
} from "./roles"
import { translate } from "@/lib/i18n/translate"
import type { DenialT } from "@/lib/permissions/denial"

// Real English resolution (not a stub), so these tests exercise the actual
// `common.role.*` catalog keys, not just the lookup logic.
const t: DenialT = (key, vars) => translate(undefined, key, vars)

// These assertions are the contract between the codex-web-app client and
// frontier-server's `ROLE_NAMES` / migration 0013. If the server's enum
// changes, the test failures here are the early-warning signal.

describe("ROLE constants", () => {
  it("has the seven canonical levels in ascending order", () => {
    expect(ALL_ROLE_LEVELS).toEqual([100, 200, 300, 400, 500, 600, 700])
  })

  it("matches the server's ROLE_NAMES mapping — the canonical name is NEVER translated", () => {
    // roleName() is the wire format / comparison key. It must read identically
    // regardless of locale — this is the one guarantee the whole catalog
    // migration (AQU-832 wave 3, WS-08) is not allowed to break.
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

  it("provides a description key for every canonical level, resolving to non-empty text", () => {
    for (const level of ALL_ROLE_LEVELS) {
      const key = roleDescriptionKey(level)
      expect(key).toBeDefined()
      expect(resolveRoleDescription(t, level)).not.toBe("")
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
  it("every option has a non-empty canonical name and resolves to non-empty display text", () => {
    for (const opt of [...PROJECT_ROLE_OPTIONS, ...ORG_ROLE_OPTIONS, ...LINK_ROLE_OPTIONS]) {
      expect(opt.name).not.toBe("")
      expect(t(opt.nameKey, { count: 1 })).not.toBe("")
      expect(t(opt.descriptionKey)).not.toBe("")
    }
  })
})

describe("role display helpers (resolveRoleName / resolveRoleDescription)", () => {
  it("resolves singular labels", () => {
    expect(resolveRoleName(t, ROLE.PROJECT_LEAD)).toBe("Project lead")
    expect(resolveRoleName(t, ROLE.CONTRIBUTOR)).toBe("Contributor")
    expect(resolveRoleName(t, ROLE.VIEWER)).toBe("Viewer")
  })

  it("resolves plural labels via the catalog's plural() form, not string concatenation", () => {
    expect(resolveRoleName(t, ROLE.VIEWER, { plural: true })).toBe("Viewers")
    expect(resolveRoleName(t, ROLE.PROJECT_LEAD, { plural: true })).toBe("Project leads")
  })

  it("accepts the canonical name string as well as the numeric level", () => {
    expect(resolveRoleName(t, "project_lead")).toBe("Project lead")
    expect(resolveRoleName(t, "owner", { plural: true })).toBe("Owners")
  })

  it("falls back to unknownRoleLabel for a non-canonical level — never a bare numeric", () => {
    expect(roleNameKey(450)).toBeUndefined()
    expect(resolveRoleName(t, 450)).toBe("Level 450")
    expect(unknownRoleLabel(450)).toBe("Level 450")
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

describe("AQU-832/WS-08: a role used for comparison keeps working when its label is translated", () => {
  // This is the regression this workstream can most plausibly introduce: if
  // `roleName()`/`.name` ever started returning a *translated* string, every
  // permission comparison, sort, and switch that keys on it would silently
  // break the moment a non-English locale renders. Simulate a "translated"
  // display layer (French labels) alongside the untouched canonical name and
  // assert comparisons still resolve correctly.
  const frenchLabel: Partial<Record<string, string>> = {
    "common.role.viewer": "Lecteur",
    "common.role.commenter": "Commentateur",
    "common.role.reviewer": "Réviseur",
    "common.role.contributor": "Contributeur",
    "common.role.projectLead": "Chef de projet",
    "common.role.maintainer": "Mainteneur",
    "common.role.owner": "Propriétaire",
  }
  const frenchTemplate: Partial<Record<string, string>> = {
    "common.role.denialUnknown": "Vous devez avoir au moins le rôle {minRole} pour faire cela.",
    "common.role.denialKnown": "{currentRole} ne peuvent pas effectuer cette action — rôle {minRole} requis.",
  }
  const frenchT: DenialT = (key, vars) => {
    const template = frenchLabel[key] ?? frenchTemplate[key]
    if (template === undefined) return "?"
    if (!vars) return template
    return template.replace(/\{(\w+)\}/g, (m, name: string) => String(vars[name] ?? m))
  }

  it("PROJECT_ROLE_PICKER caps at maintainer regardless of what locale is active", () => {
    // level comparisons never touch the catalog at all — they operate on the
    // numeric ladder, so this is trivially locale-independent; asserted here
    // as the baseline the rest of this block builds on.
    expect(Math.max(...PROJECT_ROLE_PICKER)).toBe(ROLE.MAINTAINER)
  })

  it("sorting RoleOptions by level is unaffected by the active display locale", () => {
    const shuffled = [...PROJECT_ROLE_OPTIONS].reverse()
    const sorted = [...shuffled].sort((a, b) => a.level - b.level)
    expect(sorted.map((o) => o.level)).toEqual([...PROJECT_ROLE_PICKER])
    // The translated label differs per locale, but `.name` — what a real
    // caller would sort or filter on — does not.
    expect(sorted.map((o) => o.name)).toEqual(sorted.map((o) => roleName(o.level)))
  })

  it("a caller-max-role gate (`level <= callerMaxRole`) is unaffected by translation", () => {
    const callerMaxRole = ROLE.CONTRIBUTOR
    const grantable = PROJECT_ROLE_OPTIONS.filter((r) => r.level <= callerMaxRole)
    expect(grantable.map((o) => o.name)).toEqual(["viewer", "commenter", "reviewer", "contributor"])
    // Rendering the same options in French changes every label, never the
    // gate's outcome.
    const frenchLabels = grantable.map((o) => frenchT(o.nameKey))
    expect(frenchLabels).toEqual(["Lecteur", "Commentateur", "Réviseur", "Contributeur"])
    expect(grantable.map((o) => o.name)).toEqual(["viewer", "commenter", "reviewer", "contributor"])
  })

  it("denialMessage composes a French sentence while the underlying levels/comparison stay numeric", async () => {
    const { denialMessage } = await import("@/lib/permissions/denial")
    const msg = denialMessage(frenchT, ROLE.CONTRIBUTOR, ROLE.VIEWER)
    expect(msg).toBe("Lecteur ne peuvent pas effectuer cette action — rôle Contributeur requis.")
    // The English comparison contract (English test above) is untouched by
    // this — same function, different `t`.
  })
})
