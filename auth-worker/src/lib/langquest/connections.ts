// Account-level LangQuest connections (0196_langquest_connections.sql).
//
// One row per (Aquilla user, LangQuest organization): the user's lqp_ token,
// encrypted like a link's, and its health. A project link made from a
// connection carries its own token_enc copy (so the sync routes in
// routes/langquest.ts never changed) and points back here with connection_id,
// which is how a reconnect reaches every link made from the connection and how
// a link's rejected token marks the connection broken.

import type { Env } from "../../types"
import { parseJsonColumn } from "../monday/types"
import { runningEnvironment } from "../monday/tokens"
import type { LangQuestMe, LangQuestScope } from "./client"
import { encryptLangQuestToken } from "./tokens"

export interface ConnectionRow {
  id: string
  user_id: number | string
  api_base: string
  lq_org_id: string
  lq_org_name: string | null
  token_enc: string
  environment: string | null
  token_id: string | null
  token_name: string | null
  scopes: unknown
  all_languages: boolean
  token_expires_at: string | Date | null
  needs_reauth: boolean
  last_checked_at: string | Date | null
  last_error: string | null
  created_at: string | Date
  updated_at: string | Date
}

/**
 * The one word the UI acts on. `expired` is read off the token's own expiry
 * so it shows before LangQuest is ever asked; `needs_reauth` is what LangQuest
 * said (revoked, or made on another deployment); `unreachable` is a failed
 * probe that was not a verdict on the token; `ok` is everything else.
 */
export type ConnectionHealth = "ok" | "needs_reauth" | "expired" | "unreachable"

export function connectionHealth(
  row: Pick<ConnectionRow, "needs_reauth" | "token_expires_at" | "last_error">,
  now = Date.now(),
): ConnectionHealth {
  if (row.needs_reauth) return "needs_reauth"
  const exp = row.token_expires_at == null ? null : new Date(row.token_expires_at).getTime()
  if (exp != null && Number.isFinite(exp) && exp <= now) return "expired"
  if (row.last_error) return "unreachable"
  return "ok"
}

const iso = (v: string | Date | null): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString()

