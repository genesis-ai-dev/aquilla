# Operational Security Review — 2026-08-09

_Scheduled review of Aquilla's own security posture. Follow-up to
`docs/SECURITY-NOTES-2026-06-10.md` (analysis-only; no code was changed then).
Every status below was **re-verified against the tree today** rather than carried
forward from the June document._

Labels follow the June convention: **FACT** = verified in code, **JUDGMENT** =
reasoned inference.

---

## 1. Critical data inventory

What this system actually holds, worst-first:

| Data | Where it lives | Why it matters |
|---|---|---|
| **Unpublished scripture translations** | `events` (append-only) → `cells`/`files` in Neon Postgres; source blobs in R2 | The crown jewels. Draft translations for minority-language communities. Premature disclosure or tampering carries real-world consequences for translators in sensitive regions — this is not generic SaaS content. |
| **Identity credentials** | `users.password_hash` (Werkzeug-compatible scrypt), Postgres | Reused passwords make a breach here a breach elsewhere. |
| **Session tokens** | HS256 JWTs, browser IndexedDB (`src/lib/frontier/session-store.ts`) | 30-day lifetime (see V2). Script-readable. |
| **Agent API PATs** | `api_credentials` (migration 0054), scoped org/project | Long-lived machine credentials against the external Agent API. |
| **Third-party user API keys** | Browser `localStorage` (`src/lib/store/user-api-keys.ts`) | User-supplied Gemini/OpenAI-compatible keys. Script-readable; billable if stolen. |
| **Platform provider keys** | Worker secrets: `OPENROUTER_API_KEY`, mail, Modal | Direct financial exposure. |
| **Signing keys** | `SECRET_KEY`, `SYNC_SECRET_KEY` | Compromise = mint any session or sync token. |
| **Org/member graph + comments** | Postgres | Reveals who is translating what, where — the targeting metadata for the threats below. |
| **Voice recordings** | R2 (`aquilla-snapshots`), `/audio/*` | Biometrically identifying; ties a named person to a project. |

The membership graph and the audio deserve emphasis: for a translator in a
region hostile to the work, *the association itself* is the sensitive fact, even
without the translation content.

## 2. Threat actors and motives

| Actor | Motive | Realistic capability |
|---|---|---|
| **Opportunistic credential stuffers** | Account resale, resource theft | Automated, high volume, low sophistication. **Most likely to actually happen.** |
| **Cost/resource abusers** | Free LLM inference on the platform's OpenRouter key | Registers legitimately, scripts the proxy. |
| **State or communal actors hostile to translation work** | Identify translators; suppress or tamper with output | Targeted, patient. Cares about the membership graph and audio as much as the text. This is the threat that makes Aquilla different from a generic SaaS. |
| **Compromised/careless insider or operator laptop** | Varies | Holds real credentials. Amplified by V1 (shared cross-environment secrets). |
| **Malicious external agent via the Agent API** | Corrupt translations at scale | Holds a PAT. Mitigated by the changeset approval gate. |
| **Supply-chain attacker** | Reach every user via one dependency | Fully realistic for a browser SPA with a large dependency tree. |

## 3–4. Vulnerabilities, with risk assessment

Status of every June finding, verified today. "Risk" is likelihood × impact.

| ID | Finding | Status today | Risk |
|---|---|---|---|
| SEC-1 | Prod/dev/staging share `SECRET_KEY` + `SYNC_SECRET_KEY` | **OPEN** [FACT] — `auth-worker/wrangler.toml:256` still documents dev reusing prod keys | **High.** Compromise of the least-hardened env mints prod-valid tokens. Highest-leverage single fix remaining. |
| SEC-2 | 30-day tokens, no revocation | **PARTLY FIXED** [FACT] — `jti` now minted (`auth/jwt.ts:35`) and checked via `isTokenRevoked` (`middleware/auth.ts:44`); `revokeToken` exists. But `ACCESS_TOKEN_EXPIRE_MINUTES` is still `43200` (30 days) in all four envs | **Medium** (was High). Revocation now exists; the long default lifetime still widens every stolen-token window. |
| SEC-3 | Unmetered LLM proxy | **FIXED** [FACT] — `runAiGuard` enforces a model allowlist + per-user/global daily budget (AQU-265) | Low residual. |
| SEC-4 | No auth rate limiting | **FIXED** [FACT] — `auth_rate_limit_events` (migration 0066); login/register/reset limits in `utils/rate-limit.ts`, wired into `routes/auth.ts` | Low residual. |
| SEC-5 | `SYNC_SECRET_KEY` doubles as admin bearer | **PARTLY FIXED** [FACT] — `constantTimeEqual` now used (`sync-worker/src/admin.ts`), but the signing key is still the admin credential | **Medium.** Every ops use sends the signing key in a header; timing leak closed, key reuse not. |
| SEC-6 | No CSP or security headers | **FIXED IN THIS CHANGE** — see §5. Tauri's `csp: null` was already fixed | Was Medium; now materially reduced. |
| SEC-7 | Dependency CVEs | **MOSTLY FIXED** [FACT] — hono resolves to 4.12.29 / 4.12.31 / 4.13.0 (all past the JWT advisory); `onnxruntime-web` repinned to stable 1.27.0. This change raises the declared floors so a fresh install cannot regress | Low residual. |
| SEC-8 | False reassurance on the dev-bypass gate | **FIXED IN THIS CHANGE** — comment corrected; the gate itself was and remains sound | Low. |
| SEC-9 | Sync-token auto-registers unknown projectIds | **OPEN** [FACT] — `routes/sync-token.ts:98` still INSERTs and grants OWNER | Low. Needs a leaked UUID of a never-registered project. |
| SEC-10 | scrypt N=32768, below OWASP N=2¹⁷ | **OPEN** [FACT] — `utils/password.ts:27` | Low. Legacy byte-compatibility constraint. |
| SEC-11 | Internal errors leak outside prod | Not re-verified this pass | Low. |

