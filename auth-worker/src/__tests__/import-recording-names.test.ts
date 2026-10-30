import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"

const PROJECT_ID = "names-project"

function testEnv(): typeof env {
  return Object.assign(Object.create(env), {
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_BASE_URL: "http://127.0.0.1:9456/api/v1/",
    AI_BUDGET_ENFORCE: "false",
  })
}

function ruleBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    projectId: PROJECT_ID,
    names: ["Mt-ch19_v01.ogg", "Mt-ch19_v02.ogg", "Mt-ch22_v32.ogg"],
    outline: "MAT (Matthew): verses per chapter 25,23,17",
    ...extra,
  })
}

const GOOD_RULE = {
  templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }],
  books: { Mt: "MAT" },
  explanation: "Mt is Matthew, then the chapter and the verse.",
}

async function seedLead(): Promise<string> {
  await seedUser(1, "names-owner")
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (71, 'Names Org', 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by, org_id) VALUES (?, 'Names', 1, 71)").bind(PROJECT_ID).run()
  return jwtFor("names-owner")
}

function modelAnswers(content: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
    usage: { cost: 0.0004 },
  }), { status: 200, headers: { "Content-Type": "application/json" } }))
}

afterEach(() => vi.restoreAllMocks())

describe("POST /api/v1/import/recording-names", () => {
  it("requires a project lead, and never calls the model for anyone else", async () => {
    await seedUser(1, "owner")
    await seedUser(2, "contributor")
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, 'Names', 1)").bind(PROJECT_ID).run()
    await env.AQUILLA_PG.prepare("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, 2, 400, 1)").bind(PROJECT_ID).run()
    const upstream = vi.spyOn(globalThis, "fetch")
    const response = await app.request("/api/v1/import/recording-names", {
      method: "POST", headers: authHeader(await jwtFor("contributor")), body: ruleBody(),
    }, testEnv())
    expect(response.status).toBe(403)
    expect(upstream).not.toHaveBeenCalled()
  })

  it("owns the prompt and model, sends only names and the outline, and returns the checked rule", async () => {
    const jwt = await seedLead()
    const upstream = modelAnswers({ ...GOOD_RULE, extra: "stripped" })
    const response = await app.request("/api/v1/import/recording-names", {
      method: "POST", headers: authHeader(jwt), body: ruleBody({ model: "attacker/model" }),
    }, testEnv())
    expect(response.status).toBe(200)
    const { rule } = await response.json() as { rule: Record<string, unknown> }
    expect(rule).toMatchObject({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }], books: { Mt: "MAT" } })
    expect(rule).not.toHaveProperty("extra")
    expect(upstream).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(upstream.mock.calls[0][1]?.body)) as { model: string; temperature: number; messages: Array<{ content: string }> }
    expect(body.model).not.toBe("attacker/model")
    expect(body.temperature).toBe(0)
    expect(body.messages[0].content).toContain("untrusted data")
    expect(body.messages[1].content).toContain("<file-names>\nMt-ch19_v01.ogg")
  })

  it("sends only the failed names on the retry", async () => {
    const jwt = await seedLead()
    const upstream = modelAnswers(GOOD_RULE)
    await app.request("/api/v1/import/recording-names", {
      method: "POST",
      headers: authHeader(jwt),
      body: ruleBody({ previous: GOOD_RULE, failures: [{ name: "Mt-ch19_v99.ogg", made: "MAT 19:99.ogg", reason: "noSuchVerse" }] }),
    }, testEnv())
    const prompt = (JSON.parse(String(upstream.mock.calls[0][1]?.body)) as { messages: Array<{ content: string }> }).messages[1].content
    expect(prompt).toContain("<failed-names>\nMt-ch19_v99.ogg → MAT 19:99.ogg (noSuchVerse)")
  })

  it("refuses an answer that isn't a usable rule", async () => {
    const jwt = await seedLead()
    modelAnswers({ assignments: [{ file: "a.ogg", cell: "x" }] })
    const response = await app.request("/api/v1/import/recording-names", {
      method: "POST", headers: authHeader(jwt), body: ruleBody(),
    }, testEnv())
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: "invalid_naming_rule" })
  })

  it("refuses more than 40 names before calling the model", async () => {
    const jwt = await seedLead()
    const upstream = vi.spyOn(globalThis, "fetch")
    const response = await app.request("/api/v1/import/recording-names", {
      method: "POST", headers: authHeader(jwt), body: ruleBody({ names: Array.from({ length: 41 }, (_, i) => `n${i}.ogg`) }),
    }, testEnv())
    expect(response.status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
  })
})

describe("the organization's saved naming rules", () => {
  it("keeps a confirmed rule under its shapes, and hands it back for the next upload", async () => {
    const jwt = await seedLead()
    const save = await app.request("/api/v1/import/recording-names/saved", {
      method: "POST", headers: authHeader(jwt), body: JSON.stringify({ projectId: PROJECT_ID, shapes: ["mt-ch#_v#.ogg"], rule: GOOD_RULE }),
    }, testEnv())
    expect(await save.json()).toEqual({ saved: true })
    const read = await app.request(`/api/v1/import/recording-names/saved?projectId=${PROJECT_ID}`, { headers: authHeader(jwt) }, testEnv())
    const { rules } = await read.json() as { rules: Record<string, unknown> }
    expect(rules["mt-ch#_v#.ogg"]).toMatchObject({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }] })
  })

  it("leaves the organization's other settings as they were", async () => {
    const jwt = await seedLead()
    await env.AQUILLA_PG.prepare("INSERT INTO org_settings (org_id, settings, version) VALUES (71, ?, 3)").bind(JSON.stringify({ validationCount: 2 })).run()
    await app.request("/api/v1/import/recording-names/saved", {
      method: "POST", headers: authHeader(jwt), body: JSON.stringify({ projectId: PROJECT_ID, shapes: ["mt-ch#_v#.ogg"], rule: GOOD_RULE }),
    }, testEnv())
    const row = await env.AQUILLA_PG.prepare("SELECT settings, version FROM org_settings WHERE org_id = 71").first<{ settings: string; version: number }>()
    const settings = JSON.parse(row!.settings) as Record<string, unknown>
    expect(settings.validationCount).toBe(2)
    expect(settings).toHaveProperty("recordingNameRules")
    expect(row!.version).toBe(4)
  })
})
