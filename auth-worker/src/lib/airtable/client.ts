// Airtable Web API client (AQU-804) — v0 REST: records at
// /v0/{baseId}/{tableId}, schema at /v0/meta/bases/{baseId}/tables.
//
// Airtable allows 5 requests per second per base and answers a burst with a
// 429 that locks the base out for 30 seconds. So every request to a base
// waits its turn (one slot per 220 ms, per base, per isolate), and a 429 is
// retried ONCE after the wait Airtable asks for (Retry-After, else 30 s); a
// second 429 is the caller's to handle (the push engine backs off, AQU-1828).
// Record writes go 10 at a time, Airtable's per-request maximum, with
// `typecast` on so a status label that isn't a choice yet becomes one.

import type { Env } from "../../types"
import type { AirtableField, AirtableTable } from "./types"
import {
  isAbortTimeout,
  logVendorTimeout,
  vendorTimeoutMessage,
  VENDOR_TIMEOUT_MS,
} from "../../../../shared/vendor-timeouts"

export const AIRTABLE_API_URL = "https://api.airtable.com"

/** Records per create/update request — Airtable refuses more than 10. */
export const RECORD_BATCH_SIZE = 10
/** Spacing between requests to one base: 5 per second, with a little room. */
export const BASE_REQUEST_INTERVAL_MS = 220
/** What a 429 costs when Airtable doesn't say (its documented lock-out). */
export const RATE_LIMIT_WAIT_MS = 30_000
/** The longest Retry-After we will honour before giving up on the attempt. */
const MAX_RATE_LIMIT_WAIT_MS = 60_000

export class AirtableApiError extends Error {
  readonly status: number
  /** Airtable's error type, e.g. UNKNOWN_FIELD_NAME, when it gave one. */
  readonly type: string | null
  constructor(message: string, status: number, type: string | null = null) {
    super(message)
    this.name = "AirtableApiError"
    this.status = status
    this.type = type
  }
}

/** Test seam: the clock and the sleep behind the throttle and the 429 wait. */
export const airtableTiming = {
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
}

/** Next free request slot per base, within this isolate. */
const nextSlotByBase = new Map<string, number>()

/** Forget every base's slot (tests start from a clean clock). */
export function resetAirtableThrottle(): void {
  nextSlotByBase.clear()
}

async function waitForBaseSlot(baseId: string): Promise<void> {
  const now = airtableTiming.now()
  const slot = Math.max(now, nextSlotByBase.get(baseId) ?? 0)
  nextSlotByBase.set(baseId, slot + BASE_REQUEST_INTERVAL_MS)
  if (slot > now) await airtableTiming.sleep(slot - now)
}

export interface AirtableClient {
  token: string
  apiUrl: string
}

export function airtableClient(env: Pick<Env, "AIRTABLE_API_URL">, token: string): AirtableClient {
  return { token, apiUrl: (env.AIRTABLE_API_URL?.trim() || AIRTABLE_API_URL).replace(/\/+$/, "") }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE"
  path: string
  query?: URLSearchParams
  body?: unknown
  /** The base the request touches, for the per-base throttle. */
  baseId?: string
}

interface ErrorEnvelope {
  error?: string | { type?: string; message?: string }
  errors?: Array<{ error?: string; message?: string }>
}

function errorFrom(body: ErrorEnvelope | null, status: number): AirtableApiError {
  const err = body?.error
  if (err && typeof err === "object") {
    return new AirtableApiError(err.message || err.type || `Airtable API HTTP ${status}`, status, err.type ?? null)
  }
  if (typeof err === "string") return new AirtableApiError(err, status, err)
  const first = body?.errors?.[0]
  if (first) return new AirtableApiError(first.message || first.error || `Airtable API HTTP ${status}`, status, first.error ?? null)
  return new AirtableApiError(`Airtable API HTTP ${status}`, status)
}

function retryAfterMs(res: Response): number {
  const header = Number(res.headers.get("Retry-After"))
  return Number.isFinite(header) && header > 0 ? header * 1000 : RATE_LIMIT_WAIT_MS
}

