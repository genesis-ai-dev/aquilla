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
The second outage happened on a release whose manifests and lockfiles carried
that pin, which read as the pin having failed. It had not been in force. The
Workers serving that day came from a manual deploy of the release, not the
release workflow, and a deploy bundles whatever driver is installed. Every
database error those two Workers logged carries stack frames (`frame`, `run`,
`socket.ondata`) that exist only in 4.0.0, and the sync-worker bundle
downloaded from Cloudflare contains 4.0.0's code. The three builds of the
pinned release that ran before it served 272 loads of the settings route with
no statement left half-sent.

Reading the nine reads one at a time stopped the leak within minutes of
deploying, on either driver, because nothing then exceeded the pool.

The wedge was reproduced on the development Hyperdrive on 2026-11-13, with a
scratch Worker driving the real shim: nine unprepared reads at once on a pool
of eight.

| Driver | Runs | Wedged |
| --- | --- | --- |
| 4.0.0, defaults | 3 | 3, always the ninth statement |
| 4.0.0, `max_pipeline: 1` | 105 | 0 |
| 3.4.9 | 105 | 0 |

The 105 include fan-outs of 16, 32 and 64 and mixed slow and fast statements.
So the ingredient "wider than the pool" needed was the driver: 4.0.0 writes
the surplus statement to a busy connection, where 3.4.9 queues it.

Two things are still **not** known. Whether the reply is lost in the driver
or in Hyperdrive: the same nine reads do not wedge from Node or from a local
Worker connected straight to Postgres. And why the whole-project health
rollup, which issues one read per file, as many as 121 at once, through the
same statement path and from a Worker that was also running 4.0.0, was never
among the wedged sessions.

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

The driver is also told not to double up on its own
(`db/shim/postgres.ts::MAX_PIPELINE`, added when the driver returned to 4.0.0).
The cap keeps the shim from handing the driver a statement it has no
connection for; the pipeline limit means that if one arrives anyway, it waits.
Neither reaches statements inside a transaction, which 4.0.0 always writes
straight to the transaction's connection, so `fromPostgresJs` makes an
unprepared statement there wait for the one before it. That is what 3.4.9 did
by itself. Prepared statements are exempt: `batchPipelined()` sends a wave of
them together on purpose, and through Hyperdrive that shape returned the same
results at the same 13 to 15 ms per statement on every driver in the table.

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

- The two open questions under Context, and with them whether the driver or
  Hyperdrive should be reported upstream.
- 4.0.0 under conditions the reproduction did not exercise: a handle idle past
  Hyperdrive's ten-minute drop, a client that aborts mid-request, a connection
  lost mid-statement, and several days of real traffic.
- A deploy that bundles a driver other than the one the lockfile names. That
  is how the second outage happened, and nothing checks for it.
- Work started outside the request's handle (`makePostgres` called again for a
  streaming route or a Durable Object) has its own pool and its own cap; the
  60 origin connections are still shared by all of them.
