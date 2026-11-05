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
  await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (71, 1, 700, 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by, org_id) VALUES (?, 'Names', 1, 71)").bind(PROJECT_ID).run()
  return jwtFor("names-owner")
}

/** Someone on the Names project at this level, and not in its organization. */
async function seedProjectMember(id: number, username: string, level: number): Promise<string> {
  await seedUser(id, username)
  await env.AQUILLA_PG.prepare("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, 1)").bind(PROJECT_ID, id, level).run()
  return jwtFor(username)
}

const SAVED = "/api/v1/import/recording-names/saved"

function save(jwt: string, rule: unknown = GOOD_RULE, shapes: string[] = ["mt-ch#_v#.ogg"], projectId = PROJECT_ID, at = testEnv()) {
  return app.request(SAVED, { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ projectId, shapes, rule }) }, at)
}

async function readSaved(jwt: string, projectId = PROJECT_ID): Promise<{ status: number; rules: Record<string, unknown>; canKeep?: boolean }> {
  const response = await app.request(`${SAVED}?projectId=${projectId}`, { headers: authHeader(jwt) }, testEnv())
  const body = await response.json().catch(() => ({})) as { rules?: Record<string, unknown>; canKeep?: boolean }
  return { status: response.status, rules: body.rules ?? {}, canKeep: body.canKeep }
}

async function storedShapes(orgId = 71): Promise<string[]> {
  const row = await env.AQUILLA_PG.prepare("SELECT settings FROM org_settings WHERE org_id = ?").bind(orgId).first<{ settings: string }>()
  return Object.keys((JSON.parse(row?.settings ?? "{}") as { recordingNameRules?: Record<string, unknown> }).recordingNameRules ?? {}).sort()
}

