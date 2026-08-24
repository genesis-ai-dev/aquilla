// Stable map keys for the changeset engine's per-cell joins.
//
// A leaf module (imports nothing) so the pure helpers that need keying —
// supersede.ts, supersede-state.ts — stay off the commands.ts import graph.
// commands.ts re-exports both names, so every existing `from './commands'`
// import keeps working.

/** Stable key for de-duping / joining commands ↔ preconditions by target cell. */
export function cellKey(fileId: string, cellId: string): string {
  return `${fileId}\u0000${cellId}`
}

/** Lane-qualified cellKey (AQU-538): the same cell in two target lanes is two
 *  distinct dedupe/join slots. Empty/absent lane is the default lane, so
 *  lane-less callers key identically to each other (back-compat). */
export function laneCellKey(fileId: string, cellId: string, laneId?: string): string {
  return `${cellKey(fileId, cellId)}\u0000${laneId ?? ''}`
}
