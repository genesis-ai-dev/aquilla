# Operational Security Review — 2026-09-28

_Continues the standing series. Most recent entry: `docs/OPSEC-REVIEW-2026-09-23.md`.
New findings continue the **OPS-n** series at **OPS-37** — note that OPS-35 and
OPS-36 were each assigned twice, by the 09-21 and 09-23 passes running on separate
branches (the numbering note in `docs/OPSEC.md` §0 records it). Nothing is lost:
09-21's pair is elevation-session binding and elevation-code hashing, 09-23's is the
`users`-table ban and the JSON-merge prototype pollution. This pass starts after
both._

**Scope for this pass: authorization at the data layer — and, following the thread,
the one read path that depends on it.** This is a deliberate deviation from the
Monday auth/session slot. The 09-23 pass closed with a secondary finding it
explicitly handed forward "for its own PR": several tables the agent's SQL guard
treats as project-scoped are granted to `app_runtime` but carry no RLS policy. Taking
that up first meant measuring RLS coverage properly, which turned out to be much
narrower than any document in the repo claimed — and that, in turn, invalidated the
assumption the agent's SQL guard was resting on. The guard finding (OPS-37) is
therefore what the RLS work turned up, not a separate errand, and it is the more
urgent of the two.

No survey agent was used; the sweep is mechanical (a schema/migration parse, in the
repo as a test now) plus a read of the guard.

Every finding is labelled **FACT** (verified against a file:line or a reproduced
exploit at this commit) or **JUDGMENT** (reasoned inference).

---

## Findings

### OPS-37 — The agent's SQL tool let any project member read other projects' data, including every live invite token on the platform — **FIXED** [FACT]

`auth-worker/src/lib/agent/sql-guard.ts` is the in-app translation agent's read path
(`sql({query})`, the documented escape hatch): the model writes arbitrary SQL text,
`guardSql()` validates it, `runGuardedSql()` executes it read-only against production
Postgres. Its scoping control was a **blocklist over the whole database** plus one
text requirement — that the substring `project_id = :project` appear *somewhere* in
the query text reachable from the final `SELECT`.

One correctly-scoped table therefore admitted an arbitrary second, unscoped one. The
worst instance needs no decoy, no CTE, and no unusual syntax:

```sql
SELECT i.token, i.project_id, i.role_level, i.email
FROM cells c CROSS JOIN project_invites i
WHERE c.project_id = :project
```

`cells c` supplies the required substring; `i` is filtered by nothing. Run for real
this returns **every row of `project_invites` for every project on the platform**.
Invite tokens are stored in plaintext (OPS-26, `docs/OPSEC-REVIEW-2026-08-31.md` — the
one credential table the schema never hashed, because three product surfaces re-display
a live token), so each row is a *working* project-access credential, complete with the
`role_level` it grants on accept. That is not a data leak that ends at reading: it is
cross-tenant access to arbitrary projects, at up to OWNER, for anyone with an account
and any single project of their own.

Eight variants were run against `guardSql()` at the pre-fix commit and every one
returned `ok: true`:

| Query shape | What it returns |
|---|---|
| `cells c CROSS JOIN project_invites i` | every live invite token + role_level + invitee email, all projects |
| `cells c CROSS JOIN project_access_links l` | every deep-link token + its scrypt PIN hash + role_level (AQU-626 diode-zone links) |
| `cells c CROSS JOIN cell_backtranslations b` | every project's back-translations (D2 draft text) |
| `cells c CROSS JOIN assignments a` | every project's assignment graph — who is working on what (D3) |
| `cells c CROSS JOIN agent_memories m` | every project's Living Memory content |
| `cells c CROSS JOIN org_settings o` | every org's settings blob, including the user-supplied vendor API keys `routes/org-settings.ts` redacts on read (D7) |
| `... WHERE project_id = :project OR 1 = 1` | every project's cells — the scoping predicate satisfied *and* neutralised |
| `... WHERE NOT (project_id = :project)` | as above, by inverting it |

