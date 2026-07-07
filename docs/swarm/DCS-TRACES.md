# DCS Importer swarm — TRACES

Gaps, deferrals, open TODOs, and honest limitations discovered during the build. Append-only.
Next agent / next wake: pick up anything here.

- 2026-07-06 · start · Wave 1 (Slice A foundation) about to dispatch.
- Deferred by spec (§12), do NOT build in this swarm unless flagged: webhooks/background sync;
  `twl` join tables; `rc://` link-graph + tw/ta reader UI; USFM `\zaln` alignment; shared
  cross-org mirror org; server-side service-account adapter.
- OPEN: adapter-project dedupe within an org — v1 reuse by `(owner/repo)` match on `dcsUpstream`;
  confirm behavior when two users import the same repo.
- OPEN: markdown tw/ta cell-id stability (no ID column) — content-hash matching mitigates; may
  show spurious delete+create on structural reflow. Lowest priority (Slice E tail).

## Slice A (foundation) — done 2026-07-06, branch `claude/dcs-slice-a`

Built `src/lib/dcs/{content-hash,cell-id,catalog,manifest,resource-map,import-dcs,delta,cursor}.ts`
+ `.test.ts` (TDD). tsc `-p tsconfig.app.json` = 0 errors; `vitest run src/lib/dcs` = 46 passed;
eslint clean; no `any` in implementation files. NOT pushed.

**SWARM-TODOs / deferrals left in code:**
- `resource-map.ts` — only the **USFM route** is implemented. OBS / TSV notes+questions / md
  tw+ta routes are a `// SWARM-TODO(Slice E)` in `ROUTES`. `routeFor()` returns `null` for
  unrouted resources and `importDcsResource` throws a clear "no import route" error.
- `import-dcs.ts` — `fileTypeForRoute()` only maps `usfm`; Slice E extends it (obs/tsv/md).
- `delta.applyDelta` takes an **injected `DeltaEmitters`** (create/commit/delete) rather than
  importing `events-emit.ts` directly — Slice A stays pure/testable and does not touch the
  forbidden existing file. Slice C wiring must bind these to `source.cell.create` /
  `source.cell.commit` (chained on `parentEventId`) / `source.cell.delete`. NOTE: the event kind
  is `source.cell.delete` (there is no bare `cell.delete` kind); `emitSourceCellDelete` exists in
  `events-emit.ts`, but there is **no `emitSourceCellCommit` helper yet** — Slice C must add one
  (or call `enqueueEvent({ kind: "source.cell.commit", parentId, payload: { value, valueHtml } })`).

**Assumptions about the live DCS API to verify against git.door43.org (mocked in tests):**
- `/catalog/search` returns rows under a `data[]` array; fields are snake_case
  (`full_name`, `content_format`, `branch_or_tag_name`, `ref_type`, `commit_sha`, `zipball_url`,
  `metadata_url`, `language*`). The catalog-search filter param for content format is guessed as
  `metadataType` — VERIFY the real param name.
- `/catalog/entry/{owner}/{repo}/{ref}` returns the archive URL as **`tarbar_url`** (sic); the
  normalizer prefers `zipball_url` then falls back to `tarbar_url`. VERIFY which key prod sends.
- `compare` changed files = union of `.commits[].files[].filename` (top-level `.files` empty) —
  matches the spec §6 verified fact; re-confirm on a real v88→v89 fetch.
- `git/trees/{ref}?recursive=1&per_page=99999` returns `{ tree: [{ path, type: "blob"|"tree" }] }`.
- Raw files at `https://git.door43.org/{owner}/{repo}/raw/{tag|branch}/{ref}/{path}`.
- Manifest is fetched at repo-root `manifest.yaml` via `fetchRaw` (not the catalog `metadata_url`);
  if some repos only expose it via `metadata_url`, import-dcs/delta need a fallback.

## Slice E (OBS + TSV notes/questions routes) — done 2026-07-06, branch `claude/dcs-e-routes`

