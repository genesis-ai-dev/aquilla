# Operational Security Review — 2026-08-10

_Scope: the operational security of **this project** — the data Aquilla handles, who would want it, where the practices around it are weak, and what changed since the last pass. Follow-up to `docs/SECURITY-NOTES-2026-06-10.md` (code-level findings, SEC-1…SEC-11), which this review re-checks in §6 rather than repeats._

Findings raised here are numbered **OPS-n** to keep them distinct from the June **SEC-n** series. Each is labelled **FACT** (verified against the tree at this commit) or **JUDGMENT** (reasoned inference). Two findings are fixed in the same change that adds this document; the rest are recorded with a recommended owner-decision, because they are configuration or policy calls rather than code.

---

## 1. Critical data — what this system actually holds

Ranked by what an incident would cost, not by volume.

| Rank | Asset | Where it lives | Why it matters |
|---|---|---|---|
| 1 | **Translator identity ↔ project linkage** | `users`, `project_members`, `orgs`, invite emails, comment authorship | Aquilla is used for Bible translation, including by teams working in jurisdictions where that work is legally or socially dangerous. "Who is translating what, with whom" is the highest-consequence datum in the system, and it is not a secret the platform can un-leak. |
| 2 | **Signing keys** — `SECRET_KEY`, `SYNC_SECRET_KEY` | Cloudflare Worker secrets | Mint identity and sync tokens for any user/project. `SYNC_SECRET_KEY` is additionally accepted verbatim as an admin bearer (`sync-worker/src/admin.ts:41`). |
| 3 | **Session JWTs** | Browser IndexedDB (`src/lib/frontier/session-store.ts`) | 30-day lifetime (`auth-worker/wrangler.toml:128`). Script-readable. |
| 4 | **Unpublished translation content** | `events` / `cells` in Neon, source blobs + snapshots in R2 `aquilla-snapshots` | Pre-release drafts; embargo and doctrinal-review sensitivity. Also the product's whole value to the customer. |
| 5 | **Voice recordings** | R2 via `/audio/*`, sent to Modal for diarization (`sync-worker/src/diarization.ts:113`) and voice conversion | Biometric-adjacent, and a recording identifies the speaker far more reliably than a username does. Leaves Cloudflare for a third-party GPU host. |
| 6 | **Credentials at rest** | scrypt/bcrypt password hashes; Agent-API PATs stored **SHA-256-hashed only** (`db/shared/api-credentials.ts:41`); users' own Gemini/OpenRouter keys in browser `localStorage` (`src/lib/store/user-api-keys.ts:15`) | PAT handling is correct (hash + display prefix, plaintext shown once). Browser-held third-party keys are the user's money, not ours. |
| 7 | **Platform third-party keys** | `OPENROUTER_API_KEY`, `DIARIZATION_SHARED_SECRET`, `AGENT_SANDBOX_KEY`, Monday.com OAuth tokens, CF Email Service | Direct spend, or lateral movement into the sandbox/notification paths. |
| 8 | **Auth telemetry containing PII** | `auth_rate_limit_events` (IP + lowercased email/username) | Introduced by the July rate-limit work. Pruned at 1 day (`auth-worker/src/utils/rate-limit.ts:66`) — proportionate. |
| 9 | **Product analytics + session replay** | PostHog (US), consent-gated (`src/lib/posthog.ts`) | Replays mask all inputs but not page text — see OPS-3. |

Deliberately **not** held: payment card data, government identifiers, health data. That absence is itself a control worth preserving.

## 2. Threats — who wants this, and why

| Actor | Target | Motive | Realistic capability |
|---|---|---|---|
| Opportunistic credential-stuffing botnet | User accounts | Resale, resource abuse | High volume, no targeting. Already the most-likely event by far. |
| Cost-abuse actor | The authenticated LLM proxy, TTS/diarization endpoints | Free inference on the platform's account | Requires only a signup. Financial DoS, not data loss. |
| Commercial scraper / competitor | Translation corpora in R2 and `cells` | Training data, competitive intelligence | Needs a valid token or a project-scope bug. |
| **State or non-state actor hostile to the translation work** | Asset #1 — translator identity and location | Suppression, coercion of named individuals | **Low probability, catastrophic and irreversible impact.** This is the threat that should drive data-minimisation decisions even when the expected-value maths says otherwise. |
| Insider / compromised operator laptop | Signing keys, admin bearer, Neon prod branch | Full impersonation | Plausible for any small team. Amplified by SEC-1 (shared keys across environments) — see §6. |
| Malicious dependency in the supply chain | Build output → every browser session | Token and API-key exfiltration | The `pnpm`/`npm` surface is large. CSP is the mitigation that assumes this happened. |

