# Operational Security Review — 2026-08-06

_Standing OPSEC review of Aquilla's handling of sensitive data. Complements
`docs/SECURITY-NOTES-2026-06-10.md` (application-security findings, June audit)
and the 2026-08-03 pen-test remediation work._

**Scope.** This is an *operational* review — what sensitive material the system
holds, who would want it, where the handling is weak, and which controls are
actually enforced rather than merely documented. It covers what is verifiable
from this repository and its deployment config. It does **not** cover the
operators' personal devices, password hygiene, or accounts, because none of that
is observable from here; §5 lists the operator-side practices that need to be
confirmed out of band, and they are the part of this review most likely to be
the real weak link.

Findings are labelled **FACT** (verified against a file:line in this tree) or
**JUDGMENT** (reasoned inference), following the convention set by the June
audit.

---

## 1. Critical data

Ranked by what it would cost us if it leaked, not by volume.

| # | Asset | Where it lives | Why it matters |
|---|---|---|---|
| D1 | **Signing keys** — `SECRET_KEY` (access tokens), `SYNC_SECRET_KEY` (sync tokens, and a plaintext admin bearer) | Worker secrets; `.dev.vars` locally | Holding either mints credentials for *any* user or project. Root of the whole trust tree. |
| D2 | **Unpublished translation drafts** — per-cell target text, comments, backtranslations | Postgres `cells`/`events`, R2 source blobs | Pre-publication scripture text for named languages. In restricted-access regions, *which* language is being worked on and *by whom* is the sensitive part, not the prose. |
| D3 | **Translator identity + activity** — emails, usernames, org/project membership, presence, focus locks, `last_used_at` | Postgres; the `ProjectSync` DO in memory | Presence and focus-lock data is a working-hours and collaboration graph. Combined with D2 this answers "who is translating what, and when" — the question that makes this product a target rather than a curiosity. |
| D4 | **Third-party credentials** — `OPENROUTER_API_KEY`, Monday client/signing secrets, GitLab admin token, Neon/Hyperdrive connection strings, R2 keys, `CLOUDFLARE_API_TOKEN`, Apple/Windows/Tauri signing keys | Worker secrets + GitHub Actions secrets | Direct financial loss (LLM spend), or — for the code-signing keys — the ability to ship a signed malicious desktop build. |
| D5 | **Bearer tokens in circulation** — 30-day access JWTs, 15-minute sync tokens, `aqk_` Agent-API PATs, invite tokens | Client IndexedDB / localStorage; `api_credentials` (hashed) | Each is a live credential. Invite tokens ride in a URL path, which is the least protected place a bearer token can be. |
| D6 | **Voice recordings and cloned voices** | R2 `aquilla-snapshots`, Modal services | Biometric-adjacent. A cloned voice is not revocable the way a password is. |
| D7 | **User-supplied vendor API keys** (Gemini/TTS/completion) | Browser `localStorage`, org settings in Postgres | Someone else's credential that we chose to hold. |
| D8 | **Session replays** | PostHog (third party) | Inputs are masked, but the page body is deliberately visible — so D2 draft text leaves our infrastructure by design. |

---

## 2. Threat actors and motives

| Actor | Motive | Realistic capability |
|---|---|---|
| **Opportunistic credential harvesters** | Resale, LLM-spend theft | Continuously scrape public GitHub, npm, and CI logs for D1/D4 patterns. Zero targeting cost; this is the highest-*likelihood* actor by a wide margin. |
| **State or para-state actors in restricted-access regions** | Identify and disrupt translation work and the people doing it | Interested in D2+D3 — specifically the *linkage*, not the text. Would target an account, a laptop, or an invite link rather than the crypto. Lowest likelihood, by far the highest impact: this is the threat where a leak is measured in personal safety, not dollars. |
| **Over-scoped insiders and agents** | Usually accident, not malice | Org members and PAT-bearing external agents already hold legitimate access to D2/D3. The exposure is *breadth* — a PAT scoped wider than the job needed. |
| **Supply-chain attackers** | Anything downstream | npm dependencies and GitHub Actions run with repo/CI credentials. See §3 V6. |
| **Phishers targeting maintainers** | Cloudflare / Neon / GitHub console access | A maintainer's session is equivalent to D1+D4 in one step, bypassing every control in this repo. Highest likelihood among the "targeted" actors. |

The second and fifth rows are why this review treats routine/activity metadata (D3)
as sensitive rather than as telemetry.

---

## 3. Vulnerabilities

### V1 — Sync auth bypass had no fail-closed guard — **FIXED IN THIS CHANGE** [FACT]

