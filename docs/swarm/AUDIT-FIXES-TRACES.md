# Audit-fixes swarm — open TODOs / deferred items

Pick these up in a later wave or session. Source: docs/AUDIT-2026-06-10.md.

## Deferred by orchestrator (with reason)

- **M2-4 shared `packages/data-model`** (ARCH-3): requires editing `auth-worker/src/types.ts`, which has uncommitted user work in the main checkout. Do after that work lands.
- **M2-5 sync-token timeout**: `src/lib/sync/sync-token.ts` dirty in main checkout — same reason.
- **M0-3 smoke re-split** (TEST-3): tagging a true <2min subset across 308 specs is a dedicated pass; wave 1 adds a scheduled full-e2e CI job instead.
- **E2E concurrent-edit spec execution** (M0-4 e2e half): user's dev stack is live on 5173/8788 and `e2e-up.ts` force-kills those ports. PGlite worker-level concurrency tests are the regression proof this run; add the e2e spec + run when ports are free.
- **M3-1/M3-2 god-file splits, M3-3 react-query reads, M3-4 typeChecked ESLint, M3-7 networkidle reduction**: polish tier, after correctness waves.
- **PERF-6/PERF-7 client memo/identity churn**: revisit after M2-1 changes the read path shape.
- **PERF-9 retention/GC, CACHE-6 audio Range, CACHE-7 eBible mirror, RACE-10 token single-flight**: audit non-goals for now.
- **onnxruntime-web nightly pin** (DEPS-4): needs a deliberate upgrade+test pass, not a swarm side-effect.

## Agent-reported TODOs (wave 3 — aud-fix-locks)

**B4 fix landed** (`swarm/aud-fix-locks` commit `1faa871`): `cell-lock-state.ts` helper module
extracted; all three WS handlers in `ProjectWorkspace.tsx` (presence / lock.claimed /
lock.released) now build ONE new Map per frame — no in-place mutation, no bail-out.
RACE-5 synchrony preserved (ref assigned before setCellLockHolders). 22 tests green, tsc clean.

**B4 ALSO note — reconnect wipes lock from client map (CONFIRMED, NOT fixed here):**

Verified in `sync-worker/src/project-do.ts:129`: on every new WebSocket connection the DO
unconditionally sets `this.presence.set(userId, { userId, ts: Date.now() })` — this overwrites
any existing presence entry (including its `focusedCell`) for that userId.

Consequence for lock reliability (RACE-5/M1-6):
1. User A holds a lock on cell X. Their presence entry has `focusedCell: "cell-X"` (set by
   `applyFocusClaim` at `project-do-handlers.ts:232`).
2. User A's tab drops and reconnects (network blip, tab hide/show, etc.).
3. DO line 129 overwrites A's presence entry — `focusedCell` wiped from the presence map.
4. `broadcastPresence()` (line 136) fans out the updated roster to all other clients.
5. Other clients receive a `presence` frame without A's `focusedCell`; their
   `applyPresenceFrame` handler REPLACES the entire `cellLockHolders` map — A's lock entry
   is removed from the client-side map.
6. The lock in `this.locks` on the server is still valid (lease not expired), but no
   `lock.claimed` re-broadcast fires. Other clients no longer see the lock. Since
   server-side enforcement is advisory (RACE-5 accepted design), another user can now
   commit to cell X through the gap.

Recommended fix (wave-2 `aud-lock-client` scope or standalone):
- In `project-do.ts` connect handler: preserve existing presence entry fields when setting
  the new connection's entry — `this.presence.set(userId, { ...existing, userId, ts: now })`
  — OR, after upsetting the presence entry, immediately re-broadcast any active locks for
  that user via `lock.claimed` frames to all connections (including the new one) so client
  maps are correct again. The latter also fixes the reconnecting client's own lock-map gap.

## Agent-reported TODOs (wave 1)

**DEPLOY BLOCKER — `db/postgres/migrations/0034_server_seq_allocator.sql`** (project_seq_counters + chain_claims, idempotent) must be applied to LIVE NEON and the staging DB **before** deploying sync-worker, or every event write 500s (D1→Neon drift failure mode). Long-lived dev Postgres containers need it too (`applyPgSchemaIfMissing` only runs schema.sql on empty DBs). Rolling-deploy window: old workers still allocate MAX+1; collisions during the window surface as loud 500 + retry (self-heals).

- LINT: 390 pre-existing errors (207 no-explicit-any mostly in worker tests, 59 no-unused-vars, react-hooks/rules-of-hooks in e2e/helpers/multi-user.ts). CI lint job red until fixed → wave-2 aud-lint-green.
- Worker vitest PGlite hookTimeout flakiness under machine load — consider hookTimeout 60s in worker vitest configs; final gate must run on a quiet machine.
- Wrangler version skew: workers pin ^3.78.12, root ^4.99.0 — align later, verify wrangler.toml compat.
- Staging BASE_URL (auth-worker/wrangler.toml [env.staging]): dev.aquilla.app vs staging.aquilla.app — **needs human decision**; staging emails currently link to dev SPA.
- M0-4 e2e half: no true two-browser concurrent-write spec yet (PGlite unit half done); blocked on free ports (user's dev stack live).
- Wave-2 delta-read: server_seq now has harmless gaps (id-replays burn seqs) — ETag/?since= must treat seq as ordering key (MAX), never a count. Preserve EditorRow's pendingTargetEventIdRef confirm/clear effect (~EditorTable:1621) when touching useCells.
- ProjectWorkspace unreachable-state UI not rendered yet (hook-level isUnreachable exists) → wave-2 aud-lock-client (owns ProjectWorkspace).
- TeamDetail.tsx still uses deprecated fetchAccessibleProjects().
- Coverage gaps confirmed: cqrs-bridge.ts, CellTranscriptPreview.tsx (lost-only-coverage in 51c2985).
- useProject 'unreachable' has no auto-retry on 'online' event (manual Retry only).
- do-locks: claimed pre-existing tsc errors in some sync-worker test files (CellRow/EventRow index signatures) — root tsc -b is clean; verify at final gate.
- server-seq risks for review panel: claim-gating chosen over cells-CAS (deliberate, preserves RACE-8 semantics + rebuild parity); in-flight claim losers still broadcast (harmless no-op refetch); stale read-back best-effort; id-replays consume seqs (gaps).
