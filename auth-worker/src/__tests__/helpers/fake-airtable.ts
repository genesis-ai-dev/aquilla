// A stand-in for the Airtable Web API (AQU-804), built from Airtable's
// published reference: no test ever talks to airtable.com. It keeps bases,
// tables and records in memory and answers the endpoints the integration
// uses with Airtable's shapes and refusals:
//
//   GET   /v0/meta/whoami                               → { id, email }
//   GET   /v0/meta/bases                                → { bases: [{ id, name, permissionLevel }] }
//   GET   /v0/meta/bases/{baseId}/tables                → { tables: [{ id, name, primaryFieldId, fields, views }] }
//   POST  /v0/meta/bases/{baseId}/tables/{tableId}/fields → the new field
//   GET   /v0/{baseId}/{tableId}                        → { records, offset? } (pageSize ≤ 100)
//   POST  /v0/{baseId}/{tableId}                        → create ≤ 10 records
//   PATCH /v0/{baseId}/{tableId}                        → update ≤ 10 records, or upsert with performUpsert
//
// Refusals: 401 for a wrong token, 422 for more than 10 records or an unknown
// field, 404 for an unknown base/table/record. `fail` lets a test inject any
// other answer (a 429, a 503) for the next matching request.

export interface FakeField {
  id: string
  name: string
  type: string
  options?: unknown
}

export interface FakeTable {
  id: string
  name: string
  primaryFieldId: string
  fields: FakeField[]
}

export interface FakeBase {
  id: string
  name: string
  tables: FakeTable[]
}

export interface FakeRecord {
  id: string
  fields: Record<string, unknown>
}

export interface FakeRequest {
  method: string
  path: string
  query: URLSearchParams
  body: Record<string, unknown> | null
}

export interface FakeAirtable {
  token: string
  email: string
  bases: FakeBase[]
  /** Records per table id, fields keyed by field id. */
  records: Map<string, FakeRecord[]>
  /** Every request, in order. */
  requests: FakeRequest[]
  /** Answer the next request this returns a Response for (checked first). */
  fail: ((req: FakeRequest) => Response | null) | null
  /** Refuse /v0/meta/bases with 403 (a token without schema.bases:read). */
  noSchemaRead: boolean
  /** Refuse field creation with 403 (a token without schema.bases:write). */
  noSchemaWrite: boolean
}

export function makeFakeAirtable(seed: Partial<Pick<FakeAirtable, "token" | "email" | "bases">> = {}): FakeAirtable {
  return {
    token: seed.token ?? "patTEST.secret",
    email: seed.email ?? "anna@comeandsee.example",
    bases: seed.bases ?? [],
    records: new Map(),
    requests: [],
    fail: null,
    noSchemaRead: false,
    noSchemaWrite: false,
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } })

const airtableError = (status: number, type: string, message: string) => json({ error: { type, message } }, status)

let idCounter = 0
const newId = (prefix: string) => `${prefix}${String(++idCounter).padStart(14, "0")}`

function findTable(fake: FakeAirtable, baseId: string, tableId: string): FakeTable | null {
  const base = fake.bases.find((b) => b.id === baseId)
  return base?.tables.find((t) => t.id === tableId || t.name === tableId) ?? null
}

/** Field keys may be ids or names, as in Airtable. Returns null for an unknown one. */
function resolveFields(table: FakeTable, fields: Record<string, unknown>): Record<string, unknown> | string {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    const field = table.fields.find((f) => f.id === key || f.name === key)
    if (!field) return key
    out[field.id] = value
  }
  return out
}

