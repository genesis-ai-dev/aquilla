// LangQuest live links (routes/langquest.ts, lib/langquest/*).
//
// LangQuest is played by a small fake built from its docs/agent-api.md and
// apps/web/worker/agent/view.ts; global fetch is stubbed per test, so no
// request leaves the process. The DB is the shared PGlite, so the
// langquest_* tables are real.

import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"
import { DEFAULT_LANGQUEST_API_BASE, type LangQuestPassage } from "../lib/langquest/client"
import { encryptLangQuestToken } from "../lib/langquest/tokens"
import { runningEnvironment } from "../lib/monday/tokens"
import type { Env } from "../types"

const aenv = env as unknown as Env
const TOKEN = "lqp_Sq3k1yA0bJxL6tWm9cZr2eVu"
const BLOB = "https://next.langquest.org/api/blobs/abc123?expires=1&sig=x"

afterEach(() => vi.unstubAllGlobals())

interface FakeLangQuest {
  token: string
  scopes: string[]
  passages: LangQuestPassage[]
  changes: { cursor: string; type: string; unitId: string; at: string }[]
  /** Requests LangQuest saw, as "METHOD /path?query". */
  seen: string[]
  /** Releases posted, as `${unitId}:${live}`. */
  released: string[]
}

function passage(unitId: string, opts: Partial<LangQuestPassage> = {}): LangQuestPassage {
  return {
    unitId,
    label: unitId,
    path: ["Genesis", "Chapter 1"],
    kind: "passage",
    order: unitId,
    reference: null,
    status: "approved",
    version: { n: 1, takeId: `${unitId}-t1`, submittedAt: "2026-10-01T00:00:00Z", durationMs: 1000 },
    approvedVersion: { n: 1, takeId: `${unitId}-t1` },
    releases: [],
    updatedAt: "2026-10-01T00:00:00Z",
    ...opts,
  }
}

function makeFake(over: Partial<FakeLangQuest> = {}): FakeLangQuest {
  return { token: TOKEN, scopes: ["read", "release"], passages: [], changes: [], seen: [], released: [], ...over }
}

function install(fake: FakeLangQuest) {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      if (url.pathname.startsWith("/api/blobs/")) {
        fake.seen.push(`GET ${url.pathname}`)
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "audio/wav" } })
      }
      if (!req.url.startsWith(DEFAULT_LANGQUEST_API_BASE)) throw new Error(`unexpected fetch in test: ${req.url}`)
      const path = url.pathname.replace("/api/v1", "")
      fake.seen.push(`${req.method} ${path}${url.search}`)
      if (req.headers.get("Authorization") !== `Bearer ${fake.token}`) {
        return json(401, { error: "That token is not valid.", code: "unauthorized" })
      }
      if (path === "/me") {
        return json(200, {
          token: { id: "tok-1", orgId: "lq-org", name: "Aquilla", scopes: fake.scopes, languageIds: null, expiresAt: null },
          org: { id: "lq-org", name: "Kalam Team" },
          languages: [
            {
              languageId: "lang-kal",
              name: "Kalam",
              code: "kmh",
              country: "PG",
              can: { read: "all", review: true, release: fake.scopes.includes("release"), externalValues: { read: false, write: false } },
            },
            {
              languageId: "lang-none",
              name: "Hidden",
              code: "xxx",
              country: null,
              can: { read: null, review: false, release: false, externalValues: { read: false, write: false } },
            },
          ],
        })
      }
      if (path === "/languages/lang-kal/changes") {
        const after = url.searchParams.get("after")
        if (after === "expired") return json(410, { error: "too old", code: "cursor_expired" })
        const changes = fake.changes.filter((ch) => after == null || Number(ch.cursor) > Number(after))
        return json(200, { changes, cursor: changes.at(-1)?.cursor ?? after ?? "0", more: false })
      }
      if (path === "/languages/lang-kal/passages") {
        const ids = url.searchParams.getAll("unitIds")
        const list = ids.length ? fake.passages.filter((p) => ids.includes(p.unitId)) : fake.passages
        return json(200, { passages: list, nextAfter: null })
      }
      const release = path.match(/^\/languages\/lang-kal\/passages\/([^/]+)\/releases$/)
      if (release && req.method === "POST") {
        const body = (await req.json()) as { live: boolean }
        fake.released.push(`${decodeURIComponent(release[1]!)}:${body.live}`)
        return json(201, { ok: true })
      }
      if (path === "/token" && req.method === "DELETE") return json(200, { ok: true })
      return json(404, { error: "no such route", code: "not_found" })
    }),
  )
}

