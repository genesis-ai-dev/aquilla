import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { OrgsReadError, fetchUserOrgs, fetchOrgMembers } from "./orgs-read"

const originalFetch = global.fetch
beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { global.fetch = originalFetch })

describe("fetchUserOrgs", () => {
  it("returns the MyOrg payload on 200", async () => {
    const myOrg = { id: 1, name: "Acme", role: { level: 700, name: "owner" } }
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(myOrg), { status: 200 }),
    ) as unknown as typeof fetch
    const out = await fetchUserOrgs("jwt", "https://auth.example.com")
    expect(out).toEqual(myOrg)
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toBe("https://auth.example.com/api/v2/orgs/me")
  })

  it("throws on non-2xx", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("err", { status: 500 }),
    ) as unknown as typeof fetch
    await expect(fetchUserOrgs("jwt", "https://auth.example.com")).rejects.toBeInstanceOf(
      OrgsReadError,
    )
  })
})

describe("fetchOrgMembers", () => {
  it("returns the members array", async () => {
    const members = [
      { userId: 1, username: "alice", role: { level: 600, name: "maintainer" } },
    ]
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ members }), { status: 200 }),
    ) as unknown as typeof fetch
    const out = await fetchOrgMembers(42, "jwt", "https://auth.example.com")
    expect(out).toEqual(members)
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toBe("https://auth.example.com/api/v2/orgs/42/members")
  })

  it("throws on non-2xx", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("err", { status: 403 }),
    ) as unknown as typeof fetch
    await expect(fetchOrgMembers(42, "jwt", "https://auth.example.com")).rejects.toBeInstanceOf(
      OrgsReadError,
    )
  })
})
