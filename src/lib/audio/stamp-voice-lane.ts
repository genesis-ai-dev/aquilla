import type { Voice } from "@/lib/parsers/types"

/** The one target lane row whose legacy tag is `tag`, or null when it isn't exactly one. */
export function targetLaneRowId(
  lanes: readonly { id: string; role: string; legacyTag: string | null }[] | undefined,
  tag: string,
): string | null {
  const matches = (lanes ?? []).filter((lane) => lane.role === "target" && (lane.legacyTag ?? "") === tag)
  return matches.length === 1 ? matches[0]!.id : null
}

/**
 * Put a voice in `laneId` unless it already names a lane, is a built-in
 * preset, or there is no lane to put it in. AQU-2037's write rule, kept here
 * so a project lead's new voice belongs to the lane they are writing.
 */
export function stampVoiceLane(voice: Voice, laneId: string | null | undefined): Voice {
  if (!laneId || voice.builtIn || voice.laneId !== undefined) return voice
  return { ...voice, laneId }
}

/**
 * Stamp every voice in `next` that the stored library does not already hold.
 * Editing a voice never moves it. A voice stored before it had a lane stays
 * without one.
 */
export function stampNewVoiceLanes(
  next: readonly Voice[],
  previous: readonly Voice[] | undefined,
  laneId: string | null | undefined,
): Voice[] {
  if (!laneId) return [...next]
  const stored = new Set((previous ?? []).map((voice) => voice.id))
  return next.map((voice) => (stored.has(voice.id) ? voice : stampVoiceLane(voice, laneId)))
}