`ALLOW_UNAUTHENTICATED="true"` skipped sync-token JWT verification entirely for
`ProjectSync` WebSocket connections (`sync-worker/src/project-do.ts` `/connect`).
The only thing preventing it from being set on a deployed Worker was a comment in
`sync-worker/wrangler.toml:96` — and the flag is settable after the fact via
`wrangler secret put`, which no config review or deploy diff would catch. A
deployed Worker with it set would have let any unauthenticated client join any
project's realtime session: presence roster (D3), event stream, focus-lock
leases.

The existing `deploymentEnvironmentError` guard did not check it, and only fires
on the two first-party API hostnames — so a `*.workers.dev` alias or PR preview
was outside it entirely.

**Fixed:** `unauthenticatedBypassError` (`sync-worker/src/environment-guard.ts`)
503s the Worker when the flag is set in a deployed `ENVIRONMENT`, keyed on the
environment label rather than the hostname so previews are covered. The DO
re-checks at the authorization decision point rather than trusting the entry
point. Local dev (`ENVIRONMENT="local"`) and the E2E stack (no `[vars]` block)
are unaffected.

### V2 — No HTTP security headers on the web surface — **FIXED IN THIS CHANGE** [FACT]

The June audit's SEC-6 flagged the missing CSP. The Tauri shell has since gained
a real policy (`src-tauri/tauri.conf.json`), but the web app had **no** security
headers at all: no CSP, no HSTS, no `nosniff`, no framing policy, no
`Referrer-Policy`. That left `/join/:token` and `/join-org/:token` — URLs whose
path *is* a bearer token (D5) — relying on browser defaults not to forward the
path in a `Referer`, and left an app full of one-click irreversible actions
(archive project, remove member, apply agent changeset) framable by anyone.

**Fixed:** `worker/security-headers.ts` applies `nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY` +
`frame-ancestors 'none'`, a `Permissions-Policy` that keeps the microphone (the
app records cell audio) and denies camera/geolocation/payment, and HSTS on
non-local HTTPS origins.

**Still open:** a full `script-src` CSP. `run_worker_first = ["/"]` means these
headers land on the HTML surface but not on hashed asset responses, and a real
script policy needs a nonce threaded through the prerender step
(`scripts/prerender-marketing.ts`) to survive deploy. The Tauri policy is the
right starting shape. Until that lands, SEC-6's core point — one XSS yields a
30-day token plus the user's vendor API keys — stands.

### V3 — Invite tokens written to the browser console — **FIXED IN THIS CHANGE** [FACT]

`src/lib/sync/invites.ts:325` logged the full invite token on a failed revoke.
PostHog is initialised app-wide with session recording on
(`src/lib/posthog.ts`); its config comment correctly reasons that "passwords,
emails, invite tokens all enter through inputs" and are therefore masked — but a
token printed to `console` isn't an input and isn't masked. Console capture is a
server-side PostHog project setting, so whether this reached the third party
depends on config outside this repo. **JUDGMENT** on exposure; **FACT** that a
live credential was being written to an unmasked sink.

**Fixed:** logs a 6-character fingerprint instead.

### V4 — The SPA Worker's tests never ran — **FIXED IN THIS CHANGE** [FACT]

`worker/**` is excluded from the root `pnpm test` run (`vite.config.ts:206`)
like every other Worker package — but unlike the others, no CI job or hook ever
invoked it. Consequence, and the proof it mattered: the `wrangler.toml`
deployment-config contract test had been **failing** since the AQU-799 staging
retirement (`7c2c3b55`) and nobody knew. That test exists specifically to catch
routing regressions that unit tests can't see.

This is a control-effectiveness failure, not a bug: the check existed, was
well-designed, and was worth nothing because nothing ran it.

A second instance surfaced while verifying this change: the production case in
`scripts/verify-live-environment.test.ts` passed a retired `staging.aquilla.app`
origin to its fetch mock, so it threw `unexpected URL` instead of asserting
anything — leaving the deploy verifier's production path untested. `pnpm test`
was red on `dev` because of it (reproduced by stashing this change and running
the file at `HEAD`). Both instances are downstream of the same AQU-799 staging
retirement.

**Fixed:** `pnpm run test:worker` + a `web-worker-tests` CI job; both stale
assertions corrected.

### V4a — GitHub Actions is not currently producing meaningful results [FACT observation / cause UNVERIFIED]

