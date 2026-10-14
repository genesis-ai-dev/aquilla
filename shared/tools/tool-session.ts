/**
 * Smart Extensions apiRev 7: the tool session token.
 *
 * `payload.tool_origin` used to be caller-declared: any script with a sync
 * token could claim "this write came from extension X" by copying X's (public)
 * id, version and code hash. The auth-worker now mints a short JWT per mounted
 * extension (POST /api/v2/projects/:p/tools/:t/session) after checking the
 * caller is a project member and the tool's current version is the one
 * claimed. It is signed with SYNC_SECRET_KEY (the key both workers already
 * share for sync tokens) under its own audience, so a sync token can never be
 * replayed as a tool session or the reverse.
 *
 * The sync-worker verifies the signature and then `toolSessionMatches`: the
 * token must name the same project, tool, version and code hash as the
 * event's tool_origin, and the same user as the event's verified author. Only
 * then is provenance `verified`, and file / extension-data writes require it.
 */

export const TOOL_SESSION_AUDIENCE = "aquilla-tool"
/** Long enough to cover an outbox that flushes after a day offline. */
export const TOOL_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

export interface ToolSessionClaims {
  aud: typeof TOOL_SESSION_AUDIENCE
  projectId: string
  toolId: string
  version: number
  codeHash: string
  userId: number
  username: string
  iat: number
  exp: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isToolSessionClaims(value: unknown): value is ToolSessionClaims {
  return (
    isRecord(value) &&
    value.aud === TOOL_SESSION_AUDIENCE &&
    typeof value.projectId === "string" &&
    typeof value.toolId === "string" &&
    typeof value.version === "number" &&
    typeof value.codeHash === "string" &&
    typeof value.userId === "number" &&
    typeof value.username === "string" &&
    typeof value.exp === "number"
  )
}

/** Does a verified token vouch for this event's claim? */
export function toolSessionMatches(
  claims: ToolSessionClaims,
  event: { projectId: string; author: string; origin: { toolId: string; version: number; codeHash: string } },
): boolean {
  return (
    claims.projectId === event.projectId &&
    claims.toolId === event.origin.toolId &&
    claims.version === event.origin.version &&
    claims.codeHash === event.origin.codeHash &&
    (claims.username === event.author || `user:${claims.userId}` === event.author)
  )
}
