# Linked Projects — Provenance Chains & Upstream-Change Invalidation — Design

**Status:** Draft for discussion · 2026-07-06
**Driver:** Come and See (The Chosen) — English scripts/video + subtitles localized into 500–600
languages, with translation-of-translation chains (English → French → Chaluba). Secondary
drivers: unfoldingWord (git-based upstream), LangQuest (batch/quest invalidation).
**Builds on:** AD-9 (`projects.source_project_id`, `cells.source_event_id` staleness pin,
`stale-source-route.ts`), the link/detach routes in `auth-worker/src/routes/source-linking.ts`,
and the template/clone-vs-live sketch in
`2026-06-24-multimedia-timeline-file-design.md` §6–§7 (Linear: FRO-440).

---

## 1. The problem we're solving

Come and See runs one project per language per episode (today: *two* per language — dialogue +
subtitles — which the timeline-file design collapses into one). Every language project consumes
the same upstream English content. Two things go wrong at this scale:

1. **Upstream fixes don't propagate.** When a line of English source is corrected, every
   language project that translated that line is silently wrong. Anna's Jun 3 session was
   exactly this: a bad English/French file was uploaded, a translator translated it, and the
   fix had to be hand-migrated ("The migration inserted all of the content off by one").
   There is no mechanism that *tells* a downstream project its source moved.