Noticed while checking this change's own CI, and it matters here because it is
the delivery mechanism for every control in §5: **no CI run has produced a
usable result on any branch today.** As of 2026-08-06, every `CI` workflow run
across `dev` and all feature branches concluded `failure`, with the individual
jobs failing 2–10 seconds after start — far too fast to have run `pnpm lint` or
`pnpm test` — and their logs returning HTTP 404. The run opened for this change
did not appear at all.

Jobs that fail before executing anything, plus unavailable logs, point at the
Actions environment (quota, billing, or runner availability) rather than at repo
content. **The cause is not verified from here and should not be assumed.** What
is verifiable and worth acting on: a required check that fails in two seconds
for infrastructure reasons is indistinguishable, at the branch-protection layer,
from one that passed — so for as long as this persists, "CI is green" means
nothing, including for the credential scan added in V5.

**Not fixed here** — it is an Actions/org-level issue, not a code change. It is
the first thing to resolve, because it gates whether anything else in §5 is
actually enforced.

### V5 — No credential scanning in the toolchain — **FIXED IN THIS CHANGE** [FACT]

The June audit's S6 hand-scanned 1,655 files and found the tree clean; an
independent scan for this review agrees (no vendor-prefixed keys, PEM blocks, or
passworded connection strings in any tracked file; `.env*` and `**/.dev.vars` are
gitignored; CI uses `${{ secrets.* }}` throughout; no `pull_request_target`).
But "clean when a human last looked" is not a control — nothing prevented the
next paste. Against the highest-likelihood actor in §2, this was the gap.

**Fixed:** `pnpm run scan:secrets` (`scripts/secret-scan.ts`), wired into the
`lint` CI job so it sits behind an existing required check rather than an
optional one. Deliberately narrow — vendor-prefixed keys and unmistakable
structures only — because a noisy scanner gets bypassed within a week.

### V6 — Dependency vulnerabilities [FACT versions / JUDGMENT exploitability]

`pnpm audit --prod`: 9 advisories (1 critical, 4 high, 4 moderate).

- **`tar` ≤7.5.20** (1 critical + 1 high + 3 moderate) — reached only via
  `kokoro-js → @huggingface/transformers → onnxruntime-node`. All are
  parse/decompression DoS against a process that reads a tar; the browser build
  doesn't take that path. Transitive, so it needs an upstream bump or an override.
- **`sharp` <0.35.0** (high, libvips CVEs) — build/scripts-time image handling.
- **`adm-zip` <0.6.0** (high) — crafted-ZIP memory blowup, tooling path.
- **`react-router` <8.3.0** (high) — the advisory is RSC-mode CSRF; this is a
  client-rendered SPA with no RSC, so **likely not exploitable here** (same
  reasoning the June audit applied to the earlier turbo-stream advisory).

Since June: `onnxruntime-web` was repinned from a nightly dev build to stable
`1.27.0`, and sync-worker's `hono` floor moved to `^4.12.33`. auth-worker still
*declared* `^4.12.14` — below the JWT-validation advisory floor from SEC-7 — and
was only patched by lockfile resolution (4.12.25). Raised to `^4.12.21` here so
a fresh resolve can't land on a vulnerable version.

### V7 — Signing keys still shared between production and development [FACT]

SEC-1, unchanged. `auth-worker/wrangler.toml:256` still documents it as
intentional: "Same SECRET_KEY + SYNC_SECRET_KEY as prod so tokens minted against
dev still verify against prod workers during cross-env testing."

This is the single highest-leverage item left. It means the development
environment — looser controls, and per V1 the environment where auth-bypass
flags plausibly get set — holds a key that mints production credentials, and it
removes any ability to rotate one environment independently. Every other control
in this document is downstream of D1 staying secret.

Not fixed here: splitting the keys is a coordinated secret-rotation and
cross-environment-testing change, not a code edit.

### V8 — 30-day access tokens [FACT, partially mitigated]

`ACCESS_TOKEN_EXPIRE_MINUTES = "43200"` in all four wrangler profiles. SEC-2's
"no revocation path" has since been addressed — `auth-worker/src/utils/token-revocation.ts`
adds a `jti` denylist for server-side logout — but tokens minted before that
change carry no `jti` and cannot be revoked individually, and the 30-day window
itself is unchanged. Combined with script-readable client storage (SEC-6), a
single XSS still yields a month of access.

### V9 — Invite tokens travel in URL paths [FACT structure / JUDGMENT impact]

