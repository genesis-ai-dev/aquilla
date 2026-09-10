# SWARM ORCHESTRATION — live sync: content-bearing frames + diff presence

**Started:** 2026-09-04. **Base:** `dev` @ `69689a78c`. **Integration:** `swarm/sync-live-integration`
at `.worktrees/sync-live-integration`. **Promotion target:** `dev` (then `deploy:aquilla:dev:*`).
**Operator instruction:** "data from the db must be live and instant; presence is slow and glitchy — fix both."

## §0 STOP checklist
- [ ] `event.applied` frames for cell events carry `serverSeq` + the cell's projected rows; the client applies
      them directly (no per-cell GET) with a per-cell seq guard; the `?since=` delta remains the reconcile path.
- [ ] Presence: DO emits per-user diffs, draft text travels in its own frame, server-side per-user rate limit;
      full roster only on connect. Client store consumes diffs. Root-level workspace re-render per frame removed
      or deferred with a trace (EditorTable is owned by the perf-burst swarm this wave).
- [ ] Integration green: `pnpm -s tsc -b`, root vitest (affected), `cd sync-worker && npm test`, eslint on touched files.
- [ ] Collab smokes green centrally: `concurrent-edit`, `concurrent-edit-throttled`, `commit-chain-linear`,
      `member-presence-popover`, `cross-user-validate`.
- [ ] Adversarial review panel (races / regressions / contracts) passed; blockers fixed or reverted.
- [ ] Promoted to `dev` with the root tree clean; SPA + sync-worker deployed to dev and live-verified.
- [ ] Every gap traced in `docs/swarm/SYNC-LIVE-TRACES.md`.

## §1 Operating model
- Workflow mode (operator present). Agents run in `isolation: 'worktree'` off root HEAD; they never push, deploy,
  or run `e2e-up` (one e2e stack per machine — orchestrator runs smokes centrally).
- Orchestrator owns merges into integration (union), gates, promotion, deploy.
- **Forbidden paths (other actors in flight):**
  - AQU-1145 (Ryder, `~/.codex/worktrees/927e`): `src/hooks/useActiveCellStore.ts`, `src/hooks/useCompletion.ts`,
    `src/lib/sync/cells-cache.ts`, `src/lib/sync/events-emit.ts` (+ tests). `src/lib/sync/ws-reconciler.ts` is on that
    list too — WS-B may make ONE additive change there (pass `serverSeq`/`rows` through the `event.applied` parser)
    and must flag it; nothing else.
  - Perf-burst swarm (`docs/swarm/PERF-BURST-ORCHESTRATION.md`): `src/components/EditorTable.tsx` (+ tests),
    `sync-worker/src/events/cells-read-route.ts`, `src/components/ProjectWorkspace.tsx` (waves 2–3). Agents here do
    NOT edit ProjectWorkspace.tsx or EditorTable.tsx; the orchestrator applies the two small wiring hunks in
    ProjectWorkspace at merge time.

## §2 Frame contract (shared by WS-A and WS-B — do not diverge)
`event.applied` gains two optional fields (additive; old clients ignore them):
```
{ t: "event.applied", id, kind, project, file?, cell?, by?, via?,
  serverSeq?: number,          // events.server_seq of this event
  rows?: CellRow[] }           // the cell's CURRENT projected rows (both sides, all lanes),
                               // serialised EXACTLY as GET …/cells?cellIds= returns them
```
`rows` is present only for cell-scoped chain/validation kinds where the route can cheaply produce the rows.
Presence frames (WS-C ↔ WS-D):
```
{ t: "presence", users }                       // full roster — on connect only
{ t: "presence.diff", user: PresenceState }    // one user changed (no draftText inside)
{ t: "presence.left", userId }
{ t: "presence.draft", userId, cellId, draftText, ts }   // rate-limited per user (≥150 ms apart)
```

## §3 Workstream registry
| WS | Title | Owns | Notes |
| --- | --- | --- | --- |
| WS-A | server: rows + serverSeq on event.applied | `sync-worker/src/events/route.ts`, `sync-worker/src/project-do.ts` (relay only), `sync-worker/src/project-do-handlers.ts` (frame types only), tests | reuse the by-ids row serialiser |
| WS-B | client: live-apply module | new `src/lib/sync/live-apply.ts` (+test), one additive parser change in `ws-reconciler.ts` | uses store public API only |
| WS-C | server: diff presence + rate limit | `sync-worker/src/project-do-handlers.ts`, `project-do.ts`, `project-do-types.ts`, tests | full roster on connect only |
| WS-D | client: presence store diffs | `src/lib/sync/presence-store.ts` (+test), `src/lib/sync/ws-reconciler.ts` presence parser (additive), `src/components/PeerPresence.tsx` | leaf hooks already exist |

## §4 Merge log
<!-- date · WS · branch · sha · tsc · vitest · notes -->
