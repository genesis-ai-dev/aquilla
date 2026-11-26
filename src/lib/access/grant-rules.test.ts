/**
 * AQU-2320: the Give access picker and the server's dry run read one rule.
 * If a scope starts offering a rung it does not carry (a Maintainer on a lane,
 * Owner on a team), or a granter is offered a role above their own, the
 * dialog would let someone ask for a grant the write route then refuses — or
 * worse, one that route would accept. These pin the rule itself.
 */
import { describe, expect, it } from "vitest"
import { offeredRoles, placeGrantability, type GrantScopeType } from "./grant-rules"

describe("offeredRoles", () => {
  it.each<[GrantScopeType, number, boolean, number[]]>([
    // Spec §3.4 rungs, granter at Owner: everything the place carries.
    ["org", 700, false, [700, 600]],
    ["team", 700, false, [600, 500, 100]],
    ["project", 700, false, [500, 400, 300, 200, 100]],
    ["lane", 700, false, [400, 300, 100]],
    // A Project lead never sees a role above Project lead (AC1).
    ["project", 500, false, [500, 400, 300, 200, 100]],
    ["lane", 500, false, [400, 300, 100]],
    ["team", 500, false, [500, 100]],
    // A Contributor-level cap cuts the ladder at Contributor.
    ["project", 400, false, [400, 300, 200, 100]],
    // Invites: Owner is never handed over by a link; project/lane links cap at Contributor; no team invite.
    ["org", 700, true, [600]],
    ["project", 700, true, [400, 300, 200, 100]],
    ["lane", 600, true, [400, 300, 100]],
    ["team", 700, true, []],
  ])("%s at cap %i (invite %s) offers %j", (type, cap, invite, expected) => {
    expect(offeredRoles(type, cap, { invite })).toEqual(expected)
  })
})

describe("placeGrantability", () => {
  it.each<[string, GrantScopeType, Parameters<typeof placeGrantability>[1], ReturnType<typeof placeGrantability>]>([
    ["only an Owner grants at the org", "org", { orgRole: 600 }, { ok: false, denial: "owner_only" }],
    ["an Owner grants at the org up to Owner", "org", { orgRole: 700 }, { ok: true, cap: 700 }],
    ["a team needs an org Maintainer", "team", { orgRole: 500 }, { ok: false, denial: "maintainer_only" }],
    ["a Maintainer grants on a team up to their own role", "team", { orgRole: 600, teamTopProjectRole: 400 }, { ok: true, cap: 600 }],
    [
      "a team holding a project role above the granter is closed to them",
      "team",
      { orgRole: 600, teamTopProjectRole: 700 },
      { ok: false, denial: "team_above_you" },
    ],
    ["a project needs a Project lead there", "project", { orgRole: 700, projectRole: 400 }, { ok: false, denial: "lead_only" }],
    ["a Project lead grants on their project", "project", { orgRole: null, projectRole: 500 }, { ok: true, cap: 500 }],
    ["a lane follows its project", "lane", { orgRole: null, projectRole: 600 }, { ok: true, cap: 600 }],
  ])("%s", (_why, type, roles, expected) => {
    expect(placeGrantability(type, roles)).toEqual(expected)
  })
})
