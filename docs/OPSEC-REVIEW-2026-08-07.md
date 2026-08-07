# Operational Security Review — 2026-08-07

_Scheduled defensive review of Aquilla's own systems. Re-verifies every finding in
`docs/SECURITY-NOTES-2026-06-10.md` against the tree at `69b3268` (dev), adds what has changed
since, and lands the fixes that were safe to apply unattended._

**Scope note.** The standing prompt for this routine is written in personal-OPSEC terms
(financial data, location, social media, predictable routines). Aquilla is a product, not a
person, so each of those maps onto its system analogue: credentials and PATs for "passwords,"
platform API keys and the credit ledger for "financial," IndexedDB/localStorage for "unencrypted
storage," dependency freshness for "unpatched software," and the deploy/secret topology for
"compartmentalization." The personal-life items with no product analogue (physical routines,
social-media oversharing by individuals) are out of scope and are not padded out here.

**Method.** Every claim below is either **FACT** (read out of the tree at this commit, with a
file:line) or **JUDGMENT** (reasoned inference). No live production system was probed — this is a
source review, so anything that depends on Cloudflare zone config, provider-side spend limits, or
the contents of `wrangler secret` is marked as unverifiable from here.

---

## 1. Critical data

Ranked by what an attacker would actually want, not by volume.

| Rank | Asset | Where it lives | Why it is the crown jewel |
|---|---|---|---|
| 1 | `SECRET_KEY` / `SYNC_SECRET_KEY` | Cloudflare secrets; injected into both API Workers | Mints access tokens and sync tokens for **any** user, project, and file. Full read/write on all tenants. |
| 2 | `OPENROUTER_API_KEY` | auth-worker secret | Direct spend on the org's account. The only asset here that converts to attacker profit without touching customer data. |
| 3 | Contributor translation work | Postgres `events` / `cells`; R2 source blobs | The product's reason to exist. Unpublished scripture drafts are commercially and, in some regions, personally sensitive to the translators who wrote them. |
| 4 | User credentials | `users.password_hash` (scrypt), Postgres | Reused elsewhere by real people. Breach cost extends past this product. |
| 5 | Agent API PATs | `api_credentials` (migration 0054) | Org/project-scoped programmatic write access; long-lived by design. |
| 6 | Session JWTs | Browser **IndexedDB**, `src/lib/frontier/session-store.ts` | Script-readable, up to 30 days of validity each. |
| 7 | User-supplied model API keys | Browser **localStorage**, `src/lib/store/user-api-keys.ts:15` | Third-party (Gemini/completion) keys belonging to the *user*, not us — a breach here spends someone else's money. |
| 8 | Member email addresses | Postgres; CF Email Service | Feeds phishing back at exactly the people who hold #3–#7. |
| 9 | Audio recordings | R2 `aquilla-snapshots`, `/audio/*` | Contributor voices — biometric-adjacent, and diarization means they are already segmented by speaker. |

Assets 6 and 7 sit in **script-readable browser storage**, which is what makes the CSP work in
this change the highest-leverage item on the list: one XSS reaches both.

## 2. Threat actors and motives

| Actor | Motive | Most likely first move | Plausibility |
|---|---|---|---|
| Opportunistic credential-stuffer | Account resale, resource theft | Spray leaked passwords at `/auth/token` | **High** — automated, untargeted, already happening to everything on the internet |
| Cost parasite | Free frontier-model inference | Register (open signup) → script `/api/v1/chat/completions` | **High** — the single most-abused shape of endpoint on the web right now |
| Compromised contributor laptop | Whatever is reachable | Reuse a stolen 30-day JWT or PAT | **Medium** — the user base is distributed field translators on personal machines |
| Targeted opposition to a translation programme | Suppress or corrupt a specific translation; identify contributors | Phish a Maintainer; pull member lists and audio | **Low frequency, severe impact** — this is the threat that distinguishes Aquilla from a generic SaaS, and the one worth designing for even at low probability |
| Supply-chain actor | Broad compromise via a dependency | Malicious postinstall or a poisoned pre-release build | **Medium** — see V4; the tree currently executes remote-fetching install scripts |
| Insider / over-broad operator access | Convenience, not malice | Use `SYNC_SECRET_KEY` as an admin bearer from a laptop shell | **Medium** — mitigated since June, see §6 |