export async function airtableRequest<T>(
  client: AirtableClient,
  options: RequestOptions,
  attempt = 0,
): Promise<T> {
  if (options.baseId) await waitForBaseSlot(options.baseId)
  const qs = options.query?.toString() ?? ""
  const url = `${client.apiUrl}${options.path}${qs ? `?${qs}` : ""}`
  let res: Response
  try {
    res = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${client.token}`,
        ...(options.body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
      // Per ATTEMPT: the 429 wait below sits between attempts, so a hung
      // Airtable surfaces as a 504 instead of holding the push open.
      signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS.airtableApi),
    })
  } catch (err) {
    if (isAbortTimeout(err)) {
      logVendorTimeout("airtableApi", err)
      throw new AirtableApiError(vendorTimeoutMessage("airtableApi"), 504)
    }
    throw err
  }

  if (res.status === 429 && attempt === 0) {
    await airtableTiming.sleep(Math.min(retryAfterMs(res), MAX_RATE_LIMIT_WAIT_MS))
    return airtableRequest<T>(client, options, 1)
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) throw errorFrom(body as ErrorEnvelope | null, res.status)
  return body as T
}

const basePath = (baseId: string) => `/v0/${encodeURIComponent(baseId)}`
const tablePath = (baseId: string, tableId: string) =>
  `${basePath(baseId)}/${encodeURIComponent(tableId)}`

/** Split into groups of `size`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// ── Metadata ───────────────────────────────────────────────────────────────

export interface AirtableWhoAmI {
  id: string
  email?: string
  scopes?: string[]
}

/** Who the token belongs to (and, when Airtable says, its scopes). */
export async function whoAmI(client: AirtableClient): Promise<AirtableWhoAmI> {
  return airtableRequest<AirtableWhoAmI>(client, { path: "/v0/meta/whoami" })
}

export interface AirtableBaseSummary {
  id: string
  name: string
}

/** Every base the token can see (paginated, up to 1,000 per page). */
export async function listBases(client: AirtableClient): Promise<AirtableBaseSummary[]> {
  const bases: AirtableBaseSummary[] = []
  let offset: string | undefined
  for (let page = 0; page < 5; page++) {
    const query = new URLSearchParams()
    if (offset) query.set("offset", offset)
    const data = await airtableRequest<{ bases?: Array<{ id: string; name: string }>; offset?: string }>(
      client,
      { path: "/v0/meta/bases", query },
    )
    for (const b of data.bases ?? []) bases.push({ id: b.id, name: b.name })
    offset = data.offset
    if (!offset) break
  }
  return bases
}

/** A base's tables and their fields (ids are stable across renames — key on id). */
export async function fetchBaseTables(client: AirtableClient, baseId: string): Promise<AirtableTable[]> {
  const data = await airtableRequest<{
    tables?: Array<{ id: string; name: string; primaryFieldId: string; fields?: AirtableField[] }>
  }>(client, { path: `/v0/meta/bases/${encodeURIComponent(baseId)}/tables`, baseId })
  return (data.tables ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    primaryFieldId: t.primaryFieldId,
    fields: (t.fields ?? []).map(({ id, name, type }) => ({ id, name, type })),
  }))
}

/** One table of a base. 404 when the base no longer has it. */
export async function fetchTable(client: AirtableClient, baseId: string, tableId: string): Promise<AirtableTable> {
  const table = (await fetchBaseTables(client, baseId)).find((t) => t.id === tableId)
  if (!table) throw new AirtableApiError(`table ${tableId} not found in base ${baseId}`, 404, "NOT_FOUND")
  return table
}

/** The table in Airtable's own UI. */
export function tableUrl(baseId: string, tableId: string): string {
  return `https://airtable.com/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`
}

/** Create one field (needs the schema.bases:write scope). */
export async function createField(
  client: AirtableClient,
  baseId: string,
  tableId: string,
  spec: { name: string; type: string; options?: Record<string, unknown> },
): Promise<AirtableField> {
  const made = await airtableRequest<{ id?: string; name?: string; type?: string }>(client, {
    method: "POST",
    path: `/v0/meta/bases/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}/fields`,
    body: spec,
    baseId,
  })
  if (!made.id) throw new AirtableApiError("field creation returned no id", 200)
  return { id: made.id, name: made.name ?? spec.name, type: made.type ?? spec.type }
}

// ── Records ────────────────────────────────────────────────────────────────

export interface AirtableRecord {
  id: string
  /** Keyed by field id (we always ask for returnFieldsByFieldId). */
  fields: Record<string, unknown>
}

/** Records of a table, keyed by field id, `fieldIds` only when given. */
export async function listRecords(
  client: AirtableClient,
  baseId: string,
  tableId: string,
  opts: { fieldIds?: string[]; maxRecords?: number } = {},
): Promise<AirtableRecord[]> {
  const records: AirtableRecord[] = []
  let offset: string | undefined
  const max = opts.maxRecords ?? 5000
  do {
    const query = new URLSearchParams({ returnFieldsByFieldId: "true", pageSize: String(Math.min(100, max)) })
    for (const id of opts.fieldIds ?? []) query.append("fields[]", id)
    if (offset) query.set("offset", offset)
    const data = await airtableRequest<{ records?: AirtableRecord[]; offset?: string }>(client, {
      path: tablePath(baseId, tableId),
      query,
      baseId,
    })
    for (const r of data.records ?? []) records.push({ id: r.id, fields: r.fields ?? {} })
    offset = data.offset
  } while (offset && records.length < max)
  return records.slice(0, max)
}

/** Create records, 10 per request. Returns the new ids in input order. */
export async function createRecords(
  client: AirtableClient,
  baseId: string,
  tableId: string,
  records: Array<Record<string, unknown>>,
): Promise<string[]> {
  const ids: string[] = []
  for (const batch of chunk(records, RECORD_BATCH_SIZE)) {
    const data = await airtableRequest<{ records?: Array<{ id: string }> }>(client, {
      method: "POST",
      path: tablePath(baseId, tableId),
      body: { records: batch.map((fields) => ({ fields })), typecast: true },
      baseId,
    })
    const made = data.records ?? []
    if (made.length !== batch.length) throw new AirtableApiError("record creation returned the wrong number of records", 200)
    ids.push(...made.map((r) => r.id))
  }
  return ids
}

/** Update records in place (only the given fields change), 10 per request. */
export async function updateRecords(
  client: AirtableClient,
  baseId: string,
  tableId: string,
  records: Array<{ id: string; fields: Record<string, unknown> }>,
): Promise<void> {
  for (const batch of chunk(records, RECORD_BATCH_SIZE)) {
    await airtableRequest(client, {
      method: "PATCH",
      path: tablePath(baseId, tableId),
      body: { records: batch, typecast: true },
      baseId,
    })
  }
}

/**
 * Create-or-update records matched on one field (the Aquilla ID), 10 per
 * request: a record whose `mergeFieldId` value matches is updated, anything
 * else is created. Returns the record ids in input order.
 */
export async function upsertRecords(
  client: AirtableClient,
  baseId: string,
  tableId: string,
  mergeFieldId: string,
  records: Array<Record<string, unknown>>,
): Promise<string[]> {
  const ids: string[] = []
  for (const batch of chunk(records, RECORD_BATCH_SIZE)) {
    const data = await airtableRequest<{ records?: AirtableRecord[] }>(client, {
      method: "PATCH",
      path: tablePath(baseId, tableId),
      body: {
        performUpsert: { fieldsToMergeOn: [mergeFieldId] },
        records: batch.map((fields) => ({ fields })),
        typecast: true,
        returnFieldsByFieldId: true,
      },
      baseId,
    })
    const returned = data.records ?? []
    // Match on the merge value rather than trusting the order alone.
    const byKey = new Map(returned.map((r) => [String(r.fields?.[mergeFieldId] ?? ""), r.id]))
    batch.forEach((fields, i) => {
      const id = byKey.get(String(fields[mergeFieldId] ?? "")) ?? returned[i]?.id
      if (!id) throw new AirtableApiError("upsert returned no record for a row", 200)
      ids.push(id)
    })
  }
  return ids
}
