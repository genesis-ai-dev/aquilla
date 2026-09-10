import { describe, it, expect } from "vitest"
import {
  ROLE,
  requiredRoleFor,
  canPerform,
  canOpenAssignUi,
  canSubmitAssignment,
  foreignRoleFor,
  effectiveCommentRoleFor,
  canMutateComment,
} from "./role-policy"

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

  // ── AQU-1000: the foreign-comment floor ─────────────────────────────────
  //
  // REGRESSION GUARD. The mirror used to carry only the self floors, so
  // `canPerform("comment.resolve", 200)` said yes for EVERY thread — including
  // ones the caller did not write, which the server refuses. The UI believed
  // it, offered Resolve, flipped the thread optimistically, and the 403 flipped
  // it back. Resolve authority is a function of (role, who wrote the thread);
  // anything that collapses it back to role alone reintroduces the bug.
  describe("foreign-comment floors (AQU-1000)", () => {
    it("carries a second, higher floor for acting on someone else's comment", () => {
      // Closing a thread is bookkeeping and is reversible, so it sits lower
      // than rewriting or destroying what another person actually said.
      expect(foreignRoleFor("comment.resolve")).toBe(ROLE.CONTRIBUTOR)
      expect(foreignRoleFor("comment.edit")).toBe(ROLE.MAINTAINER)
      expect(foreignRoleFor("comment.delete")).toBe(ROLE.MAINTAINER)
    })

    it("keeps the self floor at commenter — lowering the foreign bar never raises the self one", () => {
      expect(effectiveCommentRoleFor("comment.resolve", true)).toBe(ROLE.COMMENTER)
      expect(effectiveCommentRoleFor("comment.edit", true)).toBe(ROLE.COMMENTER)
    })

    it("applies the foreign floor on a thread the caller did not write", () => {
      expect(effectiveCommentRoleFor("comment.resolve", false)).toBe(ROLE.CONTRIBUTOR)
      expect(effectiveCommentRoleFor("comment.edit", false)).toBe(ROLE.MAINTAINER)
    })

    it("lets a commenter resolve their OWN thread but not a foreign one", () => {
      expect(canMutateComment("comment.resolve", ROLE.COMMENTER, true)).toBe(true)
      expect(canMutateComment("comment.resolve", ROLE.COMMENTER, false)).toBe(false)
    })

    it("denies a reviewer a foreign resolve — 300 is still below the contributor bar", () => {
      expect(canMutateComment("comment.resolve", ROLE.REVIEWER, false)).toBe(false)
      expect(canMutateComment("comment.resolve", ROLE.REVIEWER, true)).toBe(true)
    })

    it("lets a contributor resolve any thread", () => {
      expect(canMutateComment("comment.resolve", ROLE.CONTRIBUTOR, true)).toBe(true)
      expect(canMutateComment("comment.resolve", ROLE.CONTRIBUTOR, false)).toBe(true)
    })

    it("still refuses a contributor a foreign EDIT or DELETE (unchanged, no regression)", () => {
      expect(canMutateComment("comment.edit", ROLE.CONTRIBUTOR, false)).toBe(false)
      expect(canMutateComment("comment.delete", ROLE.CONTRIBUTOR, false)).toBe(false)
      expect(canMutateComment("comment.edit", ROLE.MAINTAINER, false)).toBe(true)
      expect(canMutateComment("comment.delete", ROLE.MAINTAINER, false)).toBe(true)
    })

    it("refuses a viewer either way — below even the self floor", () => {
      expect(canMutateComment("comment.resolve", ROLE.VIEWER, true)).toBe(false)
      expect(canMutateComment("comment.resolve", ROLE.VIEWER, false)).toBe(false)
    })

    it("fails open on an unknown role and an unmapped kind", () => {
      // Local / git-imported projects have no sync role; the server is still
      // authoritative, so we never block on a guess.
      expect(canMutateComment("comment.resolve", null, false)).toBe(true)
      expect(foreignRoleFor("some.future.kind")).toBeNull()
      expect(effectiveCommentRoleFor("some.future.kind", false)).toBeNull()
      expect(canMutateComment("some.future.kind", ROLE.VIEWER, false)).toBe(true)
    })
  })

  it("keeps the structural file.* kinds at the maintainer floor", () => {
    // Both relayout the timeline for every collaborator, so they sit a rung
    // above the contributor-level editing kinds. Drift here costs a redundant
    // 403 rather than a hole, but it defeats the guard — so pin both sides.
    expect(requiredRoleFor("file.timing.set")).toBe(ROLE.MAINTAINER)
    expect(requiredRoleFor("file.track.set")).toBe(ROLE.MAINTAINER)
  })

  it("keeps sidebar folder moves at the file.rename floor", () => {
    expect(requiredRoleFor("file.corpus.set")).toBe(ROLE.CONTRIBUTOR)
    expect(canPerform("file.corpus.set", ROLE.CONTRIBUTOR)).toBe(true)
    expect(canPerform("file.corpus.set", ROLE.REVIEWER)).toBe(false)
  })

  // ── The setup/handoff line (AQU-646, Sam 2026-08-18) ────────────────────
  //
  // The client's own process settles the film, the cue pairings and the
  // character sheets BEFORE handing the project to translators and dubbers.
  // Those people are contributors, and none of these three is theirs to
  // change: each one silently rewrites what everybody else is working against.
  it("keeps project SETUP above the contributors who receive the handoff", () => {
    expect(requiredRoleFor("file.video.set")).toBe(ROLE.PROJECT_LEAD)
    expect(requiredRoleFor("cell.link.set")).toBe(ROLE.PROJECT_LEAD)
  })

  it("refuses both for a contributor, and allows them for a lead", () => {
    for (const kind of ["file.video.set", "cell.link.set"]) {
      expect(canPerform(kind, ROLE.CONTRIBUTOR)).toBe(false)
      expect(canPerform(kind, ROLE.PROJECT_LEAD)).toBe(true)
    }
  })

  it("puts the characters above even a project lead (Sam, 2026-08-20)", () => {
    // Characters are one person's job here: the client's producer owns the
    // sheets and holds maintainer, and nobody below her reconciles them. A
    // lead can still link the film and cut the pairings — this is the one
    // piece of setup that went a rung higher than the rest.
    expect(requiredRoleFor("cast.assign")).toBe(ROLE.MAINTAINER)
    expect(canPerform("cast.assign", ROLE.PROJECT_LEAD)).toBe(false)
    expect(canPerform("cast.assign", ROLE.MAINTAINER)).toBe(true)
  })

  it("knows about cast.assign at all", () => {
    // It was absent from this mirror until 2026-08-18. `canPerform` fails open
    // on an unknown kind, so the character-import button's own permission check
    // returned true for every role and the server's 403 was the only guard.
    expect(requiredRoleFor("cast.assign")).not.toBeNull()
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