The fourth row is the one that should shape decisions. For most SaaS, "who would bother" is a
fair question. For a Bible-translation platform serving languages in restricted regions, the
answer is "a state actor with a specific interest in the contributor list," and the harm is
physical, not financial. That is the justification for the member-list and audio protections
being treated as more than a compliance checkbox.

## 3. Vulnerabilities

Re-verified at this commit. IDs continue the `SEC-*` series from the June notes.

### Still open

**V1 (was SEC-1) — [HIGH] [FACT] Prod, dev, and staging share JWT signing secrets.**
`auth-worker/wrangler.toml:256` still documents the intent: "Same SECRET_KEY + SYNC_SECRET_KEY as
prod so tokens minted against dev still…". This is the one finding from June that has not moved
at all, and it is the finding that removes compartmentalization — the single most valuable OPSEC
property on the list. Compromise of the dev Worker, the dev Neon branch, or one operator laptop
yields a key that mints **production** tokens, and no environment's keys can be rotated
independently.

**V2 (was SEC-2, partially fixed) — [MED] [FACT] Access tokens still live 30 days.**
`ACCESS_TOKEN_EXPIRE_MINUTES = "43200"` at `auth-worker/wrangler.toml:128,221,299,345`. Severity
drops from High because a real revocation path now exists — `jti`-keyed denylist in
`auth-worker/src/utils/token-revocation.ts`, backed by `revoked_tokens` (migration 0073), checked
in `middleware/auth.ts`. Residual: revocation is **opt-in per token** (you must log out), the
check **fails open** on a DB error by deliberate design, and pre-migration tokens carry no `jti`
and can never be revoked individually. A silently stolen token is still good for up to 30 days.

**V3 (was SEC-3, mostly fixed) — [MED] [FACT] Spend caps exist but are not enforced.**
The model allowlist is now real and **always** enforced (`ai-budget.ts:61-79`, hardcoded
`DEFAULT_ALLOWED_MODELS` fallback), which closes the "arbitrary expensive model" half of the June
finding. But **both** spend-cap layers default to log-only and neither flag is set anywhere in the
tree:
- `CREDIT_ENFORCE` — unset ⇒ `credits.ts:64` resolves `enforce: false`; `creditGuard` logs
  "(log-only)" and returns ok. Caps of 1000 credits/day, 5000/week are therefore advisory.
- `AI_BUDGET_ENFORCE` / `platform_settings.aiBudgetEnforce` — same shape in `ai-budget.ts:190`.

Additionally both guards fail open on any DB error, and project-less chat attributes to `orgId 0`,
which takes the env defaults with no per-org override possible. Net: registration is open, so
today the only hard ceiling on a scripted abuse run is whatever spend limit exists on the
OpenRouter account itself — **not verifiable from the repo**, and the whole question of severity
turns on it.

**V4 — [MED] [FACT] Install-time remote code execution in the dependency tree.**
New finding, observed directly while installing for this review. `onnxruntime-node`'s postinstall
script downloads a CUDA `.nupkg` from `api.nuget.org` at install time and **throws when the
download fails**, aborting the whole install. That is a build step reaching the network for an
unpinned binary on every `pnpm i`, in CI and on every developer machine. It is also entirely dead
weight: `onnxruntime-node` arrives transitively via `@huggingface/transformers` (a browser-side
dependency — the app uses `onnxruntime-web`), so nothing in the shipped product consumes it.

**V5 (was SEC-7, residual) — [LOW] [FACT] Dependency posture.**
`pnpm audit --prod` reports 9 advisories (1 critical, 3 high, 4 moderate). Traced to source:
- `tar` (critical + high + 3 moderate), `adm-zip` (high), `sharp` (high) — all reachable **only**
  via `onnxruntime-node` and `miniflare`. Node/tooling-side, never in a Worker or the browser
  bundle. Not exploitable in the deployed product; they inflate the audit and hide real signal.
  Fixing V4 removes most of them.
- `react-router` (high, RSC-mode CSRF, patched in ≥8.3.0) — this is a client-rendered SPA with no
  RSC or framework mode, so **not exploitable here**. The fix is a major-version bump across the
  whole route table; deliberately not attempted unattended.
- `@huggingface/transformers@4.2.0` still pulls `onnxruntime-web: 1.26.0-dev.20260416-b7804b056c`,
  an unsigned nightly, even though the direct dependency was correctly repinned to stable `1.27.0`.

