import { describe, it, expect, vi, afterEach } from "vitest"
import {
  getAdminMe,
  getAdminOverview,
  getAdminOrgs,
  getAdminUsers,
  getAdminProjects,
  getAdminActivity,
} from "./admin"

const ORIG = global.fetch

afterEach(() => {
  global.fetch = ORIG
})

function mockJson(body: unknown, status = 200): void {
  global.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

describe("getAdminMe", () => {
  it("returns true when isPlatformAdmin is set", async () => {
    let url = ""
    global.fetch = vi.fn(async (i: unknown) => {
      url = typeof i === "string" ? i : (i as Request).url
      return new Response(JSON.stringify({ isPlatformAdmin: true, username: "root" }), { status: 200 })
    }) as unknown as typeof fetch
    expect(await getAdminMe("jwt")).toBe(true)
    expect(url).toMatch(/\/api\/v2\/admin\/me$/)
  })

  it("returns false (not throw) on 403 and 401", async () => {
    global.fetch = vi.fn(async () => new Response("nope", { status: 403 })) as unknown as typeof fetch
    expect(await getAdminMe("jwt")).toBe(false)
    global.fetch = vi.fn(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch
    expect(await getAdminMe("jwt")).toBe(false)
  })

  it("throws on unexpected server error (human message, not 'HTTP 500')", async () => {
    global.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch
    const err = await getAdminMe("jwt").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toMatch(/HTTP\s*500/)
    expect((err as Error).name).toBe("UserError")
  })
})

describe("admin list endpoints unwrap their envelope", () => {
  it("getAdminOverview returns the object verbatim", async () => {
    mockJson({ orgs: 2, users: 3, activeProjects: 4, archivedProjects: 1, activeUsers7d: 1 })
    expect(await getAdminOverview("jwt")).toMatchObject({ orgs: 2, users: 3 })
  })

  it("getAdminOrgs unwraps { orgs }", async () => {
    mockJson({ orgs: [{ id: 1, name: "CAS" }] })
    expect(await getAdminOrgs("jwt")).toHaveLength(1)
  })

  it("getAdminUsers unwraps { users }", async () => {
    mockJson({ users: [{ id: 1, username: "wendi" }] })
    expect((await getAdminUsers("jwt"))[0].username).toBe("wendi")
  })

  it("getAdminProjects unwraps { projects }", async () => {
    mockJson({ projects: [{ id: "p", name: "John" }] })
    expect((await getAdminProjects("jwt"))[0].id).toBe("p")
  })

  it("getAdminActivity passes the limit and unwraps { activity }", async () => {
    let url = ""
    global.fetch = vi.fn(async (i: unknown) => {
      url = typeof i === "string" ? i : (i as Request).url
      return new Response(JSON.stringify({ activity: [{ id: 9 }] }), { status: 200 })
    }) as unknown as typeof fetch
    const res = await getAdminActivity("jwt", 50)
    expect(res).toHaveLength(1)
    expect(url).toMatch(/\/api\/v2\/admin\/activity\?limit=50$/)
  })

  it("throws on non-OK status (human message, not 'HTTP 403')", async () => {
    global.fetch = vi.fn(async () => new Response("x", { status: 403 })) as unknown as typeof fetch
    const err = await getAdminOrgs("jwt").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toMatch(/HTTP\s*403/)
    expect((err as Error).name).toBe("UserError")
  })
})
