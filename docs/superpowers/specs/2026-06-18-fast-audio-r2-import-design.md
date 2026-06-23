# Fast R2→R2 Audio Import (All Takes) — Design

**Date:** 2026-06-18
**Status:** Approved design, pending implementation plan

## Goal

Make Aquilla aware of **every historical audio take** for migrated Codex projects,
copying the audio bytes **bucket-to-bucket inside Cloudflare** instead of pulling
them out of GitLab LFS and re-uploading them.

The legacy audio already lives in R2. The existing `migrate-all.ts --audio` pass is
slow only because it asks GitLab to dereference each LFS object (egress from R2 via
signed download URLs) and then re-uploads the identical bytes into `aquilla-snapshots`
— shuttling GBs across the public network to move them between two buckets in the
**same Cloudflare account**. This design removes that round-trip.

## Background (verified facts)

- **Account:** Aquilla and the legacy GitLab LFS backend are in the **same** CF account
  (`6a80496d1e59948a9cbaa3c643ba81d7`, Frontier R&D). Confirmed in
  `sync-worker/wrangler.toml:26` ("Same CF account as frontier-server and aquilla-db").
- **Legacy audio bytes** are stored as **GitLab LFS objects** in bucket
  **`codex-attachments-v1-1`**, keyed by SHA-256 oid under GitLab's object-storage
  layout. Confirmed in `~/frontierrnd/frontier-server/configure-gitlab-lfs-r2.sh`
  (`gitlab_rails['lfs_object_store_remote_directory'] = '$R2_BUCKET_NAME'`, bucket
  named `codex-attachments-v1-1` at lines 182/199/203/212; `proxy_download = true`).
- **In the git repo, each attachment is only an LFS pointer** (oid + size). A
  `--no-lfs` clone therefore carries everything we need to *locate* the bytes (the
  oid) plus the cell metadata, without downloading any audio.
- **Destination key** for live playback is
  `projects/{projectId}/files/{fileId}/audio/{audioId}`
  (`sync-worker/src/audio.ts` `audioObjectKey`); `frontier-audio://{audioId}` URLs
  resolve to this path (`src/lib/audio/upload.ts`).
- **The take model already supports unlimited takes per cell.** `cell_audio` has one
  row per take (PK includes `audio_id`), a `selected` flag (one selected per cell+slot),
  and a `deleted` flag (`db/postgres/schema.sql:316`). The read route returns **all**
  non-deleted takes per cell plus the selected ids
  (`sync-worker/src/events/cell-audio-read-route.ts`). The `TakesStrip` UI already
  browses, plays, denoises, and switches takes
  (`src/components/AudioRecorder/TakesStrip.tsx`). **No schema or projection changes
  are required** — only the migration emits more events.
- **The old app had no voice generation.** Every legacy take is a human recording, so
  all imported takes use slot `"recording"`; the `generatedVoice` slot is not used by
  this migration.

## Scope

**In scope:** Import every non-deleted audio take per cell for migrated projects, with
the legacy `selectedAudioId` pinned as the active take. Bytes copied R2→R2 within CF.

**Out of scope:** Soft-deleted takes (`isDeleted`), generated-voice clips (none exist),
changes to the live recording/playback paths, changes to `cell_audio` schema or event
projection, and the existing `--audio` pass (left intact as a fallback).

## Architecture

Four cooperating units, each independently testable:

### 1. Take collection (pure) — `src/lib/migrate/audio.ts`

Add `collectAllCellAudio(cell): AudioImport[]` alongside the existing
`collectCellAudio`. It returns **all** non-deleted audio attachments
(`type === "audio"` or untyped, `!isDeleted`, has `url`), each as an `AudioImport` with
`slot: "recording"`, carrying `createdAt`, `mimeType`, `durationMs`, and
`legacyAudioId`. The existing `collectCellAudio` (active-only) is untouched.

Selection is derived separately: the active take id is the cell's `selectedAudioId`
(if that attachment is among the collected, non-deleted takes).

`AudioImport.aquillaAudioId` remains `basename(att.url)` and `diskRelPath` remains
`att.url`, exactly as today.

