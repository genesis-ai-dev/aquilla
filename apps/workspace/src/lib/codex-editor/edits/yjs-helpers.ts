import * as Y from "yjs"
import type { EditTypeValue, ValidationEntry } from "@/lib/codex-editor/types"
import type { EditSessionSnapshot } from "./types"

/**
 * Canonical getter for a cell's edits array. Creates on first access so
 * callers never have to null-check. The returned Y.Array holds Y.Map entries
 * whose shape matches CreateEntryInput (authors, timestamp, type, editMap,
 * value, and optionally validatedBy).
 */
export function getEditsArray(cell: Y.Map<unknown>): Y.Array<Y.Map<unknown>> {
  let arr = cell.get("edits") as Y.Array<Y.Map<unknown>> | undefined
  if (!arr) {
    arr = new Y.Array<Y.Map<unknown>>()
    cell.set("edits", arr)
  }
  return arr
}

// Cap on per-cell `edits` Y.Array length. Each entry is a nested Y.Map with
// authors/editMap/validatedBy sub-types — Yjs allocates significant CRDT
// metadata per entry, so an unbounded array is the leading cause of doc
// bloat (and DO OOM) on long-lived projects. 100 entries comfortably covers
// active review while keeping per-cell memory bounded.
//
// Mirrors EDITS_CAP_PER_CELL in sync-worker/src/index.ts. If you change one,
// change both. Server-side enforcement is the safety net; this client cap is
// the primary mechanism so the doc never grows past the limit in the first
// place.
export const EDITS_CAP_PER_CELL = 100

/**
 * Trim the head of the edits array so its length is at most cap. Caller is
 * responsible for wrapping in doc.transact() (typically already in one when
 * called from appendEntry's caller).
 */
function trimEditsToCap(arr: Y.Array<Y.Map<unknown>>, cap: number): void {
  if (arr.length <= cap) return
  arr.delete(0, arr.length - cap)
}

export interface CreateEntryInput {
  authors: string[]
  timestamp: number
  type: EditTypeValue
  editMap: string[]
  value: unknown
  /** If set, seeds validatedBy with an active entry for this username. */
  seedValidator?: string
}

/**
 * Append a new session-entry Y.Map to a cell's (or meta's) edits Y.Array.
 * The entry must be attached to a doc before nested Y types (authors,
 * editMap, validatedBy) can be written. We push first, then populate.
 * Caller is responsible for wrapping in doc.transact() when batching with
 * other writes.
 */
export function appendEntry(
  arr: Y.Array<Y.Map<unknown>>,
  input: CreateEntryInput,
): Y.Map<unknown> {
  // Trim BEFORE the push so the post-push length is at most the cap.
  // Trimming after would briefly hold cap+1 entries, which matters for
  // Yjs garbage collection of the deleted-from-front entries.
  trimEditsToCap(arr, EDITS_CAP_PER_CELL - 1)
  const entry = new Y.Map<unknown>()
  // Push first so entry is attached to the doc — Yjs emits warnings for writes
  // (even primitives) on detached Y types.
  arr.push([entry])
  entry.set("timestamp", input.timestamp)
  entry.set("type", input.type)
  entry.set("value", input.value)
  const authorsArr = new Y.Array<string>()
  entry.set("authors", authorsArr)
  authorsArr.push(input.authors.slice())
  const editMapArr = new Y.Array<string>()
  entry.set("editMap", editMapArr)
  editMapArr.push(input.editMap.slice())
  if (input.seedValidator) {
    const validators = new Y.Map<Y.Map<unknown>>()
    entry.set("validatedBy", validators)
    const v = new Y.Map<unknown>()
    validators.set(input.seedValidator, v)
    v.set("creationTimestamp", input.timestamp)
    v.set("updatedTimestamp", input.timestamp)
    v.set("isDeleted", false)
  }
  return entry
}

/**
 * Project a live entry Y.Map into a detached plain object for reads. Missing
 * or malformed fields degrade to safe defaults so a half-populated entry
 * (e.g. mid-transaction observer firing) can still be rendered.
 */
