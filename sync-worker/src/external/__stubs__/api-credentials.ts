// SWARM-TODO: delete after W1-A merge — replace all imports of this stub with
// `db/shared/api-credentials`. W1-A owns the real, DB-backed hashed-credential
// validator (COMMON contract). This stub exists ONLY so W1-B compiles and its
// tests run before W1-A has landed. The exported types + `validateApiCredential`
// signature MUST stay identical to the real module.

/**
 * Resolved context for an authenticated external API credential. Scope fields
 * are null when the credential is unscoped on that axis (any project / any org).
 */
export interface ApiCredentialContext {
  /** Stable credential id (recorded in provenance + changeset rows). */
  credentialId: string
  /** Owning Frontier user id (numeric, matches users.id / SyncTokenClaims.userId). */
  userId: number
  /** Owning user's username (stamped as events.author via the minted token). */
  username: string
  /** Org scope — null = any org; else must match the project's org_id. */
  orgId: string | null
  /** Project scope — null = any project; else must match the target project. */
  projectId: string | null
  /** Autonomy ceiling. A request may downgrade `act`→`ask`; never the reverse. */
  autonomyMode: 'ask' | 'act'
}

/**
 * STUB: validates a bearer `aqk_` token by decoding a base64url JSON body.
 * Format: `aqk_<base64url(JSON ApiCredentialContext)>`. Tests build tokens with
 * `makeStubCredentialToken` below. The REAL W1-A version hashes the token and
 * looks it up in `api_credentials`, resolving live user/scope/autonomy.
 */
export async function validateApiCredential(
  _db: AquillaDb,
  token: string | null | undefined,
): Promise<ApiCredentialContext | null> {
  if (!token || !token.startsWith('aqk_')) return null
  try {
    const json = atob(token.slice(4).replace(/-/g, '+').replace(/_/g, '/'))
    const parsed = JSON.parse(json) as Partial<ApiCredentialContext>
    if (
      typeof parsed.credentialId !== 'string' ||
      typeof parsed.userId !== 'number' ||
      typeof parsed.username !== 'string' ||
      (parsed.autonomyMode !== 'ask' && parsed.autonomyMode !== 'act')
    ) {
      return null
    }
    return {
      credentialId: parsed.credentialId,
      userId: parsed.userId,
      username: parsed.username,
      orgId: parsed.orgId ?? null,
      projectId: parsed.projectId ?? null,
      autonomyMode: parsed.autonomyMode,
    }
  } catch {
    return null
  }
}

/** SWARM-TODO(test-only): mint a stub `aqk_` token from a context. */
export function makeStubCredentialToken(cred: ApiCredentialContext): string {
  const b64 = btoa(JSON.stringify(cred))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `aqk_${b64}`
}
