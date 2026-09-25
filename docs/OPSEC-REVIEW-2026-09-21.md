# Operational Security Review — 2026-09-21

_Continues the standing series. Most recent entries: `docs/OPSEC-REVIEW-2026-09-17.md`
(OPS-33…OPS-34, Agent API identity scrubbing) and `docs/OPSEC-REVIEW-2026-09-14.md`
(OPS-29…OPS-30, third-party analytics egress). New findings continue the **OPS-n** series
at **OPS-35**._

**Scope for this pass: authentication & session management** — the Monday slot in the
rotating weekly cycle (**auth/session Mon**, authz/access Tue, injection Wed, API/data
exposure Thu, infra/deployment Fri). It is the first full sweep on this theme since
`docs/OPSEC-REVIEW-2026-09-07.md`, which was deliberately narrow because a parallel session
(PR #569) had run the broad recon the same morning; the intervening Monday (09-14) was spent
on third-party egress instead.

Because the broad surface — login/signup, token issuance, the sliding refresh, sync-token
minting, PAT lifecycle, logout/revocation, reset and invite tokens, WebSocket auth — has now
been swept four times in five weeks, this pass deliberately went looking for auth/session
surface that **no prior pass had ever read**, rather than re-walking the same routes. The
method was mechanical: enumerate every route mount in `auth-worker/src/index.ts`, resolve
each one's guard (router-level `use` vs. per-route), and cross-reference the result against
`grep -l` over every `docs/OPSEC*.md`.

That turned up one whole subsystem with **zero mentions across the entire review series**:
the admin console's **step-up elevation** gate (`middleware/platform-admin.ts`,
`routes/admin.ts`, migration 0047) — the emailed-6-digit-code "sudo" factor that stands
between a platform operator's ordinary JWT and cross-tenant god-mode over every org,
user, and project. Both findings below are in it.

Every finding is labelled **FACT** (verified against a file:line or a test run at this
commit) or **JUDGMENT** (reasoned inference).

---

## Findings

### OPS-35 — Admin step-up elevation was bound to the account, not the session, so a stolen admin JWT inherited the real operator's elevation — **FIXED** [FACT]

`requireAdminElevation` (`auth-worker/src/middleware/platform-admin.ts:88-96`, before this
change) gated the console on:

```sql
SELECT 1 AS ok FROM admin_elevations WHERE user_id = ? AND elevated_until > now()
```

and `admin_elevations` was `user_id BIGINT PRIMARY KEY` (`db/postgres/schema.sql:335`,
migration 0047) — **one row per user, no reference to the credential that earned it.**
`POST /elevation/verify` upserted with `ON CONFLICT (user_id) DO UPDATE`.

The question that query asks is "is this *person* elevated?". The question the gate exists
to ask is "did *this token* pass the second factor?". The gap between those two is the whole
finding, and the route's own code names the attacker it lets through. From the brute-force
comment on `/elevation/verify` (`routes/admin.ts:147-152`), added by the 2026-07-27 pen test:

> a caller already holding a valid (e.g. stolen) **non-elevated** admin JWT could
> brute-force the 6-digit code with unlimited guesses inside its ~10-minute window

That pass correctly stopped the brute-force (a per-user throttle,
`ADMIN_ELEVATION_VERIFY_MAX_FAILURES = 10` in a 15-minute window). But it left the
attacker a strictly easier path that needs no guessing at all: **wait.** The moment the
legitimate operator elevated on their own machine — reading the code out of their own
inbox — the single `admin_elevations` row went live for the *account*, and the stolen token
was elevated too, for the full `ELEVATION_SESSION_HOURS` (6h default), having never seen the
emailed code. The second factor defended the account while leaving the session unprotected,
which is the one thing a step-up factor must not do: its entire purpose is to prove that the
holder of *this* credential also controls the operator's mailbox.

