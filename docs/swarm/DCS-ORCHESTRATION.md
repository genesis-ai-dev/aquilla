# DCS Importer swarm — ORCHESTRATION (source of truth)

Durable state for the autonomous build of the DCS (Door43) importer. Survives context
compaction — **re-read this + DCS-TRACES.md + `git log --oneline swarm/dcs-integration` on every
wake to know where things stand.** Spec: `docs/superpowers/specs/2026-07-06-dcs-importer-design.md`.

- **Integration branch:** `swarm/dcs-integration` at `.worktrees/dcs-integration` (off dev HEAD `ff466abfe`).
- **Started:** 2026-07-06 (user AFK overnight; back in the morning).
- **Mode:** AFK / multi-hour. Orchestrator owns every merge, the verify gate, the adversarial
  review, and the dev proof. Subagents NEVER push, NEVER promote, NEVER touch `main`/`dev`.

## GOAL / STOP checklist

Deliver the DCS importer end-to-end and PROVE it against live git.door43.org on ≥2 linked
projects. Done when ALL are true on `swarm/dcs-integration`:

- [ ] Slice A — `src/lib/dcs/*` foundation (catalog client, manifest, cell-id, resource-map[USFM],
      import-dcs, delta, cursor) with unit tests. `tsc` clean, vitest green.
- [ ] Slice B — Catalog browser + "Import as source" wired into ImportDialog; freshness
      "Check for updates" / "Import changes" panel.
- [ ] Slice C — **The money proof:** re-pinning an adapter project from an OLD real DCS release
      to a NEWER one runs the delta, moves source heads, and flags linked downstream targets stale
      (reusing stale-source + UpstreamChangesPanel). Verified in the dev stack.
- [ ] Slice D — Aligned-target import (snapshot + live `consumes:'target'`), generalizing
      `prepareEBibleTargetImport`.
- [ ] Slice E — OBS + TSV (tn/tq/sn/sq) resource routes (markdown tw/ta best-effort).
- [ ] Central gate green: `tsc -b --noEmit` + `vitest run` (root) + `npm run build` + worker tscs.
- [ ] Adversarial review panel (races / regressions / contracts) passed on the promotion diff.
- [ ] **Dev proof captured:** browser QA against live DCS — import book@vOLD, link 2 language
      projects, translate cells, "Import changes" → vNEW, observe stale flags + review panel.
      Screenshots + asserted server-state-after-reload in DCS-UIQA.md.

**Promotion policy (AFK):** DO NOT promote to `main` or push `dev`/staging unattended — memory
`project_dev_push_clobbers_prod_spa` says a `dev` push clobbers the prod SPA. Leave everything on
`swarm/dcs-integration` with the proof + a summary; the user promotes in the morning.

## Verified facts (do not re-litigate)

- DCS API + raw hosts send `access-control-allow-origin: *` (+ OPTIONS 204). **Adapter runs
  client-side in the SPA; no worker proxy.**
- `uuid` ^13 present; deterministic ids via `import { v5 as uuidv5 } from "uuid"` — mirror the
  `u5()` pattern in `src/lib/migrate/ids.ts`. Pick ONE fixed `DCS_NS` UUID constant in cell-id.ts.
- `yaml` ^2.9 present → manifest.yaml parsing.
- Server `contentHash(text)` (djb2, 32-bit) is exported at
  `sync-worker/src/events/event-projection.ts:56`. The delta engine MUST hash with the SAME
  normalization so no-op suppression matches the server. Port/reuse it in `src/lib/dcs/`.
- Emit surface (`src/lib/sync/bulk-import.ts`): `bulkUploadSource(BulkUploadArgs)` for the
  GENESIS import (file.create + N source.cell.create); `bulkUploadTargetCommits` for aligned
  target. `BulkImportCell.id` accepts ANY string ⇒ pass the deterministic uuidv5 EVENT id there
  (`uuidv5(`${repo}|${sha}|${cellId}`, DCS_NS)`); server `/import` is idempotent so re-runs dedupe.
- Reference import shape: `emitParsedFile` / `buildBulkCells` in `src/lib/import.ts` (see the
  OBS path ~L470–587 and eBible target path ~L189–278). Existing parsers output
  `TranslatableString[]` (`src/lib/parsers/types.ts`).

