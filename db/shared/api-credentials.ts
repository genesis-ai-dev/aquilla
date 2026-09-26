// Shared external-API credential (PAT) minting + validation for the Agent API
// (AQU-533 §2 "Trust model"). Lives in db/shared/ so both auth-worker (mint,
// list, revoke) and any future command-layer worker (validate on every call)
// speak the same token format and hashing.
//
// Token format:  "aqk_" + base64url(>=32 random bytes)
//   - `aqk_` is a fixed, greppable tag so a leaked token is recognizable.
//   - Only the SHA-256 hex hash is stored; the plaintext is returned once.
//   - `token_prefix` = first 12 chars of the full token (incl. the tag) — a
//     display fragment, never enough to reconstruct the secret.
//
// Live role/membership is re-resolved on every call by the route/command layer
// (see db/shared/project-roles.ts). This module only answers "is this token a
// live, unexpired, unrevoked credential, and whose is it?".

import type { AquillaDb } from "../shim/postgres"
import { countRecentRateLimitEvents, recordRateLimitEvent } from "./rate-limit"

/** Fixed tag prefixing every Aquilla API token. */
export const API_TOKEN_TAG = "aqk_"

/**
 * [Pen test] Auth & session mgmt (2026-09-07): every external route
 * (sync-worker /api/v1/external/*) hashes + looks up whatever Bearer value
 * it's handed, valid or not, on every call — an unauthenticated caller
 * flooding any of those routes with garbage tokens costs a DB round-trip
 * each time, with no limiter in front of it (the existing external rate
 * limits in db/shared/rate-limit.ts are keyed by credentialId, which only
 * exists once a token has already validated). Brute-forcing the 256-bit
 * token itself is infeasible regardless of any throttle here; this exists
 * to bound DB load from repeated invalid attempts, the same "throttle it
 * anyway" reasoning already applied to the reset-token and access-link-PIN
 * flows despite their tokens being equally unguessable. Failures only, per
 * source IP, 15-minute window — a caller presenting the same valid token
 * over and over is never counted or throttled.
 */
const INVALID_CREDENTIAL_RATE_LIMIT_KIND = "external_credential_invalid"
const MAX_INVALID_ATTEMPTS_PER_IP = 30

/** Number of chars of the full token kept for display (incl. the tag). */
export const TOKEN_PREFIX_LEN = 12

/** Random secret bytes (before the tag/base64url encoding). */
const TOKEN_RANDOM_BYTES = 32

/**
 * AQU-1242: the credential's ACCESS ceiling — may this token change anything?
 *
 * Orthogonal to `mode`, which is the autonomy dial for writes that are already
 * permitted ('ask' parks them at the approval page, 'act' applies them). A
 * read-only token is refused at every write surface regardless of mode.
 */
export type ApiCredentialAccess = "read" | "write"

/** The resolved credential context handed to the command/permission layer. */
export interface ApiCredentialContext {
  credentialId: string
  userId: string
  username: string
  mode: "ask" | "act"
  /**
   * AQU-1242: 'read' refuses every write surface; 'write' is the original
   * all-or-nothing grant. REQUIRED rather than optional on purpose — the
   * permissive value is the back-compatible one, so an optional field would let
   * a new principal fail OPEN by simply forgetting it. Every construction site
   * (including session-routes' browser principal) must say which it is.
   */
  access: ApiCredentialAccess
  orgId: string | null
  projectId: string | null
  /**
   * AQU-1180: may this credential see real human identities in agent-facing
   * responses? OPTIONAL, and absent means NO — the safe default has to be the
   * one you get by forgetting the field, not the one you get by remembering
   * it. Only an OWNER of the credential's scope can mint a token with it on
   * (auth-worker/src/routes/credentials.ts); a project's `agentAuthorship:
   * none` setting overrides it back off (external/pii.ts).
   */
  pii?: boolean
}

/** Product of minting a token: the plaintext (shown once) + what to persist. */
export interface MintedApiToken {
  /** Plaintext token — returned to the caller exactly once, never stored. */
  token: string
  /** SHA-256 hex hash of `token` — the stored secret. */
  tokenHash: string
  /** First 12 chars of `token` — stored for display. */
  tokenPrefix: string
}