/** A rule for one save: the names say the book and chapter, so it may be kept. */
function ruleNo(n: number) {
  return { templates: [{ pattern: `{book}-ch{chapter}_v{verse}_s${n}` }], books: { Mt: "MAT" } }
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
    expect(rule).toMatchObject({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }], books: { mt: "MAT" } })
    expect(rule).not.toHaveProperty("extra")
    expect(upstream).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(upstream.mock.calls[0][1]?.body)) as { model: string; temperature: number; messages: Array<{ content: string }> }
    expect(body.model).not.toBe("attacker/model")
    expect(body.temperature).toBe(0)
    expect(body.messages[0].content).toContain("untrusted data")
    // Each name as a JSON string, like the outline's file names (review, Oct 30).
    expect(body.messages[1].content).toContain('<file-names>\n"Mt-ch19_v01.ogg"\n"Mt-ch19_v02.ogg"')
  })

  it("sends only the failed names on the retry", async () => {
    const jwt = await seedLead()
    const upstream = modelAnswers(GOOD_RULE)
    // The browser sends only the names the first rule failed on (the preview's
    // test pins that); the prompt then lists those and nothing else.
    await app.request("/api/v1/import/recording-names", {
      method: "POST",
      headers: authHeader(jwt),
      body: ruleBody({ names: ["Mt-ch19_v99.ogg"], previous: GOOD_RULE, failures: [{ name: "Mt-ch19_v99.ogg", made: "MAT 19:99.ogg", reason: "noSuchVerse" }] }),
    }, testEnv())
    const prompt = (JSON.parse(String(upstream.mock.calls[0][1]?.body)) as { messages: Array<{ content: string }> }).messages[1].content
    expect(prompt).toContain('<file-names>\n"Mt-ch19_v99.ogg"\n</file-names>')
    expect(prompt).toContain('<failed-names>\n"Mt-ch19_v99.ogg" → "MAT 19:99.ogg" ("noSuchVerse")')
    expect(prompt).not.toContain("Mt-ch19_v01.ogg")
  })

  it("refuses a retry whose previous rule isn't one the browser could have run", async () => {
    const jwt = await seedLead()
    const upstream = vi.spyOn(globalThis, "fetch")
    const response = await app.request("/api/v1/import/recording-names", {
      method: "POST",
      headers: authHeader(jwt),
      body: ruleBody({ previous: { templates: [{ pattern: "{constructor}" }] }, failures: [{ name: "a.ogg", made: null, reason: "noTemplate" }] }),
    }, testEnv())
    expect(response.status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
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

  it("reads the model's loose ends the way the browser does: a long explanation trimmed, a null one and an empty folder as none", async () => {
    const jwt = await seedLead()
    modelAnswers({ templates: [{ pattern: "{book}-ch{chapter}_v{verse}", folder: "" }], books: { Mt: "MAT" }, explanation: "x".repeat(400) })
    const long = await app.request("/api/v1/import/recording-names", { method: "POST", headers: authHeader(jwt), body: ruleBody() }, testEnv())
    expect(long.status).toBe(200)
    const { rule } = await long.json() as { rule: { explanation: string; templates: unknown[] } }
    expect(rule.explanation).toHaveLength(300)
    expect(rule.templates).toEqual([{ pattern: "{book}-ch{chapter}_v{verse}" }])
    vi.restoreAllMocks()
    modelAnswers({ ...GOOD_RULE, explanation: null })
    const none = await app.request("/api/v1/import/recording-names", { method: "POST", headers: authHeader(jwt), body: ruleBody() }, testEnv())
    expect(none.status).toBe(200)
  })

  it("refuses an answer the browser's compiler would refuse, such as a built-in's name as a placeholder", async () => {
    const jwt = await seedLead()
    for (const pattern of ["{constructor}", "{part}{verse}", "{any}a{any}a{any}a{verse}"]) {
      vi.restoreAllMocks()
      modelAnswers({ templates: [{ pattern }], book: "MAT", chapter: 1 })
      const response = await app.request("/api/v1/import/recording-names", { method: "POST", headers: authHeader(jwt), body: ruleBody() }, testEnv())
      expect(response.status).toBe(502)
      expect(await response.json()).toMatchObject({ error: "invalid_naming_rule" })
    }
  })

  it("counts the words it was sent on the legacy billing path, as the importer's classifier does", async () => {
    const jwt = await seedLead()
    modelAnswers(GOOD_RULE)
    const response = await app.request("/api/v1/import/recording-names", { method: "POST", headers: authHeader(jwt), body: ruleBody() }, testEnv())
    expect(response.status).toBe(200)
    const row = await env.AQUILLA_PG.prepare("SELECT SUM(words) AS words FROM org_word_usage_daily WHERE org_id = 71 AND rail = 'llm'").first<{ words: number | null }>()
    expect(Number(row?.words ?? 0)).toBeGreaterThan(0)
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

  it("refuses to keep a rule that leans on a book, chapter or file it was told", async () => {
    const jwt = await seedLead()
    for (const rule of [
      { templates: [{ pattern: "New Recording {verse}" }], book: "MAT", chapter: 5 },
      { templates: [{ pattern: "{book} v{verse}" }], chapter: 5 },
      { templates: [{ pattern: "IMG_{line}" }], file: "Welcome letter" },
    ]) {
      const response = await save(jwt, rule, ["new recording #.m4a"])
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: "naming_rule_not_savable" })
    }
    const unusable = await save(jwt, { templates: [{ pattern: "{constructor}" }] })
    expect(unusable.status).toBe(400)
    expect(await storedShapes()).toEqual([])
  })

  it("lets a project lead who is in the organization keep a rule, and no one else", async () => {
    const lead = await seedLead()
    const projectOnlyLead = await seedProjectMember(3, "project-only-lead", 500)
    const contributor = await seedProjectMember(4, "contributor", 400)
    expect((await save(projectOnlyLead)).status).toBe(403)
    expect((await save(contributor)).status).toBe(403)
    expect(await storedShapes()).toEqual([])
    expect((await save(lead)).status).toBe(200)
    expect(await storedShapes()).toEqual(["mt-ch#_v#.ogg"])
  })

  it("says who may keep and forget the team's rules, by the same gate as those routes (Sam, Oct 30)", async () => {
    const lead = await seedLead()
    const projectOnlyLead = await seedProjectMember(3, "project-only-lead", 500)
    const contributor = await seedProjectMember(4, "contributor", 400)
    expect((await readSaved(lead)).canKeep).toBe(true)
    // A lead added only to the project may read and use the rules, but the
    // server won't let them keep or forget one, so the preview mustn't offer it.
    const projectOnly = await readSaved(projectOnlyLead)
    expect(projectOnly.status).toBe(200)
    expect(projectOnly.canKeep).toBe(false)
    const forget = await app.request(SAVED, { method: "DELETE", headers: authHeader(projectOnlyLead), body: JSON.stringify({ projectId: PROJECT_ID, shapes: ["mt-ch#_v#.ogg"] }) }, testEnv())
    expect(forget.status).toBe(403)
    expect((await readSaved(contributor)).canKeep).toBe(false)
  })

  it("lets anyone who may upload recordings read the team's rules, so a contributor's upload uses them too", async () => {
    const lead = await seedLead()
    await save(lead)
    const contributor = await seedProjectMember(4, "contributor", 400)
    const reviewer = await seedProjectMember(5, "reviewer", 300)
    const read = await readSaved(contributor)
    expect(read.status).toBe(200)
    expect(Object.keys(read.rules)).toEqual(["mt-ch#_v#.ogg"])
    expect((await readSaved(reviewer)).status).toBe(403)
  })

  it("keeps another organization out: it can't read, keep or forget this one's rules", async () => {
    const lead = await seedLead()
    await save(lead)
    await seedUser(6, "other-owner")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (72, 'Other Org', 6)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (72, 6, 700, 6)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by, org_id) VALUES ('other-project', 'Other', 6, 72)").run()
    const other = await jwtFor("other-owner")
    expect((await readSaved(other)).status).toBe(403)
    expect((await save(other, ruleNo(1), ["other#.ogg"])).status).toBe(403)
    const forget = await app.request(SAVED, { method: "DELETE", headers: authHeader(other), body: JSON.stringify({ projectId: PROJECT_ID, shapes: ["mt-ch#_v#.ogg"] }) }, testEnv())
    expect(forget.status).toBe(403)
    // Its own project's rules go to its own organization.
    expect((await save(other, ruleNo(1), ["other#.ogg"], "other-project")).status).toBe(200)
    expect(await storedShapes(71)).toEqual(["mt-ch#_v#.ogg"])
    expect(await storedShapes(72)).toEqual(["other#.ogg"])
  })

  it("forgets a saved rule under every shape it is kept under, with the same rights as keeping one (review, Oct 30)", async () => {
    const lead = await seedLead()
    await save(lead, GOOD_RULE, ["mt-ch#_v#.ogg", "mt ch# v#.ogg"])
    await save(lead, ruleNo(2), ["other#.ogg"])
    // The same rule kept again later, under another shape, goes too.
    await save(lead, GOOD_RULE, ["mt-ch#_v#a.ogg"])
    const contributor = await seedProjectMember(4, "contributor", 400)
    const forget = (jwt: string) => app.request(SAVED, { method: "DELETE", headers: authHeader(jwt), body: JSON.stringify({ projectId: PROJECT_ID, shapes: ["mt-ch#_v#.ogg"] }) }, testEnv())
    expect((await forget(contributor)).status).toBe(403)
    const done = await forget(lead)
    expect(done.status).toBe(200)
    expect(await done.json()).toEqual({ forgotten: true })
    expect(await storedShapes()).toEqual(["other#.ogg"])
  })

  it("never hands back a rule that leans on a constant, even one an older version kept", async () => {
    const lead = await seedLead()
    const legacy = { recordingNameRules: {
      "new recording #.m4a": { rule: { templates: [{ pattern: "New Recording {verse}" }], book: "MAT", chapter: 5 }, savedAt: "2026-10-29T10:00:00.000Z" },
      "mt-ch#_v#.ogg": { rule: GOOD_RULE, savedAt: "2026-10-29T10:00:01.000Z" },
    } }
    await env.AQUILLA_PG.prepare("INSERT INTO org_settings (org_id, settings, version) VALUES (71, ?, 1)").bind(JSON.stringify(legacy)).run()
    expect(Object.keys((await readSaved(lead)).rules)).toEqual(["mt-ch#_v#.ogg"])
  })

  it("counts the 20-rule limit in rules, not shapes, and lets the oldest rule go first, whole", async () => {
    const lead = await seedLead()
    expect((await save(lead, ruleNo(0), ["a#.ogg", "b#.ogg", "c#.ogg", "d#.ogg", "e#.ogg"])).status).toBe(200)
    for (let n = 1; n <= 16; n++) expect((await save(lead, ruleNo(n), [`r${n}-#.ogg`])).status).toBe(200)
    // 17 rules in 21 shapes: all kept.
    expect(await storedShapes()).toHaveLength(21)
    for (let n = 17; n <= 20; n++) expect((await save(lead, ruleNo(n), [`r${n}-#.ogg`])).status).toBe(200)
    // 21 rules: the first one's five shapes go together.
    const shapes = await storedShapes()
    expect(shapes).toHaveLength(20)
    expect(shapes.some((shape) => /^[a-e]#\.ogg$/.test(shape))).toBe(false)
  })

  it("survives another save landing between its read and its write, and keeps both", async () => {
    const lead = await seedLead()
    await env.AQUILLA_PG.prepare("INSERT INTO org_settings (org_id, settings, version) VALUES (71, ?, 1)").bind(JSON.stringify({ validationCount: 2 })).run()
    let raced = false
    const db = new Proxy(env.AQUILLA_PG, {
      get(target, prop, receiver) {
        if (prop !== "prepare") {
          const value = Reflect.get(target, prop, receiver) as unknown
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value
        }
        return (sql: string) => {
          const statement = target.prepare(sql)
          if (raced || !/^\s*UPDATE org_settings/.test(sql)) return statement
          return {
            bind: (...args: unknown[]) => ({
              run: async () => {
                raced = true
                await target.prepare("UPDATE org_settings SET settings = ?, version = version + 1 WHERE org_id = 71")
                  .bind(JSON.stringify({ validationCount: 2, commentFloor: 400 })).run()
                return statement.bind(...args).run()
              },
            }),
          }
        }
      },
    })
    const response = await save(lead, GOOD_RULE, ["mt-ch#_v#.ogg"], PROJECT_ID, Object.assign(testEnv(), { AQUILLA_PG: db }))
    expect(raced).toBe(true)
    expect(await response.json()).toEqual({ saved: true })
    const row = await env.AQUILLA_PG.prepare("SELECT settings, version FROM org_settings WHERE org_id = 71").first<{ settings: string; version: number }>()
    const settings = JSON.parse(row!.settings) as Record<string, unknown>
    expect(settings.commentFloor).toBe(400)
    expect(Object.keys(settings.recordingNameRules as object)).toEqual(["mt-ch#_v#.ogg"])
    expect(row!.version).toBe(3)
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

// ── The second review (Oct 30) ──────────────────────────────────────────────

describe("the prompt says what the browser can apply (review, Oct 30)", () => {
  it("offers {toVerse} for a range, each placeholder once, and no folder templates", async () => {
    const jwt = await seedLead()
    const upstream = modelAnswers(GOOD_RULE)
    await app.request("/api/v1/import/recording-names", { method: "POST", headers: authHeader(jwt), body: ruleBody() }, testEnv())
    const prompt = (JSON.parse(String(upstream.mock.calls[0][1]?.body)) as { messages: Array<{ content: string }> }).messages[1].content
    expect(prompt).toContain("{toVerse}")
    expect(prompt).toContain("at most once")
    expect(prompt).not.toContain("folder")
  })

  it("refuses an answer that reads a folder, which the browser can't apply", async () => {
    const jwt = await seedLead()
    modelAnswers({ templates: [{ pattern: "v{verse}", folder: "Kapitola {chapter}" }], book: "MAT" })
    const response = await app.request("/api/v1/import/recording-names", { method: "POST", headers: authHeader(jwt), body: ruleBody() }, testEnv())
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: "invalid_naming_rule" })
  })

  it("refuses an answer that maps a word the app reads as one book to another, such as {Mark: MAT}", async () => {
    const jwt = await seedLead()
    modelAnswers({ templates: [{ pattern: "{book} {chapter}-{verse}" }], books: { Mark: "MAT" } })
    const response = await app.request("/api/v1/import/recording-names", { method: "POST", headers: authHeader(jwt), body: ruleBody() }, testEnv())
    expect(response.status).toBe(502)
    expect((await save(jwt, { templates: [{ pattern: "{book} {chapter}-{verse}" }], books: { Mark: "MAT" } }, ["mark #-#"])).status).toBe(400)
    expect(await storedShapes()).toEqual([])
  })
})

describe("a book word that names no book is never kept (review, Oct 30)", () => {
  const SERMONS = { templates: [{ pattern: "{book}_{chapter}_{verse}" }], books: { sermon: "MAT" } }

  it("refuses to keep {sermon: MAT}, so next week's Mark sermons can't land on Matthew", async () => {
    const jwt = await seedLead()
    const response = await save(jwt, SERMONS, ["sermon_#_#"])
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "naming_rule_not_savable" })
    expect(await storedShapes()).toEqual([])
  })

  it("never hands one back, even written straight into the organization's settings", async () => {
    const lead = await seedLead()
    const written = { recordingNameRules: {
      "sermon_#_#": { rule: SERMONS, savedAt: "2026-10-30T10:00:00.000Z" },
      "mt-ch#_v#-#": { rule: { templates: [{ pattern: "{book}-ch{chapter}_v{verse}-{verse}" }], books: { Mt: "MAT" } }, savedAt: "2026-10-30T10:00:01.000Z" },
      "mt-ch#_v#": { rule: GOOD_RULE, savedAt: "2026-10-30T10:00:02.000Z" },
    } }
    await env.AQUILLA_PG.prepare("INSERT INTO org_settings (org_id, settings, version) VALUES (71, ?, 1)").bind(JSON.stringify(written)).run()
    expect(Object.keys((await readSaved(lead)).rules)).toEqual(["mt-ch#_v#"])
  })

  it("keeps a word the project's own Bible file is named, and hands it back only where the project has that file", async () => {
    const lead = await seedLead()
    const MATEO = { templates: [{ pattern: "{book}_{chapter}_{verse}" }], books: { Mateo: "MAT" } }
    expect((await save(lead, MATEO, ["mateo_#_#"])).status).toBe(400)
    await env.AQUILLA_PG.prepare("INSERT INTO files (id, project_id, name, event_id, cell_count, role, book_code) VALUES ('mateo', ?, 'Mateo', 'e1', 10, 'source', 'MAT')").bind(PROJECT_ID).run()
    expect((await save(lead, MATEO, ["mateo_#_#"])).status).toBe(200)
    expect(Object.keys((await readSaved(lead)).rules)).toEqual(["mateo_#_#"])
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by, org_id) VALUES ('names-2', 'Names 2', 1, 71)").run()
    expect(Object.keys((await readSaved(lead, "names-2")).rules)).toEqual([])
  })
})

describe("odd shapes (review, Oct 30)", () => {
  it("keeps a shape named __proto__ as a shape, never as the object's prototype", async () => {
    const jwt = await seedLead()
    const response = await save(jwt, GOOD_RULE, ["__proto__", "mt-ch#_v#"])
    expect(await response.json()).toEqual({ saved: true })
    expect(await storedShapes()).toEqual(["__proto__", "mt-ch#_v#"])
    expect(Object.keys((await readSaved(jwt)).rules).sort()).toEqual(["__proto__", "mt-ch#_v#"])
  })
})