## 3. Vulnerabilities observed

### OPS-1 — [FACT] The browser build shipped with no CSP and no framing/transport headers — **fixed in this change**
The Tauri desktop shell has carried a full CSP since June (`src-tauri/tauri.conf.json:23`), but the web build — the surface that actually holds asset #3 and the users' own API keys — sent no `Content-Security-Policy`, no `X-Content-Type-Options`, no `Referrer-Policy`, no `Permissions-Policy` and no HSTS. There is no `public/_headers` and `worker/index.ts` set none. Any single XSS or compromised dependency (§2, last row) therefore had nothing between it and a 30-day token plus the user's provider keys.

### OPS-2 — [FACT] The `SYNC_SECRET_KEY`-as-admin-bearer pattern spreads a signing key through operator shells
Unchanged from SEC-5 apart from the (now correct) constant-time compare. Every ops invocation of an `/admin/*` route puts the *token-signing key* into shell history, terminal scrollback, and any intermediary's logs. This is a habit-level weakness, not a code bug: the code would be fine if the value were a dedicated admin secret.

### OPS-3 — [FACT capture / JUDGMENT sensitivity] Session replay records translation drafts as page text
`session_recording` masks all inputs and any `[data-ph-mask]` node, but deliberately keeps the rest of the page visible so replays are diagnosable (`src/lib/posthog.ts:17-23`). Draft translation text rendered outside an `<input>` — i.e. the editor surface — is therefore replayed into a third-party US SaaS. It is consent-gated and off by default (`opt_out_capturing_by_default`), which is the right shape. The gap is that the consent copy governs "analytics", while the asset at stake is unpublished translation content and, in the worst case, the visible identity of the person editing it.

### OPS-4 — [FACT] A test suite that no CI lane ran, with a failing assertion nobody saw — **fixed in this change**
The root `pnpm test` excludes all worker packages, and no check lane named `worker/` separately. That suite contains the deployment-config guards for the SPA Worker — including the assertion that the Cloudflare asset router cannot preempt the Worker at `/`. Its "one assets block per environment" assertion had been red since `7c2c3b5` retired the staging environment, and stayed red because nothing executed it. A guard that nothing runs is not a control.

Worth naming precisely, because the first attempt at this fix was itself placebo: **`.github/workflows/ci.yml` is `workflow_dispatch`-only** (AQU-564 handed pull-request validation to Cloudflare Workers Builds and explicitly cut the Actions triggers). Adding a step there would never have run on a pull request. The gate that actually executes is `scripts/cloudflare-ci-checks.mjs`, invoked via `pnpm build:workers-build`. Any future "add it to CI" reflex in this repo should start there — the Actions workflow is a retained manual fallback, not the check.

### OPS-5 — [FACT] The dev-login bypass carried a comment that argued its own gate didn't matter — **fixed in this change**
`auth-worker/src/routes/dev-seed.ts` is correctly gated on `WRANGLER_LOCAL=1` (injected only by `scripts/dev-stack.ts` and `scripts/e2e-up.ts`, defined in no `wrangler.toml`). But its header comment claimed that even a failed-open gate would let an attacker "only log in as a user that does not exist in prod" — false, since `seedDev()` *creates* that user. Nothing is exploitable today; the risk is that the next person to touch the gate believes the reassurance.

### OPS-6 — [JUDGMENT] No dependency-vulnerability or secret-scanning step in CI
`ci.yml` runs lint, typecheck, unit, build and per-worker suites. Nothing runs `pnpm audit`, and nothing scans a diff for credentials. June's SEC-7 was found by a human running `pnpm audit` by hand; the two items that mattered (`hono`, the `onnxruntime-web` nightly) are both resolved now (§6) — by ordinary dependency drift, not by a control that would catch the next one.

