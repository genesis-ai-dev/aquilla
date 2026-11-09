# Virtual source cells: a file is a blob, a filter stamp, and a revision chain

*Draft 2026-11-06. Ticket AQU-2459. Status: increments 1, 2 and the fresh-import half of 3
implemented on `aqu-2459-virtual-source-cells`; the rest is planned below.*

## Problem

Today a file's source side is N `source.cell.create` events plus N `cells`
rows, minted by the client at import time with random cell ids
(`src/lib/import.ts::emitParsedFile`, `sync-worker/src/events/import-route.ts`).
Four things follow from that, and all four hurt:

1. **Import is slow** because the bottleneck is inserting thousands of event +
   cell rows, not parsing.
2. **Upstream updates are a second system.** Re-import
   (`import-reconcile-route.ts`), link mirroring (`link-sync.ts`), DCS delta
   (`src/lib/dcs/delta.ts`) and the LangQuest planner each re-derive identity
   their own way. AQU-2380 found that an edited source paragraph is a
   delete + insert that hides the translation.
3. **Nothing can be live.** A Google Drive folder, a git repo of localization
   strings, a LangQuest passage set: each needs a connector that re-imports,
   because there is no cheap, deterministic "the blob changed, what moved?".
4. **Export cannot trust the parser.** The walk stamp exists
   (`docs/decisions/0001-parser-version-stamps-and-re-import.md`) but the
   cells are not derivable from the blob, so a stamp mismatch can only refuse.

## Decision in one paragraph

A file's source side becomes **derived state**: an immutable source artifact
(already in R2), a **filter stamp** `<filterId>@<walk>` plus options, and a
**revision chain**. Each revision is one parse of one blob, aligned against the
previous revision so every unit carries a stable **cell id** (identity across
revisions) and a **content hash** (what was translated). A revision is written
as ONE event and one manifest, never N cell events. Target cells stay exactly
what they are: rows in `cells` chained by events, pinned to a source content
hash. Existing projects keep working unchanged: a file without revisions is a
"materialized" file and takes the legacy path; every file imported after the
cutover is stamped and revisioned.

## What the open-source TMSs taught us (2026-11-06 survey)

| Tool | Identity | Source update | Take |
| --- | --- | --- | --- |
| Weblate (GPL) | `id_hash = hash(context)` for monolingual, `content_hash = hash(source, context)`; `expected_source_hash` CAS on save | on pull: same id, changed source → `NEEDS_REWRITING`, keep `previous_source`, restore state if reverted | **two-tier identity + stale flag, never delete the translation** |
| Tolgee (Apache) | key name in namespace | base text change → `outdated=true` on every translation; cleared on human edit | the flag clears only on a human write |
| Localization OS (Apache) | documents: `order_index` (positional); keys: `(ns,name,context)` + `KeyChangeLog` tombstone feed; splitter stamped `seg_engine` | documents: re-ingest refuses if any target exists; keys: `source_changed` QA flag | **stamp the splitter; connectors keep a last-seen hash and CAS on write (Docs `requiredRevisionId`, git head sha)** |
| OpenLoc (BSL 1.1) | `segment_key` = JSON path or `block:N` | XLIFF re-import classifies rows; no source diff | reference only, licence forbids reuse |
| Okapi / XLIFF 2 | counters `tu1…`; skeleton = original + manifest | — | **the original blob is the only skeleton that cannot drift** |

Nobody in that set has deterministic identity for positional documents across
edits. That is the gap this design fills: alignment, not position, assigns ids.

## Vocabulary

- **Artifact** — the uploaded bytes, content-addressed by sha256, in R2
  (`artifacts`, `file_source_blobs`). Immutable.
- **Filter** — a `FormatFilter` (`src/lib/formats/contract.ts`):
  `parse(bytes) → units`, `build(skeleton, translations) → bytes`.
- **Filter stamp** — `<filterId>@<walk>` plus a stable hash of the parse
  options (`cellUnit`, partner profile, …). Same stamp + same bytes ⇒ same
  unit list, byte for byte. A stamp never changes meaning; a changed walk is a
  new stamp (decision 0001).
- **Unit** — one parse output: `unitKey` (the locator-derived
  `aquillaImport.unitKey`), `contentHash`, text, html, type, canonicalRef,
  metadata, `sequenceIndex`.
- **Revision** — `(fileId, revisionN, artifactSha, stamp, parentRevisionN)`
  and its **manifest**: the aligned unit list where every unit has a
  `cellId`. One `file.revision` event per revision.
- **Cell id** — identity across revisions. Assigned by alignment, never by
  position. Revision 1: `uuidv5("cell:" + unitKey, fileId)`; an inserted unit
  in revision N: `uuidv5("cell:r" + N + ":" + unitKey, fileId)`. Deterministic:
  replaying the revision chain re-derives every id.
- **Content hash** — `uuidv5(normalizedText, CONTENT_NS)` (SHA-1, 122 bits;
  the 32-bit djb2 in `event-projection.ts::contentHash` stays as the cheap
  change marker it already is). Normalization is the one already used by ICE
  matching (`import-content-match.ts::normalizeForMatch`).