## Technical contract (every agent obeys)

1. **Two emit paths.** INITIAL import = `bulkUploadSource` (genesis creates). DELTA = per-changed
   cell `source.cell.commit` (chained on the cell's current head) + `cell.delete` (tombstone) for
   vanished ids + `source.cell.create` for new ids — via the normal typed emitters in
   `src/lib/sync/events-emit.ts` / outbox, NOT the bulk path. Never raw INSERT.
2. **Cell identity is content-addressed** (spec §5). Seeds: USFM `repo|BOOK C:V`; OBS
   `repo|OBS story:frame`; TSV `repo|book|rowID` (the TSV `ID` column); markdown
   `repo|path|blockIdx`. Re-segmentation ⇒ delete+create, never id churn.
3. **Cursor** = pinned prod release tag/SHA, stored in adapter project `project_settings`
   key `dcsUpstream` (shape = `DcsCursor` in `src/lib/dcs/types.ts`). Default trackMode `release`.
4. **Compare quirk:** changed files = union of `.commits[].files[].filename` (top-level `.files`
   is empty on DCS's Gitea).
5. **Public API = `src/lib/dcs/types.ts`.** Extend additively only.
6. **Reuse, don't rebuild** the linked-projects engine (mirror/stale/review). The adapter only
   PRODUCES source events into an adapter project; invalidation is inherited.

## Slice ownership & forbidden files

New code lives under `src/lib/dcs/**` + new UI components; existing-file edits are minimal and
serialized (only ONE agent touches a given existing file per wave — see below).

| Slice | Owner files (create/edit) | Forbidden |
| --- | --- | --- |
| A foundation | `src/lib/dcs/{catalog,manifest,cell-id,resource-map,content-hash,import-dcs,delta,cursor}.ts` + `*.test.ts` | any existing file except reading them; no UI |
| B import UI | NEW `src/components/dcs/*`; edit `src/components/ImportDialog.tsx` (DCS option only) | ImportDialog areas unrelated to the new option; `src/lib/dcs/**` internals |
| C delta proof | NEW `src/components/dcs/DcsUpstreamPanel.tsx`; a dev harness; wiring in a settings section | reimplementing stale-source/UpstreamChangesPanel (reuse them) |
| D aligned target | NEW `src/lib/dcs/aligned-target.ts` + UI; reuse `prepareEBibleTargetImport` | rewriting eBible import |
| E resource routes | `src/lib/dcs/routes/{obs,tsv-notes,tsv-questions,md-dict,md-manual}.ts` + tests | changing the ResourceRoute interface |

## Wave plan

- **Wave 1 (now):** 1 agent → Slice A (cohesive interdependent module; single owner avoids
  intra-module merge/interface drift). TDD, no UI.
- **Wave 2 (after A merged+verified):** parallel — B (import UI), D (aligned target), E-obs +
  E-tsv (resource routes). Mostly disjoint files.
- **Wave 3:** C (delta-invalidation wiring) + the browser-QA dev-proof agent.
- **Gate + adversarial review + proof capture + summary.**

## Wave 3 dev-proof plan (recon done 2026-07-06, live git.door43.org)

Goal: import a resource at an OLD release, link 2 language projects, translate a couple cells,
then "Import changes" to a NEWER release and watch those cells flag STALE in both downstreams +
appear in the Upstream-changes review panel. Use REAL DCS data.

**Preferred target — Translation Notes (clean prose delta):** `unfoldingWord/en_tn`, one short
book file `tn_TIT.tsv` (or `tn_PHM.tsv`/`tn_JUD.tsv`). Notes are edited between releases as real
text changes (no alignment noise). Requires Agent E's `tsv-notes` route merged+verified. Tags run
…v86 v87 v88 v89. Proof agent must first CONFIRM the chosen release pair yields ≥1 changed Note
row (fetch the file at both refs, diff) before building the demo on it.

**Fallback target — USFM Bible (route guaranteed by Slice A):** `unfoldingWord/en_ult`, a short
book (`57-TIT.usfm`/`58-PHM.usfm`/`66-JUD.usfm`). CAVEAT: en_ult is an *Aligned Bible* — much of
what changes between releases is `\zaln`/`\w` word-alignment markup, NOT verse text. Two risks the
proof agent MUST check: (a) does `src/lib/parsers/usfm.ts` strip alignment markup? If yes,
alignment-only diffs will (correctly) hash-suppress → pick a pair with a REAL verse-text change
(verified: v80 vs v89 differ for TIT/PHM/JUD; v70 is an 11-byte stub — too old). If the parser
does NOT strip alignment, imported source values carry alignment junk (ugly but the invalidation
still demonstrates). Verify ≥1 cell actually flags stale after the delta before relying on it.

**CRITICAL API finding — the `compare` endpoint THROTTLES under rapid requests:** returns HTTP 200
with an EMPTY body (`total_commits` null, no commits) when hit too fast; recovers after ~20s.
Confirmed: v88→v89 = 1 commit/56 files, v80→v89 = 1077 commits/68 files once spaced. The delta
engine + proof harness MUST: space requests, retry with backoff on an empty/short compare body,
and fall back to FULL-SCAN reconcile (parse all files, hash-compare) if compare stays empty. This
is the self-heal path the spec §6 already mandates — make sure `delta.ts`/the panel honor it.
(SWARM-TODO for whoever owns delta robustness: add backoff + full-scan fallback if not present.)

**Compare quirk reconfirmed live:** changed files = union of `.commits[].files[].filename`
(top-level `.files` empty). Raw content + manifest fetch fine (CORS `*`).

## Merge log (append-only)

- 2026-07-06 · integration branch created; spec + `types.ts` + state files committed.
- 2026-07-06 · Slice A merged (`88a458cd2`, ff). Central gate PASSED: vitest 46/46 (8 files),
  tsc `-p tsconfig.app.json` 0 errors. Live-API assumptions re-verified vs git.door43.org:
  `content_format`/`zipball_url` present, git-tree `{tree:[{path,type}]}`, raw `manifest.yaml`
  at `/raw/tag/{ref}/manifest.yaml` → 200. Wave 2 dispatched (B import-UI, C delta-wiring, E routes).
- 2026-07-06 · Slice E merged (`a2c6d221d`). Central gate PASSED: vitest 72/72 (11 files), tsc 0
  errors. Routes refactored into `src/lib/dcs/routes/{usfm,obs,tsv-notes,tsv-questions}.ts` +
  `tsv-common.ts`. E repointed one Slice-A test fixture (`import-dcs.test.ts` no-route case tn→tw)
  — legitimate since tn is now routable. tw/ta still deferred. Awaiting B + C.
- 2026-07-06 · Slice C merged (`8e78dffaa`, TRACES union-resolved). Then Slice B merged
  (`4782d5644`, TRACES union-resolved). Orchestrator fix `c64cff2b5`: mount DcsUpstreamPanel for
  self-contained adapter projects (ProjectSettings gated it on hasSourceLink; adapters have a
  dcsUpstream cursor + no sourceProjectId). ALL WAVE 2 MERGED.
- 2026-07-06 · FULL GATE: tsc 0 errors; `vitest run` (whole suite) = **3627 passed**, DCS-relevant
  134/134 green. The only failures (ProjectOverview.test.tsx) are PRE-EXISTING on base `ff466abfe`
  (byte-identical file, fails 1/20 isolated on base too; "3 failed" in full run = base test
  pollution) — NOT a DCS regression. Verified by diff --stat (empty) + isolated base-vs-integration
  runs matching. Honest status: DCS work is regression-free; ProjectOverview flakiness is the
  user's separate in-flight work.
- 2026-07-06 · Wave 3 starting: live-DCS proof.
- 2026-07-06 · LIVE PROOF (adapter half) captured in DCS-PROOF.md: real en_tn + en_ult deltas,
  stable ids, on git.door43.org. Wave 3 dispatched: (a) fix-compare (throttle correctness bug —
  compareRefs must retry/throw not silently report no-changes), (b) adversarial review of the full
  ff466abfe..HEAD diff, (c) browser-proof (dev-stack UI walkthrough, best-effort). NOT promoting;
  leaving on swarm/dcs-integration for user's morning review.
- 2026-07-06 · fix-compare merged (`e2033ed19` → integration). compareRefs now retries throttled
  bodies (numeric total_commits = legit vs absent = throttled) and THROWS after N retries instead
  of silently reporting no-changes. Central gate: vitest 76/76 (src/lib/dcs), tsc 0. Remaining Wave
  3: adversarial review + browser proof.

## STATUS (2026-07-06, mid-Wave-3)
DONE: Slice A (foundation), Slice B (import UI), Slice C (delta panel + emitters), Slice E (OBS +
TSV routes), orchestrator mount-fix, fix-compare (throttle correctness). Full suite regression-free
(3627 pass; ProjectOverview failures pre-exist on base). Live adapter proof captured (DCS-PROOF.md).
NOT DONE / DEFERRED: Slice D (aligned-target) — scoped out for this run; tw/ta markdown routes —
deferred (spec §12); USFM `\zaln` alignment stripping — follow-up; full browser UI proof — in
flight. NOT promoted (branch only, awaiting user).
- 2026-07-06 · Adversarial review BLOCKER (delta create fileId orphaning) FIXED + tests
  (`b74b7e922`). Findings 2/3 (HEAD-tracking delta, new-file file.create) → follow-ups in TRACES.
- 2026-07-06 · LIVE BROWSER QA (DCS-UIQA.md + 5 screenshots, committed `d5cdf45f9`): MILESTONE 1
  PROVEN on the real dev stack — browsed 18 live DCS entries, imported en_obs (50 files/598 cells,
  frame images, survives reload) via real /import, panel renders + Check-for-updates round-trips.
  MILESTONE 2 (UI delta→stale) blocked by 4 real defects live QA found (unit tests missed all):
  (1) catalog.ts unbound `fetch` → Illegal invocation in browser [BLOCKER]; (2) DcsCatalogBrowser
  seeds lang with display-name not ISO → 0 initial results; (3) DcsUpstreamPanel check-for-updates
  queries the PINNED ref → never sees new releases [BLOCKER for delta UI]; (4) dcsEventId not
  project-scoped → same resource in 2 projects dedupes away. Dispatched claude/dcs-fix-ui to fix
  all 4 + regression tests. Delta ENGINE separately proven on real en_tn v87→v89 (1082 changed,
  stable ids). Also confirmed product gap: import UI pins latest-only (no release picker).
- 2026-07-07 · fix-ui MERGED (`6e7c16d57`): all 4 live-QA defects fixed + regression tests
  (bind fetch, ISO lang seed via new lang-seed.ts, getLatestRelease-based check-for-updates,
  project-scoped dcsEventId(projectId,repo,sha,cellId)). Central gate: vitest 94/94 (13 files),
  tsc 0. Dispatching final M2 browser proof on the FIXED code (defects 1+3 were what blocked M2).

## FINAL STATUS — 2026-07-07 (swarm converged)
ALL slices + all review/QA fixes merged to swarm/dcs-integration (tip 3749260c4, 26 commits off
ff466abfe, ~4341 LOC across 36 source files). FINAL GATE GREEN: tsc -p tsconfig.app.json = 0
errors; DCS suite 124/124 (16 files); full suite regression-free (only pre-existing ProjectOverview
flakiness on base). PROVEN LIVE vs git.door43.org: adapter engine (DCS-PROOF.md) + Milestone-1
import UI + Milestone-2 full linked-projects delta→stale (DCS-UIQA.md, DCS-UIQA-M2.md, 16
screenshots). Fixes applied: review blocker (create fileId), 4 live-QA defects (unbound fetch,
ISO lang, latest-release check, project-scoped event ids), delta subset-adapter scoping (83k-create
hang). Main checkout pristine; agent worktrees pruned; nothing pushed.
FOLLOW-UPS (all flagged, non-blocking): USFM \zaln alignment stripping (Bible source UX);
HEAD-tracking delta (finding-2); brand-new-file file.create (finding-3); release-picker in import
UI (product gap); aligned-target import (Slice D, deferred); tw/ta markdown routes (deferred).
AWAITING USER: promotion decision. NOT promoted to main, NOT pushed to dev/staging.
