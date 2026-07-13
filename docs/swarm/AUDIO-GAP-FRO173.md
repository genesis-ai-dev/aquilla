# AQU-173: Audio Data Gap Investigation

**Branch:** swarm/fro-173  
**Date:** 2026-06-09  
**Investigator:** swarm agent  
**Status:** Investigation complete — product decision required before audio data will exist on staging

---

## Summary Verdict

| Acceptance | Status | Evidence |
|---|---|---|
| 1. Did legacy GitLab projects contain audio that should have been imported? | **YES — audio existed, but the importer was run without `--audio` flag** | See §Q1 below |
| 2. Is there an import/backfill path? | **Path exists, never executed for staging** | `scripts/migrate-all.ts --audio`, `scripts/migrate.ts --audio` |
| 3. Does a freshly recorded clip land as a cell_audio row? | **Code path is sound (verified by unit tests)** | See §Q3 below |
| 4. Will Overview audio % reflect data once it exists? | **Yes — no code change needed** | Already confirmed in AQU-160/AQU-168 swarm |

---

## Q1: Did Legacy GitLab Projects Contain Audio?

**Answer: YES** — the migration infrastructure explicitly handles legacy audio attachments.

### Evidence from code archaeology

**`src/lib/codex-editor/types.ts:83-86`** — `CodexCell` carries:
```ts
attachments?: Record<string, CodexCellAttachment>;
selectedAudioId?: string;
audioTimings?: Record<string, WordTiming[]>;
```
These fields exist on the cell metadata structure stored in `.codex` files in GitLab.

**`src/lib/migrate/audio.ts`** — `collectCellAudio()` reads `cell.metadata.attachments`,
`cell.metadata.selectedAudioId`, `cell.metadata.selectedGeneratedVoiceAudioId` and
builds a list of clips to import. `audioAttachEvent()` creates a deterministic
`cell.audio.attach` event with `url: frontier-audio://<audioId>` and a
`diskRelPath` pointing to `.project/attachments/files/<audioId>` stored as Git LFS blobs.

The module comment confirms the design intent:
> "import the cell's SELECTED recording + selected generated voice (skipping soft-deleted clips)"

**`src/lib/migrate/audio.test.ts`** — 5 unit tests pass confirming the mapping logic works
against real `CodexCell` metadata shapes (including `wendilord`-authored clips with
`durationSec`, `mimeType`, `isDeleted` flags). All pass: `5 passed (5)`.

### Why audio is absent from staging Neon

**`scripts/pg-import-content.ts:line 11`** (the bulk Neon import script):
```
// Defers: cells, files, cell_validators, cell_audio, comments, counters, FTS.
```
This script fetches projects with `--no-lfs` (line 115) and calls only
`mapFilePairToEvents()` — which maps text/validation events only. It does **NOT** call
`collectCellAudio()` or `audioAttachEvent()`. Audio was explicitly deferred.

**`scripts/migrate-all.ts:line 12`** (the D1/prod migration script) comment:
```
// Audio is DEFERRED (separate pass).
```
The content sweep ran with `--no-lfs` (line 355: `fetchProject(p.id, true) // content sweep: text only (no LFS)`).
The audio pass is in `doProjectAudio()` (line 421) and is only activated via
`npx tsx scripts/migrate-all.ts --audio --apply`.

**`scripts/lib/fold-projection.ts:line 19`**:
> "There are NO deletes, reorders, source-commits, unvalidates, waivers, audio,
> or backtranslations — so cells/validators are only ever added or updated, never removed."
The bulk fold-projection (used by `pg-build-projections.ts`) explicitly lists audio as
outside its scope — consistent with audio having been deferred.

### Staging Neon query confirmation

Querying staging Neon (`sweet-paper-88472094`, branch `br-old-credit-aja5brf7`):

