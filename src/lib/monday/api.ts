/**
 * Client for the Monday.com integration API (auth-worker /api/v2/monday/*).
 *
 * Server contract: monday-integration-contract.md (routes in
 * auth-worker/src/routes/monday.ts). Every function takes the caller's Bearer
 * JWT (from `useFrontierSession().session.jwt`) and hits `${AUTH_BASE}/api/v2/monday/...`
 * — same fetch/auth/error style as src/lib/terminology/subscriptions-api.ts and
 * src/lib/sync/org-settings.ts.
 */

import { AUTH_BASE } from "../frontier/auth"
import type { MessageKey } from "../i18n/messages/en"
import { t } from "../i18n/standalone"
import type { MondayMapping } from "./types"

function authHeaders(jwt: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
  }
}

/** Thrown when a Monday API call returns a non-2xx the caller should surface. */
export class MondayApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "MondayApiError"
    this.status = status
  }
}

/**
 * AQU-820: the message is OURS — a translated sentence chosen by the call site.
 * The server's `{ error, detail }` is untranslated and often a raw diagnostic,
 * so it is kept on `cause` for DevTools rather than shown to the user.
 */
async function readError(res: Response, fallbackKey: MessageKey): Promise<never> {
  let detail = ""
  try {
    const body = (await res.json()) as { error?: string; detail?: string }
    detail = body?.error || body?.detail || ""
  } catch {
    // non-JSON body; nothing to preserve
  }
  const err = new MondayApiError(t(fallbackKey), res.status)
  err.cause = `HTTP ${res.status}${detail ? ` — ${detail.slice(0, 400)}` : ""}`
  throw err
}

// ── Shapes (mirror the contract) ───────────────────────────────────────────

/** GET /orgs/:orgId/connection — no token ever returned. */
export interface MondayConnectionStatus {
  connected: boolean
  /** OAuth 2.1: the refresh token expired or was revoked (6-month max
   *  lifetime) — the org must re-run the Connect flow. Links are kept. */
  needsReauth?: boolean
  /** Monday's install link for this app — for forwarding to a Monday admin
   *  when the connecting user can't install apps in their account. */
  installUrl?: string
  account?: { id: string; slug: string; userName: string }
  scopes?: string
  createdAt?: string
}

/** GET /orgs/:orgId/boards item. */
export interface MondayBoard {
  id: string
  name: string
  workspace?: { id: string; name: string } | null
}

/** GET /orgs/:orgId/boards/:boardId/structure. */
export interface MondayBoardStructure {
  columns: { id: string; title: string; type: string }[]
  groups: { id: string; title: string }[]
}

/** The `link` object from GET/PUT/PATCH /projects/:projectId/link. */
export interface MondayBoardLink {
  id: string
  boardId: string
  boardName: string | null
  enabled: boolean
  config: MondayMapping
  structureStale: boolean
  lastPushedAt: string | null
  lastPushStatus: "ok" | "error" | null
  lastPushError: string | null
  orgConnected: boolean
}

export interface MondayLinkStatus {
  linked: boolean
  link?: MondayBoardLink
}

export interface MondaySyncResult {
  ok: boolean
  pushed: boolean
  itemsUpserted?: number
  error?: string
}

// ── Org connection ─────────────────────────────────────────────────────────

/** GET /api/v2/monday/orgs/:orgId/connection (org member). */
export async function fetchMondayConnection(
  jwt: string,
  orgId: number,
): Promise<MondayConnectionStatus> {
  const res = await fetch(`${AUTH_BASE}/api/v2/monday/orgs/${orgId}/connection`, {
    headers: authHeaders(jwt),
  })
  if (!res.ok) await readError(res, "error.monday.loadConnection")
  return (await res.json()) as MondayConnectionStatus
}

/**
 * POST /api/v2/monday/orgs/:orgId/connection/start (maintainer+).
 * Returns the Monday OAuth authorize URL; caller does window.location.assign(url).
 * `backTo` must be an app path (starts with '/') — validated server-side too.
 */
export async function startMondayConnect(
  jwt: string,
  orgId: number,
  backTo?: string,
): Promise<{ url: string }> {
  const res = await fetch(`${AUTH_BASE}/api/v2/monday/orgs/${orgId}/connection/start`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify(backTo ? { backTo } : {}),
  })
  if (!res.ok) await readError(res, "error.monday.startConnection")
  return (await res.json()) as { url: string }
}

/** GET /api/v2/monday/oauth/callback response — success carries the app path
 *  to return the user to; failure carries a safe (non-internal) reason. */
export type MondayOAuthResult = { ok: true; backTo: string } | { ok: false; reason: string }

/**
 * GET /api/v2/monday/oauth/callback?code&state — completes the OAuth exchange.
 * Called by the SPA /oauth/callback route (Monday's registered redirect URI is
 * an SPA route, not the worker). No auth header needed: the signed `state` JWT
 * carries org/user identity. The `code` is single-use — call exactly once.
 */
export async function completeMondayOAuth(code: string, state: string): Promise<MondayOAuthResult> {
  const qs = new URLSearchParams({ code, state })
  let res: Response
  try {
    res = await fetch(`${AUTH_BASE}/api/v2/monday/oauth/callback?${qs.toString()}`)
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "network error" }
  }
  try {
    const body = (await res.json()) as { ok?: boolean; backTo?: string; reason?: string }
    if (res.ok && body.ok === true && typeof body.backTo === "string") {
      return { ok: true, backTo: body.backTo }
    }
    return { ok: false, reason: body.reason ?? `exchange failed (${res.status})` }
  } catch {
    return { ok: false, reason: `exchange failed (${res.status})` }
  }
}

