// Which generated clips are shared by more than one line. (Sam, 2026-09-28)
//
// "Voice together" synthesizes several lines as ONE clip and attaches it to
// every one of them, each playing its own slice (combined-voice.ts). The clip
// is seeded with the first line's id, so a single line cannot tell from its own
// attachment whether it shares; counting across the file can. The Audio view
// uses this to keep "Generate again" off a shared clip — regenerating from one
// line of a group is ambiguous (the group, or just this line?), so those are
// regenerated from the recorder or the Voice-together tool instead.

import { createContext, useContext } from "react"

export function sharedGeneratedClipIds(
  entries: Iterable<{ selectedGeneratedVoiceAudioId?: string | null }>,
): ReadonlySet<string> {
  const counts = new Map<string, number>()
  for (const e of entries) {
    const id = e.selectedGeneratedVoiceAudioId
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const shared = new Set<string>()
  for (const [id, n] of counts) if (n > 1) shared.add(id)
  return shared
}

const EMPTY: ReadonlySet<string> = new Set()

export const SharedVoiceClipsContext = createContext<ReadonlySet<string>>(EMPTY)

export function useSharedVoiceClips(): ReadonlySet<string> {
  return useContext(SharedVoiceClipsContext)
}
