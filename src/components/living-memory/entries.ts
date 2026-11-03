/**
 * Pure add/update/delete helpers for authored living-memory entries.
 * Re-exported from `LivingMemoryPage.tsx` so existing imports (and
 * `LivingMemoryPage.test.ts`) keep resolving.
 */

import type { LivingMemoryEntry } from "@/lib/parsers/types"

export function addEntry(
  entries: LivingMemoryEntry[],
  kind: LivingMemoryEntry["kind"],
  text: string,
  author: string,
  /** AQU-2348: the lane (`lanes.id`) that owns this entry. Omitted = a
   *  project-wide entry, in force in every lane, which is what every entry was
   *  before per-lane memory. Set when the page is viewing ONE lane, so an
   *  entry written in that lane's view reaches that lane's prompt and no
   *  other's. Entries UNION, so this ADDS to the project's rather than
   *  replacing them. */
  laneId?: string,
): LivingMemoryEntry[] {
  const entry: LivingMemoryEntry = {
    id: crypto.randomUUID(),
    kind,
    text: text.trim(),
    createdAt: new Date().toISOString(),
    author,
    ...(laneId ? { laneId } : {}),
  }
  return [...entries, entry]
}

export function updateEntry(
  entries: LivingMemoryEntry[],
  id: string,
  text: string,
): LivingMemoryEntry[] {
  return entries.map((e) => (e.id === id ? { ...e, text: text.trim() } : e))
}

export function deleteEntry(
  entries: LivingMemoryEntry[],
  id: string,
): LivingMemoryEntry[] {
  return entries.filter((e) => e.id !== id)
}
