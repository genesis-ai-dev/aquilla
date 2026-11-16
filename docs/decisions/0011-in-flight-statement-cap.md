# 0011 — A handle never holds more work than its pool has connections

*Decided and recorded 2026-11-16, after the production outages of 2026-11-13
and 2026-11-16. No Linear issue yet.*

## Context

Each Worker request builds its own Postgres handle with a small pool
(`db/shim/postgres.ts::DEFAULT_POOL_MAX`, eight connections) and reaches Neon
through Hyperdrive, which holds 60 origin connections for the whole product.

`GET /orgs/:id/settings` issued nine reads in one `Promise.all`. On both
dates the ninth was left half-sent: Postgres showed it `active` in
`ClientRead` and it held an origin connection until Hyperdrive dropped it ten
minutes later. Every load of that route leaked one. On 2026-11-16, 45 to 55 of
the 60 origin connections were in that state, all on that one statement, and
every other route waited seconds for a connection or failed.

The first diagnosis blamed postgres.js 4.0.0 and pinned the driver to 3.4.9.
The second outage happened on the pinned release. Reading the nine reads one
at a time stopped the leak within minutes of deploying.

What is **not** known is why that route wedged. The whole-project health
rollup issues one read per file, as many as 121 at once, through the same
statement path, and was never among the wedged sessions. In postgres.js 3.4.9
a statement issued past the pool normally just queues. So "wider than the
pool" is necessary for what we saw but not sufficient, and the missing
ingredient has not been found.

## Decision

The handle, not each route, keeps the driver inside its pool.
`db/shim/postgres.ts::capInFlight` lets at most `max` units of work run at
once and makes the rest wait in the order they were issued. A unit is one
top-level statement or one whole transaction, which is one pool connection.
Statements inside a transaction are not counted: they run on the connection
their transaction already holds.

`db/shim/postgres.ts::fromPostgresJs` is the only place a production executor
is built, and it applies the cap at the pool's own size. With the cap equal
to the pool, the driver always has a free connection for whatever it is
handed and never has to decide what to do with a statement it has none for.

A route may still write a fan-out wider than the pool. It runs in waves, as it
did before inside the driver's queue.

## Consequences

- Every route is covered, including ones not yet written, without knowing the
  exact trigger.
- Raising `DEFAULT_POOL_MAX` raises the cap with it. Do not raise one without
  the other, and do not build an executor that bypasses `fromPostgresJs`.
- A wide fan-out gains nothing from being wide. One query that returns every
  row is still the faster shape.
- A transaction that issues a statement on the outer handle while every slot
  is held by such transactions waits forever. The driver's pool already had
  this property; the cap does not add it.
- `sync-worker/src/__tests__/db-statement-cap.test.ts` pins the behaviour. It
  cannot show the wedge itself: that needs Hyperdrive.

## Not covered yet

- The root cause. A reproduction through Hyperdrive on the development
  environment would say what the settings route did that the health rollup
  does not, and whether the driver or Hyperdrive should be reported upstream.
- Whether postgres.js 4.x is safe to return to. The Dependabot hold on its
  major version stays until that reproduction exists.
- Work started outside the request's handle (`makePostgres` called again for a
  streaming route or a Durable Object) has its own pool and its own cap; the
  60 origin connections are still shared by all of them.
