// Monday.com integration routes — mounted at /api/v2/monday in src/index.ts.
//
//   GET    /orgs/:orgId/connection            org member — status (never the token)
//   POST   /orgs/:orgId/connection/start      org maintainer+ — OAuth authorize URL
//   GET    /oauth/callback                    NO auth (SPA forwards code+state; JSON response)
//   DELETE /orgs/:orgId/connection            org maintainer+ — disconnect (cascades links)
//   GET    /orgs/:orgId/boards                org maintainer+ — board picker proxy
//   GET    /orgs/:orgId/boards/:boardId/structure  org maintainer+
//   GET    /projects/:projectId/link          any project member
//   PUT    /projects/:projectId/link          project maintainer+ — create/replace link
//   PATCH  /projects/:projectId/link          project maintainer+ — enabled/config
//   DELETE /projects/:projectId/link          project maintainer+
//   POST   /projects/:projectId/analyze       project maintainer+ — AI mapping proposal
//   POST   /projects/:projectId/sync          project maintainer+ — push now
//   POST   /webhook                           NO auth (Monday JWT via MONDAY_SIGNING_SECRET)
//   POST   /internal/push                     Bearer SYNC_SECRET_KEY (sync-worker fire-and-forget)
//
// One connection per org (token AES-GCM encrypted at rest — lib/monday/crypto.ts),
// one board link per project using its org's connection. Role gates use the
// same ladder as everything else: MAINTAINER (600) to manage, member to view.

import { Hono } from "hono"
import { sign, verify } from "hono/jwt"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Context } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE, type Env } from "../types"
import { getEffectiveOrgRole } from "../services/org-permissions"
import { resolveProjectRole } from "../services/project-permissions"
import {
  encryptMondayToken,
  decryptMondayToken,
  generateCodeVerifier,
  codeChallengeS256,
} from "../lib/monday/crypto"
import {
  exchangeAuthorizationCode,
  getConnectionAccessToken,
  MondayAuthError,
} from "../lib/monday/tokens"
import {
  createBoardWebhooks,
  deleteWebhooksBestEffort,
  fetchBoardItemsSample,
  fetchBoardStructure,
  listBoards,
  mondayGraphQL,
} from "../lib/monday/client"
import {
  parseJsonColumn,
  sanitizeMapping,
  PROVIDER,
  type IntegrationAccountInfo,
  type IntegrationLinkRow,
  type MondayBoardStructure,
  type IntegrationConnectionRow,
  type MondayMapping,
} from "../lib/monday/types"
import { computeProjectMetrics } from "../lib/monday/metrics"
import { analyzeBoardMapping, AnalyzeUpstreamError } from "../lib/monday/analyze"
import { pushBoardLink, schedulePush } from "../lib/monday/push"

const monday = new Hono<AuthHonoEnv>()

const MANAGE_MIN_ROLE = ROLE.MAINTAINER

/** API-facing base for webhook URLs (contract: BASE_URL_API || BASE_URL). */
const apiBase = (env: Env): string =>
  (env.BASE_URL_API || env.BASE_URL || "").replace(/\/$/, "")

/**
 * OAuth redirect URI — must EXACTLY match the redirect URL registered in the
 * Monday Developer Center. This is the SPA's /oauth/callback route (the SPA
 * forwards code+state to our /oauth/callback endpoint via fetch), not a
 * worker URL. Used in both the authorize URL and the token exchange.
 */
const oauthRedirectUri = (env: Env): string =>
  env.MONDAY_REDIRECT_URI || "https://aquilla.app/oauth/callback"

async function getConnection(env: Env, orgId: number): Promise<IntegrationConnectionRow | null> {
  return env.AQUILLA_PG.prepare(
    "SELECT * FROM integration_connections WHERE org_id = ? AND provider = ?",
  )
    .bind(String(orgId), PROVIDER)
    .first<IntegrationConnectionRow>()
}

