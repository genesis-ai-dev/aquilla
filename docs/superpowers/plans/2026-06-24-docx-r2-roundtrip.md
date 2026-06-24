# DOCX R2 Round-Trip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store the original uploaded `.docx` in R2 (no size cap) and, on export, reinsert the *translator's* content as runs back into the original document in place — preserving the original's structure and honoring the translator's own inline formatting.

**Architecture:** The original bytes move from a base64 Postgres TEXT column to the `SNAPSHOTS` R2 bucket, uploaded via a new authenticated `PUT …/files/{fileId}/source` endpoint at import time. `file_source_blobs` becomes a pointer row (`r2_key`). Export streams bytes from R2 (legacy `raw_source` as fallback). The client-side DOCX exporter is rewritten to build runs from each cell's `translatedHtml` and to anchor each translation to its original paragraph via a persisted `source_location.blockPath`.

**Tech Stack:** Cloudflare Workers (sync-worker), R2, Neon Postgres (via Hyperdrive shim), React/TypeScript client, JSZip + DOMParser (client-side), Vitest (happy-dom).

## Global Constraints

- Worker must not gain a new heavy ZIP dependency — DOCX injection stays **client-side** (JSZip already bundled). Server only streams raw bytes.
- R2 bucket binding for app-owned blobs is `SNAPSHOTS` (`aquilla-snapshots` / `-dev` / `-staging`). The read-only `LFS_SRC` bucket is off-limits for writes.
- R2 key convention mirrors audio: `${r2KeyPrefix(env)}projects/{projectId}/files/{fileId}/source/original.{ext}`.
- DB is Neon Postgres. Every schema change needs a numbered migration in `auth-worker/migrations/` AND an update to `db/postgres/schema.sql` AND application to live Neon via `pnpm neon:apply`. (Per the D1→Neon drift history, a migration in the file tree that was never applied to live Neon is the #1 cause of post-cutover 500s.)
- Contract: translator's inline styling wins; source inline emphasis is NOT copied onto translated text. Untranslated units are byte-for-byte untouched.
- Commit format: imperative subject; the repo's pre-commit hook warns when no `FRO-###` is present — include the ticket if one exists, otherwise proceed (warning is non-fatal).

---

## File Structure

**Schema**
- `auth-worker/migrations/0035_docx_r2_roundtrip.sql` (create) — `file_source_blobs` pointer columns + `cells.source_location`.
- `db/postgres/schema.sql` (modify) — mirror the migration.

**Server (sync-worker)**
- `sync-worker/src/events/source-upload-route.ts` (create) — `PUT …/files/{fileId}/source` → R2 + pointer row.
- `sync-worker/src/events/export-route.ts` (modify) — read from R2 when `r2_key` present, fall back to `raw_source`.
- `sync-worker/src/index.ts` (modify) — register the upload route.
- `sync-worker/src/events/import-route.ts` (modify) — stop requiring `rawSource`; persist `source_location` per cell.
- `sync-worker/src/events/cells-read-route.ts` (modify) — SELECT + emit `source_location`.

**Client**
- `src/lib/import.ts` (modify) — remove the 512 KB cap; keep raw bytes for upload.
- `src/lib/sync/bulk-import.ts` (modify) — upload original to R2 endpoint instead of bundling `rawSource`; carry `blockPath` on cell payloads.
- `src/lib/sync/source-upload.ts` (create) — `uploadSourceOriginal()` client helper.
- `src/lib/export/exporters/docx.ts` (modify) — run-level reinsertion from `translatedHtml`, blockPath matching.
- `src/lib/export/exporters/docx-runs.ts` (create) — pure `htmlToSpans()` + `spansToRuns()` helpers (unit-testable without a DOM document).
- `src/hooks/useCells.ts` (modify) — map `source_location` into `CellData`.

---

## Task 1: Schema — pointer columns + cell source_location

**Files:**
- Create: `auth-worker/migrations/0035_docx_r2_roundtrip.sql`
- Modify: `db/postgres/schema.sql:406-412` (the `file_source_blobs` table) and the `cells` table definition.

**Interfaces:**
- Produces: `file_source_blobs.r2_key TEXT`, `file_source_blobs.size_bytes BIGINT`, `file_source_blobs.raw_source` made nullable; `cells.source_location TEXT` (JSON string).

- [ ] **Step 1: Write the migration**

Create `auth-worker/migrations/0035_docx_r2_roundtrip.sql`:

```sql
-- DOCX R2 round-trip: file_source_blobs becomes a pointer; cells gain a
-- stable source paragraph anchor for in-place reinsertion.
ALTER TABLE file_source_blobs ADD COLUMN IF NOT EXISTS r2_key TEXT;
ALTER TABLE file_source_blobs ADD COLUMN IF NOT EXISTS size_bytes BIGINT;
ALTER TABLE file_source_blobs ALTER COLUMN raw_source DROP NOT NULL;

ALTER TABLE cells ADD COLUMN IF NOT EXISTS source_location TEXT;
```

- [ ] **Step 2: Mirror in schema.sql**

In `db/postgres/schema.sql`, update the `file_source_blobs` definition so `raw_source TEXT` is nullable and add `r2_key TEXT` and `size_bytes BIGINT`; add `source_location TEXT` to the `cells` table. Keep column ordering consistent with surrounding style.

- [ ] **Step 3: Check migration status**

Run: `pnpm neon:status`
Expected: lists `0035_docx_r2_roundtrip` as pending.

- [ ] **Step 4: Apply to live Neon**

Run: `pnpm neon:apply`
Expected: `0035_docx_r2_roundtrip` applied; re-running `pnpm neon:check` reports no drift between `schema.sql` and live Neon.

- [ ] **Step 5: Commit**

```bash
git add auth-worker/migrations/0035_docx_r2_roundtrip.sql db/postgres/schema.sql
git commit -m "feat(db): docx round-trip pointer columns + cell source_location (0035)"
```

---

## Task 2: Server — source upload endpoint (PUT → R2)

**Files:**
- Create: `sync-worker/src/events/source-upload-route.ts`
- Modify: `sync-worker/src/index.ts:39,272` (import + register)
- Test: `sync-worker/src/__tests__/source-upload-route.test.ts`

**Interfaces:**
- Consumes: `env.SNAPSHOTS: R2Bucket`, `env.AQUILLA_PG`, `r2KeyPrefix(env)` from `../audio`, `withCors` from `../cors`, the auth pattern in `export-route.ts:55-72`.
- Produces: `handleSourceUploadRequest(request, env): Promise<Response | null>`. On `PUT /api/v1/projects/{projectId}/files/{fileId}/source` with a binary body and `X-Source-Format: docx|pptx`, streams the body into R2 at `sourceObjectKey(env, projectId, fileId, format)` and upserts the `file_source_blobs` pointer row (`r2_key`, `size_bytes`, `format`, `raw_source = NULL`). Returns 200 `{ ok: true, key }`. Returns `null` when the path/method doesn't match so the router falls through.
- Produces: `sourceObjectKey(env, projectId, fileId, format): string` exported from this file.

- [ ] **Step 1: Write the failing test**

Create `sync-worker/src/__tests__/source-upload-route.test.ts`. Use the existing stub-bucket + stub-PG helpers used in `admin.test.ts` / `cells-read.test.ts` as the model for `env`.

```ts
import { describe, it, expect } from "vitest"
import { handleSourceUploadRequest, sourceObjectKey } from "../events/source-upload-route"
import { makeStubBucket, makeStubEnv } from "./helpers" // mirror existing test helpers

describe("source upload route", () => {
  it("PUTs docx bytes into SNAPSHOTS and writes a pointer row", async () => {
    const env = makeStubEnv({ SNAPSHOTS: makeStubBucket() })
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]) // PK zip magic
    const req = new Request(
      "https://x/api/v1/projects/p1/files/f1/source",
      { method: "PUT", headers: { Authorization: "Bearer test", "X-Source-Format": "docx" }, body: bytes },
    )
    const res = await handleSourceUploadRequest(req, env)
    expect(res?.status).toBe(200)
    const key = sourceObjectKey(env, "p1", "f1", "docx")
    expect(env.SNAPSHOTS._allKeys()).toContain(key)
    const row = await env.AQUILLA_PG
      .prepare("SELECT r2_key, raw_source FROM file_source_blobs WHERE file_id = ?")
      .bind("f1").first()
    expect(row.r2_key).toBe(key)
    expect(row.raw_source).toBeNull()
  })

  it("returns null for non-matching path", async () => {
    const env = makeStubEnv({})
    const res = await handleSourceUploadRequest(
      new Request("https://x/api/v1/other", { method: "PUT" }), env)
    expect(res).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter sync-worker vitest run src/__tests__/source-upload-route.test.ts`
Expected: FAIL — module `../events/source-upload-route` not found.

- [ ] **Step 3: Implement the route**

Create `sync-worker/src/events/source-upload-route.ts`:

```ts
import { withCors } from "../cors"
import { r2KeyPrefix, type AudioEnv } from "../audio"

const PATH_RE =
  /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/source$/

export interface SourceUploadEnv extends Pick<AudioEnv, "R2_KEY_PREFIX"> {
  SNAPSHOTS: R2Bucket
  AQUILLA_PG: D1Database
  SYNC_SECRET_KEY?: string
}

export function sourceObjectKey(
  env: Pick<AudioEnv, "R2_KEY_PREFIX">,
  projectId: string,
  fileId: string,
  format: string,
): string {
  const ext = format === "pptx" ? "pptx" : "docx"
  return `${r2KeyPrefix(env)}projects/${projectId}/files/${fileId}/source/original.${ext}`
}

export async function handleSourceUploadRequest(
  request: Request,
  env: SourceUploadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = PATH_RE.exec(url.pathname)
  if (!match) return null
  if (request.method !== "PUT") return null // GET handled by export-route

  // Mirror the auth + role check in export-route.ts:55-72. Require an
  // authenticated project member with write/import rights (contributor floor).
  // (Copy the token-decode + project-role lookup verbatim from export-route.)
  // ...auth block here...

  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])
  const format = request.headers.get("X-Source-Format") === "pptx" ? "pptx" : "docx"

  const body = await request.arrayBuffer()
  if (body.byteLength === 0) {
    return withCors(new Response("empty body", { status: 400 }), request)
  }
  const key = sourceObjectKey(env, projectId, fileId, format)
  const contentType = format === "pptx"
    ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  await env.SNAPSHOTS.put(key, body, { httpMetadata: { contentType } })

  await env.AQUILLA_PG
    .prepare(
      `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, size_bytes, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(file_id) DO UPDATE SET
         project_id = excluded.project_id,
         format     = excluded.format,
         raw_source = NULL,
         r2_key     = excluded.r2_key,
         size_bytes = excluded.size_bytes,
         created_at = excluded.created_at`,
    )
    .bind(fileId, projectId, format, key, body.byteLength, Date.now())
    .run()

  return withCors(
    new Response(JSON.stringify({ ok: true, key }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }),
    request,
  )
}
```

Then register in `sync-worker/src/index.ts`: add `import { handleSourceUploadRequest } from "./events/source-upload-route"` near line 39, and near line 272 (before or after the export-source dispatch) add:

```ts
const sourceUploadResponse = await handleSourceUploadRequest(request, env)
if (sourceUploadResponse) return sourceUploadResponse
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter sync-worker vitest run src/__tests__/source-upload-route.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add sync-worker/src/events/source-upload-route.ts sync-worker/src/index.ts sync-worker/src/__tests__/source-upload-route.test.ts
git commit -m "feat(sync): PUT files/:id/source uploads original docx to R2"
```

---

## Task 3: Server — export route reads R2 with raw_source fallback

**Files:**
- Modify: `sync-worker/src/events/export-route.ts:74-143`
- Test: `sync-worker/src/__tests__/export-route-r2.test.ts`

**Interfaces:**
- Consumes: `file_source_blobs` row now may have `r2_key` (R2) OR `raw_source` (legacy base64). `env.SNAPSHOTS`.
- Produces: same response shape and `X-Export-Mode: raw-sidecar` header as today; bytes come from R2 when `r2_key` is set, else from decoding `raw_source`.

- [ ] **Step 1: Write the failing test**

Create `sync-worker/src/__tests__/export-route-r2.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { handleExportSourceRequest } from "../events/export-route"
import { sourceObjectKey } from "../events/source-upload-route"
import { makeStubBucket, makeStubEnv } from "./helpers"

it("serves docx bytes from R2 when r2_key is present", async () => {
  const env = makeStubEnv({ SNAPSHOTS: makeStubBucket() })
  const key = sourceObjectKey(env, "p1", "f1", "docx")
  env.SNAPSHOTS._seed(key, new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
  await env.AQUILLA_PG.prepare(
    "INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, created_at) VALUES (?,?,?,NULL,?,?)",
  ).bind("f1", "p1", "docx", key, Date.now()).run()
  await env.AQUILLA_PG.prepare("INSERT INTO files (id, project_id, name) VALUES (?,?,?)")
    .bind("f1", "p1", "doc.docx").run()

  const req = new Request("https://x/api/v1/projects/p1/files/f1/source",
    { method: "GET", headers: { Authorization: "Bearer test" } })
  const res = await handleExportSourceRequest(req, env)
  expect(res?.status).toBe(200)
  expect(res?.headers.get("X-Export-Mode")).toBe("raw-sidecar")
  const buf = new Uint8Array(await res!.arrayBuffer())
  expect(Array.from(buf.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
})

it("falls back to legacy raw_source when r2_key is null", async () => {
  const env = makeStubEnv({ SNAPSHOTS: makeStubBucket() })
  await env.AQUILLA_PG.prepare(
    "INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, created_at) VALUES (?,?,?,?,NULL,?)",
  ).bind("f1", "p1", "docx", btoa("PK"), Date.now()).run()
  await env.AQUILLA_PG.prepare("INSERT INTO files (id, project_id, name) VALUES (?,?,?)")
    .bind("f1", "p1", "doc.docx").run()
  const res = await handleExportSourceRequest(
    new Request("https://x/api/v1/projects/p1/files/f1/source",
      { method: "GET", headers: { Authorization: "Bearer test" } }), env)
  expect(res?.status).toBe(200)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter sync-worker vitest run src/__tests__/export-route-r2.test.ts`
Expected: FAIL — R2 branch not implemented (current code only reads `raw_source`).

- [ ] **Step 3: Implement the R2 read branch**

In `export-route.ts`, change the SELECT (line ~76) to also fetch `r2_key`, and in the `docx`/`pptx` branch (line ~98) prefer R2:

```ts
const blob = await db.prepare(
  `SELECT format, raw_source, r2_key FROM file_source_blobs WHERE file_id = ? AND project_id = ?`,
).bind(fileId, projectId).first<{ format: string; raw_source: string | null; r2_key: string | null }>()
```

Then, before the base64-decode path, add:

```ts
let binary: Uint8Array
if (blob.r2_key) {
  const obj = await env.SNAPSHOTS.get(blob.r2_key)
  if (!obj) {
    return withCors(new Response("source bytes missing from storage — re-import", { status: 404 }), request)
  }
  binary = new Uint8Array(await obj.arrayBuffer())
} else if (blob.raw_source) {
  // existing base64-decode block (lines 117-128) populates `binary`
} else {
  return withCors(new Response("no source bytes recorded — re-import to enable export", { status: 404 }), request)
}
```

Add `SNAPSHOTS: R2Bucket` to `ExportRouteEnv`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter sync-worker vitest run src/__tests__/export-route-r2.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add sync-worker/src/events/export-route.ts sync-worker/src/__tests__/export-route-r2.test.ts
git commit -m "feat(sync): export source reads from R2 with raw_source fallback"
```

---

## Task 4: Client — upload original to R2 on import; remove the 512 KB cap

**Files:**
- Create: `src/lib/sync/source-upload.ts`
- Modify: `src/lib/import.ts:1389-1409` (drop the cap; keep raw bytes), `src/lib/sync/bulk-import.ts:70-117` (upload instead of bundling `rawSource`)
- Test: `src/lib/sync/source-upload.test.ts`

**Interfaces:**
- Produces: `uploadSourceOriginal({ projectId, fileId, bytes, format, getToken }): Promise<void>` — `PUT`s `bytes` (ArrayBuffer) to `…/files/{fileId}/source` with `X-Source-Format` and Bearer auth. Throws on non-2xx.
- Consumes (changed): the parser now returns the raw bytes for upload rather than a base64 `rawSource` capped at 512 KB. `ParsedFile` keeps an optional `rawBytes?: ArrayBuffer` + `rawSourceFormat?: string`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/sync/source-upload.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest"
import { uploadSourceOriginal } from "./source-upload"

it("PUTs bytes to the source endpoint with format + auth headers", async () => {
  const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
  await uploadSourceOriginal({
    projectId: "p1", fileId: "f1",
    bytes: new Uint8Array([1, 2, 3]).buffer, format: "docx",
    getToken: async () => "tok", fetchFn,
    baseUrl: "https://sync.test",
  })
  expect(fetchFn).toHaveBeenCalledOnce()
  const [url, init] = fetchFn.mock.calls[0]
  expect(url).toBe("https://sync.test/api/v1/projects/p1/files/f1/source")
  expect(init.method).toBe("PUT")
  expect(init.headers["X-Source-Format"]).toBe("docx")
  expect(init.headers.Authorization).toBe("Bearer tok")
})

it("throws on non-2xx", async () => {
  const fetchFn = vi.fn().mockResolvedValue(new Response("nope", { status: 403 }))
  await expect(uploadSourceOriginal({
    projectId: "p1", fileId: "f1", bytes: new ArrayBuffer(3), format: "docx",
    getToken: async () => "tok", fetchFn, baseUrl: "https://sync.test",
  })).rejects.toThrow(/403/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/lib/sync/source-upload.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `uploadSourceOriginal`**

Create `src/lib/sync/source-upload.ts`:

```ts
import { syncWorkerHttpOrigin } from "./source-export" // reuse existing origin resolver

export interface UploadSourceArgs {
  projectId: string
  fileId: string
  bytes: ArrayBuffer
  format: "docx" | "pptx"
  getToken: (fileId: string) => Promise<string | null>
  fetchFn?: typeof fetch
  baseUrl?: string
}

export async function uploadSourceOriginal(args: UploadSourceArgs): Promise<void> {
  const token = await args.getToken(args.fileId)
  if (!token) throw new Error("Couldn't get an upload token — sign in and try again.")
  const origin = args.baseUrl ?? syncWorkerHttpOrigin()
  const url = `${origin}/api/v1/projects/${encodeURIComponent(args.projectId)}/files/${encodeURIComponent(args.fileId)}/source`
  const fetchFn = args.fetchFn ?? fetch
  const res = await fetchFn(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "X-Source-Format": args.format },
    body: args.bytes,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(detail || `Source upload failed (HTTP ${res.status})`)
  }
}
```

- [ ] **Step 4: Remove the cap in the parser**

In `src/lib/import.ts`, replace the docx/pptx cap logic (lines 1396-1399 / 1405-1408) so the parsed file carries the raw bytes for upload and no longer base64-encodes or caps:

```ts
case "docx": {
  const buffer = await file.arrayBuffer()
  const strings = await extractDocxStrings(buffer)
  return [{ name: file.name, strings, rawBytes: buffer, rawSourceFormat: "docx" }]
}
```

Apply the same shape to the `pptx` case. Add `rawBytes?: ArrayBuffer` to the `ParsedFile` type and remove `rawSource` from it. (Keep `arrayBufferToBase64` only if still used elsewhere; otherwise delete the now-dead import.)

- [ ] **Step 5: Wire the upload into bulk-import**

In `src/lib/sync/bulk-import.ts`, remove the `rawSource`/`rawSourceFormat` bundling (lines 115-118) from the payload. After the first chunk that carries `file` succeeds, call `uploadSourceOriginal` when raw bytes are present:

```ts
if (first && args.rawBytes && args.rawSourceFormat) {
  await uploadSourceOriginal({
    projectId: args.projectId, fileId: args.fileId,
    bytes: args.rawBytes, format: args.rawSourceFormat as "docx" | "pptx",
    getToken: args.getToken,
  })
}
```

Update the `bulk-import` args type: replace `rawSource?: string` with `rawBytes?: ArrayBuffer`; keep `rawSourceFormat?`.

- [ ] **Step 6: Run client tests**

Run: `pnpm vitest run src/lib/sync/source-upload.test.ts src/lib/import.test.ts`
Expected: PASS. Fix any `import.test.ts` expectations that asserted on the old base64 `rawSource` field.

- [ ] **Step 7: Commit**

```bash
git add src/lib/sync/source-upload.ts src/lib/sync/source-upload.test.ts src/lib/import.ts src/lib/sync/bulk-import.ts
git commit -m "feat(import): upload original docx to R2, drop 512KB sidecar cap"
```

---

## Task 5: Persist `source_location` (blockPath) through the pipeline

**Files:**
- Modify: `src/lib/import.ts` (carry `blockPath` onto each cell payload), `src/lib/sync/bulk-import.ts` (include it in the cell object — it already passes `args.cells` through), `sync-worker/src/events/import-route.ts` (write `source_location` in the `source.cell.create` projection), `sync-worker/src/events/cells-read-route.ts` (SELECT + emit), `src/hooks/useCells.ts` (map into `CellData.sourceLocation`)
- Test: `sync-worker/src/__tests__/cells-read.test.ts` (extend), `src/hooks/useCells.test.ts` (extend if present)

**Interfaces:**
- Produces: `CellData.sourceLocation?: { file: string; blockPath: string }` is populated on read for docx-imported cells. The wire field is `source_location` (a JSON string column on `cells`).
- Consumes: the parser already computes `sourceLocation.blockPath = "w:p[N]"` in `src/lib/parsers/docx.ts:22-25`.

- [ ] **Step 1: Write the failing read test**

In `sync-worker/src/__tests__/cells-read.test.ts`, add a case: seed a cell whose projection row has `source_location = '{"file":"word/document.xml","blockPath":"w:p[3]"}'`, read it back via the cells-read route, and assert the emitted cell carries `sourceLocation.blockPath === "w:p[3]"`. (Follow the existing seed+read helpers in that file.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter sync-worker vitest run src/__tests__/cells-read.test.ts`
Expected: FAIL — `sourceLocation` is undefined on the read cell.

