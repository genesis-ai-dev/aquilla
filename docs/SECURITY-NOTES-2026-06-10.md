# codex-web-app — Security Notes

_Date: 2026-06-10 · Defensive review of the owner's own codebase · Analysis only, no code changed · Companion to `docs/AUDIT-2026-06-10.md` (which intentionally omits security)._

This document collects the security findings separately so they can be triaged on their own track. Each finding carries file:line evidence, a concrete consequence, a severity, and a **FACT** (verified in code) vs **JUDGMENT** (reasoned inference) label.

> Scope note: this is a fast-moving prototype already deployed to production (`aquilla.app`) with real intended users (translation consultants). Several findings below are "fine for a prototype, must-fix before scale" — the severity reflects exposure if/when this serves real translator data at volume, calibrated against the prototype's maturity.

---

## Summary

| Sev | ID | Finding |
|---|---|---|
| High | SEC-1 | Prod, dev, and staging share the same JWT signing secrets (by documented design) |
| High | SEC-2 | 30-day stateless access tokens with no revocation path |
| Med | SEC-3 | Authenticated OpenRouter proxy: open registration + arbitrary models + no quota |
| Med | SEC-4 | No rate limiting / lockout on any auth endpoint |
| Med | SEC-5 | `SYNC_SECRET_KEY` doubles as a plaintext admin bearer credential |
| Med | SEC-6 | No CSP anywhere; long-lived tokens + API keys in script-readable storage |
| Med | SEC-7 | Dependency CVEs — incl. `hono` 4.12.14 in the JWT-verification path |
| Low | SEC-8 | Dev-bypass gate is sound, but the in-code safety claim is wrong |
| Low | SEC-9 | Sync-token auto-register lets a user claim an unregistered projectId |
| Low | SEC-10 | scrypt work factor below current OWASP guidance (legacy-compat constraint) |
| Low | SEC-11 | Internal error details leaked outside production |

---

## Findings

### SEC-1 — [HIGH] [FACT] Prod, dev, and staging share the same JWT signing secrets
`SECRET_KEY` and `SYNC_SECRET_KEY` are deliberately identical across environments ([auth-worker/wrangler.toml:124,160](auth-worker/wrangler.toml); sync-worker dev/staging comments). The comment states the intent: tokens minted against dev still verify against prod for cross-env testing.
**Consequence:** compromise of the least-hardened environment (dev worker, dev Neon branch, an operator laptop) yields a key that mints tokens accepted by **prod**, and removes any ability to rotate dev keys independently. Consequence chain is JUDGMENT but direct.
**Fix:** distinct `SECRET_KEY`/`SYNC_SECRET_KEY` per environment (highest-leverage single change).

### SEC-2 — [HIGH] [FACT] 30-day stateless access tokens with no revocation
`ACCESS_TOKEN_EXPIRE_MINUTES = "43200"` (30 days); tokens are pure HS256 with `sub/iat/exp` only — no `jti`, no session table, no refresh rotation ([auth-worker/wrangler.toml:79,113](auth-worker/wrangler.toml), [auth-worker/src/auth/jwt.ts:25](auth-worker/src/auth/jwt.ts), [auth-worker/src/middleware/auth.ts:30](auth-worker/src/middleware/auth.ts)). Password reset updates the hash but does nothing to outstanding tokens.
**Consequence:** a stolen token stays valid up to 30 days **even after a password change**; there is no logout-everywhere short of rotating `SECRET_KEY` globally — which SEC-1 makes a cross-env event.
**Fix:** shorten access-token life + add a revocation primitive (refresh rotation, or a per-user `tokens_valid_after` timestamp checked in `authMiddleware`).

### SEC-3 — [MEDIUM] [FACT path / JUDGMENT severity] Authenticated OpenRouter proxy with open registration, arbitrary models, no quota
Registration is open (no invite/captcha — [auth-worker/src/routes/auth.ts:62](auth-worker/src/routes/auth.ts)); any registered user can `POST /api/v1/chat/completions`, which forwards **any model string** to OpenRouter on the platform's `OPENROUTER_API_KEY` with no per-user quota, spend cap, or rate limit ([auth-worker/src/routes/chat.ts:46](auth-worker/src/routes/chat.ts)).
**Consequence:** free signup → scripted unbounded calls to the most expensive models on the org's account. Financial DoS. Severity rises to High if the OpenRouter key has no provider-side spend limit (couldn't verify from the repo).
**Fix:** model allowlist + per-user quota/rate limit; consider gating registration.

