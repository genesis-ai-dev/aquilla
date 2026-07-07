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
  fileId works for reads), same pattern as the FRO-478 Upstream-changes panel.
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