What that buys the attacker is the reason this rates High impact rather than Medium.
Everything behind the gate is cross-tenant by construction — `requirePlatformAdmin`'s own
header calls it "the cross-tenant primitive" — and it is **not** read-only, despite
`routes/admin.ts`'s header still claiming "These are deliberately read-only". `admin.route("/",
adminBillingRoutes)` (`routes/admin.ts:973`) mounts the billing surface behind the same gate:
`PATCH /billing/plans`, `POST /billing/org/:orgId/grant-words`, `grant-credits`,
`reset-words`, `reset-credits`, plus `PATCH /settings` (platform AI config) and
`PATCH /credits/org/:orgId`. So the inherited elevation covers the full D3 cross-tenant
roster (every org, user, project, and the activity feed) *and* money-adjacent writes.

**Verified** with a failing test before the fix: two independently-minted JWTs for the same
platform-admin account, one elevated through the real request→verify flow, and
`GET /api/v2/admin/overview` on the *other* one returned **200** where it must return 403.
After the fix the same test returns 403 (`expected 200 to be 403` was the pre-fix
assertion failure).

**Fix.** Elevation is now bound to the credential that redeemed the code:

- `resolveSession` (`middleware/auth.ts`) returns a `sessionKey`, and `authMiddleware`
  stashes it on the context. This is **not a new derivation** — it is the key
  `lib/session-cache.ts` already computes for every authenticated request
  (`jti:<jti>`, falling back to `tok:<sha256 of the raw token>` for pre-`jti` tokens).
  Reusing it means (a) the isolate cache and this gate cannot disagree about what "this
  session" is, (b) legacy tokens with no `jti` are covered rather than being an
  un-bindable hole, and (c) nothing replayable is written to the database — a `jti` is
  already stored in the clear in `revoked_tokens`, and the fallback arm is a hash.
- `admin_elevations` becomes `PRIMARY KEY (user_id, session_key)` (migration 0094).
  `requireAdminElevation` and `GET /admin/me` both match on it, so the SPA's badge can no
  longer report an elevation the gate will then 403.

The composite key (rather than collapsing to one row and overwriting `session_key`) is
deliberate: an operator using two browsers elevates twice instead of having each new
elevation silently de-elevate the other. Existing rows are **deleted** by the migration
rather than backfilled — there is no session to attribute them to, and an unbound row is
exactly the vulnerable state being removed.

### OPS-36 — Elevation codes were stored in plaintext at rest — the one readable-credential table OPS-20/OPS-31 never reached — **FIXED** [FACT]

`admin_elevation_codes.code TEXT NOT NULL` (`db/postgres/schema.sql:298`), written directly
from `randomSixDigitCode()` by `POST /elevation/request` (`routes/admin.ts:125`) and matched
by SQL equality on verify (`:167`).

This is precisely the OPS-20 class, and the provenance is explicit rather than inferred.
Migration 0047's own comment describes the table as:

> short-lived 6-digit codes emailed to the operator (**clone of password_reset_tokens**)

It cloned that table's **pre-hardening** shape — and then never followed it through either
of the two fixes that table subsequently received: OPS-20 (migration 0080, store a hash)
and OPS-31 (migration 0087, drop the plaintext column so the hash-only guarantee survives a
restore). `docs/OPSEC.md`'s D5 row tracks reset and email-verification tokens as hashed and
calls out invite tokens (OPS-26) as the known exception; this table was not on the row at
all. It was the last readable-credential table in the schema outside the invite tables.

**Concrete impact:** any read of the database — a Neon branch, a PITR snapshot, a backup
restore, support access, or a SQL-injection primitive — yielded a **live second factor** for
the highest-privilege account class in the system, for the 10 minutes of its TTL. Combined
with a stolen-but-non-elevated admin JWT (the same attacker OPS-35 is about) that is a
complete bypass of the step-up gate. Note the asymmetry that makes this worth fixing even
though a DB reader is already powerful: the elevation factor's job is to be *out of band* —
to live in the operator's mailbox, somewhere the application database is not. Storing it in
that database collapses the second factor back into the first.

**Fix.** `code_hash` holds a **scrypt** digest (`hashPasswordWerkzeugScrypt`), verified by
iterating the user's live codes on redeem. Two notes on the choice:

- **scrypt, not SHA-256.** The plaintext is a 6-digit code — a 10^6 keyspace that any fast
  digest surrenders to an offline sweep in milliseconds. A slow KDF is the only hash that
  means anything at this entropy.
- **scrypt, not HMAC.** An HMAC would have preserved the indexed equality lookup, but it
  would rest on `SECRET_KEY` — which prod and dev still share (V7/SEC-1, open, and still the
  highest-leverage item in the series). The fix should not depend on the one secret the
  series already flags.

This matches the repo's own precedent: `routes/access-links.ts` hashes its 4–12 digit PIN
with the same helper for the same reason. The cost is a handful of scrypt verifications per
redeem, bounded by the existing 5-codes-per-hour mint cap, on an operator-only route.

Migration 0094 mirrors the **0080 → 0087 two-step** rather than dropping `code` immediately:
`code` becomes nullable and is never written again, so the old worker keeps functioning
between the migration and the deploy. A row it writes mid-deploy simply never verifies under
the new code — the operator re-requests, which costs ≤10 minutes of mild confusion, not
access. The follow-up `DROP COLUMN code` is recorded in the migration header, per 0087's
reasoning that only a dropped column survives a restore. A regression test asserts a legacy
plaintext-only row reads as "no such code" rather than being accepted.

**Deploy order for 0094 is migration-first, the opposite of 0087**, and the header says so
explicitly. The new code names `code_hash` and `session_key`, neither of which exists until
the migration runs, so deploying first would 500 both elevation routes. The reverse order is
safe by construction: every column the old code writes survives the migration — `code` is
merely nullable, and `session_key` carries a transitional `DEFAULT ''` so the old worker's
`INSERT INTO admin_elevations (user_id, elevated_until, updated_at)` cannot hit a NOT NULL
violation during the window. A `''` key can never equal a real session key, so such a row is
inert under the new gate. Dropping that default is part of the same recorded follow-up, which
restores "NOT NULL means actually bound to a session" and reconciles the migrated database
with `schema.sql` (which carries no default).

---

## Reviewed, no new finding

- **`resolveSession` / `authMiddleware`** (`middleware/auth.ts`) — re-read end to end, since
  everything above depends on it. The ordering is correct: signature and `exp` verified
  before anything is trusted, a missing-`exp` token rejected explicitly (the one case
  hono/jwt's own expiry check cannot cover), the `sst` absolute-session-age cap applied on
  every request rather than only at refresh, and the session cache entered **only after**
  verification. The `password_changed_at` cutoff genuinely does re-run on every cache hit, as
  its comment claims. Not a finding.
- **Isolate session cache** (`lib/session-cache.ts`) — its documented 30-second
  cross-isolate revocation window is a real, correctly-reasoned trade, and the header states
  it plainly rather than burying it. `password_hash` is blanked before caching. The
  unbounded `Map` (expired entries are evicted only when their own key is next read, with no
  sweep) is a memory-growth note, not a security finding, and is bounded in practice by
  isolate lifetime. Not a finding.
- **Elevation bootstrap ordering** — `/me`, `/elevation/request` and `/elevation/verify` sit
  *above* `admin.use("*", requireAdminElevation)` (`routes/admin.ts:205`) so they stay
  reachable to establish elevation, while `admin.route("/", adminBillingRoutes)` is
  registered at `:973`, i.e. after both `authMiddleware` and the elevation gate. Hono
  composes matching middleware in registration order, so the billing sub-router does inherit
  both. Confirmed rather than assumed, because a mounting-order slip here would have left
  the credit/word-grant endpoints unguarded. Not a finding.
- **`randomSixDigitCode`** — rejection-sampled from `crypto.getRandomValues`, so no modulo
  bias (2^32 is not a multiple of 10^6). A prior pass already replaced `Math.random()` here.
  Not a finding.
- **`devCode` leak path** — `/elevation/request` returns the code in the body only when
  `ENVIRONMENT !== "production" && !EMAIL`. Gated on the environment label and not merely on
  binding presence, so a misconfigured/missing `EMAIL` binding in prod fails closed (no
  email, no code echoed) instead of silently degrading to the dev behaviour. Correct as
  written. Not a finding.
- **Elevation rate limits** — mint capped at 5/hour/user; verify capped at 10 failures per
  15-minute window against a code that lives 10 minutes. Adequate against online guessing of
  a 10^6 keyspace. Not a finding.
- **Access links** (`routes/access-links.ts`, AQU-626) — read closely as the other
  session-minting surface outside the password flow. Single indistinguishable 401 across
  unknown/revoked/expired/locked/wrong-PIN (no oracle), scrypt-hashed PIN, atomic
  increment-and-lock (the read-then-write race was already closed on 2026-07-27), per-IP
  throttle checked before the token lookup, and the minted JWT carries `jti`/`sst` like any
  other, so it is revocable by logout and bounded by the absolute session-age cap. Worth
  recording as a deliberate design property rather than a finding: revoking a link does
  **not** kill sessions already minted from it — those die by ordinary token expiry. Given
  the diode-zone/fresh-browser use case this is defensible, but it is the kind of assumption
  worth re-testing if access links ever get a longer TTL.
- **Live-membership contract** (`sync-worker/src/events/membership.ts` and the
  `TOKEN_EXPIRED_CLOSE_CODE` / `MEMBER_REMOVED_DENY_MS` machinery in `project-do.ts`) — spot-
  checked against its own written contract (new mints refused immediately; writes refused
  immediately; reads bounded by the 15-minute token TTL; live WS sessions ejected or closed
  at token expiry). The deliberate fail-open on query error is documented and bounded by that
  same TTL. Holds as described. Not a finding this pass.

## Secondary checks (confirmed still open, not re-investigated — out of this pass's theme)

- **V7/SEC-1** (`auth-worker/wrangler.toml:271` — prod and dev share `SECRET_KEY`/
  `SYNC_SECRET_KEY`) — still present, still the highest-leverage open item in the series, and
  it directly shaped the hash choice in OPS-36 above.
- **OPS-26** (invite tokens stored in plaintext at rest) — still open, still blocked on the
  same product decision (three surfaces deliberately re-display a live invite token). With
  OPS-36 fixed, the invite tables are now the *only* readable-credential tables left in the
  schema.
- **OPS-24** (credit-guard check-then-act race, `auth-worker/src/lib/credits.ts:303-321`) —
  unchanged; billing-scoped fix, not auth/session work.

---

## Risk assessment

| ID | Finding | Likelihood | Impact | Risk | State |
|---|---|---|---|---|---|
| OPS-35 | Step-up elevation keyed on `user_id` alone, so any concurrent session for that admin — including a stolen token — inherited the grant | Medium — requires an attacker to already hold a valid admin JWT (the precondition the gate is explicitly designed around), but then needs **no** further work: elevation arrives on its own the next time the real operator elevates | High — full cross-tenant read over every org/user/project (D3), plus the billing and platform-settings writes mounted behind the same gate, for the whole 6h window | **High** | Fixed |
| OPS-36 | Elevation codes stored in plaintext at rest — the `password_reset_tokens` clone that never inherited OPS-20/OPS-31 | Low-Medium — needs a database read (backup, Neon branch, PITR snapshot, support access, SQLi), and the window is the code's 10-minute TTL | High in combination — hands over a live second factor for the highest-privilege account class, collapsing an out-of-band factor into the application DB; on its own, gated behind an already-serious compromise | **Medium** | Fixed |

## Countermeasures applied in this change

| Control | Where |
|---|---|
| `resolveSession` returns a per-credential `sessionKey` (reusing `session-cache.ts`'s existing derivation, incl. the pre-`jti` fallback); `authMiddleware` stashes it on the context | `auth-worker/src/middleware/auth.ts`, `auth-worker/src/types.ts` |
| Elevation gate matches `(user_id, session_key)` instead of `user_id` | `auth-worker/src/middleware/platform-admin.ts` |
| `GET /admin/me` scoped to the same session, so the SPA badge and the gate cannot disagree | `auth-worker/src/routes/admin.ts` |
| Elevation grant keyed per session; expired rows pruned opportunistically on verify | `auth-worker/src/routes/admin.ts` |
| Elevation codes stored as a scrypt digest; redeem verifies against the user's live digests; legacy plaintext-only rows never match | `auth-worker/src/routes/admin.ts` |
| `admin_elevations` PK → `(user_id, session_key)`; `admin_elevation_codes.code_hash` added, `code` retired to nullable with a recorded follow-up drop | `db/postgres/migrations/0094_admin_elevation_session_binding.sql`, `db/postgres/schema.sql` |
| Regression tests: a second token for the same admin is not elevated by the first's grant (both the `jti` and `tok:` arms); two sessions can elevate independently; codes are never at rest in the clear; a legacy plaintext-only row is rejected | `auth-worker/src/__tests__/admin-elevation.test.ts` |

## Verification

* `auth-worker`: `npx tsc --noEmit` reports **no** error in any changed file (the 17
  pre-existing lines are identical before and after this change — uninstalled sibling
  packages plus two long-standing errors in `index.ts`/`contextual.ts`); `npx eslint` clean
  on every changed file.
* Full `npx vitest run` in `auth-worker`: **174 files, 1786 tests, all passing.** The
  elevation suite grew from 7 to 13 tests.
* The auth-worker suite runs against real Postgres (PGlite) loading `db/postgres/schema.sql`
  directly, so the schema change here is exercised by every one of those 174 files rather
  than only asserted on paper.
* **Migration 0094 was executed, not just written.** Migrations here are applied by hand, so
  nothing in CI would have caught a broken one. It was run in PGlite against a database
  built to the *actual* pre-0094 shape (the `CREATE TABLE`s copied verbatim from migration
  0047) and carrying live rows in both tables. Result: applies cleanly; both tables emptied;
  `admin_elevations` ends with a composite primary key on `(session_key, user_id)`; `code`
  and `code_hash` both nullable; the **old** worker's INSERT statements still succeed against
  the migrated schema (the deploy-window direction that matters); and the new
  `ON CONFLICT (user_id, session_key)` upsert supports two concurrent elevated sessions for
  one operator, re-upserting the same session in place rather than adding a row.
* **Negative control:** with `requireAdminElevation` temporarily reverted to the old
  `WHERE user_id = ?` query against the *new* schema, the two OPS-35 tests fail with
  `expected 200 to be 403` — i.e. they detect the actual vulnerability rather than merely
  describing the new code.
* No response shape changed. `GET /admin/me` returns the same fields; the only behavioural
  difference is that `elevated` is now per-session, which is the fix. No SPA change was
  needed: `useAdminElevation`/`AdminElevationGate` are a pure UX gate over that unchanged
  payload and already re-probe after a verify.

## Not fixed here — needs follow-up

1. **`DROP COLUMN code`** on `admin_elevation_codes`, plus
   **`ALTER COLUMN session_key DROP DEFAULT`** on `admin_elevations`, once the deploy has
   landed and every pre-0094 row is past its own `expires_at` (`ELEVATION_TTL_MINUTES`, 10
   by default). Both are recorded in the 0094 header. Until then the hash-only property is
   behavioural rather than structural — the same gap 0087 closed for the reset tables — and
   the migrated database carries a default that `schema.sql` does not.
2. **Elevation does not survive a token refresh.** `POST /auth/refresh` mints a new `jti`,
   hence a new `sessionKey`, so an operator who refreshes mid-elevation re-enters a code.
   In practice this is rare — refresh only fires past a token's half-life (~15 days of a
   30-day token), which must then coincide with a 6-hour elevation window — and the failure
   mode is benign (one extra code, never a silent grant). Carrying the grant across a
   refresh would be a small change in `routes/auth.ts`; it was left out deliberately to keep
   this change minimal and reviewable, and because the safe direction is to under-grant.
3. **Logout does not eagerly delete the elevation row** for the revoked session. Harmless
   today — the `jti` denylist means the token cannot authenticate at all, so the row is
   unreachable, and the prune on the next verify clears it — but deleting it in
   `revokeToken` alongside `evictSessionByJti` would be tidier.
4. **`routes/admin.ts`'s header comment still says the platform surface is "deliberately
   read-only"**, which stopped being true when `adminBillingRoutes` and `PATCH /settings`
   were mounted behind the same gate. Documentation drift rather than a vulnerability, but
   it understates the blast radius for the next reader — and it is exactly what made OPS-35
   look lower-impact than it is at first glance.

---

_Re-run the mechanical parts of this review with: `cd auth-worker && npx tsc --noEmit &&
npx eslint src/middleware/auth.ts src/middleware/platform-admin.ts src/routes/admin.ts
src/types.ts src/__tests__/admin-elevation.test.ts && npx vitest run
src/__tests__/admin-elevation.test.ts` (and `npm run neon:check` at the repo root for the
schema/migration pairing)._
