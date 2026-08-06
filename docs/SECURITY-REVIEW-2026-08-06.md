# Aquilla — Operational Security Review, 2026-08-06

_Scheduled review. Analysis only — no code changed. Follow-up to
[`docs/SECURITY-NOTES-2026-06-10.md`](./SECURITY-NOTES-2026-06-10.md) (SEC-1 … SEC-11),
which is the baseline this document measures against._

**Headline:** meaningful progress — 3 findings fully closed, 3 substantially reduced — but
**SEC-1 (shared JWT signing secrets across prod/dev/staging) is unchanged after ~8 weeks and
is now the single highest-severity open item.** A second gap has opened: the Tauri desktop
shell gained a real CSP while the *web* SPA, which is the actual production surface, still
ships no security headers at all.

## Scope

This review covers what is observable from the repository and its GitHub/deployment
configuration: secret handling, credential design, auth and session management, the
authorization perimeter, dependency posture, and repo exposure. It does **not** cover
personal-device practices (disk encryption, password manager, 2FA enrollment, phone
posture, social-media exposure) — those aren't visible from here. A short unverified
checklist for that half is at the end.

---

## 1. Critical data handled

| Class | Where it lives | Notes |
|---|---|---|
| Identity access tokens (HS256 JWT, 30d) | Browser IndexedDB (`src/lib/frontier/session-store.ts`) | Script-readable |
| Sync tokens (15 min, project+file scoped) | Memory / request headers | Short-lived, well scoped |
| Agent API PATs (`aqk_…`) | Postgres, SHA-256 hash only | Plaintext shown once |
| Platform signing keys (`SECRET_KEY`, `SYNC_SECRET_KEY`) | Wrangler secrets | **Shared across environments — see SEC-1** |
| Third-party LLM/TTS vendor keys | Org: Postgres (redacted on read). User: browser `localStorage` | User keys unencrypted by documented choice |
| Vendor platform keys (`OPENROUTER_API_KEY`, `GITLAB_ADMIN_TOKEN`, `AGENT_SANDBOX_KEY`) | Wrangler secrets | Not in source |
| Contributor translation content + comments | Postgres + R2 | Real user data; project-scoped authz |
| User PII (email, username, scrypt/bcrypt password hashes) | Postgres | Sound primitives |

**Threat actors, by realistic order:** (1) credential-stuffing and scripted-abuse bots
against open registration and the LLM proxy — motive is free inference and financial DoS;
(2) an opportunistic attacker who obtains a token or vendor key via XSS or a leaked bearer
in shell history/logs; (3) a malicious or compromised project member escalating within a
tenant; (4) supply-chain compromise via the build-time dependency tree. Nation-state or
targeted-insider scenarios are not the pressing shape of this product's risk.

---

## 2. Status of the 2026-06-10 findings

### Closed

- **SEC-3 — LLM proxy abuse.** `auth-worker/src/routes/chat.ts:151` now enforces a model
  allowlist plus per-user and global daily budget (AQU-265). The financial-DoS path that
  ran from open registration to unbounded spend on the platform OpenRouter key is shut.
- **SEC-4 — No rate limiting on auth.** `auth-worker/src/utils/rate-limit.ts` exists and is
  wired into registration (`auth.ts:176`), login — counted on both identifier *and* IP
  (`auth.ts:383-384`), password-reset request (`auth.ts:762`), the contact endpoint
  (`contact.ts:48`), and admin elevation (`admin.ts:147`). Reset-request throttling is
  non-disclosing: throttled and unknown-email return the same 200.
- **SEC-7 — `hono` JWT-verification advisory.** Resolved versions are now 4.12.29
  (auth-worker), 4.12.31 (agent-worker), 4.12.33 (sync-worker) — all past the 4.12.21 fix.
  `onnxruntime-web` was repinned off the nightly dev build to stable `1.27.0`, closing the
  unsigned-pre-release supply-chain note. (Dependency posture overall has a new problem —
  see §3.)

### Substantially reduced, with residue

