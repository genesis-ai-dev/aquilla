# Operational Security Review — 2026-09-07

_Ninth pass in the standing series. Follows `docs/OPSEC-REVIEW-2026-08-31.md`
(OPS-25, OPS-26), `docs/OPSEC-REVIEW-2026-08-27.md` (OPS-22…OPS-24),
`docs/OPSEC-REVIEW-2026-08-24.md` (OPS-18…OPS-21),
`docs/OPSEC-REVIEW-2026-08-20.md` (OPS-15…OPS-17),
`docs/OPSEC-REVIEW-2026-08-17.md` (OPS-11…OPS-13),
`docs/OPSEC-REVIEW-2026-08-13.md` (OPS-8…OPS-10),
`docs/OPSEC-REVIEW-2026-08-11.md`, `docs/OPSEC-REVIEW-2026-08-10.md`
(OPS-1…OPS-7) and `docs/OPSEC.md` (V1…V9). New findings continue the **OPS-n**
series at OPS-27._

Every finding is labelled **FACT** (verified against a file:line or a test run
at this commit) or **JUDGMENT** (reasoned inference).

---

## 0. Scope — and why this pass is narrow on purpose

2026-09-07 is a Monday, so the rotating weekly cycle (**auth/session Mon**,
authz/access Tue, injection Wed, API/data exposure Thu, infra/deployment Fri)
puts this pass on **authentication & session management**. That would have made
it the fourth consecutive auth/session sweep (08-24, 08-31, and — see below —
one more this morning).

**A parallel session already ran the broad sweep today.** PR
[#569](https://github.com/genesis-ai-dev/aquilla/pull/569), "[Pen test]
Authentication and session management security review — Sep 7, 2026", was
opened at 09:57 UTC against `dev` from `claude/inspiring-maxwell-u6l8sv`. It
recons the same surface this pass would have (login/signup, token
issuance/refresh, sync-token minting, cookie/storage handling, PAT lifecycle,
logout/revocation, CORS/CSRF, reset/invite tokens, WebSocket auth) and lands
one fix: a per-source-IP throttle on invalid Agent-API PAT attempts.

Re-running that recon would have produced a second opinion on the same files
and a merge conflict for whoever landed second. So this pass deliberately does
the two things #569 does **not**:

1. **It closes the oldest open auth/session item in the series** — the OPS-20
   post-rollover cleanup, which `docs/OPSEC-REVIEW-2026-08-31.md` flagged as
   "carried forward, and now overdue… the cheapest open item in the series"
   and which #569 does not touch (its diff includes neither
   `auth-worker/src/routes/auth.ts` nor a migration). That is **OPS-27**,
   fixed here.
2. **It reviews #569's own change adversarially**, before it merges. That is
   **OPS-28**, reported not fixed — the code lives on another branch.

Both sit squarely inside the Monday theme. Neither duplicates #569.

---

## Findings

### OPS-27 — The pre-0080 plaintext-token fallback outlived its rollover window by two weeks, and the reset tests were riding it — **FIXED** [FACT]

**Background.** Migration `0080_auth_token_hashing.sql` (OPS-20, 2026-08-24)
moved `password_reset_tokens` and `email_verification_tokens` to hash-at-rest.
To avoid invalidating links already sitting in people's inboxes, it kept the
plaintext `token` column and had the four lookups in
`auth-worker/src/routes/auth.ts` match on either shape:

```sql
WHERE token_hash = ? OR (token_hash IS NULL AND token = ?)
```

The migration header wrote the exit criteria down explicitly:

> FOLLOW-UP (safe once the rollover window has passed — 24h for resets, 7d for
> verification): drop the plaintext arm from the four lookups in
> auth-worker/src/routes/auth.ts, then
>   ALTER TABLE password_reset_tokens DROP COLUMN token;
>   ALTER TABLE email_verification_tokens DROP COLUMN token;

**The gap.** 0080 shipped 2026-08-24. The reset window closed 2026-08-25 and
the verification window 2026-08-31 — **13 and 7 days** before this pass. The
follow-up had not been done. The 08-31 review flagged it as overdue; nothing
had changed by today.

Leaving it in place is low-severity but not zero, for one reason that has
nothing to do with the running system: **a dropped column is the only version
of this that survives a restore.** Backups, Neon branches and PITR snapshots
taken before 0080 still carry live plaintext reset tokens. While the column
exists in the live schema, restoring one of those reproduces a
readable-credential table that the running code would silently accept again —
the fallback arm was still there to accept it. Dropping the column makes
hash-only the schema's own invariant instead of a property of the current
query text. [JUDGMENT — the reasoning; the dates and the arm are FACT]

