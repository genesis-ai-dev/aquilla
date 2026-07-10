/**
 * FRO-427 — Unit tests for the shared permission-denial helpers.
 */
import { describe, it, expect } from "vitest"
import { denialMessage, actionGateProps } from "./denial"
import { ROLE, roleDisplayText, roleName } from "@/lib/frontier/roles"

describe("denialMessage", () => {
  it("names the minimum role in the message when current level is unknown", () => {
    const msg = denialMessage(ROLE.CONTRIBUTOR, null)
    expect(msg).toContain(roleDisplayText(roleName(ROLE.CONTRIBUTOR)))
    expect(msg).toMatch(/need at least/i)
  })

  it("names both the current role and minimum role when current level is known", () => {
    const msg = denialMessage(ROLE.CONTRIBUTOR, ROLE.VIEWER)
    expect(msg).toContain(roleDisplayText(roleName(ROLE.CONTRIBUTOR)))
    expect(msg).toContain(roleDisplayText(roleName(ROLE.VIEWER)))
  })

  it("correctly names project_lead as the minimum role", () => {
    const msg = denialMessage(ROLE.PROJECT_LEAD, ROLE.REVIEWER)
    expect(msg).toContain(roleDisplayText(roleName(ROLE.PROJECT_LEAD)))
    expect(msg).toContain(roleDisplayText(roleName(ROLE.REVIEWER)))
  })

  it("works with undefined current level (same as null)", () => {
    const msg = denialMessage(ROLE.COMMENTER, undefined)
    expect(msg).toContain(roleDisplayText(roleName(ROLE.COMMENTER)))
    expect(msg).toMatch(/need at least/i)
  })
})

describe("actionGateProps", () => {
  it("returns empty object when action is allowed", () => {
    const props = actionGateProps(true, "contributor")
    expect(props).toEqual({})
    expect(props.disabled).toBeUndefined()
  })

  it("returns disabled=true and a title when action is denied", () => {
    const props = actionGateProps(false, "project_lead")
    expect(props.disabled).toBe(true)
    expect(props.title).toBeTruthy()
    expect(props.title).toContain("project_lead")
  })

  it("title is human-readable (no role codes)", () => {
    const props = actionGateProps(false, "maintainer")
    expect(props.title).not.toMatch(/\d{3}/)
    expect(props.title).toContain("maintainer")
  })
})
