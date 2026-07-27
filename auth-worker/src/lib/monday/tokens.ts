// Monday OAuth 2.1 token lifecycle (PKCE flow — developer.monday.com
// "Migrating to the new OAuth flow").
//
// Access tokens are now JWTs that EXPIRE (exp claim) and come with a rotating
// refresh token (max lifetime ~6 months from the original authorization).
// Every Monday API call path (routes, push engine, analyze) goes through
// getConnectionAccessToken(): it refreshes when the access token expires
// within 60s, persists BOTH rotated tokens, and on refresh failure marks the
// connection needs_reauth (never deletes it) so the UI can prompt reconnect.
//
// Legacy rows (access_token_expires_at IS NULL — minted by the old
// non-expiring flow) skip refresh entirely.

import type { Env } from "../../types"
import type { IntegrationConnectionRow } from "./types"
import { decryptMondayToken, encryptMondayToken } from "./crypto"

export const MONDAY_TOKEN_URL = "https://auth.monday.com/oauth_ms/oauth/token"

/** Refresh when the access token expires within this window. */
const REFRESH_SKEW_MS = 60_000

/** Thrown when the connection cannot produce a usable token (needs re-auth). */
export class MondayAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MondayAuthError"
  }
}

export interface MondayTokenSet {
  accessToken: string
  refreshToken: string | null
  scope: string | null
  /** ISO timestamp from the access-token JWT exp claim; null = non-expiring. */
  expiresAt: string | null
}

/** Decode a JWT's exp claim (ms epoch) WITHOUT signature verification —
 *  Monday signs its own access tokens; we only need the expiry hint. */
export function decodeJwtExpMs(jwt: string): number | null {
  const parts = jwt.split(".")
  if (parts.length < 2) return null
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    const payload = JSON.parse(atob(b64)) as { exp?: unknown }
    return typeof payload.exp === "number" ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

interface TokenEndpointResponse {
  access_token?: string
  refresh_token?: string
  token_type?: string
  scope?: string
}

async function callTokenEndpoint(
  params: Record<string, string>,
): Promise<MondayTokenSet> {
  const res = await fetch(MONDAY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  })
  if (!res.ok) {
    throw new MondayAuthError(`monday token endpoint HTTP ${res.status}`)
  }
  const body = (await res.json()) as TokenEndpointResponse
  if (!body.access_token) {
    throw new MondayAuthError("monday token endpoint returned no access_token")
  }
  const expMs = decodeJwtExpMs(body.access_token)
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    scope: body.scope ?? null,
    expiresAt: expMs != null ? new Date(expMs).toISOString() : null,
  }
}

/** OAuth 2.1 authorization-code + PKCE exchange (callback path). */
export async function exchangeAuthorizationCode(
  env: Env,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<MondayTokenSet> {
  return callTokenEndpoint({
    grant_type: "authorization_code",
    client_id: env.MONDAY_CLIENT_ID ?? "",
    client_secret: env.MONDAY_CLIENT_SECRET ?? "",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  })
}

async function refreshTokenGrant(env: Env, refreshToken: string): Promise<MondayTokenSet> {
  return callTokenEndpoint({
    grant_type: "refresh_token",
    client_id: env.MONDAY_CLIENT_ID ?? "",
    client_secret: env.MONDAY_CLIENT_SECRET ?? "",
    refresh_token: refreshToken,
  })
}

/** Persist a token set on a connection row (rotating refresh token — always
 *  store the latest) and clear needs_reauth. */
export async function persistTokenSet(
  env: Env,
  connectionId: string,
  tokens: MondayTokenSet,
): Promise<void> {
  const accessEnc = await encryptMondayToken(env.SECRET_KEY, tokens.accessToken)
  const refreshEnc = tokens.refreshToken
    ? await encryptMondayToken(env.SECRET_KEY, tokens.refreshToken)
    : null
  await env.AQUILLA_PG.prepare(
    `UPDATE integration_connections
        SET access_token_enc = ?,
            refresh_token_enc = COALESCE(?, refresh_token_enc),
            access_token_expires_at = ?,
            needs_reauth = FALSE,
            updated_at = now()
      WHERE id = ?`,
  )
    .bind(accessEnc, refreshEnc, tokens.expiresAt, connectionId)
    .run()
}

// Best-effort single-flight: within one isolate, concurrent callers share a
// refresh. (Cross-isolate races are harmless — Monday tolerates a brief
// overlap window on rotated refresh tokens, and the last writer wins.)
const inflightRefresh = new Map<string, Promise<string>>()

/**
 * The ONE accessor every Monday API call path uses. Returns a usable access
 * token, refreshing first when it expires within 60s. Throws MondayAuthError
 * (and marks the connection needs_reauth) when a refresh fails.
 */
export async function getConnectionAccessToken(
  env: Env,
  conn: IntegrationConnectionRow,
): Promise<string> {
  const expiresAt = conn.access_token_expires_at
  const expMs = expiresAt ? new Date(expiresAt).getTime() : null
  if (expMs == null || expMs - Date.now() > REFRESH_SKEW_MS) {
    return decryptMondayToken(env.SECRET_KEY, conn.access_token_enc)
  }

  const existing = inflightRefresh.get(conn.id)
  if (existing) return existing
  const refresh = doRefresh(env, conn).finally(() => inflightRefresh.delete(conn.id))
  inflightRefresh.set(conn.id, refresh)
  return refresh
}

async function doRefresh(env: Env, conn: IntegrationConnectionRow): Promise<string> {
  try {
    if (!conn.refresh_token_enc) {
      throw new MondayAuthError("no refresh token stored")
    }
    const refreshToken = await decryptMondayToken(env.SECRET_KEY, conn.refresh_token_enc)
    const tokens = await refreshTokenGrant(env, refreshToken)
    await persistTokenSet(env, conn.id, tokens)
    return tokens.accessToken
  } catch (err) {
    // Refresh failed (revoked / past the 6-month max lifetime): keep the
    // connection row but flag it so the UI can prompt a reconnect.
    await env.AQUILLA_PG.prepare(
      "UPDATE integration_connections SET needs_reauth = TRUE, updated_at = now() WHERE id = ?",
    )
      .bind(conn.id)
      .run()
    if (err instanceof MondayAuthError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new MondayAuthError(`monday token refresh failed: ${message}`)
  }
}