### 2. LFS pointer → oid (pure) — reuse `src/lib/lfs/pointer.ts`

For each take, read the pointer file at `diskRelPath` from the `--no-lfs` clone and
parse it with the existing `parsePointerContent` → `{ oid, size }`. A file that is
absent or not a valid pointer yields `null`; that take is skipped and counted as an
`lfs-miss` (surfaced, never silently dropped — CLAUDE.md Rule 12).

### 3. Copy endpoint — `sync-worker`

- **Binding:** add a read-only R2 binding `LFS_SRC` → `codex-attachments-v1-1` in
  `sync-worker/wrangler.toml` (top-level + `[env.production]`; dev/staging optional and
  only needed if we test there).
- **Route:** `POST /migrate/audio-copy`, gated on `Bearer ${SYNC_SECRET_KEY}` (same
  trust model as `/migrate/ingest` and `/migrate/audio`).
- **Body:** `{ projectId, fileId, audioId, oid }`.
- **Logic:**
  1. `destKey = audioObjectKey(env, projectId, fileId, audioId)`.
  2. `srcKey = gitlabLfsKey(oid)` (the GitLab LFS object-storage layout — see Open
     verification).
  3. Idempotent: if `await env.SNAPSHOTS.head(destKey)` exists → return
     `{ copied: false, reason: "exists" }`.
  4. `const obj = await env.LFS_SRC.get(srcKey)`; if `null` → HTTP 404
     `{ copied: false, reason: "lfs-miss" }` (caller logs, continues).
  5. Else `await env.SNAPSHOTS.put(destKey, obj.body, { httpMetadata: { contentType:
     obj.httpMetadata?.contentType ?? contentTypeForAudioId(audioId) } })` → return
     `{ copied: true }`.
- The `get`→`put` streams within Cloudflare's network; the bytes never traverse the
  public internet, so there is no GitLab egress and no GB transfer over the wire.

`gitlabLfsKey(oid)` is a small pure helper (own module + unit test) so the layout is
verifiable and changeable in one place.

### 4. Event emission + driver — `--audio-fast` pass in `scripts/migrate-all.ts`

