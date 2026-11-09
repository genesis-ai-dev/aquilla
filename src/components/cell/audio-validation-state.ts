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
import { isTakeValidated } from "@/lib/sync/cell-audio-read-types"

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
 * The state one take's validated TICK shows, or null for a clip that is not a
 * dub take (an imported source clip never wears a tick). Lifted from the
 * timeline chip so the shared waveform rectangle reads a take's tick through
 * the same rule: `self`/`full` draw a check, `none`/`others` draw nothing.
 */
export function takeBadgeState(
  att: { role?: string | null; validatorCount?: number | null; validators?: readonly string[] | null },
  currentUsername: string,
  requirement: number,
): TakeState | null {
  if ((att.role ?? "dub") !== "dub") return null
  return takeState(
    { validatorCount: att.validatorCount ?? 0, validators: [...(att.validators ?? [])] },
    currentUsername,
    requirement,
  )
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

/**
 * How many of a cut take's pieces are approved, out of how many (decision 7,
 * Sam 2026-10-22). Each piece is voted on by itself, so the take has no vote
 * of its own to show: it says this instead, read-only. A piece counts once its
 * own votes reach the project's requirement — the comparison the line's own
 * "validated" makes (`isTakeValidated`). Null for no pieces.
 */
export function piecesApproved(
  pieces: ReadonlyArray<Pick<AudioValidationTake, "validatorCount">>,
  requirement: number,
): { approved: number; total: number } | null {
  if (pieces.length === 0) return null
  return { approved: pieces.filter((p) => isTakeValidated(p, requirement)).length, total: pieces.length }
}
