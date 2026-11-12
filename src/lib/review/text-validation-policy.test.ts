// AQU-1571: the client mirror of the server's three text-validation rules
// (sync-worker/src/events/route.ts, FRO-189). Where the two could drift, the
// mistake must fall towards letting the click through: the server refuses it
// anyway, while a wrong refusal here would lock a reader out of a vote.
import { describe, expect, it } from "vitest"
import {
  VALIDATION_ROLE_FLOOR,
  isOwnTextEdit,
  textValidationBlock,
  textValidationScope,
  textVoteGate,
} from "./text-validation-policy"
import { ROLE } from "@/lib/sync/role-policy"

const policy = (over: Partial<{ roleLevel: number | null; username: string }> = {}) =>
  ({ roleLevel: ROLE.CONTRIBUTOR as number | null, username: "ana", ...over })

describe("textValidationScope", () => {
  it("allows everyone when the project sets no rule", () => {
    expect(textValidationScope({}, policy())).toEqual({ canValidate: true, reason: null })
  })

  it("applies each tier of the minimum role at the server's levels", () => {
    expect(VALIDATION_ROLE_FLOOR).toEqual({ reviewer: 300, project_lead: 500, maintainer: 600 })
    const at = (floor: "reviewer" | "project_lead" | "maintainer", level: number) =>
      textValidationScope({ validationRoleFloor: floor }, policy({ roleLevel: level }))
    expect(at("reviewer", ROLE.REVIEWER).canValidate).toBe(true)
    expect(at("reviewer", ROLE.COMMENTER)).toEqual({ canValidate: false, reason: "role" })
    expect(at("project_lead", ROLE.CONTRIBUTOR)).toEqual({ canValidate: false, reason: "role" })
    expect(at("project_lead", ROLE.PROJECT_LEAD).canValidate).toBe(true)
    expect(at("maintainer", ROLE.PROJECT_LEAD)).toEqual({ canValidate: false, reason: "role" })
    expect(at("maintainer", ROLE.OWNER).canValidate).toBe(true)
  })

  // A local or git project has no role ladder; reading null as "below every
  // floor" would make validation impossible there instead of unrestricted.
  it("skips the floor when the viewer has no role", () => {
    expect(textValidationScope({ validationRoleFloor: "maintainer" }, policy({ roleLevel: null })).canValidate).toBe(true)
  })

  it("applies the named-validator list, an empty list meaning everyone", () => {
    expect(textValidationScope({ validationNamedUsers: ["bo"] }, policy())).toEqual({ canValidate: false, reason: "allowlist" })
    expect(textValidationScope({ validationNamedUsers: ["bo", "ana"] }, policy()).canValidate).toBe(true)
    expect(textValidationScope({ validationNamedUsers: [] }, policy()).canValidate).toBe(true)
    // The list still applies where the floor cannot (no roles).
    expect(textValidationScope({ validationNamedUsers: ["bo"] }, policy({ roleLevel: null })).canValidate).toBe(false)
  })

  it("checks the floor before the list, as the server does", () => {
    const project = { validationRoleFloor: "maintainer" as const, validationNamedUsers: ["bo"] }
    expect(textValidationScope(project, policy()).reason).toBe("role")
  })
})

describe("isOwnTextEdit", () => {
  it("is never true unless the project switched self-validation off", () => {
    expect(isOwnTextEdit({ lastEditor: "ana" }, "ana", true)).toBe(false)
    expect(isOwnTextEdit({ lastEditor: "ana" }, "ana", undefined)).toBe(false)
    expect(isOwnTextEdit({ lastEditor: "ana" }, "ana", false)).toBe(true)
  })

  // Unknown is never the viewer: old imported rows carry no editor, and
  // treating them as everybody's own would lock the whole team out of them.
  it("never matches an unknown editor", () => {
    expect(isOwnTextEdit({ lastEditor: null }, "ana", false)).toBe(false)
    expect(isOwnTextEdit({ lastEditor: "" }, "ana", false)).toBe(false)
    expect(isOwnTextEdit({}, "ana", false)).toBe(false)
    expect(isOwnTextEdit({ lastEditor: "" }, "", false)).toBe(false)
  })

  it("matches the viewer exactly, as the server compares", () => {
    expect(isOwnTextEdit({ lastEditor: "bo" }, "ana", false)).toBe(false)
    expect(isOwnTextEdit({ lastEditor: "Ana" }, "ana", false)).toBe(false)
  })
})

describe("textValidationBlock", () => {
  const project = { allowSelfValidation: false }

  it("is null when nothing refuses the vote", () => {
    expect(textValidationBlock({ lastEditor: "bo" }, project, policy())).toBeNull()
    expect(textValidationBlock({ lastEditor: "ana" }, {}, policy())).toBeNull()
  })

  it("names the viewer's own latest change", () => {
    expect(textValidationBlock({ lastEditor: "ana" }, project, policy())).toBe("self")
  })

  it("names a project rule first, whatever the line", () => {
    const strict = { ...project, validationRoleFloor: "project_lead" as const }
    expect(textValidationBlock({ lastEditor: "ana" }, strict, policy())).toBe("policy")
    expect(textValidationBlock({ lastEditor: "bo" }, strict, policy())).toBe("policy")
    expect(textValidationBlock({ lastEditor: "bo" }, { validationNamedUsers: ["bo"] }, policy())).toBe("policy")
  })
})

// AQU-1571: the agent pane's text vote control and its click handler both ask
// this one question, so the greyed control and the click cannot disagree.
describe("textVoteGate", () => {
  const viewer = (over: Partial<{ username: string; myScopes: { kind: "lane" | "file"; value: string }[]; activeLane: string }> = {}) =>
    ({ username: "ana", myScopes: [], activeLane: "", ...over })
  const project = (over: Record<string, unknown> = {}) =>
    ({ syncRole: { level: ROLE.CONTRIBUTOR, name: "contributor", source: "project" }, ...over }) as never
  const line = (over: Record<string, unknown> = {}) => ({ fileId: "f1", lastEditor: "bob", ...over })

  it("lets a contributor validate somebody else's line", () => {
    expect(textVoteGate(line(), project(), viewer())).toEqual({ canValidate: true, block: null })
  })

  it("blocks the reader's own latest change as 'self' when self-validation is off", () => {
    expect(textVoteGate(line({ lastEditor: "ana" }), project({ allowSelfValidation: false }), viewer()))
      .toEqual({ canValidate: false, block: "self" })
    expect(textVoteGate(line({ lastEditor: "ana" }), project({ allowSelfValidation: true }), viewer()))
      .toEqual({ canValidate: true, block: null })
  })

  it("blocks a reader the minimum role or named list excludes as 'policy'", () => {
    expect(textVoteGate(line(), project({ validationRoleFloor: "project_lead" }), viewer()))
      .toEqual({ canValidate: false, block: "policy" })
    expect(textVoteGate(line(), project({ validationNamedUsers: ["bob"] }), viewer()))
      .toEqual({ canValidate: false, block: "policy" })
  })

  it("refuses a role that cannot validate, or a line outside the reader's lanes, with no policy reason", () => {
    const commenter = project({ syncRole: { level: ROLE.COMMENTER, name: "c", source: "project" } })
    expect(textVoteGate(line(), commenter, viewer())).toEqual({ canValidate: false, block: null })
    expect(textVoteGate(line(), project(), viewer({ myScopes: [{ kind: "lane", value: "fr" }], activeLane: "es" })))
      .toEqual({ canValidate: false, block: null })
  })
})
