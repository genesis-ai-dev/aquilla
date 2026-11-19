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

const listeners = new Set<(refs: readonly LocalTakeRef[]) => void>()

export function noteLocalTakeChange(refs: readonly LocalTakeRef[]): void {
  if (refs.length === 0) return
  for (const l of listeners) l(refs)
}

export function onLocalTakeChange(fn: (refs: readonly LocalTakeRef[]) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
