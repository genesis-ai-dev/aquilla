import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { countOrgTargetLanes } from "../lib/billing/words"

/**
 * AQU-1070: the enterprise SOW bills by *active* language band, so a lane a
 * partner has stood down must stop counting. There are two ways to stand one
 * down and both have to drop out of this number: archiving the project, and
 * pausing it with the lifecycle toggle (`is_active = false`).
 */
describe("countOrgTargetLanes — active lanes only (AQU-1070)", () => {
  async function seedProject(
    id: string,
    settings: { targetLanguage?: string; targetLanes?: string[]; archivedLanes?: string[] },
    opts: { archived?: boolean; isActive?: boolean } = {},
  ): Promise<void> {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO projects (id, name, org_id, created_by, is_active, archived_at)
       VALUES (?, ?, 1, 1, ?, ${opts.archived ? "CURRENT_TIMESTAMP" : "NULL"})`,
    )
      .bind(id, id, opts.isActive ?? true)
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings) VALUES (?, ?)",
    )
      .bind(id, JSON.stringify(settings))
      .run()
  }

  async function seedOrg(): Promise<void> {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO users (id, username, email, password_hash, preferences) VALUES (1, 'pm', 'pm@example.com', 'x', '{}')",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)",
    ).run()
  }

  it("counts distinct lanes across live, active projects", async () => {
    await seedOrg()
    await seedProject("a", { targetLanguage: "fr", targetLanes: ["fr", "es"] })
    await seedProject("b", { targetLanguage: "pt" })
    expect(await countOrgTargetLanes(env.AQUILLA_PG, 1)).toBe(3)
  })

  it("excludes a paused (is_active = false) project's lanes", async () => {
    await seedOrg()
    await seedProject("live", { targetLanguage: "fr" })
    await seedProject("paused", { targetLanguage: "sw" }, { isActive: false })
    // 'sw' exists only on the paused project, so pausing must drop the count.
    expect(await countOrgTargetLanes(env.AQUILLA_PG, 1)).toBe(1)
  })

  it("excludes an archived project's lanes", async () => {
    await seedOrg()
    await seedProject("live", { targetLanguage: "fr" })
    await seedProject("old", { targetLanguage: "sw" }, { archived: true })
    expect(await countOrgTargetLanes(env.AQUILLA_PG, 1)).toBe(1)
  })

  it("still counts a lane that a paused project shares with an active one", async () => {
    await seedOrg()
    await seedProject("live", { targetLanguage: "sw" })
    await seedProject("paused", { targetLanguage: "sw" }, { isActive: false })
    expect(await countOrgTargetLanes(env.AQUILLA_PG, 1)).toBe(1)
  })
})
