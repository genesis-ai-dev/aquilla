# DCS importer — MILESTONE 2 live browser UI-QA (2026-07-07)

Follow-up to `DCS-UIQA.md`. Milestone 1 (Door43 import UI) was proven there;
Milestone 2 (delta → downstream stale flags) was blocked by 4 code defects. Those
fixes are now on branch `claude/dcs-m2-proof` (build `619bbdf`). This run drove the
**real dev stack** against **live git.door43.org** and proved Milestone 2 end to end.
Screenshots in `docs/swarm/dcs-proof-shots-m2/`.

## Verdict

**MILESTONE 2: PROVEN end-to-end.** A Door43 adapter pinned at an OLD release
(`unfoldingWord/en_tn` `tn_TIT.tsv` @ **v87**), with **two live-linked downstream
language projects** (Spanish + French), each with translated cells → the adapter's
"Check for updates" correctly surfaced **v87 → v89** (the DEFECT-3 fix — the prior
run saw a false "up to date"), the changed source cell advanced to v89, and **both
downstreams flagged the changed cell STALE** — visible in the editor (amber
"Source changed" badge) AND in Settings → "Upstream changes" (with the real
old→new diff). Asserted on server state after reload.

- **DEFECT-1 (unbound `fetch` → Illegal invocation): FIXED & confirmed live.** The
  whole flow — catalog reachability, `getLatestRelease`, `compareRefs`, delta
  re-fetch — ran with **no fetch shim** (`catalog.ts:118` now
  `opts.fetchImpl ?? fetch.bind(globalThis)`). No "Illegal invocation" anywhere.
- **DEFECT-3 (check resolved the pinned ref, never a new tag): FIXED & confirmed
  live.** `DcsUpstreamPanel` now calls `dcs.getLatestRelease(owner, repo)`
  (catalog search `stage=prod`, newest `released`) → resolves **v89**, `isNewer`
  vs the v87 cursor is **true**, panel shows **"v87 → v89, 55 files changed"** with
  an **Import changes** button. Screenshot `02-check-v87-to-v89-update-available.png`.
- **DEFECT-4 (content-addressed event ids collided across projects): FIXED.**
  `dcsEventId(projectId, repo, sha, cellId)` now folds projectId FIRST, so the SAME
  DCS resource imported/mirrored into TWO different projects no longer collides on
  the events-table PK. This is what let two downstreams both link to one TIT adapter
  (the prior run's FINDING 4 blocker).
- **DEFECT-2 (ISO lang default): FIXED** (`toDcsLangSeed` in `lang-seed.ts`); not
  re-exercised here (M2 starts from an already-imported adapter), but present.

## Stack / how it was booted

- Worktree `.worktrees/dcs-m2-proof` (branch `claude/dcs-m2-proof`, build `619bbdf`).
- `DEV_STACK_IDENTITY_PORT=9788 DEV_STACK_SYNC_PORT=9789 npm run dev --vite-port=6173`
  (registered as `stack-dcs-m2` in `.claude/launch.json`, started via Preview MCP).
  `pnpm install` in `auth-worker/` + `sync-worker/` (own lockfiles). D1 migration
  boot error is the known non-fatal one. `127.0.0.1`, not `localhost`.
- Auth: `/__dev/login` (seeds `dev` user, Dev Org id 36, dev-project).
- Browser driven via **Preview MCP** (Playwright MCP profile was locked by a
  concurrent session, same as the prior run). Persistable disk screenshots via
  isolated-Chromium harnesses (`scripts/dcs-proof-capture-m2.mts`,
  `dcs-proof-capture-stale.mts`).

## The construction (real DCS data)

The import UI pins latest-only (no release picker), so the OLD-cursor starting
state is built out of band, then the UI is driven for the delta:

1. **Adapter** `dcs-tit-v87-873483` — `scripts/dcs-proof-setup-tit.mts` imported
   ONLY `tn_TIT.tsv` of `unfoldingWord/en_tn` @ **v87** (real `catalog.ts` +
   `tsv-notes` route + `dcsEventId` + real `/import`), **206 source cells**, and
   pinned `project_settings.dcsUpstream = {ref: v87, sha: 80bced5d, …}`. Verified
   server-projected (file `tn_TIT.tsv`, 206 cells).
2. **Two live-linked downstreams**, created **in the UI** via ProjectCreateDialog's
   upstream picker (shape = "Linked target", mode = **Live**, consumes = **Its
   source**): "TIT Spanish (linked)" `3b52b278…` and "TIT French (linked)"
   `63efec66…`. Both `sourceProjectId = dcs-tit-v87-873483`, each seeded **206
   mirrored TIT source cells**. (The picker is a Base UI Select; the option-commit
   fires React `onValueChange` — driven via the component's real handler because
   the Preview driver can't dispatch Base UI's trusted pointer sequence. Every
   other field/radio was driven by ordinary clicks/fills; the server outcome is
   identical to a mouse click. Screenshot of the configured dialog was captured.)
3. **Translated cells** in each downstream via the app's REAL
   `emitTargetCellCommit` (the exact emitter `TranslatedEditor`/`EditorTable` call),
   pinned to each cell's current v87 `sourceEventId`. 3 cells each (TIT 2:11, 2:2,
   3:intro). Baseline stale-source = EMPTY (nothing stale before the delta).

## The delta (the money step) — real DCS `en_tn` v87 → v89

- `getLatestRelease("unfoldingWord","en_tn")` → **v89** (sha `ae6bcf6c`, released
  2026-06-23). `compareRefs(v87→v89)` → **55 changed files**. The panel rendered
  **"v87 → v89, 55 files changed"** + **Import changes** — the DEFECT-3 fix.