**A second, larger problem found while removing it.** [FACT]

Three test files seeded reset tokens through a hand-copied `seedToken` helper
that inserted **plaintext** rows:

```ts
"INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)"
```

— `password-reset.test.ts:22`, `session-invalidation.test.ts:37`,
`auth-rate-limit.test.ts:177`, plus one plaintext row in
`email-verification.test.ts:101`. Since 0080, every one of those tests has been
reaching the verify/reset handlers **through the deprecated compatibility arm**,
not through the digest lookup that production actually uses.

That was verified, not assumed. Restoring the original (plaintext-seeding)
`password-reset.test.ts` and the original `schema.sql` against this pass's
hash-only lookups fails three tests:

```
× still accepts a pre-0080 plaintext token row (rollover)
× accepts a valid token
× changes the password, lets the user log in with the new one, and consumes the token
  AssertionError: expected 400 to be 200   (×3)
```

The middle two are the core end-to-end coverage for password reset. So for the
last two weeks the **production digest path for password reset had no
end-to-end test at all** — the only thing pinning it was OPS-20's "stored as a
digest" assertion, which checks how the row is written and never exercises
reading it back. A regression in the hash lookup would have shipped green.

**The fix.**

- Dropped the plaintext arm from all four lookups in `routes/auth.ts` (the
  verify-email SELECT and DELETE, and the two identical reset lookups), and
  removed `token` from the two INSERT column lists.
- Added `db/postgres/migrations/0087_drop_plaintext_auth_tokens.sql`, dropping
  both columns. The header records the deploy ordering: **the worker ships
  first**, because the new code never names the column and so runs fine against
  a database that still has it, whereas applying the migration first would
  break the old code's INSERTs for the length of the deploy window.
- Removed the two now-dead plaintext indexes from `db/postgres/schema.sql`
  (`idx_password_reset_tokens_token`, `idx_email_verification_tokens_token`).
  Postgres drops a column's dependent indexes with it, so the migration needs
  no separate `DROP INDEX`.
- Converted all four seeding helpers to write digests, so those tests now
  exercise the shipping path.
- Deleted the two rollover tests that existed only to cover the removed arm
  (their own comments said to delete them with it), replacing them with
  assertions that still earn their place: a wrong token is rejected, and an
  expired token still returns 410.
- Turned the two "never as plaintext" assertions into **structural** ones —
  they now assert `information_schema` has no `token` column on either table,
  so re-adding one fails the suite rather than silently restoring a
  readable-credential table.