**V6 (was SEC-9) — [LOW] [FACT] `sync-token` still auto-creates unknown projects.**
`auth-worker/src/routes/sync-token.ts:104` — `POST /api/v2/sync-token` with an unknown `projectId`
plus a `projectName` inserts the project and makes the caller OWNER. Same mitigation as June
(client IDs are UUIDs; the create flow writes the server row first), so squatting needs a leaked
UUID for a never-registered project. Also still permits unbounded org-less project creation by any
registered user.

**V7 (was SEC-10) — [LOW] [FACT] scrypt at N=2^15.** `auth-worker/src/utils/password.ts:27`,
below current OWASP guidance of 2^17 for these r/p. Pinned for byte-compatibility with the legacy
frontier DB. bcrypt hashes upgrade on login; scrypt hashes never re-stretch.

**V8 (was SEC-11, partially fixed) — [LOW] [FACT] Raw exception text in responses.** The
password-reset path is now rate-limited, but raw `err.message` still reaches clients from ~20
sites across `projects.ts`, `source-linking.ts`, `contextual.ts`, `monday.ts`, and `agent.ts` SSE
error frames. With V1 unfixed, an infra string leaked from dev is a string about a system that
shares prod's signing key.

### Fixed since June — verified, not assumed

| June ID | Status at this commit | Evidence |
|---|---|---|
| SEC-2 (no revocation at all) | **Fixed** — `jti` denylist + `revoked_tokens` | `utils/token-revocation.ts`, `middleware/auth.ts:11,43` |
| SEC-3 (arbitrary models) | **Fixed** — allowlist always enforced | `lib/ai-budget.ts:61-79`, `routes/chat.ts:152` |
| SEC-4 (no auth rate limiting) | **Fixed** — DB-backed limiter on login/register/reset + admin elevation | `utils/rate-limit.ts`, `__tests__/auth-rate-limit.test.ts` |
| SEC-5 (timing-unsafe admin compare) | **Fixed** — `constantTimeEqual` | `sync-worker/src/admin.ts:43` |
| SEC-6 (Tauri `"csp": null`) | **Fixed** — real CSP in the shell | `src-tauri/tauri.conf.json:23-26` |
| SEC-6 (no CSP on the SPA) | **Fixed in this change** | `worker/index.ts`, §5 below |
| SEC-7 (`hono` on the vulnerable JWT path) | **Fixed** — locks resolve 4.12.29/4.12.31/4.12.33, all ≥4.12.21; floors raised in this change | worker `package-lock.json` |
| SEC-7 (nightly `onnxruntime-web` direct dep) | **Fixed** — repinned to stable `1.27.0` | `package.json:120` (transitive nightly remains, V5) |
| SEC-8 (misleading dev-bypass comment) | **Fixed in this change** | `auth-worker/src/routes/dev-seed.ts` |

Nine of eleven June findings are fully or substantially closed in under two months, and the two
that are not (V1, V2) are both configuration decisions rather than missing code. That is a good
trajectory and worth saying plainly.

## 4. Risk assessment

Likelihood is over a 12-month horizon at current scale. Impact assumes the vulnerability is the
one that gets used.

| ID | Likelihood | Impact | Risk | Reasoning |
|---|---|---|---|---|
| V1 shared signing keys | Low | **Critical** | **High** | Needs another compromise first, but converts any dev-side foothold into total prod compromise with no rotation path. Pure blast-radius amplifier. |
| V3 spend caps log-only | **High** | Medium | **High** | Open registration plus an unmetered upstream key is the most-scanned-for shape on the internet. Bounded by the OpenRouter account limit — which is exactly the control nobody in this repo can confirm exists. |
| V2 30-day tokens | Medium | Medium | Medium | Revocation now exists but only fires when the user actively logs out. A silent theft still buys a month. |
| V4 install-time RCE | Low | **High** | Medium | Compromise of a package that already executes network-fetching install scripts lands code on every dev machine and in CI, ahead of any runtime control. |
| V8 error leakage | Medium | Low | Low-Med | Reconnaissance quality, not access. Rises with V1 unfixed. |
| V6 project squatting | Low | Low | Low | Needs a leaked UUID for a project that was never registered server-side. |
| V5 dependency CVEs | Low | Low | Low | None on a reachable path; the real cost is that 9 unactionable advisories train people to ignore the audit. |
| V7 scrypt work factor | Low | Medium | Low | Requires a full DB breach first; 2^15 is dated, not broken. |

