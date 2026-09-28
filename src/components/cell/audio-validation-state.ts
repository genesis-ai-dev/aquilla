// AQU-490: the audio validation control's display state, kept out of the
// component so it can be tested as arithmetic and so the component file
// exports only a component (fast refresh).
//
// This is PRESENTATION state and it is not the same question as
// `cellAudioVotes()` in cell-audio-read-types.ts, which mirrors the server's
// histogram. That one asks "how validated is this line?"; these ask "what
// should this viewer see, and what can they still do?" — which is why they
// take a username and the other does not.
import type { AudioValidationTake } from "./AudioValidationControl"

/** How far along one take is, from the viewer's point of view. */
type TakeState = "none" | "others" | "self" | "full"

const STATE_RANK: Record<TakeState, number> = { none: 0, others: 1, self: 2, full: 3 }

export function takeState(
  take: Pick<AudioValidationTake, "validatorCount" | "validators">,
  currentUsername: string,
  requirement: number,
): TakeState {
  const mine = Boolean(currentUsername) && take.validators.includes(currentUsername)
  if (take.validatorCount >= Math.max(1, requirement)) return "full"
  if (mine) return "self"
  return take.validatorCount > 0 ? "others" : "none"
}

/**
 * The line's state: the WEAKEST of its takes.
 *
 * Deliberately the minimum and not the maximum. Two tracks sound together, so
 * a line whose second track nobody has listened to is not a validated line,
 * however thoroughly the first was signed off — the same reduction the server
 * makes when it buckets the minimum vote count into the progress histogram.
 */
export function lineState(
  takes: AudioValidationTake[],
  currentUsername: string,
  requirement: number,
): TakeState | "empty" {
  if (takes.length === 0) return "empty"
  let weakest: TakeState = "full"
  for (const take of takes) {
    const state = takeState(take, currentUsername, requirement)
    if (STATE_RANK[state] < STATE_RANK[weakest]) weakest = state
  }
  return weakest
}
