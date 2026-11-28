/**
 * AQU-2321: every removal goes through the route that owns the grant and
 * names the person by userId, so it lands on the account the dry run
 * described — and each of those routes sends the live-session eject. A role
 * change by name writes the roster's username and checks the account written.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

import { changeGrantRole, removeGrants } from "./edit-access-data"

const mocks = vi.hoisted(() => {
  const state = { calls: [] as unknown[][], fail: null as string | null, written: { userId: 2 } as unknown, inviteRemoved: true }
  const record = (name: string) => (...args: unknown[]) => {
    state.calls.push([name, ...args])
    if (state.fail === name) return Promise.reject(new Error(name))
    if (name === "addOrgMember" || name === "addProjectMember") return Promise.resolve(state.written)
    if (name === "revokeProjectInvite") return Promise.resolve(state.inviteRemoved)
    return Promise.resolve()
  }
  return { state, record }
})
const { state } = mocks
vi.mock("@/lib/frontier/orgs", () => ({
  addOrgMember: mocks.record("addOrgMember"),
  removeOrgMember: mocks.record("removeOrgMember"),
  revokeProjectInvite: mocks.record("revokeProjectInvite"),
}))
vi.mock("@/lib/frontier/invites", () => ({ revokeOrgInvite: mocks.record("revokeOrgInvite") }))
vi.mock("@/lib/frontier/members", () => ({ addProjectMember: mocks.record("addProjectMember"), removeProjectMember: mocks.record("removeProjectMember") }))
vi.mock("@/lib/frontier/teams", () => ({ removeTeamMember: mocks.record("removeTeamMember"), setTeamMemberRole: mocks.record("setTeamMemberRole") }))

beforeEach(() => {
  state.calls.length = 0
  state.fail = null
  state.written = { userId: 2 }
  state.inviteRemoved = true
})

describe("removeGrants", () => {
  it("sends each grant to its own route, by userId, in order", async () => {
    const outcome = await removeGrants("jwt", 1, { userId: "2" }, [{ type: "team", id: "3" }, { type: "project", id: "q1" }, { type: "org", id: "1" }])
    expect(outcome).toEqual({ done: 3, total: 3, error: null })
    expect(state.calls).toEqual([
      ["removeTeamMember", "jwt", 1, 3, 2],
      ["removeProjectMember", "jwt", "q1", 2],
      ["removeOrgMember", "jwt", 1, 2],
    ])
  })

  it("stops at the first failure and says how far it got", async () => {
    state.fail = "removeProjectMember"
    const outcome = await removeGrants("jwt", 1, { userId: "2" }, [{ type: "team", id: "3" }, { type: "project", id: "q1" }, { type: "org", id: "1" }])
    expect(outcome.done).toBe(1)
    expect(outcome.total).toBe(3)
    expect(outcome.error).toBeInstanceOf(Error)
    expect(state.calls.map((c) => c[0])).toEqual(["removeTeamMember", "removeProjectMember"])
  })

  it("cancels an org or project invite by its token, and an invite already gone is a failure", async () => {
    await removeGrants("jwt", 1, { inviteId: "invite:org:tok-a" }, [])
    await removeGrants("jwt", 1, { inviteId: "invite:project:q1:tok-b" }, [])
    expect(state.calls).toEqual([["revokeOrgInvite", "jwt", 1, "tok-a"], ["revokeProjectInvite", "jwt", "q1", "tok-b"]])
    state.inviteRemoved = false
    expect((await removeGrants("jwt", 1, { inviteId: "invite:project:q1:tok-b" }, [])).error).not.toBeNull()
  })
})

describe("changeGrantRole", () => {
  it("changes a team role by userId, and an org or project role by the roster's username (no lanes named, so lanes stay)", async () => {
    const person = { userId: "2", username: "member-login" }
    await changeGrantRole("jwt", 1, person, { type: "team", id: "3" }, 500)
    await changeGrantRole("jwt", 1, person, { type: "project", id: "p1" }, 300)
    await changeGrantRole("jwt", 1, person, { type: "org", id: "1" }, 600)
    expect(state.calls).toEqual([
      ["setTeamMemberRole", "jwt", 1, 3, 2, 500],
      ["addProjectMember", "jwt", "p1", "member-login", 300],
      ["addOrgMember", "jwt", 1, "member-login", 600],
    ])
  })

  it("refuses without a username, and fails loudly when the route wrote another account", async () => {
    await expect(changeGrantRole("jwt", 1, { userId: "2", username: null }, { type: "project", id: "p1" }, 300)).rejects.toThrow()
    expect(state.calls).toEqual([])
    state.written = { userId: 99 }
    await expect(changeGrantRole("jwt", 1, { userId: "2", username: "member-login" }, { type: "project", id: "p1" }, 300)).rejects.toThrow()
  })
})
