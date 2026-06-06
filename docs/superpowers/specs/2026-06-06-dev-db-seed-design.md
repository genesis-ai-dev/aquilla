# Dev DB seed from prod — design

Date: 2026-06-06
Status: approved (brainstorming), pending implementation
Branch: `feat/dev-db-seed`

## Problem

We need to robustly populate a **dev** database with realistic sample data drawn
from **prod** (Neon Postgres project `sweet-paper-88472094`, "Aquilla"). The
samples should cover our team's internal/test projects so dev exercises real
project shapes (large translation projects, alignment, audio dubbing, comments,
validators) without copying the entire 14.5M-event prod corpus or leaking PII.

The same seed must hydrate **both** a developer's local Postgres **and** a remote
Neon dev branch.

## Decisions (locked during brainstorming)

| Question | Decision |
| --- | --- |
| Dev DB target | One seed source that loads into local Postgres **and** a Neon dev branch (loader takes a target connection string). |
| Project scope | Curated allowlist (~6–10 projects) from **BCS** + a couple of **The Chosen** projects (incl. audio). Easy to add/remove in a manifest. |
| Fidelity | **Verbatim** — events + projections + blobs. No re-fold on load. |
| PII | **Scrub** identity: anonymize users (fake email/username/display), null password hashes, drop reset/invite tokens. Content kept as-is. |
| Bundle storage | **R2-hosted** in the existing prod `aquilla-snapshots` bucket under a `seed/` prefix. The repo commits only a small pointer + metadata file. |
| Bundle format | **Per-table JSONL**, concatenated and **zstd**-compressed (Node 22 built-in `zlib.zstd*`, zero new deps). |
| Audio media | **No blob copy.** `cell_audio.url` / `checkpoints.r2_key` keep their original prod R2 keys; dev reads media in place from the prod bucket (read-only). New dev recordings write to the dev bucket as usual. |

### Conflict resolved (Rule 7)

An earlier answer said "committed seed works offline." The later decision —
R2-hosted bundle + repo pointer — supersedes it. "Offline" therefore means
**offline after the first `seed:fetch`**, and audio always reads from prod R2 at
runtime. We go with the later (R2-pointer) decision.

## Curated allowlist (initial)

Eight projects, biased toward variety over size (counts are cells / events):

| Project | Org | cells | events | Why |
| --- | --- | --- | --- | --- |
| `bestalu-bible` (`41ee4729…`) | BCS | 31,174 | 32,073 | Flagship large BCS project |
| `suvvali-bible` (`5a75dd78…`) | BCS | 31,209 | 35,795 | Second large BCS project |
| `tamil-alignment` (`9f9c4294…`) | BCS | 32,835 | 32,964 | Alignment `kind` surface |
| `nagamese-pilgrims-progress` (`f7818397…`) | BCS | 9,651 | 15,199 | Non-Bible content, multi-file |
| `hindi-pilgrims-progress` (`6ecec038…`) | BCS | 1,404 | 2,808 | Tiny single-file project |
| `commentaries-test` (`d51f82a7…`) | BCS | 66 | 133 | Smallest; commentary kind |
| `audio-dubbing-playground` (`d04c4f29…`) | Come and See | 5,145 | 10,694 | **Audio** dubbing surface |
| `Copy-of-test-matthew-audio-dubbing` (`40be0415…`) | Chosen-test-playground | 1,247 | 1,379 | Small **audio** project |

Verbatim size ≈ 120 MB raw events; zstd ≈ 15–35 MB in R2. The manifest is the
single source of truth and is trivially editable to drop the big three if the
bundle needs to shrink.

## Architecture

Five units, each independently runnable and testable.

```
prod Neon ──seed-extract──▶ bundle.jsonl.zst ──put──▶ R2 (aquilla-snapshots/seed/)
                                  │                        │
                          seed.meta.json (committed)       │
                                                           ▼
target (local PG / Neon branch) ◀──seed-load── .cache/ ◀──seed-fetch── R2
```

### 1. `db/seed/manifest.json` — curated allowlist + scrub rules

Human-editable. Drives everything. Shape:

```jsonc
{
  "version": 1,
  "projectIds": ["41ee4729-…", "5a75dd78-…", "…"],
  "scrub": {
    "emailDomain": "example.test",
    "keepDisplayNames": false
  },
  "tables": [ /* ordered table list, see below */ ]
}
```

### 2. `scripts/seed-extract.ts` — prod → bundle (maintainer-only, needs prod creds)

- Reads manifest. Resolves the **closure** of identity rows the projects depend
  on: every `org_id` on the projects, every group that grants them
  (`group_project_grants`), and **every user referenced** by any selected row —
  by numeric id (`projects.created_by/archived_by`, `*.user_id`,
  `org.owner_user_id`, `group.created_by`, `assignments.*`, etc.) **and** by text
  username (`events.author`, `cells.last_editor`, `cell_validators.username`,
  `comments.author_id`/`author_label`, `cell_backtranslations.author`).
