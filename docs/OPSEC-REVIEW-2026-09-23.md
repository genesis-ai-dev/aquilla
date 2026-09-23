# Operational Security Review — 2026-09-23

_Continues the standing series. Most recent entry: `docs/OPSEC-REVIEW-2026-09-17.md`
(OPS-33…OPS-34, API security & data exposure). New findings continue the **OPS-n**
series at **OPS-35**._

**Scope for this pass: input validation & injection attacks** — the first pass on this
theme in the rotating weekly cycle (auth/session Mon, authz/access Tue, **injection
Wed**, API/data exposure Thu, infra Fri). No prior review in this repo was scoped to
this theme by name, though several earlier passes closed individual injection-shaped
bugs in passing (the SQL guard's decoy-CTE fix and `password_hash` ban, both dated
2026-07-29, and the resource-proxy open-redirect fix referenced below) — this pass
re-examines that surface deliberately rather than incidentally.

A survey agent swept raw-SQL construction, HTML/rich-text rendering, command
execution, deserialization/`eval`, regex DoS, path traversal/SSRF, and prototype
pollution across the SPA and all three workers. Two real findings came out of that
sweep (below); everything else it checked is recorded under "Reviewed, no new
finding" with what was actually verified, not just asserted. Both findings were
independently reproduced against the real code — OPS-35 by running the pre-fix
`guardSql()` against the crafted exploit string and confirming it returned `ok: true`
with a SQL string that reads the `users` table — before being fixed.

Every finding is labelled **FACT** (verified against a file:line or a reproduced
exploit at this commit) or **JUDGMENT** (reasoned inference).

---

## Findings

### OPS-35 — The agent's SQL sandbox let any authenticated project member dump every account's email on the platform — **FIXED** [FACT]

`auth-worker/src/lib/agent/sql-guard.ts` is the in-app translation agent's read
path: the model is free to write arbitrary SQL text, which `guardSql()` validates
(single SELECT statement, keyword/function/column blocklists, mandatory
`project_id = :project` scoping) before `runGuardedSql()` executes it read-only
against production Postgres. Its own header comment states the threat model
correctly: *"the model's SQL is untrusted input running against the production
database."* A 2026-07-29 pass had already found and fixed one bypass of the
`:project` scoping check (a decoy CTE) and, while doing so, banned the
`password_hash` column outright with a comment noting `users` "has no RLS backstop"
and that a scoping-check bypass "would otherwise be able to exfiltrate every
credential on the platform in one query."

That fix did not go far enough. The mandatory-scoping check
(`PROJECT_EQ_RE`/`reachableScopingText()`) only requires the substring
`project_id = :project` to appear *somewhere* in the reachable query text — it does
not, and by its own design comment cannot, verify that *every* table the query joins
is actually filtered by it. For the seven tables migration `0034_rls_backstop.sql`
(and later migrations) put real row-level security on — `cells`, `events`, `files`,
`comments`, `cell_validators`, `cell_audio`, `project_settings`, plus several added
since — that gap is closed at the database layer regardless of what the guard's text
analysis missed. **`users` has no such backstop and no `project_id` column at all**,
so nothing catches an unfiltered join against it. No decoy CTE is even required —
this is a *simpler* bypass than the one already fixed:

```sql
SELECT c.cell_id, u.email, u.username, u.display_name
FROM cells c
CROSS JOIN users u
WHERE c.project_id = :project
```

Reproduced directly against `guardSql()` at the pre-fix commit: this returns
`{ ok: true, sql: "...CROSS JOIN users u WHERE c.project_id = ?...", params: [projectId] }`.
Run for real, `cells c` is correctly RLS-scoped to the caller's own project, but the
`CROSS JOIN` against `users` has no such scoping — the result is the Cartesian
product, i.e. every row of `cells` paired with **every account on the platform**,
including `email`, `username`, and `display_name` (only `password_hash` was
blocked). Because `runGuardedSql()` caps the result at 200 rows but places no
restriction on `WHERE u.id BETWEEN … AND …`-style literal filters, the whole `users`
table is trivially exfiltrable in ~200-row pages via repeated tool calls.