/** Answer one request as Airtable would. */
export async function fakeAirtableFetch(fake: FakeAirtable, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const text = request.method === "GET" ? "" : await request.text()
  const req: FakeRequest = {
    method: request.method,
    path: url.pathname,
    query: url.searchParams,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
  }
  fake.requests.push(req)
  const injected = fake.fail?.(req)
  if (injected) return injected

  if (request.headers.get("Authorization") !== `Bearer ${fake.token}`) {
    return airtableError(401, "AUTHENTICATION_REQUIRED", "Authentication required")
  }
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)

  if (parts[1] === "meta") {
    if (parts[2] === "whoami") return json({ id: "usrFAKE0000000001", email: fake.email })
    if (parts[2] === "bases" && parts.length === 3) {
      if (fake.noSchemaRead) return airtableError(403, "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND", "Invalid permissions")
      return json({ bases: fake.bases.map((b) => ({ id: b.id, name: b.name, permissionLevel: "create" })) })
    }
    const base = fake.bases.find((b) => b.id === parts[3])
    if (!base) return airtableError(404, "NOT_FOUND", "Could not find base")
    if (parts[4] === "tables" && parts.length === 5 && req.method === "GET") {
      return json({
        tables: base.tables.map((t) => ({
          id: t.id,
          name: t.name,
          primaryFieldId: t.primaryFieldId,
          fields: t.fields,
          views: [{ id: "viwGRID", name: "Grid view", type: "grid" }],
        })),
      })
    }
    if (parts[4] === "tables" && parts[6] === "fields" && req.method === "POST") {
      if (fake.noSchemaWrite) return airtableError(403, "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND", "Invalid permissions")
      const table = base.tables.find((t) => t.id === parts[5])
      if (!table) return airtableError(404, "NOT_FOUND", "Could not find table")
      const body = req.body as { name?: string; type?: string; options?: unknown }
      if (!body.name || !body.type) return airtableError(422, "INVALID_REQUEST_UNKNOWN", "Invalid request")
      if (table.fields.some((f) => f.name.toLowerCase() === body.name!.toLowerCase())) {
        return airtableError(422, "DUPLICATE_OR_EMPTY_FIELD_NAME", `Field name "${body.name}" already exists`)
      }
      const field = { id: newId("fld"), name: body.name, type: body.type, ...(body.options ? { options: body.options } : {}) }
      table.fields.push(field)
      return json(field)
    }
    return airtableError(404, "NOT_FOUND", "Not found")
  }

  // Records: /v0/{baseId}/{tableIdOrName}
  const table = findTable(fake, parts[1] ?? "", parts[2] ?? "")
  if (!table) return airtableError(404, "NOT_FOUND", "Could not find table")
  const rows = fake.records.get(table.id) ?? []
  fake.records.set(table.id, rows)

  if (req.method === "GET") {
    const pageSize = Math.min(100, Number(req.query.get("pageSize") ?? 100))
    const start = Number(req.query.get("offset") ?? 0)
    const wanted = req.query.getAll("fields[]")
    const page = rows.slice(start, start + pageSize).map((r) => ({
      id: r.id,
      createdTime: "2026-10-15T00:00:00.000Z",
      fields: Object.fromEntries(
        Object.entries(r.fields).filter(([id, v]) => v != null && (wanted.length === 0 || wanted.includes(id))),
      ),
    }))
    const next = start + pageSize < rows.length ? String(start + pageSize) : undefined
    return json({ records: page, ...(next ? { offset: next } : {}) })
  }

  const body = req.body as {
    records?: Array<{ id?: string; fields: Record<string, unknown> }>
    performUpsert?: { fieldsToMergeOn: string[] }
  }
  const incoming = body.records ?? []
  if (incoming.length > 10) {
    return airtableError(422, "INVALID_RECORDS", "You may only create or update up to 10 records per request")
  }
  const resolved: Array<{ id?: string; fields: Record<string, unknown> }> = []
  for (const r of incoming) {
    const fields = resolveFields(table, r.fields ?? {})
    if (typeof fields === "string") return airtableError(422, "UNKNOWN_FIELD_NAME", `Unknown field name: "${fields}"`)
    resolved.push({ id: r.id, fields })
  }

  if (req.method === "POST") {
    const made = resolved.map((r) => ({ id: newId("rec"), fields: r.fields }))
    rows.push(...made)
    return json({ records: made.map((r) => ({ ...r, createdTime: "2026-10-15T00:00:00.000Z" })) })
  }

  if (req.method === "PATCH") {
    const merge = body.performUpsert?.fieldsToMergeOn?.map((key) => table.fields.find((f) => f.id === key || f.name === key)?.id)
    if (merge && merge.some((id) => !id)) return airtableError(422, "INVALID_FIELD_TO_MERGE_ON", "Unknown merge field")
    const out: FakeRecord[] = []
    const created: string[] = []
    const updated: string[] = []
    for (const r of resolved) {
      let target = r.id ? rows.find((row) => row.id === r.id) : undefined
      if (r.id && !target) return airtableError(404, "NOT_FOUND", `Record ${r.id} not found`)
      if (!target && merge) {
        target = rows.find((row) => merge.every((id) => String(row.fields[id!] ?? "") === String(r.fields[id!] ?? "")))
      }
      if (target) {
        Object.assign(target.fields, r.fields)
        updated.push(target.id)
        out.push(target)
      } else if (merge) {
        const made = { id: newId("rec"), fields: { ...r.fields } }
        rows.push(made)
        created.push(made.id)
        out.push(made)
      } else {
        return airtableError(422, "INVALID_RECORDS", "Record id required")
      }
    }
    return json({
      records: out.map((r) => ({ id: r.id, createdTime: "2026-10-15T00:00:00.000Z", fields: r.fields })),
      ...(merge ? { createdRecords: created, updatedRecords: updated } : {}),
    })
  }
  return airtableError(404, "NOT_FOUND", "Not found")
}
