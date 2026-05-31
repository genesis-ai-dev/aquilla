import { describe, it, expect, afterEach, vi } from "vitest"
import { listTeams, getTeam, createTeam, updateTeam, deleteTeam, addTeamMember, removeTeamMember, attachProject, changeProjectRole, detachProject } from "./teams"

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

describe("teams mutations", () => {
  function captureFetch(responseBody: unknown = {}) {
    const calls: { url: string; method: string; body: string | null }[] = []
    global.fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url
      calls.push({ url, method: (init?.method as string) ?? "GET", body: (init?.body as string) ?? null })
      return new Response(JSON.stringify(responseBody), { status: 200 })
    }) as unknown as typeof fetch
    return calls
  }

  it("createTeam POSTs name + description", async () => {
    const calls = captureFetch({ id: 5, name: "WA", description: "d" })
    const t = await createTeam("jwt", 1, "WA", "d")
    expect(calls[0]).toMatchObject({ method: "POST" })
    expect(calls[0].url).toMatch(/\/api\/v2\/orgs\/1\/groups$/)
    expect(JSON.parse(calls[0].body!)).toEqual({ name: "WA", description: "d" })
    expect(t).toEqual({ id: 5, name: "WA", description: "d" })
  })

  it("updateTeam PATCHes the group", async () => {
    const calls = captureFetch({ id: 5, name: "New", description: null })
    await updateTeam("jwt", 1, 5, { name: "New" })
    expect(calls[0].method).toBe("PATCH")
    expect(calls[0].url).toMatch(/\/groups\/5$/)
    expect(JSON.parse(calls[0].body!)).toEqual({ name: "New" })
  })

  it("deleteTeam DELETEs the group", async () => {
    const calls = captureFetch({ removed: true })
    await deleteTeam("jwt", 1, 5)
    expect(calls[0].method).toBe("DELETE")
    expect(calls[0].url).toMatch(/\/groups\/5$/)
  })

  it("addTeamMember POSTs a username", async () => {
    const calls = captureFetch({ userId: 2, username: "anna" })
    await addTeamMember("jwt", 1, 5, "anna")
    expect(calls[0].url).toMatch(/\/groups\/5\/members$/)
    expect(JSON.parse(calls[0].body!)).toEqual({ username: "anna" })
  })

  it("removeTeamMember DELETEs by userId", async () => {
    const calls = captureFetch({ removed: true })
    await removeTeamMember("jwt", 1, 5, 2)
    expect(calls[0].method).toBe("DELETE")
    expect(calls[0].url).toMatch(/\/groups\/5\/members\/2$/)
  })

  it("attachProject POSTs projectId + roleLevel", async () => {
    const calls = captureFetch({ projectId: "pa", roleLevel: 400 })
    await attachProject("jwt", 1, 5, "pa", 400)
    expect(calls[0].url).toMatch(/\/groups\/5\/projects$/)
    expect(JSON.parse(calls[0].body!)).toEqual({ projectId: "pa", roleLevel: 400 })
  })

  it("changeProjectRole PATCHes the grant", async () => {
    const calls = captureFetch({ projectId: "pa", roleLevel: 300 })
    await changeProjectRole("jwt", 1, 5, "pa", 300)
    expect(calls[0].method).toBe("PATCH")
    expect(calls[0].url).toMatch(/\/groups\/5\/projects\/pa$/)
  })

  it("detachProject DELETEs the grant", async () => {
    const calls = captureFetch({ removed: true })
    await detachProject("jwt", 1, 5, "pa")
    expect(calls[0].method).toBe("DELETE")
    expect(calls[0].url).toMatch(/\/groups\/5\/projects\/pa$/)
  })
})
