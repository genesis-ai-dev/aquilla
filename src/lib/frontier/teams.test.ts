import { describe, it, expect, afterEach, vi } from "vitest"
import { listTeams, getTeam } from "./teams"

const originalFetch = global.fetch
afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks() })

describe("teams API", () => {
  it("listTeams GETs the org groups endpoint", async () => {
    let url = ""
    global.fetch = vi.fn(async (input) => {
      url = typeof input === "string" ? input : (input as Request).url
      return new Response(JSON.stringify({ groups: [{ id: 10, name: "West Africa", memberCount: 2, projectCount: 1, viewerIsMember: true }] }), { status: 200 })
    }) as unknown as typeof fetch
    const teams = await listTeams("jwt", 1)
    expect(url).toMatch(/\/api\/v2\/orgs\/1\/groups$/)
    expect(teams[0]).toMatchObject({ id: 10, name: "West Africa", memberCount: 2 })
  })
  it("getTeam GETs the detail endpoint", async () => {
    let url = ""
    global.fetch = vi.fn(async (input) => {
      url = typeof input === "string" ? input : (input as Request).url
      return new Response(JSON.stringify({ id: 10, name: "West Africa", members: [{ userId: 1, username: "wendi", roleLevel: 700 }], projects: [{ id: "pa", name: "Bambara", grantedRoleLevel: 400 }] }), { status: 200 })
    }) as unknown as typeof fetch
    const detail = await getTeam("jwt", 1, 10)
    expect(url).toMatch(/\/api\/v2\/orgs\/1\/groups\/10$/)
    expect(detail.projects).toEqual([{ id: "pa", name: "Bambara", grantedRoleLevel: 400 }])
  })
})