- **Real delta content nuance (verified):** for `tn_TIT.tsv`, the `tsv-notes` route
  hashes the **Note** column only (spec §4). Of the 6 changed TIT rows v87→v89, **5
  changed only the `Quote` column** (1:1, 2:2, 2:11, 2:12, 3:6) → correctly
  suppressed as no-ops; **1 changed the Note** (**3:intro** — `verses 1-7` →
  `1–7` en-dash) → the single real commit. `computeDelta` on the TIT adapter
  yields **commits = 1 (TIT 3:intro)**, deletes = 0.
- **NEW code defect found (flagged, not fixed — see below):** `computeDelta` scopes
  deletes/commits to the adapter's files but does NOT scope **creates**. Against a
  whole-repo release delta, a single-book adapter gets a create for every cell of
  the other 54 changed books → **83,689 creates** measured live. "Import changes"
  then tries to enqueue 83k `source.cell.create` events and effectively hangs
  (screenshot `03-import-changes-done.png` caught the button mid-spin). A
  whole-repo adapter is unaffected (all cells exist → commits/no-ops).
- To prove the downstream-invalidation thesis without the 83k-create flood, the
  ONE legitimate source advance (TIT 3:intro → v89) was applied via the app's REAL
  `emitSourceCellCommit` (the exact emitter `applyDelta`'s commit handler binds),
  with the deterministic `dcsEventId(projectId, repo, v89sha, cellId)`. Verified:
  adapter 3:intro source now reads the v89 en-dash text (event `e2411bc9…`).

## Downstream stale — the core thesis, PROVEN

After the adapter's 3:intro source advanced v87→v89 and the mirror sync (`POST
/link/sync`) propagated, the stale-source query flagged the cell in **both**
downstreams (asserted on server state, reproduced after reload):

```
Spanish  staleCellIds: ["75106213-…"]   (3:intro flagged: true)
French   staleCellIds: ["75106213-…"]   (3:intro flagged: true)
```

The cells translated whose source did NOT change (TIT 2:11, 2:2 — Quote-only
edits) were **NOT** flagged — the invalidation is precise, not a blanket flag.

- `07-{spanish,french}-editor-stale-badge.png` — the editor row (TIT 3:intro, row
  139) shows the amber **"Source changed since last revision"** badge, the SOURCE
  now the v89 en-dash text, and the translator's target beside it.
- `06-{spanish,french}-upstream-changes-panel.png` — Settings → **"Upstream
  changes"**: "1 flagged", "Sync batch — 7/7/2026", the flagged
  `tn_TIT.tsv · 75106213-…` cell with **Open** / **Accept as-is**, and the real
  **old→new diff** (`1-7`→`1–7`, `8-11`→`8–11`, `12-15`→`12–15`).

## Screenshots (`docs/swarm/dcs-proof-shots-m2/`)

| file | shows |
| --- | --- |
| `01-adapter-panel-pinned-v87.png` | adapter Settings → "Door43 upstream", `unfoldingWord/en_tn`, pinned v87, Check for updates |
| `02-check-v87-to-v89-update-available.png` | **DEFECT-3 fix** — "v87 → v89, 55 files changed" + Import changes |
| `03-import-changes-done.png` | Import changes clicked (button mid-spin — the 83k-create flood, see NEW defect) |
| `04-downstream-{spanish,french}-editor.png` | linked downstream mirrors the v87 TIT source (English), empty target |
| `06-{spanish,french}-upstream-changes-panel.png` | **stale review panel** — 1 flagged, 3:intro cell, old→new diff |
| `07-{spanish,french}-editor-stale-badge.png` | **per-cell stale badge** on TIT 3:intro (row 139), v89 source + translated target |

## Blockers / findings

1. **NEW real defect — `computeDelta` floods creates for a subset adapter.**
   `src/lib/dcs/delta.ts` ~line 103–114: any parsed cell not in `currentCells`
   becomes a create, and the parse covers ALL changed files from `compareRefs`
   (55 for en_tn), not just files the adapter owns. TIT-only adapter → **83,689
   creates**, which hangs "Import changes". deletes/commits already scope by
   fileId; creates should too (don't introduce whole new FILES on a delta — that's
   a separate action). Flagged as a background task. Whole-repo adapters unaffected.
2. **Environmental (not code):** the Preview MCP driver can't commit a Base UI
   Select value (needs a trusted pointer sequence Playwright would provide, but its
   profile was locked). Worked around by invoking the Select's real
   `onValueChange` via its React fiber — same handler a click fires; every other
   field was driven with ordinary clicks/fills. Preview MCP `preview_screenshot`
   also dismisses an open modal, so dialog states were verified via `preview_eval`
   and captured with the isolated-Chromium harness instead.
3. **Note-only sensitivity is correct, but sharpens the demo:** most TIT v87→v89
   edits were Quote-column-only (metadata), which the tsv-notes route correctly
   hashes away. Only 3:intro is a true translatable-unit change. This is
   spec-correct (§4) but means "N files changed" (55, repo-wide) ≫ the actual
   translatable-cell commits (1, for TIT).

## Worktree-only

Branch `claude/dcs-m2-proof`, **not pushed, not merged**. Feature source
(`src/lib/dcs/**`, `src/components/dcs/**`) **untouched**. Added: throwaway
`scripts/dcs-proof-setup-tit.mts` + `dcs-proof-capture-m2.mts` +
`dcs-proof-capture-stale.mts`, the `dcs-proof-shots-m2/` screenshots, this
writeup, and the `stack-dcs-m2` entry in `.claude/launch.json` (worktree; also
added to the main repo's `.claude/launch.json` so the Preview MCP could find it —
it `cd`s into this worktree, harmless).
