import { describe, it, expect } from "vitest"
import { ROLE, requiredRoleFor, canPerform, canOpenAssignUi, canSubmitAssignment } from "./role-policy"

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

  it("keeps the structural file.* kinds at the maintainer floor", () => {
    // Both relayout the timeline for every collaborator, so they sit a rung
    // above the contributor-level editing kinds. Drift here costs a redundant
    // 403 rather than a hole, but it defeats the guard — so pin both sides.
    expect(requiredRoleFor("file.timing.set")).toBe(ROLE.MAINTAINER)
    expect(requiredRoleFor("file.track.set")).toBe(ROLE.MAINTAINER)
    expect(requiredRoleFor("file.video.set")).toBe(ROLE.CONTRIBUTOR)
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

  // AQU-496: self-assignment carve-out for assignment.create.
  describe("canOpenAssignUi", () => {
    it("leads/maintainers/owners can always open the UI, regardless of allowSelfAssignment", () => {
      expect(canOpenAssignUi(ROLE.PROJECT_LEAD, false)).toBe(true)
      expect(canOpenAssignUi(ROLE.MAINTAINER, false)).toBe(true)
      expect(canOpenAssignUi(ROLE.OWNER, false)).toBe(true)
      expect(canOpenAssignUi(ROLE.PROJECT_LEAD, true)).toBe(true)
    })

    it("CONTRIBUTOR can open the UI only when allowSelfAssignment is on", () => {
      expect(canOpenAssignUi(ROLE.CONTRIBUTOR, false)).toBe(false)
      expect(canOpenAssignUi(ROLE.CONTRIBUTOR, true)).toBe(true)
    })

    it("below CONTRIBUTOR (viewer/commenter/reviewer) can never open the UI, even with allowSelfAssignment on", () => {
      expect(canOpenAssignUi(ROLE.VIEWER, true)).toBe(false)
      expect(canOpenAssignUi(ROLE.COMMENTER, true)).toBe(false)
      expect(canOpenAssignUi(ROLE.REVIEWER, true)).toBe(false)
    })

    it("fails closed (not open) when role is unknown — unlike canPerform's fail-open default", () => {
      expect(canOpenAssignUi(null, true)).toBe(false)
      expect(canOpenAssignUi(undefined, true)).toBe(false)
    })
  })

  describe("canSubmitAssignment", () => {
    it("leads/maintainers can assign to ANYONE, regardless of allowSelfAssignment", () => {
      expect(canSubmitAssignment(ROLE.PROJECT_LEAD, false, 1, 999)).toBe(true)
      expect(canSubmitAssignment(ROLE.MAINTAINER, false, 1, 999)).toBe(true)
    })

    it("CONTRIBUTOR can self-assign only when allowSelfAssignment is on", () => {
      expect(canSubmitAssignment(ROLE.CONTRIBUTOR, true, 1, 1)).toBe(true)
      expect(canSubmitAssignment(ROLE.CONTRIBUTOR, false, 1, 1)).toBe(false)
    })

    it("CONTRIBUTOR can NEVER assign to another user, even with allowSelfAssignment on", () => {
      expect(canSubmitAssignment(ROLE.CONTRIBUTOR, true, 1, 2)).toBe(false)
    })

    it("below CONTRIBUTOR can never self-assign, even with allowSelfAssignment on", () => {
      expect(canSubmitAssignment(ROLE.REVIEWER, true, 1, 1)).toBe(false)
      expect(canSubmitAssignment(ROLE.VIEWER, true, 1, 1)).toBe(false)
    })

    it("fails closed when callerUserId is unknown, even in self-assign mode", () => {
      expect(canSubmitAssignment(ROLE.CONTRIBUTOR, true, null, 1)).toBe(false)
      expect(canSubmitAssignment(ROLE.CONTRIBUTOR, true, undefined, 1)).toBe(false)
    })

    it("fails closed when roleLevel is unknown", () => {
      expect(canSubmitAssignment(null, true, 1, 1)).toBe(false)
    })
  })
})
