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
import { handleFileRename } from './handlers/file-rename'
import { handleCommentEvent, type CommentEventKind } from './handlers/comment-events'
import { handleAssignmentEvent, type AssignmentEventKind } from './handlers/assignment-events'
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
  /**
   * QW-10: skip the per-event file-counter recompute. The route coalesces
   * one recompute per (file, chunk) instead; the affected file is reported
   * back via DispatchResult.counterFile.
   */
  deferFileCounters?: boolean
  /**
   * FRO-279: project-level threshold for cells.validated.
   * Passed through to buildEventProjectionStmts for cell.validate /
   * cell.unvalidate events. Default 1 (N=1 projects: byte-identical behavior).
   */
  validationCount?: number
}

/**
 * Dispatch one authorized event to its kind-specific handler.
 *
 * Does NOT write to Postgres or broadcast — the caller (route.ts) batches and
 * commits statements after all events in the request are dispatched.
 */
export function dispatchEvent(
  db: AquillaDb,
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
    case 'cell.waive':
    case 'cell.unwaive':
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
        ),
      }

    case 'file.rename':
      return {
        ok: true,
        result: handleFileRename(
          db,
          authed as AuthorizedEvent<'file.rename'>,
          serverTs,
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
        ),
      }

    case 'cell.backtranslation.set':
      return {
        ok: true,
        result: handleCellEvent(
          db,
          authed as AuthorizedEvent<CellEventKind>,
          serverTs,
          opts,
        ),
      }

    case 'assignment.create':
    case 'assignment.reassign':
    case 'assignment.unassign':
      return {
        ok: true,
        result: handleAssignmentEvent(
          db,
          authed as AuthorizedEvent<AssignmentEventKind>,
          serverTs,
        ),
      }

    default: {
      // Exhaustiveness check.
      const exhaustive: never = kind
      return { ok: false, status: 400, reason: `unknown event kind: ${exhaustive}` }
    }
  }
}
