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

## Agent-reported TODOs

(appended by orchestrator from agent returns)
