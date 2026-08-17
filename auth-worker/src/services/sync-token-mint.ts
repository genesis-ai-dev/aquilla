// AQU-926 (COMMAND-REGISTRY §4) — the sync-token mint core, extracted from
// routes/sync-token.ts so the agent harness (propose_command) can mint a
// project-scoped write-capable token for the run's user without an HTTP
// round-trip to its own route. The route delegates here; behavior parity is
// pinned by sync-token.test.ts and sync-token-mint.test.ts.
//
// Token claims must match sync-worker/src/auth.ts SyncTokenClaims, signed
// HS256 with SYNC_SECRET_KEY (distinct from SECRET_KEY). AQU-285 freeze
// semantics: archived/frozen projects block new write-capable mints; the
// 15-minute TTL bounds any token minted just before a freeze.

import { sign } from "hono/jwt"
import type { AuthUser, Env, RoleResolution, SyncTokenClaims } from "../types"
import { resolveProjectRole } from "./project-permissions"

/** 15-minute lifetime — matches docs/SYNC.md. */
export const SYNC_TOKEN_TTL_SECONDS = 15 * 60

export function roleNameFor(level: number): string {
  switch (level) {
    case 100: return "viewer"
    case 200: return "commenter"
    case 300: return "reviewer"
    case 400: return "contributor"
    case 500: return "project_lead"
    case 600: return "maintainer"
    case 700: return "owner"
    default: return `level_${level}`
  }
}

export type SyncTokenMintFailure =
  /** SYNC_SECRET_KEY unset — deployment config, not a caller problem. */
  | "not_configured"
  /** No projects row — the route may branch to auto-register on this. */
  | "project_not_found"
  | "project_archived"
  /** AQU-285: is_active = false blocks new write-capable mints. */
  | "project_frozen"
  /** Project exists but AD-12 resolution found no role for the user. */
  | "no_access"

export type SyncTokenMintResult =
  | { ok: true; token: string; expiresIn: number; role: RoleResolution }
  | { ok: false; reason: SyncTokenMintFailure }

/**
 * Sign a sync token for an ALREADY-RESOLVED role (the route's auto-register
 * path supplies the creator/OWNER resolution itself). Loads the user's
 * lane/file scopes (AQU-553) — the claim is omitted entirely when unscoped so
 * an absent claim keeps meaning "no restriction" on the sync-worker side.
 */
export async function signSyncTokenWithRole(
  env: Pick<Env, "AQUILLA_PG" | "SYNC_SECRET_KEY">,
  user: Pick<AuthUser, "id" | "username">,
  projectId: string,
  fileId: string,
  resolved: RoleResolution,
): Promise<{ token: string; expiresIn: number }> {
  const secret = env.SYNC_SECRET_KEY
  if (!secret) throw new Error("SYNC_SECRET_KEY not configured")

  const scopeRows = await env.AQUILLA_PG.prepare(
    "SELECT kind, value FROM project_member_scopes WHERE project_id = ? AND user_id = ? ORDER BY kind, value",
  )
    .bind(projectId, user.id)
    .all<{ kind: "lane" | "file"; value: string }>()
  const scopes = (scopeRows.results ?? []).map((r) => ({
    kind: r.kind,
    value: r.value,
  }))

  const now = Math.floor(Date.now() / 1000)
  const claims: SyncTokenClaims = {
    userId: user.id,
    username: user.username,
    projectId,
    fileId,
    role: resolved.level,
    // AQU-346: the sync-worker's write-path membership re-check exempts
    // `src === "platform"` tokens; every other source is re-verified against
    // the live grant tables on each POST /events flush.
    src: resolved.source,
    // AQU-553: omit entirely when unscoped (no rows).
    ...(scopes.length > 0 ? { scopes } : {}),
    aud: "sync",
    iat: now,
    exp: now + SYNC_TOKEN_TTL_SECONDS,
  }
  const token = await sign(claims as unknown as Record<string, unknown>, secret, "HS256")
  return { token, expiresIn: SYNC_TOKEN_TTL_SECONDS }
}

/**
 * Full mint: project existence + archived/frozen checks, AD-12 role
 * resolution (max-wins across direct + group + org + creator + platform),
 * scope load, HS256 sign. Auto-registration of an unknown projectId is NOT
 * here — that is a project-creation concern the route keeps.
 */
export async function mintSyncTokenForUser(
  env: Env,
  user: AuthUser,
  projectId: string,
  fileId: string,
): Promise<SyncTokenMintResult> {
  if (!env.SYNC_SECRET_KEY) return { ok: false, reason: "not_configured" }

  const project = await env.AQUILLA_PG.prepare(
    `SELECT id, archived_at, is_active FROM projects WHERE id = ?`,
  )
    .bind(projectId)
    .first<{ id: string; archived_at: string | null; is_active: boolean }>()

  if (!project) return { ok: false, reason: "project_not_found" }
  if (project.archived_at) return { ok: false, reason: "project_archived" }
  // AQU-285: is_active is a BOOLEAN NOT NULL DEFAULT TRUE column (migration 0033).
  if (!project.is_active) return { ok: false, reason: "project_frozen" }

  const resolved = await resolveProjectRole(env, user, projectId)
  if (!resolved) return { ok: false, reason: "no_access" }

  const signed = await signSyncTokenWithRole(env, user, projectId, fileId, resolved)
  return { ok: true, token: signed.token, expiresIn: signed.expiresIn, role: resolved }
}