/**
 * Resolve a usable org access token or the appropriate 409 Response
 * (not connected / needs re-auth). The token accessor transparently
 * refreshes near-expiry OAuth 2.1 tokens (lib/monday/tokens.ts).
 */
async function orgTokenOr409(
  c: Context<AuthHonoEnv>,
  orgId: number,
): Promise<string | Response> {
  const conn = await getConnection(c.env, orgId)
  if (!conn) return c.json({ error: "org is not connected to Monday" }, 409)
  try {
    return await getConnectionAccessToken(c.env, conn)
  } catch (err) {
    if (err instanceof MondayAuthError) {
      return c.json(
        { error: "Monday connection needs re-authorization", needsReauth: true },
        409,
      )
    }
    throw err
  }
}

async function getProjectOrgId(env: Env, projectId: string): Promise<number | null> {
  const row = await env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{ org_id: number | null }>()
  return row?.org_id ?? null
}

async function getLink(env: Env, projectId: string): Promise<IntegrationLinkRow | null> {
  return env.AQUILLA_PG.prepare(
    "SELECT * FROM integration_links WHERE project_id = ? AND provider = ?",
  )
    .bind(projectId, PROVIDER)
    .first<IntegrationLinkRow>()
}

/** Guard: caller must have >= minRole on the org. Returns role or an error Response. */
async function orgGuard(
  c: Context<AuthHonoEnv>,
  minRole: number | null,
): Promise<{ orgId: number } | Response> {
  const orgId = parseInt(c.req.param("orgId") ?? "", 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
  const role = await getEffectiveOrgRole(c.env, orgId, c.get("user"))
  if (role == null) return c.json({ error: "no access to org" }, 403)
  if (minRole != null && role < minRole) {
    return c.json({ error: `org role >= maintainer (${minRole}) required` }, 403)
  }
  return { orgId }
}

/** Guard: caller must have >= minRole on the project. */
async function projectGuard(
  c: Context<AuthHonoEnv>,
  minRole: number | null,
): Promise<{ projectId: string } | Response> {
  const projectId = c.req.param("projectId") ?? ""
  if (!projectId) return c.json({ error: "invalid projectId" }, 400)
  const role = await resolveProjectRole(c.env, c.get("user"), projectId)
  if (!role) return c.json({ error: "no access to project" }, 403)
  if (minRole != null && role.level < minRole) {
    return c.json({ error: `project role >= maintainer (${minRole}) required` }, 403)
  }
  return { projectId }
}

function linkResponse(link: IntegrationLinkRow, orgConnected: boolean) {
  return {
    id: link.id,
    boardId: link.external_id,
    boardName: link.external_name,
    enabled: link.enabled,
    config: parseJsonColumn<MondayMapping | null>(link.config, null),
    structureStale: link.remote_state_stale,
    lastPushedAt: link.last_pushed_at,
    lastPushStatus: link.last_push_status,
    lastPushError: link.last_push_error,
    orgConnected,
  }
}

// ── Org connection ─────────────────────────────────────────────────────────

monday.get("/orgs/:orgId/connection", authMiddleware, async (c) => {
  const guard = await orgGuard(c, null)
  if (guard instanceof Response) return guard
  // Monday's official install link (Share tab / response_type=install). Some
  // accounts restrict app installs to admins, so the SPA offers this for
  // forwarding when the connecting user can't install the app themselves.
  const installUrl = c.env.MONDAY_CLIENT_ID
    ? `https://auth.monday.com/oauth2/authorize?client_id=${c.env.MONDAY_CLIENT_ID}&response_type=install`
    : undefined
  const conn = await getConnection(c.env, guard.orgId)
  if (!conn) return c.json({ connected: false, installUrl })
  return c.json({
    connected: true,
    installUrl,
    account: (() => {
      const acct = parseJsonColumn<IntegrationAccountInfo>(conn.account, {})
      return { id: acct.accountId ?? null, slug: acct.accountSlug ?? null, userName: acct.userName ?? null }
    })(),
    scopes: conn.scopes,
    createdAt: conn.created_at,
    needsReauth: conn.needs_reauth,
  })
})

const startSchema = z.object({ backTo: z.string().optional() })

monday.post(
  "/orgs/:orgId/connection/start",
  authMiddleware,
  zValidator("json", startSchema),
  async (c) => {
    const guard = await orgGuard(c, MANAGE_MIN_ROLE)
    if (guard instanceof Response) return guard
    if (!c.env.MONDAY_CLIENT_ID) {
      return c.json({ error: "Monday integration is not configured (MONDAY_CLIENT_ID)" }, 500)
    }
    const { backTo } = c.req.valid("json")
    // backTo must be an app path, never an absolute URL (open-redirect guard).
    if (backTo != null && (!backTo.startsWith("/") || backTo.startsWith("//"))) {
      return c.json({ error: "backTo must be a path" }, 400)
    }
    // OAuth 2.1 PKCE: the code_verifier must survive to the callback without
    // trusting the browser — encrypt it (same AES-GCM key as tokens) and ride
    // it INSIDE the signed state JWT as the `cv` claim. Stateless, no table.
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = await codeChallengeS256(codeVerifier)
    const cv = await encryptMondayToken(c.env.SECRET_KEY, codeVerifier)
    const now = Math.floor(Date.now() / 1000)
    const state = await sign(
      {
        orgId: guard.orgId,
        userId: c.get("user").username,
        backTo: backTo ?? "/settings/monday",
        cv,
        iat: now,
        exp: now + 600, // 10 minutes
      },
      c.env.SECRET_KEY,
      "HS256",
    )
    const url = new URL("https://auth.monday.com/oauth2/authorize")
    url.searchParams.set("client_id", c.env.MONDAY_CLIENT_ID)
    url.searchParams.set("redirect_uri", oauthRedirectUri(c.env))
    url.searchParams.set("state", state)
    url.searchParams.set("code_challenge", codeChallenge)
    url.searchParams.set("code_challenge_method", "S256")
    url.searchParams.set("force_install_if_needed", "true")
    return c.json({ url: url.toString() })
  },
)

// NO authMiddleware — Monday redirects the browser to the SPA's
// /oauth/callback route (the registered redirect URI), and the SPA forwards
// code+state here via fetch. Auth is the short-lived state JWT we minted in
// /connection/start. Returns JSON (never a redirect): { ok: true, backTo } on
// success, { ok: false, reason } on failure — reason is a coarse slug, never
// internals.
monday.get("/oauth/callback", async (c) => {
  const fail = (reason: string, status: 400 | 401) =>
    c.json({ ok: false, reason }, status)
  const code = c.req.query("code")
  const stateRaw = c.req.query("state")
  if (!code || !stateRaw) return fail("missing_params", 400)

  let state: { orgId?: number; userId?: string; backTo?: string; cv?: string }
  try {
    state = (await verify(stateRaw, c.env.SECRET_KEY, "HS256")) as typeof state
  } catch {
    return fail("bad_state", 401)
  }
  const backTo =
    typeof state.backTo === "string" && state.backTo.startsWith("/") && !state.backTo.startsWith("//")
      ? state.backTo
      : "/settings/monday"
  const orgId = Number(state.orgId)
  if (!Number.isFinite(orgId)) return fail("bad_state", 401)

  // PKCE: recover the code_verifier minted in /connection/start (encrypted
  // inside the signed state — the browser never saw the plaintext).
  if (typeof state.cv !== "string" || !state.cv) return fail("bad_state", 401)
  let codeVerifier: string
  try {
    codeVerifier = await decryptMondayToken(c.env.SECRET_KEY, state.cv)
  } catch {
    return fail("bad_state", 401)
  }

  try {
    let tokens
    try {
      tokens = await exchangeAuthorizationCode(c.env, code, codeVerifier, oauthRedirectUri(c.env))
    } catch {
      return fail("token_exchange_failed", 400)
    }

    // Capture connecting identity (best-effort — a failure still stores the token).
    let me: { id?: string | number; name?: string; account?: { id?: string | number; slug?: string } } = {}
    try {
      const data = await mondayGraphQL<{ me: typeof me }>(
        tokens.accessToken,
        "query { me { id name account { id slug } } }",
      )
      me = data.me ?? {}
    } catch (err) {
      console.warn("[monday] me query failed after token exchange:", err)
    }

    const accessEnc = await encryptMondayToken(c.env.SECRET_KEY, tokens.accessToken)
    const refreshEnc = tokens.refreshToken
      ? await encryptMondayToken(c.env.SECRET_KEY, tokens.refreshToken)
      : null
    const account: IntegrationAccountInfo = {
      accountId: me.account?.id != null ? String(me.account.id) : null,
      accountSlug: me.account?.slug ?? null,
      userId: me.id != null ? String(me.id) : null,
      userName: me.name ?? null,
    }
    await c.env.AQUILLA_PG.prepare(
      `INSERT INTO integration_connections
         (id, org_id, provider, account,
          access_token_enc, refresh_token_enc, access_token_expires_at, needs_reauth, scopes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, FALSE, ?, ?)
       ON CONFLICT (org_id, provider) DO UPDATE SET
         account = EXCLUDED.account,
         access_token_enc = EXCLUDED.access_token_enc,
         refresh_token_enc = EXCLUDED.refresh_token_enc,
         access_token_expires_at = EXCLUDED.access_token_expires_at,
         needs_reauth = FALSE,
         scopes = EXCLUDED.scopes,
         updated_at = now()`,
    )
      .bind(
        crypto.randomUUID(),
        String(orgId),
        PROVIDER,
        JSON.stringify(account),
        accessEnc,
        refreshEnc,
        tokens.expiresAt,
        tokens.scope,
        state.userId ?? "unknown",
      )
      .run()

    return c.json({ ok: true, backTo })
  } catch (err) {
    // Never leak internals — reason stays a coarse slug.
    console.error("[monday] oauth callback failed:", err)
    return fail("internal", 400)
  }
})

monday.delete("/orgs/:orgId/connection", authMiddleware, async (c) => {
  const guard = await orgGuard(c, MANAGE_MIN_ROLE)
  if (guard instanceof Response) return guard
  const conn = await getConnection(c.env, guard.orgId)
  if (!conn) return c.json({ ok: true, deleted: false })

  // Best-effort: delete the webhooks our links created before the cascade
  // removes the rows that remember their ids.
  try {
    const token = await getConnectionAccessToken(c.env, conn)
    const links = await c.env.AQUILLA_PG.prepare(
      "SELECT webhook_ids FROM integration_links WHERE connection_id = ?",
    )
      .bind(conn.id)
      .all<{ webhook_ids: unknown }>()
    for (const row of links.results ?? []) {
      await deleteWebhooksBestEffort(token, parseJsonColumn<string[]>(row.webhook_ids, []))
    }
  } catch (err) {
    console.warn("[monday] webhook cleanup on disconnect failed (best-effort):", err)
  }

  await c.env.AQUILLA_PG.prepare("DELETE FROM integration_connections WHERE id = ?")
    .bind(conn.id)
    .run()
  return c.json({ ok: true, deleted: true })
})

// ── Board browsing (proxy) ─────────────────────────────────────────────────

monday.get("/orgs/:orgId/boards", authMiddleware, async (c) => {
  const guard = await orgGuard(c, MANAGE_MIN_ROLE)
  if (guard instanceof Response) return guard
  const token = await orgTokenOr409(c, guard.orgId)
  if (token instanceof Response) return token
  const boards = await listBoards(token)
  return c.json({ boards: boards.slice(0, 200) })
})

monday.get("/orgs/:orgId/boards/:boardId/structure", authMiddleware, async (c) => {
  const guard = await orgGuard(c, MANAGE_MIN_ROLE)
  if (guard instanceof Response) return guard
  const token = await orgTokenOr409(c, guard.orgId)
  if (token instanceof Response) return token
  const boardId = c.req.param("boardId") ?? ""
  if (!boardId) return c.json({ error: "invalid boardId" }, 400)
  const structure = await fetchBoardStructure(token, boardId)
  return c.json({
    columns: structure.columns.map(({ id, title, type }) => ({ id, title, type })),
    groups: structure.groups,
  })
})

// ── Project board link ─────────────────────────────────────────────────────

monday.get("/projects/:projectId/link", authMiddleware, async (c) => {
  const guard = await projectGuard(c, null)
  if (guard instanceof Response) return guard
  const orgId = await getProjectOrgId(c.env, guard.projectId)
  const orgConnected = orgId != null && (await getConnection(c.env, orgId)) != null
  const link = await getLink(c.env, guard.projectId)
  if (!link) return c.json({ linked: false, orgConnected })
  return c.json({ linked: true, link: linkResponse(link, orgConnected) })
})

const putLinkSchema = z.object({
  boardId: z.string().min(1),
  boardName: z.string().optional(),
  config: z.record(z.string(), z.unknown()),
  enabled: z.boolean().optional(),
})

monday.put(
  "/projects/:projectId/link",
  authMiddleware,
  zValidator("json", putLinkSchema),
  async (c) => {
    const guard = await projectGuard(c, MANAGE_MIN_ROLE)
    if (guard instanceof Response) return guard
    const body = c.req.valid("json")

    const orgId = await getProjectOrgId(c.env, guard.projectId)
    if (orgId == null) return c.json({ error: "project has no org" }, 409)
    const conn = await getConnection(c.env, orgId)
    if (!conn) return c.json({ error: "org is not connected to Monday" }, 409)
    const token = await orgTokenOr409(c, orgId)
    if (token instanceof Response) return token

    // Validate config against LIVE board structure (warn-not-fail: bad
    // columns are stripped and reported back, never a hard 400).
    const structure = await fetchBoardStructure(token, body.boardId)
    const { mapping, warnings } = sanitizeMapping(body.config, structure)
    if (!mapping) return c.json({ error: "invalid config", warnings }, 400)

    const cachedStructure: MondayBoardStructure = {
      fetchedAt: new Date().toISOString(),
      columns: structure.columns,
      groups: structure.groups,
    }

    // Webhooks: keep existing ones when re-linking the same board; otherwise
    // clean up the old board's webhooks (best-effort) and create fresh ones.
    const existing = await getLink(c.env, guard.projectId)
    let webhookIds = parseJsonColumn<string[]>(existing?.webhook_ids ?? null, [])
    if (!existing || existing.external_id !== body.boardId || webhookIds.length === 0) {
      if (existing && webhookIds.length > 0) {
        await deleteWebhooksBestEffort(token, webhookIds)
      }
      try {
        webhookIds = await createBoardWebhooks(
          token,
          body.boardId,
          `${apiBase(c.env)}/api/v2/monday/webhook`,
        )
      } catch (err) {
        console.warn("[monday] webhook creation failed (link still saved):", err)
        warnings.push("could not create Monday webhooks; board-structure changes will not be detected automatically")
        webhookIds = []
      }
    }

    const linkId = existing?.id ?? crypto.randomUUID()
    await c.env.AQUILLA_PG.prepare(
      `INSERT INTO integration_links
         (id, project_id, provider, connection_id, external_id, external_name, config, enabled, webhook_ids, remote_state, remote_state_stale, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE, ?)
       ON CONFLICT (project_id, provider) DO UPDATE SET
         connection_id = EXCLUDED.connection_id,
         external_id = EXCLUDED.external_id,
         external_name = EXCLUDED.external_name,
         config = EXCLUDED.config,
         enabled = EXCLUDED.enabled,
         webhook_ids = EXCLUDED.webhook_ids,
         remote_state = EXCLUDED.remote_state,
         remote_state_stale = FALSE,
         updated_at = now()`,
    )
      .bind(
        linkId,
        guard.projectId,
        PROVIDER,
        conn.id,
        body.boardId,
        body.boardName ?? null,
        JSON.stringify(mapping),
        body.enabled ?? true,
        JSON.stringify(webhookIds),
        JSON.stringify(cachedStructure),
        c.get("user").username,
      )
      .run()

    const link = await getLink(c.env, guard.projectId)
    if (!link) return c.json({ error: "link write failed" }, 500)
    return c.json({ link: linkResponse(link, true), warnings })
  },
)

const patchLinkSchema = z.object({
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
})

monday.patch(
  "/projects/:projectId/link",
  authMiddleware,
  zValidator("json", patchLinkSchema),
  async (c) => {
    const guard = await projectGuard(c, MANAGE_MIN_ROLE)
    if (guard instanceof Response) return guard
    const body = c.req.valid("json")
    const link = await getLink(c.env, guard.projectId)
    if (!link) return c.json({ error: "project has no Monday link" }, 404)

    const warnings: string[] = []
    let configJson: string | null = null
    if (body.config !== undefined) {
      const cached = parseJsonColumn<MondayBoardStructure | null>(link.remote_state, null)
      const result = sanitizeMapping(body.config, cached)
      if (!result.mapping) return c.json({ error: "invalid config", warnings: result.warnings }, 400)
      warnings.push(...result.warnings)
      configJson = JSON.stringify(result.mapping)
    }

    await c.env.AQUILLA_PG.prepare(
      `UPDATE integration_links
          SET enabled = COALESCE(?, enabled),
              config = COALESCE(?::jsonb, config),
              updated_at = now()
        WHERE id = ?`,
    )
      .bind(body.enabled ?? null, configJson, link.id)
      .run()

    const fresh = await getLink(c.env, guard.projectId)
    if (!fresh) return c.json({ error: "link update failed" }, 500)
    return c.json({ link: linkResponse(fresh, true), warnings })
  },
)

monday.delete("/projects/:projectId/link", authMiddleware, async (c) => {
  const guard = await projectGuard(c, MANAGE_MIN_ROLE)
  if (guard instanceof Response) return guard
  const link = await getLink(c.env, guard.projectId)
  if (!link) return c.json({ ok: true, deleted: false })
  try {
    const token = await loadLinkToken(c.env, link)
    if (token) {
      await deleteWebhooksBestEffort(token, parseJsonColumn<string[]>(link.webhook_ids, []))
    }
  } catch (err) {
    console.warn("[monday] webhook cleanup on unlink failed (best-effort):", err)
  }
  await c.env.AQUILLA_PG.prepare("DELETE FROM integration_links WHERE id = ?")
    .bind(link.id)
    .run()
  return c.json({ ok: true, deleted: true })
})

async function loadLinkToken(env: Env, link: IntegrationLinkRow): Promise<string | null> {
  const conn = await env.AQUILLA_PG.prepare(
    "SELECT * FROM integration_connections WHERE id = ?",
  )
    .bind(link.connection_id)
    .first<IntegrationConnectionRow>()
  if (!conn) return null
  return getConnectionAccessToken(env, conn)
}

// ── AI analyze + manual sync ───────────────────────────────────────────────

const analyzeSchema = z.object({
  boardId: z.string().min(1),
  message: z.string().optional(),
  currentConfig: z.record(z.string(), z.unknown()).optional(),
})

monday.post(
  "/projects/:projectId/analyze",
  authMiddleware,
  zValidator("json", analyzeSchema),
  async (c) => {
    const guard = await projectGuard(c, MANAGE_MIN_ROLE)
    if (guard instanceof Response) return guard
    const body = c.req.valid("json")

    const orgId = await getProjectOrgId(c.env, guard.projectId)
    if (orgId == null) return c.json({ error: "project has no org" }, 409)
    const token = await orgTokenOr409(c, orgId)
    if (token instanceof Response) return token

    const summary = await computeProjectMetrics(c.env.AQUILLA_PG, guard.projectId)
    if (!summary) return c.json({ error: "project not found" }, 404)

    let structure, sampleItems
    try {
      structure = await fetchBoardStructure(token, body.boardId)
      sampleItems = await fetchBoardItemsSample(token, body.boardId, 25)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error("[monday] analyze board fetch failed:", err)
      return c.json({ error: `Monday API error: ${message}` }, 502)
    }

    const currentConfig = body.currentConfig
      ? (sanitizeMapping(body.currentConfig, structure).mapping ?? undefined)
      : undefined

    try {
      const result = await analyzeBoardMapping(c.env, {
        structure,
        sampleItems,
        summary,
        currentConfig,
        message: body.message,
      })
      return c.json({ proposal: result.proposal, summary: result.summary })
    } catch (err) {
      console.error("[monday] analyze failed:", err)
      // Upstream outage gets a clear, distinct shape (the body snippet is
      // logged server-side only — never leaked to the client).
      if (err instanceof AnalyzeUpstreamError) {
        return c.json({ error: err.message }, 502)
      }
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: `analyze failed: ${message}` }, 502)
    }
  },
)

