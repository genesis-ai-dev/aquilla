// OAuth 2.1 authorization-code + PKCE for MCP hosts (ChatGPT plugin, Claude,
// Codex). The sync-worker MCP server answers a token-less request with a 401
// naming its RFC 9728 metadata, which names this worker as the authorization
// server. Flow:
//
//   1. GET  /.well-known/oauth-authorization-server[/identity]  RFC 8414 metadata
//   2. GET  /oauth/authorize?…        → 302 to the SPA consent page (same query)
//   3. POST /api/v2/mcp-oauth/request  (session) validate client + show consent
//   4. POST /api/v2/mcp-oauth/decision (session) issue a code, return redirect
//   5. POST /oauth/token               code + PKCE verifier → aqk_ credential
//
// The access token is an ordinary API credential (same table, same revoke
// button, with a saved organization allowlist and live-role checks on every call).
// It does not expire and there is no refresh token — the same contract as the
// device flow (agent-connect.ts), so a connected host keeps working until the
// human revokes it under Preferences → API tokens.
//
// Clients register by URL (Client ID Metadata Documents, see
// lib/mcp-oauth/client-metadata.ts); there is no dynamic registration
// endpoint. All clients are treated as public: PKCE S256 is mandatory.

import { Hono, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE, type AuthUser } from "../types"
import { mintApiToken, sha256Hex } from "../../../db/shared/api-credentials"
import { countRecentEvents, recordAuthEvent, userIdentifier } from "../utils/rate-limit"
import { scopeLevel } from "./agent-connect"
import { pinnedClientFetcher, resolveClient, type Fetcher, type ResolvedClient } from "../lib/mcp-oauth/client-metadata"

type Bindings = AuthHonoEnv["Bindings"]
type Mode = "ask" | "act"

const MCP_RESOURCE_SUFFIX = "/api/v1/external/mcp"
const CODE_TTL = "5 minutes"
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/

/** This worker's public base — the `issuer`. Must equal the sync-worker's
 *  AUTH_WORKER_URL (what its protected-resource metadata advertises). */
export function issuerFor(env: Pick<Bindings, "MCP_OAUTH_ISSUER">, requestUrl: string): string {
  return (env.MCP_OAUTH_ISSUER ?? new URL(requestUrl).origin).replace(/\/+$/, "")
}

export function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["act"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: "https://github.com/genesis-ai-dev/aquilla/blob/dev/docs/CHATGPT-PLUGIN.md",
  }
}

const authorizeSchema = z.object({
  response_type: z.string().max(50),
  client_id: z.string().min(1).max(2000),
  redirect_uri: z.string().min(1).max(2000),
  code_challenge: z.string().max(200).optional(),
  code_challenge_method: z.string().max(20).optional(),
  state: z.string().max(2000).optional(),
  scope: z.string().max(500).optional(),
  resource: z.string().max(2000).optional(),
})
type AuthorizeParams = z.infer<typeof authorizeSchema>

/** The existing MCP endpoint is the OAuth audience, not a permission grant. */
export function oauthResourceFor(env: Pick<Bindings, "SYNC_WORKER_URL">, issuer: string): string {
  const base = env.SYNC_WORKER_URL ?? issuer.replace(/\/identity$/, "/sync")
  return `${base.replace(/\/+$/, "")}${MCP_RESOURCE_SUFFIX}`
}

export function isAcceptableResource(resource: string, issuer: string, expected?: string): boolean {
  return resource === (expected ?? oauthResourceFor({}, issuer))
}

/** Eligible organizations, without platform-admin elevation or lazy creation. */
async function eligibleOrganizations(env: Bindings, userId: string) {
  const result = await env.AQUILLA_PG.prepare(`
    SELECT o.id::text AS id, o.name FROM organizations o
    WHERE o.owner_user_id::text = ? OR EXISTS (
      SELECT 1 FROM org_members om WHERE om.org_id = o.id
        AND om.user_id::text = ? AND om.role_level >= ${ROLE.MAINTAINER}
    ) ORDER BY LOWER(COALESCE(o.name, '')), o.id
  `).bind(userId, userId).all<{ id: string; name: string | null }>()
  return result.results
}

export function buildRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value)
  return url.toString()
}

