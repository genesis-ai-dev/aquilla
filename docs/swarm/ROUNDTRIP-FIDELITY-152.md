# Round-trip fidelity — design notes (FRO-152 / FRO-156)

## Storage architecture

Original imported blobs (DOCX, PPTX) are stored in the `SNAPSHOTS` R2 bucket,
NOT in a D1 TEXT column.  The `files.r2_key` column (migration 0008) holds the
R2 object key; it is written by the `file.create` event projection.

**R2 key layout:**
```
{R2_KEY_PREFIX}/projects/{projectId}/files/{fileId}/source
```

**Endpoint:** `PUT /source-blob/:projectId/:fileId` on the sync-worker.
- Auth: sync-token JWT scoped to `(projectId, fileId)`, same as bulk import.
- Returns `{ ok, r2Key, bytes }`.
- `GET /source-blob/:projectId/:fileId` retrieves the blob for future re-parse.

## Import flow for DOCX / PPTX

1. Client parses the file → produces `TranslatableString[]`.
2. Client PUTs raw bytes to `/source-blob/:projectId/:fileId` → gets back `r2Key`.
3. Client streams cells to `/import` with `file.r2Key` set in the first chunk.
4. Sync-worker writes `r2_key` to `files` table via `buildEventProjectionStmts`.

No size limit applies because R2 objects can be arbitrarily large (unlike D1
rows, which are capped at ~1 MB).  This supersedes any 512 KB guard that was
considered for D1-based side-car storage.

## Round-trip support matrix

| Format | Import | Round-trip export | Notes |
|--------|:------:|:-----------------:|-------|
| USFM / SFM | ✓ | ✓ | `serializeUsfmLossless` |
| DOCX | ✓ | ⏳ (FRO-152b) | Original blob in R2 via FRO-156 |
| PPTX | ✓ | ⏳ (FRO-152a) | Original blob in R2 via FRO-156 |
| VTT / SRT | ✓ | ⏳ (FRO-157) | Timing on cells; serializer TBD |
| Plain text / Markdown | ✓ | — | One-way; no structural fidelity |
| eBible | ✓ | — | Source is remote URL |

## Export path (future)

When export is re-enabled (v1.x), the exporter will:
1. Fetch `files.r2_key` for the file.
2. `GET /source-blob/:projectId/:fileId` → original bytes.
3. Patch translated text into the original structure (PPTX: `<a:t>` by
   `sourceLocation.blockPath`; DOCX: `<w:t>` by paragraph index).
4. Return the reconstructed file.
