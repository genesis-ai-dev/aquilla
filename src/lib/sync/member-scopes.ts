// Client helpers for auth-worker's per-member lane/file scopes endpoints
// (AQU-553, auth-worker/src/routes/member-scopes.ts).
//
//   GET /api/v2/projects/:projectId/members/:userId/scopes
//       Read a member's scopes. Own scopes: viewer (100+). Others':
//       project_lead (500+).
//
//   PUT /api/v2/projects/:projectId/members/:userId/scopes
//       Replace-set a member's scopes. project_lead (500+). Rejects scoping
//       a member whose effective role is >= project_lead (500).
//
// Follows the fetch/error-handling style of project-settings.ts: helpers
// return null (GET) on any non-2xx or network error rather than throwing, so
// callers can treat "couldn't load" the same as "unscoped" when tolerant, or
// surface it when not. `putMemberScopes` throws on failure — callers save
// from an explicit user action and need to show the error.

import { AUTH_API_URL } from "./sync-token"

/** A single lane/file write-restriction row on a project member. */
export interface MemberScope {
  kind: "lane" | "file"
  value: string
}

/**
 * AQU-633: client mirror of the sync-worker's `enforceScopes` (authorize.ts)
 * for a validate / target-cell write. `scopes` are the CURRENT user's own
 * scopes; composition is AND — any lane scopes → the event's lane must match,
 * any file scopes → the event's fileId must match. Empty = unscoped = allowed.
 *
 * A `null` scopes (couldn't load) is treated as IN scope so the client never
 * hides an action the server would actually allow — the server stays
 * authoritative, and a genuine refusal still surfaces via the outbox 403 path.
 *
 * AQU-1607: `lane` here is a lane TAG, because the client's active lane still
 * is one. A stored lane scope is a lane id, so callers pass scopes already
 * read back as tags (`laneScopesAsTags`) — ProjectWorkspace does that once
 * where it loads them. Handing raw id-valued scopes to this would match
 * nothing and hide actions the server allows.
 */
export function isInMemberScope(
  scopes: MemberScope[] | null | undefined,
  fileId: string,
  lane: string,
): boolean {
  if (!scopes || scopes.length === 0) return true
  const laneScopes = scopes.filter((s) => s.kind === "lane").map((s) => s.value)
  if (laneScopes.length > 0 && !laneScopes.includes(lane)) return false
  const fileScopes = scopes.filter((s) => s.kind === "file").map((s) => s.value)
  if (fileScopes.length > 0 && !fileScopes.includes(fileId)) return false
  return true
}

function authHeaders(jwt: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
  }
}

/**
 * GET /api/v2/projects/:projectId/members/:userId/scopes.
 *
 * Returns null on 403/404 (no access, or caller lacks project_lead to view
 * someone else's scopes) and on any network error — callers should treat a
 * null the same as "couldn't determine scopes", not "unscoped".
 */
/** The caller's own scopes, plus whether the project's org lets lane-limited
 *  members assign work (`null` when the server didn't say — an older server). */
export interface MyScopeGrant {
  scopes: MemberScope[]
  allowScopedLaneAssignment: boolean | null
}

/**
 * GET the caller's OWN scopes (`me`). Unlike `fetchMemberScopes`, this also
 * returns `allowScopedLaneAssignment`: a guest — a project member outside the
 * org — can't read the org's settings, so this is how the client learns the
 * lane-assignment setting for them (AQU-581 review). `null` on failure.
 */
export async function fetchMyScopeGrant(
  jwt: string,
  projectId: string,
  apiUrl: string = AUTH_API_URL,
): Promise<MyScopeGrant | null> {
  try {
    const res = await fetch(
      `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/members/me/scopes`,
      { headers: authHeaders(jwt) },
    )
    if (!res.ok) {
      console.warn(`[member-scopes] fetchMyScopeGrant ${projectId} → HTTP ${res.status}`)
      return null
    }
    const body = (await res.json()) as { scopes?: MemberScope[]; allowScopedLaneAssignment?: unknown }
    return {
      scopes: body.scopes ?? [],
      allowScopedLaneAssignment:
        typeof body.allowScopedLaneAssignment === "boolean" ? body.allowScopedLaneAssignment : null,
    }
  } catch (err) {
    console.warn("[member-scopes] fetchMyScopeGrant failed:", err)
    return null
  }
}