/** base64url (no padding) of a byte array. */
function base64url(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** SHA-256 hex of a UTF-8 string, via Web Crypto (Workers + vitest). */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", data)
  const bytes = new Uint8Array(digest)
  let hex = ""
  for (const b of bytes) hex += b.toString(16).padStart(2, "0")
  return hex
}

/**
 * Mint a fresh API token. Returns the plaintext (to hand to the caller once)
 * plus the hash and display prefix to persist. Does NOT touch the database —
 * the route owns the INSERT so it can attach scope/mode/expiry.
 */
export async function mintApiToken(): Promise<MintedApiToken> {
  const random = new Uint8Array(TOKEN_RANDOM_BYTES)
  crypto.getRandomValues(random)
  const token = API_TOKEN_TAG + base64url(random)
  const tokenHash = await sha256Hex(token)
  return { token, tokenHash, tokenPrefix: token.slice(0, TOKEN_PREFIX_LEN) }
}

interface CredentialRow {
  id: string
  user_id: string
  mode: "ask" | "act"
  access: string | null
  org_id: string | null
  project_id: string | null
  expires_at: string | null
  revoked_at: string | null
  last_used_at: string | null
  username: string
  pii: boolean | null
}

/**
 * Validate an inbound API token. Returns the credential context, or null when
 * the token is malformed, unknown, revoked, or expired.
 *
 * Side effect: bumps `last_used_at`, throttled to once per 5 minutes so a busy
 * agent doesn't write on every request. The bump is a single conditional
 * UPDATE (no read-modify-write); a failed bump never fails validation.
 */
export async function validateApiCredential(
  db: AquillaDb,
  token: string,
  /** Caller's source IP (e.g. the `CF-Connecting-IP` header), for the
   *  invalid-attempt throttle above. Omit to skip throttling (e.g. tests). */
  ipIdentifier?: string | null,
): Promise<ApiCredentialContext | null> {
  if (!token || !token.startsWith(API_TOKEN_TAG)) return null

  const throttleKey = ipIdentifier ? `ip:${ipIdentifier.trim().toLowerCase()}` : null
  if (throttleKey) {
    const recentFailures = await countRecentRateLimitEvents(
      db,
      INVALID_CREDENTIAL_RATE_LIMIT_KIND,
      throttleKey,
    )
    if (recentFailures >= MAX_INVALID_ATTEMPTS_PER_IP) return null
  }

  const fail = async (): Promise<null> => {
    if (throttleKey) await recordRateLimitEvent(db, INVALID_CREDENTIAL_RATE_LIMIT_KIND, throttleKey)
    return null
  }

  const tokenHash = await sha256Hex(token)
  const row = await db
    .prepare(
      `SELECT ac.id AS id, ac.user_id AS user_id, ac.mode AS mode,
              ac.access AS access,
              ac.org_id AS org_id, ac.project_id AS project_id,
              ac.expires_at AS expires_at, ac.revoked_at AS revoked_at,
              ac.last_used_at AS last_used_at, u.username AS username,
              ac.pii AS pii
         FROM api_credentials ac
         JOIN users u ON u.id::text = ac.user_id
        WHERE ac.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<CredentialRow>()

  if (!row) return fail()
  if (row.revoked_at) return fail()
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return fail()

  // Throttled last-used bump: only when the row hasn't been touched in 5min.
  // Single set-based UPDATE — no read-modify-write. Fire-and-forget: a failed
  // bump is non-fatal to authentication.
  try {
    await db
      .prepare(
        `UPDATE api_credentials
            SET last_used_at = now()
          WHERE id = ?
            AND (last_used_at IS NULL
                 OR last_used_at < now() - interval '5 minutes')`,
      )
      .bind(row.id)
      .run()
  } catch (err) {
    console.warn("[validateApiCredential] last_used_at bump failed (non-fatal):", err)
  }

  return {
    credentialId: row.id,
    userId: row.user_id,
    username: row.username,
    mode: row.mode,
    // AQU-1242: only an explicit 'read' narrows the token. Any other stored
    // value — including a NULL from a row written before 0112 landed — is the
    // original read-write grant, so existing tokens keep working unchanged.
    access: row.access === "read" ? "read" : "write",
    orgId: row.org_id,
    projectId: row.project_id,
    // Only an explicit true opts in — a NULL (pre-0091 row) stays scrubbed.
    pii: row.pii === true,
  }
}
