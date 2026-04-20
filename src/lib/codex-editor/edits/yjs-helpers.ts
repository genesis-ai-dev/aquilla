import * as Y from "yjs"
import type { EditTypeValue, ValidationEntry } from "@/lib/codex-editor/types"
import type { EditSessionSnapshot } from "./types"

/**
 * Canonical getter for a cell's edits array. Creates on first access so
 * callers never have to null-check. The returned Y.Array holds Y.Map entries
 * shaped per appendEntry() below.
 */
export function getEditsArray(cell: Y.Map<unknown>): Y.Array<Y.Map<unknown>> {
  let arr = cell.get("edits") as Y.Array<Y.Map<unknown>> | undefined
  if (!arr) {
    arr = new Y.Array<Y.Map<unknown>>()
    cell.set("edits", arr)
  }
  return arr
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
  const entry = new Y.Map<unknown>()
  // Set primitives before push (safe) and nested Y types after push (required).
  entry.set("timestamp", input.timestamp)
  entry.set("type", input.type)
  entry.set("value", input.value)
  arr.push([entry])
  // Now attached — safe to nest Y types.
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
