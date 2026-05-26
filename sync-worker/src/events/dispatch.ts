// Per-kind event dispatcher.
//
// Single point of kind-to-handler mapping. Adding a new EventKind in
// types.ts will trip the exhaustiveness check in the default branch, so
// the dispatcher stays in sync with the type at compile time.
//
// Every cell-level kind routes to the same `handleCellEvent` because the
// shape of the work is identical (write events row + projection statements
// + realtime frame). What changes per kind is the projection statements,
// and those are built inside buildEventProjectionStmts (event-projection.ts).
//
// `file.create` is the only non-cell kind so it has its own handler.

import type { AuthorizedEvent } from './authorize'
import type { EventKind } from './types'
import { handleCellEvent, type CellEventKind } from './handlers/cell-events'
import { handleFileCreate } from './handlers/file-create'
import { handleCommentEvent, type CommentEventKind } from './handlers/comment-events'
import type { DispatchResult } from './handlers/types'

export type { DispatchResult } from './handlers/types'

export type DispatchOutcome =
  | { ok: true; result: DispatchResult }
  | { ok: false; status: number; reason: string }

export interface DispatchOptions {
  /**
   * AD-2 first-child-of-parent decision. When `false`, the projection
   * update is skipped — the event still lands in `events` (for history)
   * but does not advance `cells.event_id`. The route layer evaluates the
   * parent-chain guard before calling here.
   */
  updateProjection: boolean
  /** Per-project monotonic sequence assigned at accept time. */
  serverSeq: number
}

/**
 * Dispatch one authorized event to its kind-specific handler.
 *
 * Does NOT write to D1 or broadcast — the caller (route.ts) batches and
 * commits statements after all events in the request are dispatched.
 */
export function dispatchEvent(
  db: D1Database,
  authed: AuthorizedEvent,
  serverTs: number,
  opts: DispatchOptions,
): DispatchOutcome {
  const kind = authed.event.kind as EventKind
  switch (kind) {
    case 'source.cell.create':
    case 'source.cell.commit':
    case 'source.cell.delete':
    case 'source.cell.reorder':
    case 'target.cell.create':
    case 'target.cell.commit':
    case 'target.cell.delete':
    case 'target.cell.reorder':
    case 'cell.validate':
    case 'cell.unvalidate':
    case 'cell.audio.attach':
    case 'cell.audio.select':
    case 'cell.audio.remove':
      return {
        ok: true,
        result: handleCellEvent(
          db,
          authed as AuthorizedEvent<CellEventKind>,
          serverTs,
          opts,
        ),
      }

    case 'file.create':
      return {
        ok: true,
        result: handleFileCreate(
          db,
          authed as AuthorizedEvent<'file.create'>,
          serverTs,
          { serverSeq: opts.serverSeq },
        ),
      }

    case 'comment.create':
    case 'comment.edit':
    case 'comment.delete':
    case 'comment.resolve':
      return {
        ok: true,
        result: handleCommentEvent(
          db,
          authed as AuthorizedEvent<CommentEventKind>,
          serverTs,
          { serverSeq: opts.serverSeq },
        ),
      }

    default: {
      // Exhaustiveness check.
      const exhaustive: never = kind
      return { ok: false, status: 400, reason: `unknown event kind: ${exhaustive}` }
    }
  }
}
