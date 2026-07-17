// Client lib for the external API credentials (personal access tokens)
// endpoints (auth-worker, AQU-533 §2 "Trust model").
//
// Mirrors usage.ts / credits.ts: AUTH_BASE + fetchWithTimeout + Authorization
// header, thrown Error on non-OK responses. See auth-worker/src/routes/credentials.ts
// for the server-side contract (READ ONLY from this repo's ownership boundary).

import { AUTH_BASE } from "../frontier/auth"
import { fetchWithTimeout } from "../frontier/orgs"

export type CredentialMode = "ask" | "act"

/** Public credential DTO — never includes the token hash or plaintext. */
export interface ApiCredential {
  id: string
  name: string
  mode: CredentialMode
  /** Org scope, if any. Stored as TEXT server-side (see migration 0054). */
  orgId: string | null
  /** Project scope, if any. */
  projectId: string | null
  tokenPrefix: string
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
}

export interface MintCredentialInput {
  name: string
  mode: CredentialMode
  orgId?: string
  projectId?: string
  /** ISO-8601 timestamp; omit for "never expires". */
  expiresAt?: string
}

export interface MintCredentialResult {
  /** The plaintext `aqk_…` token — returned exactly once, never again. */
  token: string
  credential: ApiCredential
}

/** GET /api/v2/credentials — the caller's own credentials, newest first. */
export async function listCredentials(jwt: string): Promise<ApiCredential[]> {
  const res = await fetchWithTimeout(`${AUTH_BASE}/api/v2/credentials`, {
    headers: { Authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`credentials list failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
  return ((await res.json()) as { credentials: ApiCredential[] }).credentials
}

/**
 * POST /api/v2/credentials — mint a new credential. The server enforces the
 * scope/autonomy rules (see credentials.ts); this client just forwards the
 * request and propagates any error.
 */
export async function mintCredential(
  jwt: string,
  input: MintCredentialInput,
): Promise<MintCredentialResult> {
  const res = await fetchWithTimeout(`${AUTH_BASE}/api/v2/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`credentials mint failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
  return (await res.json()) as MintCredentialResult
}

/** DELETE /api/v2/credentials/:id — revoke a credential. Idempotent server-side. */
export async function revokeCredential(jwt: string, id: string): Promise<void> {
  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/credentials/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${jwt}` } },
  )
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`credentials revoke failed: HTTP ${res.status} — ${body.slice(0, 200)}`)
  }
}