- **SEC-2 — 30-day tokens, no revocation.** Two real countermeasures landed: a `jti`
  denylist (`utils/token-revocation.ts`, migration 0073) so logout actually revokes, and
  rejection of any token issued before `password_changed_at` (`middleware/auth.ts:62-70`,
  migration 0066) so a password reset invalidates outstanding tokens. **Residue:** TTL is
  still 30 days (`ACCESS_TOKEN_EXPIRE_MINUTES = "43200"`); pre-change tokens carry no `jti`
  and can't be individually revoked; the revocation check deliberately fails open on a DB
  error. The design note is explicit about all three — this is a documented posture, not an
  oversight, but the 30-day ceiling still sets the blast radius of a stolen token.
- **SEC-5 — `SYNC_SECRET_KEY` as admin bearer.** Comparison is now constant-time
  (`sync-worker/src/admin.ts:6,43` via `lib/secure-compare`). **Residue:** the signing key
  itself is still the admin bearer credential, so every place that bearer travels — ops
  scripts, shell history, proxy logs — remains a signing-key disclosure. The recommended fix
  (a dedicated admin secret) was not done; only the timing half, which was the less
  exploitable half.
- **SEC-6 — No CSP.** The Tauri shell went from `"csp": null` to a genuine policy
  (`src-tauri/tauri.conf.json:23-36`: `object-src 'none'`, `frame-ancestors 'none'`,
  `base-uri 'self'`, no `unsafe-eval`). **Residue, and now an inconsistency:** the SPA served
  by `worker/index.ts` sets **no** `Content-Security-Policy`, `X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy`, or `Strict-Transport-Security` — the only
  headers it sets are `Cache-Control` and `X-Robots-Tag`. There is no `public/_headers`
  either. The desktop app is now hardened against exactly the class of attack the web app
  — the surface with all the users — is still open to. Tokens remain in IndexedDB and user
  vendor keys in `localStorage`, so a single XSS still yields a 30-day token plus third-party
  keys.

### Open, unchanged

- **SEC-1 [HIGH] — Shared signing secrets across environments.** `SECRET_KEY` and
  `SYNC_SECRET_KEY` are still deliberately identical across prod, staging, and dev
  (`auth-worker/wrangler.toml:256` "Same SECRET_KEY + SYNC_SECRET_KEY as prod…";
  `sync-worker/wrangler.toml:165,170` instructs copying the prod secret into the dev env).
  Compromise of the least-hardened environment still mints tokens accepted by production,
  and no environment's key can be rotated independently. This was #2 on the June
  recommended order and is now the top open item.
- **SEC-9 [LOW]** — `POST /api/v2/sync-token` still auto-registers an unknown `projectId`
  and grants the caller OWNER (`routes/sync-token.ts:104-111`).
- **SEC-10 [LOW]** — scrypt still `N=32768` (`utils/password.ts:27`), below current OWASP
  guidance; pinned by legacy-hash compatibility.
- **SEC-11 [LOW]** — Partially addressed and worth noting because it's asymmetric:
  registration now suppresses internal detail outside production (`auth.ts:314-317`), but
  `/password-reset/request` still returns the raw exception message in **every**
  environment (`auth.ts:819-826`: `Failed to send reset email: ${errorMessage}`). The exact
  endpoint the June review named is the one still leaking.

---

## 3. New this review

- **Dependency posture regressed by count.** `pnpm audit`: 16 vulnerabilities — 1 critical,
  5 high, 9 moderate, 1 low (June: 18, with 4 high and none critical). The critical is
  `node-tar` decompression/parse DoS, reached via
  `kokoro-js → @huggingface/transformers → onnxruntime-node → tar`. Every critical and high
  sits in the **build/dev-time** tree — `onnxruntime-node` (tar, adm-zip), `sharp`/libvips,
  and `wrangler → miniflare → undici` — not in deployed Worker runtime code. The
  `react-router` RSC CSRF advisory is RSC/framework-mode only and this is a client-rendered
  SPA, so it reads as not-exploitable here, same call as June. Real but lower-urgency than
  raw severity labels suggest; the relevant exposure is a developer machine or CI runner
  processing a hostile archive.
