# Data Persistence Plan

> **Status:** Draft — pending implementation
> **Last updated:** 2026-05-08
> **Supersedes:** the Y.Doc-as-truth architecture documented in [SYNC.md](./SYNC.md) and the hydration model in [CQRS_LEGACY_IMPORT.md](./CQRS_LEGACY_IMPORT.md).
> **Companion doc:** [CLEANUP_POST_REFACTOR.md](./CLEANUP_POST_REFACTOR.md) — what to delete or migrate once this plan lands.

Authoritative reference for how data is stored, replicated, and synced across codex-web-app, codex-sync-worker, frontier-server, and client browsers. Read this before designing any feature that touches cells, library documents, sync, exports, or media.

---

## 1. Goals and non-goals

### Goals

- **Keystroke durability.** Every keystroke survives a closed laptop or dropped connection.
- **Live presence and co-edit.** Multiple users see each other and can co-edit the same cell live.
- **Bounded client memory.** A project the size of a full Bible (~31k cells) loads on a low-end laptop without OOM.
- **Offline / poor-connection tolerance.** The app remains usable while disconnected; pending edits drain when the network returns.
- **Multi-format coverage.** USFM Bibles, Markdown, SRT/video subtitles, and InDesign IDML round-trip cleanly.
- **Cross-project leverage.** Translation Memory and termbase reuse work across projects in the same org without a second store.
- **One truth.** A single system of record per concept; no parallel sources of truth racing each other.

### Non-goals (deferred, not foreclosed)

- Vector embeddings / RAG infrastructure. Schema reservation only.
- Per-cell ACLs beyond `scope_id`. Hook present, policy table later.
- Project branching / forking. `cell_revisions` covers history needs for now.
- Native mobile clients. Browser + Tauri shell only.

---

## 2. Storage tiers at a glance

```
                      ┌──────────────────┐
                      │  R2  blobs       │  raw sources, skeletons, exports, snapshots
                      └──────────────────┘
                                ▲
                                │
      ┌─────────────┐    ┌──────────────┐    ┌──────────────────┐
client ⇄│ Project DO │ ⇄  │ frontier-srv │ ⇄  │     D1           │  truth
      │ (presence)  │    │  (Hono API)  │    │ (cells, log, …)  │
      └─────────────┘    └──────────────┘    └──────────────────┘
            ▲
            │ Y.Text relay (transient, focused cells only)
            ▼
      ┌─────────────┐
      │  client     │  SQLite-WASM (OPFS) replica + outbox + workers
      └─────────────┘
```

| Tier | Role | Mutability |
|---|---|---|
| **D1** | System of record. Current state + history + log. | Mutable via ordered events; rows are projections. |
| **R2** | Big immutable bytes. Raw uploads, format skeletons, export artifacts, project snapshots. | Content-addressed, write-once. |
| **Project DO** | Per-project ephemeral coordinator. Presence, change broadcast, focused-cell Y.Text relay. | RAM only; persists nothing. |
| **Client SQLite-WASM (OPFS)** | Full project replica + FTS5 + outbox. | Local; reconciled via sync engine. |

**The pivotal change from today's architecture:** Yjs is no longer the system of record and never persists to R2. It exists only as ephemeral *sugar* on top of the SQLite + outbox stack, in two narrow forms:

- **`Y.XmlFragment` per focused cell** — TipTap's editing CRDT, scoped to a single cell, lives only while that cell has focus. On blur or quiesce, the canonical text is flushed to `cells.translation_text` via the outbox. The Y.XmlFragment is then disposed.
- **`Y.Text` per co-edited cell** — when ≥2 clients focus the same cell, the project DO spins up a transient Y.Text seeded from `cells.translation_text` so live cursors and concurrent character ops merge cleanly. Same disposal rule: on quiesce, flush + tear down.

Y.Doc is *never* persisted. The DO holds it in RAM only while at least one client is focused on a co-edited cell. Single-user editing on a single cell uses Y.XmlFragment locally without involving the DO.

See [CLEANUP_POST_REFACTOR.md](./CLEANUP_POST_REFACTOR.md) for what this means for the existing `sync-worker` code.

---

## 3. Pinned decisions

These have been argued through and committed. Do not relitigate without explicit team buy-in.

| Decision | Choice | Rationale |
|---|---|---|
| Cell content representation | Plain TEXT with placeholder tokens + per-cell `tag_dictionary` JSON | Keeps `source_text`/`translation_text` FTS5-indexable and Y.Text-mergeable. Round-trip via dictionary. |
| Cell granularity | Semantic translatable unit (verse, sentence, cue, paragraph) per format adapter | Multiple styled runs per cell; styling is *inside* the unit. Splitting per run destroys translator workflow. |
| Tag IDs | Deterministic from `(kind_short, ordinal_within_cell)` | Same source bytes + same parser version ⇒ identical IDs across re-parses. Stops re-parse from breaking translation bindings. |
| Cell address scheme | Format-adapter-defined, semantic, stable across re-parses | USFM uses `book.chapter.verse[.kind+ord]`; Markdown uses `slug_path/sentence_hash`; SRT uses `cue.{n}`; IDML uses `story.paragraph.sentence`. |
| Translation Memory | Finalized `cells` rows *are* the TM | Denormalized `org_id`, `source_lang`, `target_lang`, `source_text_hash`. No second store. |
| Status workflow | State-machine via events, denormalized to `cells.status` | Carries `approved_at_version` for drift detection. Locked is orthogonal. |
| Speakers | First-class `speakers` table, FK from `cell_media` | Voice clone references and language-specific name overrides need an entity. |
| Audio timing | Constraint vs actual, separate column pairs | Voice cloning + retiming flows depend on this distinction. |
| Y.Text scope | Focused-cell co-edit only, ephemeral, never persisted | Releases the RAM pressure that whole-file Y.Doc hydration causes. |
| Local store | SQLite-WASM (OPFS) + FTS5 | Replaces ad-hoc IndexedDB usage. Real SQL, real indexes, real FTS. |
| GitLab sync | Library-level, opt-in webhook → re-parse | Library is the seam, not the project. |

---

## 4. D1 schema

Single database (`frontier-db-v2`). IDs are ULIDs unless noted. Timestamps are `INTEGER` unix ms. JSON is stored as `TEXT`, validated app-side. Every replicated table carries `org_id` for defense-in-depth tenant scoping even when redundant via FK.

