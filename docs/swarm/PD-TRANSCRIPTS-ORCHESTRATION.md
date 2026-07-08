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
(empty — appended as agent branches merge)
