# Operational Security Review — 2026-09-10

_Continues the standing series. Most recent entries: `docs/OPSEC-REVIEW-2026-08-31.md`
(OPS-25…OPS-26, auth/session theme) and `docs/OPSEC-REVIEW-2026-08-27.md` (OPS-22…OPS-24,
API/data-exposure theme). New findings continue the **OPS-n** series at OPS-27._

**Scope for this pass: API security & data exposure**, the fifth pass on this theme in the
rotating weekly cycle (auth/session Mon, authz/access Tue, injection Wed, **API/data exposure
Thu**, infra/deployment Fri). A dedicated survey agent inventoried every route in `auth-worker`
and `sync-worker` end to end — full endpoint/auth-gate map, authorization/IDOR sweep, response
data-exposure sweep, secrets handling, rate limiting, CORS, verbose-error sweep, and the AD-2
`POST /events` head-CAS mechanism — with file:line evidence for every claim. This pass triages
that inventory: most of the classic gaps (IDOR, mass assignment, PAT/secret leakage, CORS+
credentialed-cookie CSRF, timing side-channels) were already closed by prior passes and are
recorded below as reviewed with no new finding. One broad, previously-unswept class of real
findings remained: **raw driver/upstream error text reaching the client in `catch` blocks
across both workers.**

Every finding is labelled **FACT** (verified against a file:line or a test run at this commit)
or **JUDGMENT** (reasoned inference).

---

## Findings

### OPS-27 — Raw DB/R2/upstream error text echoed to the client across ~20 route handlers — **FIXED** [FACT]