### 4.1 Identity and ownership (existing)

```sql
CREATE TABLE orgs        (id TEXT PRIMARY KEY, name TEXT, created_at INTEGER);
CREATE TABLE users       (id TEXT PRIMARY KEY, email TEXT UNIQUE, created_at INTEGER);
CREATE TABLE org_members (org_id TEXT, user_id TEXT, role TEXT, PRIMARY KEY(org_id, user_id));
```

### 4.2 Library

```sql
-- A document the org owns. Independent of any project.
CREATE TABLE library_documents (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  name               TEXT NOT NULL,
  format             TEXT NOT NULL,              -- 'usfm' | 'markdown' | 'srt' | 'idml' | …
  usage_kind         TEXT NOT NULL DEFAULT 'source',
                                                 -- 'source' | 'reference' | 'glossary' | 'style_guide'
  source_lang        TEXT NOT NULL,              -- BCP-47
  current_version_id TEXT,                       -- FK → library_document_versions(id)
  gitlab_origin      TEXT,                       -- JSON: {repo, path, ref} or NULL
  created_by         TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX idx_library_org ON library_documents(org_id);

-- Each parse of a library document produces a version. Immutable.
CREATE TABLE library_document_versions (
  id                TEXT PRIMARY KEY,
  library_doc_id    TEXT NOT NULL,
  source_hash       TEXT NOT NULL,               -- SHA-256 of raw bytes; R2 key
  skeleton_hash     TEXT NOT NULL,               -- SHA-256 of skeleton blob; R2 key
  parser_version    TEXT NOT NULL,               -- e.g. 'usfm@2.4.1'
  parsed_at         INTEGER NOT NULL,
  cell_count        INTEGER NOT NULL,
  source_meta       TEXT NOT NULL DEFAULT '{}',  -- JSON: {book_count, chapter_count, …}
  UNIQUE(library_doc_id, source_hash)
);
CREATE INDEX idx_lib_ver_doc ON library_document_versions(library_doc_id);
```

### 4.3 Projects

```sql
CREATE TABLE projects (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  name              TEXT NOT NULL,
  library_doc_id    TEXT NOT NULL,
  bound_version_id  TEXT NOT NULL,               -- pinned library_document_version.id
  source_lang       TEXT NOT NULL,
  target_lang       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
                                                 -- 'active' | 'archived' | 'frozen'
  sync_seq          INTEGER NOT NULL DEFAULT 0,  -- monotonic per-project
  snapshot_seq      INTEGER,                     -- last snapshot rollup point
  snapshot_key      TEXT,                        -- R2 key of latest snapshot blob
  created_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_projects_org ON projects(org_id);
CREATE INDEX idx_projects_lib ON projects(library_doc_id);
```

`sync_seq` is incremented inside every mutation transaction and stamped on every change.

### 4.4 Cells (the workhorse)

```sql
CREATE TABLE cells (
  id                  TEXT PRIMARY KEY,           -- '{project_id}:{address}'
  project_id          TEXT NOT NULL,
  scope_id            TEXT NOT NULL,              -- chapter / scene / section ID
  address             TEXT NOT NULL,              -- semantic address within project
  ord                 INTEGER NOT NULL,           -- ordering hint within scope
  kind                TEXT NOT NULL DEFAULT 'text',
                                                  -- 'text' | 'subtitle_cue' | 'audio_segment' | 'footnote'
  parent_cell_id      TEXT,                       -- footnotes/refs reference host cell

  -- Source side (immutable per source_version_id; reparses replace, not edit)
  source_text         TEXT NOT NULL,              -- with inline placeholders (see §6)
  source_text_hash    TEXT NOT NULL,              -- SHA-1 of normalized source_text (TM key)
  source_version_id   TEXT NOT NULL,              -- library_document_versions.id

  -- Translation side (mutable)
  translation_text    TEXT NOT NULL DEFAULT '',
  tag_dictionary      TEXT NOT NULL DEFAULT '{}', -- JSON; shared by source and target

  -- Workflow
  status              TEXT NOT NULL DEFAULT 'empty',
                                                  -- 'empty' | 'draft' | 'translated'
                                                  -- | 'reviewed' | 'approved' | 'locked'
  approved_at_version INTEGER,                    -- value of `version` when approved (drift detection)
  locked_by_user_id   TEXT,                       -- non-null iff status='locked'

  -- Optimistic concurrency
  version             INTEGER NOT NULL DEFAULT 0,
  last_edited_by      TEXT,
  last_edited_at      INTEGER,

  -- Sync stamping
  seq                 INTEGER NOT NULL,           -- the project sync_seq at last write
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,

  -- TM denormalization (so cells *are* the TM index)
  org_id              TEXT NOT NULL,
  source_lang         TEXT NOT NULL,
  target_lang         TEXT NOT NULL,

  -- Format-specific structural metadata (small; bigger goes in skeleton blob)
  format_meta         TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_cells_project_seq   ON cells(project_id, seq);
CREATE INDEX idx_cells_project_scope ON cells(project_id, scope_id, ord);
CREATE INDEX idx_cells_status        ON cells(project_id, status);
CREATE INDEX idx_cells_tm_exact      ON cells(source_lang, target_lang, source_text_hash)
                                       WHERE status IN ('translated','reviewed','approved');
CREATE INDEX idx_cells_parent        ON cells(parent_cell_id) WHERE parent_cell_id IS NOT NULL;
```

`cells` is the TM. Cross-project fuzzy/exact matches filter by `org_id`, language pair, and status `>= translated`.

### 4.5 Cell history

```sql
CREATE TABLE cell_revisions (
  id                  TEXT PRIMARY KEY,
  cell_id             TEXT NOT NULL,
  version             INTEGER NOT NULL,           -- equals cells.version at write time
  translation_text    TEXT NOT NULL,
  tag_dictionary      TEXT NOT NULL,
  status              TEXT NOT NULL,
  source_text         TEXT NOT NULL,              -- snapshot for diff context
  source_version_id   TEXT NOT NULL,
  edited_by           TEXT NOT NULL,
  edited_at           INTEGER NOT NULL,
  event_id            TEXT NOT NULL,              -- → events.id
  UNIQUE(cell_id, version)
);
CREATE INDEX idx_revs_cell ON cell_revisions(cell_id, version DESC);
```

