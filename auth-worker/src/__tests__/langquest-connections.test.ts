// Account-level LangQuest connections (routes/langquest-connections.ts,
// lib/langquest/connections.ts) and the link route's use of them.
//
// The contract: a token pasted once is stored encrypted for (user, LangQuest
// org) and never returned; a second project links from the saved connection
// without a token; LangQuest rejecting the token flips the connection (and the
// links made from it) to needs_reauth; reconnecting refreshes every link's
// token copy; a connection is private to the user who pasted it.

import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"
import { DEFAULT_LANGQUEST_API_BASE } from "../lib/langquest/client"
import { connectionHealth } from "../lib/langquest/connections"
import type { Env } from "../types"

const aenv = env as unknown as Env
const TOKEN = "lqp_Sq3k1yA0bJxL6tWm9cZr2eVu"
const TOKEN2 = "lqp_SecondTokenForTheSameOrgX"

afterEach(() => vi.unstubAllGlobals())

/** LangQuest accepting `tokens`, all for the same org, unless `down`. */
function installFake(opts: { tokens?: string[]; down?: boolean; expiresAt?: string | null } = {}) {
  const tokens = opts.tokens ?? [TOKEN]
  const seen: string[] = []
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      if (!req.url.startsWith(DEFAULT_LANGQUEST_API_BASE)) throw new Error(`unexpected fetch in test: ${req.url}`)
      const path = new URL(req.url).pathname.replace("/api/v1", "")
      seen.push(`${req.method} ${path}`)
      if (opts.down) throw new TypeError("fetch failed")
      const auth = req.headers.get("Authorization") ?? ""
      if (!tokens.some((t) => auth === `Bearer ${t}`)) {
        return json(401, { error: "That token is not valid.", code: "unauthorized" })
      }
      if (path === "/me") {
        return json(200, {
          token: { id: `tok-${auth.slice(-4)}`, orgId: "lq-org", name: "Aquilla", scopes: ["read"], languageIds: null, expiresAt: opts.expiresAt ?? null },
          org: { id: "lq-org", name: "Kalam Team" },
          languages: [
            { languageId: "lang-kal", name: "Kalam", code: "kmh", country: "PG", can: { read: "all", review: false, release: false, externalValues: { read: false, write: false } } },
            { languageId: "lang-ipi", name: "Ipili", code: "ipi", country: "PG", can: { read: "all", review: false, release: false, externalValues: { read: false, write: false } } },
          ],
        })
      }
      if (path === "/token" && req.method === "DELETE") return json(200, { ok: true })
      return json(404, { error: "no such route", code: "not_found" })
    }),
  )
  return seen
}

async function seed() {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Kalam', 1)").run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 600, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-1', 'Kalam oral', 1, 1), ('proj-2', 'Ipili oral', 1, 1)",
  ).run()
}

const request = async (username: string, method: string, path: string, body?: unknown) =>
  app.request(
    path,
    { method, headers: authHeader(await jwtFor(username)), ...(body !== undefined && { body: JSON.stringify(body) }) },
    aenv,
  )

type Conn = { id: string; org: { name: string }; health: string; linkedProjects: number; token: { scopes: string[] } }

async function connect(username = "anna", token = TOKEN) {
  const res = await request(username, "POST", "/api/v2/langquest/connections", { token })
  expect(res.status).toBe(200)
  return (await res.json()) as { connection: Conn; languages: { languageId: string }[] }
}