export function snapshotEntry(entry: Y.Map<unknown>): EditSessionSnapshot {
  const authorsArr = entry.get("authors") as Y.Array<string> | undefined
  const editMapArr = entry.get("editMap") as Y.Array<string> | undefined
  const validators = entry.get("validatedBy") as Y.Map<Y.Map<unknown>> | undefined
  const validatedBy: ValidationEntry[] = []
  if (validators) {
    validators.forEach((v, username) => {
      validatedBy.push({
        username,
        creationTimestamp: (v.get("creationTimestamp") as number) ?? 0,
        updatedTimestamp: (v.get("updatedTimestamp") as number) ?? 0,
        isDeleted: !!v.get("isDeleted"),
      })
    })
  }
  validatedBy.sort((a, b) => a.username.localeCompare(b.username))
  return {
    authors: authorsArr ? authorsArr.toArray() : [],
    timestamp: (entry.get("timestamp") as number) ?? 0,
    type: (entry.get("type") as EditTypeValue) ?? "user-edit",
    editMap: editMapArr ? editMapArr.toArray() : [],
    value: entry.get("value"),
    validatedBy,
  }
}

/**
 * Add or reactivate a validator. Idempotent: calling twice for the same
 * username at the same timestamp produces the same state (last-write-wins on
 * updatedTimestamp is exactly what we want for concurrent same-user writes).
 *
 * Precondition: `entry` must already be attached to a Y.Doc (guaranteed when
 * obtained via appendEntry). Operating on a fully detached entry will throw
 * when the internal validators Y.Map is read back.
 */
export function upsertValidator(
  entry: Y.Map<unknown>, username: string, timestamp: number,
): void {
  let validators = entry.get("validatedBy") as Y.Map<Y.Map<unknown>> | undefined
  if (!validators) {
    validators = new Y.Map<Y.Map<unknown>>()
    entry.set("validatedBy", validators)
  }
  let v = validators.get(username)
  if (!v) {
    v = new Y.Map<unknown>()
    v.set("creationTimestamp", timestamp)
    validators.set(username, v)
  }
  v.set("updatedTimestamp", timestamp)
  v.set("isDeleted", false)
}

/**
 * Soft-delete a validator. No-op if the username isn't present — we don't
 * want to create a tombstone for someone who never validated.
 */
export function softDeleteValidator(
  entry: Y.Map<unknown>, username: string, timestamp: number,
): void {
  const validators = entry.get("validatedBy") as Y.Map<Y.Map<unknown>> | undefined
  if (!validators) return
  const v = validators.get(username)
  if (!v) return
  v.set("updatedTimestamp", timestamp)
  v.set("isDeleted", true)
}

/** Active (non-deleted) usernames in insertion order, for UI reads. */
export function getValidatorsActive(entry: Y.Map<unknown>): string[] {
  const validators = entry.get("validatedBy") as Y.Map<Y.Map<unknown>> | undefined
  if (!validators) return []
  const out: string[] = []
  validators.forEach((v, username) => {
    if (!v.get("isDeleted")) out.push(username)
  })
  return out
}

/**
 * Read the active validator usernames for a cell's latest *value*-edit. This
 * is the canonical "who has signed off on the current translation" question:
 * non-value edits (metadata-only, etc.) never carry validator state, and any
 * value-edit older than the latest is stale because the text it ratified has
 * since changed.
 *
 * Shared by `useCells` (when D1 audit stats aren't available yet) and
 * `useSectionProgress` (which doesn't consult D1 at all). Keeping a single
 * implementation prevents the two from drifting — the earlier divergence is
 * what made the sidebar's "% validated" bar stay at 0 even though the editor
 * UI showed validators present.
 */
export function readLatestActiveValidators(cell: Y.Map<unknown>): string[] {
  const arr = cell.get("edits") as Y.Array<Y.Map<unknown>> | undefined
  if (!arr) return []
  for (let i = arr.length - 1; i >= 0; i--) {
    const entry = arr.get(i)
    const editMapArr = entry.get("editMap") as Y.Array<string> | undefined
    if (editMapArr?.get(0) !== "value") continue
    return getValidatorsActive(entry)
  }
  return []
}

/** Does this entry's authors array contain the username? */
export function entryHasAuthor(entry: Y.Map<unknown>, username: string): boolean {
  const arr = entry.get("authors") as Y.Array<string> | undefined
  if (!arr) return false
  return arr.toArray().includes(username)
}

/** Append a new author to an entry's authors array. */
export function appendAuthor(entry: Y.Map<unknown>, username: string): void {
  let arr = entry.get("authors") as Y.Array<string> | undefined
  if (!arr) {
    arr = new Y.Array<string>()
    entry.set("authors", arr)
  }
  arr.push([username])
}

/** Deep-equal comparison for editMap arrays. */
export function editMapEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Read the editMap of a live entry as a plain string[]. */
export function getEntryEditMap(entry: Y.Map<unknown>): string[] {
  const arr = entry.get("editMap") as Y.Array<string> | undefined
  return arr ? arr.toArray() : []
}