Server-only. Not replicated to clients (clients ask on demand for diff/history view).

### 4.6 Events log

The single append-only log for all *significant* mutations. Keystrokes inside a focused cell are *not* events — they live in the transient Y.Text and are flushed as a single `cell.updated` event on commit/blur/idle.

```sql
CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,                   -- monotonic per project
  kind        TEXT NOT NULL,
  actor_id    TEXT NOT NULL,                     -- user_id or 'system'
  payload     TEXT NOT NULL,                     -- JSON, kind-specific
  created_at  INTEGER NOT NULL,
  UNIQUE(project_id, seq)
);
CREATE INDEX idx_events_project_seq ON events(project_id, seq);
CREATE INDEX idx_events_kind        ON events(project_id, kind, seq);
```

Event kinds (initial set):

| Kind | Payload sketch |
|---|---|
| `project.created` | `{name, library_doc_id, bound_version_id, source_lang, target_lang}` |
| `project.archived` / `.unarchived` / `.frozen` | `{}` |
| `library.linked` | `{library_doc_id, version_id}` |
| `source.imported` | `{version_id, cell_count, parser_version, source_hash, skeleton_hash}` |
| `source.reparsed` | `{prev_version_id, new_version_id, rebind_summary: {kept, lost, added}}` |
| `cell.created` | `{cell_id, address, scope_id, kind, source_text, tag_dictionary}` |
| `cell.updated` | `{cell_id, expected_version, new_translation_text, new_tag_dictionary?}` |
| `cell.status_changed` | `{cell_id, expected_version, from, to}` |
| `cell.locked` / `.unlocked` | `{cell_id, user_id?}` |
| `cell.commented` | `{cell_id, comment_id}` |
| `pretranslation.applied` | `{cell_ids[], source: 'mt'\|'tm', model?}` |
| `media.segment_updated` | `{cell_id, t_start, t_end, speaker_id, generated_clip_ref?}` |
| `qa.run_completed` | `{cell_ids[], findings_count}` |
| `export.completed` | `{format, artifact_key, scope_filter}` |
| `import.started` / `.cell_added` / `.completed` / `.failed` | `{job_id, …}` |

`cell.created` and `cell.updated` produce both an `events` row *and* the `cells`-table projection update inside the same D1 transaction.

### 4.7 Commits (narrative layer)

Distinct from `events` — this is what humans read in an activity feed. Project-level rollups, sparse, durable.

```sql
CREATE TABLE commits (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL,                     -- 'scope_finalized' | 'review_pass' | 'export' | …
  actor_id    TEXT NOT NULL,
  message     TEXT NOT NULL,                     -- human-readable
  payload     TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_commits_project ON commits(project_id, seq DESC);
```

A `commit` is created by the server in response to specific events (e.g., when `cell.status_changed` flips the last cell of a scope to `approved`, emit `scope_finalized` commit).

### 4.8 Media

```sql
CREATE TABLE speakers (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,              -- or library_doc_id if reused across episodes
  display_name       TEXT NOT NULL,
  voice_clone_ref    TEXT,                       -- R2 key or external provider ID
  language_overrides TEXT NOT NULL DEFAULT '{}', -- JSON: {lang -> name}
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_speakers_project ON speakers(project_id);

CREATE TABLE cell_media (
  cell_id              TEXT PRIMARY KEY,         -- 1:1 with cells where kind != 'text'
  speaker_id           TEXT,
  -- Constraint = source/required timing the translation must respect
  t_start_constraint   INTEGER NOT NULL,         -- ms
  t_end_constraint     INTEGER NOT NULL,
  -- Actual = produced timing (after voice synthesis / re-timing)
  t_start_actual       INTEGER,
  t_end_actual         INTEGER,
  source_clip_ref      TEXT,                     -- R2 key (extracted source audio/video chunk)
  generated_clip_ref   TEXT,                     -- R2 key (rendered target audio)
  cps_max              REAL,                     -- subtitle reading-speed constraint
  cpl_max              INTEGER                   -- chars-per-line constraint
);
CREATE INDEX idx_cell_media_speaker ON cell_media(speaker_id);
```

### 4.9 Termbase (stub)

Lands empty in migration 001. Built out by Phase F of the editor refactor.

```sql
CREATE TABLE term_entries (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  scope            TEXT NOT NULL DEFAULT 'org',  -- 'org' | 'project' | 'library_doc'
  scope_id         TEXT,
  source_lang      TEXT NOT NULL,
  target_lang      TEXT NOT NULL,
  source_term      TEXT NOT NULL,
  target_term      TEXT,
  do_not_translate INTEGER NOT NULL DEFAULT 0,
  notes            TEXT,
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_terms_lookup ON term_entries(org_id, source_lang, target_lang);
```

### 4.10 Cell data model: cell-keyed vs edit-keyed

`CellData` (the legacy observed shape) is sourced from many subsystems addressed by `cell_id`. They split cleanly into two categories with different persistence shapes and different conflict semantics:

| Category | Examples | Identity | Lifecycle |
|---|---|---|---|
| **Cell-keyed** | `translation_text`, `label`, `threads`, `attachments`, `media_segments` | Tied to the cell as an entity. Survive translation edits. | Mutated over time; LWW with version checks where conflict matters. |
| **Edit-keyed** | `validations`, `waivers`, `backtranslations` | Assertions about a *specific text version*. Naturally invalidated when the version moves. | Append-only; new rows on each version. UI renders staleness honestly ("validated at v3, current is v4"). |

Edit-keyed rows carry a `text_snapshot TEXT NOT NULL` of the translation they apply to. Self-contained: no FK to `cell_revisions`, so the row stays interpretable even if older revisions are pruned. The PM input that surfaced this rule:

> Validation isn't a property of the cell, it's a signoff against a specific edit (cell_id + version). Multiple users validate the same edit independently; advancing the cell version naturally invalidates prior signoffs because they were assertions about a specific text, not about the cell as an entity.

### 4.11 Edit-keyed signoffs (added in migration 002)

