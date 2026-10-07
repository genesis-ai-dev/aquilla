// RenameFile — file-label management for the Agent API (AQU-1182, parity epic
// AQU-1181 item 17).
//
// The UI's file rename is a single `file.rename` event at the CONTRIBUTOR
// floor, and the EmitEvents door (AQU-926) already stages that kind through the
// full precondition + approval pipeline. So RenameFile is deliberately SUGAR:
// prepare desugars it into the equivalent EmitEvents command and hands it to
// that engine, which owns existence checks, prepare-time event ids, the
// changeset-approval gate, provenance, and the /events perimeter round-trip.
// Nothing here compiles an event of its own — one code path, one set of gates.
//
// Why a named command at all: `describe_command` and the role-filtered command
// index are how an agent discovers what it may do. "Rename a file" as a first
// class command with its own paramsDoc is discoverable; "hand-build a
// file.rename payload inside EmitEvents" is not.
//
// File DELETE is deliberately NOT surfaced here (AQU-272 — soft-delete/trash
// semantics are still in flux). It remains reachable only through the raw
// EmitEvents door, where the caller opts into the current semantics explicitly.

import type { EmitEventsCommand } from './commands-emit-events'
import { REQUIRED_ROLE } from '../events/role-policy'

/** Rename one file's display label. Compiles (via EmitEvents) to `file.rename`. */
export interface RenameFileCommand {
  kind: 'RenameFile'
  fileId: string
  /** New display name. Trimmed; 1–256 chars, matching the UI's rename field. */
  name: string
}

/** Longest file label the UI accepts — mirrors the project-rename bound so the
 *  two label fields cannot drift into different truncation behavior. */
export const MAX_FILE_NAME_LENGTH = 256

export interface RenameFileValidationIssue {
  index: number
  message: string
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** Validate one raw RenameFile command (shape only — file existence and the
 *  role floor are resolved live at prepare, by the EmitEvents engine). */
export function validateRenameFileCommand(
  c: Record<string, unknown>,
  index: number,
  issues: RenameFileValidationIssue[],
): RenameFileCommand | null {
  if (!isNonEmptyString(c.fileId)) {
    issues.push({ index, message: 'RenameFile.fileId must be a non-empty string' })
    return null
  }
  if (typeof c.name !== 'string') {
    issues.push({ index, message: 'RenameFile.name must be a string' })
    return null
  }
  // Trim first, so a whitespace-only name fails the empty check rather than
  // landing a blank label (the UI's rename field trims the same way).
  const name = c.name.trim()
  if (name.length === 0) {
    issues.push({ index, message: 'RenameFile.name must not be empty or whitespace-only' })
    return null
  }
  if (name.length > MAX_FILE_NAME_LENGTH) {
    issues.push({
      index,
      message: `RenameFile.name must be at most ${MAX_FILE_NAME_LENGTH} characters`,
    })
    return null
  }
  return { kind: 'RenameFile', fileId: c.fileId, name }
}

/** Static role floor — the SAME floor `file.rename` hits at the /events
 *  perimeter (role-policy is the single source of truth), i.e. the UI's own
 *  floor for renaming a file. */
export function renameFileFloor(): number {
  return REQUIRED_ROLE['file.rename']
}

/** Desugar a RenameFile batch into the equivalent EmitEvents command. Order is
 *  preserved, so two renames of the same file apply last-wins exactly as the
 *  caller wrote them. */
export function renameFileToEmitEvents(cmds: readonly RenameFileCommand[]): EmitEventsCommand {
  return {
    kind: 'EmitEvents',
    events: cmds.map((c) => ({
      kind: 'file.rename',
      fileId: c.fileId,
      payload: { name: c.name },
    })),
  }
}