type Validated =
  /** Client or redirect URI is untrusted: show the error, never redirect. */
  | { kind: "fatal"; error: string; error_description: string }
  /** Trusted redirect, bad request: send the error back to the client. */
  | { kind: "redirect_error"; error: string; error_description: string; redirect: string }
  | { kind: "ok"; client: ResolvedClient; params: AuthorizeParams; mode: Mode; resource: string | null }

function clientFetcher(env: Pick<Bindings, "WRANGLER_LOCAL" | "MCP_OAUTH_PINNED_CLIENTS">): Fetcher {
  return env.WRANGLER_LOCAL === "1" && env.MCP_OAUTH_PINNED_CLIENTS
    ? pinnedClientFetcher(env.MCP_OAUTH_PINNED_CLIENTS)
    : fetch
}

async function validateAuthorize(params: AuthorizeParams, issuer: string, resource: string, fetcher: Fetcher): Promise<Validated> {
  const resolved = await resolveClient(params.client_id, fetcher)
  if (!resolved.ok) return { kind: "fatal", error: resolved.error, error_description: resolved.description }
  if (!resolved.client.redirectUris.includes(params.redirect_uri)) {
    return { kind: "fatal", error: "invalid_request", error_description: "redirect_uri is not registered for this client" }
  }
  const back = (error: string, error_description: string): Validated => ({
    kind: "redirect_error", error, error_description,
    redirect: buildRedirect(params.redirect_uri, { error, error_description, state: params.state, iss: issuer }),
  })
  if (params.response_type !== "code") return back("unsupported_response_type", "only response_type=code is supported")
  if (params.code_challenge_method !== "S256" || !params.code_challenge || !PKCE_CHALLENGE.test(params.code_challenge)) {
    return back("invalid_request", "PKCE with code_challenge_method=S256 is required")
  }
  if (params.resource !== undefined && !isAcceptableResource(params.resource, issuer, resource)) {
    return back("invalid_target", "resource is not an Aquilla MCP endpoint")
  }
  return { kind: "ok", client: resolved.client, params, mode: "act", resource: params.resource ?? resource }
}

async function readBody(req: Request): Promise<unknown> {
  if (req.headers.get("content-type")?.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(await req.text()))
  }
  return req.json().catch(() => null)
}

function base64url(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function pkceS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

const noStore: MiddlewareHandler<AuthHonoEnv> = async (c, next) => {
  c.header("Cache-Control", "no-store")
  c.header("Pragma", "no-cache")
  await next()
}

// ── Public surface: metadata, authorize redirect, token ────────────────────
export const mcpOAuthPublicRoutes = new Hono<AuthHonoEnv>()

// RFC 8414 puts a path issuer's metadata at /.well-known/oauth-authorization-server/<path>
// (reached through the zone route); clients that append to the issuer instead
// reach /identity/.well-known/oauth-authorization-server, which the prefix
// strip turns into the bare form.
mcpOAuthPublicRoutes.get("/.well-known/oauth-authorization-server", (c) =>
  c.json(authorizationServerMetadata(issuerFor(c.env, c.req.url)), 200, { "Cache-Control": "public, max-age=300" }))
mcpOAuthPublicRoutes.get("/.well-known/oauth-authorization-server/*", (c) => {
  const issuer = issuerFor(c.env, c.req.url)
  const suffix = c.req.path.slice("/.well-known/oauth-authorization-server".length)
  if (suffix !== new URL(issuer).pathname) return c.json({ error: "not_found" }, 404)
  return c.json(authorizationServerMetadata(issuer), 200, { "Cache-Control": "public, max-age=300" })
})

// The consent UI lives in the SPA (sign-in, organization selection). Pass the request
// through untouched; the SPA posts it back to /api/v2/mcp-oauth/* for
// validation, so nothing here trusts the client yet.
mcpOAuthPublicRoutes.get("/oauth/authorize", (c) => {
  const base = c.env.BASE_URL?.replace(/\/+$/, "")
  if (!base) return c.json({ error: "server_error", error_description: "BASE_URL not configured" }, 500)
  return c.redirect(`${base}/oauth/consent${new URL(c.req.url).search}`, 302)
})

const tokenSchema = z.object({
  grant_type: z.string().max(100),
  code: z.string().min(20).max(200),
  redirect_uri: z.string().min(1).max(2000),
  client_id: z.string().min(1).max(2000),
  code_verifier: z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/),
  resource: z.string().max(2000).optional(),
})

