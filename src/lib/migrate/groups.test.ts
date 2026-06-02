import { describe, it, expect } from "vitest"
import {
  planGroupImport,
  mapTopLevelAccess,
  ROLE,
  GITLAB_ACCESS,
  SUBGROUP_ONLY_ROLE,
  type GroupImportInput,
  type ResolvedMember,
} from "./groups"
import { orgLegacyUuidFor, teamLegacyUuidFor } from "./ids"

const member = (userId: number | null, username: string, access: number): ResolvedMember => ({
  userId,
  username,
  access_level: access,
})

function buildInput(over: Partial<GroupImportInput> = {}): GroupImportInput {
  return {
    topGroups: over.topGroups ?? [{ id: 1, name: "Acme", full_path: "acme" }],
    subgroups: over.subgroups ?? [],
    membersByGroupId: over.membersByGroupId ?? new Map(),
    existing: over.existing ?? { orgUuids: new Set(), teamUuids: new Set() },
  }
}

describe("mapTopLevelAccess", () => {
  it("maps the GitLab access ladder onto the Aquilla role ladder", () => {
    expect(mapTopLevelAccess(GITLAB_ACCESS.OWNER)).toBe(ROLE.OWNER)
    expect(mapTopLevelAccess(GITLAB_ACCESS.MAINTAINER)).toBe(ROLE.MAINTAINER)
    expect(mapTopLevelAccess(GITLAB_ACCESS.DEVELOPER)).toBe(ROLE.CONTRIBUTOR)
    expect(mapTopLevelAccess(GITLAB_ACCESS.REPORTER)).toBe(ROLE.REVIEWER)
    expect(mapTopLevelAccess(GITLAB_ACCESS.GUEST)).toBe(ROLE.VIEWER)
  })
})

describe("planGroupImport — org + owner", () => {
  it("maps a top-level group to an org owned by its GitLab Owner", () => {
    const plan = planGroupImport(
      buildInput({
        membersByGroupId: new Map([[1, [member(7, "owner", GITLAB_ACCESS.OWNER)]]]),
      }),
    )
    expect(plan.orgs).toHaveLength(1)
    expect(plan.orgs[0]).toMatchObject({ legacyUuid: orgLegacyUuidFor(1), name: "Acme", ownerUserId: 7 })
  })

  it("picks the owner deterministically: highest access, then lowest user id", () => {
    // Two Owners — lowest user id wins so re-runs agree.
    const plan = planGroupImport(
      buildInput({
        membersByGroupId: new Map([
          [1, [member(9, "b", GITLAB_ACCESS.OWNER), member(3, "a", GITLAB_ACCESS.OWNER)]],
        ]),
      }),
    )
    expect(plan.orgs[0].ownerUserId).toBe(3)
  })

  it("surfaces a conflict and skips the org when no member resolves to an account", () => {
    const plan = planGroupImport(
      buildInput({ membersByGroupId: new Map([[1, [member(null, "ghost", GITLAB_ACCESS.OWNER)]]]) }),
    )
    expect(plan.orgs).toHaveLength(0)
    expect(plan.conflicts.some((c) => c.kind === "no-owner")).toBe(true)
  })
})

describe("planGroupImport — the decisive permission rule", () => {
  // The whole point: a subgroup Owner must NOT gain org-wide authority. If this
  // test passes with the cap removed, the business rule isn't actually enforced.
  it("caps a subgroup-only Owner at contributor, never org owner/maintainer", () => {
    const plan = planGroupImport(
      buildInput({
        subgroups: [{ id: 2, name: "team-a", full_path: "acme/team-a", topLevelId: 1 }],
        membersByGroupId: new Map([
          [1, [member(1, "topowner", GITLAB_ACCESS.OWNER)]], // owns the top group
          [2, [member(5, "subowner", GITLAB_ACCESS.OWNER)]], // Owner of the subgroup only
        ]),
      }),
    )
    const sub = plan.orgMembers.find((m) => m.userId === 5)
    expect(sub?.roleLevel).toBe(SUBGROUP_ONLY_ROLE)
    expect(sub?.roleLevel).toBeLessThan(ROLE.MAINTAINER)
    // ...and they are not the org owner.
    expect(plan.orgs[0].ownerUserId).toBe(1)
  })

  it("keeps a user's top-level role even if they are also in a subgroup", () => {
    const plan = planGroupImport(
      buildInput({
        subgroups: [{ id: 2, name: "t", full_path: "acme/t", topLevelId: 1 }],
        membersByGroupId: new Map([
          [1, [member(1, "u", GITLAB_ACCESS.MAINTAINER)]], // top-level Maintainer → 600
          [2, [member(1, "u", GITLAB_ACCESS.GUEST)]], // also a subgroup guest
        ]),
      }),
    )
    expect(plan.orgMembers.find((m) => m.userId === 1)?.roleLevel).toBe(ROLE.MAINTAINER)
  })
})

describe("planGroupImport — teams", () => {
  it("flattens every subgroup to a team named by its full path, with its direct members", () => {
    const plan = planGroupImport(
      buildInput({
        subgroups: [
          { id: 2, name: "team-a", full_path: "acme/team-a", topLevelId: 1 },
          { id: 3, name: "deep", full_path: "acme/team-a/deep", topLevelId: 1 }, // nested → still flat
        ],
        membersByGroupId: new Map([
          [1, [member(1, "o", GITLAB_ACCESS.OWNER)]],
          [2, [member(5, "x", GITLAB_ACCESS.DEVELOPER)]],
          [3, [member(6, "y", GITLAB_ACCESS.DEVELOPER)]],
        ]),
      }),
    )
    expect(plan.teams.map((t) => t.name).sort()).toEqual(["acme/team-a", "acme/team-a/deep"])
    expect(plan.teamMembers).toContainEqual({ teamUuid: teamLegacyUuidFor(2), userId: 5 })
    expect(plan.teamMembers).toContainEqual({ teamUuid: teamLegacyUuidFor(3), userId: 6 })
  })

  it("adds subgroup-only members to org_members so the group_member FK precondition holds", () => {
    const plan = planGroupImport(
      buildInput({
        subgroups: [{ id: 2, name: "t", full_path: "acme/t", topLevelId: 1 }],
        membersByGroupId: new Map([
          [1, [member(1, "o", GITLAB_ACCESS.OWNER)]],
          [2, [member(5, "x", GITLAB_ACCESS.DEVELOPER)]],
        ]),
      }),
    )
    expect(plan.orgMembers.some((m) => m.userId === 5)).toBe(true)
  })
})

describe("planGroupImport — idempotency", () => {
  it("does not re-emit orgs/teams that already exist, but still plans their members", () => {
    const plan = planGroupImport(
      buildInput({
        subgroups: [{ id: 2, name: "t", full_path: "acme/t", topLevelId: 1 }],
        membersByGroupId: new Map([
          [1, [member(1, "o", GITLAB_ACCESS.OWNER)]],
          [2, [member(5, "x", GITLAB_ACCESS.DEVELOPER)]],
        ]),
        existing: {
          orgUuids: new Set([orgLegacyUuidFor(1)]),
          teamUuids: new Set([teamLegacyUuidFor(2)]),
        },
      }),
    )
    expect(plan.orgs).toHaveLength(0)
    expect(plan.teams).toHaveLength(0)
    expect(plan.orgMembers.length).toBeGreaterThan(0)
    expect(plan.teamMembers.length).toBeGreaterThan(0)
  })
})