- Builds a **global identity remap** (see "PII scrub" below).
- Streams each table's project-scoped rows, applies the remap, and writes one
  JSONL section per table (with a `# table: <name>` header line) into a single
  buffer, then `zstdCompressSync` → `seed.bundle.jsonl.zst`.
- `wrangler r2 object put aquilla-snapshots/seed/dev-seed-v<N>.jsonl.zst` (prod
  account; bucket already holds audio, so one credential set covers both).
- Writes `db/seed/seed.meta.json` (committed): R2 key, byte size, sha256 of the
  compressed bundle, per-table row counts, prod extract timestamp, and the
  **sha256 of `db/postgres/schema.sql`** at extract time.

### 3. `scripts/seed-fetch.ts` — R2 → local cache

`wrangler r2 object get` the key named in `seed.meta.json` into
`db/seed/.cache/<key>` (gitignored). Verifies sha256 against meta; re-uses cache
if present and valid.

### 4. `scripts/seed-load.ts` — bundle → any Postgres

```
npx tsx scripts/seed-load.ts --target "<conn string>"   # or --local / --neon
```

- Fetches (via unit 3) if the cache is cold.
- **Schema guard:** recompute sha256 of the target's live schema (or of local
  `schema.sql`) and compare to `seed.meta.json.schemaHash`; **refuse to load on
  mismatch** (guards the known D1→Neon drift trap). Override flag
  `--ignore-schema-hash` for deliberate cases.
- In a single transaction: for each project id in the bundle, `DELETE` existing
  rows from every content table (idempotent re-seed), `DELETE` the seeded
  org/group/user ids, then `zstdDecompressSync` and bulk-`INSERT` each table
  section in FK-free order (no FKs are enforced; order is for readability).
- After load: `setval` the identity sequences (users, organizations, groups,
  activity_logs) per the schema's post-migration notes so dev-created rows don't
  collide with seeded ids.
- **Verify & fail loud:** re-count every table for the seeded ids and assert it
  equals `seed.meta.json` counts; non-zero exit on any mismatch (Rule 12).

### 5. npm scripts

```jsonc
"seed:extract": "tsx scripts/seed-extract.ts",   // maintainer, prod creds
"seed:fetch":   "tsx scripts/seed-fetch.ts",
"seed:load":    "tsx scripts/seed-load.ts",
"seed:dev":     "tsx scripts/seed-load.ts --local" // fetch + load into local PG
```

## PII scrub (global identity remap)

The hard part: usernames are foreign keys *by text* across content tables, so a
naive `users`-only rewrite would orphan `events.author` etc. The extract builds
one map and applies it everywhere:

- For each real user `(id, username, email, display_name)` in the closure, derive
  a **deterministic** fake: `username → user_<id>`, `email → user_<id>@<domain>`,
  `display_name → "User <id>"` (or null), `password_hash → ''` (non-loginable),
  `avatar_url → null`, `preferences → '{}'`.
- Determinism (keyed on the stable numeric id) means re-extraction yields the
  identical fake set → minimal bundle churn and stable diffs.
- Apply the **username** half of the map to: `events.author`,
  `cells.last_editor`, `cell_validators.username`, `cell_waivers.waived_by`,
  `cell_backtranslations.author`, `comments.author_id` + `author_label`.
- Drop entirely: `password_reset_tokens`, `project_invites` (tokens + invitee
  emails), `activity_logs` (noisy + PII; not needed for dev).
- Org/group/project **names** are kept (they're our own team's, not PII).

Unmapped author strings (e.g. system/bot authors, or ids not in the user table)
are passed through unchanged; the extract logs any author token it could not map
so we can decide case-by-case rather than silently dropping (Rule 12).

## Table set & load order

Identity (closure): `users`, `organizations`, `org_members`, `groups`,
`group_members`.
Project: `projects`, `project_members`, `group_project_grants`,
`project_settings`.
Content (project-scoped): `events`, `files`, `cells`, `cell_validators`,
`cell_waivers`, `cell_audio`, `cell_backtranslations`, `comments`, `assignments`,
`assignment_cells`, `diarization_jobs`, `file_source_blobs`, `checkpoints`,
`snapshots`.

Excluded: `password_reset_tokens`, `project_invites`, `activity_logs`.

## Non-goals

- No re-fold of projections on load (we ship them verbatim).
- No copy of audio/checkpoint blobs (pointer-only to prod R2).
- No automated prod→bundle refresh schedule; `seed:extract` is run by hand when
  the sample set should change.
- Login as seeded users (their hashes are blanked). Local login continues to use
  the existing `/__dev__/seed` "dev" user path.

## Risks / open points

- **Bundle size vs git:** mitigated by R2 hosting; only the small meta file is
  committed.
- **Schema drift between extract and load:** mitigated by the schema-hash guard.
- **Audio depends on prod R2 at runtime:** acceptable for dev; documented.
- **Sequence collisions:** mitigated by `setval` after load.
- **Cross-table username remap completeness:** the extract must enumerate every
  author/editor column; the unmapped-token log is the safety net.
