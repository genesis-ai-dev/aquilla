// Monday.com integration routes (routes/monday.ts + lib/monday/*).
//
// Global fetch is mocked per-test — no request ever leaves the process. The
// DB is the shared PGlite (schema.sql), so the new monday_* tables are
// exercised for real.

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import { sign } from "hono/jwt"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import {
  encryptMondayToken,
  decryptMondayToken,
  codeChallengeS256,
} from "../lib/monday/crypto"

const menv = {
  ...env,
  MONDAY_CLIENT_ID: "test-client-id",
  MONDAY_CLIENT_SECRET: "test-client-secret",
  MONDAY_SIGNING_SECRET: "test-signing-secret",
  OPENROUTER_API_KEY: "test-openrouter-key",
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

/** Install a fetch mock routed by URL + request body. */
function mockFetch(handler: (url: string, body: string) => Response | null) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : ""
    const res = handler(url, body)
    if (!res) throw new Error(`unexpected fetch in test: ${url} ${body.slice(0, 120)}`)
    return res
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

/** wendi=owner(700), anna=maintainer(600), tom=contributor(400), stranger=none; project proj-1 in org 1. */
async function seedOrgProject() {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await seedUser(3, "tom")
  await seedUser(4, "stranger")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES
      (1, 1, 700, 1), (1, 2, 600, 1), (1, 3, 400, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-1', 'Ruth Translation', 1, 1)",
  ).run()
}

/** Fake Monday access-token JWT with an exp claim (no real signature). */
const fakeAccessJwt = (expSec: number): string => {
  const b64url = (s: string) => Buffer.from(s).toString("base64url")
  return `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url(JSON.stringify({ exp: expSec }))}.fakesig`
}

async function seedConnection(
  opts: {
    accessToken?: string
    refreshToken?: string | null
    /** ms until access-token expiry; null/omitted = non-expiring legacy row. */
    expiresInMs?: number | null
  } = {},
): Promise<string> {
  const accessEnc = await encryptMondayToken(
    env.SECRET_KEY,
    opts.accessToken ?? "monday-plain-token",
  )
  const refreshEnc = opts.refreshToken
    ? await encryptMondayToken(env.SECRET_KEY, opts.refreshToken)
    : null
  const expiresAt =
    opts.expiresInMs != null ? new Date(Date.now() + opts.expiresInMs).toISOString() : null
  await env.AQUILLA_PG.prepare(
    `INSERT INTO integration_connections (id, org_id, provider, account, access_token_enc, refresh_token_enc, access_token_expires_at, created_by)
     VALUES ('conn-1', '1', 'monday', '{"accountSlug":"acme"}', ?, ?, ?, 'wendi')`,
  )
    .bind(accessEnc, refreshEnc, expiresAt)
    .run()
  return "conn-1"
}

const baseConfig = {
  version: 1,
  itemGranularity: "project",
  columns: [{ columnId: "numbers_1", columnType: "numbers", metric: "completion_pct" }],
}

async function seedLink(overrides: { lastPushedAt?: "now" | null; config?: unknown } = {}) {
  await seedConnection()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO integration_links (id, project_id, provider, connection_id, external_id, external_name, config, created_by, last_pushed_at)
     VALUES ('link-1', 'proj-1', 'monday', 'conn-1', 'board-9', 'Ruth Board', ?, 'wendi',
             ${overrides.lastPushedAt === "now" ? "now()" : "NULL"})`,
  )
    .bind(JSON.stringify(overrides.config ?? baseConfig))
    .run()
  return "link-1"
}

const request = async (
  username: string | null,
  method: string,
  path: string,
  body?: unknown,
) =>
  app.request(
    path,
    {
      method,
      headers: username ? authHeader(await jwtFor(username)) : { "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    },
    menv,
  )

// ── Role gating ────────────────────────────────────────────────────────────

describe("monday role gating", () => {
  it("contributor (400) gets 403 on connection/start; maintainer (600) gets a URL", async () => {
    await seedOrgProject()
    const denied = await request("tom", "POST", "/api/v2/monday/orgs/1/connection/start", {})
    expect(denied.status).toBe(403)

    const ok = await request("anna", "POST", "/api/v2/monday/orgs/1/connection/start", {})
    expect(ok.status).toBe(200)
    const { url } = (await ok.json()) as { url: string }
    expect(url).toContain("https://auth.monday.com/oauth2/authorize")
    expect(url).toContain("client_id=test-client-id")
    expect(url).toContain("state=")
    expect(url).toContain("force_install_if_needed=true")
  })

  it("rejects an absolute-URL backTo (open-redirect guard)", async () => {
    await seedOrgProject()
    const res = await request("anna", "POST", "/api/v2/monday/orgs/1/connection/start", {
      backTo: "https://evil.example/phish",
    })
    expect(res.status).toBe(400)
  })

  it("contributor (400) gets 403 on PUT /projects/:id/link", async () => {
    await seedOrgProject()
    const res = await request("tom", "PUT", "/api/v2/monday/projects/proj-1/link", {
      boardId: "board-9",
      config: baseConfig,
    })
    expect(res.status).toBe(403)
  })

  it("non-member gets 403 on GET connection; member sees connected:false", async () => {
    await seedOrgProject()
    const denied = await request("stranger", "GET", "/api/v2/monday/orgs/1/connection")
    expect(denied.status).toBe(403)

    const ok = await request("tom", "GET", "/api/v2/monday/orgs/1/connection")
    expect(ok.status).toBe(200)
    // installUrl is Monday's public install link (derived from the client id) —
    // surfaced even before a connection exists so users can install the app
    // or forward the link to their Monday admin.
    expect(await ok.json()).toEqual({
      connected: false,
      installUrl:
        "https://auth.monday.com/oauth2/authorize?client_id=test-client-id&response_type=install",
    })
  })
})

// ── OAuth callback ─────────────────────────────────────────────────────────

describe("GET /api/v2/monday/oauth/callback", () => {
  it("runs the full PKCE flow: challenge in authorize URL, verifier at exchange, ENCRYPTED tokens stored", async () => {
    await seedOrgProject()
    const accessJwt = fakeAccessJwt(Math.floor(Date.now() / 1000) + 3600)
    let exchangeBody = ""
    mockFetch((url, body) => {
      if (url.startsWith("https://auth.monday.com/oauth_ms/oauth/token")) {
        exchangeBody = body
        return jsonResponse({
          access_token: accessJwt,
          refresh_token: "refresh-tok-1",
          token_type: "Bearer",
          scope: "boards:read boards:write",
        })
      }
      if (url.startsWith("https://api.monday.com/v2")) {
        return jsonResponse({ data: { me: { id: 7, name: "Anna M", account: { id: 99, slug: "acme" } } } })
      }
      return null
    })

    // Start the flow for real so the state carries the encrypted verifier.
    const startRes = await request("anna", "POST", "/api/v2/monday/orgs/1/connection/start", {})
    expect(startRes.status).toBe(200)
    const { url } = (await startRes.json()) as { url: string }
    const authorizeUrl = new URL(url)
    const state = authorizeUrl.searchParams.get("state")!
    const codeChallenge = authorizeUrl.searchParams.get("code_challenge")!
    expect(codeChallenge).toBeTruthy()
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256")

    const res = await app.request(
      `/api/v2/monday/oauth/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      {},
      menv,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, backTo: "/settings/monday" })

    // Token exchange hit the NEW OAuth 2.1 endpoint with the PKCE verifier —
    // and the verifier matches the challenge we sent in the authorize URL.
    const params = new URLSearchParams(exchangeBody)
    expect(params.get("grant_type")).toBe("authorization_code")
    const sentVerifier = params.get("code_verifier")!
    expect(sentVerifier).toBeTruthy()
    expect(await codeChallengeS256(sentVerifier)).toBe(codeChallenge)

    const row = await env.AQUILLA_PG.prepare(
      `SELECT access_token_enc, refresh_token_enc, access_token_expires_at, needs_reauth, provider, account
         FROM integration_connections WHERE org_id = '1'`,
    ).first<{
      access_token_enc: string
      refresh_token_enc: string
      access_token_expires_at: string | null
      needs_reauth: boolean
      provider: string
      account: { accountSlug?: string; userName?: string } | string
    }>()
    expect(row).not.toBeNull()
    // Neither token stored in plaintext — both round-trip through decrypt.
    expect(row!.access_token_enc).not.toContain(accessJwt)
    expect(await decryptMondayToken(env.SECRET_KEY, row!.access_token_enc)).toBe(accessJwt)
    expect(row!.refresh_token_enc).not.toContain("refresh-tok-1")
    expect(await decryptMondayToken(env.SECRET_KEY, row!.refresh_token_enc)).toBe("refresh-tok-1")
    // Expiry captured from the access-token JWT exp claim; needs_reauth cleared.
    expect(row!.access_token_expires_at).not.toBeNull()
    expect(row!.needs_reauth).toBe(false)
    expect(row!.provider).toBe("monday")
    const account =
      typeof row!.account === "string"
        ? (JSON.parse(row!.account) as { accountSlug?: string; userName?: string })
        : row!.account
    expect(account.accountSlug).toBe("acme")
    expect(account.userName).toBe("Anna M")
  })

  it("rejects a valid-signature state that lacks the PKCE verifier claim", async () => {
    await seedOrgProject()
    mockFetch(() => null)
    const now = Math.floor(Date.now() / 1000)
    const state = await sign(
      { orgId: 1, userId: "anna", backTo: "/settings/monday", iat: now, exp: now + 600 },
      env.SECRET_KEY,
      "HS256",
    )
    const res = await app.request(
      `/api/v2/monday/oauth/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      {},
      menv,
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, reason: "bad_state" })
  })

  it("rejects a bad state JWT with 401 (no internals leaked)", async () => {
    await seedOrgProject()
    mockFetch(() => null)
    const res = await app.request(
      "/api/v2/monday/oauth/callback?code=auth-code&state=not-a-jwt",
      {},
      menv,
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, reason: "bad_state" })
    const count = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM integration_connections",
    ).first<{ n: number }>()
    expect(Number(count!.n)).toBe(0)
  })
})

// ── Webhook ────────────────────────────────────────────────────────────────

describe("POST /api/v2/monday/webhook", () => {
  it("echoes the challenge JSON exactly (no auth required)", async () => {
    const res = await app.request(
      "/api/v2/monday/webhook",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge: "abc-123" }),
      },
      menv,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ challenge: "abc-123" })
  })

  it("rejects a non-challenge event without a valid signing-secret JWT", async () => {
    const res = await app.request(
      "/api/v2/monday/webhook",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "garbage" },
        body: JSON.stringify({ event: { type: "item_deleted", boardId: "board-9", itemId: "42" } }),
      },
      menv,
    )
    expect(res.status).toBe(401)
  })

  it("item_deleted clears the matching item link; create_column marks structure stale", async () => {
    await seedOrgProject()
    await seedLink()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO integration_item_links (link_id, entity_kind, entity_id, external_item_id) VALUES ('link-1', 'project', 'proj-1', 'item-42')",
    ).run()

    const now = Math.floor(Date.now() / 1000)
    const webhookJwt = await sign({ iat: now, exp: now + 300 }, menv.MONDAY_SIGNING_SECRET, "HS256")
    const post = (event: Record<string, unknown>) =>
      app.request(
        "/api/v2/monday/webhook",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${webhookJwt}` },
          body: JSON.stringify({ event }),
        },
        menv,
      )

    const del = await post({ type: "item_deleted", boardId: "board-9", itemId: "item-42" })
    expect(del.status).toBe(200)
    const remaining = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM integration_item_links",
    ).first<{ n: number }>()
    expect(Number(remaining!.n)).toBe(0)

    const col = await post({ type: "create_column", boardId: "board-9", columnId: "new_col" })
    expect(col.status).toBe(200)
    const link = await env.AQUILLA_PG.prepare(
      "SELECT remote_state_stale FROM integration_links WHERE id = 'link-1'",
    ).first<{ remote_state_stale: boolean }>()
    expect(link!.remote_state_stale).toBe(true)
  })
})

