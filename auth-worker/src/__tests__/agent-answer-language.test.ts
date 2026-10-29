// AQU-2263 (Oct 29, second pass): the language the assistant answers in. The
// person's own choice (Preferences → Translator profile) wins, then the
// project's "The assistant answers the team in …" (drafting settings'
// main_chat_language, which nothing read before), then the language the person
// uses Aquilla in. With none of them (an older client sends no app language)
// the assistant follows the language of the latest message, as before.
import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const PROJECT = "22222222-2222-4222-8222-222222222222"

async function seed(teamLanguage?: string) {
  await seedUser(1, "alice")
  await seedUser(2, "boss")
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, 'P', 2)").bind(PROJECT).run()
  await env.AQUILLA_PG.prepare("INSERT INTO project_members (project_id, user_id, role_level) VALUES (?, 1, 400)")
    .bind(PROJECT).run()
  const settings: Record<string, unknown> = { sourceLanguage: "English", targetLanguage: "Urdu" }
  if (teamLanguage !== undefined) settings.draftingSettings = { main_chat_language: teamLanguage }
  await env.AQUILLA_PG.prepare("INSERT INTO project_settings (project_id, settings) VALUES (?, ?)")
    .bind(PROJECT, JSON.stringify(settings)).run()
}

/** The system prompt the model receives for one run with `extra` in the body. */
async function systemPromptFor(extra: Record<string, unknown>): Promise<string> {
  const bodies: { messages: { role: string; content: string }[] }[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  })
  const res = await app.request(
    "/api/v1/ai/agent/run",
    {
      method: "POST",
      headers: authHeader(await jwtFor("alice")),
      body: JSON.stringify({ projectId: PROJECT, messages: [{ role: "user", content: "hello" }], ...extra }),
    },
    Object.assign(Object.create(env), { OPENROUTER_API_KEY: "test-key" }),
  )
  expect(res.status).toBe(200)
  await res.text()
  return bodies[0].messages.filter((m) => m.role === "system").map((m) => m.content).join("\n")
}

afterEach(() => vi.restoreAllMocks())

describe("the language the assistant answers in", () => {
  it("the person's own choice wins over the project's and the app's", async () => {
    await seed("French")
    const prompt = await systemPromptFor({ translatorProfile: { responseLanguage: "Swahili" }, appLanguage: "Portuguese" })
    expect(prompt).toContain("Reply to the user in Swahili.")
    expect(prompt).not.toContain("in French")
  })

  it("then the project's language for the team", async () => {
    await seed("French")
    const prompt = await systemPromptFor({ appLanguage: "Portuguese" })
    expect(prompt).toContain("Reply to the user in French.")
    expect(prompt).not.toContain("Portuguese")
  })

  it("then the language the person uses Aquilla in", async () => {
    await seed("  ")
    const prompt = await systemPromptFor({ appLanguage: "Portuguese" })
    expect(prompt).toContain("Reply to the user in Portuguese.")
  })

  it("with none of them, it follows the latest message as before", async () => {
    await seed()
    const prompt = await systemPromptFor({})
    expect(prompt).toContain("language of the user's latest message")
    expect(prompt).not.toContain("Reply to the user in")
  })
})
