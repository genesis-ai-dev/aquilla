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
