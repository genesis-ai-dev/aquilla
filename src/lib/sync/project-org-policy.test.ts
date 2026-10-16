// AQU-1771: a project's surfaces apply the org policy carried on the project's
// own settings response. The case that mattered most: a member who is in the
// project but not in its org cannot read the org's settings, and the browser
// read that refusal as the built-in defaults — repetition copying ON in a
// project whose org had turned it OFF, so their validations wrote copies.
import { describe, it, expect } from "vitest"
import {
  effectiveRepetitionPropagation,
  resolveProjectPolicy,
  type OrgSettingsFallback,
  type ProjectOrgPolicy,
  type ProjectVisibilityFloors,
} from "./project-org-policy"

/** What useOrgSettings hands back when the org read was refused: fetched, no server row, defaults. */
const refusedOrgRead: OrgSettingsFallback = {
  hasFetched: true,
  version: null,
  rosterViewMinRole: 600,
  memberProgressViewMinRole: 600,
  allowSelfAssignment: false,
  allowScopedLaneAssignment: false,
  assignmentMinRole: 500,
  autoPropagateRepetitions: true,
  exportMinRole: null,
  canExport: true,
}

const carriedPolicy: ProjectOrgPolicy = {
  rosterViewMinRole: 400,
  memberProgressViewMinRole: 400,
  allowSelfAssignment: true,
  allowScopedLaneAssignment: true,
  assignmentMinRole: 400,
  autoPropagateRepetitions: false,
  exportMinRole: 500,
}

const carriedFloors: ProjectVisibilityFloors = {
  rosterViewMinRole: { org: 400, project: 600, effective: 600 },
  memberProgressViewMinRole: { org: 400, project: null, effective: 400 },
}

describe("resolveProjectPolicy — a project-only member (AQU-1771)", () => {
  it("uses the org values carried on the project's settings, not the refused org read's defaults", () => {
    const policy = resolveProjectPolicy({
      orgPolicy: carriedPolicy,
      visibilityFloors: carriedFloors,
      projectSettings: {},
      org: refusedOrgRead,
      roleLevel: 400,
    })
    expect(policy).toMatchObject({
      ready: true,
      carried: true,
      allowSelfAssignment: true,
      allowScopedLaneAssignment: true,
      assignmentMinRole: 400,
      autoPropagateRepetitions: false,
      exportMinRole: 500,
      canExport: false,
    })
    expect(policy.rosterViewMinRole).toEqual({ org: 400, project: 600, effective: 600 })
    expect(policy.memberProgressViewMinRole.effective).toBe(400)
  })

  it("never copies repetitions when the org turned it off and the project says nothing", () => {
    const policy = resolveProjectPolicy({
      orgPolicy: carriedPolicy,
      visibilityFloors: carriedFloors,
      projectSettings: {},
      org: refusedOrgRead,
      roleLevel: 400,
    })
    expect(effectiveRepetitionPropagation(undefined, policy)).toBe(false)
    // The project's own answer still wins either way.
    expect(effectiveRepetitionPropagation(true, policy)).toBe(true)
  })

  it("on a server that does not carry the policy, a refused org read never switches repetition copying on", () => {
    const policy = resolveProjectPolicy({
      orgPolicy: undefined,
      visibilityFloors: undefined,
      projectSettings: {},
      org: refusedOrgRead,
      roleLevel: 400,
    })
    expect(policy.carried).toBe(false)
    expect(effectiveRepetitionPropagation(undefined, policy)).toBe(false)
  })
})

describe("resolveProjectPolicy — fallback to the org read (older server)", () => {
  const readOrg: OrgSettingsFallback = { ...refusedOrgRead, version: 3, autoPropagateRepetitions: true }

  it("follows a real org answer", () => {
    const policy = resolveProjectPolicy({
      orgPolicy: null,
      visibilityFloors: null,
      projectSettings: {},
      org: readOrg,
      roleLevel: 600,
    })
    expect(policy.ready).toBe(true)
    expect(effectiveRepetitionPropagation(undefined, policy)).toBe(true)
  })

  it("applies the project's own floors only where stricter than the org's", () => {
    const policy = resolveProjectPolicy({
      orgPolicy: null,
      visibilityFloors: null,
      projectSettings: { rosterViewMinRole: 700, memberProgressViewMinRole: 400 },
      org: readOrg,
      roleLevel: 600,
    })
    expect(policy.rosterViewMinRole).toEqual({ org: 600, project: 700, effective: 700 })
    expect(policy.memberProgressViewMinRole).toEqual({ org: 600, project: null, effective: 600 })
  })

  it("is not ready, on a synced project, before the project's own settings land", () => {
    // The org read alone says Maintainer; the project may still be stricter.
    const policy = resolveProjectPolicy({
      orgPolicy: null,
      visibilityFloors: null,
      projectSettings: null,
      org: readOrg,
      roleLevel: 600,
      projectSettingsFetched: false,
    })
    expect(policy.ready).toBe(false)
  })

  it("is not ready before the org read lands", () => {
    const policy = resolveProjectPolicy({
      orgPolicy: null,
      visibilityFloors: null,
      projectSettings: null,
      org: { ...readOrg, hasFetched: false, version: null },
      roleLevel: 600,
    })
    expect(policy.ready).toBe(false)
    expect(policy.autoPropagateRepetitions).toBe(false)
  })
})
