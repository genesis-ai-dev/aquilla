import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { seedUser } from "./helpers/d1"

describe("real-D1 harness", () => {
  it("applies migrations (org/group tables exist)", async () => {
    const tables = await env.AQUILLA_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('organizations','org_members','groups','group_members','group_project_grants')",
    ).all<{ name: string }>()
    const names = (tables.results ?? []).map((r) => r.name).sort()
    expect(names).toEqual(["group_members","group_project_grants","groups","org_members","organizations"])
  })

  it("isolates storage between tests", async () => {
    await seedUser(1, "alice")
    const row = await env.AQUILLA_DB.prepare("SELECT username FROM users WHERE id = 1").first<{ username: string }>()
    expect(row?.username).toBe("alice")
  })
})
