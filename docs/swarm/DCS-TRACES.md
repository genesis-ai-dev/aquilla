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
## Slice C (delta wiring + upstream panel) — done 2026-07-06, branch `claude/dcs-c-delta-wiring`

Added `emitSourceCellCommit` (ADD-ONLY) to `src/lib/sync/events-emit.ts`, new
`src/components/dcs/DcsUpstreamPanel.tsx` (+ `.test.tsx`), mounted the panel in
`src/components/ProjectSettings/SourceLinkSection.tsx`. tsc `-p tsconfig.app.json` = 0 errors;
`vitest run src/lib/sync/events-emit src/components/dcs` = 34/34 (4 files); eslint clean; no `any`.
NOT pushed.

Contract wired exactly as Slice A specified:
- `applyDelta`'s injected `DeltaEmitters` bind to → `commit`: `emitSourceCellCommit({ parentId:
  parentEventId, id: eventId, value, valueHtml })`; `delete`: `emitSourceCellDelete`; `create`:
  `enqueueEvent({ kind: "source.cell.create", id: eventId, parentId: null, payload })` directly
  (NOT `emitSourceCellCreate`, which has no `id` param — bypassing it keeps events-emit ADD-ONLY
  while still stamping the deterministic `dcsEventId` so re-runs dedupe).
- `emitSourceCellCommit` signature (symmetrical with `emitSourceCellDelete`, plus a `parentId` +
  optional deterministic `id`):
  `emitSourceCellCommit({ projectId, fileId, cellId, parentId: string|null, value, valueHtml?,
  id?, author, clientTs? }) → Promise<string>` — emits `{ kind: "source.cell.commit", parentId,
  payload: { value, valueHtml? } }` through `enqueueEvent`.
- `currentCells` built by NEW internal `buildCurrentCells()` in the panel: `fetchProjectFiles` →
  per file `fetchAllFileCells(side:"source")`, hashing each row's `value` with the shared
  `@/lib/dcs/content-hash` djb2 → `Map<cellId,{ eventId: row.eventId, contentHash, fileId }>` =
  the `CurrentCell` shape. Token minted via `buildFileScopedTokenFetcher` (project-scoped; any
  fileId works for reads), same pattern as the AQU-478 Upstream-changes panel.
- Cursor advanced with `buildCursor(newEntry, cursor.trackMode)` and persisted via
  `useProjectSettings().patch({ dcsUpstream })`. `applyDelta` ctx = `{ repo: newEntry.fullName,
  sha: newEntry.commitSha }` — matches `import-dcs.ts`'s `dcsEventId(fullName, commitSha, cellId)`.
- Import gated at MAINTAINER (600) per spec §11 (importer is maintainer of the adapter project);
  also clears the role-policy PROJECT_LEAD(500) floor on `source.cell.*`.

**SWARM-TODOs / deferrals:**
- MOUNT-GATING GAP (orchestrator owns `ProjectSettings.tsx`, which I may NOT edit): the panel is
  mounted inside `SourceLinkSection`, which `ProjectSettings.tsx` only renders when
  `hasSourceLink` (a non-null `sourceProjectId`, i.e. a DOWNSTREAM link). A SELF-CONTAINED DCS
  adapter project (the common case — no `sourceProjectId`) never shows `SourceLinkSection`, so the
  panel won't appear there. The panel itself is correctly self-gated (renders null without a
  `dcsUpstream` cursor). FIX (one line, `ProjectSettings.tsx`): also mount the panel — or a
  dedicated `section-dcs-upstream` — when `readCursor(settings)` is non-null, independent of
  `hasSourceLink`. Left to the orchestrator since `ProjectSettings.tsx` + `project-settings.ts`
  are outside Slice C's owned files. The dev-proof (Wave 3) should re-pin an adapter that IS a
  downstream link (so the section shows) OR land the one-line gate first.
- `ProjectWideSettings` (`src/lib/sync/project-settings.ts`) has NO `dcsUpstream` key — the panel
  reads via `readCursor(settings as Record<string, unknown>)` and writes via
  `patch({ [DCS_UPSTREAM_KEY]: cursor } as Record<string, unknown>)` (JSONB passthrough; no schema
  migration per spec §8). Adding `dcsUpstream?: DcsCursor` to `ProjectWideSettings` additively
  would drop both casts — a nice-to-have for another owner (that file is not Slice C's).
- create-emitter fileId: a brand-new upstream cell has no existing projection row, so
  `buildCurrentCells` can't map its fileId. The panel currently falls back to `cell.cellId` as the
  fileId placeholder for creates. This is WRONG for multi-file books (the created cell lands under
  a synthetic file id). Not exercised by the v88→v89 en_ult delta (all changed cells already
  exist), but Slice E / a book-addition delta needs `DcsCell` to carry its parsed `fileId` (or the
  delta to return creates grouped by file). Flagged for whoever extends the delta result shape.
- LIVE INVALIDATION IS UNPROVEN HEADLESSLY: unit tests prove the wiring (applyDelta called with
  real emitters, cursor persisted), but that moving a source head actually flags downstream
  linked targets stale can only be shown against the dev stack + live git.door43.org. Wave 3
  browser-QA owns that proof (import book@vOLD, link a language project, translate, Import changes
  → vNEW, observe stale flags + Upstream-changes review panel).

---

## Slice B (import UI) — traces & deferrals · 2026-07-06

**Delivered:** `src/components/dcs/DcsCatalogBrowser.tsx` (catalog search + filters + pick) and a
surgical ImportDialog edit adding a "Door43 (DCS)" source that runs `importDcsResource` into the
CURRENT project then pins the release via `project_settings.dcsUpstream`. Wired at the render site
in `ProjectWorkspace.tsx` (`patchDcsCursor` → `useProject().patchSettings({ dcsUpstream })`).

**Token/projectId path:** identical to OBS/eBible — ImportDialog receives `projectId` +
`getToken(fileId) => Promise<string|null>` as props (from ProjectWorkspace's
`getTokenForFile` = `buildFileScopedTokenFetcher`) and threads them straight into
`importDcsResource({ projectId, getToken })`.

**Settings-patch client:** `useProjectSettings().patch` (exposed as `useProject().patchSettings`),
which merges the partial over fresh server settings and PUTs the whole blob to
`PATCH /api/v2/projects/:id/settings`. Server schema is `z.record(string, unknown)` (accepts the
new `dcsUpstream` key); server floor is MAINTAINER(600). Added `dcsUpstream?: DcsCursor` to
`ProjectWideSettings` (spec §8) — additive, no migration.

**SWARM-TODOs / deferrals for Wave 3 (Slice C) + follow-ups:**
- **No FileReference optimism after DCS import.** `importDcsResource` returns only
  `{ files, cells, cursor }` (no per-file ids/names), and `src/lib/dcs/**` is read-only, so the
  DcsPanel calls `onImported([], …)` and relies on the parent's `refresh()` + `revalidateCells()`
  to pull the server projection. Consequence: the imported file is NOT auto-opened and does not
  appear optimistically — it shows after the server round-trip. If Slice C wants auto-open, extend
  `ImportDcsSummary` to return `{ fileId, name }[]` and map to FileReferences here.
- **DCS option gated on `patchDcsCursor`.** When the host can't persist settings (unsynced
  local-only project, or ImportDialog rendered without the prop — e.g. the existing tests), the
  Door43 card is hidden. This is intentional (can't pin a release). Below-MAINTAINER users still
  SEE the card (the prop is present) but the pin PATCH returns non-ok → the success screen shows
  "Imported, but couldn't pin the release." The source cells still land.
- **Only USFM imports today.** `resource-map.ROUTES` = `[usfmRoute]` on the integration branch, so
  picking a non-Bible resource (OBS/TSV/markdown) throws "No import route for …" from
  `importDcsResource`; the DcsPanel surfaces it as an error and returns to browse. The browser does
  NOT hide unsupported subjects (the catalog search returns them) — Slice E enables the routes.
- **Catalog `stage=latest`/`preprod` untested against prod.** The Stage filter offers
  prod/preprod/latest; only `prod` is on the spec's happy path. Verify the DCS search honours these
  stage values (and that `latest`=HEAD behaves) in Wave 3 live QA.
- **Adapter-project dedupe (spec §15) NOT implemented.** Re-importing the same repo into the same
  project just re-runs the idempotent import (server /import dedupes by deterministic event id) and
  re-pins. No "you already imported en_ult" guard. Acceptable for v1; revisit with §10 cross-org
  sharing.
- **Live browser proof owed (Wave 3).** Everything verified headlessly (tsc + 28 vitest). The real
  catalog fetch, the Select-in-Dialog interaction (happy-dom can't drive Base UI Select portals
  reliably — filter Selects are untested at the unit level, only the text inputs + row-pick are),
  and the end-to-end import-then-pin against live git.door43.org are for the browser-QA agent.

## Live-proof findings — 2026-07-06 (see DCS-PROOF.md)

- Adapter VERIFIED on live git.door43.org: en_tn TIT v87→v89 → exactly 1 changed note detected
  (206 rows, 1 commit, 0 spurious); en_ult TIT v80→v89 → 1 commit + 2 deletes, cell-ids STABLE
  across releases. Fetch/manifest/parse/delta all real.
- FINDING 1 (follow-up, high priority for Bible UX): USFM route does NOT strip `\zaln`/`\w`
  alignment markup — cell values carry alignment attributes. Pre-existing `usfm.ts` behavior (not a
  DCS regression). Add alignment stripping to the USFM route/parser for clean verse text. TSV/OBS
  routes are clean. en_tn is the recommended first-use + demo target.
- FINDING 2: `compare` endpoint throttles (empty body under rapid requests). VERIFY delta.ts has
  backoff + full-scan reconcile fallback (spec §6); add if missing.

## Adversarial review findings — 2026-07-06

- FINDING 1 (BLOCKER) — FIXED: delta CREATE assigned a phantom fileId (cell id) → new upstream
  cells orphaned into a non-existent file, invisible in adapter + downstreams; test suite masked
  it (no fileId assertion on the create call). Fix: thread parsed `file.fileId` through
  `DeltaResult.creates` → `CreateArg` → the create emitter; commit/delete were already correct
  (fileId from currentCells). Tests now assert the create fileId. Commit on integration.
- FINDING 2 (minor, follow-up): trackMode:"head" cursors can't detect a delta —
  `compareRefs(cursor.ref, latest.ref)` becomes compare(main...main) → empty. Dead config today
  (every cursor is created with trackMode:"release"), but the "tracking HEAD" badge advertises a
  mode that wouldn't work if wired. Fix later: for HEAD, compare stored commitSha...branch HEAD
  (or commits-since-SHA), or drop the HEAD option until wired.
- FINDING 3 (minor, follow-up): a wholly-NEW upstream FILE (a book added mid-resource) still emits
  no `file.create`, so its cells would lack a files row. Finding-1's fix handles new cells in
  EXISTING files (the common case); a brand-new file needs file.create wiring (thread the DcsFile
  name/bookCode + a file.create emit when a created cell's fileId isn't among existing files).
  Narrow case; flagged for the aligned-target / hardening pass.

## UI-defect fixes — 2026-07-07, branch `claude/dcs-fix-ui`

Fixed the four live-browser-QA defects from `docs/swarm/DCS-UIQA.md` (unit tests + mocks missed
all four). tsc `-p tsconfig.app.json` = 0 errors, no `any` in source; `vitest run src/lib/dcs
src/components/dcs` = 94 passed (13 files). Each fix carries a regression test. NOT pushed.

- DEFECT 1 (BLOCKER) — FIXED: `DcsClient` stored an UNBOUND native `fetch`
  (`opts.fetchImpl ?? fetch`) → every real-browser DCS call threw `TypeError: Illegal invocation`
  (native fetch needs `this === window`). Fix: `opts.fetchImpl ?? fetch.bind(globalThis)`
  (`catalog.ts` ctor). Injected `fetchImpl` path unchanged. Guard: new `catalog.test.ts` test
  spies `globalThis.fetch` (asserting `this === globalThis|undefined`) and drives the NO-fetchImpl
  default path — VERIFIED to FAIL against the unbound form and PASS with the bind. NOTE: the
  actual `Illegal invocation` throw only reproduces in a real browser (happy-dom's fetch tolerates
  a rebound `this`), so the test guards the *binding contract*, not the browser throw itself.
- DEFECT 2 (major) — FIXED: `DcsCatalogBrowser` seeded the initial `lang` filter from the
  project's source-language DISPLAY NAME ("English") → the app's own first search fired
  `?lang=English` → 0 results (DCS matches ISO codes: `?lang=en`). Fix: new
  `toDcsLangSeed()` (in `src/lib/dcs/lang-seed.ts` — kept out of the component so the file only
  exports a component, react-refresh clean) normalizes the seed to a short ISO code via
  `@/lib/language-normalize`
  (reverse-mapping its 639-2/T 3-letter output back to the 2-letter GL code DCS uses); codes with
  a region subtag (`es-419`) or already-short codes pass through verbatim; an unmappable word →
  `""` (never leak a display name). `useState(() => toDcsLangSeed(defaultLang) || "en")`. Guard:
  `DcsCatalogBrowser.test.tsx` asserts the initial `searchCatalog` param is `en` (from
  `defaultLang="English"`), `es-419` passes through, and `toDcsLangSeed` unit cases.
- DEFECT 3 (BLOCKER for delta flow) — FIXED: `DcsUpstreamPanel` "Check for updates" resolved the
  entry AT the pinned ref (`getCatalogEntry(owner, repo, cursor.ref)`) → for a release-tracking
  cursor at v8 it compared v8-vs-v8 → always "up to date", never seeing a NEW tag (v8→v9). Fix:
  new `DcsClient.getLatestRelease(owner, repo)` (catalog search `stage=prod`, newest `released`);
  the panel now resolves the latest prod release and only falls back to the pinned-ref entry if
  that returns nothing. "Import changes" deltas `cursor.ref` → `latest.ref` (unchanged path, now
  fed the real latest). Guards: `catalog.test.ts` `getLatestRelease` (newest-wins + null);
  `DcsUpstreamPanel.test.tsx` — latest v89 vs cursor v88 shows the update (asserts
  `getLatestRelease` called, NOT "up to date"), latest==cursor shows "up to date".
- DEFECT 4 (major, design) — FIXED: `dcsEventId(repo, sha, cellId)` had NO project scope →
  importing the same DCS resource into two projects minted IDENTICAL event ids; the server events
  PK + `INSERT OR IGNORE` silently dropped the second project's import. Fix: signature is now
  `dcsEventId(projectId, repo, sha, cellId) = uuidv5(`${projectId}|${repo}|${sha}|${cellId}`,
  DCS_NS)`. Cell ids stay content-addressed (cells PK is already project-scoped). Callers updated:
  `import-dcs.ts` `toBulkCells` (threads `args.projectId`), `delta.ts` `applyDelta` (ctx gains
  `projectId`), `DcsUpstreamPanel.tsx` (passes `projectId` into the applyDelta ctx). Determinism
  preserved per `(project, repo, sha, cell)` → same-project re-run still dedupes. Guards:
  `cell-id.test.ts` (two projectIds → different ids, same projectId → same id), `delta.test.ts` +
  `import-dcs.test.ts` (same resource into two projects → different EVENT ids, identical CELL ids).

## Live M2 proof + delta-scoping fix — 2026-07-07 (DCS-UIQA-M2.md)

- MILESTONE 2 PROVEN LIVE: en_tn TIT adapter@v87 → 2 UI-linked downstreams (Spanish+French, 206
  mirrored cells each) → translated cells → "Check for updates" showed v87→v89, 55 files → Import
  changes → BOTH downstreams flagged the changed note STALE (amber "Source changed" + "Upstream
  changes: 1 flagged" w/ old→new diff), server-asserted after reload, precise (unchanged cells not
  flagged). Defects 1/3/4 confirmed fixed in a real browser.
- NEW defect FOUND + FIXED: computeDelta scoped deletes/commits to adapter files but not creates →
  a subset (single-book) adapter against a whole-repo release emitted a create per cell of every
  other changed book (83,689 measured → Import-changes hang). Fixed: scope parsed files to the
  adapter's own fileIds (currentCells). Regression test added.
