import { describe, expect, it } from "vitest"
import { ROLE, planGroupImport, type GitLabSubgroupNode } from "./groups"
import { orgLegacyUuidFor, projectIdFor, teamLegacyUuidFor } from "./ids"
import { planCanonicalUserAccess } from "./user-access"

const tops = [
  { id: 10, name: "Org A", full_path: "org-a" },
  { id: 20, name: "Org B", full_path: "org-b" },
]
const subgroups: GitLabSubgroupNode[] = [
  { id: 11, name: "Team A", full_path: "org-a/team-a", topLevelId: 10 },
  { id: 12, name: "Team B", full_path: "org-a/team-b", topLevelId: 10 },
  { id: 13, name: "Nested", full_path: "org-a/team-a/nested", topLevelId: 10 },
]
const existing = {
  orgUuids: new Set([orgLegacyUuidFor(10), orgLegacyUuidFor(20)]),
  teamUuids: new Set([
    teamLegacyUuidFor(11),
    teamLegacyUuidFor(12),
    teamLegacyUuidFor(13),
  ]),
  projectIds: new Set([projectIdFor("91", "gitlab")]),
}

describe("planCanonicalUserAccess", () => {
  it("reuses the full planner's top-level role and subgroup-only cap", () => {
    const plan = planCanonicalUserAccess({
      username: "cleiton",
      topGroups: tops,
      subgroups,
      memberships: [
        { source_type: "Namespace", source_id: 10, access_level: 40 },
        { source_type: "Namespace", source_id: 11, access_level: 50 },
        { source_type: "Project", source_id: 91, access_level: 30 },
      ],
      existing,
    })

    expect(plan.conflicts).toEqual([])
    expect(plan.orgMemberships).toEqual([
      { orgUuid: orgLegacyUuidFor(10), roleLevel: ROLE.MAINTAINER },
    ])
    expect(plan.teamUuids).toEqual([
      teamLegacyUuidFor(11),
      teamLegacyUuidFor(12),
      teamLegacyUuidFor(13),
    ].sort())
    expect(plan.projectMemberships).toEqual([
      { projectId: projectIdFor("91", "gitlab"), roleLevel: ROLE.CONTRIBUTOR },
    ])
  })

  it("matches the full group importer for the same GitLab facts", () => {
    const full = planGroupImport({
      topGroups: tops,
      subgroups,
      membersByGroupId: new Map([
        [10, [
          { userId: 7, username: "owner", access_level: 50 },
          { userId: 42, username: "cleiton", access_level: 30 },
        ]],
        [11, [{ userId: 42, username: "cleiton", access_level: 40 }]],
        [12, [
          { userId: 8, username: "other", access_level: 30 },
          { userId: 42, username: "cleiton", access_level: 30 },
        ]],
        [13, [{ userId: 42, username: "cleiton", access_level: 40 }]],
        [20, [{ userId: 9, username: "owner-b", access_level: 50 }]],
      ]),
      existing: {
        orgUuids: existing.orgUuids,
        teamUuids: existing.teamUuids,
      },
    })
    const single = planCanonicalUserAccess({
      username: "cleiton",
      topGroups: tops,
      subgroups,
      memberships: [
        { source_type: "Namespace", source_id: 10, access_level: 30 },
        { source_type: "Namespace", source_id: 11, access_level: 40 },
      ],
      existing,
    })

    expect(single.orgMemberships).toEqual(
      full.orgMembers
        .filter((member) => member.userId === 42)
        .map(({ orgUuid, roleLevel }) => ({ orgUuid, roleLevel })),
    )
    expect(single.teamUuids).toEqual(
      full.teamMembers
        .filter((member) => member.userId === 42)
        .map((member) => member.teamUuid)
        .sort(),
    )
  })

  it("plans a subgroup-only member against an existing org without inventing an owner", () => {
    const plan = planCanonicalUserAccess({
      username: "translator",
      topGroups: tops,
      subgroups,
      memberships: [
        { source_type: "Namespace", source_id: 12, access_level: 50 },
      ],
      existing,
    })

    expect(plan.conflicts).toEqual([])
    expect(plan.orgMemberships).toEqual([
      { orgUuid: orgLegacyUuidFor(10), roleLevel: ROLE.CONTRIBUTOR },
    ])
    expect(plan.teamUuids).toEqual([teamLegacyUuidFor(12)])
  })

  it("expands a direct parent-group membership through every descendant team", () => {
    const plan = planCanonicalUserAccess({
      username: "inherited-member",
      topGroups: tops,
      subgroups,
      memberships: [
        { source_type: "Namespace", source_id: 10, access_level: 20 },
      ],
      existing,
    })

    expect(plan.conflicts).toEqual([])
    expect(plan.orgMemberships).toEqual([
      { orgUuid: orgLegacyUuidFor(10), roleLevel: ROLE.REVIEWER },
    ])
    expect(plan.teamUuids).toEqual([
      teamLegacyUuidFor(11),
      teamLegacyUuidFor(12),
      teamLegacyUuidFor(13),
    ].sort())
  })

  it("fails closed when a referenced org, group, or project is absent", () => {
    const plan = planCanonicalUserAccess({
      username: "new-user",
      topGroups: tops,
      subgroups,
      memberships: [
        { source_type: "Namespace", source_id: 11, access_level: 30 },
        { source_type: "Project", source_id: 99, access_level: 30 },
      ],
      existing: { orgUuids: new Set(), teamUuids: new Set(), projectIds: new Set() },
    })

    expect(plan.conflicts).not.toEqual([])
    expect(plan.conflicts.join(" ")).toMatch(/organization|project/i)
  })

  it("accepts a confirmed user with no GitLab memberships", () => {
    const plan = planCanonicalUserAccess({
      username: "no-access",
      topGroups: tops,
      subgroups,
      memberships: [],
      existing,
    })
    expect(plan).toEqual({
      orgMemberships: [],
      teamUuids: [],
      projectMemberships: [],
      conflicts: [],
      confirmedMembershipCount: 0,
    })
  })
})
