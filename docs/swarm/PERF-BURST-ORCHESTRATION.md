# SWARM ORCHESTRATION — Prototype Debugging: edit-burst perf (AQU-1146 / 1147 / 1016 / 1160)

**Project:** Prototype Debugging (`215cff7b-1a95-443d-9343-1f1528754462`), team Aquilla.
**Started:** 2026-09-03 (evening). **Base:** `dev` @ `ddaa15b48`. **Integration:** `swarm/perf-burst-integration`
at `.worktrees/perf-burst-integration`. **Promotion target:** `dev` (this repo lands perf work on dev, PRs to main are QA's).
**Operator instruction:** promote 1146/1147/1016/1160 out of Triage and implement; AQU-1145 is owned elsewhere — do not touch.
Ordering intent: 1146 → 1147 (prod profile gate first) → 1016 → 1160; 1160 is server-side and file-disjoint so it runs in wave 1.

## §0 STOP checklist
- [ ] AQU-1146, AQU-1147, AQU-1016, AQU-1160 each at **Fixed** (verified) or honestly **blocked** with a Linear note.
- [ ] Every changed user journey has its smoke spec/page object updated in the same workstream; new journeys registered in `e2e/JOURNEYS.md`.
- [ ] Integration green: `pnpm build` + directly affected Vitest (EditorTable.*, ProjectWorkspace.*, useCells, cells-read) + `cd sync-worker && npx tsc --noEmit && npm test`.
- [ ] `pnpm test:e2e:smoke` passes once on the final integrated result before promotion/push.
- [ ] Each fix verified on the real dev stack (live UI) before its issue → Fixed; spec reconciled per `/issue` Step 2.5.
- [ ] Promoted to `dev` only with the root working tree clean (never clobbered).
- [ ] Every remaining gap traced in `docs/swarm/TRACES.md` (§ PERF-BURST).

## §EXCLUDED
- **AQU-1145** — Dispatched to Ryder in `~/.codex/worktrees/927e/aquilla` (uncommitted, 11 files, +1072/-102). Not swarmed.
  Its files are **forbidden paths** for every agent here: `src/hooks/useActiveCellStore.ts`, `src/hooks/useCompletion.ts`,
  `src/lib/sync/cells-cache.ts`, `src/lib/sync/ws-reconciler.ts`, `src/lib/sync/events-emit.ts` (+ their tests), and the
  `commitCompletedCells` block it adds to `src/components/ProjectWorkspace.tsx` (~L4186, plus the import lines ~L24 and ~L160).

## §1 Operating model
- Root checkout (`dev`) is sacred; it hosts the shared dev stack for the live-UI slot. Never branch off a dirty tree.
- Agents work in `.worktrees/aqu-####` off the LIVE integration tip (manual worktrees, not `isolation:worktree`). Agents never push, deploy, promote, or run `e2e-up`/dev stack (one e2e stack per machine; e2e boot wipes dev-stack R2). Targeted smoke runs centrally.
- Orchestrator owns merges into integration, gates, promotion, Linear status flips. Merge protocol: union (keep both sides).
- Wave-1 contract deviation: all four issues were in Triage / "Dev Shaped Task"; the operator's instruction is the triage decision (promoted to Todo 2026-09-04 04:17Z). AQU-1016 was assigned to Tim; reassigned to the orchestrator with a Linear comment.

## §2 Wave plan (dependency + file-overlap DAG)
| Wave | WS | Issue | Why here |
| --- | --- | --- | --- |
| 1 | WS-1146 | EditorTable incremental memos + per-cell row props | `EditorTable.tsx` only; disjoint from 1145 and 1160 |
| 1 | WS-1160 | Bounded server cell-page reads | `sync-worker/src/events/cells-read-route.ts` + migration; disjoint from all client work |
| 1 | WS-PROF | **Gate for 1147**: production-build Draft-all/commit-burst profile on a whole-Bible file (dev stack, live-UI slot) | 1147 AC #1 requires the profile before implementation; also fulfils the "one agent on the real UI" rule |
| 1 (accelerated 2026-09-04 06:07Z) | WS-1147 | ProjectWorkspace shell de-subscription | operator asked to speed up: profile gate waived, dispatched concurrently with region ownership inside `ProjectWorkspace.tsx` (version memos = 1147; scroll state, validate handlers, useHealth = 1016) |
| 1 (accelerated) | WS-1016 | Scroll path (`trackedCellRef`/`visibleCellIds`) + validate→health recompute | concurrent with 1147; merged serially with union protocol |

## §3 Workstream registry
| WS | Issue | Status | Branch / worktree | Owns | Notes |
| --- | --- | --- | --- | --- | --- |
| WS-1146 | AQU-1146 | Merged to dev | `swarm/aqu-1146` / `.worktrees/aqu-1146` | `src/components/EditorTable.tsx`, `src/components/EditorTable.*.test.tsx` | store API read-only (`getCellVersion`, `readAtVersion`) |
| WS-1160 | AQU-1160 | Merged to dev | `swarm/aqu-1160` / `.worktrees/aqu-1160` | `sync-worker/src/events/cells-read-route.ts`, `sync-worker/src/__tests__/cells-read.test.ts`, `read-routes.test.ts`, `db/postgres/migrations/0083_*.sql`, `db/postgres/schema.sql`, comments in `src/lib/sync/cells-read.ts` | salvage index/paging from reverted `ef249e914` |
| WS-PROF | AQU-1147 gate | Done | none (read-only; uses root dev stack + `pnpm build`/`vite preview`) | `docs/swarm/PERF-BURST-PROFILE.md` | records numbers on AQU-1147 |
| WS-1147 | AQU-1147 | Merged to dev (scaled down) | `swarm/aqu-1147` / `.worktrees/aqu-1147` | `src/components/ProjectWorkspace.tsx`, new hooks under `src/hooks/`, `ProjectWorkspace.*.test.ts` | |
| WS-1016 | AQU-1016 | Merged to dev | `swarm/aqu-1016` / `.worktrees/aqu-1016` | `ProjectWorkspace.tsx` scroll state, `EditorTable.tsx` scroll callbacks, health recompute scheduling | |

## §1b Release plan (operator, 2026-09-04)
Dev team will test on the dev environment. Gate for push+deploy to `dev` / dev.aquilla.app: `pnpm build` + affected Vitest + worker tests + `pnpm test:e2e:affected`; full `test:e2e:smoke` runs AFTER deploy in the background and is reported honestly. Deploy command: `pnpm run deploy:aquilla:dev` (verifies branch `dev`).

## §M Merge log
<!-- date · WS · branch · sha · build · vitest · targeted smoke · notes -->
- 2026-09-04 · WS-1160 · `swarm/aqu-1160` · merge `9b50a80b5` · tsc/tests NOT run at merge time (operator waived) · no smoke · ordered-id chain cache + `idx_cells_file_scan`.
- 2026-09-04 · WS-1146 · `swarm/aqu-1146` · merge after `32901cf40` · `tsc -b` clean · 26 EditorTable files / 142 tests green · no smoke.
- 2026-09-04 · WS-1147 · `swarm/aqu-1147` · merge after `a1acd5c94` · `tsc -b` clean · covered by the combined run below · no smoke. **Scaled down** per the profile: only the eight handlers that carried `cellStoreVersion` for nothing; the ~20-memo extraction and render-count probes were dropped. The parallel `origin/agent/AQU-1147-workspace-version-derivations` (`eec110d25`, six handlers) is a strict subset of this and can be deleted.
- 2026-09-04 · WS-1016 · `swarm/aqu-1016` · merge after `58c28a51c` · `tsc -b` clean · 33 files / 189 tests green across EditorTable + ProjectWorkspace + useEditorViewportStore · no smoke.

**Verification debt (honest):** none of the four was verified on the live dev
stack, and `pnpm test:e2e:smoke` was NOT run — the operator waived both for this
pass. §0's live-UI and smoke boxes are therefore still open, and the dev team's
testing on `dev.aquilla.app` is the first real exercise of this work.
