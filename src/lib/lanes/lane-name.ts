/**
 * AQU-1418: display-name rules for a lane row.
 *
 * `lanes.name` is not unique in the database. Two lanes may share a language.
 * Two lanes may not share a display name: the maintainer is asked to change
 * one. This check is the prompt. It is not a unique index, so rows that
 * already share a name stay until someone edits them.
 */

export const MAX_LANE_NAME_LENGTH = 200

export type LaneNameProblem = "empty" | "too_long" | "duplicate"

export function laneNameProblem(input: {
  laneId: string
  name: string
  others: readonly { id: string; name: string }[]
}): LaneNameProblem | null {
  const trimmed = input.name.trim()
  if (trimmed.length === 0) return "empty"
  if (trimmed.length > MAX_LANE_NAME_LENGTH) return "too_long"
  const folded = trimmed.toLocaleLowerCase()
  for (const other of input.others) {
    if (other.id === input.laneId) continue
    if (other.name.trim().toLocaleLowerCase() === folded) return "duplicate"
  }
  return null
}
