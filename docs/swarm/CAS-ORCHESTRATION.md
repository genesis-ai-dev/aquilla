# CAS (Come-and-See migration) swarm — ORCHESTRATION

Project: **Prototype Debugging** (id `215cff7b-1a95-443d-9343-1f1528754462`), team FrontierR&D.
Scope: the 9 issues created 2026-06-25 from the Wendi meeting (AQU-434…442).
Integration branch: `swarm/cas-integration` (off `main` @ b9555893f). Worktree: `.worktrees/cas-integration`.
Orchestrator: only actor that merges to main. Agents never push/deploy/promote.

## §0 STOP checklist (the goal)
- [ ] Every eligible issue at **Fixed** (verified) or honestly **blocked** with a Linear note.
- [ ] Integration green: `npx tsc -b --noEmit` + `npx vitest run`; `npm run build` before each promotion.
- [ ] `sync-worker` + `auth-worker` tsc/test green **if** touched (AQU-438 touches sync-worker; AQU-436 touches auth-worker).
- [ ] Each fix verified on the real dev stack (live UI) before → Fixed; spec reconciled per /issue Step 2.5.
- [ ] Promoted to main only with main clean apart from recorded protected files.
- [ ] Every remaining gap traced in docs/swarm/CAS-TRACES.md.

## §EXCLUDED / already-handled
- **AQU-435** (org visibility maintainer-floor) — was **already implemented uncommitted** in the user's
  working tree. Verified (auth-worker tsc 0, 86/86 perm tests pass) and committed as `2f4b2e7c3` on
  `perf/memory-telemetry-lazy-glosser`. Marked **Fixed**. NOT swarmed (its files are the user's live work).
- Protected / do-not-touch (user's other in-flight changes; not on this base but keep hands off):
  `src/hooks/useHealth.ts`, `src/lib/footnotes/extract.ts`, `db/postgres/schema.sql`, `.design-sync/**`,
  `auth-worker/migrations/0035_docx_r2_roundtrip.sql`.

## §HITL — not AFK-implementable (blocked, Linear-noted, NOT dispatched)
- **AQU-434** — QA checklist *review & deliver to Anna*. Human task (send the doc), not code. Doc already
  written (`docs/come-and-see-anna-qa-checklist.md`, attached to the issue). Leave for Ryder.
- **AQU-440** — Template projects + clone-vs-live + linked-projects **graph UI**. Needs a design pass
  (graph viz) before implementation; clone-vs-live semantics depend on undecided template model.
- **AQU-442** — Multimedia/timeline file — **design approval**. Requires Ryder's sign-off on open
  questions before any slice is implementable. Spec attached.

## §1 Operating model
- Per-issue: agents run `.claude/commands/issue.md` for their FRO-### (already moved to Dispatched + assigned by orchestrator).
- Manual worktrees off the LIVE integration tip (NOT isolation:worktree). Sonnet agents.
- Claim = move issue to **Dispatched** (`539bcf69-8c7a-4282-93d0-5631430b66ed`) + assign me, BEFORE spawning.
- Agents: verify `npx tsc -b --noEmit` + `npx vitest run` (+ worker tests if touched), commit, do NOT push/merge/deploy.
  Live-UI verification is centralized (Step 6). Leave precise SWARM-TODOs for what to click.

## §3 Workstream registry + wave plan

### Wave 1 (parallel — file-disjoint)
| WS | Issue(s) | Surface (OWN) | Branch | Status |
|----|----------|---------------|--------|--------|
| WS-EXPORT | AQU-437 (file naming) + AQU-441 (metadata spreadsheet export) | `src/components/ExportDialog.tsx`, `src/lib/export/**` | swarm/fro-437-441-export | pending |
| WS-LABELS | AQU-438 (re-enable cast label import apply) | `src/components/import/LabelImportPanel.tsx`, cast/label parts of `src/lib/parsers/spreadsheet.ts`, `src/lib/sync/events-emit.ts` (new `cast.assign`), `sync-worker/src/events/**` | swarm/fro-438-labels | pending |
| WS-AUTH | AQU-436 (lock username/password self-change) | `auth-worker/src/routes/**` (user/account), related auth-worker tests | swarm/fro-436-auth | pending |

### Wave 2 (after WS-LABELS + WS-EXPORT merge)
| WS | Issue(s) | Depends on | Surface | Status |
|----|----------|-----------|---------|--------|
| WS-VOICE | AQU-439 (split voice/camera tags; filter/export by voice) | AQU-438 (cast events), WS-EXPORT (ExportDialog) | cast/voice model + ExportDialog voice filter/scope | pending |

File-overlap rationale: AQU-437 & 441 both touch ExportDialog → one agent owns the export surface and does
both /issue cycles sequentially. AQU-439 touches both cast/label code (438) and ExportDialog (export-by-voice)
→ must run after both Wave-1 export/labels merge. WS-AUTH is disjoint (auth-worker only).

## §M Merge log
(append: date · WS · branch · sha · tsc · vitest)
- 2026-06-25 · WS-EXPORT (AQU-437, AQU-441) · swarm/fro-437-441-export · cc8f6e6cf+85644a718 · tsc 0 · merged clean
- 2026-06-25 · WS-LABELS (AQU-438) · swarm/fro-438-labels · caae58f33 · tsc 0 (fe+sync) · merged clean
- 2026-06-25 · WS-AUTH (AQU-436) · swarm/fro-436-auth · b359f24f2 · tsc 0 (auth) · merged clean
- 2026-06-25 · INTEGRATION GATE · swarm/cas-integration · fe vitest 3188/3188 · sync 648/648 · auth 462/462 · build ✓
- 2026-06-25 · PROMOTED main ← swarm/cas-integration (FF). Wave 2 (AQU-439) next; live-UI QA (Step 6) pending.
- 2026-06-25 · WS-VOICE (AQU-439) · swarm/fro-439-voice · ef66f5ebe · tsc 0 (fe+sync) · fe 3202/3202 · sync 648/648 · build ✓ · merged clean
- 2026-06-25 · PROMOTED main ← swarm/cas-integration (FF) — Wave 2. SWARM CONVERGED for AFK scope. Live-UI QA (Step 6) + HITL (434/440/442) remain.