### New this pass

- **V-A — The SPA Worker's test suite runs in no automated gate.** [FACT]
  `worker/` has no `package.json`, no job in `ci.yml` (which is
  `workflow_dispatch`-only anyway — PR validation lives in Cloudflare Workers
  Builds, outside this repo), and root `vitest` excludes `worker/**`. Evidence
  it had gone stale: an assertion expected 5 wrangler asset blocks against a
  file that has 4, and had been red unnoticed. Fixed here, plus a
  `pnpm test:web-worker` script — but **wiring it into the real PR gate is an
  action outside this repo** and is left as a recommendation.
- **V-B — Inline bootstrap scripts block CSP enforcement.** [FACT]
  `index.html:36` and `homepage.html:64` carry inline theme scripts. Until they
  are hashed or externalised, `script-src 'self'` cannot be enforced. This is
  the single blocker to promoting the policy in §5 from Report-Only.
- **V-C — No CSP violation reporting endpoint.** [JUDGMENT] Report-Only surfaces
  violations only in each visitor's console, so nobody sees them centrally. A
  `report-to` endpoint is needed before the report data can drive enforcement.

## 5. Countermeasures applied in this change

Scoped deliberately to changes that are **safe to deploy without breaking a
working feature**. Anything requiring a secret rotation, an infrastructure
decision, or a product trade-off is recommended below, not done unilaterally.

1. **Baseline security headers on every response** — `worker/security-headers.ts`
   and `public/_headers`. Both are required and must stay in sync:
   `run_worker_first = ["/"]` means the Worker runs for the bare root *only*;
   every other path is answered by the static-asset router. A parity test
   asserts they agree, so the two cannot drift.
   Headers: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
   `Permissions-Policy`.

   **Two headers were deliberately left off.** `Strict-Transport-Security`
   belongs at the Cloudflare zone, where `includeSubDomains` can be decided for
   every `*.aquilla.app` host at once. `Cross-Origin-Opener-Policy: same-origin`
   was dropped after checking the Monday OAuth flow: the popup is opened
   *without* `noopener` on purpose because the code needs the handle to navigate
   it (`OrgSettingsMonday.tsx:114`). COOP severs that browsing-context group
   once the popup goes cross-origin, and the severance timing relative to the
   `popup.location.href` assignment can't be settled without driving a real
   browser through a real consent screen. Small gain, real risk to a working
   flow — a regression test now pins its absence with that reasoning.
2. **CSP, split by risk** — `frame-ancestors 'none'` is *enforced* (verified
   zero-risk: there is no `<iframe>` anywhere in `src/` or any marketing page).
   The full policy ships **Report-Only**, because enforcing it today would break
   production on the first deploy (V-B).
3. **Permissions-Policy denies what the app never uses** (camera, geolocation,
   payment, USB, sensors) while preserving `microphone=(self)` and
   `autoplay=(self)` — cell audio recording and TTS depend on them.
4. **Dependency floors raised** — `hono` `^4.12.14` → `^4.12.21` in auth-worker
   and agent-worker, so no fresh install can resolve a version vulnerable to the
   JWT NumericDate advisory in the very library doing JWT verification.
5. **Corrected the dangerous comment** in `auth-worker/src/routes/dev-seed.ts`
   (SEC-8). The old text told a future reader that a failed-open
   `WRANGLER_LOCAL` gate would be harmless. It would be an authentication
   bypass against live data: `/__dev__/login` runs `seedDev()`, which *creates*
   the `dev` user before minting its token.
6. **Repaired and made runnable the SPA Worker suite** (V-A).

**Deliberately not done here**, because each needs an owner's decision:

- **Rotate to per-environment signing keys (SEC-1).** Highest-value remaining
  item. An ops action, not a code change — and it invalidates existing sessions.
- **Shorten token lifetime (SEC-2).** Now that revocation exists, cutting 30 days
  to hours + refresh rotation is the natural follow-up, but it is a UX trade-off.
- **Mint a dedicated admin secret (SEC-5).** Requires updating ops scripts.
- **Stop auto-creating projects on sync-token mint (SEC-9).**

## 6. Effectiveness check

**What the June review demonstrably achieved.** Of 11 findings, 3 are fully
fixed (SEC-3, SEC-4, SEC-7), 3 partly (SEC-2, SEC-5, and SEC-6's Tauri half),
and this change closes 2 more (SEC-6, SEC-8). The two fixed Mediums were the
ones with automated, high-volume attackers behind them — the right ones to have
gone first.

**What needs adjustment.**

1. **The one High that never moved is SEC-1**, and it is now the top of the list
   by a clear margin. Cross-environment key sharing undoes much of the benefit
   of the revocation work: a dev-side leak still mints prod-valid tokens.
2. **Fixes were not landing with regression tests at the config layer.** V-A is
   the tell — a config assertion sat red in a suite nothing runs. Controls that
   live in `wrangler.toml` and `_headers` are exactly the kind that rot
   silently. Wiring `pnpm test:web-worker` into the Cloudflare Workers Builds
   PR gate is the concrete correction.
3. **Report-Only CSP is a stopgap, not a control.** It reduces nothing on its
   own. It becomes a real countermeasure only after V-B (hash or externalise the
   inline bootstrap) and V-C (a reporting endpoint). Without a scheduled
   follow-up this stalls half-done — worse than useless, because the header's
   presence *looks* like protection.

**Recommended next review:** after SEC-1 rotation, re-run this checklist and
promote the CSP if violation data is clean.
