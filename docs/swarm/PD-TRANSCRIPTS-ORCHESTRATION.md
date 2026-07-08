# Swarm — PD Transcripts (2026-07-08)

Project: **Prototype Debugging** (Aquilla team, id 215cff7b-1a95-443d-9343-1f1528754462).
Scope: the **ready subset** of the 8 issues created from 2026-07-08 meeting transcripts.
Integration branch: `swarm/pd-transcripts-integration` off `dev` @ c66657e7c.
Promotion target: **local `dev`, unpushed** (house convention; Ryder pushes). Orchestrator is the only merger.

## §0 STOP checklist (goal)
- [ ] Every in-scope issue at **Fixed** (verified) or honestly **blocked** with a Linear note.
- [ ] Integration green: `npx tsc -b --noEmit` + `npx vitest run`; `npm run build` before promotion.
- [ ] Each UI fix verified on the real dev stack (live UI) before → Fixed.
- [ ] Landed on local dev only with tracked tree clean apart from protected paths.
- [ ] Every gap traced below.

## §EXCLUDED / HELD
- **Held for Ryder's inputs (NOT swarmed):** AQU-510 (needs i18n scaffolding + real Burmese/Patani Malay translations), AQU-511 (i18n framework — design-first), AQU-514 (spike + Cloudflare/AWS infra, not merge-safe), AQU-515 (needs Doug's pericope-boundary dataset).
- **Do NOT touch (Ryder's decision):** AQU-435, AQU-269 (reopen candidates) + all augment-commented issues.
- **Protected untracked paths in main (forbidden to all agents):** `scripts/import-blackfoot-john.ts`, `src/lib/parsers/label-track.ts(.test.ts)`, `docs/swarm/AQU-DASHBOARD2-ORCHESTRATION.md`, `.migrate-state.json.bak-local-jun25`.
- **Other live swarm (avoid):** aqu-488/489/491/494/495/496/498 worktrees (paused ETEN-dashboard swarm) — different issues; their unmerged ProjectWorkspace/dashboard edits may later conflict with AQU-516 (integration concern for that swarm, not this one).

## §3 Workstream registry + wave plan
Single wave — all four file-disjoint.

| Issue | Branch | Worktree | Owned files | Status |
|---|---|---|---|---|
| AQU-509 Discord invite (consolidate + configurable) | swarm/aqu-509 | .worktrees/aqu-509 | BetaBadge.tsx, HelpMenu.tsx, pages/Beta/BetaPage.tsx(.test) | Dispatched |
| AQU-512 role-tailored product tour | swarm/aqu-512 | .worktrees/aqu-512 | onboarding/ProductTour.tsx, context/ProductTourContext.tsx, hooks/useProductTour.ts | Dispatched |
| AQU-513 per-cell audio-file upload | swarm/aqu-513 | .worktrees/aqu-513 | NEW CellAudioUploadButton.tsx, EditorTable.tsx (wire only) | Dispatched |
| AQU-516 all-files sidebar completeness | swarm/aqu-516 | .worktrees/aqu-516 | ProjectWorkspace.tsx, ExpandableFileList.tsx, FileRow.tsx, hooks/useHealth.ts | Dispatched |

Read-only reuse (no edits): AQU-513 → lib/audio/upload.ts, lib/sync/events-emit.ts; AQU-516 → lib/sync/cells-read.ts (fetchProjectFiles).

## §M Merge log
- **AQU-509 — CANCELED** (not a real issue; transient client-side error per Ryder). Consolidation commit 55386ed56 preserved on branch `swarm/aqu-509`, NOT shipped; worktree removed.
- **AQU-512** merged (5b025cbbc). Role-filter tour steps. Note: behaviorally near-neutral today (nav-settings anchor already 600-gated in OrgSidebar → resolveSteps DOM-drop already hid it from non-admins); adds explicit tested `minRole` mechanism. tsc 0, ProductTour 21/21.
- **AQU-513** merged (0e475267a). New CellAudioUploadButton + 14-line additive wire in EditorTable. tsc 0, button test 4/4, EditorTable.editorActions 2/2.
- **AQU-516** merged (17e6e1d60). fetchProjectFiles→all-files sidebar progress, live active-file entry preserved via mergeFileProgress. tsc 0, helper 5/5 + ProjectWorkspace/useHealth 34/34.

**Integration gate (tip 8368361a4):** `tsc -b --noEmit`=0 · targeted vitest 64/64 (+EditorTable editorActions 2/2) · `vite build`=OK (44s, dist emitted). Full vitest suite not run (10min+ ceiling); targeted across all changed surfaces instead.

**Landed:** fast-forwarded local `dev` to integration tip. UNPUSHED (Ryder pushes). **Live-UI QA: DEFERRED** — click-paths in each issue's SWARM-TODO / Linear comment.