`/join/:token` and `/join-org/:token` put a bearer credential in a URL. URLs land
in browser history, chat-app link previews, and any intermediary that logs paths.
The mitigations already in place are good — `worker/index.ts` deliberately serves
generic invite unfurl copy so no org/project/inviter name reaches link scrapers
(AQU-471), and V2 now pins `Referrer-Policy`. The residual risk is a token
forwarded in a screenshot or a pasted URL, which is a user-behaviour problem, not
a code one. See §5.

---

## 4. Risk assessment

Likelihood is over roughly the next year, assuming current practices.

| ID | Vulnerability | Likelihood | Impact | Risk | State |
|---|---|---|---|---|---|
| V7 | Prod/dev share signing keys | Low | **Critical** — mints any credential (D1) | **High** | Open |
| V5 | No credential scanning | Medium-High | High — a committed key is scraped in minutes | **High** | Fixed |
| V1 | Sync auth bypass unguarded | Low | High — full realtime read of D2/D3 | **Medium-High** | Fixed |
| V8 | 30-day tokens, partial revocation | Medium | High — one XSS ⇒ a month of access | **Medium-High** | Partial |
| V2 | No web security headers | Medium | Medium — clickjacking, referrer leak of D5 | **Medium** | Fixed (CSP still open) |
| V6 | Dependency CVEs | Medium | Low-Medium — DoS, build-time paths | **Medium** | Tracked |
| V4a | CI producing no meaningful result | **Certain** (currently true) | High — every automated control below is unenforced | **High** | Open |
| V4 | Tests not running / silently red | **Certain** (already happened, twice) | Medium — silent routing and deploy-verifier regressions | **Medium** | Fixed |
| V3 | Invite token in console | Low | Medium — one project's membership (D5) | **Low-Medium** | Fixed |
| V9 | Tokens in URL paths | Medium | Medium — scoped, expiring, revocable | **Low-Medium** | Mitigated |

Note the shape of this table: the highest-risk rows (V4a, V7, V5) are *not*
sophisticated attacks. One is broken automation, one a documented convenience
trade-off, one an absent routine check. That is the normal distribution of OPSEC
failure — and V4a sitting at the top is the point: a control that doesn't run is
worth exactly as much as one that was never written.

---

## 5. Countermeasures

### Applied in this change

| Control | Where |
|---|---|
| Fail closed on the sync auth bypass in deployed environments | `sync-worker/src/environment-guard.ts`, `index.ts`, `project-do.ts` |
| Baseline HTTP security headers on the web surface | `worker/security-headers.ts` |
| Invite tokens fingerprinted, never logged whole | `src/lib/sync/invites.ts` |
| Credential scanning as a required CI check | `scripts/secret-scan.ts`, `.github/workflows/ci.yml` (`lint`) |
| SPA Worker suite actually runs | `pnpm run test:worker`, `web-worker-tests` job |
| auth-worker `hono` floor raised above the SEC-7 advisory | `auth-worker/package.json` |

Every one has a test. A control without a test is V4 waiting to happen again.

### Recommended next, in order

0. **Get CI actually running again (V4a).** Everything in the table above is
   delivered by a CI check. Until a failing check means "this change is bad"
   rather than "Actions didn't start", none of it is enforced.
1. **Split `SECRET_KEY` / `SYNC_SECRET_KEY` per environment (V7).** Highest
   leverage remaining. Replace cross-env token portability with a dev-only test
   fixture — the testing convenience it buys is not worth prod credentials
   living in the dev environment.
2. **Ship a web CSP (V2 remainder).** Start from the Tauri policy in
   `src-tauri/tauri.conf.json`; the work is nonce-threading through
   `scripts/prerender-marketing.ts`, plus allowing PostHog and the R2/HF model
   hosts in `connect-src`. Report-only first.
3. **Shorten the access-token TTL (V8).** 30 days is a deliberate choice made
   before revocation existed; now that `jti` denylisting works, a shorter TTL
   plus refresh is affordable.
4. **Add `overrides` for the transitive `tar` (V6)**, and re-audit on a schedule
   rather than during reviews like this one.
5. **Scope Agent-API PATs narrowly by default.** `db/shared/api-credentials.ts`
   supports org/project scoping and expiry; make the narrow choice the default
   in the minting UI rather than an option.

### Operator-side practices — confirm out of band

Not verifiable from this repo, and per §2 the likeliest single point of failure.
The Cloudflare, Neon, GitHub, and OpenRouter consoles collectively hold every
asset in §1, and none of this repo's controls apply to them.

- **Hardware-backed MFA (not SMS, not TOTP) on Cloudflare, GitHub, Neon,
  OpenRouter, and the Apple developer account.** Phishing-resistant MFA is the
  only control that survives the phisher in §2.