interface CodeRow {
  client_id: string
  redirect_uri: string
  code_challenge: string
  resource: string | null
  user_id: string
  mode: Mode
  project_id: string | null
  org_id: string | null
  org_ids: string[] | null
  status: "issued" | "consumed"
  credential_id: string | null
  expired: boolean
}

mcpOAuthPublicRoutes.post("/oauth/token", bodyLimit({ maxSize: 8192 }), noStore, async (c) => {
  const raw = await readBody(c.req.raw)
  const grantType = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).grant_type : undefined
  if (grantType !== undefined && grantType !== "authorization_code") {
    return c.json({ error: "unsupported_grant_type" }, 400)
  }
  const parsed = tokenSchema.safeParse(raw)
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400)
  const input = parsed.data
  const issuer = issuerFor(c.env, c.req.url)
  const codeHash = await sha256Hex(input.code)
  const db = c.env.AQUILLA_PG
  const row = await db.prepare(
    `SELECT client_id, redirect_uri, code_challenge, resource, user_id, mode, project_id, org_id,
            status, credential_id, org_ids, expires_at <= now() AS expired
     FROM mcp_oauth_codes WHERE code_hash = ?`,
  ).bind(codeHash).first<CodeRow>()
  const invalidGrant = () => c.json({ error: "invalid_grant" }, 400)
  if (!row) return invalidGrant()
  if (row.status === "consumed") {
    // A second redemption means the code leaked. Revoke what the first one
    // minted rather than guess which party is legitimate (OAuth 2.1 §4.1.3).
    if (row.credential_id) {
      await db.prepare("UPDATE api_credentials SET revoked_at = now() WHERE id = ? AND revoked_at IS NULL")
        .bind(row.credential_id).run()
    }
    return invalidGrant()
  }
  if (row.expired) return invalidGrant()
  if (row.client_id !== input.client_id || row.redirect_uri !== input.redirect_uri) return invalidGrant()
  if ((await pkceS256(input.code_verifier)) !== row.code_challenge) return invalidGrant()
  if (input.resource !== undefined) {
    const matches = input.resource === (row.resource ?? oauthResourceFor(c.env, issuer))
    if (!matches) return c.json({ error: "invalid_target" }, 400)
  }
  // Live role at mint time, not just at consent: it may have been lowered.
  const user = await db.prepare("SELECT * FROM users WHERE id::text = ?").bind(row.user_id).first<AuthUser>()
  if (!user) return invalidGrant()
  if (row.org_ids !== null) {
    const eligible = new Set((await eligibleOrganizations(c.env, row.user_id)).map((org) => org.id))
    if (!row.org_ids.length || row.org_ids.some((id) => !eligible.has(id))) return invalidGrant()
  } else {
    // Codes issued before 0119 keep their original scope until they expire.
    const level = await scopeLevel(c.env, user, row.project_id, row.org_id)
    if (level == null || level < (row.mode === "act" ? ROLE.MAINTAINER : ROLE.CONTRIBUTOR)) return invalidGrant()
  }

  const minted = await mintApiToken()
  const credentialId = crypto.randomUUID()
  // Consume and mint in ONE statement: a concurrent redemption finds the code
  // already consumed and mints nothing.
  const credential = await db.prepare(
    `WITH claimed AS (
       UPDATE mcp_oauth_codes SET status = 'consumed', credential_id = ?
       WHERE code_hash = ? AND status = 'issued' AND expires_at > now()
       RETURNING user_id, client_name, mode, org_id, project_id, org_ids, resource
     ) INSERT INTO api_credentials
       (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id, expires_at, org_ids, oauth_resource)
       SELECT ?, user_id, client_name, ?, ?, mode, org_id, project_id, NULL, org_ids, COALESCE(resource, ?)
       FROM claimed RETURNING id`,
  ).bind(credentialId, codeHash, credentialId, minted.tokenPrefix, minted.tokenHash, oauthResourceFor(c.env, issuer)).first()
  if (!credential) return invalidGrant()
  return c.json({ access_token: minted.token, token_type: "Bearer", scope: row.mode })
})

// ── Session surface for the SPA consent page ───────────────────────────────
export const mcpOAuthConsentRoutes = new Hono<AuthHonoEnv>()
mcpOAuthConsentRoutes.use("*", bodyLimit({ maxSize: 8192 }))
mcpOAuthConsentRoutes.use("*", noStore)
mcpOAuthConsentRoutes.use("*", authMiddleware)

