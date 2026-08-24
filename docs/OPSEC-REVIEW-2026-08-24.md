# Operational Security Review — 2026-08-24

_Sixth pass in the standing series. Follows `docs/OPSEC-REVIEW-2026-08-20.md`
(OPS-15…OPS-17), `docs/OPSEC-REVIEW-2026-08-17.md` (OPS-11…OPS-13),
`docs/OPSEC-REVIEW-2026-08-13.md` (OPS-8…OPS-10),
`docs/OPSEC-REVIEW-2026-08-11.md`, `docs/OPSEC-REVIEW-2026-08-10.md`
(OPS-1…OPS-7) and `docs/OPSEC.md` (V1…V9). New findings continue the **OPS-n**
series at OPS-18._

**Scope for this pass: authentication & session management**, the Monday slot
in the rotating weekly cycle (**auth/session Mon**, authz/access Tue,
injection Wed, API/data exposure Thu, infra/deployment Fri). Reviewed
`auth-worker/src/routes/auth.ts` (register, login, logout, self-update, email
verification, the three password-reset endpoints),
`auth-worker/src/middleware/auth.ts`, `auth-worker/src/auth/jwt.ts`,
`auth-worker/src/utils/{password,rate-limit,token-revocation}.ts`, and
`auth-worker/src/routes/sync-token.ts`.

Every finding is labelled **FACT** (verified against a file:line or a test run
at this commit) or **JUDGMENT** (reasoned inference). All three findings below
are fixed in this change.

**What this pass turned up.** The credential-guessing side of this surface has
been worked over repeatedly (five prior `[Pen test] Auth & session mgmt`
windows are commented inline) and it holds up: every unauthenticated endpoint
is throttled, logout revokes by `jti`, a password reset invalidates every
prior token via `password_changed_at`. What had *not* been looked at is the
**enumeration** side — the question "does an account exist for this address?",
which the OPSEC threat model (`docs/OPSEC.md` §2, D3) treats as sensitive in
its own right, because in a restricted-access region the fact that a person is
a translator on this platform is the exposure, not their password. Two of the
three findings are that question answered through a channel nobody had
measured: response *time* (OPS-18) and error *shape* (OPS-19). The third
(OPS-20) is a storage finding: the one class of bearer credential in this
system still kept in plaintext at rest.

---

## Findings

### OPS-18 — Login response time is a user-enumeration oracle — **FIXED** [FACT]

`POST /api/v2/auth/token` took two very different amounts of work depending on
whether the identifier resolved to an account:

- **No account** (`auth.ts:476-482`, pre-change): one indexed `SELECT`, then a
  straight `401`.
- **Account exists, wrong password**: the same lookup *plus* a full werkzeug
  scrypt derivation at the production parameters (`N=32768, r=8, p=1`,
  `utils/password.ts:26-30`) — deliberately expensive, then the same `401`.

The response bodies were already identical (`"Incorrect username/email or
password"`), and the 2026-07-20 pass explicitly reasoned about timing when it
put the throttle check *before* the user lookup. But the branch that actually
dominates the clock was never equalized. Measured on the test harness at this
commit: **~5 ms for a nonexistent identifier vs ~110 ms for a real one** — a
20× difference, and not a subtle statistical one.

The existing throttles do not blunt this. `LOGIN_MAX_FAILURES_PER_IDENTIFIER`
(8) never engages, because enumeration uses each identifier exactly once;
only `LOGIN_MAX_FAILURES_PER_IP` (20 / 15 min) applies, so a single source
confirms ~80 addresses an hour and a modest proxy pool scales that linearly.
The attacker needs no password and never has to succeed at anything.