/** DELETE /api/v2/monday/orgs/:orgId/connection (maintainer+). Cascades links. */
export async function deleteMondayConnection(jwt: string, orgId: number): Promise<void> {
  const res = await fetch(`${AUTH_BASE}/api/v2/monday/orgs/${orgId}/connection`, {
    method: "DELETE",
    headers: authHeaders(jwt),
  })
  if (!res.ok) await readError(res, "error.monday.disconnect")
}

// ── Boards ─────────────────────────────────────────────────────────────────

/** GET /api/v2/monday/orgs/:orgId/boards (maintainer+). Unwraps `{ boards }`. */
export async function fetchMondayBoards(jwt: string, orgId: number): Promise<MondayBoard[]> {
  const res = await fetch(`${AUTH_BASE}/api/v2/monday/orgs/${orgId}/boards`, {
    headers: authHeaders(jwt),
  })
  if (!res.ok) await readError(res, "error.monday.loadBoards")
  const body = (await res.json()) as { boards?: MondayBoard[] }
  return body.boards ?? []
}

/** GET /api/v2/monday/orgs/:orgId/boards/:boardId/structure (maintainer+). */
export async function fetchMondayBoardStructure(
  jwt: string,
  orgId: number,
  boardId: string,
): Promise<MondayBoardStructure> {
  const res = await fetch(
    `${AUTH_BASE}/api/v2/monday/orgs/${orgId}/boards/${encodeURIComponent(boardId)}/structure`,
    { headers: authHeaders(jwt) },
  )
  if (!res.ok) await readError(res, "error.monday.loadBoardStructure")
  return (await res.json()) as MondayBoardStructure
}

// ── Project board link ─────────────────────────────────────────────────────

/** GET /api/v2/monday/projects/:projectId/link (any project member). */
export async function fetchMondayLink(jwt: string, projectId: string): Promise<MondayLinkStatus> {
  const res = await fetch(`${AUTH_BASE}/api/v2/monday/projects/${projectId}/link`, {
    headers: authHeaders(jwt),
  })
  if (!res.ok) await readError(res, "error.monday.loadLink")
  return (await res.json()) as MondayLinkStatus
}

/**
 * PUT /api/v2/monday/projects/:projectId/link (maintainer+). Creates/replaces
 * the board link. Missing columns are stripped server-side into `warnings`.
 */
export async function putMondayLink(
  jwt: string,
  projectId: string,
  body: { boardId: string; boardName?: string; config: MondayMapping; enabled?: boolean },
): Promise<{ link: MondayBoardLink; warnings: string[] }> {
  const res = await fetch(`${AUTH_BASE}/api/v2/monday/projects/${projectId}/link`, {
    method: "PUT",
    headers: authHeaders(jwt),
    body: JSON.stringify(body),
  })
  if (!res.ok) await readError(res, "error.monday.saveLink")
  const out = (await res.json()) as { link: MondayBoardLink; warnings?: string[] }
  return { link: out.link, warnings: out.warnings ?? [] }
}

/** PATCH /api/v2/monday/projects/:projectId/link (maintainer+). */
export async function patchMondayLink(
  jwt: string,
  projectId: string,
  body: { enabled?: boolean; config?: MondayMapping },
): Promise<MondayBoardLink> {
  const res = await fetch(`${AUTH_BASE}/api/v2/monday/projects/${projectId}/link`, {
    method: "PATCH",
    headers: authHeaders(jwt),
    body: JSON.stringify(body),
  })
  if (!res.ok) await readError(res, "error.monday.updateLink")
  // Accept both `{ link }` (PUT-style envelope) and a bare link object.
  const out = (await res.json()) as MondayBoardLink | { link: MondayBoardLink }
  return "link" in out && typeof out.link === "object" ? out.link : (out as MondayBoardLink)
}

/** DELETE /api/v2/monday/projects/:projectId/link (maintainer+). */
export async function deleteMondayLink(jwt: string, projectId: string): Promise<void> {
  const res = await fetch(`${AUTH_BASE}/api/v2/monday/projects/${projectId}/link`, {
    method: "DELETE",
    headers: authHeaders(jwt),
  })
  if (!res.ok) await readError(res, "error.monday.removeLink")
}

// ── AI configure + sync ────────────────────────────────────────────────────

/**
 * POST /api/v2/monday/projects/:projectId/analyze (maintainer+). One LLM call
 * server-side; returns a validated/clamped mapping proposal for user review.
 */
export async function analyzeMondayMapping(
  jwt: string,
  projectId: string,
  body: { boardId: string; message?: string; currentConfig?: MondayMapping },
): Promise<{ proposal: MondayMapping; summary: string }> {
  const res = await fetch(`${AUTH_BASE}/api/v2/monday/projects/${projectId}/analyze`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify(body),
  })
  if (!res.ok) await readError(res, "error.monday.analyze")
  return (await res.json()) as { proposal: MondayMapping; summary: string }
}

/** POST /api/v2/monday/projects/:projectId/sync (maintainer+). Push now. */
export async function syncMondayNow(jwt: string, projectId: string): Promise<MondaySyncResult> {
  const res = await fetch(`${AUTH_BASE}/api/v2/monday/projects/${projectId}/sync`, {
    method: "POST",
    headers: authHeaders(jwt),
  })
  if (!res.ok) await readError(res, "error.monday.sync")
  return (await res.json()) as MondaySyncResult
}