/** Validate an authorization request and describe it for the consent page.
 *  Fetches the client's metadata document, so it is session-gated and
 *  throttled per user. */
mcpOAuthConsentRoutes.post("/request", async (c) => {
  const parsed = authorizeSchema.safeParse(await readBody(c.req.raw))
  if (!parsed.success) return c.json({ error: "invalid_request", error_description: "malformed authorization request" }, 400)
  const ident = userIdentifier(c.get("user").id)
  if (await countRecentEvents(c.env.AQUILLA_PG, "mcp_oauth_request", ident, { onlyFailures: false }) >= 30) {
    return c.json({ error: "slow_down" }, 429)
  }
  await recordAuthEvent(c.env.AQUILLA_PG, "mcp_oauth_request", ident, true)
  const issuer = issuerFor(c.env, c.req.url)
  const v = await validateAuthorize(parsed.data, issuer, oauthResourceFor(c.env, issuer), clientFetcher(c.env))
  if (v.kind === "fatal") return c.json({ error: v.error, error_description: v.error_description }, 400)
  if (v.kind === "redirect_error") {
    return c.json({ error: v.error, error_description: v.error_description, redirect: v.redirect }, 400)
  }
  return c.json({
    clientName: v.client.clientName,
    clientHost: v.client.host,
    redirectHost: new URL(v.params.redirect_uri).host,
    mode: "act",
    organizations: await eligibleOrganizations(c.env, String(c.get("user").id)),
  })
})

const decisionSchema = authorizeSchema.extend({
  approve: z.boolean(),
  org_ids: z.array(z.string().regex(/^[1-9][0-9]*$/)).min(1).max(1000).optional(),
})

/** Approve or deny. Returns the URL the browser must navigate to; the code is
 *  in it, so the SPA never stores it. */
mcpOAuthConsentRoutes.post("/decision", async (c) => {
  const parsed = decisionSchema.safeParse(await readBody(c.req.raw))
  if (!parsed.success) return c.json({ error: "invalid_request", error_description: "malformed decision" }, 400)
  const input = parsed.data
  const user = c.get("user")
  const ident = userIdentifier(user.id)
  if (await countRecentEvents(c.env.AQUILLA_PG, "mcp_oauth_decision", ident, { onlyFailures: false }) >= 20) {
    return c.json({ error: "slow_down" }, 429)
  }
  await recordAuthEvent(c.env.AQUILLA_PG, "mcp_oauth_decision", ident, true)
  const issuer = issuerFor(c.env, c.req.url)
  // Re-validate from scratch: the browser is not trusted to carry a verdict.
  const v = await validateAuthorize(input, issuer, oauthResourceFor(c.env, issuer), clientFetcher(c.env))
  if (v.kind === "fatal") return c.json({ error: v.error, error_description: v.error_description }, 400)
  if (v.kind === "redirect_error") {
    return c.json({ error: v.error, error_description: v.error_description, redirect: v.redirect }, 400)
  }
  if (!input.approve) {
    return c.json({ redirect: buildRedirect(input.redirect_uri, { error: "access_denied", state: input.state, iss: issuer }) })
  }
  const orgIds = [...new Set(input.org_ids ?? [])]
  if (!orgIds.length) {
    return c.json({ error: "invalid_request", error_description: "choose at least one organization" }, 400)
  }
  const eligible = new Set((await eligibleOrganizations(c.env, String(user.id))).map((org) => org.id))
  if (orgIds.some((id) => !eligible.has(id))) return c.json({ error: "scope_denied" }, 403)
  const code = base64url(crypto.getRandomValues(new Uint8Array(32)))
  await c.env.AQUILLA_PG.prepare(
    `INSERT INTO mcp_oauth_codes
       (code_hash, client_id, client_name, redirect_uri, code_challenge, resource,
        user_id, mode, org_ids, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'act', ?::text::jsonb, now() + interval '${CODE_TTL}')`,
  ).bind(await sha256Hex(code), v.client.clientId, v.client.clientName, input.redirect_uri,
    input.code_challenge ?? "", v.resource, String(user.id), JSON.stringify(orgIds)).run()
  // Bounded retention; codes are useless minutes after issue.
  await c.env.AQUILLA_PG.prepare("DELETE FROM mcp_oauth_codes WHERE expires_at < now() - interval '1 day'").run()
  return c.json({ redirect: buildRedirect(input.redirect_uri, { code, state: input.state, iss: issuer }) })
})
