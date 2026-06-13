# Org-credits — adversarial review findings (2026-06-13b)

Pre-promotion review of `swarm/credits-integration` (diff vs `3899fe37b`). Fixes by orchestrator before promotion. Status `OPEN`/`FIXED`.

## Lens 1 — Contracts + cap math (agent aa151d30, DONE)

All 3 blockers are admin-console client↔server drift (frontadmin built against spec; authcredits shaped its own). Org-facing CreditsPanel/getOrgCredits are CLEAN.

- [OPEN] **B1 BLOCKER** `src/lib/sync/credits.ts:108,130` — client hits `/api/v1/admin/credits/*` but auth-worker mounts admin at `/api/v2/admin` (`auth-worker/src/index.ts:163`) → 404 on every admin credits call. **Fix:** client → `/api/v2/admin/...`.
- [OPEN] **B2 BLOCKER** `src/lib/sync/credits.ts:55-68` + `src/components/admin/AdminCreditsSection.tsx:112-115` — server returns each row as `{orgId,orgName,config:{markup,agentMarkup,dailyCap,weeklyCap,agentDailyCap,agentWeeklyCap,enforce,showToOrg},day,week}` (admin.ts:329-349) but client type/uses `row.caps.*`, `row.enforce`, `row.showToOrg` → TypeError. **Fix:** align client `AdminOrgCredits` + AdminCreditsSection to read `row.config.*` (matches the /credits endpoint which also nests `config`); update its test fixture.
- [OPEN] **B3 BLOCKER** `src/lib/sync/credits.ts:116` — server returns `{orgs: rows}` (admin.ts:356) but `listOrgCredits` casts to a naked `AdminOrgCredits[]` → no rows. **Fix:** `return ((await res.json()) as {orgs:AdminOrgCredits[]}).orgs`.
- [OPEN] **B-MAJOR-1** `auth-worker/src/lib/credits.ts:124-127` — JSDoc says "Raw cost cents by rail" but `readSpend` stores CREDITS (markup applied). Code correct, comment wrong (double-markup trap for future readers). **Fix:** correct the JSDoc.
- [OPEN?] **B-MINOR-1** `src/lib/sync/credits.ts:16-21` — client `byRail` requires {llm,agent,tts}; server `byRailDay/Week` is sparse (missing rails absent). Latent (UI uses totalCredits/agentCredits). **Fix (cheap robustness):** have server `readSpend` default llm/agent/tts to 0.
- [OK→trace] **B-MINOR-2** sync-worker TTS rail is recorded but NOT credit-guarded (only the per-user seconds `runTtsGuard`). Per spec TTS pre-check was low-priority; org credit cap on tts rail tracked-not-enforced. Acceptable v1 → TRACE.
- [OK] Formula identical across auth/sync/frontend `creditsFor`; defaults 4×/5×; `CREDIT_ENFORCE` false default + creditGuard returns ok when enforce off; rolling-7d (today−6) correct; checkCredits cap precedence + agent-only gating correct.

## Lens 2 — Security / role-gating / regressions (agent a5eddcb2, DONE)

- [DUP of B1] **FINDING-1 (their MAJOR)** = B1 (admin /v1→/v2). 404s make enforce/showToOrg toggles inoperable via UI. Same fix.
- [OK→trace] FINDING-2 MINOR `usage.ts:357-407` — `resolveCreditConfig` runs BEFORE the auth check (wasted query, NOT a leak; 403 fires before any config returned). **Fix (cheap):** move config resolve AFTER the maintainer/admin gate.
- [OK] FINDING-3 cross-org read depends on existing `getEffectiveOrgRole` (structurally identical to other org endpoints) — no new bug.
- [OK] FINDING-4 `recordCredit` in stream callback can't crash a run (swallows errors; .catch sends error frame at worst).
- [OK→note] FINDING-5 org-0 chat is a shared global pool when enforce=true (by design, no-org fallback). Operator awareness only.
- [OK] FINDING-6 enforce + showToOrg DEFAULT FALSE confirmed (env + per-org merge).
- [OK] **FINDING-7 translator-never-sees-credits DOUBLE GATE HOLDS** (client role<600 skips fetch; server 403→null; activeOrg null→0→fails gate).
- [OK] FINDING-8 platform-admin middleware on all `/api/v2/admin/credits/*` (authMiddleware + requirePlatformAdmin global). FINDING-9 SQL fully parameterized.

## RESOLUTION (orchestrator commit on swarm/credits-integration)
All 3 blockers + MAJOR + actionable MINORs FIXED. Re-verified: root tsc 0 · root vitest 2875 (7 pre-existing Login only) · auth-worker tsc 0 + 382/382 · sync-worker 620/620 (unchanged) · build PASS. Deferred: B-MINOR-2 (TTS rail credit-cap enforcement) — tracked, acceptable v1; chat org-0 shared pool — operator note. Security invariants all confirmed SAFE (translator double-gate, platform-admin gating, enforce/showToOrg default false, SQL params).

## Consolidated fix plan (orchestrator, before promote)
1. **B1** client `src/lib/sync/credits.ts` admin URLs `/api/v1/`→`/api/v2/`.
2. **B2** client `AdminOrgCredits` type + `AdminCreditsSection.tsx` → read `row.config.*` (+ enforce/showToOrg from config); fix test fixture.
3. **B3** `listOrgCredits` unwrap `{orgs:[...]}`.
4. **B-MAJOR-1** fix JSDoc in `auth-worker/src/lib/credits.ts` (credits not raw).
5. **B-MINOR-1** server `readSpend` default byRail {llm,agent,tts}=0.
6. **FINDING-2** reorder usage.ts `/credits` — auth gate before resolveCreditConfig.
7. **B-MINOR-2** TTS rail enforcement deferred → TRACE (acceptable v1).
