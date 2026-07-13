// SWARM-TODO(W1-C): `db/shared/api-credentials.ts` is being built in parallel
// (COMMON contract, AQU-533 §2 "Credentials") and did not exist in this
// worktree at build time. This is a minimal local stub of
// `validateApiCredential` with the shape W1-C needs (hashed-token lookup,
// revocation/expiry checks, org/project scope fields). Delete this file and
// repoint the import in `read-routes.ts` once the shared module lands —
// the real implementation is expected to own credential minting/rotation
// too, which this stub does not attempt.
//
// Schema assumed (matches migration 0054 per the COMMON contract description
// in the AGENT-API doc; created ad-hoc in tests until W1-A's migration
// merges — see `__tests__/external-reads.test.ts`):
//
//   CREATE TABLE api_credentials (
//     id            TEXT PRIMARY KEY,
//     user_id       BIGINT NOT NULL,
//     org_id        BIGINT,
//     project_id    TEXT,
//     token_hash    TEXT NOT NULL UNIQUE,
//     autonomy_mode TEXT NOT NULL DEFAULT 'ask',
//     revoked_at    TIMESTAMPTZ,
//     expires_at    TIMESTAMPTZ,
//     created_at    TIMESTAMPTZ DEFAULT now()
//   );

export interface ApiCredential {
  id: string
  userId: number
  /** null = not org-scoped (any org the user's projectId access reaches). */
  orgId: number | null
  /** null = not project-scoped (any project the user has a role on). */
  projectId: string | null
  autonomyMode: "ask" | "act"
}

export type ValidateCredentialResult =
  | { ok: true; credential: ApiCredential }
  | { ok: false; reason: "invalid" | "revoked" | "expired" }

interface CredentialRow {
  id: string
  user_id: number | string | bigint
  org_id: number | string | bigint | null
  project_id: string | null
  autonomy_mode: string | null
  revoked_at: string | number | null
  expires_at: string | number | null
}

/** SHA-256 hex digest — credentials are stored hashed, never in plaintext. */
export async function hashApiToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** Bearer-token prefix for externally-issued API credentials (AGENT-API §2). */
export const API_CREDENTIAL_PREFIX = "aqk_"

/**
 * Validate a bearer token against `api_credentials`, live (no caching) — the
 * AGENT-API trust model requires every call to re-check revocation.
 */
export async function validateApiCredential(
  db: AquillaDb,
  token: string,
): Promise<ValidateCredentialResult> {
  if (!token.startsWith(API_CREDENTIAL_PREFIX)) {
    return { ok: false, reason: "invalid" }
  }

  const tokenHash = await hashApiToken(token)
  const row = await db
    .prepare(
      "SELECT id, user_id, org_id, project_id, autonomy_mode, revoked_at, expires_at " +
        "FROM api_credentials WHERE token_hash = ?",
    )
    .bind(tokenHash)
    .first<CredentialRow>()

  if (!row) return { ok: false, reason: "invalid" }
  if (row.revoked_at != null) return { ok: false, reason: "revoked" }
  if (row.expires_at != null && new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "expired" }
  }

  return {
    ok: true,
    credential: {
      id: row.id,
      userId: Number(row.user_id),
      orgId: row.org_id == null ? null : Number(row.org_id),
      projectId: row.project_id,
      autonomyMode: row.autonomy_mode === "act" ? "act" : "ask",
    },
  }
}
