// Monday.com GraphQL client — thin fetch helper with the API-Version pin,
// 429/complexity handling (single retry after retry_in_seconds), and an
// aliased-mutation batcher so the push engine sends ONE HTTP request per ~10
// mutations (daily-call budgets on Free/Basic Monday plans are tiny).

import type { MondayBoardColumn, MondayBoardGroup } from "./types"

export const MONDAY_API_URL = "https://api.monday.com/v2"
export const MONDAY_API_VERSION = "2026-07"

/** Max seconds we will actually sleep on a 429 before giving up. */
const MAX_RETRY_SLEEP_SECONDS = 60

export class MondayApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "MondayApiError"
    this.status = status
  }
}

interface GraphQLErrorEntry {
  message?: string
  extensions?: { code?: string; retry_in_seconds?: number }
}

interface GraphQLEnvelope<T> {
  data?: T
  errors?: GraphQLErrorEntry[]
  error_message?: string
  retry_in_seconds?: number
}

function retrySecondsFrom(body: GraphQLEnvelope<unknown> | null): number | null {
  if (!body) return null
  if (typeof body.retry_in_seconds === "number") return body.retry_in_seconds
  const fromError = body.errors?.find(
    (e) => typeof e.extensions?.retry_in_seconds === "number",
  )
  return fromError?.extensions?.retry_in_seconds ?? null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Execute one GraphQL request against the Monday API. On a rate-limit
 * response carrying retry_in_seconds, sleeps exactly that (capped) and
 * retries ONCE; a second failure throws.
 */
export async function mondayGraphQL<T>(
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
  attempt = 0,
): Promise<T> {
  const res = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      Authorization: accessToken,
      "Content-Type": "application/json",
      "API-Version": MONDAY_API_VERSION,
    },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  })

  let body: GraphQLEnvelope<T> | null = null
  try {
    body = (await res.json()) as GraphQLEnvelope<T>
  } catch {
    body = null
  }

  const retryIn = res.status === 429 ? (retrySecondsFrom(body) ?? 1) : retrySecondsFrom(body)
  if (retryIn != null && attempt === 0) {
    await sleep(Math.min(Math.max(retryIn, 0), MAX_RETRY_SLEEP_SECONDS) * 1000)
    return mondayGraphQL<T>(accessToken, query, variables, 1)
  }

  if (!res.ok) {
    throw new MondayApiError(
      body?.error_message ?? body?.errors?.[0]?.message ?? `monday API HTTP ${res.status}`,
      res.status,
    )
  }
  if (body?.errors?.length) {
    throw new MondayApiError(body.errors[0]?.message ?? "monday API error", 200)
  }
  if (!body?.data) {
    throw new MondayApiError("monday API returned no data", res.status)
  }
  return body.data
}

/** Escape a string for embedding inside a GraphQL double-quoted string literal. */
export function gqlString(value: string): string {
  return JSON.stringify(value)
}

export interface AliasedMutation {
  alias: string
  /** The mutation body WITHOUT the leading `mutation {` wrapper, e.g. `create_item(...) { id }`. */
  body: string
}

/** Chunk an array into groups of `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Run mutations batched via GraphQL aliases, ~10 per HTTP request.
 * Returns a map alias → result object ({ id } for item mutations).
 */
export async function runAliasedMutations(
  accessToken: string,
  mutations: AliasedMutation[],
  batchSize = 10,
): Promise<Record<string, { id?: string } | null>> {
  const results: Record<string, { id?: string } | null> = {}
  for (const batch of chunk(mutations, batchSize)) {
    const query = `mutation {\n${batch.map((m) => `  ${m.alias}: ${m.body}`).join("\n")}\n}`
    const data = await mondayGraphQL<Record<string, { id?: string } | null>>(
      accessToken,
      query,
    )
    Object.assign(results, data)
  }
  return results
}

// ── Read helpers ───────────────────────────────────────────────────────────

export interface MondayBoardSummary {
  id: string
  name: string
  workspace: { id: string; name: string } | null
}

/** List boards the token can see (paginated, up to ~200). */
export async function listBoards(accessToken: string): Promise<MondayBoardSummary[]> {
  const boards: MondayBoardSummary[] = []
  for (let page = 1; page <= 4; page++) {
    const data = await mondayGraphQL<{
      boards: Array<{
        id: string | number
        name: string
        state?: string
        workspace: { id: string | number; name: string } | null
      }> | null
    }>(
      accessToken,
      `query { boards(limit: 50, page: ${page}, state: active) { id name state workspace { id name } } }`,
    )
    const pageBoards = data.boards ?? []
    for (const b of pageBoards) {
      boards.push({
        id: String(b.id),
        name: b.name,
        workspace: b.workspace
          ? { id: String(b.workspace.id), name: b.workspace.name }
          : null,
      })
    }
    if (pageBoards.length < 50) break
  }
  return boards
}

