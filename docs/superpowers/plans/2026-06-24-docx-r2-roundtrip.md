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

## Task 7: Rewrite `exportDocx` — run-level reinsertion + blockPath matching

**Files:**
- Modify: `src/lib/export/exporters/docx.ts` (replace `injectTranslationIntoParagraph`, change matching, consume `translatedHtml`)
- Test: `src/lib/export/exporters/docx.test.ts` (extend existing)

**Interfaces:**
- Consumes: `htmlToSpans`, `spansToRuns` from `./docx-runs`; `CellData.translatedHtml`, `CellData.translated`, `CellData.group`, `CellData.sourceLocation?.blockPath`.
- Produces: `exportDocx(rawDocxBytes, cells)` unchanged signature/return (`{ blob, injected, untouched }`), but: (a) each translated paragraph's runs are rebuilt from the translator's `translatedHtml` (fallback to plain `translated` when no html), honoring the translator's marks; (b) paragraph selection prefers `blockPath` (`w:p[N]` → the Nth `w:p` in document order, 1-based) and falls back to positional non-empty matching when no cell carries a `blockPath`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/export/exporters/docx.test.ts` (build a minimal docx zip fixture in-test with JSZip, as the existing tests do):

```ts
it("honors the translator's bold, not the source's", async () => {
  // source paragraph: plain "alpha"; translation html: "a<strong>B</strong>"
  const bytes = await makeDocxFixture(["alpha"]) // helper in this test file
  const cells = [{ group: "g0", translated: "aB", translatedHtml: "a<strong>B</strong>",
                   sourceLocation: { file: "word/document.xml", blockPath: "w:p[1]" } }] as any
  const { blob, injected } = await exportDocx(await bytes.arrayBuffer(), cells)
  expect(injected).toBe(1)
  const xml = await readDocumentXml(blob) // helper
  expect(xml).toMatch(/<w:r>(?:(?!<\/w:r>).)*<w:b\/?>[^]*?<w:t[^>]*>B<\/w:t>/)
  // the "a" run must NOT be bold
})

it("leaves untranslated paragraphs byte-identical", async () => {
  const bytes = await makeDocxFixture(["keep me", "translate me"])
  const cells = [
    { group: "g0", translated: "", translatedHtml: "", sourceLocation: { file: "word/document.xml", blockPath: "w:p[1]" } },
    { group: "g1", translated: "DONE", translatedHtml: "DONE", sourceLocation: { file: "word/document.xml", blockPath: "w:p[2]" } },
  ] as any
  const { injected, untouched } = await exportDocx(await bytes.arrayBuffer(), cells)
  expect(injected).toBe(1)
  expect(untouched).toBe(1)
  // assert paragraph 1 still contains "keep me"
})

it("matches by blockPath when present", async () => {
  // A doc whose w:p[2] is the only translated target; positional index would
  // also pick para 0 first — blockPath forces the right paragraph.
  // ...assert the translation landed on w:p[2], not w:p[1].
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/lib/export/exporters/docx.test.ts`
Expected: FAIL — current code uses source rPr / plain text / positional only.

- [ ] **Step 3: Implement run-level injection**

In `docx.ts`, replace `injectTranslationIntoParagraph(p, text)` with one that takes the cell's html:

```ts
import { htmlToSpans, spansToRuns } from "./docx-runs"

function injectTranslationIntoParagraph(p: Element, html: string, plain: string): void {
  const doc = p.ownerDocument!
  const baseRpr = extractDominantRpr(p) // keep: font/size base only
  // Remove every child except <w:pPr>.
  for (const el of Array.from(p.childNodes)) {
    if (el.nodeType === Node.ELEMENT_NODE) {
      const ln = (el as Element).localName || (el as Element).tagName.replace(/^.*:/, "")
      if (ln !== "pPr") (el as Element).remove()
    }
  }
  const spans = htmlToSpans(html) 
  const finalSpans = spans.length > 0 ? spans : [{ text: plain, marks: new Set<never>() }]
  for (const run of spansToRuns(doc, finalSpans as any, baseRpr)) p.appendChild(run)
}
```

- [ ] **Step 4: Change matching to prefer blockPath**

In `exportDocx`, build a `blockPath → { html, plain }` map from cells (joining same-`group` segments with a space, using `translatedHtml` when present else `translated`). If any cell has a `sourceLocation.blockPath`, resolve targets by indexing `paragraphs` (the full `w:p` list, 1-based `w:p[N]`); otherwise keep the existing positional non-empty matching. For each resolved paragraph with a non-empty translation, call the new `injectTranslationIntoParagraph(p, html, plain)`; count `injected`/`untouched` as before. Empty translations leave the paragraph untouched.

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm vitest run src/lib/export/exporters/docx.test.ts`
Expected: PASS (all cases, including the existing structure-preservation tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/export/exporters/docx.ts src/lib/export/exporters/docx.test.ts
git commit -m "feat(export): reinsert translator runs in-place, match by blockPath"
```

---

## Task 8: End-to-end fidelity test + over-cap test

**Files:**
- Test: `src/lib/export/exporters/docx.roundtrip.test.ts` (create)

**Interfaces:**
- Consumes: `exportDocx` + a realistic fixture `.docx` checked into `src/lib/export/exporters/__fixtures__/` containing a heading, a bulleted list, a table, an embedded image, and a mixed-bold paragraph.

- [ ] **Step 1: Add the fixture**

Create `src/lib/export/exporters/__fixtures__/roundtrip.docx` (a small real Word doc with: H1 heading, 2-item bullet list, 1 table with 2 cells, 1 inline PNG, and a paragraph "the **LORD** said"). Document its structure in a sibling `roundtrip.fixture.md`.

- [ ] **Step 2: Write the fidelity test**

```ts
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { readFileSync } from "node:fs"
import { exportDocx } from "./docx"

const raw = readFileSync(new URL("./__fixtures__/roundtrip.docx", import.meta.url))

it("preserves structure, image, and untranslated content; honors translator marks", async () => {
  const cells = [/* translate only the heading + mixed-bold paragraph; leave the list untranslated */] as any
  const { blob } = await exportDocx(raw.buffer, cells)
  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  // (a) image part still present
  expect(Object.keys(zip.files).some(k => /^word\/media\//.test(k))).toBe(true)
  const xml = await zip.file("word/document.xml")!.async("string")
  // (b) table + list markup survives
  expect(xml).toContain("<w:tbl>")
  expect(xml).toContain("<w:numPr>")
  // (c) untranslated list items unchanged (assert original text still there)
  // (d) translated heading carries translator text
})
```

- [ ] **Step 3: Run it**

Run: `pnpm vitest run src/lib/export/exporters/docx.roundtrip.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/export/exporters/__fixtures__ src/lib/export/exporters/docx.roundtrip.test.ts
git commit -m "test(export): end-to-end docx round-trip fidelity fixture"
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