describe("connecting an account to a LangQuest org", () => {
  it("stores the token encrypted for (user, org), returns the org's languages, and never returns the token", async () => {
    await seed()
    installFake()
    const { connection, languages } = await connect()
    expect(connection.org.name).toBe("Kalam Team")
    expect(connection.health).toBe("ok")
    expect(languages.map((l) => l.languageId)).toEqual(["lang-kal", "lang-ipi"])
    const row = await env.AQUILLA_PG.prepare("SELECT token_enc, user_id FROM langquest_connections").first<{ token_enc: string; user_id: number }>()
    expect(row!.token_enc).not.toContain(TOKEN)
    expect(Number(row!.user_id)).toBe(2)
    const list = await request("anna", "GET", "/api/v2/langquest/connections")
    const text = await list.text()
    expect(text).toContain("Kalam Team")
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain(row!.token_enc)
  })

  it("a second token for the same org refreshes the one connection rather than adding another", async () => {
    await seed()
    installFake({ tokens: [TOKEN, TOKEN2] })
    const first = await connect("anna", TOKEN)
    const second = await connect("anna", TOKEN2)
    expect(second.connection.id).toBe(first.connection.id)
    const n = await env.AQUILLA_PG.prepare("SELECT count(*) AS n FROM langquest_connections").first<{ n: number }>()
    expect(Number(n!.n)).toBe(1)
  })

  it("a rejected token connects nothing", async () => {
    await seed()
    installFake()
    const res = await request("anna", "POST", "/api/v2/langquest/connections", { token: TOKEN2 })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { needsReauth: boolean }).needsReauth).toBe(true)
    const n = await env.AQUILLA_PG.prepare("SELECT count(*) AS n FROM langquest_connections").first<{ n: number }>()
    expect(Number(n!.n)).toBe(0)
  })

  it("is private: another user neither lists it nor can read its languages", async () => {
    await seed()
    installFake()
    const { connection } = await connect("anna")
    const list = (await (await request("wendi", "GET", "/api/v2/langquest/connections")).json()) as { connections: Conn[] }
    expect(list.connections).toEqual([])
    const langs = await request("wendi", "GET", `/api/v2/langquest/connections/${connection.id}/languages`)
    expect(langs.status).toBe(404)
    const del = await request("wendi", "DELETE", `/api/v2/langquest/connections/${connection.id}`)
    expect(del.status).toBe(404)
  })
})

describe("linking projects from a connection", () => {
  it("links a second project with no token, and the connection counts both", async () => {
    await seed()
    installFake()
    const { connection } = await connect("anna")
    const one = await request("anna", "PUT", "/api/v2/langquest/projects/proj-1/link", { connectionId: connection.id, languageId: "lang-kal" })
    expect(one.status).toBe(200)
    const two = await request("anna", "PUT", "/api/v2/langquest/projects/proj-2/link", { connectionId: connection.id, languageId: "lang-ipi" })
    expect(two.status).toBe(200)
    const link = ((await two.json()) as { link: { connectionId: string; language: { code: string } } }).link
    expect(link.connectionId).toBe(connection.id)
    expect(link.language.code).toBe("ipi")
    const list = (await (await request("anna", "GET", "/api/v2/langquest/connections")).json()) as { connections: Conn[] }
    expect(list.connections[0]!.linkedProjects).toBe(2)
  })

  it("refuses another user's connection id", async () => {
    await seed()
    installFake()
    const { connection } = await connect("anna")
    const res = await request("wendi", "PUT", "/api/v2/langquest/projects/proj-1/link", { connectionId: connection.id, languageId: "lang-kal" })
    expect(res.status).toBe(404)
  })

  it("a token pasted on a project link also becomes the user's connection to that org", async () => {
    await seed()
    installFake()
    const res = await request("anna", "PUT", "/api/v2/langquest/projects/proj-1/link", { token: TOKEN, languageId: "lang-kal" })
    expect(res.status).toBe(200)
    const list = (await (await request("anna", "GET", "/api/v2/langquest/connections")).json()) as { connections: Conn[] }
    expect(list.connections).toHaveLength(1)
    expect(list.connections[0]!.linkedProjects).toBe(1)
    expect(((await res.json()) as { link: { connectionId: string } }).link.connectionId).toBe(list.connections[0]!.id)
  })
})

