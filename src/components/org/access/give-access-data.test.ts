/**
 * AQU-2320: submitGrant writes ONE grant through the route that already owns
 * that kind of place, so every cap those routes enforce still applies. If a
 * kind of place were sent to the wrong route — a lane as a whole-project
 * grant, an email as a username lookup — the person would get more (or
 * other) access than the sentence on screen said.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { PersonChoice, PlaceRow } from "@/lib/access/give-access"
import type { ScopeRef } from "@/lib/access/types"
import { submitGrant } from "./give-access-data"

const mocks = vi.hoisted(() => {
  const state = { calls: [] as unknown[][], inviteResult: { token: "t" } as unknown }
  const record = (name: string) => (...args: unknown[]) => {
    state.calls.push([name, ...args])
    return Promise.resolve(name === "createServerInvite" ? state.inviteResult : [{ ok: true }])
  }
  return { state, record }
})
const { state } = mocks
vi.mock("@/lib/frontier/orgs", () => ({ addOrgMember: mocks.record("addOrgMember"), createOrgInvite: mocks.record("createOrgInvite") }))
vi.mock("@/lib/frontier/members", () => ({ addProjectMember: mocks.record("addProjectMember") }))
vi.mock("@/lib/frontier/teams", () => ({ addTeamMembers: mocks.record("addTeamMembers"), setTeamMemberRole: mocks.record("setTeamMemberRole") }))
vi.mock("@/lib/sync/invites", () => ({ createServerInvite: mocks.record("createServerInvite") }))

const org: ScopeRef = { type: "org", id: "1", name: "Org" }
const team: ScopeRef = { type: "team", id: "7", name: "Team" }
const project: ScopeRef = { type: "project", id: "p1", name: "Project" }
const lane: ScopeRef = { type: "lane", id: "fr01", name: "French" }
const row = (scope: ScopeRef, path: ScopeRef[]): PlaceRow => ({
  key: `${scope.type}:${scope.id}`, scope, path, depth: path.length - 1, projectId: scope.type === "lane" ? "p1" : scope.type === "project" ? "p1" : undefined, grantable: { ok: true, cap: 700 },
})
const guest: PersonChoice = { kind: "account", userId: "9", displayName: "naladda", email: null, isGuest: true }
const invite: PersonChoice = { kind: "invite", email: "new@example.com" }

beforeEach(() => {
  state.calls.length = 0
  state.inviteResult = { token: "t" }
})

describe("submitGrant", () => {
  it.each<[string, PersonChoice, PlaceRow, number, unknown[][]]>([
    ["org account → org members", guest, row(org, [org]), 600, [["addOrgMember", "jwt", 1, "naladda", 600]]],
    ["team account → join (a guest stays outside the org) then set the team role", guest, row(team, [org, team]), 600, [
      ["addTeamMembers", "jwt", 1, 7, ["naladda"], { external: true }],
      ["setTeamMemberRole", "jwt", 1, 7, 9, 600],
    ]],
    ["project account → project member on every current lane", guest, row(project, [org, project]), 300, [["addProjectMember", "jwt", "p1", "naladda", 300, { allCurrentLanes: true }]]],
    ["lane account → project member narrowed to that lane", guest, row(lane, [org, project, lane]), 300, [["addProjectMember", "jwt", "p1", "naladda", 300, { scopeLanes: ["fr01"] }]]],
    ["org email → org invite", invite, row(org, [org]), 600, [["createOrgInvite", "jwt", 1, { email: "new@example.com", role: 600 }]]],
    ["project email → project invite for every lane", invite, row(project, [org, project]), 300, [["createServerInvite", "jwt", "p1", 300, undefined, "new@example.com", undefined, undefined, true]]],
    ["lane email → project invite for that lane", invite, row(lane, [org, project, lane]), 300, [["createServerInvite", "jwt", "p1", 300, undefined, "new@example.com", undefined, ["fr01"], undefined]]],
  ])("%s", async (_why, person, place, roleLevel, expected) => {
    await submitGrant("jwt", 1, { person, roleLevel, place })
    expect(state.calls).toEqual(expected)
  })

  it("a project invite the server did not create is a failure, not a silent success", async () => {
    state.inviteResult = null
    await expect(submitGrant("jwt", 1, { person: invite, roleLevel: 300, place: row(project, [org, project]) })).rejects.toThrow()
  })
})
