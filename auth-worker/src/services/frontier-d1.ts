export const FRONTIER_D1_SOURCE = "frontier-db-v2"

export interface FrontierD1Config {
  accountId: string
  databaseId: string
  apiToken: string
  apiBaseUrl?: string
}

export interface LegacyUserRow {
  id: number
  username: string
  email: string
  password_hash: string
  gitlab_user_id: number | null
  created_at: string | null
  updated_at: string | null
}

interface D1QueryResult<T> {
  success: boolean
  results?: T[]
}

interface D1QueryResponse<T> {
  success: boolean
  result?: D1QueryResult<T>[]
}

function queryUrl(config: FrontierD1Config): string {
  const base = (config.apiBaseUrl ?? "https://api.cloudflare.com/client/v4")
    .replace(/\/+$/, "")
  return `${base}/accounts/${encodeURIComponent(config.accountId)}/d1/database/${encodeURIComponent(config.databaseId)}/query`
}

function parseLegacyUser(row: Record<string, unknown>): LegacyUserRow {
  const id = Number(row.id)
  const gitlabUserId =
    row.gitlab_user_id == null ? null : Number(row.gitlab_user_id)
  if (
    !Number.isSafeInteger(id) ||
    typeof row.username !== "string" ||
    typeof row.email !== "string" ||
    typeof row.password_hash !== "string" ||
    (gitlabUserId !== null && !Number.isSafeInteger(gitlabUserId))
  ) {
    throw new Error("frontier-db-v2 returned an invalid user row")
  }
  return {
    id,
    username: row.username,
    email: row.email,
    password_hash: row.password_hash,
    gitlab_user_id: gitlabUserId,
    created_at: typeof row.created_at === "string" ? row.created_at : null,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
  }
}

export async function queryFrontierD1<T extends Record<string, unknown>>(
  config: FrontierD1Config,
  sql: string,
  params: unknown[],
  fetchFn: typeof fetch = fetch,
): Promise<T[]> {
  let response: Response
  try {
    response = await fetchFn(queryUrl(config), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    })
  } catch {
    throw new Error("frontier-db-v2 is unavailable")
  }
  if (!response.ok) {
    throw new Error(`frontier-db-v2 query failed with HTTP ${response.status}`)
  }
  const body = (await response.json()) as D1QueryResponse<T>
  const result = body.result?.[0]
  if (!body.success || !result?.success || !Array.isArray(result.results)) {
    throw new Error("frontier-db-v2 query failed")
  }
  return result.results
}

/** Exact legacy identity lookup. Only the whitelisted migration fields are
 * selected; notably, gitlab_token is never read from D1. */
export async function findLegacyUsersByIdentifier(
  config: FrontierD1Config,
  identifier: string,
  fetchFn: typeof fetch = fetch,
): Promise<LegacyUserRow[]> {
  const rows = await queryFrontierD1<Record<string, unknown>>(
    config,
    `SELECT id, username, email, password_hash, gitlab_user_id, created_at, updated_at
       FROM users
      WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)
      ORDER BY id
      LIMIT 3`,
    [identifier.trim(), identifier.trim()],
    fetchFn,
  )
  return rows.map(parseLegacyUser)
}

/**
 * Reserve legacy identities during Aquilla registration without reading any
 * credential or GitLab fields. A single D1 query checks the proposed username
 * and email against their corresponding case-insensitive legacy identifiers.
 */
export async function hasLegacyIdentityCollision(
  config: FrontierD1Config,
  username: string,
  email: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const rows = await queryFrontierD1<{ id: unknown }>(
    config,
    `SELECT id
       FROM users
      WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)
      LIMIT 1`,
    [username.trim(), email.trim()],
    fetchFn,
  )
  return rows.length > 0
}

export async function listLegacyUsersPage(
  config: FrontierD1Config,
  afterId: number,
  limit: number,
  fetchFn: typeof fetch = fetch,
): Promise<LegacyUserRow[]> {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
  const rows = await queryFrontierD1<Record<string, unknown>>(
    config,
    `SELECT id, username, email, password_hash, gitlab_user_id, created_at, updated_at
       FROM users
      WHERE id > ?
      ORDER BY id
      LIMIT ?`,
    [afterId, safeLimit],
    fetchFn,
  )
  return rows.map(parseLegacyUser)
}

export async function listAllLegacyUsers(
  config: FrontierD1Config,
  fetchFn: typeof fetch = fetch,
): Promise<LegacyUserRow[]> {
  const users: LegacyUserRow[] = []
  let afterId = 0
  while (true) {
    const page = await listLegacyUsersPage(config, afterId, 500, fetchFn)
    users.push(...page)
    if (page.length < 500) return users
    afterId = page[page.length - 1].id
  }
}