## The alignment algorithm (shared, pure)

`db/shared/file-revision.ts::alignRevision(parent, next)` runs in the browser,
the parse worker and the sync-worker, and is the single place that decides what
an upstream change *is*:

1. **Reference-addressed units** (scripture refs, JSON key paths, XLIFF
   trans-unit ids, LangQuest unit ids — anything whose `unitKey` is not
   positional) pair by `unitKey`. Same hash → `equal`; different → `changed`.
2. **Positional units** pair by longest common subsequence over
   `contentHash` → `equal`. Within each gap, old and new runs pair in order
   when `similarity ≥ 0.6` (token Dice) → `changed`; an identical hash found
   elsewhere → `moved`; the rest are `inserted` / `deleted`.
3. Output: a `RevisionDelta` with every next-revision unit carrying its
   `cellId`, and every deleted parent unit listed for tombstoning.

Properties that the tests pin:

- Insertion between two paragraphs shifts nothing; the neighbours keep their
  ids (fixes AQU-2380 finding 1's class of bug at the identity layer).
- An edited paragraph keeps its id and is `changed`, so its translation stays
  attached and is flagged stale instead of hidden.
- Pure function of `(parent manifest, next units)`: replay-safe, testable
  without a database.

## Staleness and the AD-9 pin

A target commit is pinned today to the source head `event_id`
(`cells.source_event_id`), and `stale-source-route.ts` compares the pinned
event's payload text with the current source when the ids differ. A bulk
revision event carries no per-cell text, so it cannot be the pin for every
cell. The rule that keeps AD-9 intact (`file-revision-apply.ts`): **`equal` and
`moved` units keep their source row's `event_id`; only `changed` and `inserted`
units take the revision event id.** Targets pinned to unchanged cells stay
fresh with no query change; a changed cell's pin now points at an older event
whose text differs, so it reads stale exactly as a `source.cell.commit` does
today. Increment 4 moves the stale check onto content hashes directly. `db/shared/file-revision.ts::classifyTargetStaleness` is the
pure form of that rule, with Weblate's revert case: if the hash comes back to
what the target was pinned against, the target is `fresh` again.

Rules carried over from the survey: a stale translation is never deleted or
overwritten by a machine; the flag clears only on a human commit or an explicit
repin (`target.cell.repin`), which already exists.

## Storage and read path

```
file_revisions
  file_id, revision_n            PK
  project_id
  artifact_sha256                → artifacts / file_source_blobs
  filter_stamp                   "<filterId>@<walk>"
  options_hash
  parent_revision_n              NULL for revision 1
  manifest_r2_key                JSON manifest (units + cellIds), gzip
  unit_count, inserted, changed, moved, deleted
  event_id                       the one file.revision event
  created_at, created_by, origin ("import" | "reimport" | "drive" | "git" | "dcs" | "langquest" | "adopt")
files.head_revision_n            NULL ⇒ materialized (legacy) file
```

**Phase A (compat, increment 2):** applying a revision still writes `cells`
source rows, set-based in one statement per 1000 rows from the manifest
(`event-projection.ts::buildBulkSourceCellCreateStmt`, reused so the column
list cannot drift), anchors rewritten in document order, deletes as
`tombstoned_at`. The manifest is JSON in R2 at
`revisions/<project>/<file>/<n>.json` (`file-revision-sql.ts::revisionManifestKey`)
and remembers each unit's `eventId`. Route: `POST
/api/v1/projects/:p/files/:f/revisions` (`sync-worker/src/events/revisions-route.ts`),
lead role, body `{artifactSha256, stamp, optionsHash?, origin?, units[]}`;
same artifact + stamp + options as the head is a no-op. The revision event id
is `uuidV5("revision:<n>:<sha>:<stamp>", fileId)`, so a replayed request is
idempotent through the events PK.
There are no per-cell event rows and no chain claims. Every reader that joins
`cells` (FTS, by-ref, milestones, progress, Agent API, comments) keeps working.
This alone removes the N event inserts and the claim writes from import.

**Phase B (virtual):** `cells-read-route.ts` serves the source side of a
revisioned file from the manifest (cached per isolate by
`(fileId, revisionN)`, ETag already carries the file epoch) and joins target
rows by `cellId`; ordering is `sequenceIndex`, which replaces the anchor-chain
walk for these files. The `cells` source projection becomes optional per file
and is dropped once the readers above move to the manifest or to a
`source_units` view. Phase B is where import stops paying for N inserts at all.

## Live integrations become one loop

Re-import, "Update this file", link mirroring, DCS delta, Google Drive and git
are all the same four steps, in the sync-worker:

```
bytes ← connector.fetch(ref)              (Drive fileId, git path@sha, DCS, upload)
sha   ← sha256(bytes); if sha == head.artifact_sha256 → no-op
units ← filter(stamp).parse(bytes)        (worker-safe filters; DOM filters parse client-side and POST units)
rev   ← alignRevision(head.manifest, units) → write artifact + manifest + file.revision
```

Connectors own only `fetch` and a cursor (Drive `modifiedTime` / `headRevisionId`,
git head sha, DCS catalog sha). Polling is a sync-worker cron (the project
already has three); webhooks are an accelerator. A connector keeps the
last-seen sha so an unchanged source costs one HEAD request. Write-back
(export to Drive / a git branch + PR) is the mirror image and out of scope here;
LOS's rules apply when it lands: CAS on the upstream revision id, branch + PR
never the base, drop the stored hash on an incomplete write.

LangQuest (AQU-2442) becomes a *unit provider*: its `planSync` emits units
keyed by the LangQuest unit id and the revision path does the rest. The
`source.cell.create` branch there is the only thing removed, as that ticket
asks.

## Existing projects

- A file with `head_revision_n IS NULL` is **materialized** and untouched. All
  current routes keep their behaviour for it.
- **Adopt** (optional, per file, idempotent): revision 1 is written from the
  file's current source cells *as they are* — existing cell ids, existing
  order, the file's stored `parserVersion` as the stamp, the stored blob as the
  artifact. No realignment, so no id changes, no translation loss. From then on
  the file takes the revision path. Adopt is what re-import and link sync call
  first when they meet a materialized file, so the cutover is lazy and needs no
  flag day.
- Files whose blob was never stored, or whose stamp names a walk the current
  filter cannot reproduce, cannot be adopted and stay materialized; that is
  the `ReimportRequiredError` case from AQU-2382 and is reported, not hidden.

## Increments

| # | Scope | Done when |
| --- | --- | --- |
| 1 | `db/shared/file-revision.ts`: stamps, ids, content hash, `alignRevision`, `classifyTargetStaleness`, manifest types; tests. Decision record 0008. | `pnpm test db/shared/file-revision.test.ts` green; pins resolve. **This PR.** |
| 2 | Migration `0197_file_revisions` + `files.head_revision_n`; `POST …/files/:f/revisions` (units → revision; Phase A projection); `file.revision` event kind; adopt. | **Done.** `sync-worker/src/__tests__/revisions-route.test.ts`: second call is one event, cells keep ids, inserted paragraph gets a new id, edited one is `changed`, a pre-revision target reads stale only on the edited cell, a legacy file adopts with every id intact. |
| 3 | Client import goes through revisions when the format has a `FormatFilter` (docx, pptx, idml, html, xliff, srt, vtt), falling back to the legacy bulk route otherwise. | **Fresh imports done** (`src/lib/sync/revision-import.ts`, gate `canImportAsRevision`; kill switch `VITE_IMPORT_VIA_REVISIONS=0`): one `/import` call with zero cells creates the file, the bytes go to R2, one revisions POST carries the units. Rebuild replays revisioned files from their manifests (`rebuild.ts`). **"Update existing" re-import done** (`bulk-import.ts::reviseSourceImport`): the route aligns by content (an inserted paragraph no longer moves later translations, as reconcile's position keys did), merges `files.meta` and moves the source pointer in the same batch, and re-adopts a file whose cells moved past its head (`file-revision-apply.ts::liveUnitsIfDrifted`). Removed units are tombstoned and hidden. A `?since=` read past a revision answers `resync`. **Left:** the sidebar review apply and "Make updated copy" still use `/import/reconcile`; linked-project mirroring of revisioned files; import timing on the 10k-cell fixture; e2e import/export journeys on a preview. |
| 4 | Phase B read path behind a per-file flag; manifest cache; `sequenceIndex` ordering. | Cells route serves a revisioned file with no `cells` source rows; smoke suite green. |
| 5 | Connectors: Drive and git fetchers + cron; DCS delta and LangQuest planner rewritten as unit providers. | A Drive doc edited upstream shows `changed` cells in Aquilla within one cron tick with no re-import. |

## Not covered yet

- **Rebuild without R2.** Rebuild reads every `file.revision` manifest from
  R2 before its transaction and replays cells from them
  (`file-revision-apply.ts::buildCellStmtsFromManifest`); a manifest that
  cannot be read fails the rebuild loudly rather than leaving a file empty.
  The projection-snapshot path (AQU-1833) seeds from `cells` rows and is
  unaffected.
- Server-side parsing. The route takes parsed units; connectors and the
  worker-safe filters feed it in increment 5.
- Export through `build(skeleton, translations)` with the stamp selecting the
  walk is AQU-2382's work and stays there; this design only guarantees the
  stamp is always present and the units are reproducible.
- Splitting or merging cells by hand on a revisioned file: hand edits to the
  source side of a revisioned file are a *local revision* (a unit list edit
  with its own stamp `aquilla:manual@1`) and are aligned like any other; the
  UI for that is increment 3's follow-up.
- Write-back connectors.
- Cross-file moves (a paragraph moved to another document) are `deleted` +
  `inserted`; only within-file moves are detected.
