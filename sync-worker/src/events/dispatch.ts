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
import type { RealtimeMessage } from './realtime'
import { handleCellEvent, type CellEventKind } from './handlers/cell-events'
import { handleFileCreate } from './handlers/file-create'
import { handleFileRename } from './handlers/file-rename'
import { handleFileVideoSet } from './handlers/file-video-set'
import { handleFileTimingSet } from './handlers/file-timing-set'
import { handleFileCorpusSet } from './handlers/file-corpus-set'
import { handleFileTrackSet } from './handlers/file-track-set'
import { handleFileDelete, handleFileRestore } from './handlers/file-delete-restore'
import { handleCommentEvent, type CommentEventKind } from './handlers/comment-events'
import { handleTermEvent, type TermEventKind } from './handlers/term-events'
import { handleAssignmentEvent, type AssignmentEventKind } from './handlers/assignment-events'
import type { DispatchOutcome } from './handlers/types'

export type { DispatchResult, DispatchOutcome } from './handlers/types'

export interface DispatchOptions {
  /**
   * AQU-1005: pre-allocated server_seq for this event. Allocation happens
   * once per request via allocateSeqRange, OUTSIDE the write transaction, so
   * the per-project counter row lock is never held across the event batch.
   */
  serverSeq: number
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
   * AQU-279: project-level threshold for cells.validated.
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
    case 'source.cell.metadata.patch':
    case 'source.cell.reanchor':
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
    case 'cell.audio.rename':
    case 'cell.audio.trim':
    case 'cell.audio.place':
    case 'cell.audio.measure':
    case 'cell.audio.validate':
    case 'cell.audio.unvalidate':
    case 'cell.link.set':
    case 'cell.attachment.add':
    case 'cell.attachment.remove':
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
          opts.serverSeq,
        ),
      }

    case 'file.rename':
      return {
        ok: true,
        result: handleFileRename(
          db,
          authed as AuthorizedEvent<'file.rename'>,
          serverTs,
          opts.serverSeq,
        ),
      }

    case 'file.delete':
      return {
        ok: true,
        result: handleFileDelete(
          db,
          authed as AuthorizedEvent<'file.delete'>,
          serverTs,
          opts.serverSeq,
        ),
      }

    case 'file.restore':
      return {
        ok: true,
        result: handleFileRestore(
          db,
          authed as AuthorizedEvent<'file.restore'>,
          serverTs,
          opts.serverSeq,
        ),
      }

    case 'file.video.set':
      return {
        ok: true,
        result: handleFileVideoSet(
          db,
          authed as AuthorizedEvent<'file.video.set'>,
          serverTs,
          opts.serverSeq,
        ),
      }

    case 'file.timing.set':
      return {
        ok: true,
        result: handleFileTimingSet(
          db,
          authed as AuthorizedEvent<'file.timing.set'>,
          serverTs,
          opts.serverSeq,
        ),
      }

    case 'file.corpus.set':
      return {
        ok: true,
        result: handleFileCorpusSet(
          db,
          authed as AuthorizedEvent<'file.corpus.set'>,
          serverTs,
          opts.serverSeq,
        ),
      }

    case 'file.track.set':
      // The only handler that validates a payload shape, so the only one that
      // can refuse — it returns the outcome itself rather than a bare result.
      return handleFileTrackSet(
        db,
        authed as AuthorizedEvent<'file.track.set'>,
        serverTs,
        opts.serverSeq,
      )

    case 'term.create':
    case 'term.update':
    case 'term.delete':
    case 'term.approve':
    case 'term.reject':
      return {
        ok: true,
        result: handleTermEvent(
          db,
          authed as AuthorizedEvent<TermEventKind>,
          serverTs,
          opts.serverSeq,
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
          opts.serverSeq,
        ),
      }

    case 'cell.backtranslation.set':
    case 'cast.assign':
    case 'cell.retime':
    case 'cell.lane.retime':
    case 'source.cell.mirror':
    case 'file.mirror':
    case 'link.cursor.advance':
    case 'target.cell.repin':
      // AQU-476: mirror-engine kinds share the generic cell-event handler.
      // They are not chain-mutating (see CHAIN_MUTATING_KINDS in
      // event-projection.ts) so handleCellEvent never takes the chain-claim
      // path for them; the monotonic upstream_seq guard lives in the
      // projection SQL itself.
      // AQU-478: target.cell.repin joins this group for the same reason —
      // non-chain-mutating, guarded instead by expectedTargetEventId in the
      // projection SQL (see event-projection.ts).
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
          opts.serverSeq,
        ),
      }

    case 'project.link-source': {
      // AD-9: emitted by auth-worker on link/detach. No projection writes
      // needed in sync-worker — `projects.source_project_id` is the auth-
      // worker's table and the stale-source route reads it live from that
      // source. This case exists purely to satisfy the exhaustiveness check.
      const linkFrame: Extract<RealtimeMessage, { t: 'event' }> = {
        v: 1,
        t: 'event',
        id: authed.event.id,
        kind: authed.event.kind,
        project: authed.event.projectId,
        file: authed.event.fileId,
        ts: serverTs,
      }
      return { ok: true, result: { stmts: [], eventFrame: linkFrame, dirtyTables: [] } }
    }

    default: {
      // Exhaustiveness check.
      const exhaustive: never = kind
      return { ok: false, status: 400, reason: `unknown event kind: ${exhaustive}` }
    }
  }
}
