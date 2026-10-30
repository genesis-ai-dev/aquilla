// AQU-2259: the team's AI drafting settings live in the shared blob under
// `draftingSettings`. The route checks them the way it checks bibleEnrichments:
// typed fields only, and never an AI key — the blob is readable by every
// member, so a key stored there would be handed to all of them.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seed(projectSettings: Record<string, unknown> = { sourceLanguage: "en" }) {
  await seedUser(1, "alice") // org owner
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'TestOrg', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, '{}', 0, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'Bible data', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ('p1', ?, 1, 1)",
  )
    .bind(JSON.stringify(projectSettings))
    .run()
}

async function save(settings: Record<string, unknown>): Promise<Response> {
  return app.request(
    "/api/v2/projects/p1/settings",
    {
      method: "PATCH",
      headers: authHeader(await jwtFor("alice")),
      body: JSON.stringify({ settings, ifMatchVersion: 1 }),
    },
    env,
  )
}

async function storedSettings(): Promise<Record<string, unknown>> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT settings FROM project_settings WHERE project_id = 'p1'",
  ).first<{ settings: string }>()
  return JSON.parse(row?.settings ?? "{}") as Record<string, unknown>
}

describe("project settings: draftingSettings (AQU-2259)", () => {
  it("stores the team's drafting settings", async () => {
    await seed()
    const drafting = {
      provider: "custom",
      endpoint: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-3.5-sonnet",
      maxTokens: 16384,
      temperature: 0.4,
      top_k: 17,
      contextSize: "large",
      useOnlyValidatedExamples: true,
      main_chat_language: "French",
      fewShotExampleFormat: "target-only",
      completionBatchSize: 20,
      validationBatchSize: 40,
    }
    const res = await save({ draftingSettings: drafting })
    expect(res.status).toBe(200)
    expect((await storedSettings()).draftingSettings).toEqual(drafting)
  })

  // Oct 29 second pass: the Health penalty is retired (nothing read it). A
  // stored value from before still saves, so nobody's settings are refused.
  it("still accepts the retired Health penalty an older build stored", async () => {
    await seed({ sourceLanguage: "en", draftingSettings: { top_k: 9, llmHealthPenalty: 0.2 } })
    const res = await save({ draftingSettings: { top_k: 11, llmHealthPenalty: 0.3 }, systemPrompt: "Plain." })
    expect(res.status).toBe(200)
    expect((await storedSettings()).systemPrompt).toBe("Plain.")
  })

  it("refuses an AI key, and stores nothing", async () => {
    await seed()
    const res = await save({ draftingSettings: { top_k: 5, apiKey: "sk-secret" } })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("apiKey")
    expect((await storedSettings()).draftingSettings).toBeUndefined()
  })

  it("refuses a mistyped or out-of-range field", async () => {
    await seed()
    expect((await save({ draftingSettings: { top_k: "ten" } })).status).toBe(400)
    expect((await save({ draftingSettings: { contextSize: "huge" } })).status).toBe(400)
    expect((await save({ draftingSettings: { temperature: 7 } })).status).toBe(400)
    expect((await save({ draftingSettings: { surprise: true } })).status).toBe(400)
    expect((await save({ draftingSettings: "fast" })).status).toBe(400)
  })

  it("lets an older stored value through unchanged, so the rest still saves", async () => {
    await seed({ sourceLanguage: "en", draftingSettings: { top_k: 900 } })
    const res = await save({ systemPrompt: "Keep it plain.", draftingSettings: { top_k: 900 } })
    expect(res.status).toBe(200)
    expect((await storedSettings()).systemPrompt).toBe("Keep it plain.")
  })
})
