/**
 * AQU-427 — Unit tests for the shared permission-denial helpers.
 */
import { describe, it, expect } from "vitest"
import { denialMessage, actionGateProps, type DenialT } from "./denial"
import { ROLE, resolveRoleName } from "@/lib/frontier/roles"
import { translate } from "@/lib/i18n/translate"

// Real English resolution (not a stub) — `translate(undefined, key, vars)`
// falls back to the base `en` catalog, so this exercises the actual
// `common.role.denial*` keys `denialMessage` composes, catching a broken key
// or missing placeholder the same way production would.
const t: DenialT = (key, vars) => translate(undefined, key, vars)

describe("denialMessage", () => {
  it("names the minimum role in the message when current level is unknown", () => {
    const msg = denialMessage(t, ROLE.CONTRIBUTOR, null)
    expect(msg).toContain(resolveRoleName(t, ROLE.CONTRIBUTOR))
    expect(msg).toMatch(/need at least/i)
  })

  it("names both the current role and minimum role when current level is known", () => {
    const msg = denialMessage(t, ROLE.CONTRIBUTOR, ROLE.VIEWER)
    expect(msg).toContain(resolveRoleName(t, ROLE.CONTRIBUTOR))
    expect(msg).toContain(resolveRoleName(t, ROLE.VIEWER, { plural: true }))
  })

  it("correctly names project_lead as the minimum role", () => {
    const msg = denialMessage(t, ROLE.PROJECT_LEAD, ROLE.REVIEWER)
    expect(msg).toContain(resolveRoleName(t, ROLE.PROJECT_LEAD))
    expect(msg).toContain(resolveRoleName(t, ROLE.REVIEWER, { plural: true }))
  })

  it("works with undefined current level (same as null)", () => {
    const msg = denialMessage(t, ROLE.COMMENTER, undefined)
    expect(msg).toContain(resolveRoleName(t, ROLE.COMMENTER))
    expect(msg).toMatch(/need at least/i)
  })

  it("AQU-623: names the current role with the plural permission vocabulary", () => {
    const msg = denialMessage(t, ROLE.CONTRIBUTOR, ROLE.VIEWER)
    // "Viewers cannot perform this action …" — plural role noun, not "your current role"
    expect(msg).toContain("Viewers cannot perform this action")
    expect(msg).toMatch(/need at least Contributor access/i)
  })

  it("AQU-832/WS-08: the plural role noun comes from the catalog's plural() form, not '+ \"s\"'", () => {
    // Regression guard for the exact bug this workstream fixed: naively
    // appending "s" to the singular label happens to look right for every
    // English role name, which is precisely why it's a silent trap — this
    // asserts the message goes through the catalog's `other` form instead.
    const msg = denialMessage(t, ROLE.CONTRIBUTOR, ROLE.PROJECT_LEAD)
    expect(msg).toContain("Project leads cannot perform this action")
    // The naive concatenation would have produced "Project_leads", which
    // this also rules out.
    expect(msg).not.toContain("Project_lead")
  })
})

describe("actionGateProps", () => {
  it("returns empty object when action is allowed", () => {
    const props = actionGateProps(true, "contributor")
    expect(props).toEqual({})
    expect(props.disabled).toBeUndefined()
  })

  it("returns disabled=true and a tooltip when action is denied", () => {
    const props = actionGateProps(false, "project_lead")
    expect(props.disabled).toBe(true)
    expect(props.tooltip).toBeTruthy()
    expect(props.tooltip).toContain("project_lead")
  })

  it("tooltip is human-readable (no role codes)", () => {
    const props = actionGateProps(false, "maintainer")
    expect(props.tooltip).not.toMatch(/\d{3}/)
    expect(props.tooltip).toContain("maintainer")
  })
})