**Reachable by:** any authenticated user who is a member of *any* single project —
including their own, freshly created, free-tier project — running the in-app
translation agent (`POST /api/v1/ai/agent/run`). The SQL text is model-authored, so
the practical trigger is either a user directly prompting the agent to run a query
like the one above, or a prompt-injection payload smuggled into translated content
that talks the agent into emitting it as a tool call — the agent's own system design
already treats "the model's SQL is untrusted" as its threat model; this closes the
one place that threat model wasn't fully enforced. This is exactly the D3 threat
`docs/OPSEC.md` describes (translator identity/activity, the reason state-level
actors are called out as this product's highest-impact threat actor) delivered via a
completely different route than the Agent-API `pii`/`agentAuthorship` controls
(AQU-1180, OPS-33/34) — those gate the *external* Agent API; this tool is the
in-app agent and was never subject to them.

**Fix:** `sql-guard.ts` gains a `BANNED_TABLES` list (currently `["users"]`),
checked the same way `BANNED_COLUMNS` already is — a straightforward, auditable
reject rather than an attempt to verify join correctness textually (the CTE-decoy
history shows that text-level "is this join actually scoped" analysis is exactly
where this class of bug keeps re-entering). The two `docs.ts` cookbook examples that
joined `users` for `username` (assignments list, project-members list) now return
the bare numeric `user_id`/`assignee_user_id` instead, with a note telling the model
this table isn't readable through the tool. Regression tests cover both the exact
cross-join exploit string above and a correctly-*shaped*-but-still-unscoped join
(`project_members pm JOIN users u ON u.id = pm.user_id`, i.e. proving the ban isn't
just a cross-join-specific pattern match).

**Also hardened in this pass (same file, low severity, defense-in-depth):**
`runGuardedSql()` interpolates `vars.projectId` directly into
`` SET LOCAL app.project_id = '<id>' `` (a `SET LOCAL` can't take a bind parameter).
The existing quote-doubling escape is sufficient against Postgres's default
`standard_conforming_strings`, and in practice `projectId` only ever reaches this
function after `resolveProjectRole()`'s own parameterized lookup — but that's a
property of the caller, not of this function. `PostgresDb.withUser()`
(`db/shim/postgres.ts`) already treats the equivalent `app.user_id` interpolation as
a GUC-injection primitive that "MUST be validated here rather than trusted from the
caller"; `runGuardedSql()` now applies the same discipline, rejecting anything that
isn't a well-formed UUID before it reaches the query text.

### OPS-36 — Two-way JSON merge (Codex-notebook conflict resolution) let a `"__proto__"` key repoint the merged object's prototype — **FIXED** [FACT]

`src/lib/codex-editor/merge/resolveJsonMerge.ts`'s `deepMerge()` — used by
`resolveJsonMergeTwoWay()` to two-way-merge conflicting JSON documents (Codex-
notebook git-style merges) — recursed with `out[k] = deepMerge(a[k], b[k], …)` for
every `k` in `Object.keys(b)`. `JSON.parse` creates a literal `"__proto__"` key as
an ordinary own data property (not a prototype mutation) on the object it returns,
so a merged document containing `{"__proto__": {...}}` reaches this bracket
assignment as attacker-controlled input. Unlike the read (`b["__proto__"]`, an
ordinary own-property lookup), the *write* `out["__proto__"] = value` does invoke
`Object.prototype`'s inherited `__proto__` accessor, and — when `value` is itself an
object, the common shape for a merge conflict — calls
`Object.setPrototypeOf(out, value)`, handing the attacker the merged object's
prototype chain.

Confirmed the assignment fires (`Object.getPrototypeOf(merged)` changed) for the
current call path before the fix. Real-world severity is capped today because the
only consumer (`resolveJsonMergeTwoWay`) immediately does
`JSON.stringify(deepMerge(...))`, and `JSON.stringify` only serializes *own*
enumerable properties — so an injected prototype doesn't itself leak into the
returned string on this call path. It does not touch the global `Object.prototype`
(only that one merge result's own prototype slot). This is a textbook
prototype-pollution primitive that becomes directly exploitable the moment any
caller uses the merged object itself rather than re-stringifying it, or if this
general-purpose merge helper is reused elsewhere — worth closing now rather than
carrying as a latent footgun.

**Fix:** `deepMerge()` now skips `"__proto__"`, `"constructor"`, and `"prototype"`
keys during the merge loop rather than assigning them. No legitimate two-way JSON
diff needs to literally set one of these three keys. Regression tests assert the
merged object's prototype is unchanged after merging a `__proto__`-bearing document,
and that `constructor`/`prototype` are not set as *own* properties on the result
(the inherited `Object.prototype.constructor` remains readable, which is correct —
only an own-property override would be the pollution).

---

## Reviewed, no new finding

Each item below was actually checked against the code, not assumed safe by category.

- **Raw SQL construction outside the SQL guard** — `db/shim/postgres.ts`'s `?`→`$n`
  translation never concatenates bind values into query text; the one raw
  interpolation point (`withIdentity()`'s `SET LOCAL app.user_id`) is guarded by
  `withUser()`'s `/^\d+$/` check before it's reached. Every other `${...}`
  interpolation found across `auth-worker/`, `sync-worker/`, and `db/shared/` is
  either a compile-time-constant column list, a `?`-repeated placeholder string
  paired with a `.bind()` array, or an internal literal-union parameter never
  reachable from request input (e.g. `runs.ts`'s `key: "agent_run_id" |
  "undo_of_agent_run_id"`). `test-reset.ts`'s `DELETE FROM ${t.name}` is hard-gated
  behind `WRANGLER_LOCAL === '1'` and iterates a hardcoded table list.
- **HTML/rich-text rendering (XSS)** — every `dangerouslySetInnerHTML` in `src/`
  (editor cell content, comments, terminology decoration) routes through
  `DOMPurify.sanitize()` with an explicit tag/attribute allowlist
  (`src/lib/richtext/editor-content.ts`), and terminology decoration is applied
  strictly after sanitization so it can't reintroduce stripped attributes. No
  unsanitized instance found anywhere in `src/` or `worker/og/`.
- **Command/shell injection** — no `child_process`/`exec`/`spawn` in any deployed
  Worker or in `infra/modal/*.py`. Build/dev tooling in `scripts/` that does shell
  out uses argv arrays (`execFileSync`/`execFileP`), not shell strings, including
  the one place a URL is built from repo config (`scripts/lib/checkout-guard.ts`).
- **Unsafe deserialization / eval** — no `eval`/`new Function` in application code.
  `src/lib/parsers/xml-lite.ts` is a hand-rolled, DTD-free XML reader that only
  supports the five predefined + numeric entities, closing XXE/billion-laughs by
  construction. The agent sandbox's code execution (`agent-worker/src/exec.ts`) is
  the intended sandboxed-execution feature, not an injection bug, and its path
  resolver (`agent-worker/src/paths.ts`) rejects `..` and non-`/workspace` paths.
- **Regex DoS** — `src/lib/search/replace-action.ts` escapes every metacharacter in
  a user search string before building a `RegExp` (plain-substring search only).
  Terminology-matching regexes (`src/lib/terminology/match.ts` and its
  auth-worker/sync-worker mirrors) join escaped literal segments with a single
  non-nested wildcard — no catastrophic-backtracking shape.
- **Path traversal / SSRF** — `src/lib/net/resource-proxy-handler.ts` (third-party
  content proxy) already carries a 2026-era pen-test fix closing a
  redirect-to-arbitrary-host bypass; today it's allowlisted, GET/HEAD-only, with
  manually revalidated redirects capped at 5 hops. `auth-worker/src/lib/aquifer/
  client.ts`'s path normalizer rejects `://`, `//`, and `..` before composing
  against a fixed base URL. R2 key construction uses server-generated UUIDs / route-
  matched single path segments — no traversal semantics apply to R2's flat
  namespace.
- **Prototype pollution elsewhere** — event-payload and request-body spreads
  (`event-projection.ts`, `contextual.ts`, `aquifer.ts`, `agent.ts`,
  `import-parse.ts`) are explicit-field whitelists or single-level object-literal
  spreads of `JSON.parse` output; a literal-key spread copies `__proto__` as a
  plain own key rather than invoking the setter, so these don't share OPS-36's bug
  shape.

## Secondary finding — reported, not fixed this pass

- **RLS coverage is narrower than the SQL guard's `PROJECT_TABLES` list implies.**
  While confirming OPS-35, this pass cross-checked every table
  `sql-guard.ts`'s `PROJECT_TABLES` regex treats as "requires `project_id =
  :project` scoping" against every `ALTER TABLE … ENABLE ROW LEVEL SECURITY`
  statement in `db/postgres/migrations/`. `assignments`, `assignment_cells`,
  `cell_waivers`, `cell_backtranslations`, `cell_word_morph`, `project_members`,
  `agent_runs`, and `chain_claims` are all in that list — and all granted DML to
  `app_runtime` by migration 0034 — but **none has an RLS policy**. Unlike `users`,
  each of these does carry a `project_id` column and so does get *some* protection
  from the guard's textual scoping requirement in the common case — but, per the
  guard's own documented residual-gap reasoning (the same reasoning this pass used
  to find OPS-35), a sufficiently adversarial query can still satisfy the textual
  check without every joined reference to one of these tables actually being
  filtered by it (e.g. an `EXISTS` clause that supplies the required substring
  without correlating to the table actually being read). Recorded rather than fixed
  in this pass: closing it properly means extending migration 0034's RLS pattern to
  these eight tables (a schema migration + `app_user_can_access_project`-style
  policy per table, the same shape already proven safe for `cells`/`events`/etc.),
  which is a larger, coordinated change appropriate for its own PR rather than a
  same-day guard patch — same category as OPS-24 (credit-guard race) and OPS-26
  (invite-token hashing) in prior passes. Recommend prioritizing `project_members`
  and `assignments` first: they're the two tables the legitimate cookbook already
  joins against `users`, so they're the most-exercised unscoped tables in practice.

---

## Risk assessment

| ID | Finding | Likelihood | Impact | Risk | State |
|---|---|---|---|---|---|
| OPS-35 | Agent SQL sandbox: unscoped join against `users` returns every account's email/username/display_name | High — reachable by any project member via a single ordinary-looking tool call, no decoy or trickery required | High — full-platform PII dump, the exact D3 (translator identity) exposure the threat model in `docs/OPSEC.md` treats as this product's highest-impact risk | **High** | Fixed |
| OPS-36 | Two-way JSON merge: `__proto__` key repoints the merged object's prototype | Low today — the only caller re-stringifies immediately, capping real-world impact | Medium if reused or if the merged object is ever consumed directly — a standard exploitation primitive once that's true | **Low-Medium** | Fixed |

## Countermeasures applied in this change

| Control | Where |
|---|---|
| `users` table banned outright in the agent's free-form SQL tool (`BANNED_TABLES`) | `auth-worker/src/lib/agent/sql-guard.ts` |
| Cookbook examples no longer join `users`; return numeric ids instead | `auth-worker/src/lib/agent/docs.ts` |
| `vars.projectId` validated as a UUID before interpolation into `SET LOCAL app.project_id` | `auth-worker/src/lib/agent/sql-guard.ts` |
| `deepMerge()` skips `__proto__`/`constructor`/`prototype` keys | `src/lib/codex-editor/merge/resolveJsonMerge.ts` |
| Regression tests: the exact cross-join exploit, a correctly-shaped-but-unscoped join, the malformed-projectId path, and the `__proto__`/`constructor`/`prototype` merge cases | `auth-worker/src/__tests__/agent-sql-guard.test.ts`, `src/lib/codex-editor/merge/__test__/resolveJsonMerge.test.ts` |

No UX/UI change: both fixes are backend/internal-tool only. The agent's SQL tool
loses the ability to resolve a `username` string for two cookbook queries (it now
returns a numeric id); the app's actual Members/Assignments UI is a separate,
already-authorized surface and is unaffected.

## Verification

* `auth-worker`: full `npx vitest run` — 174 files, 1783 tests, all passing
  (includes the new/updated `agent-sql-guard.test.ts` cases and the untouched
  `agent-docs-playbooks.test.ts`/`agent-docs-brief.test.ts`). `npx eslint` clean on
  every changed file.
* Root SPA: `npx vitest run src/lib/codex-editor/merge/__test__/resolveJsonMerge.test.ts`
  green (6 tests, including the two new prototype-pollution cases). `npx eslint`
  clean on both changed files.
* The OPS-35 exploit string was run against the pre-fix `guardSql()` directly
  (outside the test suite) and confirmed `ok: true` before the fix; the same string
  is now a permanent regression test.

---

_Re-run the mechanical parts of this review with: `cd auth-worker && npx vitest run
src/__tests__/agent-sql-guard.test.ts src/__tests__/agent-docs-playbooks.test.ts
src/__tests__/agent-docs-brief.test.ts && npx eslint src/lib/agent/sql-guard.ts
src/lib/agent/docs.ts && cd .. && npx vitest run
src/lib/codex-editor/merge/__test__/resolveJsonMerge.test.ts`._
