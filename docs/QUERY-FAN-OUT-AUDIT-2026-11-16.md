# Query fan-out audit — auth-worker and sync-worker (2026-11-16)

*AQU-2614. Reviewed at `origin/dev` 4cef787ac.*

## Why this audit exists, and what changed under it

`GET /orgs/:id/settings` issued nine statements in one `Promise.all` against a
per-request pool of eight, and that was half of the 2026-11-16 outage. The
question this audit was opened to answer was "where else does one request ask
for more connections than it has?"

That question is no longer a safety question. `db/shim/postgres.ts::capInFlight`
landed on `dev` the same day (decision
`docs/decisions/0011-in-flight-statement-cap.md`), and it is applied in
`db/shim/postgres.ts::fromPostgresJs`, the only place a production executor is
built. A handle now holds at most `db/shim/postgres.ts::DEFAULT_POOL_MAX` units
of work at once and makes the rest wait in issue order, so **no route can
present the driver with a statement it has no connection for, however wide its
fan-out.**

So this is a **latency and shape review**: a wide fan-out is no longer
dangerous, it is merely pointless. It runs in waves of eight either way, and
the waves now queue one level up from where they used to. Nothing in the list
below is an outage risk at the time of writing. What the list is for is the
second half of the acceptance criteria — knowing which routes degrade with
customer data size, so a large org does not discover them for us.

### Scope and method

Every `Promise.all` / `Promise.allSettled` under `auth-worker/src` and
`sync-worker/src`: 196 sites across 108 files, of which **116 sites in 66
files** are outside test files and so are what a request can actually run. Each
was classified by reading it, after a mechanical pass measured the array
literals (comments stripped first — commas and apostrophes inside them make a
naive count wildly wrong). Sites were then judged on three things the issue
asked for: fixed width, data-dependent width, and nesting that multiplies.

Counts below are **statements in flight on one handle**, not total statements.
A `.map()` whose body awaits its queries one after another contributes one
in-flight statement per element, not one per query.

## Fixed-width fan-outs: none exceed the pool

| Width | Site | Note |
| --- | --- | --- |
| 8 | `sync-worker/src/events/route.ts` — events-route prefetch (PERF-2) | The widest in either worker. Exactly fills the pool. |
| 7 | `sync-worker/src/external/emit-events-engine.ts` — reference loads | One arm is conditional on the batch touching terminology. |
| 6 | `auth-worker/src/routes/admin.ts` — `GET /admin/overview` | Six `COUNT(*)`s. Platform admin only. |
| 5 | `sync-worker/src/events/progress-read-route.ts` — queue read | Three of the five arms are `Promise.resolve` on any given queue kind, so 2–5 are real statements. |

There are 88 array-literal sites in all; the 85 not listed above are 2–5 wide.
**No fixed array in either worker is wider than `DEFAULT_POOL_MAX`.** The nine-wide
`Promise.all` that caused the outage was the only one, and it is gone.

One correction fell out of this: the comment on `DEFAULT_POOL_MAX` said the
events route fans out *six* prefetch SELECTs and that eight leaves "headroom".
It fans out eight, which is the whole pool, and the reads that follow it are
sequential. The comment is the one piece of guidance an author reads before
widening that array, so it has been corrected rather than left to mislead.

## Data-dependent fan-outs — called out separately

These pass today on small data. Their width is set by customer data, so they
are the ones that get slower as an org grows. None is unsafe; each is an N+1
that wants to be one query.

### 1. Whole-project health rollup — worst case 200

`sync-worker/src/events/health-rollup-route.ts`, the `fileIds.map(scoreFile)`
fan-out.

- **Driver:** one statement per source file in the project, capped by that
  module's `MAX_FILES` (200). Per file it then runs *lanes × 2* statements
  sequentially, so total statements are `files × lanes × 2`.
- **Worst case in flight:** 200.
- This is the fan-out decision 0011 records at 121 concurrent — and notes was
  *never* among the wedged sessions, which is why "wider than the pool" was
  necessary but not sufficient to explain the outage.
- **Not fixed here.** Making it set-based is a real change to the propagation
  query, not a surgical edit. Ticketed.

### 2. `GET /admin/credits/orgs` — worst case = every org on the platform

`auth-worker/src/routes/admin.ts`, the `(orgs ?? []).map(...)` fan-out.

- **Driver:** the org list it fans out over is `SELECT id, name FROM
  organizations ORDER BY id` with **no `LIMIT`**. Per org it awaits
  `resolveCreditConfig` then `readSpend`, one statement each, sequentially.