The last two matter beyond their own rows: they show the text check could be satisfied
by a predicate that does not scope anything, on **any** table including the ones the
model is supposed to read. `api_credentials` (PAT hashes), `knowledge_docs`,
`project_briefs`, `agent_runs`, `password_reset_tokens` and `organizations` were all
reachable by the same join shape.

**Why it was there.** The guard's own comments were explicit that text analysis cannot
verify a join is correlated, and delegated exactly this residual gap to the database:
*"that cross-tenant case is closed at the database layer below via `db.withUser()` +
the RLS backstop (db/postgres/migrations/0034), not by text analysis"*, and *"RLS is
the real backstop where it exists."* That was a reasonable design. It was also wrong
about where RLS exists — see OPS-38. None of the tables in the table above has an RLS
policy. (This also corrects 09-23's own severity reasoning for OPS-35, which stated
that `cells` in the exploit query "is correctly RLS-scoped to the caller's own
project". On the evidence in OPS-38, it is not.)

**Reachable by:** any authenticated user who is a member of any one project, including
a free-tier project they just created, via `POST /api/v1/ai/agent/run`. The SQL text is
model-authored, so the trigger is either a user asking the agent for it directly or a
prompt-injection payload in translated content — the module's own header already treats
"the model's SQL is untrusted input running against the production database" as its
threat model.

**Fix — scoping is now structural, not textual.** Two changes, both in
`sql-guard.ts`:

1. **`READABLE_TABLES` replaces the blocklist.** The tool can read exactly the 13
   tables `schema-card.ts` documents to the model (`cells`, `files`, `events`,
   `comments`, `cell_validators`, `cell_waivers`, `cell_backtranslations`,
   `cell_audio`, `cell_word_morph`, `assignments`, `assignment_cells`,
   `project_settings`, `project_members`), plus `information_schema` for
   introspection. Anything else — `project_invites`, `org_settings`,
   `api_credentials`, a `public.`-qualified name, `pg_catalog`, a set-returning
   function in a relation position — is rejected by name. `users` and
   `password_hash` keep their 2026-09-23 bans underneath, and their regression
   tests still pass.
2. **Every reference to a readable table is rewritten into a project-scoped derived
   table.** `scanRelations()` resolves each relation reference (`FROM`/`JOIN`, comma
   lists, `LATERAL`, aliases with or without `AS`, derived tables, CTE names) and
   `scopeRelations()` rewrites it in place:

   ```
   in : SELECT c2.value FROM cells c1 JOIN cells c2 ON 1 = 1 WHERE c1.project_id = :project
   out : SELECT c2.value FROM (SELECT * FROM cells WHERE project_id = ?) c1
         JOIN (SELECT * FROM cells WHERE project_id = ?) c2 ON 1 = 1 WHERE c1.project_id = ?
   ```

   No rewriting of the caller's own predicate can undo that — `OR 1 = 1` and
   `NOT (…)` now narrow the caller's own project and nothing more. The injected
   scoping reuses the existing `:project` binding mechanism, so parameters stay
   positionally correct with no new binding path. `assignment_cells` is the one
   readable table with no `project_id` column of its own; it is scoped through the
   `assignments` row that owns it. Postgres pulls these subqueries up into the outer
   query, so index use is unchanged.

   The literal mask is now length-preserving (each literal becomes `'sss…'` of its own
   width) so offsets found on the masked copy address the same characters in the real
   statement. Everything fails closed: any relation shape `scanRelations()` cannot read
   confidently is an error, not a skipped reference, because a skipped reference would
   be a skipped rewrite. A CTE that shadows a readable table name is rejected rather
   than wrapped.

`PROJECT_EQ_RE` and `reachableScopingText()` are kept, with corrected comments: they
are no longer load-bearing, but a query that never mentions `:project` is a model
mistake worth naming precisely, and an unreachable decoy CTE still should not count as
evidence. `PROJECT_TABLES` is likewise now only the `information_schema`-carve-out
heuristic, not a security boundary — which is just as well, since it had drifted
(it lists `project_seq_counters`, and omits `project_invites`).

**No capability regression for documented use.** Every SQL shape in the agent cookbook
(`docs.ts`: the drafting self-join, the `FILTER` aggregate, the morphology join, the
`jsonb` termbase reads, the correlated validator subquery, the assignments join) is a
test case and still passes, as do comma FROM lists, `LEFT JOIN`, derived tables and
catalog introspection. Two shapes are newly rejected on purpose: a table the model can
see via `information_schema` but that is not on the allowlist, and
`EXTRACT(… FROM …)`/`SUBSTRING(… FROM …)` syntax, which puts an expression where a
relation is expected — rejected by name with the ordinary-call alternative
(`date_part()`, `substr()`) rather than mis-parsed.

### OPS-38 — Nothing measured the RLS backstop, so four reviews cited a control covering 21 of 55 tables, documented as 9, and probably not in the request path at all — **PARTLY FIXED** [FACT + JUDGMENT]

Migration `0034_rls_backstop.sql` (AQU-289) is cited across this series as the layer
that catches a query the application scoped wrongly. Measuring it mechanically against
`db/postgres/schema.sql` and every migration gives:

- **55 tables carry a `project_id` column. 21 have RLS enabled** (all 21 also
  `FORCE`d, each with at least one policy — that part is clean). **34 do not.**
- **`db/postgres/RLS.md` claimed nine**, and its list included `snapshots`, which
  migration `0039_drop_snapshots.sql` deleted. It omitted 13 tables that *do* have
  policies (`artifacts`, `changesets`, `file_section_progress`, `plan_units`,
  `cell_audio_validators`, and the seven contextual/autopilot tables). The doc has been
  wrong in both directions for ~80 migrations.
- **`expectedSchemaContract()` in `scripts/neon-schema-contract.ts`** — the checker
  behind `pnpm neon:status`, which diffs expected schema/RLS/grants against live Neon —
  required `GRANT … ON TABLE <one-identifier> TO app_runtime;`. 0034 grants 30 tables
  in a single comma-separated statement and 0090 omits the `TABLE` keyword, so
  **neither parsed**: the drift check silently verified no privilege at all for
  `cells`, `events`, `files`, `comments` and 26 others. A grant revoked or never
  applied on live would not have been reported.
- **19 of the 34 uncovered tables were never granted to `app_runtime`** —
  `lanes`, `api_credentials`, `agent_memories`, `agent_sessions`, `knowledge_docs`,
  `project_briefs`, `style_rules`, `concepts`, `cell_links`, `project_access_links`,
  `project_member_scopes`, `seq_allocations` and more. These are ordinary
  request-path tables: lane resolution, PAT authentication, agent memory, briefs.

That last bullet is the load-bearing one. **A worker connected as `app_runtime` would
fail `permission denied` on core features** [FACT]. The app works, so the deployed
Hyperdrive connection uses some other role [JUDGMENT, but hard to escape] — and every
policy in this schema is written `TO app_runtime`, so any other role is unaffected by
all 21 of them. `FORCE ROW LEVEL SECURITY` would otherwise leave the owner seeing
*nothing* rather than everything; since reads succeed, the connecting role must have
`BYPASSRLS` (Neon's default owner is a member of `neon_superuser`, which does)
[JUDGMENT]. Consistently, `RLS.md` still carried a section headed **"NOT applied to
live Neon"** stating the migration "exists only as a repo artifact" — unrevised since
0034, while pass after pass treated it as enforced. Steps 2–6 of its own apply
procedure are manual dashboard work and were never recorded anywhere in the repo.

This is the V4a shape from `docs/OPSEC.md` again, and the note under that table said
it plainly: *a control that doesn't run is worth exactly as much as one that was never
written.* Here it is worse than worth nothing, because a second control
(OPS-37's guard) was deliberately left thinner in reliance on it.

**Fixed in this change:**

- **`scripts/rls-coverage.test.ts`** — the measurement, as a test. Every
  project-scoped table must be either RLS-covered or listed in an `UNCOVERED` ledger
  with a reason, so a new table cannot join the uncovered set silently; stale entries
  fail too; RLS-enabled-but-not-`FORCE`d and enabled-with-no-policy both fail; and
  `RLS.md`'s coverage table is diffed against the migrations in both directions, so
  the `snapshots` class of drift cannot recur.
- **`db/postgres/RLS.md`** — accurate coverage table (21 rows, generated), an explicit
  "what is NOT protected" section pointing at the ledger, and the false
  "NOT applied to live Neon" section replaced by a **Deployment status** section that
  states what the repo does and does not establish, and gives the three SQL queries
  that settle it.
- **`scripts/neon-schema-contract.ts`** — multi-table and keyword-less `GRANT`
  parsing, so `pnpm neon:status` actually checks those 30 grants. `GRANT EXECUTE ON
  FUNCTION` still correctly doesn't match; four tests cover it.

**Reported, not fixed — the operator question.** Which Postgres role does each
environment's Hyperdrive connection use, and does it have `BYPASSRLS`? That is not
answerable from this repository. Until it is answered, extending RLS to the remaining
34 tables (the 09-23 recommendation this pass set out to implement) would be writing
policies `TO app_runtime` that nothing evaluates — so it is deliberately **not** done
here, and the reason is recorded in the ledger rather than left implicit. The
sequencing is: answer the question, then either finish the grants and cut over to
`app_runtime` with the soak `RLS.md` describes, or stop counting RLS as a layer and
say so in `docs/OPSEC.md`. The current state — cited but unenforced — is the only
option that isn't fine.

Two of the 34 also cannot take 0034's policy shape at all, which is worth knowing
before anyone tries: **`project_members` and `group_project_grants`** are what
`app_user_can_access_project()` reads to decide access, and it is `SECURITY INVOKER`,
so its own reads are subject to the caller's policies — a policy on either that calls
it recurses through itself. They need a self-scoped predicate or a `SECURITY DEFINER`
helper with a pinned `search_path` [JUDGMENT: documented Postgres behaviour, not run
here].

---

## Reviewed, no new finding

Each item was checked against the code, not assumed safe by category.

- **The other guard layers in `sql-guard.ts`** — single-statement/`;` rejection,
  comment and dollar-quote rejection, the keyword and function blocklists, the
  `READ ONLY` transaction, the 4s `statement_timeout`, the `ROW_CAP + 1` wrapper, the
  UUID validation in front of `SET LOCAL app.project_id`, and alias binding
  (`#c1` → UUID, so the model never handles raw ids) all behave as documented. The
  literal-masking change was re-verified against the unbalanced-quote and
  keyword-inside-a-literal cases.
- **The agent's other read tools** (`read`, `examples`, `search`, `draft`, `docs`,
  `describe_command`) build their own parameterized SQL server-side with the project id
  bound from the authorized session, not from model text — they never route through
  `guardSql()` and are not exposed to this class of bug.
- **The external Agent API** (`sync-worker/src/routes/external/*`) exposes no free-form
  SQL at all; its reads are fixed routes with PAT scope checks plus the
  `pii`/`agentAuthorship` identity controls from OPS-33/34. Unaffected by OPS-37.
- **`db/shim/postgres.ts` identity threading** — `withUser()` still validates
  `app.user_id` as `/^\d+$/` before interpolation and `asAdmin()` still sets it empty
  (fail-closed to zero rows *if* policies are live). Correct as written; OPS-38 is
  about whether anything downstream evaluates it.
- **RLS policy hygiene where policies exist** — all 21 covered tables are `FORCE`d and
  all have at least one policy; the 0074 contextual family additionally pins
  `project_id = current_setting('app.project_id', true)`, i.e. exact-project rather
  than any-accessible-project. Both properties are now asserted by the coverage test.
- **`app_user_can_access_project()`'s four paths** — unchanged, and the AQU-1107 org
  floor (`role_level >= 600`) is still in place; `auth-worker/src/__tests__/rls-backstop.test.ts`
  exercises them against PGlite and still passes.

---

## Risk assessment

| ID | Finding | Likelihood | Impact | Risk | State |
|---|---|---|---|---|---|
| OPS-37 | Agent SQL tool: one scoped table admits an unscoped one — every live invite token platform-wide, plus deep-link tokens, draft text, assignment graph, vendor API keys | High — any member of any project, one ordinary-looking query, no trickery; reproduced eight ways | **Critical** — invite tokens are working credentials, so this is cross-tenant *access*, not only disclosure; and it lands squarely on D2+D3, the linkage `docs/OPSEC.md` calls the reason this product is a target | **Critical** | Fixed |
| OPS-38 | RLS coverage unmeasured, misdocumented, and probably not in the request path; grant drift check parsed nothing for 30 tables | Certain — already happened, and OPS-37 is the consequence | High — the layer every other control's severity analysis discounts against | **High** | Guards + docs fixed; the deployment question is open and belongs to an operator |

## Countermeasures applied in this change

| Control | Where |
|---|---|
| Readable-relation allowlist (13 tables + `information_schema`), replacing a blocklist over the whole database | `auth-worker/src/lib/agent/sql-guard.ts` |
| Every readable-table reference rewritten into a project-scoped derived table — scoping no longer depends on the caller's predicate | `auth-worker/src/lib/agent/sql-guard.ts` (`scanRelations`, `scopeRelations`) |
| Length-preserving literal mask so rewrite offsets are trustworthy | `auth-worker/src/lib/agent/sql-guard.ts` |
| `FROM`-operand function syntax rejected by name instead of mis-parsed | `auth-worker/src/lib/agent/sql-guard.ts` |
| Regression tests: all eight reproduced exploits, plus real two-project execution tests asserting only the caller's rows come back | `auth-worker/src/__tests__/agent-sql-guard.test.ts` |
| Drift guards: allowlist vs `schema.sql` (existence, `project_id`, scoping template) and vs `schema-card.ts` (the model is told about what it can read) | `auth-worker/src/__tests__/agent-sql-guard.test.ts` |
| RLS coverage ledger + drift guard over all 55 project-scoped tables, incl. `FORCE`/policy-presence and `RLS.md` agreement | `scripts/rls-coverage.test.ts` |
| Multi-table / keyword-less `GRANT … TO app_runtime` parsing, so `pnpm neon:status` checks the 0034 grants | `scripts/neon-schema-contract.ts` (+ tests) |
| Accurate coverage table, explicit uncovered set, and a Deployment status section with the queries that settle it | `db/postgres/RLS.md` |

No UX/UI change. The only user-visible effect is on the agent's `sql` escape hatch: it
can no longer read tables outside the 13 it is documented to read. The product surfaces
for members, assignments, invites and org settings are separate, already-authorized
routes and are untouched.

## Verification

* `cd auth-worker && npx vitest run src/__tests__/agent-sql-guard.test.ts` — 106
  tests, all passing (73 new/updated). Includes the eight reproduced exploits as
  rejections-or-scoped, the 11 documented cookbook shapes as acceptances, the drift
  guards, and five `runGuardedSql` tests that seed two projects into PGlite and assert
  the previously-exploitable queries return only the caller's rows.
* `npx vitest run scripts/rls-coverage.test.ts scripts/neon-schema-contract.test.ts` —
  13 tests, all passing. Both `RLS.md` assertions were confirmed **failing** against
  the pre-fix doc (`snapshots` overclaimed, 13 tables missing) before it was rewritten.
* Full `auth-worker` suite (`npx vitest run`): 208 files, 2337 tests, 2333 passing.
  The 4 failures are in three billing files (`billing-chat-usage`,
  `billing-usage-reconcile`, `billing-workspace-usage`) and are **pre-existing** — a
  PGlite `cannot insert multiple commands into a prepared statement` error, reproduced
  with this change stashed. Nothing in them touches the agent or the schema contract.
  `rls-backstop.test.ts` is unchanged and passing.
* The eight OPS-37 exploit strings were run against `guardSql()` outside the test suite
  at the pre-fix commit and all returned `ok: true`; each is now a permanent test.
* `npx eslint` clean on every changed file. `npx tsc --noEmit` reports no error in any
  changed file (the only output is four `TS2307`s for `hono`/`partyserver` in
  `sync-worker`, whose package is not installed in this environment).

---

_Re-run the mechanical parts of this review with: `npx vitest run
scripts/rls-coverage.test.ts scripts/neon-schema-contract.test.ts && cd auth-worker &&
npx vitest run src/__tests__/agent-sql-guard.test.ts src/__tests__/rls-backstop.test.ts`._