/** The connection as routes return it: everything but the token. */
export function connectionOut(row: ConnectionRow, linkedProjects = 0) {
  return {
    id: row.id,
    apiBase: row.api_base,
    org: { id: row.lq_org_id, name: row.lq_org_name ?? "" },
    token: {
      id: row.token_id,
      name: row.token_name ?? "",
      scopes: parseJsonColumn<LangQuestScope[]>(row.scopes, []),
      expiresAt: iso(row.token_expires_at),
      allLanguages: row.all_languages,
    },
    health: connectionHealth(row),
    lastCheckedAt: iso(row.last_checked_at),
    lastError: row.last_error,
    linkedProjects,
    connectedAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export type ConnectionOut = ReturnType<typeof connectionOut>

export async function listConnections(env: Env, userId: number): Promise<ConnectionRow[]> {
  const { results } = await env.AQUILLA_PG.prepare(
    "SELECT * FROM langquest_connections WHERE user_id = ? ORDER BY lq_org_name, created_at",
  )
    .bind(userId)
    .all<ConnectionRow>()
  return results
}

/** A connection by id, only if it belongs to `userId`: another user's is not found. */
export async function getOwnConnection(env: Env, userId: number, id: string): Promise<ConnectionRow | null> {
  return env.AQUILLA_PG.prepare("SELECT * FROM langquest_connections WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<ConnectionRow>()
}

/** How many project links were made from each of the user's connections. */
export async function linkedProjectCounts(env: Env, connectionIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (connectionIds.length === 0) return counts
  const { results } = await env.AQUILLA_PG.prepare(
    `SELECT connection_id, count(*)::int AS n FROM langquest_links
      WHERE connection_id IN (${connectionIds.map(() => "?").join(",")}) GROUP BY connection_id`,
  )
    .bind(...connectionIds)
    .all<{ connection_id: string; n: number }>()
  for (const r of results) counts.set(r.connection_id, Number(r.n))
  return counts
}

/**
 * Store (or refresh) the user's connection to the organization `me` belongs
 * to, and push the new token onto every project link made from it. Returns
 * the row as stored.
 */
export async function upsertConnection(
  env: Env,
  userId: number,
  token: string,
  apiBase: string,
  me: LangQuestMe,
): Promise<ConnectionRow> {
  const tokenEnc = await encryptLangQuestToken(env, token)
  const environment = runningEnvironment(env)
  const existing = await env.AQUILLA_PG.prepare(
    "SELECT id FROM langquest_connections WHERE user_id = ? AND lq_org_id = ?",
  )
    .bind(userId, me.org.id)
    .first<{ id: string }>()
  const id = existing?.id ?? crypto.randomUUID()
  await env.AQUILLA_PG.batch([
    env.AQUILLA_PG.prepare(
      `INSERT INTO langquest_connections (id, user_id, api_base, lq_org_id, lq_org_name, token_enc, environment,
         token_id, token_name, scopes, all_languages, token_expires_at, needs_reauth, last_checked_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE, now(), NULL)
       ON CONFLICT (user_id, lq_org_id) DO UPDATE SET
         api_base = excluded.api_base, lq_org_name = excluded.lq_org_name, token_enc = excluded.token_enc,
         environment = excluded.environment, token_id = excluded.token_id, token_name = excluded.token_name,
         scopes = excluded.scopes, all_languages = excluded.all_languages,
         token_expires_at = excluded.token_expires_at, needs_reauth = FALSE, last_checked_at = now(),
         last_error = NULL, updated_at = now()`,
    ).bind(
      id,
      userId,
      apiBase,
      me.org.id,
      me.org.name,
      tokenEnc,
      environment,
      me.token.id,
      me.token.name,
      JSON.stringify(me.token.scopes),
      me.token.languageIds == null,
      me.token.expiresAt,
    ),
    // Every link made from this connection follows the new token.
    env.AQUILLA_PG.prepare(
      `UPDATE langquest_links SET token_enc = ?, environment = ?, api_base = ?, token_id = ?, scopes = ?,
         token_expires_at = ?, needs_reauth = FALSE, updated_at = now()
       WHERE connection_id = ?`,
    ).bind(tokenEnc, environment, apiBase, me.token.id, JSON.stringify(me.token.scopes), me.token.expiresAt, id),
  ])
  const row = await env.AQUILLA_PG.prepare("SELECT * FROM langquest_connections WHERE id = ?")
    .bind(id)
    .first<ConnectionRow>()
  if (!row) throw new Error("langquest connection vanished after upsert")
  return row
}

/** Record a health probe's outcome. A rejected token is a verdict; anything else is a note. */
export async function recordProbe(
  env: Env,
  id: string,
  outcome: { rejected: boolean; error: string | null; me?: LangQuestMe },
): Promise<void> {
  if (outcome.rejected) {
    await env.AQUILLA_PG.batch([
      env.AQUILLA_PG.prepare(
        `UPDATE langquest_connections SET needs_reauth = TRUE, last_checked_at = now(), last_error = ?, updated_at = now()
          WHERE id = ?`,
      ).bind(outcome.error, id),
      env.AQUILLA_PG.prepare(
        "UPDATE langquest_links SET needs_reauth = TRUE, updated_at = now() WHERE connection_id = ?",
      ).bind(id),
    ])
    return
  }
  if (outcome.me) {
    await env.AQUILLA_PG.prepare(
      `UPDATE langquest_connections SET lq_org_name = ?, scopes = ?, all_languages = ?, token_expires_at = ?,
         needs_reauth = FALSE, last_checked_at = now(), last_error = NULL, updated_at = now()
       WHERE id = ?`,
    )
      .bind(
        outcome.me.org.name,
        JSON.stringify(outcome.me.token.scopes),
        outcome.me.token.languageIds == null,
        outcome.me.token.expiresAt,
        id,
      )
      .run()
    return
  }
  await env.AQUILLA_PG.prepare(
    "UPDATE langquest_connections SET last_checked_at = now(), last_error = ?, updated_at = now() WHERE id = ?",
  )
    .bind(outcome.error, id)
    .run()
}

/** A link's token was rejected: the connection it came from is broken too. */
export async function markConnectionOfLinkRejected(env: Env, projectId: string, error: string | null): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `UPDATE langquest_connections SET needs_reauth = TRUE, last_checked_at = now(), last_error = ?, updated_at = now()
      WHERE id = (SELECT connection_id FROM langquest_links WHERE project_id = ?)`,
  )
    .bind(error, projectId)
    .run()
}