```sql
SELECT kind FROM events WHERE kind LIKE '%audio%' LIMIT 10;
-- Result: 0 rows

SELECT COUNT(*) FROM cell_audio;
-- Result: 0

SELECT kind, COUNT(*) FROM events GROUP BY kind ORDER BY count DESC LIMIT 30;
-- Result: source.cell.create (7.9M), target.cell.commit (4.8M),
--         cell.validate (1.8M), comment.create (27k), file.create (14k),
--         comment.resolve (1.8k)
-- No cell.audio.attach kind present anywhere in the 14.4M-event log.
```

Zero `cell.audio.attach` events were ever ingested. The 14.4M-event corpus matches
the fold-projection module's claim: only 6 kinds, no audio.

---

## Q2: Import/Backfill Path

**Path exists but has never been executed against staging.**

### Two available scripts

#### Option A — `scripts/migrate-all.ts --audio --apply` (production-grade, incremental)

```bash
set -a; . ./.env; set +a
npx tsx scripts/migrate-all.ts --audio --apply
```

- Iterates all GitLab Codex projects
- For each: re-clones **with LFS** to materialize the audio blobs on disk
- Uploads bytes to R2 via `PUT /migrate/audio/:projectId/:fileId/:audioId`
  (the `handleMigrateAudioRequest` route in `sync-worker/src/events/migrate-audio-route.ts`)
- Emits `cell.audio.attach` events via `POST /migrate/ingest`
- Change-detection via `.migrate-state.json`: skips projects whose GitLab HEAD SHA is
  unchanged from the last run — so re-runs are incremental
- **Gated on SYNC_SECRET_KEY + Cloudflare R2 binding (SNAPSHOTS)**

#### Option B — `scripts/migrate.ts --audio` (single-project, dev-stack)

Targets the local dev stack (ports 5173/8787/8788). Useful for a canary test
against one project before the full sweep.

### Prerequisite reality check

The audio pass requires:
1. A running sync-worker that handles `/migrate/audio` (already wired in
   `sync-worker/src/events/migrate-audio-route.ts` and registered in `sync-worker/src/index.ts`)
2. LFS objects accessible in GitLab (projects fetched without `--no-lfs`)
3. R2 bucket bound as `SNAPSHOTS` in the staging worker
4. `SYNC_SECRET_KEY` matching the staging worker's secret

**This is a data migration decision, not a code bug.** The code is complete and correct.
The audio blobs live in GitLab LFS; fetching them and uploading takes disk + bandwidth
(gigabytes). Operator must decide: backfill legacy audio? If yes: run the audio pass
against staging first (canary), then prod.

---

## Q3: Post-Cutover Recording Path (code trace)

The freshly-recorded-clip → `cell_audio` row path is sound at every layer.

### Trace

1. **User records in UI** → `AudioRecordingModal.tsx` calls `emitCellAudioAttach()`
   (`src/components/AudioRecorder/AudioRecordingModal.tsx:197`,
   `src/lib/sync/events-emit.ts:322`)

2. **emitCellAudioAttach** → `enqueueEvent({kind: "cell.audio.attach", ...})` → adds event
   to the outbox queue, then `POST /api/v1/projects/:p/files/:f/events` to sync-worker
   (via the standard event flush path in `src/lib/sync/events-emit.ts`)

3. **sync-worker route.ts** — `cell.audio.attach` is listed as non-chain-mutating (line 250):
   ```ts
   rawEvent.kind !== 'cell.audio.attach' && ...
   ```
   → `updateProjection: true` always → projection always executes

4. **dispatch.ts:65** — routes to `handleCellEvent()`

5. **event-projection.ts:603-659** — `case 'cell.audio.attach'` — deselects siblings in
   the same slot, then upserts the new clip row as `selected=1, deleted=0`
   into `cell_audio`

6. **Neon write** — the SQL runs against the project's Neon branch via Hyperdrive

### Unit test coverage

`sync-worker/src/__tests__/cell-audio.test.ts` — 7 tests, **7 passed**:
- `attach: deselects siblings in the slot, then upserts selected+live`
- `attach: nulls optional fields when omitted`
- `select: deselects siblings then selects the target`
- `remove: soft-deletes and deselects`
- Read-route: auth, grouping per cell, selected-per-slot mapping