```sql
CREATE TABLE validations (
  id                TEXT PRIMARY KEY,
  cell_id           TEXT NOT NULL,
  cell_version_at   INTEGER NOT NULL,           -- the cells.version this signoff applies to
  text_snapshot     TEXT NOT NULL,              -- the translation_text the validator actually saw
  rule_id           TEXT,                       -- NULL for general signoff; set for rule-scoped
  validator_id      TEXT NOT NULL,
  validated_at      INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'validated',  -- 'validated' | 'rejected' | 'withdrawn'
  notes             TEXT,
  seq               INTEGER NOT NULL,
  org_id            TEXT NOT NULL,
  UNIQUE(cell_id, cell_version_at, rule_id, validator_id)
);
CREATE INDEX idx_validations_cell    ON validations(cell_id, cell_version_at);
CREATE INDEX idx_validations_active  ON validations(cell_id, status)
                                       WHERE status = 'validated';

CREATE TABLE waivers (
  id                TEXT PRIMARY KEY,
  cell_id           TEXT NOT NULL,
  cell_version_at   INTEGER NOT NULL,
  text_snapshot     TEXT NOT NULL,
  rule_id           TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'proposed',  -- 'proposed' | 'approved' | 'revoked'
  justification     TEXT NOT NULL,
  proposed_by       TEXT NOT NULL,
  proposed_at       INTEGER NOT NULL,
  resolved_by       TEXT,
  resolved_at       INTEGER,
  seq               INTEGER NOT NULL,
  org_id            TEXT NOT NULL
);
CREATE INDEX idx_waivers_cell        ON waivers(cell_id, cell_version_at);
CREATE INDEX idx_waivers_active      ON waivers(cell_id, rule_id, state)
                                       WHERE state IN ('proposed','approved');

CREATE TABLE backtranslations (
  id                TEXT PRIMARY KEY,
  cell_id           TEXT NOT NULL,
  cell_version_at   INTEGER NOT NULL,
  text_snapshot     TEXT NOT NULL,              -- the translation_text we back-translated FROM
  back_text         TEXT NOT NULL,              -- the back-translation result
  generated_by      TEXT NOT NULL,              -- user_id or 'ai:<model>'
  generated_at      INTEGER NOT NULL,
  is_user_edited    INTEGER NOT NULL DEFAULT 0,
  seq               INTEGER NOT NULL,
  UNIQUE(cell_id, cell_version_at)
);
CREATE INDEX idx_backtrans_cell      ON backtranslations(cell_id, cell_version_at);
```

### 4.12 Cell-keyed entities (added in migration 002)

```sql
CREATE TABLE threads (
  id                TEXT PRIMARY KEY,
  cell_id           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'resolved'
  created_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  resolved_by       TEXT,
  resolved_at       INTEGER,
  seq               INTEGER NOT NULL
);
CREATE INDEX idx_threads_cell        ON threads(cell_id, status);

CREATE TABLE thread_messages (
  id                TEXT PRIMARY KEY,
  thread_id         TEXT NOT NULL,
  author_id         TEXT NOT NULL,
  body              TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  seq               INTEGER NOT NULL
);
CREATE INDEX idx_msgs_thread         ON thread_messages(thread_id, created_at);

CREATE TABLE cell_attachments (
  id                TEXT PRIMARY KEY,
  cell_id           TEXT NOT NULL,
  kind              TEXT NOT NULL,                 -- 'audio' | 'image' | 'link' | 'file' | 'reference'
  ref               TEXT,                          -- URL or external id
  blob_key          TEXT,                          -- R2 key when stored locally
  display_name      TEXT,
  metadata          TEXT NOT NULL DEFAULT '{}',    -- JSON, kind-specific
  added_by          TEXT NOT NULL,
  added_at          INTEGER NOT NULL,
  seq               INTEGER NOT NULL
);
CREATE INDEX idx_attach_cell         ON cell_attachments(cell_id);
```

Migration 002 also adds `cells.label TEXT` (cell-keyed user label) and `cells.backtranslation_pinned_id TEXT` (an FK pointer to the currently-displayed `backtranslations.id`, so the UI can fix on a specific version when the user explicitly chose one).
CREATE INDEX idx_qa_severity ON cell_qa(severity);
```

---

## 5. R2 layout

```
sources/{org_id}/{library_doc_id}/{source_hash}              raw upload bytes
skeletons/{org_id}/{library_doc_id}/{skeleton_hash}          parser-emitted skeleton (JSON or format-native)
snapshots/{project_id}/{seq}.jsonl.gz                        rolled-up project snapshot
exports/{project_id}/{export_id}/{filename}                  generated export artifacts
clips/{project_id}/source/{cell_id}.{ext}                    extracted source media chunks
clips/{project_id}/generated/{cell_id}/{revision}.{ext}      rendered target audio
```

R2 is content-addressed where possible. Skeletons are keyed by the hash of their *parser output*, not the source — same source bytes with a newer parser yields a new skeleton. This is what lets re-parse run safely.

---

## 6. Cell content representation

Plain TEXT with placeholder convention plus a JSON `tag_dictionary` per cell.

```text
source_text:
  "He said {g1}hello{/g1}{f1} to her, who served the {nd1}LORD{/nd1}."

translation_text:
  "Le dijo {g1}hola{/g1}{f1}, que servía al {nd1}SEÑOR{/nd1}."

tag_dictionary:
  {
    "g1":  { "kind": "style", "origin": { "format": "usfm", "marker": "\\add" } },
    "f1":  { "kind": "ph",    "ref":    { "cell_id": "{project}:gen.1.5.fn1" } },
    "nd1": { "kind": "style", "origin": { "format": "usfm", "marker": "\\nd"  } }
  }