`auth-worker/src/routes/auth.ts` was hardened against exactly this class of bug in an earlier
pass (SEC-11: *"this branch used to echo `msg` verbatim… Any internal failure whose message
merely CONTAINED '409'… was reflected to an unauthenticated caller"*), and the 2026-09-03 pass
(OPS-25/26, not yet merged — see "Not part of this pass" below) closed two more sites
(`knowledge.ts`, `agent-artifacts.ts`). Both showed the team is aware of the risk, but a full
sweep of both workers' `catch` blocks turned up ~26 more sites still building a client-facing
error body from `err.message`/`String(err)` — a caught Postgres/driver exception (constraint
names, column/table names, type-mismatch detail), an R2 exception (bucket/host detail, observed
in one case to include a raw IP address in a simulated network failure), or a `fetch()` failure
against an internal Modal service URL (`OMNIVOICE_URL`/`SEED_VC_URL`), returned verbatim at a
4xx/5xx status to the caller — an authenticated project member in most cases, a service
credential holder for the `/migrate/*` sites.

**Reachable, representative examples (not an exhaustive list — see the table below):**

- `auth-worker/src/routes/projects.ts` — rename/archive/restore/create/delete-file all echoed
  `err.message` at 500, reachable by any project MAINTAINER+.
- `auth-worker/src/routes/monday.ts:664-671` — the `catch` block's own comment says *"the body
  snippet is logged server-side only — never leaked to the client"*, immediately followed by a
  fallback branch two lines below that did exactly that for any non-`AnalyzeUpstreamError`
  failure — the code contradicted its own stated intent.
- `sync-worker/src/events/route.ts` (`POST /events`, the primary write path for every
  contributor's outbox flush) — two separate `catch` blocks reflected raw batch-insert and
  per-event-handler exceptions into the `rejected[]` array of an otherwise-200 response.
- `sync-worker/src/tts.ts` / `sync-worker/src/voice-convert.ts` / `sync-worker/src/audio.ts` —
  `fetch()`/R2 failures against internal Modal/R2 infrastructure reflected upstream error text
  (including, in Workers' TypeError shape, occasional target-host detail) to the browser client.
- `sync-worker/src/events/migrate-*-route.ts` (6 files) and `import-*-route.ts` (4 files) —
  the bulk-ingest/migration surface. These sit behind `migrateFenceResponse`'s runner-header
  fence plus the `SYNC_SECRET_KEY` service credential the routes themselves enforce
  (`docs: sync-worker/src/lib/migrate-fence.ts` — *"identification + intentionality, NOT
  authentication"*), so the practical exposure is to a party who already holds that shared
  service credential — lower severity than the browser-authenticated sites above, fixed anyway
  for the same defense-in-depth reasoning OPS-23 used for `isPathSafeId`.

**Not fixed / deliberately left as-is:**
- `sync-worker/src/events/migrate-ingest-route.ts:170-177` — this one `Response` **intentionally**
  echoes `cannot project event {id} (kind): {err}` per its own comment: *"surface the offending
  event so the CLI can pinpoint it rather than failing the whole batch opaquely"* — a documented
  debugging aid for the trusted migration CLI operator, not an oversight. Left unchanged.
- `auth-worker/src/routes/marketing-seed.ts` — `${err.message}` in its `detail` field, but the
  whole route 404s unless `WRANGLER_LOCAL=1` (local/e2e-recording stack only, invisible in any
  real deployment per the file's own header comment). Not reachable in production; left as-is
  rather than touching demo/recording tooling out of scope for this pass.
- `auth-worker/src/routes/import-sandbox.ts:376,425` — feeds a Zod-validation error from the
  **caller's own LLM-generated parser code** back into the same caller's own agent retry loop
  (and, if every retry is exhausted, into that same caller's own response). This is the user's
  own operation's own diagnostic output, not another user's or the platform's internal state —
  reviewed and left as intentional debugging feedback, not an information-disclosure finding.

**Fix:** every confirmed site now logs the caught error server-side (`console.error`, matching
the established `auth.ts` convention) and returns a fixed, generic message at the same status
code — no change to status codes, response shapes, or any field the client already depended on
structurally, only the error string's content. No UX/UI impact: these are all failure-path
strings a normal user path never exercises, and none of the touched frontend code reads the
`error`/`reason` field for anything beyond display.

| Area | Files | Sites |
|---|---|---|
| `auth-worker` project/org lifecycle | `routes/projects.ts`, `routes/source-linking.ts` | 8 |
| `auth-worker` Monday.com integration | `routes/monday.ts` | 2 |
| `auth-worker` document parsing | `routes/parse-document.ts` | 1 |
| `sync-worker` primary event write path | `events/route.ts` | 2 |
| `sync-worker` import/re-import | `events/import-route.ts`, `import-morph-route.ts`, `import-reconcile-route.ts`, `source-upload-route.ts` (×2), `external/import-parse.ts` | 6 |
| `sync-worker` bulk migration surface | `events/migrate-{ingest,settings,audio,project,finalize,source-artifact-copy}-route.ts` | 7 |
| `sync-worker` audio/artifacts/voice | `audio.ts`, `external/artifacts-route.ts`, `tts.ts`, `voice-convert.ts`, `project-do.ts` | 5 |

**Tests:** new regression coverage for the two highest-traffic paths — the primary `POST
/events` write path and the source-file upload path — asserting the client-visible error stays
a fixed generic string and specifically does **not** match constraint/table names, IPs, or other
injected "raw driver error" fixtures even when the underlying DB/R2 call is made to throw one
(`sync-worker/src/__tests__/events-route.test.ts`, `source-upload-route.test.ts`). The remaining
~24 sites are a mechanical, identical transformation (drop the interpolated variable, add a
`console.error`, no logic/branching change) verified by the full `tsc --noEmit` + `eslint` +
existing-suite pass below rather than a bespoke DB-failure-injection test per file.

### Reviewed, no new finding

- **Org member roster email exposure** (`auth-worker/src/routes/orgs.ts:382-406`) — every org
  member's email is visible to any caller clearing the org's `rosterViewMinRole` floor. Traced
  to `services/org-permissions.ts:1522-1543`: this is a deliberate, documented (AQU-485) product
  control with a fail-closed default (`DEFAULT_ROSTER_VIEW_MIN_ROLE` = MAINTAINER, 600) and a
  distinct `rosterHidden: true` 403 for callers below the floor that does **not** leak roster
  size. Not a finding.
- **`AGENT_SANDBOX_KEY` bearer-token comparison** (`agent-worker/src/app.ts:44-61`) — flagged by
  the survey as worth checking for a timing side-channel; already fixed in an earlier pass
  ("adversarial-panel authz-m1", same file's own comment) via SHA-256 digest + no-early-exit XOR
  comparison, i.e. not a naive `===`. Not a finding.
- **AD-2 `POST /events` head-CAS atomicity** — read `sync-worker/src/events/chain-claims.ts` end
  to end (the survey flagged this as not independently verified last pass). The claim is a real
  atomic `INSERT … ON CONFLICT (project_id, file_id, cell_id, parent_key) DO NOTHING` taken
  *inside* the same transaction as the event insert, with every chain-advancing projection write
  gated on `EXISTS (… chain_claims … AND event_id = <this event>)` — not a JS-side check-then-act.
  Confirmed closed, matching `route.ts`'s own RACE-2 comments. Not a finding.
- **PAT scoping, IDOR on artifact/changeset routes, mass assignment / `SELECT *` reaching a
  response, SSRF on the outbound proxies** — re-swept per the survey's inventory; unchanged from
  the 2026-08-27 pass's own "Reviewed, no finding" list. No new gap found.

### Not part of this pass — already reported, tracked elsewhere

- **AI chat/agent-run/TTS proxies have no per-minute rate limit, and `AI_BUDGET_ENFORCE` defaults
  to log-only** — found independently by this pass's survey, then confirmed already reported and
  fixed as OPS-25 in `docs/OPSEC-REVIEW-2026-09-03.md`, currently sitting in an unmerged PR
  (genesis-ai-dev/aquilla#523 / AQU-1141). Not re-fixed here to avoid two PRs racing the same
  files; flagging again so it isn't lost if #523 stalls further.
- **OPS-24 (credit-guard check-then-act race)** — carried forward unchanged per the 2026-08-27
  doc; still needs a billing-scoped pass, not a side effect of this one.
- **V7/SEC-1 (prod/dev share `SECRET_KEY`/`SYNC_SECRET_KEY`)** — carried forward unchanged; still
  the highest-leverage open item across the whole series, out of scope for this pass's theme.

---

## Risk assessment

| ID | Finding | Likelihood | Impact | Risk | State |
|---|---|---|---|---|---|
| OPS-27 | Raw DB/R2/upstream error text reflected to the client across ~26 sites | High — every listed route trips on an ordinary DB/R2/upstream error, no special access needed beyond the route's normal auth | Low-Medium per instance (schema/constraint/table names, occasional internal hostname/IP) — recon value for a later, targeted attack rather than a direct compromise | **Medium** (broad surface area) | Fixed |

## Countermeasures applied in this change

| Control | Where |
|---|---|
| Generic client-facing error message + server-side `console.error` on every DB/R2/upstream `catch` that used to echo raw error text | 21 files across `auth-worker/src/routes/*` and `sync-worker/src/{events,external}/*`, `audio.ts`, `tts.ts`, `voice-convert.ts`, `project-do.ts` — see table above |
| Regression tests asserting the client response stays generic even when the DB/R2 call is made to throw a raw driver-shaped error | `sync-worker/src/__tests__/events-route.test.ts`, `sync-worker/src/__tests__/source-upload-route.test.ts` |

## Verification

* `sync-worker`: `npx tsc --noEmit` clean; full suite green
* `auth-worker`: `npx tsc --noEmit` clean (3 pre-existing, unrelated `Context`/`ExecutionContext`
  type errors in `index.ts` confirmed present before this change via `git stash`); full suite
  green
* `eslint` clean on every changed file (one pre-existing unused-`err` warning this pass
  introduced in `sync-worker/src/events/route.ts` was fixed by adding the `console.error` call,
  rather than suppressed)
* No response status code, response shape, or structurally-consumed field changed — only the
  content of already-generic-shaped error strings

---

_Re-run the mechanical parts of this review with: `cd sync-worker && npx tsc --noEmit && npx
vitest run` and `cd auth-worker && npx tsc --noEmit && npx vitest run`._