/**
 * wendi=org owner(700), anna=org maintainer(600); lee=project lead(500) and
 * tom=contributor(400) hold direct project grants, since org roles below
 * maintainer do not reach a project on their own.
 */
async function seedOrgProject() {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await seedUser(3, "lee")
  await seedUser(4, "tom")
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Kalam', 1)").run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES
      (1, 1, 700, 1), (1, 2, 600, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-1', 'Kalam oral', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES
      ('proj-1', 3, 500, 1), ('proj-1', 4, 400, 1)`,
  ).run()
}

async function seedLink(environment = runningEnvironment(aenv)) {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO langquest_links (project_id, token_enc, environment, api_base, lq_org_id, lq_org_name,
       language_id, language_name, language_code, scopes, created_by)
     VALUES ('proj-1', ?, ?, ?, 'lq-org', 'Kalam Team', 'lang-kal', 'Kalam', 'kmh', '["read","release"]', 'anna')`,
  )
    .bind(await encryptLangQuestToken(aenv, TOKEN), environment, DEFAULT_LANGQUEST_API_BASE)
    .run()
}

const request = async (username: string, method: string, path: string, body?: unknown) =>
  app.request(
    path,
    {
      method,
      headers: authHeader(await jwtFor(username)),
      ...(body !== undefined && { body: JSON.stringify(body) }),
    },
    aenv,
  )