### OPS-7 — [FACT] Static assets bypass the Worker, so headers do not reach every response
`run_worker_first = ["/"]` plus the asset router means a literal `/index.html` or `/homepage.html` request is served without invoking the Worker and therefore without the OPS-1 headers. SPA deep links, `/`, and the `STATIC_PAGES` routes all do go through the Worker, so the documents users actually load are covered. Closing the remainder means a `_headers` file, which interacts with the legacy Pages deploys for the other brands — a deliberate follow-up, not an oversight.

## 4. Risk assessment

| ID | Likelihood | Impact | Risk | Note |
|---|---|---|---|---|
| OPS-1 | Medium — contingent on an XSS or a bad dependency | High — session token + user API keys | **High** | The contingency is exactly the one a defence-in-depth control exists for. |
| OPS-2 | Medium — one careless paste or one shared log | Critical — key mints tokens for any project | **High** | Highest-value remaining item; cheap to fix, but it is a secrets-provisioning change, not a code change. |
| OPS-3 | Certain — this is the designed behaviour | Low normally; **severe** for a team in a hostile jurisdiction | **Medium** | Risk is entirely about *which* customer opts in. |
| OPS-4 | Certain — it had already happened | Medium — a silent deployment-config regression reaches prod | **Medium** | The `/` routing regression this suite exists to catch previously shipped to production undetected. |
| OPS-5 | Low | Critical if the gate is ever weakened on the strength of the comment | **Low-Medium** | Pure documentation risk. |
| OPS-6 | Medium — new advisories land continuously | Medium-High | **Medium** | Detection gap, not an exposure. |
| OPS-7 | Low | Low | **Low** | The document responses that matter are covered. |

Ranked action order: **OPS-1, OPS-2, OPS-4, OPS-6, OPS-3, OPS-5, OPS-7.**

## 5. Countermeasures

**Implemented in this change (code):**

1. **Security headers on every Worker-served response** — `worker/security-headers.ts`, wired into `worker/index.ts`. Deliberately split:
   - *Enforced now*: `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'self'`, `form-action 'self'`, plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (microphone kept for `getUserMedia`; camera/geolocation/payment/usb denied), and `Strict-Transport-Security: max-age=31536000` on non-localhost hosts. None of these can break a page that isn't already doing something unwanted.
   - *Report-only*: the full policy (`script-src`, `style-src`, `connect-src`, `frame-src`, …), mirroring the Tauri CSP. The SPA's backend, analytics and model hosts are all injected at build time (`VITE_*`), and the marketing pages are prerendered, so enforcing blind would risk a production outage for a defence-in-depth control. Watch the console on the SPA and each marketing page, then promote directives into `ENFORCED_CSP` one at a time.
2. **`pnpm test:worker` added to the `spa` lane in `scripts/cloudflare-ci-checks.mjs`** — the gate Cloudflare Workers Builds actually runs on every pull request — and mirrored into the retained `ci.yml` fallback. The stale staging-era assertion in `worker/index.test.ts` is corrected, so the SPA Worker's deployment-config guards now gate merges (OPS-4).
3. **Corrected the dev-seed comment** so it states the true blast radius of a failed-open gate (OPS-5).

**Recommended, requiring an owner decision (not implemented here):**

4. **OPS-2 — mint a dedicated `ADMIN_SECRET`** for the `sync-worker` `/admin/*` routes and stop accepting `SYNC_SECRET_KEY` as a bearer. One `wrangler secret put` per environment plus a one-line change in `admin.ts`; it is out of scope for an unattended change only because it needs the secret provisioned first, in the right order, to avoid locking out ops.
5. **OPS-2/SEC-1 — split `SECRET_KEY`/`SYNC_SECRET_KEY` per environment.** Still the single highest-leverage change in the system. It ends the property that a dev-environment compromise mints prod-valid tokens. Cost: cross-environment token reuse in testing stops working, which is precisely the property that makes it dangerous.
6. **OPS-6 — add a non-blocking `pnpm audit --prod` job** on a weekly schedule rather than per-PR (per-PR fails on advisories in unrelated tooling and trains people to ignore it), and enable GitHub secret scanning + push protection on the repository. Both are settings-level, one-time.
7. **OPS-3 — make the replay trade-off explicit to the customer.** Either add `data-ph-mask` to the editor's cell-text surface, or state plainly in the consent copy that enabling replay sends draft text to a US processor. For any org that self-identifies as working in a restricted context, default replay off and do not offer it.
8. **OPS-7 — extend headers to asset-router responses** via a `_headers` file once its interaction with the remaining Pages-deployed brands is checked.