// ── Internal push (debounce) ───────────────────────────────────────────────

describe("POST /api/v2/monday/internal/push", () => {
  const internalPush = (auth: string) =>
    app.request(
      "/api/v2/monday/internal/push",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({ projectId: "proj-1" }),
      },
      menv,
    )

  it("rejects a wrong bearer", async () => {
    const res = await internalPush("Bearer wrong")
    expect(res.status).toBe(401)
  })

  it("debounces when the last push is recent: sets dirty_at, does not push", async () => {
    await seedOrgProject()
    await seedLink({ lastPushedAt: "now" })
    const fetchMock = mockFetch(() => null) // any outbound call would throw

    const res = await internalPush(`Bearer ${env.SYNC_SECRET_KEY}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, pushed: false })
    expect(fetchMock).not.toHaveBeenCalled()

    const link = await env.AQUILLA_PG.prepare(
      "SELECT dirty_at FROM integration_links WHERE id = 'link-1'",
    ).first<{ dirty_at: string | null }>()
    expect(link!.dirty_at).not.toBeNull()
  })

  it("pushes immediately when never pushed before: creates the item + link row", async () => {
    await seedOrgProject()
    await seedLink({ lastPushedAt: null })
    mockFetch((url, body) => {
      if (url.startsWith("https://api.monday.com/v2") && body.includes("create_item")) {
        return jsonResponse({ data: { c0: { id: "901" } } })
      }
      return null
    })

    const res = await internalPush(`Bearer ${env.SYNC_SECRET_KEY}`)
    expect(res.status).toBe(200)
    const result = (await res.json()) as { ok: boolean; pushed: boolean; itemsUpserted?: number }
    expect(result.ok).toBe(true)
    expect(result.pushed).toBe(true)
    expect(result.itemsUpserted).toBe(1)

    const itemLink = await env.AQUILLA_PG.prepare(
      "SELECT external_item_id FROM integration_item_links WHERE link_id = 'link-1' AND entity_kind = 'project' AND entity_id = 'proj-1'",
    ).first<{ external_item_id: string }>()
    expect(itemLink!.external_item_id).toBe("901")

    const link = await env.AQUILLA_PG.prepare(
      "SELECT last_push_status, dirty_at FROM integration_links WHERE id = 'link-1'",
    ).first<{ last_push_status: string; dirty_at: string | null }>()
    expect(link!.last_push_status).toBe("ok")
    expect(link!.dirty_at).toBeNull()
  })
})

// ── Config validation (PUT link) ───────────────────────────────────────────

describe("PUT /api/v2/monday/projects/:projectId/link", () => {
  it("drops columns unknown to the live board (warn-not-fail) and stores the link", async () => {
    await seedOrgProject()
    await seedConnection()
    mockFetch((url, body) => {
      if (!url.startsWith("https://api.monday.com/v2")) return null
      if (body.includes("settings_str")) {
        return jsonResponse({
          data: {
            boards: [
              {
                columns: [
                  { id: "numbers_1", title: "Progress", type: "numbers" },
                  { id: "text_ext", title: "External Id", type: "text" },
                ],
                groups: [{ id: "topics", title: "Topics" }],
              },
            ],
          },
        })
      }
      if (body.includes("create_webhook")) {
        return jsonResponse({ data: { create_webhook: { id: 111 } } })
      }
      return null
    })

    const res = await request("anna", "PUT", "/api/v2/monday/projects/proj-1/link", {
      boardId: "board-9",
      boardName: "Ruth Board",
      config: {
        version: 1,
        itemGranularity: "project",
        columns: [
          { columnId: "numbers_1", columnType: "numbers", metric: "completion_pct" },
          { columnId: "ghost_col", columnType: "numbers", metric: "filled_count" },
        ],
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      link: { boardId: string; config: { columns: Array<{ columnId: string }> } }
      warnings: string[]
    }
    expect(body.link.boardId).toBe("board-9")
    expect(body.link.config.columns.map((c) => c.columnId)).toEqual(["numbers_1"])
    expect(body.warnings.some((w) => w.includes("ghost_col"))).toBe(true)

    const row = await env.AQUILLA_PG.prepare(
      "SELECT webhook_ids FROM integration_links WHERE project_id = 'proj-1'",
    ).first<{ webhook_ids: unknown }>()
    expect(row).not.toBeNull()
  })

  it("409s when the org has no Monday connection", async () => {
    await seedOrgProject()
    const res = await request("anna", "PUT", "/api/v2/monday/projects/proj-1/link", {
      boardId: "board-9",
      config: baseConfig,
    })
    expect(res.status).toBe(409)
  })
})

// ── AI analyze clamping ────────────────────────────────────────────────────

describe("POST /api/v2/monday/projects/:projectId/analyze", () => {
  it("clamps LLM proposals: read-only column types are dropped server-side", async () => {
    await seedOrgProject()
    await seedConnection()
    mockFetch((url, body) => {
      if (url.startsWith("https://api.monday.com/v2")) {
        if (body.includes("settings_str")) {
          return jsonResponse({
            data: {
              boards: [
                {
                  columns: [
                    { id: "numbers_1", title: "Progress", type: "numbers" },
                    { id: "formula_1", title: "Computed", type: "formula" },
                  ],
                  groups: [],
                },
              ],
            },
          })
        }
        if (body.includes("items_page")) {
          return jsonResponse({ data: { boards: [{ items_page: { items: [] } }] } })
        }
        return null
      }
      if (url.includes("/chat/completions")) {
        return jsonResponse({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  mapping: {
                    version: 1,
                    itemGranularity: "project",
                    columns: [
                      { columnId: "formula_1", columnType: "formula", metric: "completion_pct" },
                      { columnId: "numbers_1", columnType: "numbers", metric: "completion_pct" },
                    ],
                    notes: "Mapped progress.",
                  },
                  summary: "Maps completion to the Progress column.",
                }),
              },
            },
          ],
        })
      }
      return null
    })

    const res = await request("anna", "POST", "/api/v2/monday/projects/proj-1/analyze", {
      boardId: "board-9",
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      proposal: { columns: Array<{ columnId: string }> }
      summary: string
    }
    expect(body.proposal.columns.map((c) => c.columnId)).toEqual(["numbers_1"])
    expect(body.summary).toContain("Progress")
  })

  it("contributor (400) gets 403", async () => {
    await seedOrgProject()
    const res = await request("tom", "POST", "/api/v2/monday/projects/proj-1/analyze", {
      boardId: "board-9",
    })
    expect(res.status).toBe(403)
  })
})

// ── OAuth 2.1 token refresh ────────────────────────────────────────────────

describe("monday token refresh (OAuth 2.1)", () => {
  it("refreshes a near-expiry access token and persists BOTH rotated tokens", async () => {
    await seedOrgProject()
    // Expires in 30s — inside the 60s refresh window.
    await seedConnection({
      accessToken: "old-access",
      refreshToken: "refresh-old",
      expiresInMs: 30_000,
    })
    const newAccessJwt = fakeAccessJwt(Math.floor(Date.now() / 1000) + 3600)
    let refreshBody = ""
    let boardsAuthHeader = ""
    mockFetch((url, body) => {
      if (url.startsWith("https://auth.monday.com/oauth_ms/oauth/token")) {
        refreshBody = body
        return jsonResponse({
          access_token: newAccessJwt,
          refresh_token: "refresh-new",
          token_type: "Bearer",
        })
      }
      if (url.startsWith("https://api.monday.com/v2")) {
        return jsonResponse({ data: { boards: [] } })
      }
      return null
    })
    // Capture the Authorization header the boards call ends up using.
    const rawFetch = global.fetch
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        if (url.startsWith("https://api.monday.com/v2")) {
          boardsAuthHeader = String((init?.headers as Record<string, string>)?.Authorization ?? "")
        }
        return rawFetch(input, init)
      }),
    )

    const res = await request("anna", "GET", "/api/v2/monday/orgs/1/boards")
    expect(res.status).toBe(200)

    // The refresh grant was sent with the OLD refresh token…
    const params = new URLSearchParams(refreshBody)
    expect(params.get("grant_type")).toBe("refresh_token")
    expect(params.get("refresh_token")).toBe("refresh-old")
    // …the API call used the NEW access token…
    expect(boardsAuthHeader).toBe(newAccessJwt)

    // …and BOTH rotated tokens were persisted encrypted, expiry updated.
    const row = await env.AQUILLA_PG.prepare(
      "SELECT access_token_enc, refresh_token_enc, access_token_expires_at, needs_reauth FROM integration_connections WHERE id = 'conn-1'",
    ).first<{
      access_token_enc: string
      refresh_token_enc: string
      access_token_expires_at: string
      needs_reauth: boolean
    }>()
    expect(await decryptMondayToken(env.SECRET_KEY, row!.access_token_enc)).toBe(newAccessJwt)
    expect(await decryptMondayToken(env.SECRET_KEY, row!.refresh_token_enc)).toBe("refresh-new")
    expect(new Date(row!.access_token_expires_at).getTime()).toBeGreaterThan(Date.now() + 60_000)
    expect(row!.needs_reauth).toBe(false)
  })

  it("does NOT refresh a legacy non-expiring token (no expiry stored)", async () => {
    await seedOrgProject()
    await seedConnection({ accessToken: "legacy-token" }) // no expiry, no refresh token
    const fetchMock = mockFetch((url) => {
      if (url.startsWith("https://api.monday.com/v2")) {
        return jsonResponse({ data: { boards: [] } })
      }
      return null // a token-endpoint call would throw
    })
    const res = await request("anna", "GET", "/api/v2/monday/orgs/1/boards")
    expect(res.status).toBe(200)
    const tokenCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("oauth_ms"),
    )
    expect(tokenCalls).toHaveLength(0)
  })

  it("marks the connection needs_reauth on refresh failure (row kept) and reports it", async () => {
    await seedOrgProject()
    await seedConnection({
      accessToken: "old-access",
      refreshToken: "refresh-dead",
      expiresInMs: 30_000,
    })
    mockFetch((url) => {
      if (url.startsWith("https://auth.monday.com/oauth_ms/oauth/token")) {
        return jsonResponse({ error: "invalid_grant" }, 400)
      }
      return null
    })

    const res = await request("anna", "GET", "/api/v2/monday/orgs/1/boards")
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: "Monday connection needs re-authorization",
      needsReauth: true,
    })

    // The connection row survives, flagged for re-auth…
    const row = await env.AQUILLA_PG.prepare(
      "SELECT needs_reauth FROM integration_connections WHERE id = 'conn-1'",
    ).first<{ needs_reauth: boolean }>()
    expect(row!.needs_reauth).toBe(true)

    // …and the connection GET surfaces it.
    const connRes = await request("tom", "GET", "/api/v2/monday/orgs/1/connection")
    expect(connRes.status).toBe(200)
    const conn = (await connRes.json()) as { connected: boolean; needsReauth: boolean }
    expect(conn.connected).toBe(true)
    expect(conn.needsReauth).toBe(true)
  })
})

// ── Analyze robustness (LLM output parsing + upstream errors) ──────────────

describe("analyze LLM robustness", () => {
  const mondayStructureMock = (url: string, body: string): Response | null => {
    if (!url.startsWith("https://api.monday.com/v2")) return null
    if (body.includes("settings_str")) {
      return jsonResponse({
        data: {
          boards: [
            { columns: [{ id: "numbers_1", title: "Progress", type: "numbers" }], groups: [] },
          ],
        },
      })
    }
    if (body.includes("items_page")) {
      return jsonResponse({ data: { boards: [{ items_page: { items: [] } }] } })
    }
    return null
  }
  const validMappingJson = JSON.stringify({
    mapping: {
      version: 1,
      itemGranularity: "project",
      columns: [{ columnId: "numbers_1", columnType: "numbers", metric: "completion_pct" }],
    },
    summary: "Mapped completion.",
  })

  it("parses fenced/prose-wrapped JSON, retrying once with a JSON-only nudge", async () => {
    await seedOrgProject()
    await seedConnection()
    let llmCalls = 0
    const prompts: string[] = []
    mockFetch((url, body) => {
      const monday = mondayStructureMock(url, body)
      if (monday) return monday
      if (url.includes("/chat/completions")) {
        llmCalls++
        prompts.push(body)
        // First answer: pure prose (unparseable). Second: fenced JSON with prose.
        const content =
          llmCalls === 1
            ? "Sure! Here is my thinking about the board, with no JSON at all."
            : "Here you go:\n```json\n" + validMappingJson + "\n```\nHope that helps!"
        return jsonResponse({ choices: [{ message: { content } }] })
      }
      return null
    })

    const res = await request("anna", "POST", "/api/v2/monday/projects/proj-1/analyze", {
      boardId: "board-9",
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { proposal: { columns: unknown[] } }
    expect(body.proposal.columns).toHaveLength(1)
    expect(llmCalls).toBe(2)
    expect(prompts[1]).toContain("Return ONLY the JSON object.")
  })

  it("returns a clean 502 when the AI upstream is down (no 'invalid JSON' cascade)", async () => {
    await seedOrgProject()
    await seedConnection()
    mockFetch((url, body) => {
      const monday = mondayStructureMock(url, body)
      if (monday) return monday
      if (url.includes("/chat/completions")) {
        return new Response("upstream exploded", { status: 503 })
      }
      return null
    })

    const res = await request("anna", "POST", "/api/v2/monday/projects/proj-1/analyze", {
      boardId: "board-9",
    })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: "AI provider unavailable (HTTP 503)" })
  })

  it("returns a clean 502 when the Monday API itself rejects the token", async () => {
    await seedOrgProject()
    await seedConnection()
    mockFetch((url) => {
      if (url.startsWith("https://api.monday.com/v2")) {
        return jsonResponse({ errors: [{ message: "Not authenticated" }] }, 401)
      }
      return null
    })
    const res = await request("anna", "POST", "/api/v2/monday/projects/proj-1/analyze", {
      boardId: "board-9",
    })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("Monday API error")
  })
})
