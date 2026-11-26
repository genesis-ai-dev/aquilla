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
  const state = { calls: [] as unknown[][], inviteResult: { token: "t" } as unknown, writtenUserId: null as number | null }
  const record = (name: string) => (...args: unknown[]) => {
    state.calls.push([name, ...args])
    if (name === "createServerInvite") return Promise.resolve(state.inviteResult)
    if (name === "addOrgMember" || name === "addProjectMember") {
      return Promise.resolve(state.writtenUserId == null ? undefined : { userId: state.writtenUserId })
    }
    return Promise.resolve([{ ok: true }])
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
const guest: PersonChoice = { kind: "account", userId: "9", displayName: "naladda", username: "naladda", email: null, isGuest: true }
const invite: PersonChoice = { kind: "invite", email: "new@example.com" }

beforeEach(() => {
  state.calls.length = 0
  state.inviteResult = { token: "t" }
  state.writtenUserId = null
})

describe("submitGrant", () => {
  it.each<[string, PersonChoice, PlaceRow, number, unknown[][]]>([
    ["org account → org members", guest, row(org, [org]), 600, [["addOrgMember", "jwt", 1, "naladda", 600]]],
    ["team account → join (a guest stays outside the org) then set the team role", guest, row(team, [org, team]), 600, [
      ["addTeamMembers", "jwt", 1, 7, ["naladda"], { external: true }],
      ["setTeamMemberRole", "jwt", 1, 7, 9, 600],
    ]],
    ["project account → project member on every current lane", guest, row(project, [org, project]), 300, [["addProjectMember", "jwt", "p1", "naladda", 300, { allCurrentLanes: true }]]],
    ["org email → org invite", invite, row(org, [org]), 600, [["createOrgInvite", "jwt", 1, { email: "new@example.com", role: 600 }]]],
    ["project email → project invite for every lane", invite, row(project, [org, project]), 300, [["createServerInvite", "jwt", "p1", 300, undefined, "new@example.com", undefined, undefined, true]]],
    ["lane email → project invite for that lane", invite, row(lane, [org, project, lane]), 300, [["createServerInvite", "jwt", "p1", 300, undefined, "new@example.com", undefined, ["fr01"], undefined]]],
  ])("%s", async (_why, person, place, roleLevel, expected) => {
    await submitGrant("jwt", 1, { person, roleLevel, place })
    expect(state.calls).toEqual(expected)
  })

  it("AQU-2322: a lane account goes to the additive lane-grant route by userId, never as a lane-scoped membership", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ granted: {} }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    try {
      await submitGrant("jwt", 1, { person: guest, roleLevel: 300, place: row(lane, [org, project, lane]) })
    } finally {
      vi.unstubAllGlobals()
    }
    expect(state.calls).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/api\/v2\/orgs\/1\/access\/lane-grant$/)
    expect(init.method).toBe("PUT")
    expect(JSON.parse(String(init.body))).toEqual({ laneId: "fr01", userId: "9", roleLevel: 300 })
  })

  it("writes the account the dry run named: by its username, never by a display name two people can share", async () => {
    // Two people can both be shown as "Sam". The dry run named userId 21; the
    // routes look an account up by username, so the write must carry sam-two's.
    const samTwo: PersonChoice = { kind: "account", userId: "21", displayName: "Sam", username: "sam-two", email: null, isGuest: false }
    for (const place of [row(org, [org]), row(team, [org, team]), row(project, [org, project])]) {
      state.calls.length = 0
      await submitGrant("jwt", 1, { person: samTwo, roleLevel: 600, place })
      const names = state.calls.flatMap((call) => call.slice(1)).flat()
      expect(names).toContain("sam-two")
      expect(names).not.toContain("Sam")
    }
  })

  it("refuses to write when the payload carried no username, and fails loudly when the route wrote someone else", async () => {
    const nameless: PersonChoice = { ...guest, username: null }
    await expect(submitGrant("jwt", 1, { person: nameless, roleLevel: 300, place: row(project, [org, project]) })).rejects.toThrow()
    expect(state.calls).toEqual([])

    state.writtenUserId = 99
    await expect(submitGrant("jwt", 1, { person: guest, roleLevel: 300, place: row(project, [org, project]) })).rejects.toThrow()
  })

  it("a project invite the server did not create is a failure, not a silent success", async () => {
    state.inviteResult = null
    await expect(submitGrant("jwt", 1, { person: invite, roleLevel: 300, place: row(project, [org, project]) })).rejects.toThrow()
  })
})