**Practices (people, not code):**

9. **Never paste a signing key into a shell.** Until #4 lands, admin routes should be exercised from a script that reads the key from the environment, so it never enters history.
10. **Compartmentalise by environment.** Treat the dev Neon branch and dev Worker as production-equivalent for as long as #5 is outstanding, because today they are.
11. **Invite hygiene.** Invite links are the identity-linkage disclosure path for asset #1. The OG-unfurl rewrite already keeps project, org and inviter names out of link previews (`worker/index.ts`, AQU-471) — hold that line; it is easy to undo by accident when someone asks for "nicer" invite previews.
12. **Phishing posture for the operator account.** Every control above sits behind one Cloudflare account and one GitHub account. Hardware-key 2FA on both is worth more than any item in §5.

## 6. Effectiveness check — what June's findings look like now

Re-verified against the tree, not assumed.

| June finding | Status | Evidence |
|---|---|---|
| SEC-1 — shared signing keys across envs | **Open** | `auth-worker/wrangler.toml:256` still documents the shared-key intent. Highest-leverage item outstanding. |
| SEC-2 — 30-day tokens, no revocation | **Substantially fixed** | `auth-worker/src/utils/token-revocation.ts` + migration 0073: `jti`-keyed denylist, server-side logout, `session-invalidation.test.ts` guards it. Lifetime is still 43200 minutes (`wrangler.toml:128`) — revocation now exists, so shortening it is a UX call rather than a security necessity. Pre-`jti` tokens remain unrevocable by design; they expire out by ~2026-09. |
| SEC-3 — unbounded LLM proxy | **Fixed** | `creditGuard`/`recordCredit` in `auth-worker/src/routes/chat.ts:151-165` — model allowlist plus per-user/global daily budget (AQU-265). |
| SEC-4 — no auth rate limiting | **Fixed, and extended beyond the original scope** | `auth-worker/src/utils/rate-limit.ts` now covers login, password reset, contact, register, and admin step-up verification. |
| SEC-5 — `SYNC_SECRET_KEY` as plaintext admin bearer | **Half fixed** | Compare is constant-time (`sync-worker/src/admin.ts:41`); the key is still doing double duty. Carried forward as **OPS-2**. |
| SEC-6 — no CSP; tokens/keys in script-readable storage | **Half fixed** | Tauri CSP landed (`src-tauri/tauri.conf.json:23`); the web build had none until this change (**OPS-1**). Storage locations unchanged, with the trade-off documented at `src/lib/store/user-api-keys.ts:5-9`. |
| SEC-7 — dependency CVEs | **Fixed by drift, not by control** | `hono` resolves to 4.12.25 (auth-worker), 4.12.33 (sync-worker), 4.12.31 (agent-worker) — all past the JWT `NumericDate` advisory. `onnxruntime-web` is now stable `1.27.0`, no longer a nightly. Nothing prevents the next one: **OPS-6**. |
| SEC-8 — misleading dev-bypass comment | **Fixed in this change** | **OPS-5**. |
| SEC-9 — sync-token auto-registers unknown projects as OWNER | **Open** | `auth-worker/src/routes/sync-token.ts:98-111` still inserts the project and grants OWNER when `projectName` is supplied. |
| SEC-10 — scrypt work factor | **Open (accepted)** | Legacy byte-compatibility constraint unchanged. |
| SEC-11 — error detail leaked outside production | **Not re-verified** | Out of scope for this pass; carry to the next. |

**Reading of the trend:** the July–August pen-test work closed the genuinely exploitable items (SEC-3, SEC-4) and built a real revocation primitive (SEC-2). What remains is the class of finding that needs a *secrets or settings* decision rather than a patch — SEC-1, OPS-2, OPS-6 — plus one detection gap (OPS-6) that let a real dependency risk resolve itself by luck. The two controls added here (headers, CI coverage of the Worker suite) are the parts of that list that code alone could close.

## Next review

Trigger the next pass on whichever comes first: the CSP report-only console coming back clean (promote directives, then re-review), the first paying org that self-identifies as working in a restricted context (re-weight §2 row 4 and OPS-3), or three months.