- [ ] **Step 3: Thread `blockPath` onto the client cell payload**

In `src/lib/import.ts`, where each `TranslatableString` is turned into a cell object sent to `bulk-import`, include `sourceLocation: s.sourceLocation` (the parser already attaches it). Confirm `bulk-import` forwards the cell object verbatim in `payload.cells` (it does — `chunk = args.cells.slice(...)`).

- [ ] **Step 4: Persist in the projection**

In `sync-worker/src/events/import-route.ts`, in the `source.cell.create` loop (around line 224-227), serialize and store `source_location`: add it to the cell projection INSERT/UPSERT column list as `JSON.stringify(cell.sourceLocation ?? null)` (store `NULL` when absent). Mirror the exact INSERT used for the cell row's other optional fields.

- [ ] **Step 5: Emit on read**

In `sync-worker/src/events/cells-read-route.ts`, add `source_location` to the cell SELECT and parse it back into `sourceLocation` on the emitted cell object (`JSON.parse` when non-null).

- [ ] **Step 6: Map into CellData**

In `src/hooks/useCells.ts` `buildCellData`, set `sourceLocation: serverCell.sourceLocation` so it reaches `CellData` (the field already exists at line 82).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter sync-worker vitest run src/__tests__/cells-read.test.ts && pnpm vitest run src/hooks/useCells.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/import.ts sync-worker/src/events/import-route.ts sync-worker/src/events/cells-read-route.ts src/hooks/useCells.ts sync-worker/src/__tests__/cells-read.test.ts
git commit -m "feat(sync): persist cell source_location (blockPath) through projection"
```

---

## Task 6: Pure run-building helpers — `htmlToSpans` + `spansToRuns`

**Files:**
- Create: `src/lib/export/exporters/docx-runs.ts`
- Test: `src/lib/export/exporters/docx-runs.test.ts`

**Interfaces:**
- Produces:
  - `type Mark = "b" | "i" | "u" | "s" | "code"`
  - `interface Span { text: string; marks: Set<Mark> }`
  - `htmlToSpans(html: string): Span[]` — flattens inline HTML (`<b>/<strong>`, `<i>/<em>`, `<u>`, `<s>/<strike>/<del>`, `<code>`) into ordered spans; plain text → a single markless span; empty/whitespace-only → `[]`.
  - `spansToRuns(doc: Document, spans: Span[], baseRpr: Element | null): Element[]` — one `<w:r>` per span. Each run clones `baseRpr` (font/size base) and appends the span's mark toggles (`<w:b/>`, `<w:i/>`, `<w:u w:val="single"/>`, `<w:strike/>`, `<w:rStyle w:val="..."/>` is NOT used — `code` maps to no toggle for now and is treated as plain). Text node uses `xml:space="preserve"`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/export/exporters/docx-runs.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { htmlToSpans, spansToRuns } from "./docx-runs"

describe("htmlToSpans", () => {
  it("plain text → one markless span", () => {
    expect(htmlToSpans("hello world")).toEqual([{ text: "hello world", marks: new Set() }])
  })
  it("bold word → three spans, middle bold", () => {
    const spans = htmlToSpans("the <strong>Lord</strong> said")
    expect(spans.map(s => s.text)).toEqual(["the ", "Lord", " said"])
    expect([...spans[1].marks]).toEqual(["b"])
    expect(spans[0].marks.size).toBe(0)
  })
  it("nested italic+bold → both marks", () => {
    const spans = htmlToSpans("<em><strong>x</strong></em>")
    expect([...spans[0].marks].sort()).toEqual(["b", "i"])
  })
  it("empty/whitespace → []", () => {
    expect(htmlToSpans("")).toEqual([])
    expect(htmlToSpans("   ")).toEqual([])
  })
})

describe("spansToRuns", () => {
  it("emits one w:r per span with bold toggle", () => {
    const doc = new DOMParser().parseFromString("<root/>", "application/xml")
    const runs = spansToRuns(doc, htmlToSpans("a <b>b</b>"), null)
    expect(runs.length).toBe(2)
    expect(runs[1].getElementsByTagName("w:b").length).toBe(1)
    expect(runs[0].getElementsByTagName("w:b").length).toBe(0)
    expect(runs[1].getElementsByTagName("w:t")[0].textContent).toBe("b")
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/lib/export/exporters/docx-runs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

Create `src/lib/export/exporters/docx-runs.ts`:

```ts
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
export type Mark = "b" | "i" | "u" | "s" | "code"
export interface Span { text: string; marks: Set<Mark> }