- **Worst case in flight:** the total number of organizations — the only
  genuinely unbounded fan-out in either worker.
- Platform-admin route, so it is not on a customer path; it will simply get
  slower until someone fixes the shape. Both reads are per-org lookups that a
  single set-based query could answer. **Ticketed.**

### 3. Subscribed-termbase read — nested, multiplies by 2

`auth-worker/src/lib/contextual/project-context.ts`, `results.map()` with an
inner `Promise.all([readProjectConcepts, loadLaneRows])`.

- **Driver:** `project_termbase_subscriptions` rows for the project, times the
  two inner reads.
- **Worst case in flight:** `2 × subscriptions` — past the pool at five
  subscribed termbases.
- The clearest instance of the "nested fan-outs that multiply" category.
  Neither inner read can be hoisted (both are keyed on the termbase project),
  so the fix is a set-based read across termbases. **Ticketed.**

### 4. Side-effect queue consumer — worst case 10, over a pool of 8

`sync-worker/src/side-effects/queue.ts::handleSideEffectBatch`.

- **Driver:** `max_batch_size = 10` in `sync-worker/wrangler.toml`. The queue
  handler builds **one** handle for the whole batch, so all ten messages share
  a pool and a cap of eight; each message's handler issues its statements
  sequentially, so each contributes one in flight.
- **Worst case in flight:** 10 — two messages of every full batch wait for a
  connection.
- The mismatch is a config value against a code constant, with nothing tying
  them together. Correct under the cap, just needlessly throttled.
  **Ticketed.**

## Sites that look data-dependent but are bounded

Worth recording, because each is a site a future reader would reasonably flag.

- **Progress push per recomputed file** —
  `sync-worker/src/events/progress-push.ts::buildFileProgressPushFrames` is
  mapped over `recomputedFiles` in the events route, and internally issues
  three per-*project* reads in a nested `Promise.all`. That reads as `3 × N`.
  It is not: a `POST /events` is authorized by
  `sync-worker/src/auth.ts::verifyTokenForDoc`, which requires an exact
  `fileId` match, so every event in one request belongs to one file and
  `recomputedFiles` holds at most one entry. Width 3, not `3 × N`. If per-file
  tokens are ever relaxed to project scope, this becomes a real `3 × N`
  multiplier and those three reads must be memoized per project.
- **`auth-worker/src/services/project-permissions.ts::resolveProjectRoles`** —
  fans out over every project on the dashboard, but every read inside is a
  shared promise assigned synchronously before the first `await`
  (`legacyPaths ??=`, `viewRoles ??=`, `admins ??=`). Peak is ~3 statements
  regardless of project count. **This is the shape the fixes above should take**
  — the same memo-per-request idea as
  `sync-worker/src/events/request-cache.ts::makeRequestCache`.
- **`auth-worker/src/services/access-audit.ts`** — already bounds itself with a
  local `mapPool(items, 8, fn)` helper. The only in-repo concurrency limiter;
  worth promoting if the fixes above want one.
- **`sync-worker/src/external/memory-read-routes.ts`** and
  **`sync-worker/src/events/transcription-examples-route.ts`** — both map over a
  page/ranked slice, but the mapped bodies do HMAC signing and in-memory
  pseudonymisation, not queries. No statements in flight.
- **`auth-worker/src/services/legacy-user-migration.ts`** — width ≤2 (a
  two-element set minus the submitted identifier).

## Not statements — subrequest fan-outs

These are wide, but they spend Workers subrequests, not pool connections, so
the cap does not apply and neither does this audit's question. Recorded only so
the next audit does not re-derive it: `sync-worker/src/events/link-notify.ts`
(already uses a concurrency limiter), `sync-worker/src/notification-email.ts`
(one send per recipient), `auth-worker/src/routes/org-settings.ts`
(`notifyProjectRoomsBestEffort`, one subrequest per project in the org, inside
`waitUntil`), and the events route's `doFanOut` / `broadcasts` Durable Object
broadcasts. The org-settings one is per-org-size and unbounded; if anything
here ever bites, it will be that one against the subrequest limit.

## Outcome

- No fixed-width fan-out exceeds the pool. The outage's nine-wide read was the
  only one and is gone.
- Four data-dependent fan-outs exceed it. All four are safe under
  `capInFlight` and all four are N+1 shapes; each has its own ticket.
- Fixed in the AQU-2614 PR: the `DEFAULT_POOL_MAX` comment, which understated
  the widest fan-out in the repo and promised headroom that does not exist.
