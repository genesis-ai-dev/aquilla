// Shared DispatchResult shape returned by every per-kind handler.
//
// The handler is a pure function: it computes the SQL statements + the
// realtime frame for one event and returns them to the route layer. The
// route layer batches the statements, broadcasts the frame, and applies
// the AD-2 first-child-of-parent guard before any of this work happens
// (so handlers don't have to think about chain semantics).

import type { RealtimeMessage, ProjectionTable } from '../realtime'

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
}
