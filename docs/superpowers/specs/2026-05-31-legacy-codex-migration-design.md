# Legacy Codex → Aquilla Migration — Design

**Date:** 2026-05-31
**Status:** approved design; building MVP slice
**Destination:** this repo (`codex-web-app`, prod `aquilla.app`, D1 `aquilla-db`). NOT the Rust `~/frontierrnd/aquilla` monorepo (alpha, `aquilla-alpha`).

## 1. Goal & decisions

Load and merge **all** data from legacy GitLab-based "Codex" translation projects — cells, source/target text, audio, comments, validations, edit history, video — into this app, with **maximal fidelity** and **strict idempotency**.

Locked decisions (from brainstorming):

| Decision | Choice |
|---|---|
| Where it runs | A reusable **engine library + operator CLI**, run **from a local machine** (cron-able). NOT a Cloudflare Worker. |
| Project mapping | **1 legacy project → 1 new aquilla project** (deterministic id). |
| Authorship/history | **Full fidelity** — per-edit original author + legacy timestamp + full edit history. |
| Scope/source | **All Codex projects via GitLab + LFS** (layered); local working copies for the first slice. |
| Author identity | Import `frontier-db-v2` users into `aquilla-db` so author strings link to real accounts. |
| Unmapped data | **Promote video + backtranslations to first-class** (new event grammar). |
| Reference design | Port the proven Rust migrate system (`apps/migrate/worker`, `aquilla-specs/30-aquilla-alpha/migrate.md`, `PLAN-legacy-import-v1.md`) — **leaner**, dropping the 30s-CPU-cap scaffolding (DO/Queue/cron/chunked-reentrant stages). |

## 2. Why leaner than the proven system

The Rust system's 10 queue-driven reconciler stages, per-stage cursors, and Durable-Object serialization exist to survive Cloudflare's 30s CPU cap. Running locally removes that constraint: we **parse a whole project once into memory** (even a 66-file Bible ≈ 62k events fits trivially) and **stream large batches** to one ingest endpoint. We keep the load-bearing correctness primitives (deterministic UUIDv5 ids, original-author attribution, SHA change-detection) and drop the orchestration scaffolding.

## 3. Architecture

```
scripts/migrate/  (Node/TS engine + CLI — runs locally, cron-able)
  discover  → enumerate projects (local dir | GitLab API + metadata.json detector)
  fetch     → local working copy | clone (isomorphic-git) + LFS deref (frontier-auth logic)
  parse     → REUSE src/lib/codex-editor/ (parse-codex, pair-cells, map-history, parse-comments, parse-metadata)
  resolve   → codex author string → identity username (+ frontier-db-v2 user import)
  map       → deterministic events (file.create, source.cell.create, target.cell.commit×history,
              cell.validate, cell.audio.attach, comment.*, cell.backtranslation.set, file.video.set)
  ingest    → POST /migrate/ingest  (batches ~2k events)
  verify    → reconcile counts; assert idempotent re-run
         │
         ▼  HTTPS, HMAC(SYNC_SECRET_KEY)
sync-worker:  POST /migrate/ingest   ← NEW trusted route
  - auth: HMAC/admin credential over SYNC_SECRET_KEY (same trust tier as admin routes)
  - upsert projects row (+ project_settings, owner membership)
  - per event: INSERT OR IGNORE into events (caller-supplied deterministic id, author, clientTs)
  - reuse buildEventProjectionStmts verbatim; event + projection in the SAME d1.batch (≤100 stmts/chunk)
         │
         ▼  aquilla-db (D1)  +  R2 (audio/video blobs)
```

### Components
1. **`scripts/migrate/` — engine + CLI.** Pure TS. `parse` wraps the existing Node-safe `src/lib/codex-editor/`. CLI: `migrate <project>`, `--all`, `--dry-run`, `--local|--remote`, `--since`. Continuous = local cron.
2. **`sync-worker` `POST /migrate/ingest`.** The one trusted surface that can write events with a **caller-supplied author + legacy timestamp + deterministic id** (the normal `/events` path binds author to the token and assigns its own ids). Reuses `buildEventProjectionStmts`, so migrated rows are byte-identical to live-edited ones.
3. **Schema additions (migrations in `auth-worker/migrations/`, next free = `0022`):**
   - `0022_file_video.sql` + `file.video.set`/`file.video.remove` grammar (video first-class).
   - `users.legacy_id` (+ optional `is_stub`) for idempotent `frontier-db-v2` user import.
   - **Tonight's slice needs no migration** (source/target/cells grammar already exists).

## 4. Determinism & idempotency (the contract)

`AQUILLA_MIGRATION_NS = 7f3c8a91-2b4d-4e6f-9a8c-1d3e5f2b4a6c` (matches the Rust tools → cross-compatible ids; verify against `tools/legacy-user-import/src/ids.rs` before first prod run). Any fixed namespace satisfies our own idempotency; this one buys cross-compat.