const TAG_TO_MARK: Record<string, Mark> = {
  b: "b", strong: "b", i: "i", em: "i", u: "u",
  s: "s", strike: "s", del: "s", code: "code",
}

export function htmlToSpans(html: string): Span[] {
  if (!html || !html.trim()) return []
  const doc = new DOMParser().parseFromString(`<root>${html}</root>`, "text/html")
  const root = doc.body.firstChild ?? doc.body
  const spans: Span[] = []
  const walk = (node: Node, marks: Set<Mark>) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? ""
        if (text) spans.push({ text, marks: new Set(marks) })
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = (child as Element).tagName.toLowerCase()
        const mark = TAG_TO_MARK[tag]
        const next = mark ? new Set(marks).add(mark) : marks
        walk(child, next)
      }
    }
  }
  walk(root, new Set())
  // Drop spans that are empty after the walk; keep whitespace-bearing spans.
  return spans.filter(s => s.text.length > 0)
}

export function spansToRuns(doc: Document, spans: Span[], baseRpr: Element | null): Element[] {
  return spans.map(span => {
    const run = doc.createElementNS(W_NS, "w:r")
    const rPr = baseRpr
      ? (baseRpr.cloneNode(true) as Element)
      : doc.createElementNS(W_NS, "w:rPr")
    const addToggle = (name: string, attrs?: Record<string, string>) => {
      const el = doc.createElementNS(W_NS, `w:${name}`)
      if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
      rPr.appendChild(el)
    }
    if (span.marks.has("b")) addToggle("b")
    if (span.marks.has("i")) addToggle("i")
    if (span.marks.has("u")) addToggle("u", { "w:val": "single" })
    if (span.marks.has("s")) addToggle("strike")
    if (rPr.childNodes.length > 0) run.appendChild(rPr)
    const t = doc.createElementNS(W_NS, "w:t")
    t.setAttribute("xml:space", "preserve")
    t.textContent = span.text
    run.appendChild(t)
    return run
  })
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run src/lib/export/exporters/docx-runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/export/exporters/docx-runs.ts src/lib/export/exporters/docx-runs.test.ts
git commit -m "feat(export): pure html->spans->w:r run builders for docx"
```

---

## Task 7: Rewrite `exportDocx` — surgical run-level reinsertion (codex-editor parity)

> **APPROACH (revised after reviewing codex-editor's mature DOCX round-trip):** Do NOT parse `word/document.xml` with `DOMParser` and reserialize the whole document with `XMLSerializer`. codex-editor (`/Users/ryderwishart/frontierrnd/codex-editor`, `webviews/.../importers/docx/docxExporter.ts`) deliberately avoids whole-document reparse/reserialize because it produces blank rendering in Apple Pages, and instead does **surgical string-level replacement** of paragraph content, leaving the rest of the XML byte-for-byte identical. We mirror that: locate each target `<w:p>` in the raw XML string, replace only its run region (keeping `<w:pPr>`), and splice the modified string back. We EXCEED codex-editor by rebuilding the runs from the translator's own `translatedHtml` (codex-editor keeps source-run formatting); the contract is "translator's inline styling wins."
>
> **Matching:** `source_location`/`blockPath` persistence was deferred (Task 5), so matching is POSITIONAL — the Nth non-empty `<w:p>` in document order maps to the Nth unique cell `group` in document order. This is the existing, working behavior.
>
> **Document the alternative:** add a top-of-file doc comment in `docx.ts` recording that a full-DOM-rebuild approach (parse → rebuild → `XMLSerializer`) is possible and simpler to write, but was rejected to preserve byte fidelity and avoid the Apple Pages blank-render bug — and that the Element-based `spansToRuns` is retained in `docx-runs.ts` as the primitive that approach would use.

**Files:**
- Modify: `src/lib/export/exporters/docx-runs.ts` (ADD a string-based `spansToRunXml`; keep `htmlToSpans` and the Element-based `spansToRuns`)
- Modify: `src/lib/export/exporters/docx.ts` (rewrite `exportDocx` + `injectTranslationIntoParagraph` to string-surgical; keep `extractDominantRpr` logic but string-based)
- Test: `src/lib/export/exporters/docx-runs.test.ts` (add `spansToRunXml` cases), `src/lib/export/exporters/docx.test.ts` (extend)

**Interfaces:**
- Consumes: `htmlToSpans` from `./docx-runs`; `CellData.translatedHtml`, `CellData.translated`, `CellData.group`.
- Produces:
  - `spansToRunXml(spans: Span[], baseRprXml: string | null): string` — returns clean OOXML run markup as a STRING (one `<w:r>…</w:r>` per span), with NO `xmlns` pollution (we build strings, not namespaced DOM nodes, precisely to avoid `XMLSerializer` emitting `xmlns:w="…"` on spliced fragments). `baseRprXml` is the verbatim `<w:rPr>…</w:rPr>` string of the paragraph's first text run (or `null`); each run = `<w:r>` + (baseRprXml with the translator's toggles spliced in before `</w:rPr>`, or a fresh `<w:rPr>` when there are toggles but no base, or no rPr at all when neither) + `<w:t xml:space="preserve">{escaped text}</w:t></w:r>`. XML-escape `&<>` in the text.
  - `exportDocx(rawDocxBytes, cells)` — unchanged signature/return (`{ blob, injected, untouched }`). Surgical: only translated paragraphs' run regions change in `word/document.xml`; every other byte (XML declaration, namespaces, untranslated paragraphs, all other zip parts) is identical.

- [ ] **Step 1: Write the failing `spansToRunXml` tests**

Add to `src/lib/export/exporters/docx-runs.test.ts`:

```ts
import { spansToRunXml } from "./docx-runs"

it("builds clean run XML with no xmlns pollution", () => {
  const xml = spansToRunXml(htmlToSpans("a<strong>B</strong>"), null)
  expect(xml).not.toMatch(/xmlns/)                       // critical: no namespace decls in spliced fragment
  expect(xml).toMatch(/<w:r><w:t xml:space="preserve">a<\/w:t><\/w:r>/)
  expect(xml).toMatch(/<w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">B<\/w:t><\/w:r>/)
})

it("splices translator toggles into a cloned baseRpr", () => {
  const xml = spansToRunXml(htmlToSpans("<em>x</em>"), "<w:rPr><w:sz w:val=\"24\"/></w:rPr>")
  // base font size kept AND italic added
  expect(xml).toContain("<w:sz w:val=\"24\"/>")
  expect(xml).toContain("<w:i/>")
})

it("escapes XML special chars in text", () => {
  expect(spansToRunXml(htmlToSpans("a & b < c"), null)).toContain("a &amp; b &lt; c")
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/lib/export/exporters/docx-runs.test.ts`
Expected: FAIL — `spansToRunXml` not exported.

- [ ] **Step 3: Implement `spansToRunXml`**

In `docx-runs.ts` add (reuse the existing `Mark`/`Span`; do NOT remove `spansToRuns`):

```ts
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

const MARK_TO_TAG: Partial<Record<Mark, string>> = {
  b: "<w:b/>", i: "<w:i/>", u: "<w:u w:val=\"single\"/>", s: "<w:strike/>", // code → none
}

export function spansToRunXml(spans: Span[], baseRprXml: string | null): string {
  return spans.map((span) => {
    const toggles = (["b", "i", "u", "s"] as Mark[])
      .filter((m) => span.marks.has(m)).map((m) => MARK_TO_TAG[m]).join("")
    let rPr = ""
    if (baseRprXml) {
      // splice toggles in just before the closing </w:rPr> (or expand a self-closed base)
      rPr = baseRprXml.includes("</w:rPr>")
        ? baseRprXml.replace("</w:rPr>", `${toggles}</w:rPr>`)
        : `<w:rPr>${toggles}</w:rPr>`           // base was <w:rPr/> or empty
    } else if (toggles) {
      rPr = `<w:rPr>${toggles}</w:rPr>`
    }
    return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(span.text)}</w:t></w:r>`
  }).join("")
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run src/lib/export/exporters/docx-runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing `exportDocx` tests**

Extend `src/lib/export/exporters/docx.test.ts`. Reuse the existing in-test `makeDocxFixture`/`readDocumentXml` helpers (or build a minimal zip with JSZip as the existing tests do). NOTE: cells now have NO `sourceLocation` (Task 5 deferred) — matching is positional.

```ts
it("honors the translator's bold, not the source's", async () => {
  const bytes = await makeDocxFixture(["alpha"])           // source paragraph plain "alpha"
  const cells = [{ group: "g0", translated: "aB", translatedHtml: "a<strong>B</strong>" }] as any
  const { blob, injected } = await exportDocx(await bytes.arrayBuffer(), cells)
  expect(injected).toBe(1)
  const xml = await readDocumentXml(blob)
  // "B" run is bold; "a" run is not
  expect(xml).toMatch(/<w:r><w:rPr>(?:(?!<\/w:rPr>).)*<w:b\/>[^]*?<w:t[^>]*>B<\/w:t>/)
  expect(xml).toMatch(/<w:r><w:t xml:space="preserve">a<\/w:t><\/w:r>/)
})

it("leaves untranslated paragraphs byte-identical and preserves non-document parts", async () => {
  const bytes = await makeDocxFixture(["keep me", "translate me"])
  const original = await JSZip.loadAsync(await bytes.arrayBuffer())
  const cells = [
    { group: "g0", translated: "", translatedHtml: "" },        // untranslated
    { group: "g1", translated: "DONE", translatedHtml: "DONE" },
  ] as any
  const { blob, injected, untouched } = await exportDocx(await bytes.arrayBuffer(), cells)
  expect(injected).toBe(1)
  expect(untouched).toBe(1)
  const out = await JSZip.loadAsync(await blob.arrayBuffer())
  const xml = await out.file("word/document.xml")!.async("string")
  expect(xml).toContain("keep me")                              // untranslated text retained
  expect(xml).toContain("DONE")
  // styles.xml (and every non-document.xml part) byte-identical
  for (const name of Object.keys(original.files)) {
    if (name === "word/document.xml" || original.files[name].dir) continue
    expect(await out.file(name)!.async("string")).toBe(await original.file(name)!.async("string"))
  }
})

it("does not change the XML declaration / namespaces of document.xml", async () => {
  const bytes = await makeDocxFixture(["x"])
  const before = await (await JSZip.loadAsync(await bytes.arrayBuffer())).file("word/document.xml")!.async("string")
  const { blob } = await exportDocx(await bytes.arrayBuffer(), [{ group: "g0", translated: "y", translatedHtml: "y" }] as any)
  const after = await (await JSZip.loadAsync(await blob.arrayBuffer())).file("word/document.xml")!.async("string")
  // first 120 chars (decl + <w:document … namespaces>) are identical — we never reserialized the doc
  expect(after.slice(0, 120)).toBe(before.slice(0, 120))
})
```

- [ ] **Step 6: Run to verify they fail**

Run: `pnpm vitest run src/lib/export/exporters/docx.test.ts`
Expected: FAIL — current code uses DOM rebuild / source rPr / plain text.

- [ ] **Step 7: Implement surgical `exportDocx`**

Rewrite `docx.ts` so `exportDocx`:
1. `const zip = await JSZip.loadAsync(rawDocxBytes)` and `let xml = await zip.file("word/document.xml")!.async("string")`.
2. Build the ordered `groups: string[]` and `groupToHtml: Map<string,{html,plain}>` from `cells` in document order (join same-`group` segments with a space; `html` = `translatedHtml ?? ""`, `plain` = `translated`).
3. Scan `xml` for paragraph blocks with a single regex over non-nested `<w:p>`: match BOTH `<w:p\b[^>]*\/>` (self-closing, empty) and `<w:p\b[^>]*>([\s\S]*?)<\/w:p>`. Use a `RegExp` with `g` flag and an `exec` loop so you have each match's index/length. Rebuild the output string by copying the slice before each match, then emitting either the original match (untouched) or a replacement.
4. A paragraph is "non-empty" iff its inner contains a `<w:t…>…</w:t>` with non-whitespace text. Maintain a counter `nonEmptyIdx`; the Nth non-empty paragraph maps to `groups[N]`.
5. For a non-empty paragraph whose mapped group has a non-empty translation:
   - Extract the leading `<w:pPr>…</w:pPr>` (regex `/^[\s]*<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>|^[\s]*<w:pPr\b[^>]*\/>/`) from the inner — keep it verbatim.
   - Extract `baseRprXml`: from the inner AFTER the pPr block, find the first `<w:r\b[^>]*>` and within it the first `<w:rPr>…</w:rPr>` (regex). `null` if none. (This is the first text run's run-properties — NOT the pPr's mark `<w:rPr>`.)
   - `const runsXml = spansToRunXml(htmlToSpans(html) .length ? htmlToSpans(html) : [{text: plain, marks: new Set()}], baseRprXml)`.
   - Replacement = the original `<w:p …>` open tag + `pPrXml` + `runsXml` + `</w:p>`.
   - `injected++`.
6. Non-empty paragraphs with no/empty translation, and all empty paragraphs: emit the original match unchanged; non-empty-but-untranslated → `untouched++`.
7. After the loop append the trailing slice. `zip.file("word/document.xml", rebuilt)`. `const blob = await zip.generateAsync({ type: "blob", mimeType: DOCX_MIME })`. Return `{ blob, injected, untouched }`.
8. Add the top-of-file doc comment described in the APPROACH note (surgical-vs-DOM rationale, Apple Pages, codex-editor reference, `spansToRuns` retained as the DOM-approach primitive).

Keep the existing structure-preservation tests green. If a regex boundary case (self-closing paragraph, paragraph with no runs, nested-looking content) makes the string scan unsafe, STOP and report DONE_WITH_CONCERNS with the specific case rather than shipping a fragile scan.

- [ ] **Step 8: Run to verify they pass**

Run: `pnpm vitest run src/lib/export/exporters/docx.test.ts src/lib/export/exporters/docx-runs.test.ts`
Expected: PASS (all cases incl. existing structure-preservation tests).

- [ ] **Step 9: Commit**

```bash
git add src/lib/export/exporters/docx.ts src/lib/export/exporters/docx-runs.ts src/lib/export/exporters/docx.test.ts src/lib/export/exporters/docx-runs.test.ts
git commit -m "feat(export): surgical in-place run reinsertion (codex-editor parity, translator formatting)"
```

---

## Task 8: End-to-end fidelity test (rich fixture, built in-code)

**Files:**
- Test: `src/lib/export/exporters/docx.roundtrip.test.ts` (create)

**Interfaces:**
- Consumes: `exportDocx`. The fixture is built PROGRAMMATICALLY with JSZip inside the test (a subagent cannot author a real binary Word file). It contains a heading paragraph, a bulleted list (`<w:numPr>`), a 2-cell table (`<w:tbl>`), an embedded image part (`word/media/image1.png`), and a mixed-formatting paragraph — exercising codex-editor's fidelity bar.

This task asserts the codex-editor parity bar: after translating a SUBSET of paragraphs, ONLY those paragraphs change; the table, list, image, and every non-`document.xml` part are byte-identical, and untranslated paragraphs are byte-identical.

- [ ] **Step 1: Write the fixture builder + failing test**

Create `src/lib/export/exporters/docx.roundtrip.test.ts`. Build the fixture in-code so the document.xml has, in order: (1) a heading `<w:p>` ("Title"), (2) two list paragraphs each with `<w:pPr><w:numPr>…</w:numPr></w:pPr>` ("First item"/"Second item"), (3) a `<w:tbl>` with two `<w:tc>` cells each holding a `<w:p>` ("Cell A"/"Cell B"), (4) a mixed-format paragraph with two runs ("the " + bold "LORD"). Include a tiny `word/media/image1.png` (a few bytes) and the minimal `[Content_Types].xml`, `_rels/.rels`, `word/_rels/document.xml.rels`.

```ts
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { exportDocx } from "./docx"

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
function p(inner: string, pPr = "") { return `<w:p>${pPr}${inner}</w:p>` }
function run(text: string, rPr = "") { return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>` }

async function buildRichFixture(): Promise<ArrayBuffer> {
  const body =
    p(run("Title"), "<w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr>") +                 // 1 heading
    p(run("First item"), "<w:pPr><w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"1\"/></w:numPr></w:pPr>") +
    p(run("Second item"), "<w:pPr><w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"1\"/></w:numPr></w:pPr>") +
    `<w:tbl><w:tr><w:tc>${p(run("Cell A"))}</w:tc><w:tc>${p(run("Cell B"))}</w:tc></w:tr></w:tbl>` +
    p(run("the ") + run("LORD", "<w:rPr><w:b/></w:rPr>"))                              // mixed-format
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body}</w:body></w:document>`
  const zip = new JSZip()
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`)
  zip.file("word/media/image1.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  zip.file("word/document.xml", documentXml)
  return zip.generateAsync({ type: "arraybuffer" })
}

it("preserves table/list/image + untranslated paragraphs; honors translator marks", async () => {
  const raw = await buildRichFixture()
  const original = await JSZip.loadAsync(raw)
  const originalXml = await original.file("word/document.xml")!.async("string")

  // Translate ONLY the heading and the mixed-format paragraph (positions 0 and 5 of the
  // non-empty paragraph sequence: heading, item1, item2, cellA, cellB, mixed).
  // Leave list items + table cells untranslated (empty translation).
  const G = (i: number) => ({ group: `g${i}` })
  const cells = [
    { ...G(0), translated: "Titre", translatedHtml: "Titre" },                 // heading
    { ...G(1), translated: "", translatedHtml: "" },                            // list item 1
    { ...G(2), translated: "", translatedHtml: "" },                            // list item 2
    { ...G(3), translated: "", translatedHtml: "" },                            // cell A
    { ...G(4), translated: "", translatedHtml: "" },                            // cell B
    { ...G(5), translated: "le SEIGNEUR", translatedHtml: "le <strong>SEIGNEUR</strong>" }, // mixed
  ] as any

  const { blob, injected } = await exportDocx(raw, cells)
  expect(injected).toBe(2)
  const out = await JSZip.loadAsync(await blob.arrayBuffer())
  const xml = await out.file("word/document.xml")!.async("string")

  // (a) image part byte-identical
  const imgBefore = await original.file("word/media/image1.png")!.async("uint8array")
  const imgAfter = await out.file("word/media/image1.png")!.async("uint8array")
  expect(Array.from(imgAfter)).toEqual(Array.from(imgBefore))
  // (b) every non-document.xml part byte-identical
  for (const name of Object.keys(original.files)) {
    if (name === "word/document.xml" || original.files[name].dir) continue
    expect(await out.file(name)!.async("string")).toBe(await original.file(name)!.async("string"))
  }
  // (c) table + list markup intact, and their text untouched
  expect(xml).toContain("<w:tbl>")
  expect(xml).toContain("<w:numPr>")
  expect(xml).toContain("Cell A"); expect(xml).toContain("Cell B")
  expect(xml).toContain("First item"); expect(xml).toContain("Second item")
  // (d) untranslated list-item paragraph byte-identical (extract from original, assert verbatim)
  const item1 = originalXml.match(/<w:p>(?:(?!<\/w:p>)[\s\S])*First item[\s\S]*?<\/w:p>/)![0]
  expect(xml).toContain(item1)
  // (e) heading translated; XML declaration unchanged (no whole-doc reserialize)
  expect(xml).toContain("Titre")
  expect(xml.slice(0, 60)).toBe(originalXml.slice(0, 60))
  // (f) translator's bold honored on the mixed paragraph; source "the " stays plain
  expect(xml).toMatch(/<w:r><w:rPr>(?:(?!<\/w:rPr>).)*<w:b\/>[^]*?<w:t[^>]*>SEIGNEUR<\/w:t>/)
})
```

- [ ] **Step 2: Run to verify it fails, then passes**

Run: `pnpm vitest run src/lib/export/exporters/docx.roundtrip.test.ts`
If `injected`/assertions reveal a real exporter gap (e.g. table-cell paragraphs shift the positional count), STOP and report it — that is a genuine finding about table handling, not a test bug. Otherwise, once green, proceed.

- [ ] **Step 3: Commit**

```bash
git add src/lib/export/exporters/docx.roundtrip.test.ts
git commit -m "test(export): end-to-end docx round-trip fidelity (table/list/image/marks)"
```

---

## Task 9: Manual verification + build gate

- [ ] **Step 1: Typecheck + build**

Run: `pnpm tsc -b && pnpm build`
Expected: no type errors; client + workers build clean.

- [ ] **Step 2: Worker + client test suites**

Run: `pnpm vitest run && pnpm --filter sync-worker vitest run`
Expected: green.

- [ ] **Step 3: Live smoke (per verify-dev-change skill)**

Using the dev stack: import a >512 KB `.docx` with a heading, a table, and an inline image; translate a few cells (add a bold word in one translation); export; re-open the downloaded file in Word/LibreOffice and confirm: structure intact, image present, untranslated paragraphs unchanged, translator's bold honored, source-only emphasis NOT force-applied to plain translations.

- [ ] **Step 4: Report results** (do not mark complete if any step was skipped — per Rule 12).

---

## Self-Review notes

- **Spec coverage:** Section 1 (storage/transport) → Tasks 1-4. Section 2 (reinsertion + blockPath) → Tasks 5-7. Section 3 testing → Tasks 6-9. PPTX injection remains a non-goal; storage (Tasks 1-4) is format-agnostic so PPTX uploads to R2 for free but its injection is unchanged.
- **Open follow-up (not in this plan):** the slow health-ring (validated cells showing no confidence ring) is tracked separately.
- **Risk:** Task 1's migration must be applied to live Neon (`pnpm neon:apply`) — a file-only migration is the documented top cause of post-cutover 500s. Task 5 reuses the same column-plumbing pattern as existing optional cell fields; the implementer must mirror an existing optional column end-to-end rather than inventing wiring.
