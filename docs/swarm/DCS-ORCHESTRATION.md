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

## Merge log (append-only)

- 2026-07-06 · integration branch created; spec + `types.ts` + state files committed.
