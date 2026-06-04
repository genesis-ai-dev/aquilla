import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { seedUser } from "./helpers/d1"

// Sanity checks for the test DB harness. Post-Neon-cutover this runs against
// real Postgres (PGlite) via the production D1→Postgres shim, so schema presence
// is checked through information_schema rather than SQLite's sqlite_master.
describe("Postgres test harness", () => {
  it("loads the schema (org/group tables exist)", async () => {
    const tables = await env.AQUILLA_DB.prepare(
      `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema='public'
          AND table_name IN ('organizations','org_members','groups','group_members','group_project_grants')`,
    ).all<{ name: string }>()
    const names = (tables.results ?? []).map((r) => r.name).sort()
    expect(names).toEqual(["group_members", "group_project_grants", "groups", "org_members", "organizations"])
  })

  it("isolates storage between tests", async () => {
    const before = await env.AQUILLA_DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>()
    expect(before?.n).toBe(0)
    await seedUser(1, "alice")
    const row = await env.AQUILLA_DB.prepare("SELECT username FROM users WHERE id = 1").first<{ username: string }>()
    expect(row?.username).toBe("alice")
  })
})