Deterministic ids (UUIDv5 over NS):
- `projectKey` = `gitlab_project_id` (GitLab) **or** `metadata.json.projectId` (local).
- aquilla `project_id` = `uuid5(NS, "gitlab-project:<gid>")` or `"local-project:<projectId>"`.
- `file_id` = `uuid5(NS, "file:<projectKey>:<relativePath>")`.
- event `file.create` = `uuid5(NS, "file-create:<project_id>:<file_id>")`.
- event `source.cell.create` = `uuid5(NS, "cell-create:<project_id>:<file_id>:<cellId>")`.
- event `target.cell.commit[i]` = `uuid5(NS, "cell-commit:<project_id>:<file_id>:<cellId>:<editIdx>")`.
- `cell_id` = verbatim legacy `metadata.id`; source/target share it (so they pair).
- audio object id = `uuid5(NS, "audio:<project_id>:<cellId>:<legacyAudioId>")` + ext.
- `comment.create` = `uuid5(NS, "comment:<project_id>:<legacyCommentId>")`.
- **Excluded from id seeds** (per proven design): `commit_sha` (lives in `payload.migrated_from`); `target_event_id` excluded from `cell.validate` key so re-syncs converge as the head advances.

Idempotency guarantees:
- **No randomness** in any id; legacy timestamps go in `clientTs`, never in an id seed.
- **Event + projection are one atomic `d1.batch`** → "event exists" ⟺ "projection applied"; an interrupted run leaves a clean prefix and the re-run completes the rest.
- **Projections converge** (UPSERT; counters recomputed from `cells`, never incremented).
- **R2 keys deterministic** → overwrite identical bytes; HEAD-skip when present.
- **Change-detection (HEAD/blob SHA) is an optimization only** — correctness never depends on the local state file.
- **Success criterion (tested):** run → run again ⇒ **0 new events, 0 projection changes, 0 R2 writes.**

## 5. Fidelity mapping

| Legacy | Destination | Layer |
|---|---|---|
| source/target cells, verse refs, ordering | `source.cell.create` + `target.cell.commit`, shared `cell_id`, `canonical_ref`, anchor chain | MVP |
| full edit history (per-edit author + ts) | one `target.cell.commit` per `metadata.edits[]` entry, chained, `author`=edit author, `clientTs`=edit ts | MVP→next |
| project metadata (languages, validation counts) | `projects` + `project_settings` | MVP |
| validations (`validatedBy[]`) | `cell.validate` against the imported head commit's event id | next |
| audio (LFS deref → R2) | R2 upload (deterministic key) → `cell.audio.attach` (bytes before event) | next |
| comments (`.project/comments.json`) | `comment.create/edit/resolve` (deterministic from legacy thread/comment ids) | next |
| backtranslations (`files/backtranslations.json`) | `cell.backtranslation.set` (`targetEventId` = imported head) | next |
| video (`metadata.videoUrl` + per-cell timings) | `file.video.set` + `file_video` table (per-cell timings already on the cells chain) | layer |
| GitLab enumerate + Codex-detect + LFS hydrate | `discover`/`fetch` | layer |
| `frontier-db-v2` users → link author strings | user-import subcommand (+ `users.legacy_id`) | layer |
| original `.codex`/`.source` bytes (round-trip) | `file_source_blobs` side-car | layer |

Notes: legacy authors are **Frontier usernames** (codex sets `edits[].author = authApi.currentUser.username`). Join to identity by case-insensitive `username` then `email`. Unmappable/`unknown`/bot authors fall back to project owner but keep the original string in `payload.migrated_from.codex_username`. Soft-deleted/merged cells (`data.deleted`/`data.merged`) are imported but marked inactive (mirror `getActiveCells`).

## 6. Tonight's MVP slice

Target: `~/.codex-projects/Demo-Text-Project-olmxuoxbzeppn1xdv8cf` opens in the local SPA with source + target populated; re-run adds nothing.

1. `POST /migrate/ingest` on the running local sync-worker: HMAC auth, upsert project, INSERT-OR-IGNORE events + projection in one atomic batch.
2. `scripts/migrate/`: parse via `src/lib/codex-editor`, map to `file.create` + `source.cell.create` + `target.cell.commit` (latest value; then full history), deterministic ids, original authors + legacy `clientTs`.
3. Run against local stack; verify in browser (dev login → open project); assert idempotent re-run.
4. Point at an audio project + a couple more → "a few projects tonight."

## 7. Roadmap (post-MVP, ordered)

full edit-history commits → validations → audio (R2 + LFS deref) → comments → backtranslations → video grammar (migration 0022) → GitLab enumeration + Codex detector + LFS hydrate → `frontier-db-v2` user import (+`legacy_id`) → raw-bytes side-car → continuous cron + SHA change-detection.

## 8. Risks / open items

- **`file.create` projection currently hardcodes `role`/`book_code`/`source_file_id` to NULL** even though plumbed — extend that projection branch so sidebar book/role grouping is populated.
- **Validation "sticks" only against the current chain head** — emit the target commit, then validate against that exact event id.
- **Legacy LFS audio is not playable as-is** — must re-upload real bytes to R2.
- **Author identity:** verify the join (username/email) against real `frontier-db-v2` rows before a prod run; decide `is_stub` for GitLab members absent from `frontier-db-v2`.
- **Verify `AQUILLA_MIGRATION_NS`** against the Rust source if cross-compat with `aquilla-alpha` is ever wanted (not required for our own idempotency).
- **Trusted endpoint is privileged** (caller-chosen author) — gate strictly on `SYNC_SECRET_KEY`; never expose to browser clients.