- **Minor — identifiers committed in an example file.** `auth-worker/.dev.vars.example`
  contains a live Cloudflare account ID (`FRONTIER_D1_ACCOUNT_ID`) and the internal GitLab
  host `git.genesisrnd.com`. Not credentials, and the repo is private, so impact is low —
  but they're reconnaissance-grade identifiers that don't need to be in source.

### Verified sound (checked this round, beyond June's list)

- **Agent API PATs are well built.** 256 bits of `crypto.getRandomValues`, SHA-256 hash
  stored (plaintext returned exactly once), a greppable `aqk_` tag so a leaked token is
  recognizable, a 12-char display prefix that can't reconstruct the secret, expiry +
  revocation columns, and live role re-resolution on every call so a credential never
  outlives the user's current role (`db/shared/api-credentials.ts`, migration 0054).
- **Org vendor keys are redacted on read.** `GET /orgs/:id/settings` is open to any org
  member including viewers, and `redactSecrets` strips `orgProviderKeys`
  (`routes/org-settings.ts:96-112,174`). Without it, any viewer could have read the org's
  live Gemini/TTS key. Good catch by whoever wrote it.
- **Secrets hygiene holds.** No `.env` or `.dev.vars` tracked (only `.example`); a pattern
  scan across the full tree and 1,080 commits of history surfaced only test fixtures and
  local-dev DSNs; `.gitignore` covers dev vars, wrangler local state, and `e2e/.auth/`.
- **Repo exposure is contained.** `genesis-ai-dev/aquilla` is **private**, forking disabled,
  0 forks.
- **Dev-only bypasses stay gated.** `ALLOW_UNAUTHENTICATED` appears only in dev config and
  an explicit `!== "true"` production check (`sync-worker/src/project-do.ts:268`);
  `WRANGLER_LOCAL` is CLI-injected only, never persisted in any env file.

---

## 4. Priorities

1. **Split `SECRET_KEY` / `SYNC_SECRET_KEY` per environment (SEC-1).** Highest-leverage
   single change, unchanged for two months, and it gates the value of everything else —
   token revocation and rate limiting don't help if a dev-environment key mints prod tokens.
2. **Add security headers to the SPA-serving worker.** Port the Tauri policy to
   `worker/index.ts` (or a `public/_headers`): CSP, `frame-ancestors 'none'`,
   `X-Content-Type-Options: nosniff`, `Referrer-Policy`, HSTS. The desktop shell already
   proves the policy is compatible with the app.
3. **Mint a dedicated admin secret for sync-worker** so the signing key stops travelling in
   bearer headers (SEC-5 residue), and **shorten the access-token TTL** from 30 days now
   that a revocation primitive exists to make re-auth cheap (SEC-2 residue).
4. **Bump the `node-tar` chain** (dev-tree critical), then sweep the remaining highs.
5. **Cleanups:** generic error body on `/password-reset/request` (SEC-11), drop the
   auto-OWNER grant from sync-token (SEC-9), re-stretch scrypt when legacy compat allows
   (SEC-10), scrub the account ID from `.dev.vars.example`.

---

## 5. Not verifiable from here

The prompt's personal-practice half can't be checked from a repo container. Worth
self-auditing, roughly in order of leverage given the findings above:

- Hardware-backed 2FA on GitHub, Cloudflare, Neon, and OpenRouter — those four accounts
  collectively own every secret in §1.
- Cloudflare API tokens scoped least-privilege and rotated; check for stale broad tokens.
- A provider-side **spend cap on the OpenRouter account** — SEC-3's in-app budget is one
  layer, the vendor cap is the backstop if the key itself leaks.
- Signing-key rotation runbook — today SEC-1 makes rotation a cross-environment event, which
  is exactly why it hasn't happened.
- Password manager with unique credentials; full-disk encryption on any machine holding
  `.dev.vars`; shell-history hygiene given admin bearers are passed as headers.

---

_Findings reproducible from the cited `file:line` references against
`claude/magical-wright-sgccup` at `69b32685`._
