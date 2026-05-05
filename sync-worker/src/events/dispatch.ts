// Per-kind event dispatcher.
//
// Keeps the route handler agnostic to kind-specific logic. This is the single
// point of kind-to-handler mapping — adding a new EventKind in types.ts will
// cause TypeScript to flag the exhaustiveness check in the default branch,
// ensuring the dispatcher is always updated alongside the type.

import type { AuthorizedEvent } from './authorize'
import type { EventKind } from './types'
import { handleCellCommit, type DispatchResult } from './handlers/cell-commit'
import { handleCellValidate } from './handlers/cell-validate'
import { handleCellUnvalidate } from './handlers/cell-unvalidate'
import { handleEventsAuditOnly } from './handlers/events-audit-only'

export type DispatchOutcome =
  | { ok: true; result: DispatchResult }
  | { ok: false; status: number; reason: string }

/**
 * Dispatch one authorized event to its kind-specific handler.
 *
 * Returns DispatchResult on success. Returns a structured rejection for:
 *   - Unimplemented kinds (501) — handlers will be added in Phase 2+.
 *   - Unknown kinds (400) — TypeScript exhaustiveness check guarantees this
 *     branch is only reached by a runtime kind value not present in EventKind
 *     (e.g. a newer client talking to an older worker).
 *
 * Does NOT write to D1 or broadcast — the caller (route.ts) batches and
 * commits statements after all events in the request are dispatched.
 */
export function dispatchEvent(
  db: D1Database,
  authed: AuthorizedEvent,
  serverTs: number,
): DispatchOutcome {
  const kind = authed.event.kind as EventKind
  switch (kind) {
    case 'cell.commit':
      return {
        ok: true,
        result: handleCellCommit(db, authed as AuthorizedEvent<'cell.commit'>, serverTs),
      }

    case 'cell.validate':
      return {
        ok: true,
        result: handleCellValidate(db, authed as AuthorizedEvent<'cell.validate'>, serverTs),
      }

    case 'cell.unvalidate':
      return {
        ok: true,
        result: handleCellUnvalidate(db, authed as AuthorizedEvent<'cell.unvalidate'>, serverTs),
      }

    case 'thread.add':
    case 'thread.resolve':
    case 'cell.metadata.set':
      return {
        ok: true,
        result: handleEventsAuditOnly(db, authed, serverTs),
      }

    default: {
      // Exhaustiveness check: TypeScript narrows `kind` to `never` if all
      // EventKind variants are handled above. If a new kind is added to
      // EventKind without a case here, this line triggers a TS compile error.
      const exhaustive: never = kind
      return { ok: false, status: 400, reason: `unknown event kind: ${exhaustive}` }
    }
  }
}
