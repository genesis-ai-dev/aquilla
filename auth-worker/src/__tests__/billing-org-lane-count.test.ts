import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { countOrgTargetLanes, countTargetLanesByOrg } from "../lib/billing/words"

/**
 * AQU-1598: billing counts target lane rows, not distinct languages.
 * AQU-1070: a paused or archived project still drops out of the count.
 */
describe("countOrgTargetLanes — target lane rows (AQU-1598)", () => {
  interface LaneSeed {
    id: string
    name: string
    langCode?: string | null
    legacyTag?: string | null
    role?: "source" | "target"
    archived?: boolean
  }

  async function seedProject(
    id: string,
    settings: { targetLanguage?: string; targetLanes?: string[]; archivedLanes?: string[] } | null,
    opts: { archived?: boolean; isActive?: boolean; orgId?: number; lanes?: LaneSeed[] } = {},
  ): Promise<void> {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO projects (id, name, org_id, created_by, is_active, archived_at)
       VALUES (?, ?, ?, 1, ?, ${opts.archived ? "CURRENT_TIMESTAMP" : "NULL"})`,
    )
      .bind(id, id, opts.orgId ?? 1, opts.isActive ?? true)
      .run()
    if (settings) {
      await env.AQUILLA_PG.prepare(
        "INSERT INTO project_settings (project_id, settings) VALUES (?, ?)",
      )
        .bind(id, JSON.stringify(settings))
        .run()
    }
    for (const lane of opts.lanes ?? []) {
      await env.AQUILLA_PG.prepare(
        `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          lane.id,
          id,
          lane.role ?? "target",
          lane.name,
          lane.langCode ?? null,
          lane.legacyTag === undefined ? null : lane.legacyTag,
          lane.archived ? "2026-01-01T00:00:00Z" : null,
        )
        .run()
    }
  }

  function spanish(id: string, legacyTag: string): LaneSeed {
    return { id, name: "Spanish", langCode: "es", legacyTag }
  }

  async function seedOrg(): Promise<void> {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO users (id, username, email, password_hash, preferences) VALUES (1, 'pm', 'pm@example.com', 'x', '{}')",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)",
    ).run()
  }

  it("counts two lanes of one language as two", async () => {
    await seedOrg()
    await seedProject("a", { targetLanguage: "es", targetLanes: ["es"] }, {
      lanes: [spanish("eslane01", ""), spanish("eslane02", "es-b")],
    })
    expect(await countOrgTargetLanes(env.AQUILLA_PG, 1)).toBe(2)
  })

  it("counts an archived lane as zero", async () => {
    await seedOrg()
    await seedProject("a", { targetLanguage: "es" }, {
      lanes: [spanish("eslane01", ""), { ...spanish("eslane02", "es-b"), archived: true }],
    })
    await seedProject("b", { targetLanguage: "es" }, {
      lanes: [{ ...spanish("eslane03", ""), archived: true }],
    })
    expect(await countOrgTargetLanes(env.AQUILLA_PG, 1)).toBe(1)
  })

  it("ignores settings.targetLanes when the project has lanes rows", async () => {
    await seedOrg()
    await seedProject("a", { targetLanguage: "es", targetLanes: ["es", "pt", "fr"] }, {
      lanes: [spanish("eslane01", "")],
    })
    await seedProject("b", { targetLanguage: "es", targetLanes: ["pt", "fr"] }, {
      lanes: [{ id: "srclane1", name: "English", langCode: "en", role: "source" }],
    })
    expect(await countOrgTargetLanes(env.AQUILLA_PG, 1)).toBe(1)
  })

  it("counts a project with no lane rows as zero, settings language included", async () => {
    await seedOrg()
    await seedProject("a", { targetLanguage: "pt" })
    await seedProject("b", { targetLanguage: "   " })
    await seedProject("c", null)
    expect(await countOrgTargetLanes(env.AQUILLA_PG, 1)).toBe(0)
  })

  it("counts the same language on two projects as two lanes", async () => {
    await seedOrg()
    await seedProject("a", { targetLanguage: "es" }, { lanes: [spanish("eslane01", "")] })
    await seedProject("b", { targetLanguage: "es" }, { lanes: [spanish("eslane02", "")] })
    expect(await countOrgTargetLanes(env.AQUILLA_PG, 1)).toBe(2)
  })

  it("excludes a paused (is_active = false) project's lanes", async () => {
    await seedOrg()
    await seedProject("live", { targetLanguage: "es" }, {
      lanes: [spanish("eslane01", ""), spanish("eslane02", "es-b")],
    })
    await seedProject("paused", { targetLanguage: "es" }, {
      isActive: false,
      lanes: [spanish("eslane03", "")],
    })
    expect(await countOrgTargetLanes(env.AQUILLA_PG, 1)).toBe(2)
  })

  it("excludes an archived project's lanes", async () => {
    await seedOrg()
    await seedProject("live", { targetLanguage: "fr" }, {
      lanes: [{ id: "frlane01", name: "French", langCode: "fr", legacyTag: "" }],
    })
    await seedProject("old", { targetLanguage: "es" }, {
      archived: true,
      lanes: [spanish("eslane01", ""), spanish("eslane02", "es-b")],
    })
    expect(await countOrgTargetLanes(env.AQUILLA_PG, 1)).toBe(1)
  })

  it("sums lanes across orgs instead of collapsing a shared language", async () => {
    await seedOrg()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (2, 'Other', 1)",
    ).run()
    await seedProject("a", { targetLanguage: "es" }, { lanes: [spanish("eslane01", "")] })
    await seedProject("b", { targetLanguage: "es" }, {
      orgId: 2,
      lanes: [spanish("eslane02", "")],
    })
    const { byOrg, combined } = await countTargetLanesByOrg(env.AQUILLA_PG, [1, 2])
    expect(byOrg.get(1)).toBe(1)
    expect(byOrg.get(2)).toBe(1)
    expect(combined).toBe(2)
  })
})