```

Rules:

- Tag IDs are deterministic: `f"{kind_short}{ordinal_within_cell}"`. Same source bytes + same parser version ⇒ identical IDs across re-parses.
- One dictionary per cell, shared by source and target. Target may drop, reorder, or repeat tags but cannot introduce new IDs.
- `kind: "ph"` is a placeholder for an external referent (footnote, anchor). The translator sees a chip; the position is movable; the content is in the referenced cell.
- FTS5 indexes raw `source_text`/`translation_text`. Placeholders are short, contiguous tokens; FTS noise is bounded.
- The transient Y.Text operates on the string directly. The tag dictionary is updated by app-layer mutations atomically with the text update — never CRDT-merged.

---

## 7. Cell address scheme

The `address` column carries a stable semantic ID, set by the format adapter. Contract: same source bytes + same parser version ⇒ identical address.

| Format | Address shape | Example |
|---|---|---|
| USFM | `{book}.{chapter}.{verse}[.{kind}{ord}]` | `gen.1.1`, `gen.1.5.fn1` |
| Markdown | `{slug_path}/{sentence_hash}` | `intro/setup/9f3b1a` |
| SRT | `cue.{n}` | `cue.42` |
| IDML | `{story_id}.{paragraph_id}.{sentence_n}` | `s12.p4.3` |

On re-parse:

- `cell_id` is recomputed; survivors keep the same ID and translations re-bind automatically.
- Lost cells (address no longer present) are *not* deleted — they move to status `orphaned` and surface in a re-parse review UI. Translator can re-bind manually or discard.
- New cells (address didn't exist before) start at status `empty`.
- The `source.reparsed` event payload includes `rebind_summary` with the three counts so the activity feed shows impact.

---

## 8. Sync protocol

### 8.1 Sequence semantics

- Each project has a monotonic `sync_seq` (in `projects.sync_seq`).
- Every mutation transaction increments it and stamps every modified row + every emitted event with the new value.
- Clients track `last_seq` per project in their local store.
- Multiple rows in one transaction share one `seq` (so a transaction is atomic from the sync perspective). The DO broadcasts them as one batch.

### 8.2 Endpoints (frontier-server)

```
GET  /projects/:id                          metadata + bound_version_id
GET  /projects/:id/snapshot                 redirect → R2 signed URL of latest snapshot
GET  /projects/:id/changes?since=N&limit=M  JSONL: events + cell projections + commits, seq > N
POST /projects/:id/cells/:cell_id           optimistic mutation (body: {expected_version, …})
POST /projects/:id/cells/:cell_id/status    status transition
POST /projects/:id/library/rebind           trigger source.reparsed
POST /projects/:id/exports                  trigger export job
GET  /projects/:id/sync-token               short-lived token bound to (project_id, user_id)
WS   /do/:project_id  (token-gated)         presence + change broadcast + Y.Text relay
```

### 8.3 Initial load

1. Client → `GET /projects/:id/snapshot` → R2 signed URL + `snapshot_seq`.
2. Stream-decompress JSONL, bulk-insert into local SQLite within one transaction.
3. `GET /projects/:id/changes?since=snapshot_seq` (paginated) → apply.
4. Open WS to DO with `sync-token`, subscribe.
5. Set local `last_seq` to current.

### 8.4 Reconnect

1. Read local `last_seq`.
2. Open WS (DO buffers a short window; reject reconnects older than the buffer).
3. `GET /projects/:id/changes?since=last_seq` → catch up.
4. Resume live broadcasts.

### 8.5 Snapshot rollup

- Background job (Cron Worker or post-mutation hook above a threshold): regenerate snapshot when `current_seq - snapshot_seq > N` (initial target: 5000) or on schedule.
- Old snapshots TTL after they are no longer the latest, plus a grace period.

### 8.6 Outbox and mutations

Client outbox table:

```sql
CREATE TABLE outbox (
  local_id         TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  endpoint         TEXT NOT NULL,                -- e.g. 'POST /projects/:id/cells/:cell_id'
  payload          TEXT NOT NULL,                -- JSON
  expected_version INTEGER,                      -- denorm for conflict UX
  status           TEXT NOT NULL DEFAULT 'pending',
                                                 -- 'pending'|'in_flight'|'conflict'|'failed'
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
```

Drain loop: pick `pending`, send, mark `in_flight`, await response.

- `200`: apply server's response payload locally, delete outbox row.
- `409 conflict`: surface server's current row; outbox row → `conflict`. UX resolves; on resolution, replace `expected_version` and retry.
- `5xx` / network: leave `pending`, exponential backoff up to a cap, then `failed` with surfaced error.

Optimistic local apply: on enqueue, write the new state to the local `cells` row with `version = expected_version + 1` and a `pending` flag. On conflict, revert to last-acked state.

### 8.7 Project DO contract

- Holds in RAM: `{user_id → {scope_id, focused_cell_id, cursor_offset, last_heartbeat}}`.
- On WS connect: client subscribes to a scope (or all scopes); receives presence diff.
- On mutation: frontier-server, after committing the D1 transaction, calls `DO.broadcast({seq, changes:[{cell_id, version, …}], events:[…]})`. DO fans out to subscribers.
- On focused-cell co-edit: when ≥2 clients have the same cell focused, DO spins up a Y.Text seeded from `cells.translation_text`, relays Y.Text updates between participants, and on quiesce (debounce 1s after last edit, or all participants blur) flushes the final string through the normal `POST /cells/:id` path (one `cell.updated` event, not many).
- Soft locks: 30s TTL, refreshed on heartbeat. Pure UX hint; server still uses optimistic version checks.
- Rate limiting per DO: cap presence updates at ~10 Hz, cap Y.Text relay at ~50 ops/sec/cell. Above thresholds, drop oldest.

### 8.8 Mirror registry (Y.Doc → local store)

During the editor refactor (and any time a non-local source produces state the local store needs to mirror), the bridge is a small *registry* of mirror modules — not a single hardcoded observer. Each subsystem (`translation_text`, `threads`, `cell_attachments`, `validations`, etc.) ships its own mirror.

```ts
interface Mirror {
  name: string                                  // unique key, e.g. "translation-text"
  bootstrap(ctx: MirrorContext): Promise<void>  // one-shot import on first project open
  attach(ctx: MirrorContext): () => void        // observers; returns dispose fn
}

mirrorRegistry.register(translationTextMirror)
// Future phases:
// mirrorRegistry.register(threadsMirror)
// mirrorRegistry.register(attachmentsMirror)
```

The pattern keeps the migration path additive: each phase adds a mirror without reshaping the bridge. A retrofit to swap the bridge after Phase 0 hardcoded a single observer would be expensive — this is the cheap-now / expensive-later design.

**Bootstrap precedence.** When mounting on an existing project, the mirror's bootstrap path checks whether the destination table already has data. If empty, it imports from the source (Y.Doc, etc.). If non-empty, the local store wins and the source is ignored — the local store is canonical, the source is a lossy fallback.

---

## 9. Conflict resolution

### 9.1 The three-pane diff (UI flow)

When a `cell.set_translation` mutation returns 409:

- **Mine** = client's pending outbox payload.
- **Theirs** = server's current `cells` row.
- **Base** = `cell_revisions` at `expected_version` (lazy-fetched).

User picks: keep mine / take theirs / merge (open in editor with a 3-way merge view). Whatever they pick becomes a new mutation with `expected_version = theirs.version`.

### 9.2 Mutation kinds and per-kind conflict policies

Every outbox record carries a typed `kind` describing what it asserts. The flusher dispatches to the right server endpoint by kind, and the conflict policy below tells it what to do when the server says "the cell version moved while you were offline."

| `kind` | Shape (payload) | Endpoint | Conflict policy on `expected_version` mismatch |
|---|---|---|---|
| `cell.set_translation` | `{translation_text, expected_version}` | `POST /projects/:p/cells/:c` | **reject (409 → 3-way diff)** |
| `cell.set_label` | `{label, expected_version}` | `POST /projects/:p/cells/:c/label` | **reject (409)** — labels are cell-keyed and concurrent label edits should surface |
| `cell.transition_status` | `{from, to, expected_version}` | `POST /projects/:p/cells/:c/status` | **reject (409)** |
| `validation.signoff` | `{cell_id, cell_version_at, text_snapshot, status, notes?}` | `POST /projects/:p/validations` | **reject (409)** — version moved → reviewer must re-look |
| `validation.withdraw` | `{validation_id}` | `POST /projects/:p/validations/:id/withdraw` | LWW; accept |
| `waiver.propose` | `{cell_id, cell_version_at, text_snapshot, rule_id, justification}` | `POST /projects/:p/waivers` | **accept as historical** — old version's waiver row is preserved; UI marks it stale |
| `waiver.transition` | `{waiver_id, expected_state, to_state}` | `POST /projects/:p/waivers/:id/transition` | **reject (409)** — state transitions require fresh look |
| `backtranslation.set` (AI) | `{cell_id, cell_version_at, text_snapshot, back_text}` | `POST /projects/:p/backtranslations` | **accept as historical** — AI-generated, just persist for the version we ran on |
| `backtranslation.edit` (user) | `{backtranslation_id, expected_version, back_text}` | `PUT /projects/:p/backtranslations/:id` | **reject (409)** — user edit must re-confirm against current text |
| `thread.create` | `{cell_id, id, created_by, created_at}` | `POST /projects/:p/threads` | **accept** — additive; the empty thread shell. The first (and every) message arrives as a separate `thread.append`. |
| `thread.append` | `{thread_id, id, author_id, body, created_at}` | `POST /projects/:p/threads/:id/messages` | **accept** — additive; carries the message id so the server can dedupe on retry. |
| `thread.resolve` | `{thread_id, expected_state}` | `POST /projects/:p/threads/:id/resolve` | LWW on `state`; accept |
| `attachment.add` | `{cell_id, kind, ref?, blob_key?, display_name?, metadata?}` | `POST /projects/:p/cells/:c/attachments` | **accept** — additive; concurrent attaches don't conflict |
| `attachment.remove` | `{attachment_id}` | `DELETE /projects/:p/attachments/:id` | LWW; accept |
| `media.set_timing` | `{cell_id, expected_version, t_start_actual, t_end_actual, generated_clip_ref?}` | `POST /projects/:p/cells/:c/media` | **reject (409)** — timing belongs to a specific text version |

The two distinct "reject" semantics are the high-leverage piece:

- **`reject (409)`** = surface to user. The user sees a UI prompt or a stale banner. They re-make the decision against fresh text.
- **`accept as historical`** = the row goes through. It stays attached to its `cell_version_at`. The UI later renders staleness honestly: "validated at v3, current is v4."

Mutations that are version-irrelevant (threads, attachments) are always `accept` — concurrent additions are not conflicts.

The kinds list is *the* artifact that proves a subsystem's conflict model has been thought through. **A subsystem cannot ship in code without an entry here.**

---

## 10. Format adapter interface

Each adapter is a server-side module with a stable contract:

```ts
interface FormatAdapter {
  format: 'usfm' | 'markdown' | 'srt' | 'idml';
  parserVersion: string;

  parse(rawBytes: Uint8Array): {
    skeleton: Uint8Array;             // R2-bound, opaque to D1
    cells: Array<{
      address: string;
      scope_id: string;
      ord: number;
      kind: CellKind;
      parent_address?: string;
      source_text: string;            // with deterministic placeholders
      tag_dictionary: TagDict;
      format_meta?: object;
      media?: CellMediaFields;        // for SRT/audio
    }>;
    speakers?: Array<{ display_name: string; /* … */ }>;
  };

  export(input: {
    skeleton: Uint8Array;
    cells: CellExportView[];          // address, source_text, translation_text, tag_dict, media?
  }): Uint8Array;

  /** Round-trip determinism: empty translation → export must equal input bytes (or be semantically equal). */
}
```

CI requirement: every adapter ships with golden-file fixtures. PR cannot merge if a fixture's `parse → export(no translation)` diverges from the input beyond the adapter's documented tolerance.

---

## 11. Lifecycle flows

### 11.1 Import

1. User uploads file → `POST /library/documents` (multipart).
2. Server stores raw bytes at `sources/{org}/{doc}/{source_hash}`.
3. Server emits `import.started` event, kicks off parse job.
4. Parser produces skeleton (→ R2) and cells (→ D1, batched insert with `import.cell_added` events).
5. On completion, `library_document_versions` row inserted, `import.completed` event emitted.
6. Failures → `import.failed` event with reason; partial import state visible until user retries or discards.

### 11.2 Re-parse

1. New raw bytes uploaded for an existing library doc, *or* parser version bumped.
2. Server runs parser; produces new cells.
3. Diff against current version: by `address`, classify as `kept`, `changed_text`, `lost`, `added`.
4. For each project bound to the old version:
   - User confirms upgrade (or auto if configured).
   - Server emits `source.reparsed` event with `rebind_summary`.
   - Cells re-bound: `kept` carry translation forward; `changed_text` keep translation but flag `source_drift`; `lost` move to `orphaned`; `added` start `empty`.
   - `projects.bound_version_id` updated.

### 11.3 Export

1. `POST /projects/:id/exports` with optional scope filter.
2. Worker fetches skeleton + cells, calls adapter `export()`.
3. Result written to `exports/{project_id}/{export_id}/{filename}`.
4. `export.completed` event emitted.

---

## 12. Operational concerns

- **Backups.** D1 has continuous backup; supplement with a daily logical dump of `events` + `commits` to R2 for disaster recovery. R2 is durable; no separate backup.
- **Retention.** `events` retained indefinitely (cheap, audit value). `cell_revisions` retained indefinitely by default; per-org policy can prune to last N or last 90 days for low-tier orgs. `snapshots/{project}/...` retain latest plus one grace.
- **Telemetry from day one.** Per-project: `sync_lag` (current_seq vs client last_seq), `outbox_drain_p99`, `client_local_db_size`, `tab_memory_p50/p99` (so the 1–3 GB question is answered with data, not vibes), `do_y_text_relay_ops_per_sec`.
- **Rate limits.** Per-user: 60 mutations/sec sustained (well above human typing). Per-project DO: see §8.7.
- **Tenant scoping.** Every server query joins or filters by `org_id`. Add a defense-in-depth `org_id` column on every replicated table even when redundant (e.g., `cells.org_id`) so an off-by-one in a join cannot leak.
- **Round-trip CI.** Each format adapter has a fixture set in repo; CI fails on regression.
- **GitLab refresh.** Library documents with `gitlab_origin` get an opt-in webhook subscription. On webhook, server re-fetches the file, re-hashes; if `source_hash` changed, kick off re-parse (yields a new `library_document_versions` row). Projects bound to the old version see a "source updated upstream — review changes" banner.

---

## 13. Schema evolution and migration safety

This is the section that does not look load-bearing until the day it is. Read it before writing any migration, on either side.

### 13.1 Premortem

The failure modes we are designing against, ranked by likelihood × blast radius:

1. **Edit-in-place after deploy.** A developer fixes a bug in an already-shipped migration file. Existing users' `_migrations` says version N ran, but their schema diverges from what the file now says it did. Silent corruption, no telemetry signal until something queries the affected column.
2. **Mid-migration crash.** Migration runs `CREATE TABLE foo`; the page closes before the `INSERT INTO _migrations` row lands. Next open the runner sees N as not applied, retries, and fails because the table already exists. Database wedged for the user.
3. **Server `NOT NULL` without default.** New migration adds `cells.scope_lang TEXT NOT NULL` without a default. Old clients writing rows that omit that column get rejected by the server. Cascading failures.
4. **Server drops or renames a column.** New migration drops `cells.original_text`. Old clients reading that column get nulls. UI silently empties or misrenders.
5. **Concurrent tab migration race.** Two tabs open against the same OPFS database; both check `_migrations`, both see "not applied", both run.
6. **Snapshot has unknown column or record type.** Server emits a new field or kind the client doesn't know about. Client either crashes parsing or silently drops it.
7. **FTS5 index out-of-date after schema change.** Adding tokenizer or column changes makes search results stale until rebuild.
8. **Long migration freezes the tab.** A backfill over 30k cells runs synchronously on the main thread.

### 13.2 Client-side migration rules (enforced)

1. **Append-only.** Never edit a migration file once it has been merged to `main`. Never delete one. The shape of `_migrations` and the on-disk SQL are part of the public contract with every database that has ever been opened.
2. **Content-hashed.** The migration runner stores a SHA-256 hash alongside `(version, applied_at)`. On every open it recomputes the hash for already-applied migrations and throws `MigrationDriftError` on mismatch. *See `LocalStore.migrate` in `src/lib/local-store/db.ts` and the runtime test in `migration-drift.test.ts`.*
3. **CI-locked.** A `MIGRATIONS_LOCK.json` manifest at `src/lib/local-store/migrations/MIGRATIONS_LOCK.json` records each migration's expected hash. The vitest spec `migrations/lockfile.test.ts` fails if any committed migration's canonical hash diverges from the manifest. Editing a migration file fails CI; adding one requires updating the manifest in the same PR.
4. **Atomic.** Each migration runs inside a SQLite transaction together with its `_migrations` insert. Partial failure leaves nothing applied — recovery is to rerun.
5. **Limited operations.** Stick to: `CREATE TABLE/INDEX/TRIGGER/VIEW`, `DROP TABLE/INDEX/TRIGGER/VIEW`, `ALTER TABLE ADD COLUMN`, `ALTER TABLE RENAME COLUMN`. For type changes, `DROP COLUMN` on older SQLite versions, or constraint changes, use the rebuild pattern: create new table, `INSERT INTO new SELECT * FROM old`, drop old, rename new — all inside one migration file.
6. **No data backfills in migrations.** Backfills can take seconds-to-minutes on Bible-sized DBs and freeze the tab. Backfills must (a) happen server-side and arrive via `applyChangeBatch`, or (b) run in a Worker post-migration with progress UI.
7. **FTS5 rebuilds are explicit.** A migration that changes anything affecting `cells_fts` content must end with `INSERT INTO cells_fts(cells_fts) VALUES('rebuild');`.
8. **Recovery from drift is a wipe.** When a client hits `MigrationDriftError`, the recovery path is "delete the local OPFS file → re-bootstrap from server snapshot → replay outbox after surfacing any conflicts." No data is lost server-side. Outbox records that haven't been ack'd are at risk and must be surfaced before the wipe — see §13.5.

### 13.3 Server-side migration rules (D1)

The asymmetry is critical: client migrations are run by code we deploy together; server migrations face *every* client version that is currently in the wild. Until you have telemetry showing zero traffic from old clients, every server change must be backward-compatible.

1. **Always backward-compatible during the rollout window.** Old clients in the wild keep working unchanged. The "rollout window" defaults to 30 days, or until <0.1% of mutations come from clients that lack the new code. Track via the `User-Agent` + a `client_version` claim on the JWT.
2. **Add columns NULL-default.** Never `NOT NULL` without an explicit default; never `NOT NULL` on a column that incoming mutations from old clients might omit.
3. **Never drop or rename in a single step.** Use the deprecation cadence:
   - **Step 1 — Add.** New column with default. Server dual-writes (projects from `old → new` and `new → old`). Old clients keep working unchanged.
   - **Step 2 — Read.** Update server projections to prefer the new column on output. Update client code to read the new column. Roll out.
   - **Step 3 — Wait.** Stay in this state for the rollout window. Monitor `user_agent` distribution.
   - **Step 4 — Single-write.** Stop the `new → old` half of the dual-write. Old clients still work because they read both names from snapshot/changes responses (the snapshot includes both column names until step 5).
   - **Step 5 — Drop.** Remove the old column in a follow-up migration once telemetry shows the previous step has been live for a full window with no errors.
4. **Schema compatibility headers.** Server includes `X-Schema-Version: N` in `/snapshot` and `/changes` responses. Clients log a warning when their expected version differs. Future: hard-gate on `X-Min-Schema-Version` when the gap exceeds the rollout window.
5. **Tolerant readers on both sides.** Both client and server tolerate unknown JSON fields silently. Adding a field on either side requires no immediate change on the other. *Verified by `forward-compat.test.ts` for the client.*
6. **Mutations are versioned.** Every mutation endpoint accepts `expected_version` (as today) but also tolerates extra payload fields it doesn't know about — required for forward-compatibility from newer clients hitting the same endpoint.
7. **Format adapters are forever.** Once a parser version (e.g. `usfm@2.4.1`) has produced cells in a project, that exact parser version stays callable in the codebase. Re-parsing always emits a new version (`usfm@2.5.0`); never silently change the output of an existing version.

### 13.4 Compatibility-window contract

| Action | Compatibility window |
|---|---|
| Add column (NULL-default) | 0 days — safe immediately |
| Add table | 0 days |
| Add index | 0 days |
| Rename column | minimum 30 days, dual-write throughout |
| Drop column | minimum 30 days after step 4 above |
| Drop table | minimum 30 days; dual-read first |
| Change column type | rebuild via the table-replacement pattern; same window as rename |
| Change `NOT NULL` constraint (relax) | 0 days |
| Change `NOT NULL` constraint (tighten) | minimum 30 days; backfill server-side first |

Override only with explicit user-impact analysis in the PR description.

### 13.5 Recovery from client drift

When `LocalStore.migrate` throws `MigrationDriftError` on app open:

1. The error reaches the React error boundary at the project route.
2. UI shows: "Your local cache is incompatible with this version of the app. Reload to clear it and re-fetch from the server. *N pending edit(s) have not yet synced — these will be lost.*" with a "Reload" button.
3. If `N > 0`, surface the affected cells in a list with their pending text so the user can copy anything they care about.
4. On confirm: drop the OPFS file, reload the page. The next open does a fresh snapshot fetch and replay.

The same path triggers if the OPFS file is corrupted or quota-exceeded — these are also "wipe and re-bootstrap" failure modes.

### 13.6 Tooling guards in the repo

| Guard | What it catches | Where |
|---|---|---|
| `MigrationDriftError` at runtime | edited migration that diverges from a previously-applied DB | `src/lib/local-store/db.ts` |
| `migrations/lockfile.test.ts` | edited migration source between PRs | vitest CI |
| `forward-compat.test.ts` | reader that crashes on unknown JSON fields | vitest CI |
| Round-trip adapter fixtures | format adapter that changes its parse output silently | per-adapter golden tests |
| `X-Schema-Version` header (future) | client-server skew detection | server middleware |
| `User-Agent` + `client_version` telemetry (future) | knowing when the rollout window has actually elapsed | analytics dashboard |

---

## 14. Build order

Each step is independently shippable and reversible.

1. **Schema migration.** New tables + new columns on `cells`. Stub tables empty. `events` kind enum extended.
2. **USFM adapter.** Highest-leverage given the existing eBible importer. Implement parse + export with golden fixtures.
3. **Snapshot and changes endpoints.** `/projects/:id/snapshot` + `/projects/:id/changes?since=N`. Snapshot rollup job.
4. **Client SQLite-WASM + sync engine + outbox.** Initial load flow, reconnect flow, optimistic mutations, conflict surface.
5. **Project DO presence + change broadcast.** Strip current Y.Doc-backed DO behavior; replace with broadcast-only. (See companion cleanup doc.)
6. **Y.Text session manager.** Focused-cell co-edit only. Spin-up on second focus, tear-down on quiesce.
7. **Second adapter.** Markdown or SRT. Confirms the adapter contract.
8. **Re-parse flow.** UI, rebind logic, drift flagging.
9. **Export flow.** UI, scope filter, artifact download.
10. **Stub-table fill-in.** Comments, QA framework, termbase. Each is independent and additive.

---

## 15. Glossary

| Term | Meaning |
|---|---|
| **Cell** | One translatable unit. Verse, sentence, cue, paragraph — depending on format. |
| **Scope** | A grouping of cells that translators work on as a unit (chapter, scene, section). Permission and progress boundary. |
| **Library document** | An owned, parsed source artifact. Independent of any project. Versioned by source hash. |
| **Project** | A binding of one library document version to one target language, plus the team translating it. |
| **Skeleton** | The parser's structural output that, combined with translated cells, regenerates the original format. Lives in R2. |
| **Tag dictionary** | Per-cell JSON map from placeholder ID (`g1`, `f1`) to original markup metadata. |
| **Address** | Stable semantic ID for a cell within a project, set by the format adapter. |
| **Sync seq** | Per-project monotonic counter stamped on every mutation. The basis of incremental sync. |
| **Snapshot** | Rolled-up project state in R2 as gzipped JSONL. Initial-load fast path. |
| **Outbox** | Client-side durable queue of pending mutations. |
| **Project DO** | Per-project Durable Object. Presence, broadcast, transient Y.Text. No persisted truth. |

---

## 16. Cross-references

- [SPEC.md](./SPEC.md) — product-level specification (read this for what the app does, not how it stores data).
- [SYNC.md](./SYNC.md) — *current* sync architecture. Will be retired and replaced by this document. See cleanup doc for migration steps.
- [CQRS_LEGACY_IMPORT.md](./CQRS_LEGACY_IMPORT.md) — current event-import-and-hydrate flow. The event log half stays; the Y.Doc hydration half is replaced by the snapshot endpoint described here.
- [MMS_R2_HOSTING.md](./MMS_R2_HOSTING.md) — orthogonal (audio asset hosting); unaffected.
- [CLEANUP_POST_REFACTOR.md](./CLEANUP_POST_REFACTOR.md) — what to delete or migrate from the existing system once this plan lands. Read this before deleting anything.