describe("connection health", () => {
  it("LangQuest rejecting the token marks the connection and its links needs_reauth; reconnecting clears both", async () => {
    await seed()
    installFake()
    const { connection } = await connect("anna")
    await request("anna", "PUT", "/api/v2/langquest/projects/proj-1/link", { connectionId: connection.id, languageId: "lang-kal" })
    // The token is revoked at LangQuest.
    installFake({ tokens: [TOKEN2] })
    const probe = await request("anna", "GET", `/api/v2/langquest/connections/${connection.id}/languages`)
    expect(probe.status).toBe(401)
    const after = (await (await request("anna", "GET", "/api/v2/langquest/connections")).json()) as { connections: Conn[] }
    expect(after.connections[0]!.health).toBe("needs_reauth")
    const linkRow = await env.AQUILLA_PG.prepare("SELECT needs_reauth FROM langquest_links WHERE project_id = 'proj-1'").first<{ needs_reauth: boolean }>()
    expect(linkRow!.needs_reauth).toBe(true)
    // A fresh token for the same org repairs the connection and the link's copy.
    const re = await connect("anna", TOKEN2)
    expect(re.connection.id).toBe(connection.id)
    expect(re.connection.health).toBe("ok")
    const linkAfter = await env.AQUILLA_PG.prepare("SELECT needs_reauth FROM langquest_links WHERE project_id = 'proj-1'").first<{ needs_reauth: boolean }>()
    expect(linkAfter!.needs_reauth).toBe(false)
    const changes = await request("anna", "GET", "/api/v2/langquest/projects/proj-1/changes")
    expect(changes.status).not.toBe(401)
  })

  it("a link's rejected token marks the connection it was made from", async () => {
    await seed()
    installFake()
    const { connection } = await connect("anna")
    await request("anna", "PUT", "/api/v2/langquest/projects/proj-1/link", { connectionId: connection.id, languageId: "lang-kal" })
    installFake({ tokens: [] })
    const res = await request("anna", "GET", "/api/v2/langquest/projects/proj-1/changes")
    expect(res.status).toBe(401)
    const after = (await (await request("anna", "GET", "/api/v2/langquest/connections")).json()) as { connections: Conn[] }
    expect(after.connections[0]!.health).toBe("needs_reauth")
  })

  it("LangQuest being unreachable is noted as unreachable, not as a rejected token", async () => {
    await seed()
    installFake()
    const { connection } = await connect("anna")
    installFake({ down: true })
    const check = await request("anna", "POST", `/api/v2/langquest/connections/${connection.id}/check`)
    expect(check.status).toBe(502)
    const body = (await check.json()) as { connection: Conn }
    expect(body.connection.health).toBe("unreachable")
    const row = await env.AQUILLA_PG.prepare("SELECT needs_reauth FROM langquest_connections").first<{ needs_reauth: boolean }>()
    expect(row!.needs_reauth).toBe(false)
  })

  it("an expiry in the past reads as expired before LangQuest is asked", () => {
    const base = { needs_reauth: false, last_error: null }
    expect(connectionHealth({ ...base, token_expires_at: "2020-01-01T00:00:00Z" })).toBe("expired")
    expect(connectionHealth({ ...base, token_expires_at: "2999-01-01T00:00:00Z" })).toBe("ok")
    expect(connectionHealth({ ...base, token_expires_at: null })).toBe("ok")
    expect(connectionHealth({ needs_reauth: true, token_expires_at: null, last_error: null })).toBe("needs_reauth")
    expect(connectionHealth({ ...base, token_expires_at: null, last_error: "fetch failed" })).toBe("unreachable")
  })

  it("disconnecting forgets the connection, revokes on request, and leaves the project link in place", async () => {
    await seed()
    const seen = installFake()
    const { connection } = await connect("anna")
    await request("anna", "PUT", "/api/v2/langquest/projects/proj-1/link", { connectionId: connection.id, languageId: "lang-kal" })
    const del = await request("anna", "DELETE", `/api/v2/langquest/connections/${connection.id}?revoke=1`)
    expect(del.status).toBe(200)
    expect(((await del.json()) as { revoked: boolean }).revoked).toBe(true)
    expect(seen).toContain("DELETE /token")
    const link = await env.AQUILLA_PG.prepare("SELECT connection_id FROM langquest_links WHERE project_id = 'proj-1'").first<{ connection_id: string | null }>()
    expect(link).not.toBeNull()
    expect(link!.connection_id).toBeNull()
  })
})