## 5. Countermeasures applied in this change

Chosen against one rule: only what is verifiable here and cannot break production unattended.
Everything requiring a secret rotation, a production flag flip, or a major-version bump is
recommended in §7 instead of done, because those need a human watching the deploy.

**C1 — Security response headers on the SPA (closes the SPA half of SEC-6).**
`worker/index.ts` now applies to every response it returns:
- `Content-Security-Policy: object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` denying camera/geolocation/payment/usb/sensors, keeping `microphone=(self)`
- `Strict-Transport-Security: max-age=31536000`, suppressed on `localhost`

Three deliberate restraints, each tested so the reasoning survives:
- **`script-src`/`style-src` are not constrained yet.** The prerendered marketing pages inline
  their hydration payload (`docs/SEO.md`) and Tailwind emits runtime inline styles. Shipping
  `script-src 'self'` today would white-screen the homepage. The four directives that shipped are
  the subset with no realistic false positives.
- **`microphone=(self)`, not `()`.** `AudioRecorder/probeMicPermission.ts` calls
  `getUserMedia({ audio: true })` for cell audio recording; denying it breaks the feature outright.
- **HSTS carries no `includeSubDomains`/`preload`.** That is a zone-wide, effectively irreversible
  commitment; it belongs in the Cloudflare HSTS setting where it can be rolled back, not pinned
  into every browser that ever loaded a page. And never on `localhost`, where it would force HTTPS
  on every other loopback dev server the engineer runs.

**Coverage limit, stated plainly:** only `/` is `run_worker_first`, so Cloudflare's asset router
serves hashed bundles before the Worker runs and those responses do not carry these headers. Every
*document* does route through the Worker (`/` and the static pages explicitly, SPA routes via
`not_found_handling`), and all six headers are document-scoped, so the protection is intact. A
`public/_headers` file would close the gap for assets too — deliberately not added here because a
malformed `_headers` fails the deploy and this run cannot test a deploy.

**C2 — `hono` floor raised to `^4.12.21`** in `auth-worker` and `agent-worker` (package.json +
package-lock spec). Both already *resolved* to patched versions, but the declared floor still
admitted 4.12.14 — the version with the improper JWT NumericDate validation, on the library doing
all JWT verification. A lockfile-less install could have silently reintroduced it. Resolved
versions are unchanged (4.12.29 / 4.12.31), so this is a floor raise, not an upgrade.

**C3 — Corrected the dev-bypass safety claim (SEC-8).** The comment in `dev-seed.ts` asserted a
failed-open `WRANGLER_LOCAL` gate could "only log in as a user that does not exist in prod." That
is false: `/__dev__/login` calls `seedDev()`, which *creates* `dev`/`alice`/`bob` with password
`dev` in whatever DB is bound, and `/__test__/reset` truncates every core table. The gate itself
is sound and was re-verified — `WRANGLER_LOCAL` appears in no `wrangler.toml`, no `.env`, and no
`.dev.vars.example`, and is injected only on the CLI by `scripts/dev-stack.ts` and
`scripts/e2e-up.ts`. The vulnerability was the false reassurance sitting next to it, which is what
would let a future reviewer wave through a config change that set the var somewhere else.

**C4 — 11 regression tests** in `worker/index.test.ts` covering each header, the localhost HSTS
exemption, coverage of SPA fallback and invite-link routes, and an explicit guard asserting
`script-src` is *absent* — so the next person to tighten the CSP is forced to confirm the
marketing pages still render rather than discovering it in production.

## 6. Effectiveness check on existing countermeasures

What is working, and where each control's edge actually is.

**Holding up well:**
- **Parameterized SQL everywhere.** Re-confirmed; the only interpolated SQL remains
  `DELETE FROM ${t.name}` over a hardcoded table list in the `WRANGLER_LOCAL`-gated reset route.
- **The sync authorization perimeter.** Symbol-branded `AuthorizedEvent`, ESLint-enforced single
  construction site, per-event role policy, `aud:"sync"` rejection of access-token replay,
  15-minute project+file-scoped tokens. This is the strongest thing in the codebase.