export interface BoardStructureResult {
  columns: MondayBoardColumn[]
  groups: MondayBoardGroup[]
}

/** Fetch a board's columns + groups (ids are stable across renames — key on id). */
export async function fetchBoardStructure(
  accessToken: string,
  boardId: string,
): Promise<BoardStructureResult> {
  const data = await mondayGraphQL<{
    boards: Array<{
      columns: Array<{ id: string; title: string; type: string; settings_str?: string }>
      groups: Array<{ id: string; title: string }>
    }> | null
  }>(
    accessToken,
    `query { boards(ids: ${gqlString(boardId)}) { columns { id title type settings_str } groups { id title } } }`,
  )
  const board = data.boards?.[0]
  if (!board) throw new MondayApiError(`board ${boardId} not found`, 404)
  return { columns: board.columns ?? [], groups: board.groups ?? [] }
}

export interface MondayItemSample {
  id: string
  name: string
  column_values: Array<{ id: string; type: string; text: string | null }>
}

/** First page of items on a board (default 25) — used as LLM context in analyze. */
export async function fetchBoardItemsSample(
  accessToken: string,
  boardId: string,
  limit = 25,
): Promise<MondayItemSample[]> {
  const data = await mondayGraphQL<{
    boards: Array<{
      items_page: {
        items: Array<{
          id: string | number
          name: string
          column_values: Array<{ id: string; type: string; text: string | null }>
        }>
      }
    }> | null
  }>(
    accessToken,
    `query { boards(ids: ${gqlString(boardId)}) { items_page(limit: ${limit}) { items { id name column_values { id type text } } } } }`,
  )
  const items = data.boards?.[0]?.items_page?.items ?? []
  return items.map((i) => ({
    id: String(i.id),
    name: i.name,
    column_values: i.column_values ?? [],
  }))
}

/** Find an item whose text column equals `value` (idempotent re-linking). */
export async function findItemByColumnValue(
  accessToken: string,
  boardId: string,
  columnId: string,
  value: string,
): Promise<string | null> {
  const data = await mondayGraphQL<{
    items_page_by_column_values: { items: Array<{ id: string | number }> } | null
  }>(
    accessToken,
    `query { items_page_by_column_values(board_id: ${gqlString(boardId)}, limit: 1, columns: [{column_id: ${gqlString(columnId)}, column_values: [${gqlString(value)}]}]) { items { id } } }`,
  )
  const id = data.items_page_by_column_values?.items?.[0]?.id
  return id != null ? String(id) : null
}

/** Case-insensitive name match against the first items page (v1 approximation). */
export async function findItemByName(
  accessToken: string,
  boardId: string,
  name: string,
): Promise<string | null> {
  const data = await mondayGraphQL<{
    boards: Array<{
      items_page: { items: Array<{ id: string | number; name: string }> }
    }> | null
  }>(
    accessToken,
    `query { boards(ids: ${gqlString(boardId)}) { items_page(limit: 500) { items { id name } } } }`,
  )
  const items = data.boards?.[0]?.items_page?.items ?? []
  const needle = name.trim().toLowerCase()
  const hit = items.find((i) => i.name.trim().toLowerCase() === needle)
  return hit ? String(hit.id) : null
}

// ── Webhooks ───────────────────────────────────────────────────────────────

const WEBHOOK_EVENTS = ["create_column", "item_deleted"] as const

/**
 * Create our board webhooks (create_column → structure_stale; item_deleted →
 * clear item links). Returns the Monday webhook ids we own.
 */
export async function createBoardWebhooks(
  accessToken: string,
  boardId: string,
  url: string,
): Promise<string[]> {
  const ids: string[] = []
  for (const event of WEBHOOK_EVENTS) {
    const data = await mondayGraphQL<{ create_webhook: { id: string | number } | null }>(
      accessToken,
      `mutation { create_webhook(board_id: ${gqlString(boardId)}, url: ${gqlString(url)}, event: ${event}) { id } }`,
    )
    if (data.create_webhook?.id != null) ids.push(String(data.create_webhook.id))
  }
  return ids
}

/** Delete our webhooks; failures are swallowed (best-effort cleanup). */
export async function deleteWebhooksBestEffort(
  accessToken: string,
  webhookIds: string[],
): Promise<void> {
  for (const id of webhookIds) {
    try {
      await mondayGraphQL(
        accessToken,
        `mutation { delete_webhook(id: ${gqlString(id)}) { id } }`,
      )
    } catch (err) {
      console.warn(`[monday] delete_webhook ${id} failed (best-effort):`, err)
    }
  }
}
