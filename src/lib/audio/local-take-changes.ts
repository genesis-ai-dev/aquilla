// Review M1 (question 89 ON): the takes THIS TAB just made or changed —
// recorded, attached, cut, trimmed, saved as a Station version, cleaned by
// Remove noise. The emitters (events-emit.ts: attach, trim, cut) tell this,
// and auto-even listens. Nothing that arrives from elsewhere (a colleague, a
// refresh, an Undo of an even-out) passes through here, so auto-even never
// acts on what the takes merely look like.

export interface LocalTakeRef {
  cellId: string
  audioId: string
}

/**
 * Re-check (Sam): what the action did to the take, which is what decides
 * whether auto-even touches it — with no new state.
 * - "new": new audio (a recording, an attach, a version, Remove noise). It is
 *   evened when its track is evened.
 * - "changed": a cut or a trim. Only a take that already HAD a target is
 *   evened again; a cleared take has none, so it stays cleared.
 * A words-only attach (transcribe, a transcript save) is neither: no note.
 */
export type LocalTakeChange = "new" | "changed"

const listeners = new Set<(refs: readonly LocalTakeRef[], kind: LocalTakeChange) => void>()

export function noteLocalTakeChange(refs: readonly LocalTakeRef[], kind: LocalTakeChange): void {
  if (refs.length === 0) return
  for (const l of listeners) l(refs, kind)
}

export function onLocalTakeChange(fn: (refs: readonly LocalTakeRef[], kind: LocalTakeChange) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