- Updated `finalizeAuthTokenSchema` in `scripts/dev-stack-artifact-schema.ts`.
  This is the local-dev reconciler: the generic one adds columns from
  `schema.sql` but never drops a column that has left it, so a long-lived
  container would keep a `token` column the routes no longer name — and if it
  is still `NOT NULL` (pre-0080), inserts fail outright. Both mint paths are
  deliberately silent to callers (the reset request returns its generic 200,
  registration's verification mint is best-effort), so this would show up as
  local reset links quietly never arriving. Dropping the column subsumes the
  0080 "make nullable" repair, so one step now handles pre-0080 and pre-0087
  databases alike.

### OPS-28 — PR #569's invalid-PAT throttle locks out valid tokens from a shared egress IP, and probably increases DB load rather than reducing it — **REPORTED, not fixed** [FACT on the mechanics, JUDGMENT on the impact]

This is a review of an **unmerged** change on another branch
(`claude/inspiring-maxwell-u6l8sv`, PR #569). It is not a defect in `dev`. It
is recorded here because the whole point of catching it is to catch it before
it merges, and because a security fix that introduces an availability
regression is exactly the sort of thing this series exists to notice.

The change adds, in `db/shared/api-credentials.ts`:

```ts
const throttleKey = ipIdentifier ? `ip:${ipIdentifier.trim().toLowerCase()}` : null
if (throttleKey) {
  const recentFailures = await countRecentRateLimitEvents(db, KIND, throttleKey)
  if (recentFailures >= MAX_INVALID_ATTEMPTS_PER_IP) return null   // 30, 15-min window
}
```

**1. It is a hard lockout, not a failure throttle.** Once 30 invalid attempts
are recorded against an IP inside the window, `validateApiCredential` returns
`null` for **every** token from that IP — including a perfectly valid one. That
is not incidental; the PR's own test asserts it:

> `// The budget is now spent — even a genuinely valid token from that IP is`
> `// rejected without a DB lookup`

The population this affects is the problem. Agent-API callers are server-side
automation — CI runners, MCP clients, agent frameworks — which is precisely the
population that shares egress IPs behind NAT gateways, corporate proxies and
CI provider ranges. Cloudflare sets `CF-Connecting-IP` to the true client
address, so everyone behind one NAT shares a single 30-failure budget. One
misconfigured client retrying a revoked token burns that budget in seconds and
takes out every other credential behind the same IP for 15 minutes, with a
`permission_denied` that says nothing about throttling. [JUDGMENT on
likelihood; the mechanism is FACT]

This is not attacker-driven — `CF-Connecting-IP` is set at the edge and can't
be spoofed through Cloudflare, so an attacker can only lock out themselves. The
realistic failure is **collateral damage from an ordinary client bug**, which
is the more likely event of the two.

**2. The stated goal is DB load, and the change plausibly moves it the wrong
way.** Per `db/shared/rate-limit.ts:20-57`, each recorded failure is an
`INSERT` and each check is a windowed `COUNT(*)`. So an invalid attempt costs:

| | before | after |
|---|---|---|
| under budget | 1 indexed point lookup | 1 windowed `COUNT` + 1 `INSERT` |
| over budget | 1 indexed point lookup | 1 windowed `COUNT` |

Below the cap the change roughly triples the round trips it was meant to save.
Above the cap it swaps an indexed point lookup on `api_credentials` for a
windowed aggregate on `auth_rate_limit_events` — not obviously cheaper, and
the aggregate is the one that scans. Since the PR's own justification is
bounding DB work (it accepts that brute-forcing a 256-bit token is infeasible),
the mechanism should be checked against that goal before it lands.
[JUDGMENT — reasoned from the query shapes, not benchmarked]

**Suggested adjustment.** Key the throttle on the **token digest** rather than
the source IP. A client stuck retrying one bad token gets cut off after N
attempts and stops touching `api_credentials`; a valid token never accumulates
failures, so no legitimate caller is ever locked out and there is no
shared-IP collateral at all. Volumetric floods of *distinct* garbage tokens are
a request-rate problem, and belong at the edge (Cloudflare rate-limiting rules)
rather than in a handler that has to hit the database to count. This keeps the
security property the PR wants while removing both objections.

Reported to #569 as a review comment rather than patched here: it is not this
branch's code, and per standing practice a change of that shape on someone
else's PR is theirs to make.

---

## 1. Critical data

Unchanged from `docs/OPSEC.md` §1 (D1 signing keys, D2 unpublished translation
drafts, D3 translator identity + activity, D4 third-party credentials, D5
bearer tokens in circulation), with one row improved by this pass:

**D5 — bearer tokens in circulation.** The "hashed at rest" claim for
`password_reset_tokens` and `email_verification_tokens` is now **structural
rather than behavioural**: there is no plaintext column to write to, the tests
assert its absence, and a pre-0080 backup restored into the current schema
cannot re-introduce one. The row's remaining exception is unchanged and still
open: `project_invites` and `org_invites` store raw tokens (OPS-26).

## 2. Threats

Unchanged from `docs/OPSEC.md` §2. The actor relevant to this pass is the one
OPS-20 was written for and OPS-27 finishes closing: **anyone who obtains a
read-only copy of the database** — a Neon branch or snapshot, a PITR restore, a
backup, a replica, a support query, an over-broad analytics grant. That actor
needs no application access, no password and no mailbox, leaves no trace in the
application logs, and until this pass could have been handed live reset links
by restoring any pre-0080 backup into the live schema.

## 3. Vulnerabilities

Reviewed this pass:

- Deprecated compatibility code paths outliving their stated expiry (OPS-27) —
  **found and closed**. The generalisable weakness is that 0080 wrote its exit
  criteria into a migration header, which nothing reads on a schedule. See §5.
- Test fixtures drifting onto a compatibility path and silently vacating
  coverage of the real one (OPS-27) — **found and closed**.
- A new control introducing an availability failure mode (OPS-28) — **found,
  reported to #569**.

## 4. Risk

| Finding | Likelihood | Impact | Net |
|---|---|---|---|
| OPS-27 (plaintext column + arm) | Low — needs a pre-0080 backup restored into the live schema | High — live account-takeover tokens, no trace | **Medium**, and cheap to close |
| OPS-27 (reset flow untested) | Certain — it was already the case for 14 days | Medium — a hash-lookup regression ships green | **Medium** |
| OPS-28 (shared-IP lockout) | Medium — one buggy client behind a shared NAT | Medium — 15-minute Agent-API outage for co-located callers | **Medium**, pre-merge and cheap to change |

## 5. Countermeasures

Applied in this PR:

- Hash-only storage enforced by **schema shape**, not by query text, for both
  auth-token tables; asserted structurally in two tests.
- Deploy ordering for the migration written into its header, in the direction
  that is safe to interleave (worker first).
- The local-dev reconciler updated in the same commit as the schema change, so
  long-lived dev containers converge instead of silently failing to mint.

Recommended, not applied:

- **A dated exit criterion needs an owner, not a comment.** 0080's follow-up
  was written correctly and still slipped two weeks past its own deadline; the
  only reason it closed today is that a human-scheduled review happened to read
  the header. Migrations that leave a compatibility path behind should open a
  tracked issue dated to the window's end, so the deadline exists somewhere
  that is actually looked at.
- **A grep-level guard against fixture drift.** The three copies of `seedToken`
  drifted onto the compatibility arm because nothing connected "this insert
  shape" to "this is not what production writes." The cheapest guard is the one
  now in place (no column to write to); where that is not available, a test
  that asserts the fixture's shape matches the handler's is worth the line.

## 6. Effectiveness of existing countermeasures

- **OPS-20 (hash at rest) — now fully effective.** It was partially effective
  from 2026-08-24: new rows were hashed, but the plaintext column and its
  accepting code path remained, so the control held only for as long as nobody
  restored an old backup. Closed today.
- **OPS-25 (shared `resolveSession` + drift guard) — holding.** Still one
  helper; the drift guard is green in the 155-file suite.
- **OPS-22 / OPS-23 (external-route rate limits, path-safe ids) — holding.**
- **OPS-26 (invite tokens plaintext) — still open**, now flagged by three
  consecutive passes (08-31, #569, this one) and blocked on the same product
  decision each time. It is the last remaining exception to D5's "hashed"
  claim. Someone with product authority needs to choose between show-once
  invite links and accept-by-id; no further security pass will move it.
- **V7/SEC-1 (prod/dev share `SECRET_KEY`/`SYNC_SECRET_KEY`) — unchanged**, and
  still the highest-leverage open item across the whole series. Re-flagged per
  standing practice.

---

## Reviewed, no finding

- **The `ON CONFLICT (token_hash)` upsert on the reset mint.** Correct against
  the unique index `idx_password_reset_tokens_hash`. The digest of a
  `crypto.randomUUID()` never realistically collides, so the clause is
  effectively dead, but it is not wrong and removing it is not this pass's
  business.
- **Multiple NULL `token_hash` rows.** Postgres unique indexes permit repeated
  NULLs, so the pre-0087 shape never blocked concurrent mints. Checked because
  "unique column that the code sometimes writes NULL to" is a classic way this
  pattern breaks; it did not.
- **Nothing else reads the dropped columns.** `grep` across the tree for
  `password_reset_tokens` / `email_verification_tokens` finds only the four
  lookups, the two inserts, the test fixtures and the dev-stack reconciler, all
  updated here. `auth-worker/migrations/` and `sync-worker/migrations/` are
  retained historical D1 records and are not applied.
- **The verify-email single-use delete.** Unchanged: on success it clears all
  of the user's verification rows by `user_id`, which never depended on the
  token column shape.

## Not fixed here — needs follow-up

- **OPS-28** — belongs to PR #569; reported there.
- **OPS-26** — invite tokens plaintext at rest. Blocked on a product decision
  (§6).
- **OPS-24** — the credit-guard check-then-act race. Needs a pass scoped to
  billing.
- **OPS-21's remaining blocker** — the 399 `i18n/no-unkeyed-string` errors
  gating every PR. Belongs to whoever owns the i18n gate.
- **`auth-worker` carries two lockfiles** (`package-lock.json` and
  `pnpm-lock.yaml`) resolving different `@cloudflare/workers-types` versions.
  Unchanged since 08-24; still worth deleting one.
- **V7/SEC-1** — prod/dev shared signing keys. Unchanged.

**Instruction for the next auth/session pass (Monday):** the surface has now
had four consecutive Monday sweeps and is turning up compatibility-path and
process findings rather than live vulnerabilities. Consider spending the next
Monday slot on **OPS-24 (billing/credit-guard race)** instead, which has been
deferred three times for want of a pass scoped to it, and returning to
auth/session the Monday after.

---

_Re-run the mechanical parts of this review with:_

```bash
cd auth-worker && npx tsc --noEmit && npx vitest run   # 155 files, 1560 tests
cd .. && npx vitest run scripts/dev-stack-artifact-schema.test.ts
```