monday.post("/projects/:projectId/sync", authMiddleware, async (c) => {
  const guard = await projectGuard(c, MANAGE_MIN_ROLE)
  if (guard instanceof Response) return guard
  const link = await getLink(c.env, guard.projectId)
  if (!link) return c.json({ error: "project has no Monday link" }, 404)
  const result = await pushBoardLink(c.env, link)
  return c.json(result)
})

// ── Inbound webhook (Monday → us) — NO auth middleware ─────────────────────

monday.post("/webhook", async (c) => {
  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: "invalid body" }, 400)
  }

  // Challenge handshake: echo the exact JSON back.
  if (typeof body.challenge === "string") {
    return c.json(body)
  }

  // Board webhooks carry a JWT signed with the app's Signing Secret. Lenient
  // verify: signature + exp only (no aud pinning — the endpoint URL differs
  // per environment).
  const authHeader = c.req.header("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader
  if (!token || !c.env.MONDAY_SIGNING_SECRET) {
    return c.json({ error: "unauthorized" }, 401)
  }
  try {
    await verify(token, c.env.MONDAY_SIGNING_SECRET, "HS256")
  } catch {
    return c.json({ error: "unauthorized" }, 401)
  }

  const event = (body.event ?? {}) as Record<string, unknown>
  const type = typeof event.type === "string" ? event.type : ""
  const boardId = event.boardId != null ? String(event.boardId) : null
  const itemId =
    event.itemId != null
      ? String(event.itemId)
      : event.pulseId != null
        ? String(event.pulseId)
        : null

  // Do the (cheap) work inline and always answer 200 fast.
  if ((type === "create_column" || type.startsWith("create_column")) && boardId) {
    await c.env.AQUILLA_PG.prepare(
      "UPDATE integration_links SET remote_state_stale = TRUE WHERE external_id = ? AND provider = ?",
    )
      .bind(boardId, PROVIDER)
      .run()
  } else if (
    (type === "item_deleted" || type === "item_archived" || type === "delete_pulse" || type === "archive_pulse") &&
    itemId
  ) {
    await c.env.AQUILLA_PG.prepare(
      `DELETE FROM integration_item_links
        WHERE external_item_id = ?
          AND link_id IN (SELECT id FROM integration_links WHERE provider = ?)`,
    )
      .bind(itemId, PROVIDER)
      .run()
  }
  return c.json({ ok: true })
})

// ── Internal push trigger (sync-worker → us) ───────────────────────────────

const internalPushSchema = z.object({ projectId: z.string().min(1) })

monday.post("/internal/push", zValidator("json", internalPushSchema), async (c) => {
  // Same shared-secret pattern as sync-worker's __broadcast.
  const authHeader = c.req.header("Authorization")
  if (!c.env.SYNC_SECRET_KEY || authHeader !== `Bearer ${c.env.SYNC_SECRET_KEY}`) {
    return c.json({ error: "unauthorized" }, 401)
  }
  const { projectId } = c.req.valid("json")
  const result = await schedulePush(c.env, projectId)
  return c.json(result)
})

export default monday