- **A password manager with unique credentials per service**, and no
  console credentials reused anywhere.
- **Compartmentalise the code-signing keys (D4).** `TAURI_SIGNING_PRIVATE_KEY`
  and the Apple/Windows certificates are the only assets here that let someone
  ship signed malicious software to users. They should not be reachable with the
  same session that reads a PR.
- **Scope the `CLOUDFLARE_API_TOKEN` in CI** to the Workers/Pages it actually
  deploys, not account-wide.
- **Treat invite links as credentials (V9)** — never in a screenshot, a public
  channel, or a ticket. Prefer email invites, which are scoped to a recipient.
- **Least-privilege GitHub Actions.** No `pull_request_target` today (verified);
  keep it that way, since it hands fork-authored code the repo's secrets.

### Training

Two things, not a curriculum:

- **Phishing that targets consoles, not inboxes.** The realistic lure is a
  Cloudflare or GitHub "verify your account" page, not a Nigerian prince. Anyone
  with console access should have seen what that looks like.
- **What the product's data actually means (D2/D3).** Everyone touching this
  system should understand that for some projects the sensitive fact is *which
  language is being translated and by whom* — so a screenshot of a project list
  in a public support thread can matter more than the draft text in it.

---

## 6. Effectiveness of existing controls

Reviewed against what the June audit and the 2026-08-03 pen test put in place.

### Working, keep

- **`AuthorizedEvent` perimeter** (S2) — symbol-branded, ESLint-enforced,
  single construction site. Still the strongest thing in the codebase.
- **Parameterized SQL everywhere** (S1) — re-checked; the only interpolated SQL
  remains `DELETE FROM ${t.name}` over a hardcoded list in the `WRANGLER_LOCAL`-gated
  reset route.
- **PAT handling** (`db/shared/api-credentials.ts`) — SHA-256 hashed at rest,
  plaintext returned once, greppable `aqk_` tag so a leaked token is
  *recognizable*, display prefix that can't reconstruct the secret,
  throttled `last_used_at`. This is the model the rest of the system should follow.
- **Secret redaction where it exists** — agent-memory writes reject
  credential-shaped content (`auth-worker/src/lib/agent/memory-writes.ts`);
  org settings redact vendor keys on read (`auth-worker/src/routes/org-settings.ts`).
- **`WRANGLER_LOCAL` gating** of `/__dev__/*` and `/__test__/reset` — verified
  again: set only via CLI in `dev-stack.ts` / `e2e-up.ts`, never in a
  wrangler.toml or `.dev.vars.example`.
- **Deployment environment guards** — both workers fail closed when a
  first-party API hostname is served with another environment's bindings. V1
  extends this pattern rather than inventing a new one.
- **CORS** (S7) — `*` is correct for a cookie-less bearer API. Re-confirmed: no
  credentialed CORS, no origin reflection.
- **PostHog masking** — `maskAllInputs: true`, opt-out by default until consent.
  Sound. V3 was the gap it didn't cover.

### Needs adjustment

| Control | Problem | Action |
|---|---|---|
| `worker/` test suite | Existed, never ran, went red unnoticed (V4) | Fixed — CI job added |
| Root `unit` CI job | Was red on `dev` via a self-neutralising mock (V4) | Fixed |
| **CI as a whole** | Jobs fail in ~2s before running anything, so no check result is meaningful (V4a) | **Open — resolve first; every §5 control depends on it** |
| `wrangler.toml` comments as the only guard on `ALLOW_UNAUTHENTICATED` | A comment is not a control (V1) | Fixed — enforced in code |
| PostHog input masking | Doesn't cover console output (V3) | Fixed at the source; keep console capture off in the PostHog project |
| Environment separation | Explicitly defeated for signing keys (V7) | Open — recommendation #1 |
| Dependency hygiene | Audited only during reviews like this one (V6) | Schedule a recurring audit; add `overrides` for transitive `tar` |
| Secret hygiene | Verified by hand in June, unenforced since (V5) | Fixed — `scan:secrets` in CI |

### Regressed or unchanged since June

- **V7 / SEC-1** — unchanged, and now the top open item.
- **SEC-5** — `SYNC_SECRET_KEY` still doubles as a plaintext admin bearer with a
  non-constant-time compare. Not re-examined in depth here; still valid.
- **SEC-9, SEC-10, SEC-11** — not re-examined; assume open.

---

_Re-run the mechanical parts of this review with: `pnpm run scan:secrets`,
`pnpm audit --prod`, `pnpm run test:worker`._
