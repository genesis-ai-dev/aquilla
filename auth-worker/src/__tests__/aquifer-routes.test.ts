// /api/v1/aquifer/{search,page,answers} — the read-only proxy + publish route.
//
// WHY: these back the Search-dock "Bible resources" mode and the publish-
// proposal Apply path. They must require auth, enforce the per-project gate
// (off → 404, "not there"), and never touch the credit ledger. fetch is mocked
// so the upstream Aquifer API is offline.

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const PROJECT = "11111111-1111-4111-8111-111111111111"

async function seedWorld(opts: { enabled: boolean }) {
  await seedUser(1, "alice")
  await env.AQUILLA_PG.prepare(`INSERT INTO projects (id, name, created_by) VALUES (?, 'P', 1)`)
    .bind(PROJECT)
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES (?, 1, 400)`,
  )
    .bind(PROJECT)
    .run()
  if (opts.enabled) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 1, 1)`,
    )
      .bind(PROJECT, JSON.stringify({ bibleResourcesEnabled: true }))
      .run()
  }
}

function aquiferJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function testEnv() {
  return Object.assign(Object.create(env), {})
}

afterEach(() => vi.restoreAllMocks())

describe("GET /api/v1/aquifer/search", () => {
  it("401 unauthenticated", async () => {
    const res = await app.request(`/api/v1/aquifer/search?projectId=${PROJECT}&q=abraham`, {}, testEnv())
    expect(res.status).toBe(401)
  })

  it("404 when the project hasn't enabled Bible resources", async () => {
    await seedWorld({ enabled: false })
    const jwt = await jwtFor("alice")
    const res = await app.request(
      `/api/v1/aquifer/search?projectId=${PROJECT}&q=abraham`,
      { headers: authHeader(jwt) },
      testEnv(),
    )
    expect(res.status).toBe(404)
  })

  it("200 with results when enabled", async () => {
    await seedWorld({ enabled: true })
    const jwt = await jwtFor("alice")
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      aquiferJson({ query: "abraham", lang: "en", count: 1, results: [{ title: "Abraham", url: "u", kind: "person", description: "d" }] }),
    )
    const res = await app.request(
      `/api/v1/aquifer/search?projectId=${PROJECT}&q=abraham`,
      { headers: authHeader(jwt) },
      testEnv(),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: unknown[] }
    expect(body.results).toHaveLength(1)
  })
})

describe("GET /api/v1/aquifer/page", () => {
  it("200 with page text when enabled", async () => {
    await seedWorld({ enabled: true })
    const jwt = await jwtFor("alice")
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      aquiferJson({ path: "/en/people/abraham/", url: "u", title: "Abraham", truncated: false, text: "Abraham..." }),
    )
    const res = await app.request(
      `/api/v1/aquifer/page?projectId=${PROJECT}&path=${encodeURIComponent("/en/people/abraham/")}`,
      { headers: authHeader(jwt) },
      testEnv(),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { title: string }
    expect(body.title).toBe("Abraham")
  })
})

describe("POST /api/v1/aquifer/answers", () => {
  it("400 when citations are missing (validation)", async () => {
    await seedWorld({ enabled: true })
    const jwt = await jwtFor("alice")
    const res = await app.request(
      `/api/v1/aquifer/answers`,
      {
        method: "POST",
        headers: { ...authHeader(jwt), "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: PROJECT, question: "What is chesed exactly?", answer: "Covenant faithfulness and steadfast love.", citations: [] }),
      },
      testEnv(),
    )
    expect(res.status).toBe(400)
  })

  it("404 when disabled (even with a valid body)", async () => {
    await seedWorld({ enabled: false })
    const jwt = await jwtFor("alice")
    const res = await app.request(
      `/api/v1/aquifer/answers`,
      {
        method: "POST",
        headers: { ...authHeader(jwt), "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: PROJECT,
          question: "What is chesed exactly?",
          answer: "Covenant faithfulness and steadfast love.",
          citations: [{ url: "https://bibletranslation.org/en/terms/chesed/" }],
        }),
      },
      testEnv(),
    )
    expect(res.status).toBe(404)
  })

  it("200 and returns the wiki url when enabled", async () => {
    await seedWorld({ enabled: true })
    const jwt = await jwtFor("alice")
    vi.spyOn(globalThis, "fetch").mockResolvedValue(aquiferJson({ url: "https://bibletranslation.org/qa/what-is-chesed/" }))
    const res = await app.request(
      `/api/v1/aquifer/answers`,
      {
        method: "POST",
        headers: { ...authHeader(jwt), "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: PROJECT,
          question: "What is chesed exactly?",
          answer: "Covenant faithfulness and steadfast love.",
          citations: [{ url: "https://bibletranslation.org/en/terms/chesed/" }],
        }),
      },
      testEnv(),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { url: string }
    expect(body.url).toContain("/qa/")
  })
})
