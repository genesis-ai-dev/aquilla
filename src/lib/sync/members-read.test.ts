import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { fetchProjectMembers, MembersReadError } from "./members-read"

const originalFetch = global.fetch
beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { global.fetch = originalFetch })

describe("fetchProjectMembers", () => {
  it("returns the members array", async () => {
    const members = [
      {
        userId: 1,
        username: "alice",
        role: { level: 700, name: "owner", source: "creator" },
      },
    ]
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ members }), { status: 200 }),
    ) as unknown as typeof fetch
    const out = await fetchProjectMembers("p1", "jwt", "https://auth.example.com")
    expect(out).toEqual(members)
  })

  it("throws MembersReadError on 403", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("nope", { status: 403 }),
    ) as unknown as typeof fetch
    await expect(
      fetchProjectMembers("p1", "jwt", "https://auth.example.com"),
    ).rejects.toBeInstanceOf(MembersReadError)
  })
})
