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
): LivingMemoryEntry[] {
  const entry: LivingMemoryEntry = {
    id: crypto.randomUUID(),
    kind,
    text: text.trim(),
    createdAt: new Date().toISOString(),
    author,
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