**Implementation note / deviation from original plan:** the spec first proposed a
standalone `scripts/migrate-audio-copy.ts`. During implementation this was changed to a
parallel **`--audio-fast`** pass inside `scripts/migrate-all.ts`, because the bulk audio
import needs the project-discovery, `fetchProject`, `headSha`, `.migrate-state.json`,
`fetchExistingEventIds`, and `ingest` plumbing that already lives there — a standalone
script would duplicate ~200 lines. The existing `--audio` pass is left **untouched** as a
fallback (the spec's real requirement). The pure logic lives in
`src/lib/migrate/audio-copy.ts` and is fully unit-tested; the pass is thin orchestration.

`doProjectAudioFast(p, args)`, per project:

1. Fetch with `--no-lfs` (reuse `fetchProject(id, true)`): metadata + pointers only.
2. `buildOidIndex(discoverPointers(dir).pointers)`; for each cell, `planCellAudio` →
   `{ copies: {take, oid}[], missingOid[], selectedAquillaAudioId }`. `missingOid` (no
   pointer resolved) is counted as `no-oid`.
3. For each copy, `POST /migrate/audio-copy`. On `copied`/`exists` the take's bytes are
   in place → include it in the cell's copied set. `404 lfs-miss` and other failures are
   counted + warned, never silently dropped.
4. `buildCellAudioEvents(cellId, copiedTakes, selectedAquillaAudioId, opts)` →
   `cell.audio.attach` per copied take (`frontier-audio://{audioId}`, slot `recording`,
   `clientTs = createdAt` so `TakesStrip`'s `created_ts ASC` reproduces "Take 1..N"),
   then one `cell.audio.select` to pin the active take — omitted if that take wasn't
   copied or there is none. Uses the new deterministic `audioSelectEventId`.
5. Ingest via the existing `/migrate/ingest`, **delta-filtered** against
   `fetchExistingEventIds`.
6. Per-project log: `copied / existing / lfs-miss / no-oid / failed`. State tracked under
   a new `audioFastSha` key in `.migrate-state.json` so re-runs skip unchanged projects
   (separate from `audioSha` so the two passes don't clobber each other).

Run: `npx tsx scripts/migrate-all.ts --audio-fast --only <id>` (dry-run one), then
`--audio-fast --apply` (sweep). Requires the sync-worker deployed with the `LFS_SRC`
binding.

## Data flow

```
migrate-fetch --no-lfs  ──►  cell metadata + LFS pointers (no audio bytes)
        │
        ▼
collectAllCellAudio  ──►  takes[] (slot=recording) + selectedAudioId
        │  (read pointer → oid)
        ▼
POST /migrate/audio-copy {projectId,fileId,audioId,oid}
        │   sync-worker: LFS_SRC.get(srcKey) ──► SNAPSHOTS.put(destKey)   [in-network]
        ▼
queue cell.audio.attach (per take) + cell.audio.select (active take)
        │
        ▼
POST /migrate/ingest  (delta-filtered)  ──►  projection writes cell_audio rows
        ▼
read route returns all takes; TakesStrip renders them; selected take circled
```

## Idempotency & delta

- **Copy:** `head(destKey)` short-circuit makes re-copies free.
- **Events:** deterministic ids + `fetchExistingEventIds` diff mean re-runs send only
  new events.
- **State:** `.migrate-state.json` skips projects whose audio set is unchanged.

Net effect: the second run of any project is near-instant.

## Error handling (fail loud — CLAUDE.md Rule 12)

- **`lfs-miss`** (pointer references an oid not in the bucket): logged per occurrence,
  counted per project, summarized at the end. Never silently dropped.
- **Non-pointer attachment** (bytes inline / not LFS-tracked): no oid → cannot fast-copy.
  Logged as "needs slow path" and counted; the operator can run the existing `--audio`
  pass for those projects. Expected to be negligible/zero.
- **Copy or ingest HTTP failure:** abort that take, log, continue the project; the take
  reappears on the next run (no partial-success poisoning because events are only
  queued for takes whose copy succeeded).

## Testing strategy

- **Unit:**
  - `collectAllCellAudio` — returns all non-deleted takes, excludes deleted, marks slot
    `recording`, identifies `selectedAudioId`; intent: *every* take is imported, not
    just the active one.
  - `gitlabLfsKey(oid)` — produces the confirmed layout for a known oid.
  - `audioSelectEventId` / `audioAttachEventId` — deterministic for identical inputs
    (re-run safety).
- **Integration (sync-worker, mocked R2 bindings):**
  - `/migrate/audio-copy` — `head` hit → skip; source present → put to correct destKey;
    source `null` → `lfs-miss`.
  - Projection: N attaches + 1 select → N `cell_audio` rows, exactly one `selected = 1`
    in the recording slot, matching the legacy `selectedAudioId`.
- **Manual / E2E:** run the script against one small project; open it in the UI; confirm
  `TakesStrip` shows all takes in order and the correct take is active/playable.

## Open verification (before relying on it)

1. **Exact GitLab LFS key layout** in `codex-attachments-v1-1`. GitLab's default for
   object storage is `<oid[0:2]>/<oid[2:4]>/<oid>` at the bucket root, but some
   configurations prepend a path. Confirm by listing a handful of keys (via the new
   `LFS_SRC` binding in a one-off worker probe, or S3 creds from
   `frontier-server/config/r2_storage.env`) and matching one against a known pointer's
   oid **before** trusting `gitlabLfsKey`.
2. **Bucket is safe to read** (read-only `get`; we never write or delete in `LFS_SRC`).

## Decisions (resolved)

- Mechanism: **worker-binding copy** (reuses migrate auth, no S3 creds, bytes stay in CF).
- Scope: **every historical (non-deleted) take**.
- Slot: **all takes are `recording`** (no legacy voice generation).
- Active take pinned via explicit **`cell.audio.select`** on legacy `selectedAudioId`.
- Delivered as a **`--audio-fast` pass in `migrate-all.ts`** (reuses the sweep plumbing;
  see §4 implementation note); existing `--audio` pass left intact as fallback.