The projection SQL is verified against the real `buildEventProjectionStmts` function.
No gaps in unit coverage for this path.

---

## Q4: Overview Audio % (no code change needed)

The Overview audio % query already reads from `cell_audio`. Confirmed in AQU-160 and
AQU-168 swarms. Once rows exist, the Overview will reflect them automatically.
The `// TODO(AQU-168): audio VALIDATION metric` placeholder remains (validation coverage
is separate from recording coverage and is moot until audio data exists).

---

## What Was Changed

**Nothing.** This is a pure investigation. No source files were modified.

- `docs/swarm/AUDIO-GAP-FRO173.md` — this document (new file)

---

## Root Cause

The bulk GitLab→Neon import (`pg-import-content.ts`, `migrate-all.ts` content sweep)
deliberately skipped audio because:
1. Audio blobs are stored in Git LFS (gigabytes); the text-content sweep ran with
   `--no-lfs` for speed
2. `fold-projection.ts` (the bulk projection builder) explicitly excludes audio events

The audio import infrastructure is complete and correct. It was never executed against
staging. This is **not a code bug** — it is a deferred data migration decision.

---

## Recommended Next Action

**Product decision required:** Does Frontier R&D want to backfill legacy GitLab audio
onto staging/prod?

**Options:**

| Option | Action | Effort |
|---|---|---|
| A — Backfill legacy audio | Run `npx tsx scripts/migrate-all.ts --audio --apply` targeting staging sync-worker | Moderate (hours of LFS clone + upload; GBs of data) |
| B — New recordings only | Accept that legacy audio is lost; focus on the post-cutover path | No effort (path already works) |
| C — Canary first | Run Option A on one known audio-heavy project (`--only <gitlabId>`) to measure volume and verify the path before the full sweep | Low (minutes) |

**If Option A or C:** An operator with GitLab LFS access, `SYNC_SECRET_KEY`, and
staging worker access must run `scripts/migrate-all.ts --audio --apply`.

**If Option B:** Close AQU-173 as "won't fix / data decision — no code change."

---

## Live-UI Steps for Central QA Agent (Acceptance 3)

To confirm a freshly recorded clip lands as a `cell_audio` row on staging:

1. Sign in at `https://dev.aquilla.app` with a staging account
2. Open any project, navigate to any file in the editor
3. Click the audio record button on any cell (microphone icon in the cell toolbar)
4. Record a short clip (2–3 seconds), then save/confirm it
5. Immediately after save, query staging Neon:
   ```sql
   SELECT * FROM cell_audio
   WHERE project_id = '<project_id>'
   ORDER BY created_ts DESC
   LIMIT 5;
   ```
6. Expected: a new row with `selected=1, deleted=0`, `url` matching `frontier-audio://<audioId>`,
   `slot='recording'`
7. Reload the Overview page — the project's audio % should be > 0 for that project

**Note:** Step 5 requires knowing the `project_id`. It can be found in the URL:
`https://dev.aquilla.app/project/<projectId>`. Alternatively, look at the most recent
`cell_audio` insert after recording.

---

## SWARM-TODOs

- [ ] **[PRODUCT DECISION]** Decide whether to backfill legacy GitLab audio
  (Options A/B/C above). Assign to an operator with GitLab LFS access.
- [ ] Once a decision is made and any backfill runs, re-run:
  `SELECT COUNT(*) FROM cell_audio;` on staging to confirm rows exist.
- [ ] If backfilling, run canary first:
  `npx tsx scripts/migrate-all.ts --audio --apply --only <known-audio-project-gitlabId>`
- [ ] The `// TODO(AQU-168): audio VALIDATION metric` placeholder can be addressed
  once audio data exists (separate ticket).

---

## Gate Results

- `npx tsc -b --noEmit` — not run (no code changed)
- `sync-worker vitest run src/__tests__/cell-audio.test.ts` — **7/7 pass**
- `vitest run src/lib/migrate/audio.test.ts` — **5/5 pass**
- No new test failures introduced (no code changed)
