import type { EditTypeValue, ValidationEntry } from "@/lib/codex-editor/types"

/**
 * Contiguous-commit window. A commit from the same author+type+editMap
 * within this many ms of the last entry extends that entry in place.
 * Must match the desktop serializer's SESSION_GAP_MS in
 * src/lib/codex-editor/serialize/edit-sessions.ts so round-trips are stable.
 */
export const SESSION_GAP_MS = 5 * 60_000

/**
 * Plain-JS projection of a `cell.edits` entry for UI consumption. Produced by
 * snapshotEntry() in yjs-helpers.ts. The live Y.Map is the source of truth;
 * this is a detached read-only copy.
 */
export interface EditSessionSnapshot {
  authors: string[]
  timestamp: number
  type: EditTypeValue
  editMap: string[]
  value: unknown
  validatedBy: ValidationEntry[]
}

/**
 * Per-edit summary used by the validation popover timeline in EditorTable.
 * Active = isDeleted=false; all includes soft-deleted entries for the
 * expanded-row view.
 */
export interface EditValidationSummary {
  authors: string[]
  timestamp: number
  type: EditTypeValue
  editMap: string[]
  value: unknown
  validatorsActive: string[]
  validatorsAll: ValidationEntry[]
}
