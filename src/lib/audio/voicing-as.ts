// AQU-1758 / AQU-2212: "Voicing as …" — the voice a line is being generated
// or re-voiced in, while it runs.
//
// The Audio view's card kept this in its own state, beside the field the pick
// came from. With the card gone, the work starts in the workspace (a pick in
// Media's table, the one-click "Change to …", a take's menu) and shows in two
// other places — the line's Recording tab and its clip on the timeline — so it
// lives here, keyed by the line, for any of them to read.

import { useSyncExternalStore } from "react"

const voicing = new Map<string, string>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/** Say the line `cellId` is being voiced as `voiceName`; null when done. */
export function setVoicingAs(cellId: string, voiceName: string | null): void {
  if (voiceName == null) {
    if (!voicing.delete(cellId)) return
  } else {
    if (voicing.get(cellId) === voiceName) return
    voicing.set(cellId, voiceName)
  }
  notify()
}

export function getVoicingAs(cellId: string): string | null {
  return voicing.get(cellId) ?? null
}

/**
 * Run `work` with the line shown as being voiced as `voiceName`, and clear it
 * however the work ends.
 */
export async function whileVoicingAs<T>(cellId: string, voiceName: string, work: () => Promise<T>): Promise<T> {
  setVoicingAs(cellId, voiceName)
  try {
    return await work()
  } finally {
    setVoicingAs(cellId, null)
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
    () => (cellId ? voicing.get(cellId) ?? null : null),
    () => null,
  )
}

/** Tests only. */
export function __resetVoicingAsForTests(): void {
  voicing.clear()
  notify()
}
