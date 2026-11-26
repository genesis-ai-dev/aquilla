/**
 * AQU-2320: the Give access picker and the server's dry run read one rule.
 * If a scope starts offering a rung it does not carry (a Maintainer on a lane,
 * Owner on a team), or a granter is offered a role above their own, the
 * dialog would let someone ask for a grant the write route then refuses — or
 * worse, one that route would accept. These pin the rule itself.
 */
import { describe, expect, it } from "vitest"
import { offeredRoles, placeGrantability, removalCheck, roleChangeOptions, type EditTarget, type GrantScopeType, type PlaceGrantability } from "./grant-rules"

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

/**
 * AQU-2321: the Places lens greys a role pill or an × for the same reason the
 * write route would refuse. If these drift from the routes, the lens offers a
 * change the server refuses — or hides one a person is allowed to make.
 */
const lead: PlaceGrantability = { ok: true, cap: 500 }
const maint: PlaceGrantability = { ok: true, cap: 600 }
const owner: PlaceGrantability = { ok: true, cap: 700 }
const someone = (roleLevel: number, extra: Partial<EditTarget> = {}): EditTarget => ({ roleLevel, isSelf: false, ...extra })

describe("roleChangeOptions", () => {
  it.each<[string, GrantScopeType, PlaceGrantability, EditTarget, ReturnType<typeof roleChangeOptions>]>([
    ["a Project lead's dropdown stops at Project lead (AC5)", "project", lead, someone(400), { ok: true, roles: [500, 400, 300, 200, 100] }],
    ["an Owner's project dropdown is the whole project ladder", "project", owner, someone(500), { ok: true, roles: [500, 400, 300, 200, 100] }],
    ["a Project lead cannot change a peer Project lead", "project", lead, someone(500), { ok: false, denial: "target_outranks", cap: 500 }],
    ["nobody changes their own project row", "project", owner, someone(300, { isSelf: true }), { ok: false, denial: "self", cap: 700 }],
    ["a team offers its own rungs under the cap", "team", maint, someone(100), { ok: true, roles: [600, 500, 100] }],
    ["a Maintainer cannot change a team role above theirs", "team", maint, someone(700), { ok: false, denial: "target_outranks", cap: 600 }],
    ["the org offers Owner and Maintainer to an Owner", "org", owner, someone(600), { ok: true, roles: [700, 600] }],
    ["lane rows belong to lane staffing", "lane", owner, someone(300), { ok: false, denial: "lane_needs_staffing", cap: 700 }],
    ["no Project lead, no dropdown", "project", { ok: false, denial: "lead_only" }, someone(300), { ok: false, denial: "lead_only", cap: null }],
  ])("%s", (_why, type, place, target, expected) => {
    expect(roleChangeOptions(type, place, target)).toEqual(expected)
  })
})

describe("removalCheck", () => {
  it.each<[string, GrantScopeType, PlaceGrantability, EditTarget, ReturnType<typeof removalCheck>]>([
    ["a project member is removed by a Maintainer there", "project", maint, someone(400), { ok: true }],
    ["a Project lead cannot remove project members (the route needs Maintainer)", "project", lead, someone(300), { ok: false, denial: "maintainer_on_project", cap: 500 }],
    ["a Maintainer cannot remove a peer Maintainer", "project", maint, someone(600), { ok: false, denial: "target_outranks", cap: 600 }],
    ["an Owner removes anyone on a project", "project", owner, someone(700), { ok: true }],
    ["a team member is removed by an org Maintainer, even on a team above them", "team", { ok: false, denial: "team_above_you" }, someone(100), { ok: true }],
    ["a team needs an org Maintainer to remove", "team", { ok: false, denial: "maintainer_only" }, someone(100), { ok: false, denial: "maintainer_only", cap: null }],
    ["an Owner cannot remove themselves from the org", "org", owner, someone(700, { isSelf: true }), { ok: false, denial: "self", cap: 700 }],
    ["a Project lead cancels a project invite", "project", lead, someone(400, { invite: true }), { ok: true }],
    ["lane rows belong to lane staffing", "lane", owner, someone(300), { ok: false, denial: "lane_needs_staffing", cap: 700 }],
  ])("%s", (_why, type, place, target, expected) => {
    expect(removalCheck(type, place, target)).toEqual(expected)
  })
})