### SEC-4 — [MEDIUM] [FACT no-control / JUDGMENT prod-exposure] No rate limiting or lockout on auth endpoints
`/auth/token`, `/auth/register`, `/password-reset/request` have no rate limiting, lockout, or captcha, and no Cloudflare rate-limit bindings in any wrangler.toml ([auth.ts:62,134,274](auth-worker/src/routes/auth.ts)). Register returns a distinguishable 409 (enumeration); reset sends an email per call (mailbox flooding + spend).
**Consequence:** credential stuffing, username enumeration, email bombing. Zone-level WAF rules may exist outside the repo (unverified), so prod exposure is JUDGMENT.
**Fix:** Cloudflare rate-limit rules / Workers rate-limit bindings on all three + the chat proxy.

### SEC-5 — [MEDIUM] [FACT reuse / JUDGMENT leak-likelihood] `SYNC_SECRET_KEY` doubles as a plaintext admin bearer
The HMAC key that signs all sync tokens is also accepted verbatim as `Authorization: Bearer ${SYNC_SECRET_KEY}` for R2 deletion/inspection, DO broadcast injection, and migration ingest, compared with non-constant-time `!==` ([sync-worker/src/admin.ts:40](sync-worker/src/admin.ts), [project-do.ts:65](sync-worker/src/project-do.ts), [migrate-ingest-route.ts:104](sync-worker/src/events/migrate-ingest-route.ts)).
**Consequence:** every place the raw key travels as a bearer header (ops scripts, shell history, proxy logs) is a signing-key leak; the holder can mint owner-level sync tokens for any project/file. The timing-unsafe compare is impractical to exploit over HTTPS.
**Fix:** mint a dedicated admin secret distinct from the signing key; constant-time compare.

### SEC-6 — [MEDIUM] [FACT storage+missing-CSP / JUDGMENT impact] No CSP; long-lived tokens and API keys in script-readable storage
No CSP on the SPA (no `public/_headers`, no meta, `worker/index.ts` sets none) and Tauri ships `"csp": null` ([src-tauri/tauri.conf.json:23](src-tauri/tauri.conf.json)). JWTs live in IndexedDB ([src/lib/frontier/session-store.ts](src/lib/frontier/session-store.ts)); user Gemini/completion API keys live in localStorage ([src/lib/store/user-api-keys.ts:15](src/lib/store/user-api-keys.ts)).
**Consequence:** any single XSS yields the 30-day token (SEC-2) plus third-party API keys. CSP is the standard second layer and it's absent. Impact is contingent on an XSS existing — current sinks look sanitized (see Strengths).
**Fix:** add a CSP to the SPA and the Tauri shell; consider httpOnly-cookie sessions over script-readable storage.

### SEC-7 — [MEDIUM] [FACT versions / JUDGMENT exploitability] Dependency vulnerabilities
`pnpm audit --prod`: 18 vulns (4 high, 13 moderate, 1 low). Actionable:
- **`hono` < 4.12.18/4.12.21** — improper JWT NumericDate validation in `verify()` (GHSA-hm8q-7f3q-5f36, GHSA-2gcr-mfcq-wcc3). Both workers lock **4.12.14** ([auth-worker/package.json:17](auth-worker/package.json), [sync-worker/package.json:13](sync-worker/package.json)) — the library doing all JWT verification. Forging still needs the secret, and `middleware/auth.ts:36` re-checks `exp`, but the malformed-claim path isn't fully caught. **One-line bump each — do this first.**
- `react-router` turbo-stream RCE advisory — SSR/framework-mode only; this is a client-rendered SPA, so **likely not exploitable** here.
- `fast-uri` ×2 high, `brace-expansion` — mostly via the `shadcn` CLI tooling path, not runtime.
- `onnxruntime-web` pinned to a **nightly dev build** `1.26.0-dev.20260416-b7804b056c` — unsigned pre-release in the supply chain; repin to a stable release.

### SEC-8 — [LOW] [FACT] Dev-bypass gate is sound; the in-code safety claim is wrong
`/__dev__/seed`, `/__dev__/login`, `/__test__/reset` all 404 unless `WRANGLER_LOCAL === "1"` ([dev-seed.ts:268,287](auth-worker/src/routes/dev-seed.ts), [test-reset.ts:34](auth-worker/src/routes/test-reset.ts)). Verified the var is never set in any wrangler.toml/env/`.dev.vars.example` — only injected via CLI in `scripts/dev-stack.ts:394` / `scripts/e2e-up.ts:216`. **Gate: sound.** But the comment at `dev-seed.ts:9` claims a failed-open gate "could only log in as a user that doesn't exist in prod" — false: `/__dev__/login` calls `seedDev()` which *creates* users `dev`/`alice`/`bob` (password `dev`) + an org + projects in whatever DB is bound, and `/__test__/reset` deletes every row in every core table.
**Consequence:** no current exposure, but a future config mistake setting this var in prod is catastrophic, not benign. Fix the misleading comment so no one relies on the false reassurance.

