# Operational Security Review — 2026-10-05

_Continues the standing series. Most recent entry: `docs/OPSEC-REVIEW-2026-09-28.md`
(see also `docs/OPSEC-REVIEW-2026-09-25.md`, the Friday infrastructure pass, which
merged after it and claimed OPS-40/OPS-41). New findings continue the **OPS-n**
series at **OPS-42**._

**Scope for this pass: authentication & session management** — the Monday slot,
which the 09-28 pass deliberately spent on the data layer instead. Two
constraints shaped where it looked:

1. **A parallel auth/session pass already ran this morning.** Commit `87397102`
   ("[Pen test] Auth & session hardening: username/email shadowing, PAT revoke on
   reset, password length cap, constant-time diarization token") landed on `dev`
   at 09:11 UTC and touched `auth-worker/src/routes/auth.ts` and
   `sync-worker/src/diarization.ts`. It wrote no review document, so its findings
   carry no OPS-n. **This pass therefore avoids `routes/auth.ts` entirely** —
   login, registration, password reset and email verification — rather than
   re-reading it hours behind someone else. That is the fourth concurrent-pass
   collision the series has recorded; §0's numbering note is still the right
   diagnosis, and scheduling is still the fix.
2. **The one authentication surface the series has never read is the newest.**
   Grepping every review for `mcp-oauth`, `MCP OAuth` and `client_id metadata`
   returns nothing: the OAuth 2.1 authorization server
   (`auth-worker/src/routes/mcp-oauth.ts`, `auth-worker/src/lib/mcp-oauth/`,
   `src/pages/OAuthConsent.tsx`) landed between 2026-10-01 and 2026-10-05 in
   AQU-1584/AQU-1529/AQU-1641 — after 09-21's route-mount sweep, which is the pass
   that would otherwise have caught it. Aquilla now **is** an authorization
   server, minting non-expiring act-mode credentials to third-party MCP hosts,
   and nothing in this series had looked at it.

So: the whole OAuth grant (metadata → authorize → consent → code → token →
credential-in-use), plus the device flow beside it, plus — because reading the
consent and invite surfaces together made it visible — where those surfaces'
URLs end up.

Both findings are **late-arriving gaps in controls the repo already built
elsewhere**, which is the same shape 09-25 reported: OPS-42 is OPS-29's
browser-side redaction never applied to the workers' own log shipping; OPS-43 is
a floor that two of its three enforcement points agree on.

No survey agent was used. Every finding is labelled **FACT** (verified against a
file:line or reproduced at this commit) or **JUDGMENT** (reasoned inference).

---

## Findings

### OPS-42 — Both workers copy live invite and access-link tokens out of the URL path into their logs, on the ordinary failures — **FIXED** [FACT]

Eight API routes carry a bearer credential (D5) as a **path segment** rather than
in a header or a body:

| Route | Credential in the path |
|---|---|
| `GET /api/v2/invites/:token/preview` | project invite token |
| `POST /api/v2/invites/:token/accept` | project invite token |
| `POST /api/v2/access-links/:token/redeem` | AQU-626 access-link token |
| `POST /api/v2/access-links/:token/revoke` | AQU-626 access-link token |
| `GET /api/v2/orgs/invite-preview/:token` | org invite token |
| `GET /api/v2/projects/invite-preview/:token` | project invite token |
| `DELETE /api/v2/orgs/:orgId/invites/:token` | org invite token |
| `DELETE /api/v2/projects/:projectId/invites/:token` | project invite token |

Both workers' request wrappers copy `url.pathname` verbatim into two sinks:

- **`shipErrorResponse`** (`auth-worker/src/posthog-logs.ts`,
  `sync-worker/src/posthog-logs.ts` — byte-identical files), called from
  `index.ts` for **every** response with `status >= 400`. It ships
  `http.path` plus a 500-character body snippet to **PostHog Logs**, a third
  party, in PostHog EU Cloud.
- **`console.warn("[slow-request] …")`** in both `index.ts` files, for any
  request over `SLOW_REQUEST_MS` (5s) — **including successful ones** — which
  lands in Cloudflare Workers Logs. `[observability] enabled = true` is declared
  in every env block of both `wrangler.toml`s, so these are retained, not
  ephemeral.

**The leaking cases are the ordinary ones, not the exotic ones.** A path only
reaches a log line when the request fails or runs slow, and for these eight
routes the common failures leave the credential **still live**:

- `POST /api/v2/access-links/:token/redeem` answers **401 `DEAD_LINK`** on a
  wrong PIN (`routes/access-links.ts`, after `verifyPasswordWerkzeugScrypt`
  fails). The link itself is untouched — the token is valid and only the 4–12
  digit PIN is missing. One mistyped PIN by a legitimate recipient writes the
  working link token into the log.
- `POST /api/v2/invites/:token/accept` and
  `POST /api/v2/access-links/:token/revoke` are behind `authMiddleware`, which
  **401s before the route runs** on an expired token, a `jti`-denylisted one, or
  one invalidated by a password change. A user who clicks an invite link with a
  lapsed session gets a 401 whose log line carries the live invite token. With
  30-day access tokens and a 90-day absolute session cap (`MAX_SESSION_AGE_DAYS`),
  that is a routine event, not an edge case.
- `countRecentEvents` 429s on the redeem throttle before the DB is touched at
  all — again with the token live.
- The slow-request path needs no failure whatsoever: a 5s `redeem` that
  **succeeds** logs the token.

**Why that matters more here than for a generic URL leak.** Invite tokens are the
one credential class in this schema still stored in **plaintext** — OPS-26
(`docs/OPSEC-REVIEW-2026-08-31.md`) reported it and deliberately left it, because
three product surfaces re-display a live token. So a logged invite token is a
*working* project grant at its stated `role_level`, not a hash of one; OPS-37
(09-28) rated the same rows critical when the agent's SQL tool could read them.
Access-link tokens are the AQU-626 diode-zone links, capped at
`LINK_ROLE_CAP = CONTRIBUTOR`, with the PIN as the only remaining factor once the
token is known.

**This is OPS-29 on the server side.** The 09-14 pass found exactly this class —
credential-bearing URLs exported to PostHog — and fixed it where it had looked:
in the browser, with a `before_send` redaction hook over `$current_url`,
`$pathname`, the persisted `$initial_*` person properties and rrweb's `href`. The
workers ship their own paths to the same vendor through an entirely separate code
path, and that pass did not touch it. A control applied to one of two producers
is the shape §3's V4a note keeps describing.

**Honest severity: one sink is live, one is armed but not firing.**
`POSTHOG_KEY = ""` in `[env.production.vars]` of both `wrangler.toml`s (and
nowhere else), and `shipLog` no-ops on a blank key — the comment there records
that the EU project token is a pending account-side dependency. So **the PostHog
arm is latent today and becomes live the moment someone pastes that token in**,
which is a config edit, not a code review [FACT]. The Cloudflare Workers Logs arm
(`console.warn`) is **live now** [FACT], with a narrower audience — anyone with
Cloudflare dashboard or Logpush access, i.e. the operator set §5 already treats
as the likeliest weak link. Fixing it before the key lands is the cheap ordering;
fixing it after is an incident with a retention window.

What this is *not*: a claim that Cloudflare's own edge request logs don't record
full URLs. They do, for any HTTP service, which is precisely why a bearer token in
a URL path is a poor design and why D5 already says so. The finding is that the
*application* additionally copies it into sinks of its own choosing, one of them a
third party, and that it did not have to.

**Fix.** `shared/log-path-redaction.ts` — a shape list, not an entropy heuristic,
because project ids are UUIDs and *are* wanted in logs, so "looks random" cannot
be the test. Four patterns cover the eight routes; every non-secret segment is
preserved, so `/api/v2/orgs/41/invites/:token` still names the org and the route.
Applied in `shipErrorResponse` in both workers and at all four `index.ts` log
sites (unhandled-error `shipLog`, slow-request `shipLog`, slow-request
`console.warn`, and the `http.path` attribute of each).

The redactor takes a **pathname, never a URL**, on purpose:
`routes/monday.ts:262` reads an OAuth `?code=` from a query string, nothing
redacts query strings, and a test pins that no sink reads `url.search`,
`url.href` or `searchParams`.

**The drift guard earned its place on first run.** It re-derives every route's
mounted path by parsing `auth-worker/src/index.ts`'s `app.route(...)` calls
against its import list, then fails for any route whose declared path contains a
credential-ish parameter (`token`, `inviteToken`, `linkToken`, `code`, `secret`,
`pin`) that `redactLogPath` does not blank. Written against the seven routes found
by hand, it immediately failed on an eighth —
`DELETE /api/v2/projects/:projectId/invites/:token`
(`auth-worker/src/routes/projects.ts:2232`) — which is now covered. It also fails
on a stale shape that matches no live route, so the list cannot rot in the other
direction either.

### OPS-43 — The OAuth organization allowlist's only post-mint check used a VIEWER floor, so a demotion could not narrow a token the demoted role had granted — **FIXED** [FACT]

AQU-1529 (2026-10-01) lets a human approving a ChatGPT/Claude/Codex connection
pick which organizations the resulting credential may act in. The grant floor is
**org MAINTAINER (600), or the org's owner** — below that an org is not offered
and cannot be chosen. That floor is applied in three places:

| Where | When | Floor |
|---|---|---|
| `eligibleOrganizations()` → `POST /api/v2/mcp-oauth/request` | consent screen | `role_level >= 600` |
| `eligibleOrganizations()` → `POST /oauth/token` | code redemption | `role_level >= 600` |
| the `org_ids` sub-select in `validateApiCredential()` | **every call the token makes** | `role_level >= 100` |

The third is the only one that runs *after* the credential exists, and it is the
one `mcp-oauth.ts`'s own header advertises: *"an ordinary API credential … with a
saved organization allowlist and **live-role checks on every call**"*. At VIEWER
(100) it re-checked a different, far weaker proposition than the one consent
enforced. An approver demoted from org MAINTAINER to VIEWER, COMMENTER, REVIEWER,
CONTRIBUTOR or PROJECT_LEAD kept every org they had delegated inside the token's
allowlist indefinitely — the allowlist had stopped meaning "orgs this user may
still delegate to an agent".

Reproduced against PGlite: with `role_level` on org 11 moved from 600 to 100,
`validateApiCredential` returned `orgIds: ["10", "11"]` at the pre-fix commit and
returns `["10"]` after. (The existing AQU-1529 test covered the approver
*leaving* the org — `DELETE FROM org_members` — which the 100 floor does catch.
Demotion, the commoner case, was the uncovered one.)

**Why this is drift and not a breach** [JUDGMENT, from the code paths]: the
allowlist *narrows*; it never grants. Every external surface additionally resolves
the caller's **live per-project role** — `scopeCredentialToProject`
(`sync-worker/src/external/read-auth.ts:126`) and `mintInternalSyncToken`
(`sync-worker/src/external/token-bridge.ts`), plus `credentialAllowsOrganization`
at seven more call sites — and the AQU-1107 org floor for project access is itself
600, so a demoted-to-VIEWER approver loses access to the org's projects they are
not directly a member of anyway. What survived was act-mode agent reach over the
projects they still personally hold a role on. That is their own access, not an
escalation past it — which is exactly why this sat unnoticed, and exactly why a
control whose stated job is to narrow should not be the one left at the wrong
threshold.

**Fix.** The floor is now a named export, `OAUTH_ORG_ALLOWLIST_FLOOR = 600`, in
`db/shared/api-credentials.ts`, with the owner arm untouched (an org's owner keeps
it at any `org_members` level, and a test pins that). It is redeclared rather than
imported because `db/shared` must not depend on a worker package — the same
convention `db/shared/command-catalog.ts` and `db/shared/cell-editing-floor.ts`
already use — so a test asserts `OAUTH_ORG_ALLOWLIST_FLOOR === ROLE.MAINTAINER`
against `auth-worker/src/types.ts` to keep the two from drifting again.

Narrowing only. No credential gains scope; the ones that lose it are the ones
whose owner can no longer grant it.

---

## Reviewed, no new finding

Each was read against the code, not assumed safe by category.

- **The OAuth code grant's core invariants** all hold. PKCE S256 is mandatory and
  the challenge is format-checked (`/^[A-Za-z0-9_-]{43}$/`) — `plain` is neither
  advertised nor accepted. `redirect_uri` is matched by **exact string equality**
  against the client document's list, with no prefix or wildcard arm, and is
  re-compared at the token endpoint. An untrusted client or redirect is
  `kind: "fatal"` and never redirected to. `/decision` re-validates the whole
  request from scratch rather than trusting the browser to carry a verdict. The
  code is 32 bytes from `crypto.getRandomValues`, stored only as a SHA-256, TTL
  5 minutes, and consume-and-mint happens in **one** statement, so a concurrent
  redemption mints nothing. A second redemption revokes what the first minted
  (OAuth 2.1 §4.1.3) instead of guessing which party is legitimate. Both consent
  routes are session-gated and throttled per user.
- **Audience binding is real and fail-closed.** An OAuth-minted credential stores
  `oauth_resource`, and `validateApiCredentialRequest` supplies an expected
  resource **only** for an `McpDelegatedRequest` — a JavaScript subtype a network
  client cannot manufacture. So the credential works at the MCP endpoint and
  nowhere else in the external REST tier; the mismatch arm is a rejection, not a
  skip.
- **`client_id` metadata documents (CIMD)** are fetched with `redirect: "manual"`,
  a 5s timeout, a 16KB cap checked against both `content-length` and the actual
  body, must return exactly 200, must be a JSON object, and must **name
  themselves** (`record.client_id !== clientId` → reject). `isClientIdUrl`
  requires https, a path, no userinfo, no fragment, no dot segments, and
  `url.href === clientId` so no normalisation game changes identity.
- **Consent-screen spoofing** was checked rather than assumed: `client_name` is
  self-declared and attacker-controlled (capped at 100 chars), so a hostile client
  can call itself "ChatGPT". `src/pages/OAuthConsent.tsx` renders the **verified
  host** (`client.clientHost`) and the **return host**
  (`client.redirectHost`) beside the name on every approval, which is the
  mitigation `client-metadata.ts` promises ("never shown without `host`"). React
  escapes the name, so there is no injection either. Left as is.
- **SSRF through the client-document fetch** — `resolveClient` fetches an
  attacker-chosen HTTPS URL and reflects the upstream status in its error text
  (`client metadata document returned HTTP ${status}`). Not raised as a finding:
  the call is session-gated and throttled (30/window), the scheme is https-only,
  the body is never reflected, and on Workers `fetch` reaches no private address
  space — so the oracle covers only public endpoints the caller could probe from
  their own machine. Worth revisiting if this ever runs anywhere with a reachable
  internal network [JUDGMENT].
- **The ignored `scope` parameter.** `authorizeSchema` accepts `scope` and
  `validateAuthorize` discards it, hardcoding `mode: "act"`. A client asking for
  read-only gets a write-capable credential. Not a finding: the metadata document
  advertises `scopes_supported: ["act"]`, the consent screen states `act`
  explicitly, and the human approves that. It is a least-privilege *product* gap
  (a read-only MCP connection is not offerable), recorded here rather than
  changed.
- **The RFC 8628 device flow** beside it (`routes/agent-connect.ts`) — `user_code`
  is 40 bits over a uniform 32-character alphabet (256/32 divides exactly, so the
  `% length` is unbiased), hashed at rest alongside the device code, 10-minute TTL,
  per-IP throttle on issue and per-user throttles on `/request` and `/decision`,
  an atomic poll claim that concurrent requests cannot both pass, explicit
  `code_confirmed`, a requested project that stays pinned rather than widening to
  its org, exactly one scope, and the approver's role re-checked at mint. The
  pacing comment correctly reasons that a 256-bit device code was never
  brute-forceable and that single-use is what the consume-and-mint statement
  enforces.
- **`middleware/auth.ts`** — unchanged since 09-21 and still correct: one
  `resolveSession` behind both the required and optional paths (OPS-25), a
  no-`exp` token rejected, the `sst` absolute session cap checked on every
  request rather than only at refresh, the `jti` denylist, and the
  `password_changed_at` cutoff re-run on every session-cache hit. The 30s
  isolate cache's documented cross-isolate revocation window is still the
  accepted trade it says it is.
- **`db/shared/api-credentials.ts` beyond OPS-43** — hashed lookup, revocation and
  expiry before use, the per-IP invalid-attempt throttle, `access === "read"` as
  the only narrowing value (so a pre-0113 NULL stays read-write), `pii === true`
  as the only opt-in, and a `last_used_at` bump that cannot fail authentication.
  `jsonb_exists` is used for allowlist membership, so a Postgres driver returning
  parsed JSONB keeps `orgIds` an array — had it arrived as a string,
  `credentialAllowsOrganization`'s `.includes()` would have been a substring
  match and org `13` would have satisfied a token scoped to `3`. No type parser
  is overridden anywhere in `db/shim/`, so it does not; worth knowing before
  anyone adds one.
- **`routes/auth.ts` and `sync-worker/src/diarization.ts`** — **deliberately not
  reviewed**, see the scope note. Commit `87397102` changed both hours before this
  pass and wrote no document; re-reading them here would duplicate work without
  being able to see its reasoning.

---

## Risk assessment

| ID | Finding | Likelihood | Impact | Risk | State |
|---|---|---|---|---|---|
| OPS-42 | Live invite / access-link tokens copied from the URL path into PostHog Logs (every 4xx/5xx) and Cloudflare Workers Logs (every slow request, success included) | **PostHog arm: certain once `POSTHOG_KEY` is filled in** — one config edit, and the triggering failures are a mistyped PIN and a lapsed session. **Workers Logs arm: happening now.** | **High** — invite tokens are the one credential class stored in plaintext (OPS-26), so each logged one is a working project grant at its stated role; access-link tokens leave only the PIN standing. Lands on D2+D3, the linkage §2 calls the reason this product is a target | **High** | Fixed |
| OPS-43 | OAuth org allowlist re-filtered at VIEWER (100) while consent and mint require MAINTAINER (600) — the only post-mint check was the one a demotion could not narrow | Medium — needs a demotion after a connection; ordinary org churn | **Low–Medium** — bounded by the live per-project role gate every external route runs, so not an escalation past the user's own access. The control that exists to narrow was the one left wrong | **Medium** | Fixed |

## Countermeasures applied in this change

| Control | Where |
|---|---|
| Path-credential redactor — shape list over the eight credential-bearing routes, preserving every non-secret segment | `shared/log-path-redaction.ts` |
| Applied to the 4xx/5xx PostHog shipper in both workers (identical files kept identical) | `auth-worker/src/posthog-logs.ts`, `sync-worker/src/posthog-logs.ts` |
| Applied to all four remaining log sites: unhandled-error `shipLog`, slow-request `shipLog`, slow-request `console.warn`, and the `http.path` attribute of each | `auth-worker/src/index.ts`, `sync-worker/src/index.ts` |
| Drift guard: every route whose mounted path declares a credential-ish parameter must be redacted; a stale shape fails too (found an eighth route on first run) | `shared/log-path-redaction.test.ts` |
| Pin: no log sink reads `url.search` / `url.href` / `searchParams`, so the Monday OAuth `?code=` cannot join the set | `shared/log-path-redaction.test.ts` |
| Regression tests over `shipErrorResponse` itself for all eight routes, incl. the wrong-PIN 401 and the lapsed-session 401 | `auth-worker/src/__tests__/posthog-logs-host.test.ts` |
| OAuth org allowlist re-filtered at the MAINTAINER floor consent enforces, owner arm preserved | `db/shared/api-credentials.ts` (`OAUTH_ORG_ALLOWLIST_FLOOR`) |
| Tests: demotion narrows the allowlist; ownership survives any `org_members` level; the constant equals `ROLE.MAINTAINER` | `auth-worker/src/__tests__/mcp-oauth.test.ts` |

**No UX/UI change, and no change to what any route returns.** OPS-42 only alters
log text. OPS-43 only narrows an OAuth credential whose owner was demoted below
the floor that minted it; nothing gains scope.

## Verification

* `npx vitest run shared/log-path-redaction.test.ts` — 24 tests, all passing
  (redaction of all eight routes, non-credential paths byte-identical, mount
  prefixes, no-widening, the drift guard, the stale-shape check, the
  no-query-string pin).
* `cd auth-worker && npx vitest run src/__tests__/posthog-logs-host.test.ts` — 15
  tests, all passing (9 new). The 8 OPS-42 assertions were confirmed **failing**
  against the pre-fix `posthog-logs.ts` (`git checkout` of that one file, re-run,
  8 failed / 7 passed) before the fix was restored.
* `cd auth-worker && npx vitest run src/__tests__/mcp-oauth.test.ts` — 26 tests,
  all passing (3 new). The OPS-43 demotion test was confirmed **failing** with the
  floor set back to 100 (1 failed / 25 passed).
* `cd auth-worker && npx vitest run src/__tests__/credentials.test.ts
  src/__tests__/agent-connect.test.ts src/__tests__/mcp-oauth-org-migration.test.ts
  src/__tests__/mcp-oauth-resource-migration.test.ts` — all passing; the other
  consumers of the changed credential query are unaffected.
* Full `auth-worker` suite (`npx vitest run`): **266 files, 3085 passing, 2
  expected-fail, 0 failures.** The three billing PGlite failures 09-28 reported
  as pre-existing are gone — commit `3f04ccdf` ("Test databases run parameterless
  SQL over the simple protocol, as production does", AQU-1635) fixed them on `dev`
  since. There is now nothing red in this package.
* Root `app` suite (`npx vitest run --project app`): **1568 files, 17682 passing,
  23 skipped, 6 failures — all in `src/components/import/ScriptAlignmentDialog.test.tsx`
  and all pre-existing.** That file arrived with AQU-1480 (`a103c139`, `172d367d`),
  which is already on `dev`; this change touches nothing under `src/` and nothing
  in `src/` imports any changed module (`db/shared/api-credentials`,
  `shared/log-path-redaction`, either `posthog-logs.ts`), so the two are disjoint.
  Noted rather than fixed — it is not auth/session work, and `dev` owns it.
* `npx eslint` clean on every changed file. `npx tsc --noEmit` reports no error in
  any changed file — in `auth-worker` the only remaining output is the
  `partyserver` `TS2307`s from `sync-worker`, whose package is not installed in
  this environment (same as 09-28).

---

_Re-run the mechanical parts of this review with: `npx vitest run
shared/log-path-redaction.test.ts && cd auth-worker && npx vitest run
src/__tests__/posthog-logs-host.test.ts src/__tests__/mcp-oauth.test.ts`._