- **Centralized authorization.** `resolveProjectRole` max-wins everywhere; `requirePlatformAdmin`
  as a single choke point backed by a deploy-config allowlist rather than a forgeable DB flag.
- **XSS sinks.** All three `dangerouslySetInnerHTML` sites still run DOMPurify; TipTap paste stays
  tag-allowlisted. This is what kept SEC-6 theoretical rather than live — but it is a single layer,
  which is the argument for C1.
- **Secrets hygiene.** `.gitignore` correctly excludes `**/.dev.vars*` while whitelisting
  `.example`; only placeholder files are tracked; CI uses `${{ secrets.* }}`. Re-scanned this run:
  clean apart from local-dev DSNs (`postgresql://aquilla:aquilla@127.0.0.1`).
- **`environment-guard.ts`** (new since June) asserts each Worker's bindings match
  `config/cloudflare-deployments.json` at boot. Good defense-in-depth against exactly the class of
  config mistake that makes V1 dangerous — though note it validates *hosts and plaintext vars*, not
  secret distinctness, so it does **not** catch V1 itself.

**Implemented but needs adjustment:**
- **Rate limiting** (`utils/rate-limit.ts`) fails open on DB error and prunes probabilistically
  (~1-in-50 calls) rather than on a schedule. Both are reasonable prototype trade-offs; both mean
  the control degrades silently under exactly the load that would accompany an attack. Worth a
  metric that alarms when the limiter starts failing open.
- **Token revocation** works, but only for tokens whose owner actively logs out. A password reset
  still does not invalidate outstanding sessions. Adding a `tokens_valid_after` timestamp per user,
  checked in `authMiddleware`, would turn "log out" into "log out everywhere" and make password
  reset mean what users assume it means.
- **Credit and AI-budget guards** are fully built, accurate, and **switched off**. Instrumentation
  without enforcement is the correct order to build it in and the wrong place to stop. Flipping
  `CREDIT_ENFORCE`/`AI_BUDGET_ENFORCE` is a one-line config change — deliberately left to a human,
  because the caps have never been enforced and the first enforcement run is where you find out
  whether a legitimate heavy user sits above them.
- **The June audit itself** is the control that worked best: nine of eleven findings closed in
  under two months. The gap it left is that nothing re-checks it. This document is dated for the
  same reason — it will be stale by October.

## 7. Recommended next steps, in order

Each needs a human either because it touches production secrets, flips a production flag, or
carries a breaking-change risk this run cannot test.

1. **Split `SECRET_KEY` and `SYNC_SECRET_KEY` per environment** (V1). Highest-leverage single
   change available. Rotate dev and staging to distinct values; accept that cross-env token reuse
   stops working — that is the point. Consider extending `environment-guard.ts` to assert the
   secrets *differ* across environments, so this cannot silently regress.
2. **Confirm a hard spend limit on the OpenRouter account** (V3). This is the fastest risk
   reduction on the list and takes one look at a dashboard. Then flip `AI_BUDGET_ENFORCE=true`,
   watch a week of log-only data first to check the caps do not clip real users, then
   `CREDIT_ENFORCE=true`.
3. **Drop `onnxruntime-node` from the install path** (V4, and most of V5 with it) — a pnpm
   `onlyBuiltDependencies` allowlist or an override, since the browser app never loads it. Removes
   install-time network RCE, the critical `tar` advisory, and both remaining high-severity
   tooling CVEs in one change.
4. **Add `tokens_valid_after` and invalidate sessions on password reset** (V2). Optionally shorten
   access tokens to 24h with refresh rotation — a UX decision, not a security-only one.
5. **Tighten the CSP** (C1 follow-up): measure with `Content-Security-Policy-Report-Only` plus a
   real report endpoint, add nonces to the prerender step, then add `script-src`/`connect-src`.
   Add `public/_headers` in the same pass so asset-router responses are covered, and test a
   preview deploy before production.
6. **Generic error responses** across the ~20 raw-`err.message` sites (V8); log detail server-side.
7. **Remove `sync-token` auto-registration** (V6); require an explicit create with membership.
8. **Re-stretch scrypt hashes on login** (V7) once the legacy frontier-DB compatibility constraint
   is retired.

---

_Findings reproducible from the cited `file:line` references against `dev` at `69b3268`.
Next review due ~2026-10._
