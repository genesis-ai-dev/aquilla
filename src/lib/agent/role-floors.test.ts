/**
 * role-floors tests — the Apply gate must refuse exactly what the server
 * refuses and nothing more.
 *
 * The security-relevant case is AQU-1630's: a project with
 * "Allow self-validation" off refuses a `cell.validate` from the line's own
 * last editor (sync-worker/src/events/route.ts, FRO-189 check #3). The role
 * floor cannot see it — `cell.validate` only needs REVIEWER — so without the
 * self rule the card offered a button that was guaranteed to 403.
 *
 * The rest of the cases pin the fail-open posture: we block only when the
 * refusal is provable from what the client knows.
 */

import { describe, it, expect } from "vitest"
import { canApply, canApplyStagedEvent, ROLE } from "./role-floors"
import type { RoleT } from "@/lib/frontier/roles"

/** Stand-in for the i18n `t` — returns the key so assertions stay readable. */
const tr: RoleT = (key) => key

const VALIDATE = { kind: "cell.validate", cellId: "c-1" }
const SELF_BLOCKED = "agent.validation.selfValidationBlocked"

describe("canApplyStagedEvent — role floor", () => {
  it("defers to canApply when the role is below the floor", () => {
    const verdict = canApplyStagedEvent(tr, VALIDATE, ROLE.VIEWER)
    expect(verdict.allowed).toBe(false)
    expect(verdict).toEqual(canApply(tr, "cell.validate", ROLE.VIEWER))
  })

  it("allows a role at or above the floor when no self rule applies", () => {
    expect(canApplyStagedEvent(tr, VALIDATE, ROLE.REVIEWER).allowed).toBe(true)
  })
})

describe("canApplyStagedEvent — self-validation (AQU-1630)", () => {
  const gate = {
    allowSelfValidation: false,
    username: "anna",
    resolveLastEditor: (cellId: string) => (cellId === "c-1" ? "anna" : "bob"),
  }

  it("blocks validating a line the viewer last edited, with a reason", () => {
    const verdict = canApplyStagedEvent(tr, VALIDATE, ROLE.REVIEWER, gate)
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toBe(SELF_BLOCKED)
  })

  it("allows validating a line somebody else last edited", () => {
    expect(
      canApplyStagedEvent(tr, { kind: "cell.validate", cellId: "c-2" }, ROLE.REVIEWER, gate).allowed,
    ).toBe(true)
  })

  it("leaves other event kinds alone", () => {
    expect(
      canApplyStagedEvent(tr, { kind: "target.cell.commit", cellId: "c-1" }, ROLE.CONTRIBUTOR, gate)
        .allowed,
    ).toBe(true)
  })

  it("does not block when the project allows self-validation", () => {
    expect(
      canApplyStagedEvent(tr, VALIDATE, ROLE.REVIEWER, { ...gate, allowSelfValidation: true }).allowed,
    ).toBe(true)
  })

  it("does not block when the setting is unknown", () => {
    expect(
      canApplyStagedEvent(tr, VALIDATE, ROLE.REVIEWER, { ...gate, allowSelfValidation: undefined })
        .allowed,
    ).toBe(true)
  })

  it("does not block when the cell is not loaded — the server stays authoritative", () => {
    expect(
      canApplyStagedEvent(tr, VALIDATE, ROLE.REVIEWER, { ...gate, resolveLastEditor: () => undefined })
        .allowed,
    ).toBe(true)
  })

  it("does not block when the line has no last editor yet", () => {
    expect(
      canApplyStagedEvent(tr, VALIDATE, ROLE.REVIEWER, { ...gate, resolveLastEditor: () => null })
        .allowed,
    ).toBe(true)
  })

  it("does not block when the current user is unknown", () => {
    expect(
      canApplyStagedEvent(tr, VALIDATE, ROLE.REVIEWER, { ...gate, username: "" }).allowed,
    ).toBe(true)
  })

  it("keeps the role refusal ahead of the self reason when both apply", () => {
    const verdict = canApplyStagedEvent(tr, VALIDATE, ROLE.VIEWER, gate)
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).not.toBe(SELF_BLOCKED)
  })
})