describe("connecting a token", () => {
  it("inspect says what the token reaches and may do, and stores nothing", async () => {
    await seedOrgProject()
    install(makeFake())
    const res = await request("tom", "POST", "/api/v2/langquest/inspect", { token: TOKEN })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { org: { name: string }; token: { scopes: string[] }; languages: { code: string }[] }
    expect(body.org.name).toBe("Kalam Team")
    expect(body.token.scopes).toEqual(["read", "release"])
    expect(body.languages.map((l) => l.code)).toEqual(["kmh", "xxx"])
    const rows = await env.AQUILLA_PG.prepare("SELECT count(*) AS n FROM langquest_links").first<{ n: number }>()
    expect(Number(rows!.n)).toBe(0)
  })

  it("a revoked or mistyped token is a 401 the dialog can name", async () => {
    await seedOrgProject()
    install(makeFake({ token: "lqp_someoneElsesTokenXXXX" }))
    const res = await request("anna", "POST", "/api/v2/langquest/inspect", { token: TOKEN })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { needsReauth: boolean }).needsReauth).toBe(true)
  })

  it("linking stores the token encrypted and no route ever returns it", async () => {
    await seedOrgProject()
    install(makeFake())
    const put = await request("anna", "PUT", "/api/v2/langquest/projects/proj-1/link", { token: TOKEN, languageId: "lang-kal" })
    expect(put.status).toBe(200)
    const stored = await env.AQUILLA_PG.prepare("SELECT token_enc FROM langquest_links WHERE project_id = 'proj-1'").first<{ token_enc: string }>()
    expect(stored!.token_enc).not.toContain(TOKEN)
    // Any member may see that the project is linked — but never the token.
    const get = await request("tom", "GET", "/api/v2/langquest/projects/proj-1/link")
    const text = await get.text()
    expect(get.status).toBe(200)
    expect(text).toContain("Kalam Team")
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(stored!.token_enc)
  })

  it("opening a project never errors on a database migration 0185 has not reached", async () => {
    await seedOrgProject()
    await env.AQUILLA_PG.prepare("ALTER TABLE langquest_passages RENAME TO langquest_passages_away").run()
    await env.AQUILLA_PG.prepare("ALTER TABLE langquest_links RENAME TO langquest_links_away").run()
    try {
      const res = await request("tom", "GET", "/api/v2/langquest/projects/proj-1/link")
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ link: null })
    } finally {
      await env.AQUILLA_PG.prepare("ALTER TABLE langquest_links_away RENAME TO langquest_links").run()
      await env.AQUILLA_PG.prepare("ALTER TABLE langquest_passages_away RENAME TO langquest_passages").run()
    }
  })

  it("only a maintainer can link a project", async () => {
    await seedOrgProject()
    install(makeFake())
    const res = await request("lee", "PUT", "/api/v2/langquest/projects/proj-1/link", { token: TOKEN, languageId: "lang-kal" })
    expect(res.status).toBe(403)
  })

  it("refuses a language the token cannot read, so a link never starts out broken", async () => {
    await seedOrgProject()
    install(makeFake())
    const res = await request("anna", "PUT", "/api/v2/langquest/projects/proj-1/link", { token: TOKEN, languageId: "lang-none" })
    expect(res.status).toBe(400)
  })

  it("linking another language forgets the old passage map, so the next sync lists from scratch", async () => {
    await seedOrgProject()
    await seedLink()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO langquest_passages (project_id, unit_id, file_id, cell_id) VALUES ('proj-1', 'OLD', 'f', 'c')",
    ).run()
    await env.AQUILLA_PG.prepare("UPDATE langquest_links SET language_id = 'lang-old', feed_cursor = '9'").run()
    install(makeFake())
    await request("anna", "PUT", "/api/v2/langquest/projects/proj-1/link", { token: TOKEN, languageId: "lang-kal" })
    const state = (await (await request("lee", "GET", "/api/v2/langquest/projects/proj-1/state")).json()) as {
      cursor: string | null
      passages: unknown[]
    }
    expect(state.cursor).toBeNull()
    expect(state.passages).toEqual([])
  })
})

