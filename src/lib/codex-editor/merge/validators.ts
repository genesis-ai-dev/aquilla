// src/lib/codex-editor/merge/validators.ts
// Vendored from codex-editor/src/projectManager/utils/merge/resolvers.ts:55-121,714-781
// Pure JS, no Node or VS Code deps.
import type { ValidationEntry } from "@/lib/codex-editor/types"

export function isValidValidationEntry(value: unknown): value is ValidationEntry {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return typeof v.username === "string"
    && typeof v.creationTimestamp === "number"
    && typeof v.updatedTimestamp === "number"
    && typeof v.isDeleted === "boolean"
}

export function mergeValidatedByLists(
  existing?: Array<ValidationEntry | string>,
  incoming?: Array<ValidationEntry | string>
): ValidationEntry[] {
  const upgrade = (e: ValidationEntry | string): ValidationEntry =>
    typeof e === "string"
      ? { username: e, creationTimestamp: 0, updatedTimestamp: 0, isDeleted: false }
      : e
  const all: ValidationEntry[] = [...(existing ?? []), ...(incoming ?? [])].map(upgrade)
  const byUser = new Map<string, ValidationEntry>()
  for (const e of all) {
    const prev = byUser.get(e.username)
    if (!prev) { byUser.set(e.username, e); continue }
    byUser.set(e.username, {
      username: e.username,
      creationTimestamp: Math.min(prev.creationTimestamp, e.creationTimestamp),
      updatedTimestamp: Math.max(prev.updatedTimestamp, e.updatedTimestamp),
      isDeleted: e.updatedTimestamp >= prev.updatedTimestamp ? e.isDeleted : prev.isDeleted,
    })
  }
  return [...byUser.values()].sort((a, b) => a.username.localeCompare(b.username))
}