### SEC-9 — [LOW] [FACT behavior / JUDGMENT precondition] Sync-token auto-register lets a user claim an unregistered projectId
`POST /api/v2/sync-token` with an unknown `projectId` + a `projectName` inserts the project and grants the caller OWNER ([sync-token.ts:86](auth-worker/src/routes/sync-token.ts)). Mitigated: client project IDs are UUIDs and the create flow writes the server row first, so squatting needs a leaked UUID of a never-registered project (legacy/offline imports are the plausible case). Also permits unlimited org-less project creation.
**Fix:** don't auto-create on sync-token mint; require an explicit create with membership.

### SEC-10 — [LOW] [FACT params / JUDGMENT adequacy] scrypt work factor below current OWASP guidance
Werkzeug-compatible scrypt at `N=32768 (2^15), r=8, p=1` ([auth-worker/src/utils/password.ts:26](auth-worker/src/utils/password.ts)); OWASP recommends N=2^17 for these r/p. Pinned for byte-compatibility with the legacy frontier DB; bcrypt hashes auto-upgrade on login but scrypt ones never re-stretch.
**Fix:** re-stretch scrypt hashes on next login once the legacy-compat constraint is gone.

### SEC-11 — [LOW] [FACT] Internal error details leaked outside production
`/password-reset/request` returns the raw exception message in all environments ([auth.ts:308](auth-worker/src/routes/auth.ts)); register hides detail only when `ENVIRONMENT=production`, so dev/staging (same signing keys as prod, SEC-1) leak SQL/infra strings.
**Fix:** generic error responses everywhere; log details server-side only.

---

## Security strengths (verified — preserve these)

- **S1 — Uniform parameterized SQL.** Every query in both workers binds `?` params through the Postgres shim ([db/shim/postgres.ts:154](db/shim/postgres.ts)); the only string-interpolated SQL is `DELETE FROM ${t.name}` over a hardcoded table list in the gated test-reset route. No injection path found.
- **S2 — Sync event authorization perimeter.** Symbol-branded `AuthorizedEvent` constructible only in one module (ESLint-enforced), per-event role policy, `aud:"sync"` rejection of access-token replay, 15-minute project+file-scoped sync tokens minted only after membership resolution.
- **S3 — Centralized, consistently-applied authorization.** Every sampled data route goes through `resolveProjectRole` max-wins resolution or token-claims checks; the cross-tenant admin surface sits behind a single `requirePlatformAdmin` choke point with a deploy-config allowlist (not a forgeable DB flag); invite-link roles capped at contributor. **No IDOR found in sampling.**
- **S4 — Sound credential primitives.** scrypt with `timingSafeEqual`, transparent bcrypt→scrypt upgrade on login, single-use 24h reset tokens, non-enumerating reset responses.
- **S5 — XSS sinks are sanitized.** All three `dangerouslySetInnerHTML` sites run DOMPurify ([EditorTable.tsx:2542](src/components/EditorTable.tsx), [CommentThread.tsx:76](src/components/CommentThread.tsx), [CommentsPage.tsx:272](src/components/CommentsPage.tsx)); TipTap paste is tag-allowlisted; the server document parser is auth-gated with a 2MB cap.
- **S6 — Secrets scan clean.** Pattern scan of all 1,655 tracked files found only local-dev DSNs (`postgresql://aquilla:aquilla@127.0.0.1`) in dev scripts; `.env*`/`.dev.vars` are gitignored; only `.example` placeholders are tracked; CI uses `${{ secrets.* }}`.
- **S7 — CORS is correctly permissive, not dangerous.** `Access-Control-Allow-Origin: *` on both workers is sound for a cookie-less bearer-token API — no credentialed CORS, no origin reflection. `cors-proxy/` is not an open proxy (it has zero tracked files).

---

## Recommended order
1. **SEC-7** — bump `hono` to ≥4.12.21 in both workers (one line each, JWT-verification path).
2. **SEC-1** — split signing keys per environment.
3. **SEC-2** — shorten token life + add a revocation primitive.
4. **SEC-4 / SEC-3** — rate-limit auth endpoints + the chat proxy; model allowlist + spend guard.
5. **SEC-5 / SEC-6** — dedicated admin secret; add CSP to SPA + Tauri.
6. Lower: SEC-8 (fix the comment), SEC-9, SEC-10, SEC-11.

_All findings reproducible from the cited file:line references against `main` at audit time (`7856958`)._
