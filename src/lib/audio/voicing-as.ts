// AQU-1758 / AQU-2212: "Voicing as …" — the voice a line is being generated
// or re-voiced in, while it runs.
//
// The Audio view's card kept this in its own state, beside the field the pick
// came from. With the card gone, the work starts in the workspace (a pick in
// Media's table, the one-click "Change to …", a take's menu) and shows in two
// other places — the line's Recording tab and its clip on the timeline — so it
// lives here, keyed by the line, for any of them to read.

import { useSyncExternalStore } from "react"

// Every voicing of a line still running, in the order they started. Two can
// overlap — a Regenerate from the take menu, then "Change to …" on the same
// line before it finishes — so the line names the latest, and each, when it
// ends, takes away only its own entry: never the status of one still running.
const voicing = new Map<string, { voiceName: string }[]>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

export function getVoicingAs(cellId: string): string | null {
  return voicing.get(cellId)?.at(-1)?.voiceName ?? null
}

/** Change the line's running voicings, and tell the readers when what it
 *  names changed. */
function update(cellId: string, next: { voiceName: string }[]): void {
  const before = getVoicingAs(cellId)
  if (next.length > 0) voicing.set(cellId, next)
  else voicing.delete(cellId)
  if (getVoicingAs(cellId) !== before) notify()
}

/**
 * Run `work` with the line shown as being voiced as `voiceName`, and take that
 * away however the work ends — this voicing's own, so a voicing of the same
 * line still running keeps saying so.
 */
export async function whileVoicingAs<T>(cellId: string, voiceName: string, work: () => Promise<T>): Promise<T> {
  const entry = { voiceName }
  update(cellId, [...(voicing.get(cellId) ?? []), entry])
  try {
    return await work()
  } finally {
    update(cellId, (voicing.get(cellId) ?? []).filter((e) => e !== entry))
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The voice the line is being voiced as, or null. */
export function useVoicingAs(cellId: string | null | undefined): string | null {
  return useSyncExternalStore(
    subscribe,
    () => (cellId ? getVoicingAs(cellId) : null),
    () => null,
  )
}

/** Tests only. */
export function __resetVoicingAsForTests(): void {
  voicing.clear()
  notify()
}
