// HideCell / ShowCell — park a cell from the Agent API (AQU-1426).
//
// AQU-1422 gave a human the editor's three-dot "Hide cell": a reversible per-cell
// flag that takes a row out of translation and out of every export without
// deleting anything. This module is the agent's door to the same act.
//
// It matters because of what an agent could do BEFORE it: only DeleteCell, which
// hard-deletes the row (and is refused outright while the cell owns a comment, a
// validator or an audio take). An agent asked to park a stray heading that bled
// through an import had one destructive tool and no reversible one.
//
// Like RenameFile (commands-rename-file.ts) these are deliberately SUGAR: prepare
// desugars them into the equivalent EmitEvents command and hands that to the
// EmitEvents engine, which already owns file/cell existence checks, prepare-time
// event ids, the changeset approval gate, the provenance envelope and the /events
// perimeter round-trip. Nothing here compiles an event of its own — one code
// path, one set of gates, one place for the role floor to come from.
//
// Why named commands rather than "hand-build a source.cell.visibility.set inside
// EmitEvents": `describe_command` and the role-filtered command index are how an
// agent learns what it may do. "Hide a cell" with its own paramsDoc is
// discoverable, and the discovery surfaces can say the thing that actually
// matters — that this is the REVERSIBLE one, and DeleteCell is not.

import type { EmitEventsCommand } from './commands-emit-events'
import { REQUIRED_ROLE } from '../events/role-policy'

/** Park one cell: it leaves the editor and every export for everyone, in every
 *  lane, until ShowCell brings it back. Compiles (via EmitEvents) to
 *  `source.cell.visibility.set` with `hidden: true`. */
export interface HideCellCommand {
  kind: 'HideCell'
  fileId: string
  cellId: string
}

/** Un-park a cell hidden earlier — the exact inverse, restoring the row in its
 *  original position with its source text, every lane's translation, recordings,
 *  comments and validation state untouched (nothing was ever deleted). */
export interface ShowCellCommand {
  kind: 'ShowCell'
  fileId: string
  cellId: string
}

export type VisibilityCommand = HideCellCommand | ShowCellCommand

export const VISIBILITY_KINDS: readonly VisibilityCommand['kind'][] = ['HideCell', 'ShowCell'] as const

const VISIBILITY_KIND_SET: ReadonlySet<string> = new Set<string>(VISIBILITY_KINDS)

export function isVisibilityCommandKind(kind: unknown): kind is VisibilityCommand['kind'] {
  return typeof kind === 'string' && VISIBILITY_KIND_SET.has(kind)
}

/** Narrow a wider tagged union to the visibility family, so
 *  `filter(isVisibilityCommand)` yields `VisibilityCommand[]` without a cast. */
export function isVisibilityCommand<T extends { kind: string }>(
  c: T,
): c is Extract<T, VisibilityCommand> {
  return VISIBILITY_KIND_SET.has(c.kind)
}

/** Hard cap on visibility commands per changeset — one human-reviewable plan,
 *  matching the EmitEvents ceiling these desugar into. */
export const VISIBILITY_MAX_COMMANDS = 200

/** Static floor — the SAME floor `source.cell.visibility.set` hits at the
 *  /events perimeter (role-policy.ts is the single source of truth), i.e.
 *  PROJECT_LEAD, the floor AQU-1422 gave the editor's own menu item. Asking
 *  role-policy rather than restating the number is what keeps this surface from
 *  drifting below the perimeter that will refuse it anyway. */
export function visibilityCommandFloor(): number {
  return REQUIRED_ROLE['source.cell.visibility.set']
}

export interface VisibilityValidationIssue {
  index: number
  message: string
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** Validate one raw HideCell/ShowCell command (shape only — the cell's
 *  existence and its CURRENT visibility are live state, resolved at prepare;
 *  see prepareVisibilityPreconditions). */
export function validateVisibilityCommand(
  c: Record<string, unknown>,
  index: number,
  issues: VisibilityValidationIssue[],
): VisibilityCommand | null {
  const bad = (message: string): null => {
    issues.push({ index, message })
    return null
  }
  const kind = c.kind as VisibilityCommand['kind']
  if (!isNonEmptyString(c.fileId)) return bad(`${kind}.fileId must be a non-empty string`)
  if (!isNonEmptyString(c.cellId)) return bad(`${kind}.cellId must be a non-empty string`)
  return { kind, fileId: c.fileId, cellId: c.cellId }
}

/**
 * Desugar a visibility batch into the equivalent EmitEvents command.
 *
 * Order is preserved, so a Hide followed by a Show of the same cell applies
 * last-wins exactly as the caller wrote it — the event is idempotent in the
 * sense that matters (it sets a flag, it does not toggle one), so a replay of
 * the compiled plan lands the same state.
 */
export function visibilityToEmitEvents(cmds: readonly VisibilityCommand[]): EmitEventsCommand {
  return {
    kind: 'EmitEvents',
    events: cmds.map((c) => ({
      kind: 'source.cell.visibility.set',
      fileId: c.fileId,
      cellId: c.cellId,
      payload: { hidden: c.kind === 'HideCell' },
    })),
  }
}

/** The state a visibility command asks for, as a boolean, for precondition
 *  comparison against the live row. */
export function requestedHidden(cmd: VisibilityCommand): boolean {
  return cmd.kind === 'HideCell'
}