2. **Chains multiply the problem.** For low-resource languages, a translation is itself the
   base for another translation ("you can take the French that's a target and treat it as the
   source for another one… chain the projects together" — Ryder, Jun 3 demo). A fix to one
   English line must invalidate the French line that renders it, and — once the French line is
   flagged/changed — the Chaluba line that renders *that*. Invalidation is **cell-lineage
   granular**: one changed line touches its descendants along the chain, not the whole file
   and not unrelated cells.

The requirements, stated once:

- **Deterministic.** Staleness must be *derivable on read* from durable data (event-id pins +
  cursors + content hashes), never dependent on a notification having been delivered. Push
  messages are accelerators only; a missed message must self-heal.
- **Batch-friendly.** A re-imported episode script changes hundreds of cells at once; the
  propagation unit is a *set* of cells (an event-seq window), not a per-cell message. This is
  also the forward-compat shape for LangQuest ("a whole quest goes stale").
- **Chain-aware.** Invalidation cascades hop-by-hop through the provenance chain, following
  the lineage of the changed cell only.
- **Scale-sane.** One upstream may have 600 downstreams. The upstream write path must not fan
  out 600 synchronous writes per edit. Dormant downstreams catch up when opened.

---

## 2. Link model & terminology

A **link** makes one project (the **downstream**) consume content from another (the
**upstream**). Chains are just links composed: C→B→A. `chainContains()` (32-hop cap) already
prevents cycles.

Each link has two properties, fixed at creation:

| Property | Values | Meaning |
| --- | --- | --- |
| **mode** | `clone` \| `live` | `clone`: one-time snapshot at creation, then independent (today's `snapshotSourceCells` detach behavior, applied at birth). `live`: subscribed; upstream changes propagate per §5. |
| **consumes** | `source` \| `target` | Which upstream lane becomes the downstream's **source** lane. `source` = sibling-language case (both translate the same English). `target` = chain case (Chaluba's source *is* French's translation). |
| **gate** (target-consumption only) | `head` \| `validated` | Which upstream target state propagates: every commit (`head`) or only validated heads (`validated`, default). Head-gating means every French draft commit churns Chaluba; validated-gating means the chain consumes *decisions*, at the cost of starving if the middle hop never validates (open question §15). |

Existing AD-9 code implicitly assumes `consumes: 'source'` (the stale-route JOIN reads
`s.side = 'source'` in the upstream). `consumes` is the semantic decision this spec locks in —
but it is **not** a one-line flag on the chain case, because target rows have a different
lifecycle than source rows:

- Upstream target rows are born on first `target.cell.commit` with **no structure** — no
  `type`, `canonical_ref`, `anchor_cell_id`, `start_ms/end_ms`, `sequence_index`, no cast
  metadata (the projection only writes those at `*.cell.create`). A dubbing chain needs all of
  it. Therefore a `consumes: 'target'` mirror is a **merge**: structural fields come from the
  upstream cell's **source** row, text (`value`/`valueHtml`) from the upstream **target** row.
  The mirror delta must watch upstream *structural* events (`source.cell.create`,
  `cell.retime`, `cast.assign`, `file.create`) in **both** consumption modes.
- Upstream cells whose target has never been committed simply have no downstream source row
  yet; they appear when the first (gated) upstream commit lands. The review panel (§9.5) shows
  the untranslated remainder as "awaiting upstream translation," so a chain project can see
  its true frontier.

**Clone representation.** A clone **keeps** `source_project_id` set, with
`source_link_mode = 'clone'` — the FRO-440 graph needs the edge. Every consumer of the link
must therefore check the mode: the stale-source route, the mirror sync, and the push hook all
**short-circuit on `mode = 'clone'`** (a clone must never show upstream-drift flags — that is
the point of cloning). Detach remains the only operation that nulls the FK.

**Identity across projects rides on `cell_id`.** Parser-minted cell ids are fresh UUIDs per
import (`src/lib/parsers/subtitle.ts`), so *re-import can never be the propagation mechanism*.
Instead, a linked project is **seeded** from its upstream — files and cells are copied
preserving `file_id` and `cell_id` — and from then on cross-project lineage is the shared
`cell_id` plus event-id pins. (This is already how `snapshotSourceCells` and the stale-route
JOIN work; we're naming the invariant.)

**One upstream per project** (v1), stored as today's `projects.source_project_id`. Multi-
upstream (e.g. dialogue lane from A, subtitle lane from B) is explicitly out of scope; the
schema in §4 leaves room via a `project_links` table if it's ever needed, but we do not build
it now.

---

## 3. What already exists (inventory)

| Piece | Where | Status |
| --- | --- | --- |
| `projects.source_project_id` FK + cycle check | `auth-worker/migrations/0004`, `services/source-linking.ts` | ✅ shipped |
| Link/detach/downstreams/delete-guard routes | `auth-worker/src/routes/source-linking.ts` | ✅ shipped (project_lead 500+; no link UI) |
| Detach = snapshot upstream source cells locally | `snapshotSourceCells()` | ✅ shipped |
| `project.link-source` durable event | `sync-worker/src/events/types.ts`, `dispatch.ts` | ✅ shipped (broadcast-only, no projection) |
| Per-target pin `cells.source_event_id`, set on `target.cell.commit` | `events-emit.ts`, `event-projection.ts` | ✅ shipped |
| Stale query (pin ≠ upstream head) | `sync-worker/src/events/stale-source-route.ts` | ✅ shipped — **source-lane only, single hop** |
| Client hook + badge | `useStaleSourceCells.ts`, `StaleSourceIndicator.tsx` | ✅ built, badge not fully wired into `CellRow` |
| `content_hash` (djb2) on cells projection | `event-projection.ts` | ✅ shipped |
| Per-project `server_seq` + delta reads (`?since=`) | `events` table, `cells-read-route.ts` | ✅ shipped |
| Per-project ProjectSync DO broadcast (`__broadcast`, PERF-8 batching) | `route.ts`, `project-do.ts` | ✅ shipped — strictly per-project |
| Cross-project reads at read time | `cells-read-route.ts` | ❌ none — reads are project-local by design (AD-3); source content must be **materialized** locally |
| Queues / cron / DO alarms in the workers | wrangler.toml | ❌ none — propagation cannot assume async infra |

Consequence: the design below is **mirror + pin + derive-on-read**. Downstream source cells
are real local rows; propagation is a *mirror sync* that advances them; staleness falls out of
machinery that already exists.

---

## 4. Data model changes

**Link metadata** (v1: columns on `projects`, beside `source_project_id`):

```sql
ALTER TABLE projects ADD COLUMN source_link_mode     TEXT;   -- 'clone' | 'live' (null = legacy/live)
ALTER TABLE projects ADD COLUMN source_link_consumes TEXT;   -- 'source' | 'target' (null = 'source')
ALTER TABLE projects ADD COLUMN source_link_gate     TEXT;   -- 'head' | 'validated' (target-consumption)
ALTER TABLE projects ADD COLUMN source_link_cursor   BIGINT NOT NULL DEFAULT 0;
                                 -- max upstream server_seq this project has mirrored
```

`source_link_cursor` is the deterministic "how far behind am I" marker — the *derive-on-read
fallback if every push message in the world is lost*. The freshness probe compares it against
the max **lane-relevant** upstream seq, not the raw `MAX(server_seq)`: the upstream log is full
of comments, audio attaches, BTs, and validations that never mirror, and a probe that counts
them makes all 600 downstreams read "behind" after every upstream comment. Concretely: a
partial index (or maintained per-project `last_lane_seq`) over the mirrored kinds
(`source.cell.*`, `cell.retime`, `cast.assign`, `file.create`, `cell.delete`, and
`target.cell.commit`/`cell.validate` for target-consumption links).

**Mirror provenance on cells.** Mirrored source cells record where they came from inside the
mirror event's payload (`upstream: { projectId, cellId, eventId, side, contentHash }`) and the
projection stores the upstream event id in a new nullable column:

```sql
ALTER TABLE cells ADD COLUMN upstream_event_id TEXT;    -- head of the upstream cell this row mirrors
ALTER TABLE cells ADD COLUMN upstream_seq      BIGINT;  -- that event's upstream server_seq (monotonic apply guard)
ALTER TABLE cells ADD COLUMN tombstoned_at     BIGINT;  -- upstream deleted this cell (kept visible, see §5)
```

This makes "is my local mirror current?" a local comparison, and gives the inherited-staleness
walk (§6) its join key. All migrations must land in D1 *and* `db/postgres/schema.sql` (see
memory: post-cutover 500s are usually a migration never applied to Neon).

**New event kinds** (conventions per `types.ts`):

| Kind | Arbitration | Payload | Purpose |
| --- | --- | --- | --- |
| `source.cell.mirror` | **latest-upstream-seq-wins** (see below) | full create-grade shape: `{ value, valueHtml?, type, canonicalRef?, anchorCellId?, startMs?, endMs?, sequenceIndex?, metadata?, deleted?, upstream: { projectId, cellId, eventId, seq, side, contentHash } }` | Server-emitted event that advances a downstream source cell to match upstream. Projected as **UPSERT** (the `target.cell.commit` INSERT…ON CONFLICT shape, *not* the UPDATE-only `source.cell.commit` shape — mirrors routinely hit cells with no local row yet: new upstream cells post-seed, first-ever translations in target-consumption mode). Sets `upstream_event_id`/`upstream_seq`; `deleted: true` sets `tombstoned_at` instead of removing the row. |
| `file.mirror` | idempotent upsert | `{ fileId, name, meta, upstream: {...} }` | Downstream `files` row for an upstream file created post-seed. No per-cell fold can conjure the file row; this must be an explicit delta step. |
| `target.cell.repin` | non-chain-mutating, **guarded** | `{ sourceEventId, expectedTargetEventId }` | "Reviewed against new source; translation stands." Projection: `UPDATE … SET source_event_id = ? WHERE … AND event_id = expectedTargetEventId` — a no-op if the translator re-committed under the reviewer (the route reports the no-op so bulk repin surfaces skipped cells). Chain head does not move, so validations survive (deliberate — §7). Reviewer (300)+. |
| `link.cursor.advance` | no projection to cells | `{ upstreamProjectId, fromSeq, toSeq, cellCount }` | Audit-trail record of each **non-empty** mirror batch; an empty fold advances the cursor column directly without minting an event (no log spam from unmirrored upstream noise). |

**Mirror arbitration — explicitly not first-child.** Mirror events carry `parentId: null` and
are **exempt from `CHAIN_MUTATING_KINDS`** / the chain-claims gate. Rationale: a mirror
replicates an ordering the *upstream* already arbitrated; running it through downstream
first-child claims adds nothing and creates a real fault (two concurrent syncs fold the same
cell from different upstream heads; the older one wins the claim slot, the newer one's
projection no-ops, and the cell is stranded on stale content behind an advanced cursor —
invisible to every self-heal probe). Instead the projection applies a mirror **iff
`payload.upstream.seq > cells.upstream_seq`** (monotonic, order-insensitive, replay-safe).
`rebuild.ts` must reproduce the same rule.

Mirror event ids are **deterministic**: `uuidFrom(hash(downstreamProjectId + upstreamEventId))`
so replays/dual triggers dedupe via the events-PK idempotency path that already exists
(`readExistingEventIds`). Nothing about ordering relies on wall clock.

---

## 5. Propagation: the mirror sync

The single engine, used by every trigger. **Single-flight per downstream**: `/link/sync` is
serialized through the downstream's ProjectSync DO (the natural per-project serializer), so
two triggers can't interleave folds. Skipped for `mode = 'clone'`.

```
mirrorSync(downstream):                         -- runs inside the downstream's DO, one at a time
  link   = load link (upstream id, consumes, gate, cursor)
  head   = max LANE-RELEVANT upstream seq (§4 probe)     -- cheap freshness probe
  if head <= cursor: return (already current)
  delta  = upstream events WHERE server_seq > cursor AND kind in lane set:
             always:            source.cell.create/commit/mirror, cell.retime,
                                cast.assign, cell.delete, file.create
             consumes=target:   + target.cell.commit (gate=head)
                                  or cell.validate→its validated head (gate=validated)
  fold delta to latest-applicable-per-cell (a seq window, not per-event work)
  for new upstream files: emit file.mirror
  for each (cellId, upstreamState):
      if upstream deleted:            emit source.cell.mirror { deleted: true }   -- tombstone, §4
      elif upstream content_hash == local mirrored contentHash:
          skip entirely                                   -- no event; §6 staleness is hash-aware,
                                                          -- so a lagging upstream_event_id is harmless
      else:
          emit source.cell.mirror                         -- deterministic id; consumes=target merges
                                                          -- structure from upstream SOURCE row + text
                                                          -- from upstream TARGET row (§2)
  POST all of the above through the normal /events path (batched, idempotent)
  cursor = GREATEST(cursor, head); emit link.cursor.advance only if the fold was non-empty
```

Properties worth stating:

- **Batch-native.** A 500-cell upstream re-import is one seq window → one mirror burst through
  the existing 100-statement batching. The propagation unit is a set, per requirement.
- **No-op suppression without write amplification.** `content_hash` equality (normalized text)
  emits *nothing* — not even a pin-refresh event. This matters: a re-imported upstream file
  mints fresh event ids on every cell (parser invariant, §2); if unchanged cells required
  refresh mirrors, that's 500 cells × 600 downstreams = 300k events whose content is "nothing
  changed." Instead, the §6 staleness checks compare **hash before event id** — hash-equal is
  never stale — so `upstream_event_id` is allowed to lag on unchanged content.
- **Idempotent, resumable, race-proof.** Deterministic ids dedupe replays; the monotonic
  `upstream_seq` apply-guard (§4) makes application order-insensitive; `GREATEST` on the
  cursor plus end-of-sync advancement means a crashed or overtaken sync can only *under*-claim
  progress, never over-claim it.
- **Chain staleness falls out.** The mirror advances the downstream's *local source head*;
  every target pinned to the old head is now stale under the **existing** intra-project
  comparison. No new staleness machinery on the hot path.
- **Deletes tombstone, never vanish.** A mirror-delete sets `tombstoned_at` on the downstream
  source row instead of deleting it — deleting would drop the orphaned target out of the stale
  JOIN and the translator would never learn "this line was removed upstream." Tombstoned cells
  are a third category in the §6 response and the §9.5 review panel; actual row removal
  happens only when the downstream resolves the tombstone there.
- **Live mode locks the mirrored lane.** In `live` mode, mirrored source cells — predicate:
  `mode = 'live' AND upstream_event_id IS NOT NULL` — are read-only locally (edits belong
  upstream); the emit path rejects local `source.cell.commit` on them. Downstream-added local
  cells (no `upstream_event_id`) stay editable. `clone` mode has no mirror sync and no lock.

**Seeding is the first mirror sync.** Creating a linked project does *not* bulk-copy
projection rows (`snapshotSourceCells`-style direct inserts would leave `upstream_event_id`
NULL — no §6 join key, no lock predicate, and a spurious full-file refresh burst on the first
real sync). Instead: create the project, write the link with `cursor = 0`, run `mirrorSync` —
files and cells arrive as `file.mirror` + `source.cell.mirror` events through the front door,
with provenance set from birth. (`snapshotSourceCells` remains the *detach* path, where
severing provenance is the point.)

**Triggers** (in order of preference; all funnel into the same function):

1. **On file open / workspace load** — lazy pull. Dormant projects (the long tail of 600)
   catch up exactly when someone looks. This is the self-healing floor.
2. **On push notification** (§8) — connected downstreams sync within seconds of an upstream
   fix.
3. **Manual** — "Check for upstream changes" button in the link settings section, and the
   bulk review panel (§9).

There is deliberately **no** eager server-side fan-out write on the upstream commit path: with
600 downstreams that's write amplification the single-writer store must not absorb, and we
have no queue infra to defer it. The upstream write path only *notifies* (§8).

---

## 6. Staleness: direct and inherited

Two flavors, both derived on read, returned by an extended stale-source endpoint:

```
GET /api/v1/projects/:id/files/:fileId/stale-source
→ { staleCellIds:         [...],  // pin ≠ local source head (exists today)
    upstreamStaleCellIds:  [...], // NEW: inherited — an ancestor hop is stale/behind
    tombstonedCellIds:     [...], // NEW: upstream removed this line (§5)
    behindSeq: { upstream, cursor } | null }  // link-level "you have unmirrored changes"
```

- **Direct stale** — as today: `t.source_event_id != s.event_id`, now computed entirely
  locally (the mirror made the upstream JOIN unnecessary; keep the COALESCE path as fallback
  while migrating), **and hash-aware**: if the two events' `content_hash` match, the cell is
  not stale (this is what lets the mirror skip no-op refreshes, §5). Clone links: always empty.
- **Inherited stale** — the walk must be spelled out, because the obvious implementation
  (join `upstream_event_id`, check the head moved) silently misses the case §9.4 promises:
  English fixed, **French dormant** (never re-translated, never even re-synced), Chaluba must
  still flag. Per hop, ascending from the cell's project D with ancestor U (bounded by the
  existing 32-hop cap; real chains are 2–3; ≤2 cross-project queries per hop, link chain
  cached):

  1. **Mirror check**: D's source cell's `upstream_event_id` vs the head of U's *consumed
     lane* row for that `cell_id` (side per D's `consumes`). Differs with differing hash →
     inherited-stale.
  2. **Ancestor pin check** (only when D consumes U's *target*): U's target row's own
     `source_event_id` vs U's *sibling source row* head (same `cell_id`, `side='source'`,
     inside U). Stale → inherited-stale. ← this side-switch is the step implementers miss.
  3. **Ancestor behind check**: U's own `source_link_cursor` vs *its* upstream's lane-relevant
     max seq; if U is behind and the un-mirrored delta touches this `cell_id`'s lineage, →
     inherited-stale. (Cheap approximation for v1: if U is behind at all, mark the *link*
     `behindSeq` on the response and let the per-cell violet flag come from checks 1–2 only —
     precision per cell requires reading U's un-mirrored delta, which the panel does lazily.)
  4. Recurse: U becomes D; continue until a self-contained project or hop cap.

- **behindSeq** — the file-independent probe (lane-relevant max seq vs cursor, §4) that
  oversight surfaces (ProjectOverview, the FRO-440 graph) show as "N upstream changes to
  review" without per-cell work.

`useStaleSourceCells` grows the two extra fields; `StaleSourceIndicator` gets a second tone
(amber = source changed; violet/hollow = upstream-of-source changed). Finish wiring the badge
into `CellRow` (deferred remnant of Phase 5).

---

## 7. What invalidation does — and does not — touch

- Staleness is a **flag, not a mutation**. Target text is never rewritten; `validated` is NOT
  reset by upstream changes (validation resets only when the target chain head moves — the
  existing projection rule). Rationale: validators are the scarce bilingual experts; a stale
  flag plus an oversight count is the honest signal, and a false-positive invalidation that
  nukes 600 projects' validation state is unrecoverable.
- Resolution paths per cell:
  1. **Re-translate** — normal `target.cell.commit`; pins to the new source head; validation
     resets (chain moved). The default.
  2. **Repin** (`target.cell.repin`, reviewer 300+) — "translation still correct against the
     new source." Pin updates, chain head does not move, validators stand. Guarded by
     `expectedTargetEventId` (§4): if the translator re-committed under the reviewer, the
     repin no-ops rather than clobbering the fresher pin, and bulk repin reports the skips.
     This is the bulk "accept" action for upstream edits that hash suppression didn't catch.
- Detach (exists) and **relink** stay project-lead 500+. Relink = detach + link to a new
  upstream (Ryder's "point them at a different source"); pins to the old upstream become
  ordinary stale flags against the new mirror.

---

## 8. Push layer: lossy accelerator

Hook: in sync-worker `route.ts`, after `db.batch()` commits and per-project frames are
grouped (~line 940), for any project that has downstreams (list from
`projects.source_project_id = :id`, cached in-memory per isolate with short TTL):

```
frame to each downstream's ProjectSync DO:
{ t: 'link.upstream-changed', project: <downstream>,
  upstream: <upstreamId>, untilSeq, fileIds: [...], cellIds: [...capped at 64] }
```

- Sent fire-and-forget via `waitUntil` **after** the response; one `__broadcast` POST per
  downstream per request (PERF-8 shape); downstream list capped (first N with connected
  clients preferred when the DO exposes presence; otherwise cap + rely on lazy pull).
- Client on receipt: refetch stale-source and, if the workspace is open on an affected file,
  request a mirror sync (a `POST /api/v1/projects/:id/link/sync` route on sync-worker that
  runs §5 server-side).
- **Loss is fine by construction**: the cursor probe on next open catches anything missed.
  Push is never load-bearing; delete the feature and the system still converges.

---

## 9. Come and See: the canonical workflow, end to end

1. **Template episode project** (English): timeline file per the multimedia design — dialogue
   lane + subtitle lane + core video, cast labels (`cells.metadata.cast_name`), camera state.
   The one-time work (§6 of the timeline spec): ASR/diarization, cleanup, cast setup.
2. **Create language projects from the template** — the missing FRO-440 UI. Creation writes
   the link (mode: clone vs **live** — a checkbox, not a fork; `consumes: 'source'`), copies
   cast/voice settings and rules, and seeds by running the first mirror sync (§5) — files and
   cells arrive with provenance set, ids preserved. 125 languages today, mandate to 500–600.
3. **Chain hop**: create the Chaluba project *from the French project* with
   `consumes: 'target'` (gate `validated` by default, so Chaluba consumes French *decisions*,
   not per-keystroke drafts) — French validated targets materialize as Chaluba's source lane,
   merged with the structural fields (timing, cast, refs) from French's source rows (§2).
   ("It needs to be there, the French one." — Anna)
4. **An English line is fixed** in the template. Downstreams that are open get the push frame
   and mirror within seconds; the fixed line's targets flag amber in French et al. Chaluba
   immediately shows the violet inherited flag on its descendant of that line (via §6 walk),
   which resolves to amber once French re-commits and Chaluba's mirror advances. Nothing else
   in any project is touched.
5. **Bulk review**: an "Upstream changes" panel (per project) lists flagged cells grouped by
   upstream change batch (`link.cursor.advance` records), with per-cell diff (old mirrored
   text vs new), and bulk actions: re-translate queue, or bulk **repin** for accepted-as-is.
   This is the surface Anna uses instead of the migration tool + off-by-one surgery.
6. **Oversight**: ProjectOverview shows `behindSeq`/stale counts; the FRO-440 graph view shows
   the template with its 600 edges (clone vs live) and per-edge behind/stale counts — Wendi's
   trust surface.

Non-goals for v1 (explicitly): merging the two-projects-per-language split (that's the
timeline file's job), org-level rules (separate thread from the Jun 3 call), LangQuest quest
objects (§10 keeps the shape compatible), multi-upstream links.

---

## 10. Batch sets & LangQuest forward-compat

Every interface in this design already moves **sets**: mirror syncs move seq windows; stale
responses are cell-id arrays; push frames carry capped arrays + "refetch for more"; bulk
repin takes a cell-id list. A LangQuest "quest" is a named cell-set, so "quest went stale" is
a predicate over members (`ANY(member cells) stale`) — a future `cell_sets` table + rollup
query, zero changes to the propagation machinery. We do not build it now; we just don't block
it.

---

## 11. External upstreams: the unfoldingWord pattern

*(Direction for the follow-on agent, who owns UW-repo specifics — DCS/Door43 formats, USFM/
TSV layouts, webhook availability. Everything below is the platform contract; nothing
UW-specific ships in this spec.)*

The pattern: **an external repo is represented as an ordinary upstream project** (an "adapter
project") whose source lane is written by an importer service. Once the adapter project
exists, *everything* in this spec — links, mirror sync, staleness, chains, bulk review —
applies unchanged. The UW agent builds exactly one component: the **git→events adapter**.

Contract the adapter must satisfy:

1. **Stable cell identity.** Derive `cell_id` deterministically from content addressing
   (e.g. `uuidv5(repo + path + book:chapter:verse)` for USFM; file+anchor for prose). This is
   the hard requirement — parser-default fresh UUIDs (subtitle.ts-style) break lineage. Verse
   re-segmentation/renames must map to explicit `cell.delete` + `source.cell.create`, never to
   id churn on unchanged content.
2. **Cursor = commit SHA.** The adapter stores the last-imported SHA per repo/branch (analog
   of `source_link_cursor`). Delta = `git diff <cursor>..HEAD` → changed paths → changed
   cells. Full-scan reconcile on demand (self-heal, same philosophy as §5).
3. **Emit through the front door.** `source.cell.commit` events via the normal
   `POST /events` path with a service account — never raw inserts (same rule as the
   translation agent: real event path only). Deterministic event ids from
   `hash(repo + SHA + cell_id)` for idempotent re-runs.
4. **No-op suppression at the adapter.** Compare normalized content hash before emitting;
   formatting-only commits must not invalidate downstreams.
5. **Trigger tiers**, same shape as §5: webhook if the git host offers one (lossy
   accelerator) → poll on adapter-project open → manual "Sync now". Never load-bearing push.
6. **Auth/permissions.** The adapter service account is maintainer (600) on the adapter
   project only. Downstream links to the adapter project are ordinary links (project leads of
   downstreams; adapter project lead approves nothing — linking is downstream-initiated, as
   with all links).
7. **Deletes and moves.** Removed upstream content mirrors as cell deletion *flags* downstream
   (stale-with-tombstone in the review panel), not silent row deletion — a translator must see
   "this line was removed upstream," mirroring how Anna reviews changes.

What the UW agent must come back with: cell-id derivation rules per UW resource type, the
repo→file mapping (one adapter project per repo? per book?), webhook vs poll cadence, and how
UW's own release tags map to "reviewable batches" (`link.cursor.advance` granularity).

---

## 12. Permissions

| Action | Floor | Notes |
| --- | --- | --- |
| Create link / relink / detach / choose mode | project_lead 500 (downstream) | exists today for link/detach |
| Mirror sync (run/trigger) | any member ≥ viewer 100 triggers lazily; server-initiated | sync writes are server-authored events |
| Repin | reviewer 300 | asserts translation correctness |
| Bulk repin / review panel actions | project_lead 500 | mass state changes |
| See stale flags / behind counts | viewer 100 | read-only derivation |
| Upstream template edit | normal roles in the upstream project | no special cross-project grant |

Sync-token scope note: the mirror sync reads upstream events with a **server-side** upstream
resolution (as stale-source-route does today), not a client cross-project token — clients
never read cross-project.

---

## 13. Failure modes & guarantees

| Failure | Consequence | Recovery |
| --- | --- | --- |
| Push frame lost / DO restart | downstream flags appear late | cursor probe on next open (deterministic) |
| Mirror sync crashes mid-burst | partial mirror, cursor not advanced | deterministic event ids → safe re-run; cursor advances only at the end |
| Same sync triggered twice (push + open) | duplicate events | PK idempotency (existing `readExistingEventIds`) |
| Two syncs interleave, older fold lands after newer | would strand a cell on stale content behind an advanced cursor | prevented three ways: single-flight per downstream DO (§5), monotonic `upstream_seq` apply-guard (§4), `GREATEST` cursor write |
| Upstream comment/audio noise | none — probe counts lane-relevant kinds only | §4 probe definition |
| Upstream archived | mirror pauses; flags freeze | existing downstream-guard warnings; detach snapshots (exists) |
| Upstream hard-deleted | blocked while downstreams exist (exists today) | detach first |
| Clock skew / ordering doubts | none — nothing uses wall clock | seq + event-id comparisons only |
| Neon/D1 drift on new columns | 500s on new routes | ship migrations to both; schema-guard CI |

---

## 14. Rollout slices

1. **Slice 1 — semantics + engine (no UI):** `consumes` flag, link-metadata columns,
   `source.cell.mirror` + `link.cursor.advance` + projection, `POST /link/sync`,
   lazy-pull trigger on file open, extended stale-source response (direct + behindSeq).
   Verifiable end-to-end with two dev projects via API.
2. **Slice 2 — visibility:** inherited staleness walk, badge second tone + CellRow wiring,
   ProjectOverview behind/stale counts.
3. **Slice 3 — creation & review UI:** create-from-template flow (clone/live checkbox,
   consumes choice when picking a source project vs "use its translations"), Upstream-changes
   review panel with diff + bulk repin, `target.cell.repin`.
4. **Slice 4 — push accelerator:** commit-path notify hook + client sync-on-frame.
5. **Slice 5 — graph view** (FRO-440's management surface) + template designation UX.
6. **Slice 6 — external upstream adapter** (unfoldingWord agent, per §11).

Slices 1–2 make the Come and See pilot safe (fixes propagate deterministically even with zero
new UI); 3 is what Anna touches; 4–5 are polish; 6 is a separate workstream.

---

## 15. Open questions

- **Settings seeding fidelity:** the first mirror sync covers files/cells (§5); do we also
  copy rules, TTS voice library, and cast assignments wholesale at creation (probably yes),
  and how do per-language overrides work afterwards?
- **Mirror of non-text payloads:** cast/camera/timing changes upstream (`cast.assign`,
  `cell.retime`) — mirror them always, or only before downstream has diverged locally?
  (Lean: mirror metadata only while the downstream hasn't overridden that field.)
- **Gate default & starvation:** `gate='validated'` is the default for chain links (§2), but
  a middle hop that never validates starves its descendants. Surface "upstream has N
  unvalidated newer commits" on the link, or allow per-link opt-down to `head`?
- **Repin validation semantics:** is "validators stand" right for all partners, or does
  Biblica-style checking want repin to *also* reset validation? (Per-project setting?)
- **Downstream count cap for push:** at 600 live downstreams, do we notify all DOs or only
  those with presence? (Lean: presence-aware, cap 50 per commit, rest converge lazily.)
- **`source_link_cursor` on projects vs a `project_links` table:** columns are simplest for
  one upstream; revisit only if multi-upstream becomes real.
- **Inherited-stale precision at step 3 of the walk (§6):** v1 approximates "ancestor behind"
  at link granularity; is per-cell precision worth reading the ancestor's un-mirrored delta
  in the panel, or is the link-level banner enough?