Refactored `resource-map.ts` to import per-format routes from a new `src/lib/dcs/routes/`
directory. Added OBS, TSV-notes, TSV-questions routes + tests. `routeFor`/`ROUTES` behavior is
unchanged for USFM (still first in the ordered list). tsc `-p tsconfig.app.json` = 0 errors;
`vitest run src/lib/dcs` = 72 passed (11 files); eslint clean on all touched files; no `any`.

Files: `routes/usfm.ts` (moved verbatim), `routes/obs.ts`, `routes/tsv-notes.ts`,
`routes/tsv-questions.ts`, `routes/tsv-common.ts` (shared header-driven TSV parser + book-code /
canonical-ref helpers), and their `*.test.ts` (obs 6 / tsv-notes 9 / tsv-questions 9).

Resource → cell mapping (unit + id seed):
- **OBS** (`obs`): one story frame → one cell. Reuses `parseObsStories`; seed `${repo}|OBS
  story:frame` (from the parser's `group`). Carries `metadata.attachments` (frame image) through.
  One DcsFile per `NN.md` story file (front/back matter skipped).
- **TSV notes** (`tsv-notes`): one row → one cell, translatable = the `Note` column; seed
  `${repo}|${book}|${rowID}` (TSV `ID` col). `SupportReference/Quote/Occurrence/Tags` → metadata.
- **TSV questions** (`tsv-questions`): one row → one cell, translatable = `Question` (+`Response`
  when present, labelled `Question:`/`Response:`); same `${repo}|${book}|${rowID}` seed. Rest → metadata.

**Design decision — did NOT reuse `translation-notes.ts`.** The spec (§4) requires column-precise
prose isolation (strictly the `Note` column) and a specific metadata split
(`SupportReference/Quote/Occurrence/Tags`) plus a cell-id seeded on the TSV `ID` column.
`parseTnTsv` drops the row `ID` from cell identity (mints `uuidv7`) and tab-joins ALL non-metadata
columns into one body, so it cannot satisfy §5 stability or the metadata contract. The routes parse
columns directly via `routes/tsv-common.ts` instead (header-driven, BOM/CRLF-robust). This is the
Rule-7 "pick the more-correct pattern" call, not silent duplication.

**Fixed a stale Slice-A test premise (surgical).** `import-dcs.test.ts`'s "throws when no route
matches" used `identifier: tn` / `subject: TSV Translation Notes` as its unrouted example — exactly
what Slice E now routes. Repointed the fixture to a still-unrouted markdown Translation Words
resource (`type: dict, identifier: tw`), preserving the test's intent. This was the only red test
after routing; suite is green again. (Touched a Slice-A-owned test file — flag for the Slice-A owner
if ownership is strict; the impl `.ts` files were left untouched.)

**SWARM-TODO(Slice E tail) — markdown tw/ta NOT built (lowest priority, spec §12).** Marked in
`resource-map.ts` above `ROUTES`. Translation Words (`md-dict`) + Translation Academy (`md-manual`)
need a markdown-block parser (split each article at top-level headings / blank-line blocks) with id
seed `${repo}|${path}|${blockIdx}`. These are id-UNSTABLE (no ID column) — content-hash matching in
the mirror engine absorbs reflow, structural edits map to explicit `cell.delete` + `source.cell.create`
(spec §4/§5, and the OPEN item at the top of this file). `routeFor` returns `null` for them today, so
`importDcsResource` throws its clear "no import route" error (verified by the repointed test above).

**Note for import wiring (Slice A/C):** `import-dcs.ts:fileTypeForRoute` still only special-cases
`usfm`; it falls through returning the route id verbatim for `obs`/`tsv-notes`/`tsv-questions`. If the
server projection needs a specific `FileType` for these (e.g. `obs` → "obs", TSV → "tsv"), refine that
map — it is a Slice-A-owned file, out of Slice E's scope.
