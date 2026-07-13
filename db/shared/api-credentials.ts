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

/** Fixed tag prefixing every Aquilla API token. */
export const API_TOKEN_TAG = "aqk_"

/** Number of chars of the full token kept for display (incl. the tag). */
export const TOKEN_PREFIX_LEN = 12

/** Random secret bytes (before the tag/base64url encoding). */
const TOKEN_RANDOM_BYTES = 32

/** The resolved credential context handed to the command/permission layer. */
export interface ApiCredentialContext {
  credentialId: string
  userId: string
  username: string
  mode: "ask" | "act"
  orgId: string | null
  projectId: string | null
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
  org_id: string | null
  project_id: string | null
  expires_at: string | null
  revoked_at: string | null
  last_used_at: string | null
  username: string
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
): Promise<ApiCredentialContext | null> {
  if (!token || !token.startsWith(API_TOKEN_TAG)) return null

  const tokenHash = await sha256Hex(token)
  const row = await db
    .prepare(
      `SELECT ac.id AS id, ac.user_id AS user_id, ac.mode AS mode,
              ac.org_id AS org_id, ac.project_id AS project_id,
              ac.expires_at AS expires_at, ac.revoked_at AS revoked_at,
              ac.last_used_at AS last_used_at, u.username AS username
         FROM api_credentials ac
         JOIN users u ON u.id::text = ac.user_id
        WHERE ac.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<CredentialRow>()

  if (!row) return null
  if (row.revoked_at) return null
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null

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
    orgId: row.org_id,
    projectId: row.project_id,
  }
}