What that buys an attacker is the D3 linkage in `docs/OPSEC.md` §1 — given a
list of candidate email addresses (a language-group mailing list, a partner
org's staff directory), it says which of those people are on this platform.
That is the input to the targeted-phishing and identify-the-translators
threats in §2, not a curiosity.

**Fixed:** `absorbPasswordVerificationCost()` (`utils/password.ts`) verifies
the submitted password against a fixed, syntactically valid werkzeug hash with
the production parameters whose digest is filler bytes — so it burns the same
scrypt work and can never return true. The no-such-user branch of `/token`
calls it before returning (`routes/auth.ts`). It swallows its own errors: a
failure there is a timing-equalization miss, not an auth decision, and turning
a `401` into a `500` would be a louder oracle than the one being closed.

Guarded by `auth-worker/src/__tests__/login-enumeration.test.ts`, which
compares medians of interleaved samples and fails below a 0.35 ratio. Verified
to bite: with the fix reverted it reports `ratio 0.05` and fails; with the fix
in place the branches are within noise of each other.

**Residual:** `POST /auth/register` still answers `409 "User already exists"`,
which is a *direct* enumeration oracle for anyone willing to spend a
registration attempt (throttled at `REGISTER_MAX_PER_IP` = 15 / 15 min). That
one is a deliberate UX trade — a signup form that can't say "that's taken" is
close to unusable — and it is already noted in `utils/rate-limit.ts:43-49`. It
costs more per probe than the timing channel did and is rate-limited on the
only axis that matters. Left as-is; flagged so the next pass doesn't
rediscover it as new.

### OPS-19 — Password-reset request reflected internal error text, and re-opened its own enumeration oracle — **FIXED** [FACT]

`POST /api/v2/auth/password-reset/request` is built around one rule, stated in
its own comments: the response is identical whether or not the address is
registered, and whether or not it was throttled. Two things broke that rule.

First, the handler's catch-all returned the raw internal error message to an
unauthenticated caller:

```ts
const errorMessage = error instanceof Error ? error.message : "Unknown error"
return c.json({ error: `Failed to send reset email: ${errorMessage}` }, 500)
```

This is precisely the bug SEC-11 fixed in `/register` in the same file, whose
fix note reads: *"this branch used to echo `msg` verbatim, in every
environment… The status code is the useful part; the text is already in the
log line above."* The reset route kept the pattern — reflecting Postgres
error strings, constraint names, and upstream URLs to anyone who can make the
handler throw.

Second, and worse, that catch wrapped the **whole** handler, including the
work that only runs for a registered address: the token `INSERT`, the email
send, the activity-log write. So any failure in that block produced a `500`
with a distinctive body, while an unregistered address got the generic `200` —
the enumeration oracle the 2026-07-20 pass believed it had closed. That pass
fixed exactly one instance of it (wrapping `sendPasswordResetEmail` in its own
try/catch, with a comment explaining the reasoning) and left every sibling
statement on the same branch inside the reflecting catch. A DB hiccup during
the token mint, and the route reports which addresses have accounts.

**Fixed** by splitting the handler at the lookup:

- Everything up to and including the user lookup — the throttle count and the
  `SELECT`, which run identically for registered and unregistered addresses —
  stays in a `try` whose `catch` now returns a fixed `"Failed to send reset
  email"` with no interpolation.
- Everything after it is registered-only and gets its own `catch` that logs
  loudly and **returns the generic 200 anyway**.

**The trade-off in the second half is deliberate and worth stating plainly:** a
caller whose token mint genuinely failed is now told a link is coming when it
isn't. That is a real (rare, transient, retryable) UX cost, accepted because
this route's threat model puts "is this person a user of this product" above a
misleading success message, and because the failure is loud in the logs where
an operator will see it.

Guarded in `password-reset.test.ts` by a test that makes the token `INSERT`
fail for the duration of one request (a `CHECK` the row can't satisfy) and
asserts the response is byte-identical to the unregistered-address response —
including an assertion that no token row was written, so the test can't pass
vacuously.

### OPS-20 — Password-reset and email-verification tokens stored in plaintext at rest — **FIXED** [FACT]

`password_reset_tokens.token` and `email_verification_tokens.token` held the
raw bearer token (`db/postgres/schema.sql:108-124`, pre-change). The reset
token is a **full account-takeover credential with a 24-hour life**: presenting
it to `/password-reset/reset` sets a new password for the account, with no
password, no mailbox access, and no second factor involved.

This is the only class of bearer credential in the system still kept in the
clear. Agent-API PATs have been SHA-256'd at rest since they were introduced
(`db/shared/api-credentials.ts:55-75`), and `docs/OPSEC.md` §1 lists D5
("bearer tokens in circulation") as *"`api_credentials` (hashed)"* — a
description that was accurate for the table it names and quietly wrong about
the two tables next to it.

The exposure is anyone with **read-only** access to the database rather than
write access to the app: a Neon snapshot or branch, a read replica, a backup,
a support engineer running a `SELECT`, a logged query, or a compromise that
gets no further than read. Any of those yields live takeover links for every
reset in flight, and using one leaves a trail indistinguishable from a
legitimate reset. The 24-hour TTL bounds the window but not the blast radius:
a reset table is at its fullest exactly when an incident is under way and
everyone is resetting their password.

**Fixed** in migration `db/postgres/migrations/0080_auth_token_hashing.sql`:
both tables gain a `token_hash TEXT` column with a unique index, and `token`
becomes nullable. From this change on, the routes write
`token = NULL, token_hash = sha256hex(token)` and look up by digest, using the
same `sha256Hex` primitive the PATs use. The plaintext never leaves the
request that mints it — it exists only in the emailed link.

Rows minted before the deploy keep their plaintext and a `NULL` hash, and all
four lookups carry an explicit `token_hash IS NULL AND token = ?` arm so links
already sitting in someone's inbox keep working through the rollover. That arm
is dead 24 hours after deploy for resets and 7 days after for verification;
the migration header carries the removal steps, and the two tests that cover
it are commented to be deleted alongside it.

Guarded by tests asserting the stored row has `token IS NULL` and a 64-hex
`token_hash` for both flows, plus rollover tests that exercise the plaintext
arm. Two existing tests that recovered the plaintext token out of the table to
drive the rest of a flow (`email-verification.test.ts`,
`activity-log-writes.test.ts`) had to be rewritten to plant a token whose hash
they control — which is the fix demonstrating itself.

### OPS-21 — The required PR check is red on `dev`, and it fails before the lanes that would run any test — **NOT FIXED, reported** [FACT]

Found while verifying the three fixes above: the Workers Build that gates every
pull request (`scripts/cloudflare-ci-checks.mjs`, AQU-564 — `ci.yml` and
`e2e-hetzner.yml` are both `workflow_dispatch`-only, so this is the *only*
automatic PR validation) fails on `dev` itself, and fails in a way that
silently skips most of what it is supposed to check.

`runParallelChecks` runs three **sequential** phases and throws on the first
phase with any failing lane, so a later phase never starts:

| Phase | Lanes | Status |
|---|---|---|
| 1 `frontend-contracts` | ROOT (`pnpm test`), **LINT**, AGENT | **fails** |
| 2 `backend-contracts` | SYNC, RELEASE | never runs |
| 3 `final` | **IDENTITY**, SPA | never runs |

`pnpm lint` reports **399 errors, every one of them `i18n/no-unkeyed-string`**,
across 118 files (100 in `src/components/`). Lane steps also run in sequence
and abort on failure, so `i18n:check` — the next step in the same lane — never
runs either. `scan:secrets` runs *first* and passes; that ordering is OPS-13's
fix and it is holding.

The consequence is the part that matters. Because phase 3 never starts, the
**IDENTITY lane never runs** — which is `auth-worker`'s `type-check` *and* its
full 1496-test suite, including every test added by this change. The SYNC,
RELEASE and SPA lanes are skipped for the same reason. The gate reports
failure, so nothing merges silently — but no PR in this window has had its
worker suites or its SPA build actually executed.

This is the OPS-13 / OPS-17 pattern for the third time in this series, and
this time the lint-lane comment in `cloudflare-ci-checks.mjs` describes the
present state almost verbatim: *"that is exactly what was happening on `dev` at
the time this was written (484 eslint errors from the i18n gate), which turned
'rides an already-required check' into 'rides a check that was already
failing'."* Same rule, same gate, 399 errors instead of 484.

**Not fixed here, deliberately.** None of the 399 errors is in a file this PR
touches (verified: zero overlap between the 118 error files and this diff's
10), the rule is unrelated to auth/session, and fixing it would mean touching
100+ component files in a security change. Fixing it also would *not* turn this
PR green on its own — see the second item below. Reported with patches rather
than absorbed:

- **The 399 `i18n/no-unkeyed-string` errors** are the blocker and belong to
  whoever owns the i18n gate. They need either the strings keyed or the rule's
  scope revisited — a decision, not a mechanical fix.
- **`auth-worker` `type-check` is separately red on `dev`**: 5 × `TS18046
  'body' is of type 'unknown'` in
  `src/__tests__/contextual-decisions-routes.test.ts` (lines 105-108, 138),
  reproduced against `origin/dev`'s sources with CI's own dependency set. Fix
  is two annotations — `const body = (await res.json()) as { … }` at the two
  `await res.json()` sites — matching how every sibling test in that file
  already types its body. Left to the owner of that file for the same reason.

**Measurement note, correcting this document's own first draft:** the
"15 pre-existing type errors" figure originally reported here was measured with
`auth-worker`'s deps installed via `npm ci` (its `package-lock.json`), which
resolves `@cloudflare/workers-types` 4.20260702.1. CI installs with
`pnpm --frozen-lockfile` (its `pnpm-lock.yaml`), which resolves 4.20260610.1
and does not produce the `ExecutionContext<unknown>` / `tracing` mismatches.
Under CI's actual dependency set the true figure is **5 errors, all
pre-existing, all in the file named above** — unchanged by this PR. The two
lockfiles in `auth-worker/` disagreeing about a types version is a smaller
finding in its own right, and worth a look.

---

## Risk assessment

| ID | Finding | Likelihood | Impact | Risk | State |
|---|---|---|---|---|---|
| OPS-18 | Login timing reveals whether an account exists | High — unauthenticated, no password needed, 20× signal, throttles don't cover it | Medium — D3 linkage feeding targeted phishing / translator identification | **High** | Fixed |
| OPS-19 | Reset-request catch reflects internals and re-opens the enumeration oracle | Medium — reflection on any handler throw; oracle needs an induced failure | Medium — internal detail disclosure + the same D3 linkage | **Medium** | Fixed |
| OPS-20 | Reset / verification tokens in plaintext at rest | Low — needs DB read access | High — 24h account takeover per pending reset, no trace | **Medium-High** | Fixed |
| OPS-21 | Required PR gate red on `dev`; worker suites and SPA build never execute | Certain — reproduced at this commit | Medium — the gate fails loudly, so nothing merges unchecked, but nothing is checked either | **Medium** | Reported, not fixed (see finding) |

---

## Countermeasures applied in this change

| Control | Where |
|---|---|
| Constant-cost password verification on the no-such-user login branch | `auth-worker/src/utils/password.ts` (`absorbPasswordVerificationCost`), `auth-worker/src/routes/auth.ts` |
| Reset-request handler split at the lookup; fixed error string, generic 200 for registered-only failures | `auth-worker/src/routes/auth.ts` (`/password-reset/request`) |
| Reset + email-verification tokens stored as SHA-256 digests, looked up by digest, with a bounded plaintext rollover arm | `db/postgres/migrations/0080_auth_token_hashing.sql`, `db/postgres/schema.sql`, `auth-worker/src/routes/auth.ts` |

Every one has a test:
`auth-worker/src/__tests__/login-enumeration.test.ts` (new — OPS-18, verified
to fail with the fix reverted), `password-reset.test.ts` (OPS-19's
induced-failure test, OPS-20's digest and rollover tests),
`email-verification.test.ts` (OPS-20 digest + rollover). Full auth-worker suite
green: **146 files, 1496 tests**. Under CI's own dependency set
(`pnpm --frozen-lockfile`), `tsc --noEmit` reports the same **5** pre-existing
errors before and after this change — all in
`contextual-decisions-routes.test.ts`, none in any file touched here; see
OPS-21 for that figure's correction and for why CI itself never reaches this
step. `pnpm lint` reports zero errors and zero warnings in the files this
change touches.

## Reviewed, no finding

- **Token revocation on logout** (`utils/token-revocation.ts`,
  `middleware/auth.ts:44`). Denylist keyed on `jti`, checked on every
  authenticated request, pruned against the token's own `exp`, fails open on a
  DB error with that decision documented and justified. Sound as built.
- **`password_changed_at` session invalidation** (`middleware/auth.ts:59-69`).
  Rejects any token whose `iat` predates the last reset. The comparison is
  strict (`payload.iat < changedAtSeconds`), so a token minted in the same
  whole second as a reset would survive — but no code path mints a token at
  reset time (`/password-reset/reset` returns a message, not a token), so
  there is nothing to exploit. Noted, not changed; changing it would be
  churn.
- **`JWTService.extractTokenFromHeader`** (`auth/jwt.ts:70-84`). Deliberately
  permissive — accepts a bare JWT and scans segments for a dotted triple — to
  match the legacy frontier-server. Permissive *parsing* is not permissive
  *verification*: everything it returns still goes through `verify()` with
  `SECRET_KEY`. No finding.
- **Sync-token minting** (`routes/sync-token.ts`,
  `services/sync-token-mint.ts`). Sits behind `authMiddleware`, so a revoked
  or reset-invalidated access token cannot mint new sync tokens. A sync token
  already in flight outlives a logout by at most its 15-minute TTL, which is
  the intended design and is bounded.
- **Login throttling and the reset-flow throttles** (`utils/rate-limit.ts`).
  Failure-only counting, per-identifier and per-IP scoping, checked before the
  DB lookup, fail-open on infrastructure error. Re-read in full against this
  theme; no gap found beyond OPS-18's, which is not a throttling gap.
- **Password hashing** (`utils/password.ts`). werkzeug scrypt at `N=32768`,
  constant-time compare, bcrypt legacy hashes upgraded on successful login.
  Unchanged, still sound.

## Not fixed here — needs follow-up

- **Invite tokens ride in a URL path** (`/join/:token`, `/join-org/:token`) and
  are, like the reset tokens OPS-20 just hashed, bearer credentials. This pass
  did not check how `project_invites` stores them. Same question, same table
  shape, obvious next place to look — worth an explicit item in the next
  auth/session pass rather than being folded into this one.
- **Post-rollover cleanup for OPS-20**: drop the plaintext arm from the four
  lookups and then the `token` columns, once 24h (resets) / 7d (verification)
  have elapsed since deploy. Steps are in the migration header; the two
  rollover tests are commented for deletion at the same time.
- **OPS-21's two blockers** — the 399 `i18n/no-unkeyed-string` errors gating
  every PR, and the 5 `TS18046` errors in `contextual-decisions-routes.test.ts`
  that keep `auth-worker`'s own suite from running once the gate gets that far.
  Patches described in the finding; both belong to the owners of those files.
- **`auth-worker` carries two lockfiles** (`package-lock.json` and
  `pnpm-lock.yaml`) that resolve different `@cloudflare/workers-types`
  versions, so a local `npm ci` and CI's `pnpm --frozen-lockfile` type-check
  different code. Surfaced by OPS-21's measurement note. One of the two should
  probably go.
- **Chat proxy budget-guard atomicity** (`auth-worker/src/routes/chat.ts`) —
  carried forward unchanged from the 2026-08-20 pass. Still unverified,
  still worth a dedicated look.
- **OPS-15's residual scope** — changeset GET/discard and non-search external
  reads remain unthrottled. Carried forward.
- **V7/SEC-1 (prod/dev share `SECRET_KEY`/`SYNC_SECRET_KEY`)** — unchanged,
  still the highest-leverage open item across the whole series; out of scope
  for this pass's theme but re-flagged per standing practice.

---

_Re-run the mechanical parts of this review with: `cd auth-worker && npx tsc
--noEmit && npx vitest run`. Migration 0080 is **not** applied automatically —
see its header for the `scripts/pg.ts` invocation._
