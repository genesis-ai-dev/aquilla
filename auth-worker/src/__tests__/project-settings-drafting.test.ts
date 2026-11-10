// AQU-2259: the team's AI drafting settings live in the shared blob under
// `draftingSettings`. The route checks them the way it checks bibleEnrichments:
// typed fields only, and never an AI key — the blob is readable by every
// member, so a key stored there would be handed to all of them.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import {
  legacySystemPromptSetting,
  loadTranslationInstructions,
} from "../../../db/shared/load-translation-instructions"
import { resolveTranslationInstructions } from "../../../db/shared/translation-instructions"

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

// AQU-2342: the copilot resolves the project instructions in the browser, which
// cannot read the agent's legacy `project_briefs` row. The settings GET carries
// it, so a project whose ONLY guidance is that row drafts with the same text in
// the editor as on every server path.
describe("project settings GET: legacy brief for the instructions (AQU-2342)", () => {
  async function getSettings(): Promise<{ settings: Record<string, unknown>; legacyProjectBriefText?: string }> {
    const res = await app.request("/api/v2/projects/p1/settings", { headers: authHeader(await jwtFor("alice")) }, env)
    expect(res.status).toBe(200)
    return res.json()
  }

  it("the editor resolves the same text the server paths do, and stops sending it once instructions are stored", async () => {
    await seed()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_briefs (project_id, content, updated_by, version, updated_at)
       VALUES ('p1', 'Keep divine names as in the 1999 Bible.', NULL, 1, now())`,
    ).run()

    const body = await getSettings()
    expect(body.legacyProjectBriefText).toBe("Keep divine names as in the 1999 Bible.")
    // What src/lib/instructions/project-instructions.ts computes from this response…
    const editor = resolveTranslationInstructions(body.settings, { projectBriefText: body.legacyProjectBriefText })
    // …equals what the copilot preview, the agent and Autopilot load.
    const server = await loadTranslationInstructions(env.AQUILLA_PG, "p1")
    expect(editor).toBe("Keep divine names as in the 1999 Bible.")
    expect(editor).toBe(server.text)

    expect((await save({ translationInstructions: "x".repeat(8001) })).status).toBe(400)
    expect((await save({ translationInstructions: "Ours now." })).status).toBe(200)
    expect((await getSettings()).legacyProjectBriefText).toBe("")
  })

  // The FRO-234 guard, for the one text that replaced systemPrompt: below the
  // maintainer floor a write of the instructions — a wipe included — is refused
  // server-side, whatever the client sends.
  it("refuses the instructions from below maintainer, an empty wipe included", async () => {
    await seed({ translationInstructions: "Plain register." })
    await seedUser(2, "lena")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1', 2, 500, 1)",
    ).run()
    for (const value of ["", "Lead's own text."]) {
      const res = await app.request(
        "/api/v2/projects/p1/settings",
        {
          method: "PATCH",
          headers: authHeader(await jwtFor("lena")),
          body: JSON.stringify({ settings: { translationInstructions: value }, ifMatchVersion: 1 }),
        },
        env,
      )
      expect(res.status).toBe(403)
    }
    expect((await storedSettings()).translationInstructions).toBe("Plain register.")
  })
})

// AQU-2422: ONE lookup decides which stored `systemPrompt` feeds
// migrate-on-read. Before this, only the Agent API prompt preview fell back to
// the legacy nested copy in `completionSettings`, so a legacy project's
// customized prompt appeared in `parts.instructions` and reached no draft call
// — the preview was more generous than the draft. This pins the LIVE draft
// path's loader (ai-draft-internal / the agent's draft tool / project-context
// all go through it) to `legacySystemPromptSetting`; the preview side is
// pinned in sync-worker/src/__tests__/external-prompt-preview.test.ts.
describe("legacy systemPrompt lookup (AQU-2422)", () => {
  it("is one function: the top-level key wins, else the nested copies", () => {
    expect(legacySystemPromptSetting({ systemPrompt: "top" })).toBe("top")
    expect(
      legacySystemPromptSetting({ systemPrompt: "top", completionSettings: { systemPrompt: "nested" } }),
    ).toBe("top")
    expect(legacySystemPromptSetting({ completionSettings: { systemPrompt: "nested" } })).toBe("nested")
    expect(
      legacySystemPromptSetting({
        draftingSettings: { systemPrompt: "drafting" },
        completionSettings: { systemPrompt: "nested" },
      }),
    ).toBe("drafting")
    // Junk resolves to "" rather than throwing on a drafting read.
    expect(legacySystemPromptSetting({ systemPrompt: 7, completionSettings: "nope" })).toBe("")
    expect(legacySystemPromptSetting(null)).toBe("")
  })

  it("the draft path migrates a prompt that only ever lived in the nested copy", async () => {
    await seed({
      sourceLanguage: "en",
      completionSettings: { systemPrompt: "Keep divine names as in the 1999 Bible." },
    })
    const loaded = await loadTranslationInstructions(env.AQUILLA_PG, "p1")
    expect(loaded.stored).toBe(false)
    expect(loaded.text).toBe("Keep divine names as in the 1999 Bible.")
  })

  it("the top-level key still wins over the nested copy on the draft path", async () => {
    await seed({
      sourceLanguage: "en",
      systemPrompt: "Plain register throughout.",
      completionSettings: { systemPrompt: "Keep divine names as in the 1999 Bible." },
    })
    expect((await loadTranslationInstructions(env.AQUILLA_PG, "p1")).text).toBe(
      "Plain register throughout.",
    )
  })

  it("stored instructions are authoritative, so neither copy comes back", async () => {
    await seed({
      sourceLanguage: "en",
      translationInstructions: "Ours now.",
      completionSettings: { systemPrompt: "Keep divine names as in the 1999 Bible." },
    })
    const loaded = await loadTranslationInstructions(env.AQUILLA_PG, "p1")
    expect(loaded).toEqual({ text: "Ours now.", stored: true })
  })
})