describe("syncing through the link", () => {
  it("reads the change feed with the stored token", async () => {
    await seedOrgProject()
    await seedLink()
    const fake = makeFake({ changes: [{ cursor: "5", type: "passage.version.submitted", unitId: "GEN.1.1-5", at: "x" }] })
    install(fake)
    const res = await request("lee", "GET", "/api/v2/langquest/projects/proj-1/changes?after=3")
    expect(res.status).toBe(200)
    expect(((await res.json()) as { cursor: string }).cursor).toBe("5")
    expect(fake.seen).toContain("GET /languages/lang-kal/changes?limit=1000&after=3")
  })

  it("a contributor cannot pull LangQuest data: syncing writes source cells", async () => {
    await seedOrgProject()
    await seedLink()
    install(makeFake())
    expect((await request("tom", "GET", "/api/v2/langquest/projects/proj-1/changes")).status).toBe(403)
  })

  it("an expired cursor comes back as 410 so the client relists", async () => {
    await seedOrgProject()
    await seedLink()
    install(makeFake())
    expect((await request("lee", "GET", "/api/v2/langquest/projects/proj-1/changes?after=expired")).status).toBe(410)
  })

  it("a token LangQuest stops accepting marks the link as needing a new one", async () => {
    await seedOrgProject()
    await seedLink()
    install(makeFake({ token: "lqp_revokedRevokedRevoked" }))
    const res = await request("lee", "GET", "/api/v2/langquest/projects/proj-1/passages")
    expect(res.status).toBe(401)
    const link = (await (await request("tom", "GET", "/api/v2/langquest/projects/proj-1/link")).json()) as {
      link: { needsReauth: boolean }
    }
    expect(link.link.needsReauth).toBe(true)
  })

  it("refuses a token stored by another deployment before decrypting it (AQU-1775)", async () => {
    await seedOrgProject()
    await seedLink("production-elsewhere")
    const fake = makeFake()
    install(fake)
    const res = await request("lee", "GET", "/api/v2/langquest/projects/proj-1/passages")
    expect(res.status).toBe(409)
    expect(fake.seen).toEqual([])
  })

  it("the audio proxy fetches LangQuest's own audio links and nothing else", async () => {
    await seedOrgProject()
    await seedLink()
    install(makeFake())
    const ok = await request("lee", "GET", `/api/v2/langquest/projects/proj-1/audio?url=${encodeURIComponent(BLOB)}`)
    expect(ok.status).toBe(200)
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    for (const bad of ["https://evil.example/api/blobs/x", "https://next.langquest.org/api/v1/me", "http://169.254.169.254/"]) {
      const res = await request("lee", "GET", `/api/v2/langquest/projects/proj-1/audio?url=${encodeURIComponent(bad)}`)
      expect(res.status).toBe(400)
    }
  })

  it("state round-trips the passage map and the cursor", async () => {
    await seedOrgProject()
    await seedLink()
    const post = await request("lee", "POST", "/api/v2/langquest/projects/proj-1/state", {
      upserts: [{ unitId: "GEN.1.1-5", fileId: "f1", cellId: "c1", label: "Genesis 1:1-5", order: "001", takeId: "t1" }],
      cursor: "12",
      outcome: { error: null },
    })
    expect(post.status).toBe(200)
    await request("lee", "POST", "/api/v2/langquest/projects/proj-1/state", { removed: ["GEN.1.1-5"] })
    const state = (await (await request("lee", "GET", "/api/v2/langquest/projects/proj-1/state")).json()) as {
      cursor: string
      passages: unknown[]
      link: { lastSyncedAt: string | null }
    }
    expect(state.cursor).toBe("12")
    expect(state.passages).toEqual([])
    expect(state.link.lastSyncedAt).not.toBeNull()
  })
})

describe("publishing from Aquilla", () => {
  it("reports only approved versions, and skips ones already live on that channel", async () => {
    await seedOrgProject()
    await seedLink()
    const fake = makeFake({
      passages: [
        passage("A"),
        passage("B", { approvedVersion: null, status: "in_review" }),
        passage("C", { releases: [{ channel: "Every Language", versionN: 1, takeId: "C-t1", at: "x" }] }),
      ],
    })
    install(fake)
    const res = await request("anna", "POST", "/api/v2/langquest/projects/proj-1/releases", {
      channel: "Every Language",
      live: true,
    })
    expect(await res.json()).toEqual({ released: 1, unchanged: 2, failed: [] })
    expect(fake.released).toEqual(["A:true"])
  })

  it("taking down touches every passage with something live on the channel, even an older version", async () => {
    await seedOrgProject()
    await seedLink()
    const fake = makeFake({
      passages: [
        passage("A", { releases: [{ channel: "Every Language", versionN: 1, takeId: "old", at: "x" }] }),
        passage("B"),
      ],
    })
    install(fake)
    await request("anna", "POST", "/api/v2/langquest/projects/proj-1/releases", { channel: "Every Language", live: false })
    expect(fake.released).toEqual(["A:false"])
  })

  it("needs a token with the release scope", async () => {
    await seedOrgProject()
    await seedLink()
    await env.AQUILLA_PG.prepare(`UPDATE langquest_links SET scopes = '["read"]'`).run()
    install(makeFake())
    const res = await request("anna", "POST", "/api/v2/langquest/projects/proj-1/releases", { channel: "X", live: true })
    expect(res.status).toBe(403)
  })
})
