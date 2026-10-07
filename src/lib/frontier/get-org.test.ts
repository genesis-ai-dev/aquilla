import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { getOrg } from "./get-org"

const ORIG = global.fetch
beforeEach(() => {
  global.fetch = vi.fn()
})
afterEach(() => {
  global.fetch = ORIG
})

describe("getOrg", () => {
  it("GETs /api/v2/orgs/:id", async () => {
    let calledUrl = ""
    global.fetch = vi.fn(async (input) => {
      calledUrl = typeof input === "string" ? input : (input as Request).url
      return new Response(
        JSON.stringify({
          id: 9,
          name: "Foreign",
          role: { level: 700, name: "admin" },
          viaPlatformAdmin: true,
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const org = await getOrg("jwt", 9)
    expect(calledUrl).toMatch(/\/api\/v2\/orgs\/9$/)
    expect(org).toMatchObject({ id: 9, name: "Foreign", viaPlatformAdmin: true })
  })

  it("returns null on 404 so chrome can fall through to not-found", async () => {
    global.fetch = vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch
    await expect(getOrg("jwt", 9)).resolves.toBeNull()
  })
})
