// Shared DispatchResult shape returned by every per-kind handler.
//
// The handler is a pure function: it computes the SQL statements + the
// realtime frame for one event and returns them to the route layer. The
// route layer batches the statements, broadcasts the frame, and applies
// the AD-2 first-child-of-parent guard before any of this work happens
// (so handlers don't have to think about chain semantics).

import type { RealtimeMessage, ProjectionTable } from '../realtime'
import type { ChainSlot } from '../chain-claims'

/**
 * What the dispatcher hands back for ONE event: either the work to commit, or
 * a per-event refusal the route turns into an entry in the response's
 * `rejected` array.
 *
 * A handler that spots a bad shape must return the `ok: false` form rather
 * than throw. Nothing catches a throw between here and the worker's fetch
 * handler, so one malformed event would 500 the whole POST — and the client
 * reads 5xx as transient and retries the identical batch forever WITHOUT
 * burning its attempt budget, so a single bad event wedges the outbox
 * permanently (and, because batches are grouped by the head record's file,
 * for every project the user has open).
 *
 * Lives here rather than in dispatch.ts so handlers can name their own return
 * type: they already import DispatchResult from this file, and importing it
 * from the dispatcher would point the dependency the wrong way round.
 */
export type DispatchOutcome =
  | { ok: true; result: DispatchResult }
  | { ok: false; status: number; reason: string }

export interface DispatchResult {
  /**
   * The events INSERT statement plus any projection statements
   * (cells/files/cell_validators UPSERT, UPDATE, DELETE). Caller
   * accumulates these across all events in the batch and issues them in
   * BATCH_LIMIT-sized chunks via db.batch().
   */
  stmts: AquillaStatement[]
  /**
   * Per-event Realtime frame. Caller may coalesce many of these for
   * broadcast.
   */
  eventFrame: Extract<RealtimeMessage, { t: 'event' }>
  /**
   * Tables changed by this event. Caller unions across events for the
   * projection.dirty broadcast payload.
   */
  dirtyTables: ProjectionTable[]
  /**
   * AD-2 chain slot this event tried to claim (chain-mutating events that
   * passed the route's pre-check only). After commit, the route reads the
   * claim back; if another event holds it, this one lost an in-flight race
   * and is reported stale (RACE-2 / M1-2).
   */
  chainSlot?: ChainSlot
  /**
   * Set when the per-event file-counter recompute was deferred
   * (opts.deferFileCounters) — the route appends one recompute per
   * (file, chunk) instead (QW-10).
   */
  counterFile?: { projectId: string; fileId: string }
}