export async function fetchMemberScopes(
  jwt: string,
  projectId: string,
  userId: number | "me",
  apiUrl: string = AUTH_API_URL,
): Promise<MemberScope[] | null> {
  try {
    const res = await fetch(
      `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(String(userId))}/scopes`,
      { headers: authHeaders(jwt) },
    )
    if (!res.ok) {
      console.warn(`[member-scopes] fetchMemberScopes ${projectId}/${userId} → HTTP ${res.status}`)
      return null
    }
    const body = (await res.json()) as { scopes?: MemberScope[] }
    return body.scopes ?? []
  } catch (err) {
    console.warn("[member-scopes] fetchMemberScopes failed:", err)
    return null
  }
}

/**
 * AQU-1607: a member's scopes plus display names for the lanes they name. A
 * lane scope is a lane id, so a surface that shows a scope without loading
 * the project's lanes (the members matrix's chips) reads its label from here.
 * `laneNames` covers only the lanes the scopes name, and an older server
 * simply omits it — fall back to the raw value.
 */
export interface MemberScopeView {
  scopes: MemberScope[]
  laneNames: Record<string, string>
}

/** Label for one lane scope: its lane's name when known, else the raw value. */
export function laneScopeLabel(value: string, laneNames: Record<string, string> | undefined): string {
  return laneNames?.[value] ?? value
}

export async function fetchMemberScopeView(
  jwt: string,
  projectId: string,
  userId: number | "me",
  apiUrl: string = AUTH_API_URL,
): Promise<MemberScopeView | null> {
  try {
    const res = await fetch(
      `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(String(userId))}/scopes`,
      { headers: authHeaders(jwt) },
    )
    if (!res.ok) {
      console.warn(`[member-scopes] fetchMemberScopeView ${projectId}/${userId} → HTTP ${res.status}`)
      return null
    }
    const body = (await res.json()) as { scopes?: MemberScope[]; laneNames?: Record<string, string> }
    return { scopes: body.scopes ?? [], laneNames: body.laneNames ?? {} }
  } catch (err) {
    console.warn("[member-scopes] fetchMemberScopeView failed:", err)
    return null
  }
}

/**
 * PUT /api/v2/projects/:projectId/members/:userId/scopes — replace-set a
 * member's scopes. Requires project_lead (500+); throws on any non-2xx
 * (including the 400 "leads must stay unscoped" rejection) or network error
 * so the caller's save action can surface the failure.
 */
export async function putMemberScopes(
  jwt: string,
  projectId: string,
  userId: number,
  scopes: MemberScope[],
  apiUrl: string = AUTH_API_URL,
): Promise<MemberScope[]> {
  const res = await fetch(
    `${apiUrl}/api/v2/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(String(userId))}/scopes`,
    {
      method: "PUT",
      headers: authHeaders(jwt),
      body: JSON.stringify({ scopes }),
    },
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string })
    // AQU-1607: a lane value naming two lanes or none is refused with the
    // values named — keep them in the message so the operator can see which.
    const detail = body as { error?: string; ambiguous?: string[]; unmatched?: string[] }
    const offenders = [...(detail.ambiguous ?? []), ...(detail.unmatched ?? [])]
    const message = detail.error ?? `HTTP ${res.status}`
    throw new Error(offenders.length > 0 ? `${message}: ${offenders.join(", ")}` : message)
  }
  const body = (await res.json()) as { scopes?: MemberScope[] }
  return body.scopes ?? []
}
